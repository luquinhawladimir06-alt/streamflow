/**
 * StreamFlow — Viewer Logic
 * Recebe o stream via WebRTC do broadcaster.
 */

// ─── Configuração ICE ──────────────────────────────────────────────────────────
const ICE_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    // ↓ TURN (adicionar se necessário)
    // {
    //   urls: 'turn:seu-servidor-turn.com:3478',
    //   username: 'usuario',
    //   credential: 'senha'
    // }
  ]
};

// ─── Extrair streamId da URL ───────────────────────────────────────────────────
const pathParts = window.location.pathname.split('/');
const streamId = pathParts[pathParts.length - 1];

// ─── Estado ────────────────────────────────────────────────────────────────────
let socket = null;
let peerConnection = null;
let hudTimeout = null;

// ─── Elementos DOM ─────────────────────────────────────────────────────────────
const loadingScreen    = document.getElementById('loading-screen');
const loadingText      = document.getElementById('loading-text');
const offlineScreen    = document.getElementById('offline-screen');
const offlineTitle     = document.getElementById('offline-title');
const offlineMessage   = document.getElementById('offline-message');
const viewerScreen     = document.getElementById('viewer-screen');
const remoteVideo      = document.getElementById('remote-video');
const viewerCountNum   = document.getElementById('viewer-count-num');
const hud              = document.getElementById('hud');
const bufferIndicator  = document.getElementById('buffer-indicator');
const toastContainer   = document.getElementById('toast-container');

// ─── Exibir tela correta ───────────────────────────────────────────────────────
function showLoading(text = 'Conectando à transmissão...') {
  loadingText.textContent = text;
  loadingScreen.style.display  = 'flex';
  offlineScreen.style.display  = 'none';
  viewerScreen.style.display   = 'none';
}

function showOffline(title, message) {
  loadingScreen.style.display  = 'none';
  offlineScreen.style.display  = 'flex';
  viewerScreen.style.display   = 'none';
  offlineTitle.textContent     = title   || 'Esta transmissão foi encerrada';
  offlineMessage.textContent   = message || 'O transmissor encerrou a transmissão. O link não está mais ativo.';
}

function showViewer() {
  loadingScreen.style.display  = 'none';
  offlineScreen.style.display  = 'none';
  viewerScreen.style.display   = 'block';
  scheduleHudHide();
}

// ─── HUD auto-hide ao mover mouse ────────────────────────────────────────────
function scheduleHudHide() {
  hud.classList.remove('hidden');
  clearTimeout(hudTimeout);
  hudTimeout = setTimeout(() => {
    hud.classList.add('hidden');
  }, 4000);
}

document.addEventListener('mousemove', () => {
  if (viewerScreen.style.display === 'block') scheduleHudHide();
});

document.addEventListener('click', () => {
  if (viewerScreen.style.display === 'block') scheduleHudHide();
});

// ─── Criar RTCPeerConnection ────────────────────────────────────────────────────
function createPeerConnection() {
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }

  const pc = new RTCPeerConnection(ICE_CONFIG);
  peerConnection = pc;

  // Quando receber tracks do broadcaster
  pc.ontrack = (event) => {
    console.log('[WebRTC] Track recebida:', event.track.kind);
    if (event.streams && event.streams[0]) {
      if (remoteVideo.srcObject !== event.streams[0]) {
        remoteVideo.srcObject = event.streams[0];
        console.log('[WebRTC] Stream atribuído ao vídeo');

        // Forçar play — navegadores bloqueiam autoplay com áudio
        remoteVideo.play().then(() => {
          showViewer();
        }).catch(err => {
          console.warn('[Video] play() bloqueado, mostrando botão de iniciar:', err);
          showViewer();
          showPlayOverlay();
        });
      }
    }
  };

  // Mostrar tela assim que o vídeo tiver dados suficientes para tocar
  remoteVideo.onloadedmetadata = () => {
    console.log('[Video] Metadata carregada, iniciando play');
    remoteVideo.play().catch(() => { showPlayOverlay(); });
    showViewer();
  };

  remoteVideo.oncanplay = () => {
    console.log('[Video] Pronto para tocar');
    showViewer();
  };

  // Buffer indicator
  remoteVideo.onwaiting = () => {
    bufferIndicator.style.display = 'flex';
  };
  remoteVideo.onplaying = () => {
    bufferIndicator.style.display = 'none';
    showViewer();
  };

  // Enviar ICE candidates ao broadcaster via servidor
  pc.onicecandidate = ({ candidate }) => {
    if (candidate) {
      socket.emit('ice-candidate', {
        candidate,
        streamId
      });
    }
  };

  pc.onconnectionstatechange = () => {
    console.log('[WebRTC] Connection state:', pc.connectionState);
    switch (pc.connectionState) {
      case 'connected':
        console.log('[WebRTC] Conectado ao broadcaster!');
        // Fallback: se o vídeo já tem stream mas a tela ainda não apareceu
        if (remoteVideo.srcObject) {
          remoteVideo.play().catch(() => {});
          showViewer();
        }
        break;
      case 'disconnected':
        showToast('Conexão instável...', 'info');
        break;
      case 'failed':
        showToast('Falha na conexão WebRTC.', 'error');
        showOffline('Falha na conexão', 'Não foi possível conectar à transmissão. Tente recarregar a página.');
        break;
      case 'closed':
        break;
    }
  };

  // ICE connected — mais um fallback para mostrar o vídeo
  pc.oniceconnectionstatechange = () => {
    console.log('[ICE] State:', pc.iceConnectionState);
    if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
      if (remoteVideo.srcObject) {
        remoteVideo.play().catch(() => {});
        setTimeout(() => showViewer(), 500);
      }
    }
  };

  return pc;
}

// ─── Conectar ao servidor e entrar na transmissão ──────────────────────────────
function connect() {
  if (!streamId || streamId.length < 4) {
    showOffline('Link inválido', 'O link que você acessou não é válido.');
    return;
  }

  showLoading('Conectando...');

  socket = io();

  socket.on('connect', () => {
    console.log('[Socket] Conectado:', socket.id);
    showLoading('Verificando transmissão...');

    // Tentar entrar na transmissão
    socket.emit('viewer-join', { streamId }, ({ success, reason }) => {
      if (!success) {
        if (reason === 'offline') {
          showOffline('Transmissão não encontrada', 'Esta transmissão não existe ou já foi encerrada.');
        } else {
          showOffline('Erro ao conectar', 'Não foi possível entrar nesta transmissão.');
        }
        return;
      }

      showLoading('Aguardando vídeo...');
      console.log('[Viewer] Entrou na transmissão:', streamId);
    });
  });

  socket.on('disconnect', (reason) => {
    console.log('[Socket] Desconectado:', reason);
    if (viewerScreen.style.display === 'block' || loadingScreen.style.display === 'flex') {
      showOffline('Conexão perdida', 'Você foi desconectado do servidor. Recarregue a página para tentar novamente.');
    }
  });

  // Receber offer do broadcaster
  socket.on('offer', async ({ sdp, broadcasterSocketId }) => {
    console.log('[WebRTC] Offer recebida do broadcaster');

    const pc = createPeerConnection();
    showLoading('Estabelecendo conexão de vídeo...');

    try {
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      socket.emit('answer', {
        sdp: pc.localDescription,
        streamId
      });

      console.log('[WebRTC] Answer enviada');
    } catch (err) {
      console.error('[WebRTC] Erro ao processar offer:', err);
      showOffline('Erro de conexão', 'Não foi possível estabelecer a conexão de vídeo.');
    }
  });

  // Receber ICE candidate do broadcaster
  socket.on('ice-candidate', async ({ candidate }) => {
    if (!peerConnection || !candidate) return;
    try {
      await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
      console.error('[ICE] Erro ao adicionar candidate:', err);
    }
  });

  // Transmissão encerrada pelo broadcaster
  socket.on('stream-ended', ({ reason }) => {
    console.log('[Stream] Encerrada. Motivo:', reason);

    if (peerConnection) {
      peerConnection.close();
      peerConnection = null;
    }

    if (remoteVideo.srcObject) {
      remoteVideo.srcObject.getTracks().forEach(t => t.stop());
      remoteVideo.srcObject = null;
    }

    showOffline(
      'Esta transmissão foi encerrada',
      'O transmissor encerrou a transmissão ao vivo.'
    );
  });

  // Atualização de contagem de viewers
  socket.on('viewer-count', ({ count }) => {
    if (viewerCountNum) viewerCountNum.textContent = count;
  });
}

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
  }, 4000);
}

// ─── Botão de Play Overlay (Burlar Autoplay) ──────────────────────────────────
let overlayCriado = false;
function showPlayOverlay() {
  if (overlayCriado) return;
  overlayCriado = true;

  const btn = document.createElement('button');
  btn.className = 'btn btn-primary';
  btn.innerHTML = `
    <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
      <polygon points="5 3 19 12 5 21 5 3"></polygon>
    </svg>
    Clique para assistir
  `;
  btn.style.position = 'fixed';
  btn.style.top = '50%';
  btn.style.left = '50%';
  btn.style.transform = 'translate(-50%, -50%)';
  btn.style.zIndex = '9999';
  btn.style.boxShadow = '0 0 30px rgba(124, 58, 237, 0.6)';
  btn.style.padding = '16px 32px';
  btn.style.fontSize = '1.2rem';
  
  // Fundo escuro atrás do botão
  const bg = document.createElement('div');
  bg.style.position = 'fixed';
  bg.style.inset = '0';
  bg.style.background = 'rgba(0,0,0,0.7)';
  bg.style.zIndex = '9998';
  bg.style.display = 'flex';
  bg.style.alignItems = 'center';
  bg.style.justifyContent = 'center';
  
  bg.appendChild(btn);
  document.body.appendChild(bg);

  btn.addEventListener('click', () => {
    remoteVideo.play();
    bg.remove();
  });
}

// ─── Iniciar ───────────────────────────────────────────────────────────────────
connect();
