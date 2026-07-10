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

const db = new Database(process.env.DB_PATH || './dodo.db');
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    avatar TEXT DEFAULT NULL,
    is_admin INTEGER DEFAULT 0,
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
    reply_to_id INTEGER DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(channel_id) REFERENCES channels(id),
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS dm_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id INTEGER NOT NULL,
    recipient_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(sender_id) REFERENCES users(id),
    FOREIGN KEY(recipient_id) REFERENCES users(id)
  );
`);

try { db.exec('ALTER TABLE users ADD COLUMN avatar TEXT DEFAULT NULL'); } catch(e) {}
try { db.exec('ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0'); } catch(e) {}
try { db.exec('ALTER TABLE messages ADD COLUMN reply_to_id INTEGER DEFAULT NULL'); } catch(e) {}

db.prepare('UPDATE users SET is_admin=1 WHERE id=(SELECT MIN(id) FROM users) AND (SELECT COUNT(*) FROM users WHERE is_admin=1)=0').run();

const channelCount = db.prepare('SELECT COUNT(*) as cnt FROM channels').get().cnt;
if (channelCount === 0) {
  const insert = db.prepare('INSERT INTO channels (name, type, position) VALUES (?, ?, ?)');
  insert.run('genel', 'text', 0);
  insert.run('duyurular', 'text', 1);
  insert.run('sesli-oda', 'voice', 2);
  insert.run('ekran-paylaşım', 'voice', 3);
}

app.use(express.json({ limit: '10mb' }));
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

function requireAdmin(req, res, next) {
  const user = db.prepare('SELECT is_admin FROM users WHERE id=?').get(req.user.id);
  if (!user?.is_admin) return res.status(403).json({ error: 'Yetki gerekli' });
  next();
}

// ============ AUTH ============

app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username?.trim() || !password) return res.status(400).json({ error: 'Kullanıcı adı ve şifre gerekli' });
  const trimmed = username.trim();
  if (trimmed.length < 2 || trimmed.length > 20) return res.status(400).json({ error: 'Kullanıcı adı 2-20 karakter olmalı' });
  if (password.length < 4) return res.status(400).json({ error: 'Şifre en az 4 karakter olmalı' });
  try {
    const hash = await bcrypt.hash(password, 10);
    const result = db.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run(trimmed, hash);
    const userCount = db.prepare('SELECT COUNT(*) as cnt FROM users').get().cnt;
    if (userCount === 1) db.prepare('UPDATE users SET is_admin=1 WHERE id=?').run(result.lastInsertRowid);
    const newUser = db.prepare('SELECT is_admin FROM users WHERE id=?').get(result.lastInsertRowid);
    const token = jwt.sign({ id: result.lastInsertRowid, username: trimmed, is_admin: newUser.is_admin }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, username: trimmed, is_admin: newUser.is_admin });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(400).json({ error: 'Bu kullanıcı adı kullanılıyor' });
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username?.trim());
  if (!user) return res.status(401).json({ error: 'Kullanıcı adı veya şifre hatalı' });
  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.status(401).json({ error: 'Kullanıcı adı veya şifre hatalı' });
  const token = jwt.sign({ id: user.id, username: user.username, is_admin: user.is_admin }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, username: user.username, is_admin: user.is_admin });
});

app.get('/api/me', requireAuth, (req, res) => {
  const user = db.prepare('SELECT id, username, avatar, is_admin FROM users WHERE id=?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
  res.json(user);
});

app.put('/api/profile', requireAuth, (req, res) => {
  const { username, avatar } = req.body;
  const updates = [], params = [];
  if (username !== undefined) {
    const t = username.trim();
    if (t.length < 2 || t.length > 20) return res.status(400).json({ error: 'Kullanıcı adı 2-20 karakter olmalı' });
    updates.push('username=?'); params.push(t);
  }
  if (avatar !== undefined) {
    if (avatar !== null && !avatar.startsWith('data:image/')) return res.status(400).json({ error: 'Geçersiz avatar formatı' });
    updates.push('avatar=?'); params.push(avatar);
  }
  if (!updates.length) return res.status(400).json({ error: 'Güncellenecek alan yok' });
  params.push(req.user.id);
  try {
    db.prepare(`UPDATE users SET ${updates.join(',')} WHERE id=?`).run(...params);
    const user = db.prepare('SELECT id, username, avatar, is_admin FROM users WHERE id=?').get(req.user.id);
    const newToken = jwt.sign({ id: user.id, username: user.username, is_admin: user.is_admin }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token: newToken, username: user.username, avatar: user.avatar });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(400).json({ error: 'Bu kullanıcı adı kullanılıyor' });
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// ============ CHANNELS & MESSAGES ============

app.get('/api/channels', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM channels ORDER BY position ASC, type DESC').all());
});

const MSG_SELECT = `
  SELECT m.id, m.channel_id, m.content, m.created_at, m.reply_to_id,
         u.username, u.id as user_id, u.avatar,
         ru.username as reply_username,
         rm.content as reply_content
  FROM messages m
  JOIN users u ON m.user_id = u.id
  LEFT JOIN messages rm ON m.reply_to_id = rm.id
  LEFT JOIN users ru ON rm.user_id = ru.id
`;

app.get('/api/messages/:channelId', requireAuth, (req, res) => {
  const messages = db.prepare(`${MSG_SELECT} WHERE m.channel_id = ? ORDER BY m.created_at ASC LIMIT 100`).all(req.params.channelId);
  res.json(messages);
});

// Mesaj sil (admin her mesajı, kullanıcı kendi mesajını silebilir)
app.delete('/api/messages/:messageId', requireAuth, (req, res) => {
  const msg = db.prepare('SELECT * FROM messages WHERE id=?').get(req.params.messageId);
  if (!msg) return res.status(404).json({ error: 'Mesaj bulunamadı' });

  const user = db.prepare('SELECT is_admin FROM users WHERE id=?').get(req.user.id);
  if (!user?.is_admin && msg.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Bu mesajı silme yetkiniz yok' });
  }

  db.prepare('DELETE FROM messages WHERE id=?').run(msg.id);
  io.to(`text:${msg.channel_id}`).emit('message-deleted', { messageId: msg.id });
  res.json({ ok: true });
});

// Kanalı temizle (admin)
app.delete('/api/channels/:channelId/messages', requireAuth, requireAdmin, (req, res) => {
  const channelId = req.params.channelId;
  db.prepare('DELETE FROM messages WHERE channel_id=?').run(channelId);
  io.to(`text:${channelId}`).emit('channel-cleared', { channelId });
  res.json({ ok: true });
});

// Kanal bilgisi (mesaj sayısı, üye sayısı)
app.get('/api/channels/:channelId/info', requireAuth, (req, res) => {
  const channelId = req.params.channelId;
  const msgCount = db.prepare('SELECT COUNT(*) as cnt FROM messages WHERE channel_id=?').get(channelId).cnt;
  const userCount = db.prepare('SELECT COUNT(DISTINCT user_id) as cnt FROM messages WHERE channel_id=?').get(channelId).cnt;
  res.json({ message_count: msgCount, user_count: userCount });
});

// ============ DIRECT MESSAGES ============

const DM_SELECT = `
  SELECT dm.id, dm.sender_id, dm.recipient_id, dm.content, dm.created_at,
         u.username as sender_username, u.avatar as sender_avatar
  FROM dm_messages dm
  JOIN users u ON dm.sender_id = u.id
`;

// Belirli bir kullanıcıyla olan özel mesaj geçmişi
app.get('/api/dm/:userId', requireAuth, (req, res) => {
  const other = parseInt(req.params.userId);
  const me = req.user.id;
  const messages = db.prepare(
    `${DM_SELECT} WHERE (dm.sender_id=? AND dm.recipient_id=?) OR (dm.sender_id=? AND dm.recipient_id=?)
     ORDER BY dm.created_at ASC LIMIT 200`
  ).all(me, other, other, me);
  const user = db.prepare('SELECT id, username, avatar, is_admin FROM users WHERE id=?').get(other);
  res.json({ user, messages });
});

// ============ SOCKET ============

const voiceRooms = {};
const onlineUsers = new Map();   // userId -> { id, username, avatar, is_admin }
const userSockets = new Map();   // userId -> Set(socketId)

function broadcastPresence() {
  const users = Array.from(onlineUsers.values());
  io.emit('online-users', users);
}

io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error('Kimlik doğrulama gerekli'));
  try {
    socket.user = jwt.verify(token, JWT_SECRET);
    // Avatarı DB'den yükle
    const u = db.prepare('SELECT avatar FROM users WHERE id=?').get(socket.user.id);
    socket.user.avatar = u?.avatar || null;
    next();
  } catch {
    next(new Error('Geçersiz token'));
  }
});

io.on('connection', (socket) => {
  const { id: userId, username } = socket.user;
  console.log(`[+] ${username} bağlandı (${socket.id})`);

  // Presence: çevrimiçi kullanıcı listesine ekle
  if (!userSockets.has(userId)) userSockets.set(userId, new Set());
  userSockets.get(userId).add(socket.id);
  onlineUsers.set(userId, {
    id: userId, username, avatar: socket.user.avatar || null,
    is_admin: socket.user.is_admin ? 1 : 0
  });
  broadcastPresence();

  // Özel mesaj gönder
  socket.on('dm-send', ({ toUserId, content }) => {
    const trimmed = content?.trim();
    if (!trimmed || trimmed.length > 2000 || !toUserId) return;
    const result = db.prepare(
      'INSERT INTO dm_messages (sender_id, recipient_id, content) VALUES (?, ?, ?)'
    ).run(userId, toUserId, trimmed);
    const msg = db.prepare(`${DM_SELECT} WHERE dm.id=?`).get(result.lastInsertRowid);
    // Hem alıcının hem gönderenin tüm sekmelerine ilet
    const targets = new Set([
      ...(userSockets.get(toUserId) || []),
      ...(userSockets.get(userId) || [])
    ]);
    targets.forEach(sid => io.to(sid).emit('dm-message', msg));
  });

  // Profil değişince (avatar/isim) çevrimiçi listeyi tazele
  socket.on('profile-changed', ({ username: newName, avatar }) => {
    if (newName) socket.user.username = newName;
    if (avatar !== undefined) socket.user.avatar = avatar;
    const entry = onlineUsers.get(userId);
    if (entry) {
      entry.username = socket.user.username;
      entry.avatar = socket.user.avatar || null;
      broadcastPresence();
    }
  });

  socket.on('get-voice-state', () => {
    const state = {};
    Object.entries(voiceRooms).forEach(([channelId, users]) => {
      state[channelId] = Object.entries(users).map(([sid, u]) => ({
        socketId: sid, username: u.username, avatar: u.avatar
      }));
    });
    socket.emit('voice-state', state);
  });

  socket.on('join-channel', (channelId) => {
    if (socket.textChannel) socket.leave(`text:${socket.textChannel}`);
    socket.textChannel = channelId;
    socket.join(`text:${channelId}`);
  });

  socket.on('send-message', ({ channelId, content, replyToId }) => {
    const trimmed = content?.trim();
    if (!trimmed || trimmed.length > 2000) return;

    const result = db.prepare(
      'INSERT INTO messages (channel_id, user_id, content, reply_to_id) VALUES (?, ?, ?, ?)'
    ).run(channelId, userId, trimmed, replyToId || null);

    const msg = db.prepare(`${MSG_SELECT} WHERE m.id = ?`).get(result.lastInsertRowid);
    io.to(`text:${channelId}`).emit('new-message', msg);
  });

  socket.on('join-voice', (channelId) => {
    if (socket.voiceChannel && socket.voiceChannel !== channelId) handleLeaveVoice(socket);
    if (!voiceRooms[channelId]) voiceRooms[channelId] = {};

    const existing = Object.entries(voiceRooms[channelId])
      .filter(([sid]) => sid !== socket.id)
      .map(([sid, data]) => ({ socketId: sid, username: data.username, avatar: data.avatar }));

    voiceRooms[channelId][socket.id] = { username, userId, avatar: socket.user.avatar };
    socket.voiceChannel = channelId;
    socket.join(`voice:${channelId}`);

    socket.emit('voice-participants', { channelId, participants: existing });
    socket.to(`voice:${channelId}`).emit('user-joined-voice', {
      channelId, socketId: socket.id, username, avatar: socket.user.avatar
    });
    broadcastVoiceUpdate(channelId);
  });

  socket.on('leave-voice', () => handleLeaveVoice(socket));

  socket.on('admin-kick-voice', ({ targetSocketId }) => {
    const adminUser = db.prepare('SELECT is_admin FROM users WHERE id=?').get(socket.user.id);
    if (!adminUser?.is_admin) return;
    const targetSocket = io.sockets.sockets.get(targetSocketId);
    if (!targetSocket) return;
    handleLeaveVoice(targetSocket);
    targetSocket.emit('force-leave-voice');
  });

  socket.on('admin-move-voice', ({ targetSocketId, channelId }) => {
    const adminUser = db.prepare('SELECT is_admin FROM users WHERE id=?').get(socket.user.id);
    if (!adminUser?.is_admin) return;
    const targetSocket = io.sockets.sockets.get(targetSocketId);
    if (!targetSocket) return;
    handleLeaveVoice(targetSocket);
    targetSocket.emit('force-join-voice', { channelId });
  });

  socket.on('webrtc-offer', ({ to, offer, channelId, kind }) => {
    io.to(to).emit('webrtc-offer', { from: socket.id, fromUsername: username, offer, channelId, kind });
  });
  socket.on('webrtc-answer', ({ to, answer, kind }) => {
    io.to(to).emit('webrtc-answer', { from: socket.id, answer, kind });
  });
  socket.on('webrtc-ice', ({ to, candidate, kind }) => {
    io.to(to).emit('webrtc-ice', { from: socket.id, candidate, kind });
  });
  socket.on('screen-share-started', ({ channelId }) => {
    socket.to(`voice:${channelId}`).emit('screen-share-update', { socketId: socket.id, username, sharing: true });
  });
  socket.on('screen-share-stopped', ({ channelId }) => {
    socket.to(`voice:${channelId}`).emit('screen-share-update', { socketId: socket.id, username, sharing: false });
  });
  socket.on('mute-status', ({ channelId, muted }) => {
    socket.to(`voice:${channelId}`).emit('user-mute-update', { socketId: socket.id, username, muted });
  });

  socket.on('disconnect', () => {
    console.log(`[-] ${username} ayrıldı`);
    if (socket.voiceChannel) handleLeaveVoice(socket);

    // Presence: bu sokete ait kaydı sil, kullanıcının başka açık sekmesi yoksa çevrimdışı yap
    const sockets = userSockets.get(userId);
    if (sockets) {
      sockets.delete(socket.id);
      if (sockets.size === 0) {
        userSockets.delete(userId);
        onlineUsers.delete(userId);
      }
    }
    broadcastPresence();
  });
});

function handleLeaveVoice(socket) {
  const channelId = socket.voiceChannel;
  if (!channelId || !voiceRooms[channelId]) return;
  delete voiceRooms[channelId][socket.id];
  socket.leave(`voice:${channelId}`);
  socket.voiceChannel = null;
  io.to(`voice:${channelId}`).emit('user-left-voice', { channelId, socketId: socket.id });
  broadcastVoiceUpdate(channelId);
}

function broadcastVoiceUpdate(channelId) {
  const participants = Object.entries(voiceRooms[channelId] || {}).map(([sid, u]) => ({
    socketId: sid, username: u.username, avatar: u.avatar
  }));
  io.emit('voice-room-update', { channelId, participants });
}

server.listen(PORT, () => {
  console.log(`Dodo sunucu çalışıyor: http://localhost:${PORT}`);
});
