'use strict';

// ============ STATE ============
let token = localStorage.getItem('token');
let username = localStorage.getItem('username');
let socket = null;
let webrtc = null;
let channels = [];
let currentChannel = null;
let voiceChannelId = null;      // aktif sesli kanal ID
let voiceChannelName = null;
let voiceParticipants = {};     // socketId -> username
let voiceStates = {};           // channelId -> [usernames]
let mutedUsers = {};            // socketId -> boolean
let sharingUsers = {};          // socketId -> boolean
let currentTab = 'login';
let lastMessageDate = null;

// ============ INIT ============

if (token && username) {
  showApp();
} else {
  showLoginView();
}

// ============ AUTH ============

document.querySelectorAll('.auth-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    currentTab = tab.dataset.tab;
    document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('auth-submit').textContent =
      currentTab === 'login' ? 'Giriş Yap' : 'Kayıt Ol';
    document.getElementById('auth-error').textContent = '';
  });
});

document.getElementById('auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const usernameVal = document.getElementById('auth-username').value.trim();
  const passwordVal = document.getElementById('auth-password').value;
  const errorEl = document.getElementById('auth-error');
  const submitBtn = document.getElementById('auth-submit');

  errorEl.textContent = '';
  submitBtn.disabled = true;
  submitBtn.textContent = '...';

  try {
    const res = await fetch(`/api/${currentTab}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: usernameVal, password: passwordVal })
    });
    const data = await res.json();

    if (!res.ok) {
      errorEl.textContent = data.error || 'Hata oluştu';
      return;
    }

    token = data.token;
    username = data.username;
    localStorage.setItem('token', token);
    localStorage.setItem('username', username);
    showApp();
  } catch {
    errorEl.textContent = 'Sunucuya bağlanılamadı';
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = currentTab === 'login' ? 'Giriş Yap' : 'Kayıt Ol';
  }
});

document.getElementById('logout-btn').addEventListener('click', logout);

function logout() {
  if (webrtc) webrtc.leaveVoice();
  if (socket) socket.disconnect();
  localStorage.removeItem('token');
  localStorage.removeItem('username');
  token = null;
  username = null;
  location.reload();
}

// ============ VIEW HELPERS ============

function showLoginView() {
  document.getElementById('login-view').classList.remove('hidden');
  document.getElementById('app-view').classList.add('hidden');
}

function showApp() {
  document.getElementById('login-view').classList.add('hidden');
  document.getElementById('app-view').classList.remove('hidden');

  const userNameEl = document.getElementById('user-name');
  const userAvatarEl = document.getElementById('user-avatar');
  userNameEl.textContent = username;
  userAvatarEl.textContent = username[0].toUpperCase();
  userAvatarEl.className = `user-avatar avatar-color-${avatarColor(username)}`;

  initApp();
}

function showView(viewId) {
  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
  document.getElementById(viewId).classList.remove('hidden');
}

// ============ APP INIT ============

async function initApp() {
  // Socket.io bağlantısı
  socket = io({ auth: { token } });

  socket.on('connect', () => {
    socket.emit('get-voice-state');
  });

  socket.on('connect_error', (err) => {
    if (err.message.includes('token') || err.message.includes('kimlik')) {
      logout();
    }
  });

  // WebRTC yöneticisi
  webrtc = new WebRTCManager(socket);
  webrtc.onParticipantJoined = (socketId, uname) => {
    voiceParticipants[socketId] = uname;
    renderVoiceParticipants();
  };
  webrtc.onParticipantLeft = (socketId) => {
    delete voiceParticipants[socketId];
    delete mutedUsers[socketId];
    delete sharingUsers[socketId];
    renderVoiceParticipants();
  };
  webrtc.onScreenShareStart = (socketId, stream, uname) => {
    showScreenShare(socketId, stream, uname || voiceParticipants[socketId]);
  };
  webrtc.onScreenShareStop = (socketId) => {
    hideScreenShare(socketId);
  };

  // Socket olayları
  socket.on('voice-state', (state) => {
    voiceStates = state;
    renderChannels();
  });

  socket.on('voice-room-update', ({ channelId, participants }) => {
    voiceStates[channelId] = participants;
    renderChannels();
    if (currentChannel?.id == channelId && currentChannel?.type === 'voice') {
      // Eğer bu kanaldaysak ve katılmadıysak, sadece katılımcı listesini güncelle
      if (!voiceChannelId) renderVoiceParticipantsFromState(channelId);
    }
  });

  socket.on('new-message', (msg) => {
    if (currentChannel?.id == msg.channel_id || currentChannel?.id === msg.channel_id) {
      appendMessage(msg);
    }
  });

  socket.on('user-mute-update', ({ socketId, muted }) => {
    mutedUsers[socketId] = muted;
    renderVoiceParticipants();
  });

  // Kanalları yükle
  await loadChannels();
}

// ============ CHANNELS ============

async function loadChannels() {
  try {
    const res = await fetch('/api/channels', {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) { logout(); return; }
    channels = await res.json();
    renderChannels();
  } catch {
    console.error('Kanallar yüklenemedi');
  }
}

function renderChannels() {
  const textContainer = document.getElementById('text-channels');
  const voiceContainer = document.getElementById('voice-channels');
  textContainer.innerHTML = '';
  voiceContainer.innerHTML = '';

  channels.forEach(ch => {
    const el = createChannelElement(ch);
    if (ch.type === 'text') textContainer.appendChild(el);
    else voiceContainer.appendChild(el);
  });
}

function createChannelElement(ch) {
  const item = document.createElement('div');
  item.className = 'channel-item';
  item.dataset.channelId = ch.id;
  if (currentChannel?.id === ch.id) item.classList.add('active');

  const row = document.createElement('div');
  row.className = 'channel-item-row';

  const prefix = document.createElement('span');
  prefix.className = 'channel-prefix';
  prefix.textContent = ch.type === 'text' ? '#' : '🔊';

  const name = document.createElement('span');
  name.className = 'channel-name';
  name.textContent = ch.name;

  row.appendChild(prefix);
  row.appendChild(name);
  item.appendChild(row);

  // Sesli kanal için katılımcı listesi
  if (ch.type === 'voice') {
    const members = voiceStates[ch.id] || [];
    if (members.length > 0) {
      const memberList = document.createElement('div');
      memberList.className = 'voice-member-list';
      members.forEach(uname => {
        const mi = document.createElement('div');
        mi.className = 'voice-member-item';
        const av = document.createElement('div');
        av.className = `voice-member-avatar avatar-color-${avatarColor(uname)}`;
        av.textContent = uname[0].toUpperCase();
        const mn = document.createElement('span');
        mn.className = 'voice-member-name';
        mn.textContent = uname;
        mi.appendChild(av);
        mi.appendChild(mn);
        memberList.appendChild(mi);
      });
      item.appendChild(memberList);
    }
  }

  item.addEventListener('click', () => selectChannel(ch));
  return item;
}

async function selectChannel(ch) {
  currentChannel = ch;
  renderChannels();

  if (ch.type === 'text') {
    showView('text-view');
    document.getElementById('text-channel-name').textContent = ch.name;
    socket.emit('join-channel', ch.id);
    await loadMessages(ch.id);
  } else {
    showView('voice-view');
    document.getElementById('voice-channel-name').textContent = ch.name;
    renderVoiceParticipantsFromState(ch.id);
    updateVoiceUI();
  }
}

// ============ MESSAGES ============

async function loadMessages(channelId) {
  const messagesEl = document.getElementById('messages');
  messagesEl.innerHTML = '';
  lastMessageDate = null;

  try {
    const res = await fetch(`/api/messages/${channelId}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const msgs = await res.json();
    msgs.forEach(msg => appendMessage(msg, false));
    scrollMessages();
  } catch {
    console.error('Mesajlar yüklenemedi');
  }
}

function appendMessage(msg, scroll = true) {
  if (currentChannel?.type !== 'text') return;

  const messagesEl = document.getElementById('messages');
  const msgDate = new Date(msg.created_at).toLocaleDateString('tr-TR');

  // Tarih ayracı
  if (msgDate !== lastMessageDate) {
    const divider = document.createElement('div');
    divider.className = 'msg-date-divider';
    divider.textContent = msgDate;
    messagesEl.appendChild(divider);
    lastMessageDate = msgDate;
  }

  const group = document.createElement('div');
  group.className = 'msg-group';

  const avatar = document.createElement('div');
  avatar.className = `msg-avatar avatar-color-${avatarColor(msg.username)}`;
  avatar.textContent = msg.username[0].toUpperCase();

  const body = document.createElement('div');
  body.className = 'msg-body';

  const meta = document.createElement('div');
  meta.className = 'msg-meta';

  const uname = document.createElement('span');
  uname.className = 'msg-username';
  uname.textContent = msg.username;

  const time = document.createElement('span');
  time.className = 'msg-time';
  time.textContent = formatTime(msg.created_at);

  meta.appendChild(uname);
  meta.appendChild(time);

  const content = document.createElement('div');
  content.className = 'msg-content';
  content.textContent = msg.content;

  body.appendChild(meta);
  body.appendChild(content);
  group.appendChild(avatar);
  group.appendChild(body);
  messagesEl.appendChild(group);

  if (scroll) scrollMessages();
}

function scrollMessages() {
  const el = document.getElementById('messages');
  el.scrollTop = el.scrollHeight;
}

// Mesaj gönder
document.getElementById('message-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

document.getElementById('send-btn').addEventListener('click', sendMessage);

function sendMessage() {
  const input = document.getElementById('message-input');
  const content = input.value.trim();
  if (!content || !currentChannel) return;
  socket.emit('send-message', { channelId: currentChannel.id, content });
  input.value = '';
}

// ============ VOICE CHANNEL ============

function renderVoiceParticipantsFromState(channelId) {
  // Sesli odayı göster ama katılımcıları state'ten al (socket bilmediğimiz ID'ler)
  const container = document.getElementById('voice-participants');
  container.innerHTML = '';
  const members = voiceStates[channelId] || [];
  members.forEach(uname => {
    const el = createParticipantEl(`state-${uname}`, uname, false, false);
    container.appendChild(el);
  });
}

function renderVoiceParticipants() {
  const container = document.getElementById('voice-participants');
  container.innerHTML = '';

  // Kendimizi ekle
  const myEl = createParticipantEl('me', username, webrtc?.isMuted, webrtc?.isSharing);
  container.appendChild(myEl);

  // Diğerlerini ekle
  Object.entries(voiceParticipants).forEach(([socketId, uname]) => {
    const el = createParticipantEl(socketId, uname, mutedUsers[socketId], sharingUsers[socketId]);
    container.appendChild(el);
  });
}

function createParticipantEl(socketId, uname, muted, sharing) {
  const el = document.createElement('div');
  el.className = 'voice-participant';
  el.id = `vp-${socketId}`;

  const avatar = document.createElement('div');
  avatar.className = `vp-avatar avatar-color-${avatarColor(uname)}`;
  if (muted) avatar.classList.add('muted');
  if (sharing) avatar.classList.add('vp-sharing');
  avatar.textContent = uname[0].toUpperCase();

  const name = document.createElement('div');
  name.className = 'vp-name';
  name.textContent = uname === username ? `${uname} (sen)` : uname;

  el.appendChild(avatar);
  el.appendChild(name);
  return el;
}

function updateVoiceUI() {
  const isInThisVoice = voiceChannelId && voiceChannelId == currentChannel?.id;
  document.getElementById('join-voice-area').classList.toggle('hidden', isInThisVoice);
  document.getElementById('voice-controls').classList.toggle('hidden', !isInThisVoice);

  if (isInThisVoice) renderVoiceParticipants();
}

// Sesli kanala katıl butonu
document.getElementById('join-voice-btn').addEventListener('click', async () => {
  if (!currentChannel || currentChannel.type !== 'voice') return;
  const btn = document.getElementById('join-voice-btn');
  btn.disabled = true;
  btn.textContent = 'Bağlanıyor...';

  try {
    await webrtc.joinVoice(currentChannel.id);
    voiceChannelId = currentChannel.id;
    voiceChannelName = currentChannel.name;
    voiceParticipants = {};
    mutedUsers = {};
    sharingUsers = {};

    updateVoiceUI();
    showVoiceBar(currentChannel.name);
  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '🎤 Sese Katıl';
  }
});

// Sessize al
document.getElementById('mute-btn').addEventListener('click', toggleMute);
document.getElementById('vbar-mute').addEventListener('click', toggleMute);

function toggleMute() {
  if (!webrtc) return;
  const isMuted = webrtc.toggleMute();
  const muteBtn = document.getElementById('mute-btn');
  const vbarMute = document.getElementById('vbar-mute');

  if (isMuted) {
    muteBtn.classList.add('muted');
    muteBtn.querySelector('.btn-label').textContent = 'Sesi Aç';
    vbarMute.classList.add('muted');
    vbarMute.textContent = '🔇';
  } else {
    muteBtn.classList.remove('muted');
    muteBtn.querySelector('.btn-label').textContent = 'Sessize Al';
    vbarMute.classList.remove('muted');
    vbarMute.textContent = '🎤';
  }
  renderVoiceParticipants();
}

// Ekran paylaş
document.getElementById('screen-btn').addEventListener('click', toggleScreenShare);
document.getElementById('vbar-screen').addEventListener('click', toggleScreenShare);

async function toggleScreenShare() {
  if (!webrtc) return;
  try {
    if (webrtc.isSharing) {
      webrtc.stopScreenShare();
      updateScreenBtn(false);
    } else {
      await webrtc.startScreenShare();
      updateScreenBtn(true);
    }
  } catch (err) {
    if (!err.message.includes('iptal')) alert(err.message);
    updateScreenBtn(false);
  }
}

function updateScreenBtn(sharing) {
  const btn = document.getElementById('screen-btn');
  if (sharing) {
    btn.classList.add('sharing');
    btn.querySelector('.btn-label').textContent = 'Paylaşımı Durdur';
  } else {
    btn.classList.remove('sharing');
    btn.querySelector('.btn-label').textContent = 'Ekran Paylaş';
  }
}

// Kanaldan ayrıl
document.getElementById('leave-btn').addEventListener('click', leaveVoice);
document.getElementById('vbar-leave').addEventListener('click', leaveVoice);

function leaveVoice() {
  if (!webrtc) return;
  webrtc.leaveVoice();
  voiceChannelId = null;
  voiceChannelName = null;
  voiceParticipants = {};
  mutedUsers = {};
  sharingUsers = {};

  // Ekran paylaşımlarını temizle
  document.getElementById('screen-shares').innerHTML = '';
  document.getElementById('screen-shares').classList.add('hidden');

  // Butonları sıfırla
  updateScreenBtn(false);
  document.getElementById('mute-btn').classList.remove('muted');
  document.getElementById('mute-btn').querySelector('.btn-label').textContent = 'Sessize Al';
  document.getElementById('vbar-mute').classList.remove('muted');
  document.getElementById('vbar-mute').textContent = '🎤';

  hideVoiceBar();
  updateVoiceUI();
}

// ============ VOICE BAR ============

function showVoiceBar(chName) {
  const bar = document.getElementById('voice-bar');
  document.getElementById('voice-bar-channel').textContent = chName;
  bar.classList.remove('hidden');
}

function hideVoiceBar() {
  document.getElementById('voice-bar').classList.add('hidden');
}

// ============ SCREEN SHARING ============

function showScreenShare(socketId, stream, uname) {
  const container = document.getElementById('screen-shares');
  container.classList.remove('hidden');

  let item = document.getElementById(`ss-${socketId}`);
  if (!item) {
    item = document.createElement('div');
    item.className = 'screen-share-item';
    item.id = `ss-${socketId}`;

    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.muted = (socketId === 'me');

    const label = document.createElement('div');
    label.className = 'screen-share-label';
    label.textContent = `🖥️ ${uname || username}`;

    item.appendChild(video);
    item.appendChild(label);
    container.appendChild(item);
  }

  if (stream) {
    const video = item.querySelector('video');
    video.srcObject = stream;
  }

  sharingUsers[socketId] = true;
  renderVoiceParticipants();
}

function hideScreenShare(socketId) {
  const item = document.getElementById(`ss-${socketId}`);
  if (item) item.remove();

  const container = document.getElementById('screen-shares');
  if (!container.children.length) container.classList.add('hidden');

  delete sharingUsers[socketId];
  renderVoiceParticipants();
  updateScreenBtn(false);
}

// ============ UTILITIES ============

function avatarColor(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + hash * 31;
  return Math.abs(hash) % 8;
}

function formatTime(isoString) {
  const d = new Date(isoString);
  return d.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
}
