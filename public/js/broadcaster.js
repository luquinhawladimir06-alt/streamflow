/**
 * StreamFlow — Broadcaster Logic
 * WebRTC 1:N: O broadcaster cria uma RTCPeerConnection para cada viewer.
 */

// ─── Configuração ICE ──────────────────────────────────────────────────────────
const ICE_CONFIG = {
  iceServers: [
    // STUN do Google — funciona para a maioria dos casos
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    // ↓ Adicione TURN aqui se necessário para usuários atrás de NAT restritivo
    // {
    //   urls: 'turn:seu-servidor-turn.com:3478',
    //   username: 'usuario',
    //   credential: 'senha'
    // }
  ]
};

// ─── Estado ────────────────────────────────────────────────────────────────────
let socket = null;
let localStream = null;
let streamId = null;
let broadcasterToken = null;
let peerConnections = {}; // viewerSocketId → RTCPeerConnection
let viewerCount = 0;
let startTime = null;
let durationInterval = null;
let isLive = false;

// ─── Elementos DOM ─────────────────────────────────────────────────────────────
const startScreen    = document.getElementById('start-screen');
const liveScreen     = document.getElementById('live-screen');
const startBtn       = document.getElementById('start-btn');
const endBtn         = document.getElementById('end-btn');
const localVideo     = document.getElementById('local-video');
const videoPlaceholder = document.getElementById('video-placeholder');
const streamIdDisplay  = document.getElementById('stream-id-display');
const streamLinkInput  = document.getElementById('stream-link-input');
const viewerCountNum   = document.getElementById('viewer-count-num');
const viewerCountStat  = document.getElementById('viewer-count-stat');
const durationDisplay  = document.getElementById('duration-display');
const toastContainer   = document.getElementById('toast-container');
const qualitySelect    = document.getElementById('quality-select');

// ─── Qualidades Predefinidas ───────────────────────────────────────────────────
const QUALITY_SETTINGS = {
  extreme: { width: 1920, height: 1080, fps: 60, maxBitrate: 8000000 }, // 8 Mbps
  high:    { width: 1920, height: 1080, fps: 30, maxBitrate: 5000000 }, // 5 Mbps
  normal:  { width: 1280, height: 720,  fps: 30, maxBitrate: 2500000 }  // 2.5 Mbps
};
let selectedQuality = QUALITY_SETTINGS.normal;

// ─── Conectar ao servidor ──────────────────────────────────────────────────────
function initSocket() {
  socket = io();

  socket.on('connect', () => {
    console.log('[Socket] Conectado:', socket.id);
  });

  socket.on('disconnect', () => {
    console.log('[Socket] Desconectado');
    if (isLive) {
      showToast('Conexão com o servidor perdida.', 'error');
      resetToStartScreen();
    }
  });

  // Servidor confirma encerramento
  socket.on('broadcast-ended', ({ streamId: sid }) => {
    console.log('[Broadcast] Confirmado encerrado:', sid);
  });

  // Um novo viewer entrou — criar PeerConnection e enviar offer
  socket.on('viewer-joined', async ({ viewerSocketId }) => {
    console.log('[Viewer] Novo viewer:', viewerSocketId);
    if (!localStream) return;
    await createOfferForViewer(viewerSocketId);
  });

  // Recebeu answer de um viewer
  socket.on('answer', async ({ sdp, viewerSocketId }) => {
    console.log('[WebRTC] Answer recebida de:', viewerSocketId);
    const pc = peerConnections[viewerSocketId];
    if (!pc) return;
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    } catch (err) {
      console.error('[WebRTC] Erro ao setar remote description:', err);
    }
  });

  // ICE candidate de um viewer
  socket.on('ice-candidate', async ({ candidate, viewerSocketId }) => {
    const pc = peerConnections[viewerSocketId];
    if (!pc || !candidate) return;
    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
      console.error('[WebRTC] Erro ao adicionar ICE candidate:', err);
    }
  });

  // Atualização de contagem de viewers
  socket.on('viewer-count', ({ count }) => {
    updateViewerCount(count);
  });

  // Erro do servidor
  socket.on('error-event', ({ message }) => {
    showToast(message, 'error');
  });
}

// ─── Criar RTCPeerConnection para um viewer ────────────────────────────────────
async function createOfferForViewer(viewerSocketId) {
  const pc = new RTCPeerConnection(ICE_CONFIG);
  peerConnections[viewerSocketId] = pc;

  // Adicionar todas as tracks do stream local
  localStream.getTracks().forEach(track => {
    pc.addTrack(track, localStream);
  });

  // Forçar Bitrate mais alto (evitar pixels estourados)
  const senders = pc.getSenders();
  const videoSender = senders.find(s => s.track && s.track.kind === 'video');
  if (videoSender) {
    const params = videoSender.getParameters();
    if (!params.encodings) params.encodings = [{}];
    // Injeta o maxBitrate definido pela configuração (em bps)
    params.encodings[0].maxBitrate = selectedQuality.maxBitrate;
    // Tenta aplicar as configurações
    videoSender.setParameters(params).catch(err => {
      console.warn('[WebRTC] Não foi possível forçar o bitrate:', err);
    });
  }

  // Enviar ICE candidates ao viewer via servidor
  pc.onicecandidate = ({ candidate }) => {
    if (candidate) {
      socket.emit('ice-candidate', {
        candidate,
        targetSocketId: viewerSocketId,
        streamId
      });
    }
  };

  pc.onconnectionstatechange = () => {
    console.log(`[WebRTC] Connection state (${viewerSocketId}):`, pc.connectionState);
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
      cleanupPeer(viewerSocketId);
    }
  };

  try {
    const offer = await pc.createOffer({
      offerToReceiveVideo: false,
      offerToReceiveAudio: false
    });
    await pc.setLocalDescription(offer);

    socket.emit('offer', {
      targetSocketId: viewerSocketId,
      sdp: pc.localDescription,
      streamId
    });

    console.log('[WebRTC] Offer enviada para:', viewerSocketId);
  } catch (err) {
    console.error('[WebRTC] Erro ao criar offer:', err);
    cleanupPeer(viewerSocketId);
  }
}

// ─── Limpar uma PeerConnection ─────────────────────────────────────────────────
function cleanupPeer(viewerSocketId) {
  const pc = peerConnections[viewerSocketId];
  if (pc) {
    pc.close();
    delete peerConnections[viewerSocketId];
  }
}

// ─── Iniciar transmissão ───────────────────────────────────────────────────────
async function startBroadcast() {
  startBtn.disabled = true;
  startBtn.textContent = 'Solicitando permissão...';

  // Obter qualidade selecionada
  const selectedKey = qualitySelect.value;
  selectedQuality = QUALITY_SETTINGS[selectedKey] || QUALITY_SETTINGS.normal;
  console.log('[Quality] Configuração selecionada:', selectedKey, selectedQuality);

  try {
    // 1. Capturar tela com configurações exatas (ideal => forçar o máximo possível sem quebrar)
    localStream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        width:     { ideal: selectedQuality.width },
        height:    { ideal: selectedQuality.height },
        frameRate: { ideal: selectedQuality.fps }
      },
      audio: true
    });

    // 2. Mostrar preview local (mutado para não criar eco)
    localVideo.srcObject = localStream;
    videoPlaceholder.style.display = 'none';
    localVideo.style.display = 'block';

    // 3. Registrar transmissão no servidor
    socket.emit('start-broadcast', {}, ({ streamId: sid, broadcasterToken: token }) => {
      streamId = sid;
      broadcasterToken = token;

      const streamUrl = `${window.location.origin}/live/${streamId}`;
      streamLinkInput.value = streamUrl;
      streamIdDisplay.textContent = `ID: ${streamId}`;

      console.log('[Broadcast] Transmissão iniciada:', streamId);
      showToast('Transmissão iniciada com sucesso!', 'success');
    });

    // 4. Trocar para tela de live
    startScreen.style.display = 'none';
    liveScreen.style.display = 'flex';
    isLive = true;

    // 5. Iniciar cronômetro
    startTime = Date.now();
    durationInterval = setInterval(updateDuration, 1000);

    // 6. Detectar se o usuário parou de compartilhar (clicou em "Parar" no browser)
    localStream.getVideoTracks()[0].addEventListener('ended', () => {
      console.log('[Screen] Compartilhamento encerrado pelo usuário');
      if (isLive) endBroadcast(true);
    });

  } catch (err) {
    console.error('[Screen] Erro ao capturar tela:', err);
    startBtn.disabled = false;
    startBtn.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polygon points="23 7 16 12 23 17 23 7"></polygon>
        <rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect>
      </svg>
      Transmitir
    `;

    if (err.name === 'NotAllowedError') {
      showToast('Permissão negada. Autorize o compartilhamento de tela.', 'error');
    } else if (err.name === 'NotFoundError') {
      showToast('Nenhuma tela disponível para compartilhar.', 'error');
    } else {
      showToast('Erro ao iniciar transmissão: ' + err.message, 'error');
    }
  }
}

// ─── Encerrar transmissão ──────────────────────────────────────────────────────
function endBroadcast(fromTrackEnd = false) {
  if (!isLive) return;
  isLive = false;

  // Notificar servidor
  if (streamId && broadcasterToken) {
    socket.emit('end-broadcast', { streamId, broadcasterToken });
  }

  // Parar stream local
  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
    localStream = null;
  }

  // Fechar todas as PeerConnections
  Object.keys(peerConnections).forEach(id => cleanupPeer(id));

  // Parar cronômetro
  clearInterval(durationInterval);

  // Resetar UI
  resetToStartScreen();

  if (!fromTrackEnd) {
    showToast('Transmissão encerrada.', 'info');
  }

  // Resetar IDs
  streamId = null;
  broadcasterToken = null;
}

// ─── Resetar para tela inicial ─────────────────────────────────────────────────
function resetToStartScreen() {
  liveScreen.style.display = 'none';
  startScreen.style.display = 'flex';
  localVideo.style.display = 'none';
  localVideo.srcObject = null;
  videoPlaceholder.style.display = 'flex';
  startBtn.disabled = false;
  startBtn.innerHTML = `
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <polygon points="23 7 16 12 23 17 23 7"></polygon>
      <rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect>
    </svg>
    Transmitir
  `;
  updateViewerCount(0);
  durationDisplay.textContent = '00:00';
  streamLinkInput.value = '';
  streamIdDisplay.textContent = '';
}

// ─── Atualizar contagem de viewers ────────────────────────────────────────────
function updateViewerCount(count) {
  viewerCount = count;
  viewerCountNum.textContent = count;
  if (viewerCountStat) viewerCountStat.textContent = count;
}

// ─── Atualizar duração ─────────────────────────────────────────────────────────
function updateDuration() {
  if (!startTime) return;
  const elapsed = Math.floor((Date.now() - startTime) / 1000);
  const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
  const ss = String(elapsed % 60).padStart(2, '0');
  durationDisplay.textContent = `${mm}:${ss}`;
}

// ─── Copiar link ───────────────────────────────────────────────────────────────
window.copyLink = function () {
  const link = streamLinkInput.value;
  if (!link) return;

  navigator.clipboard.writeText(link).then(() => {
    const btn = document.getElementById('copy-btn');
    const icon = document.getElementById('copy-icon');
    btn.classList.add('copied');
    btn.querySelector('span') && (btn.querySelector('span').textContent = 'Copiado!');

    // Substituir ícone por check
    icon.outerHTML = `
      <svg id="copy-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="20 6 9 17 4 12"></polyline>
      </svg>
    `;

    showToast('Link copiado!', 'success');

    setTimeout(() => {
      const newIcon = document.getElementById('copy-icon');
      if (newIcon) {
        newIcon.outerHTML = `
          <svg id="copy-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
          </svg>
        `;
      }
      btn.classList.remove('copied');
    }, 2500);
  }).catch(() => {
    // Fallback
    streamLinkInput.select();
    document.execCommand('copy');
    showToast('Link copiado!', 'success');
  });
};

// ─── Toast ─────────────────────────────────────────────────────────────────────
function showToast(message, type = 'info') {
  const icons = {
    success: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`,
    error:   `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>`,
    info:    `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>`
  };

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span class="toast-icon ${type}">${icons[type]}</span><span>${message}</span>`;
  toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.style.animation = 'fadeOut 0.3s ease forwards';
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

// ─── Event listeners ───────────────────────────────────────────────────────────
startBtn.addEventListener('click', startBroadcast);
endBtn.addEventListener('click', () => endBroadcast(false));

// Prevenir saída acidental durante transmissão
window.addEventListener('beforeunload', (e) => {
  if (isLive) {
    e.preventDefault();
    e.returnValue = 'A transmissão está ativa. Tem certeza que deseja sair?';
  }
});

// ─── Inicializar ───────────────────────────────────────────────────────────────
initSocket();
