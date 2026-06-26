require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dodo-gizli-anahtar-degistirin';

// Veritabanı kurulumu
const db = new Database(process.env.DB_PATH || './dodo.db');
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    type TEXT CHECK(type IN ('text', 'voice')) NOT NULL DEFAULT 'text',
    position INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(channel_id) REFERENCES channels(id),
    FOREIGN KEY(user_id) REFERENCES users(id)
  );
`);

// Varsayılan kanalları oluştur
const channelCount = db.prepare('SELECT COUNT(*) as cnt FROM channels').get().cnt;
if (channelCount === 0) {
  const insert = db.prepare('INSERT INTO channels (name, type, position) VALUES (?, ?, ?)');
  insert.run('genel', 'text', 0);
  insert.run('duyurular', 'text', 1);
  insert.run('sesli-oda', 'voice', 2);
  insert.run('ekran-paylaşım', 'voice', 3);
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Token gerekli' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Geçersiz token' });
  }
}

// API rotaları
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username?.trim() || !password) {
    return res.status(400).json({ error: 'Kullanıcı adı ve şifre gerekli' });
  }
  const trimmed = username.trim();
  if (trimmed.length < 2 || trimmed.length > 20) {
    return res.status(400).json({ error: 'Kullanıcı adı 2-20 karakter olmalı' });
  }
  if (password.length < 4) {
    return res.status(400).json({ error: 'Şifre en az 4 karakter olmalı' });
  }
  try {
    const hash = await bcrypt.hash(password, 10);
    const result = db.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run(trimmed, hash);
    const token = jwt.sign({ id: result.lastInsertRowid, username: trimmed }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, username: trimmed });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(400).json({ error: 'Bu kullanıcı adı kullanılıyor' });
    console.error('Kayıt hatası:', e);
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username?.trim());
  if (!user) return res.status(401).json({ error: 'Kullanıcı adı veya şifre hatalı' });
  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.status(401).json({ error: 'Kullanıcı adı veya şifre hatalı' });
  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, username: user.username });
});

app.get('/api/channels', requireAuth, (req, res) => {
  const channels = db.prepare('SELECT * FROM channels ORDER BY position ASC, type DESC').all();
  res.json(channels);
});

app.get('/api/messages/:channelId', requireAuth, (req, res) => {
  const messages = db.prepare(`
    SELECT m.id, m.content, m.created_at, u.username, u.id as user_id
    FROM messages m
    JOIN users u ON m.user_id = u.id
    WHERE m.channel_id = ?
    ORDER BY m.created_at ASC
    LIMIT 100
  `).all(req.params.channelId);
  res.json(messages);
});

// Sesli odalar bellekte tutulur (sunucu yeniden başlayınca sıfırlanır)
// { channelId: { socketId: { username, userId } } }
const voiceRooms = {};

// Socket.io kimlik doğrulama
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error('Kimlik doğrulama gerekli'));
  try {
    socket.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    next(new Error('Geçersiz token'));
  }
});

io.on('connection', (socket) => {
  const { id: userId, username } = socket.user;
  console.log(`[+] ${username} bağlandı (${socket.id})`);

  // Bağlanınca mevcut sesli oda durumunu gönder
  socket.on('get-voice-state', () => {
    const state = {};
    Object.entries(voiceRooms).forEach(([channelId, users]) => {
      state[channelId] = Object.values(users).map(u => u.username);
    });
    socket.emit('voice-state', state);
  });

  // Metin kanalı
  socket.on('join-channel', (channelId) => {
    if (socket.textChannel) socket.leave(`text:${socket.textChannel}`);
    socket.textChannel = channelId;
    socket.join(`text:${channelId}`);
  });

  socket.on('send-message', ({ channelId, content }) => {
    const trimmed = content?.trim();
    if (!trimmed || trimmed.length > 2000) return;

    const result = db.prepare(
      'INSERT INTO messages (channel_id, user_id, content) VALUES (?, ?, ?)'
    ).run(channelId, userId, trimmed);

    const msg = db.prepare(`
      SELECT m.id, m.content, m.created_at, u.username, u.id as user_id
      FROM messages m JOIN users u ON m.user_id = u.id
      WHERE m.id = ?
    `).get(result.lastInsertRowid);

    io.to(`text:${channelId}`).emit('new-message', msg);
  });

  // Sesli kanal
  socket.on('join-voice', (channelId) => {
    if (!voiceRooms[channelId]) voiceRooms[channelId] = {};

    const existing = Object.entries(voiceRooms[channelId])
      .filter(([sid]) => sid !== socket.id)
      .map(([sid, data]) => ({ socketId: sid, username: data.username }));

    voiceRooms[channelId][socket.id] = { username, userId };
    socket.voiceChannel = channelId;
    socket.join(`voice:${channelId}`);

    // Mevcut katılımcıları yeni kullanıcıya bildir (o teklif yapacak)
    socket.emit('voice-participants', { channelId, participants: existing });

    // Diğerlerine yeni katılımcıyı bildir
    socket.to(`voice:${channelId}`).emit('user-joined-voice', {
      channelId, socketId: socket.id, username
    });

    broadcastVoiceUpdate(channelId);
  });

  socket.on('leave-voice', () => handleLeaveVoice(socket));

  // WebRTC sinyalleşme - sunucu sadece iletim yapar
  socket.on('webrtc-offer', ({ to, offer, channelId }) => {
    io.to(to).emit('webrtc-offer', { from: socket.id, fromUsername: username, offer, channelId });
  });

  socket.on('webrtc-answer', ({ to, answer }) => {
    io.to(to).emit('webrtc-answer', { from: socket.id, answer });
  });

  socket.on('webrtc-ice', ({ to, candidate }) => {
    io.to(to).emit('webrtc-ice', { from: socket.id, candidate });
  });

  // Ekran paylaşımı bildirimleri
  socket.on('screen-share-started', ({ channelId }) => {
    socket.to(`voice:${channelId}`).emit('screen-share-update', {
      socketId: socket.id, username, sharing: true
    });
  });

  socket.on('screen-share-stopped', ({ channelId }) => {
    socket.to(`voice:${channelId}`).emit('screen-share-update', {
      socketId: socket.id, username, sharing: false
    });
  });

  // Mikrofon durumu
  socket.on('mute-status', ({ channelId, muted }) => {
    socket.to(`voice:${channelId}`).emit('user-mute-update', {
      socketId: socket.id, username, muted
    });
  });

  socket.on('disconnect', () => {
    console.log(`[-] ${username} ayrıldı`);
    if (socket.voiceChannel) handleLeaveVoice(socket);
  });
});

function handleLeaveVoice(socket) {
  const channelId = socket.voiceChannel;
  if (!channelId || !voiceRooms[channelId]) return;

  delete voiceRooms[channelId][socket.id];
  socket.leave(`voice:${channelId}`);
  socket.voiceChannel = null;

  io.to(`voice:${channelId}`).emit('user-left-voice', {
    channelId, socketId: socket.id
  });

  broadcastVoiceUpdate(channelId);
}

function broadcastVoiceUpdate(channelId) {
  const participants = Object.values(voiceRooms[channelId] || {}).map(u => u.username);
  io.emit('voice-room-update', { channelId, participants });
}

server.listen(PORT, () => {
  console.log(`Dodo sunucu çalışıyor: http://localhost:${PORT}`);
});
