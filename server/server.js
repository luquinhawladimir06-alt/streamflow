const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');
const path = require('path');
const session = require('express-session');
const axios = require('axios');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

const PORT = process.env.PORT || 3000;

// ─── Sessão ──────────────────────────────────────────────────────────────────
app.use(session({
  secret: process.env.SESSION_SECRET || 'streamflow-super-secret-key-xyz123',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 1000 * 60 * 60 * 24 * 7 } // 7 dias
}));

// ─── Autenticação Discord (OAuth2) ───────────────────────────────────────────
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
// Em produção, isso deve ser a URL do seu site no Railway (ex: https://seu-app.railway.app/auth/discord/callback)
const DISCORD_REDIRECT_URI = process.env.DISCORD_REDIRECT_URI || 'http://localhost:3000/auth/discord/callback';

app.get('/auth/discord', (req, res) => {
  if (!DISCORD_CLIENT_ID) return res.send('Discord OAuth não configurado pelo administrador.');
  const url = `https://discord.com/api/oauth2/authorize?client_id=${DISCORD_CLIENT_ID}&redirect_uri=${encodeURIComponent(DISCORD_REDIRECT_URI)}&response_type=code&scope=identify`;
  res.redirect(url);
});

app.get('/auth/discord/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.redirect('/');
  
  try {
    const params = new URLSearchParams({
      client_id: DISCORD_CLIENT_ID,
      client_secret: DISCORD_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code: code,
      redirect_uri: DISCORD_REDIRECT_URI
    });

    const tokenResponse = await axios.post('https://discord.com/api/oauth2/token', params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    
    const userResponse = await axios.get('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${tokenResponse.data.access_token}` }
    });

    const u = userResponse.data;
    req.session.user = {
      id: u.id,
      username: u.global_name || u.username,
      avatar: u.avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png` : null
    };

    res.redirect('/');
  } catch (err) {
    console.error('Erro no login Discord:', err.message);
    res.redirect('/');
  }
});

app.get('/auth/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

app.get('/api/user', (req, res) => {
  if (req.session && req.session.user) {
    const isAdmin = process.env.ADMIN_DISCORD_ID && req.session.user.id === process.env.ADMIN_DISCORD_ID;
    res.json({ loggedIn: true, user: req.session.user, isAdmin });
  } else {
    res.json({ loggedIn: false, isAdmin: false });
  }
});

// ─── API do Painel Admin ─────────────────────────────────────────────────────
app.get('/api/admin/stats', (req, res) => {
  // Verifica se o usuário está logado e se é o Admin
  if (!req.session || !req.session.user || !process.env.ADMIN_DISCORD_ID || req.session.user.id !== process.env.ADMIN_DISCORD_ID) {
    return res.status(403).json({ error: 'Acesso negado. Apenas o dono pode ver as estatísticas.' });
  }

  // Coletar estatísticas
  const stats = {
    totalConnections: io.engine.clientsCount, // total de conexões abertas no servidor
    activeStreamsCount: broadcasts.size,
    streams: []
  };

  broadcasts.forEach((data, streamId) => {
    stats.streams.push({
      streamId: streamId,
      broadcasterSocket: data.broadcasterSocketId,
      viewersCount: data.viewers.size
    });
  });

  res.json(stats);
});

// ─── Estado das transmissões ─────────────────────────────────────────────────
// Map: streamId → { broadcasterSocketId, broadcasterToken, viewers: Set<socketId> }
const broadcasts = new Map();

// ─── Arquivos estáticos ───────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '..', 'public')));

// Rota SPA: /live/:id → serve live.html
app.get('/live/:id', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'live.html'));
});

// API: verificar se uma transmissão está ativa
app.get('/api/stream/:id', (req, res) => {
  const { id } = req.params;
  const broadcast = broadcasts.get(id);
  if (broadcast) {
    res.json({ active: true, viewers: broadcast.viewers.size });
  } else {
    res.json({ active: false });
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
function generateStreamId() {
  // 6 bytes = 12 hex chars → usamos 4 bytes uppercase para ID curto e legível
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}

function generateBroadcasterToken() {
  return crypto.randomBytes(32).toString('hex');
}

function getViewerCount(streamId) {
  const b = broadcasts.get(streamId);
  return b ? b.viewers.size : 0;
}

function broadcastViewerCount(streamId) {
  const count = getViewerCount(streamId);
  const b = broadcasts.get(streamId);
  if (!b) return;

  // Notifica broadcaster
  io.to(b.broadcasterSocketId).emit('viewer-count', { count });

  // Notifica todos os viewers
  b.viewers.forEach((viewerSocketId) => {
    io.to(viewerSocketId).emit('viewer-count', { count });
  });
}

// ─── Socket.IO ────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[+] Socket conectado: ${socket.id}`);

  // ── BROADCASTER: iniciar transmissão ─────────────────────────────────────
  socket.on('start-broadcast', (data, callback) => {
    // Garantir que este socket não já está transmitindo
    for (const [sid, b] of broadcasts.entries()) {
      if (b.broadcasterSocketId === socket.id) {
        // Encerrar transmissão anterior automaticamente
        endBroadcast(sid, 'replaced');
        break;
      }
    }

    const streamId = generateStreamId();
    const broadcasterToken = generateBroadcasterToken();

    broadcasts.set(streamId, {
      broadcasterSocketId: socket.id,
      broadcasterToken,
      viewers: new Set()
    });

    console.log(`[LIVE] Transmissão iniciada: ${streamId} por ${socket.id}`);

    if (typeof callback === 'function') {
      callback({ streamId, broadcasterToken });
    }
  });

  // ── BROADCASTER: encerrar transmissão ────────────────────────────────────
  socket.on('end-broadcast', ({ streamId, broadcasterToken }) => {
    const b = broadcasts.get(streamId);
    if (!b) return;

    // Validar token — apenas o broadcaster original pode encerrar
    if (b.broadcasterSocketId !== socket.id || b.broadcasterToken !== broadcasterToken) {
      socket.emit('error-event', { message: 'Não autorizado a encerrar esta transmissão.' });
      return;
    }

    endBroadcast(streamId, 'ended-by-broadcaster');
  });

  // ── VIEWER: entrar na transmissão ────────────────────────────────────────
  socket.on('viewer-join', ({ streamId }, callback) => {
    const b = broadcasts.get(streamId);

    if (!b) {
      if (typeof callback === 'function') {
        callback({ success: false, reason: 'offline' });
      }
      return;
    }

    b.viewers.add(socket.id);
    socket.data.viewingStreamId = streamId;

    console.log(`[VIEW] Espectador ${socket.id} entrou em ${streamId} (total: ${b.viewers.size})`);

    if (typeof callback === 'function') {
      callback({ success: true });
    }

    // Atualizar contagem para todos
    broadcastViewerCount(streamId);

    // Notificar o broadcaster que um novo viewer chegou — ele criará a PeerConnection
    io.to(b.broadcasterSocketId).emit('viewer-joined', { viewerSocketId: socket.id });
  });

  // ── WebRTC: Offer (broadcaster → viewer via servidor) ───────────────────
  socket.on('offer', ({ targetSocketId, sdp, streamId }) => {
    const b = broadcasts.get(streamId);
    if (!b || b.broadcasterSocketId !== socket.id) return;

    io.to(targetSocketId).emit('offer', { sdp, broadcasterSocketId: socket.id });
  });

  // ── WebRTC: Answer (viewer → broadcaster via servidor) ──────────────────
  socket.on('answer', ({ sdp, streamId }) => {
    const b = broadcasts.get(streamId);
    if (!b) return;

    // Verificar que o remetente é de fato um viewer desta stream
    if (!b.viewers.has(socket.id)) return;

    io.to(b.broadcasterSocketId).emit('answer', { sdp, viewerSocketId: socket.id });
  });

  // ── WebRTC: ICE Candidate ─────────────────────────────────────────────────
  socket.on('ice-candidate', ({ candidate, targetSocketId, streamId }) => {
    const b = broadcasts.get(streamId);
    if (!b) return;

    // Broadcaster → viewer
    if (b.broadcasterSocketId === socket.id) {
      io.to(targetSocketId).emit('ice-candidate', { candidate });
      return;
    }

    // Viewer → broadcaster
    if (b.viewers.has(socket.id)) {
      io.to(b.broadcasterSocketId).emit('ice-candidate', {
        candidate,
        viewerSocketId: socket.id
      });
    }
  });

  // ── Desconexão ─────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    console.log(`[-] Socket desconectado: ${socket.id}`);

    // Verificar se era broadcaster
    for (const [streamId, b] of broadcasts.entries()) {
      if (b.broadcasterSocketId === socket.id) {
        console.log(`[END] Broadcaster desconectou — encerrando ${streamId}`);
        endBroadcast(streamId, 'broadcaster-disconnected');
        return;
      }
    }

    // Verificar se era viewer
    const streamId = socket.data.viewingStreamId;
    if (streamId) {
      const b = broadcasts.get(streamId);
      if (b) {
        b.viewers.delete(socket.id);
        console.log(`[VIEW] Espectador ${socket.id} saiu de ${streamId} (total: ${b.viewers.size})`);
        broadcastViewerCount(streamId);
      }
    }
  });
});

// ─── Encerrar transmissão ─────────────────────────────────────────────────────
function endBroadcast(streamId, reason) {
  const b = broadcasts.get(streamId);
  if (!b) return;

  // Notificar todos os viewers
  b.viewers.forEach((viewerSocketId) => {
    io.to(viewerSocketId).emit('stream-ended', { reason });
  });

  // Notificar o broadcaster (confirmação)
  io.to(b.broadcasterSocketId).emit('broadcast-ended', { streamId });

  broadcasts.delete(streamId);
  console.log(`[END] Transmissão ${streamId} encerrada. Motivo: ${reason}`);
}

// ─── Iniciar servidor ─────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n🎥 StreamFlow rodando em http://localhost:${PORT}\n`);
});
