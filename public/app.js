'use strict';

let token = localStorage.getItem('token');
let username = localStorage.getItem('username');
let isAdmin = false;
let myAvatar = null;
let socket = null;
let webrtc = null;
let channels = [];
let currentChannel = null;
let voiceChannelId = null;
let voiceChannelName = null;
let voiceParticipants = {};     // socketId -> {username, avatar}
let voiceStates = {};           // channelId -> [{socketId, username, avatar}]
let mutedUsers = {};
let sharingUsers = {};
let activeShares = {};          // socketId -> { uname, stream }
let watchingShareId = null;     // şu an oynatıcıda izlenen paylaşımın socketId'si
let currentTab = 'login';
let lastMessageDate = null;
let replyToId = null;
let replyToPreview = null;
let pendingMoveSocketId = null;
let pendingAvatarDataUrl = undefined;
let searchActive = false;
let allMessages = [];           // for search
let audioSettings = loadAudioSettings();
let volumePopoverTarget = null; // { type: 'self'|'user', socketId, uname }

function loadAudioSettings() {
  try {
    const raw = localStorage.getItem('audioSettings');
    const parsed = raw ? JSON.parse(raw) : {};
    return { mic: parsed.mic ?? 100, master: parsed.master ?? 100, perUser: parsed.perUser || {} };
  } catch (e) {
    return { mic: 100, master: 100, perUser: {} };
  }
}

function saveAudioSettings() {
  localStorage.setItem('audioSettings', JSON.stringify(audioSettings));
}

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
    document.getElementById('auth-submit').textContent = currentTab === 'login' ? 'Giriş Yap' : 'Kayıt Ol';
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
    if (!res.ok) { errorEl.textContent = data.error || 'Hata oluştu'; return; }
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

document.getElementById('logout-btn').addEventListener('click', (e) => { e.stopPropagation(); logout(); });

function logout() {
  if (webrtc) webrtc.leaveVoice();
  if (socket) socket.disconnect();
  localStorage.removeItem('token');
  localStorage.removeItem('username');
  location.reload();
}

// ============ VIEW ============

function showLoginView() {
  document.getElementById('login-view').classList.remove('hidden');
  document.getElementById('app-view').classList.add('hidden');
}

function showApp() {
  document.getElementById('login-view').classList.add('hidden');
  document.getElementById('app-view').classList.remove('hidden');
  initApp();
}

function showView(viewId) {
  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
  document.getElementById(viewId).classList.remove('hidden');
}

// ============ INIT ============

async function initApp() {
  await loadMe();

  socket = io({ auth: { token } });

  socket.on('connect', () => socket.emit('get-voice-state'));
  socket.on('connect_error', (err) => { if (err.message.includes('token') || err.message.includes('kimlik')) logout(); });

  webrtc = new WebRTCManager(socket);
  webrtc.onParticipantJoined = (socketId, uname, avatar) => {
    voiceParticipants[socketId] = { username: uname, avatar: avatar || null };
    const savedVol = audioSettings.perUser[uname];
    if (savedVol !== undefined) webrtc.setPeerVolume(socketId, savedVol);
    renderVoiceParticipants();
  };
  webrtc.onParticipantLeft = (socketId) => {
    delete voiceParticipants[socketId];
    delete mutedUsers[socketId];
    delete sharingUsers[socketId];
    renderVoiceParticipants();
  };
  webrtc.onScreenShareStart = (socketId, stream, uname) => {
    const uData = voiceParticipants[socketId];
    showScreenShare(socketId, stream, uname || uData?.username);
  };
  webrtc.onScreenShareStop = (socketId) => hideScreenShare(socketId);
  webrtc.onLocalScreenShareStop = () => hideScreenShare('me');

  socket.on('voice-state', (state) => { voiceStates = state; renderChannels(); });
  socket.on('voice-room-update', ({ channelId, participants }) => {
    voiceStates[channelId] = participants;
    renderChannels();
    if (currentChannel?.id == channelId && currentChannel?.type === 'voice' && !voiceChannelId) {
      renderVoiceParticipantsFromState(channelId);
    }
  });
  socket.on('new-message', (msg) => { if (currentChannel?.id == msg.channel_id) appendMessage(msg); });
  socket.on('message-deleted', ({ messageId }) => removeMessageEl(messageId));
  socket.on('channel-cleared', () => {
    document.getElementById('messages').innerHTML = '';
    allMessages = [];
    lastMessageDate = null;
  });
  socket.on('user-mute-update', ({ socketId, muted }) => { mutedUsers[socketId] = muted; renderVoiceParticipants(); });
  socket.on('force-leave-voice', () => { leaveVoice(); showToast('Ses kanalından çıkarıldınız.'); });
  socket.on('force-join-voice', async ({ channelId }) => {
    const ch = channels.find(c => c.id == channelId);
    if (!ch) return;
    showToast(`"${ch.name}" kanalına taşındınız.`);
    await selectChannel(ch);
  });

  await loadChannels();
}

async function loadMe() {
  try {
    const res = await fetch('/api/me', { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return;
    const user = await res.json();
    isAdmin = !!user.is_admin;
    myAvatar = user.avatar || null;
    username = user.username;
    localStorage.setItem('username', username);
    renderUserBar();
    // Admin menü öğelerini göster
    document.querySelectorAll('.admin-only').forEach(el => {
      if (isAdmin) el.classList.remove('hidden');
    });
  } catch {}
}

function renderUserBar() {
  const nameEl = document.getElementById('user-name');
  const avatarEl = document.getElementById('user-avatar');
  nameEl.textContent = username + (isAdmin ? ' 👑' : '');
  setAvatarEl(avatarEl, username, myAvatar, 'user-avatar');
}

function setAvatarEl(el, uname, avatar, baseClass) {
  if (avatar) {
    el.innerHTML = `<img src="${avatar}" alt="${uname}" />`;
    el.className = baseClass + ' has-img';
  } else {
    el.textContent = uname[0].toUpperCase();
    el.className = `${baseClass} avatar-color-${avatarColor(uname)}`;
  }
}

// ============ CHANNELS ============

async function loadChannels() {
  try {
    const res = await fetch('/api/channels', { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) { logout(); return; }
    channels = await res.json();
    renderChannels();
  } catch {}
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
  item.className = 'channel-item' + (currentChannel?.id === ch.id ? ' active' : '');
  item.dataset.channelId = ch.id;

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

  if (ch.type === 'voice') {
    const members = voiceStates[ch.id] || [];
    if (members.length > 0) {
      const memberList = document.createElement('div');
      memberList.className = 'voice-member-list';
      members.forEach(m => {
        const uname = typeof m === 'string' ? m : m.username;
        const avatar = typeof m === 'object' ? m.avatar : null;
        const mi = document.createElement('div');
        mi.className = 'voice-member-item';
        const av = document.createElement('div');
        if (avatar) {
          av.innerHTML = `<img src="${avatar}" alt="${uname}" />`;
          av.className = 'voice-member-avatar has-img';
        } else {
          av.className = `voice-member-avatar avatar-color-${avatarColor(uname)}`;
          av.textContent = uname[0].toUpperCase();
        }
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
    closeSearch();
    clearReply();
    socket.emit('join-channel', ch.id);
    await loadMessages(ch.id);
  } else {
    showView('voice-view');
    document.getElementById('voice-channel-name').textContent = ch.name;

    if (voiceChannelId == ch.id) { updateVoiceUI(); return; }
    if (voiceChannelId) leaveVoice();

    try {
      await webrtc.joinVoice(ch.id);
      voiceChannelId = ch.id;
      voiceChannelName = ch.name;
      voiceParticipants = {};
      mutedUsers = {};
      sharingUsers = {};
      updateVoiceUI();
      showVoiceBar(ch.name);
    } catch {
      renderVoiceParticipantsFromState(ch.id);
      document.getElementById('join-voice-area').classList.remove('hidden');
      document.getElementById('voice-controls').classList.add('hidden');
    }
  }
}

// ============ MESSAGES ============

async function loadMessages(channelId) {
  const messagesEl = document.getElementById('messages');
  messagesEl.innerHTML = '';
  allMessages = [];
  lastMessageDate = null;
  try {
    const res = await fetch(`/api/messages/${channelId}`, { headers: { Authorization: `Bearer ${token}` } });
    const msgs = await res.json();
    msgs.forEach(msg => appendMessage(msg, false));
    scrollMessages();
  } catch {}
}

function appendMessage(msg, scroll = true) {
  if (currentChannel?.type !== 'text') return;
  if (searchActive) return;

  allMessages.push(msg);

  const messagesEl = document.getElementById('messages');
  const msgDate = new Date(msg.created_at).toLocaleDateString('tr-TR');

  if (msgDate !== lastMessageDate) {
    const divider = document.createElement('div');
    divider.className = 'msg-date-divider';
    divider.textContent = msgDate;
    messagesEl.appendChild(divider);
    lastMessageDate = msgDate;
  }

  const group = createMessageEl(msg);
  messagesEl.appendChild(group);
  if (scroll) scrollMessages();
}

function createMessageEl(msg) {
  const canDelete = isAdmin || msg.user_id === getCurrentUserId();

  const group = document.createElement('div');
  group.className = 'msg-group';
  group.dataset.msgId = msg.id;

  // Yanıt önizleme
  if (msg.reply_to_id && msg.reply_username) {
    const replyPreview = document.createElement('div');
    replyPreview.className = 'msg-reply-preview';
    replyPreview.innerHTML = `<span class="reply-user">↩ ${msg.reply_username}</span><span class="reply-text">${escapeHtml(msg.reply_content || '')}</span>`;
    group.appendChild(replyPreview);
  }

  const inner = document.createElement('div');
  inner.className = 'msg-inner';

  const avatar = document.createElement('div');
  setAvatarEl(avatar, msg.username, msg.avatar || null, 'msg-avatar');

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
  inner.appendChild(avatar);
  inner.appendChild(body);

  // Aksiyon butonları (hover'da görünür)
  const actions = document.createElement('div');
  actions.className = 'msg-actions';

  const replyBtn = document.createElement('button');
  replyBtn.className = 'msg-action-btn';
  replyBtn.title = 'Yanıtla';
  replyBtn.textContent = '↩';
  replyBtn.addEventListener('click', () => setReply(msg));
  actions.appendChild(replyBtn);

  if (canDelete) {
    const delBtn = document.createElement('button');
    delBtn.className = 'msg-action-btn danger';
    delBtn.title = 'Sil';
    delBtn.textContent = '🗑';
    delBtn.addEventListener('click', () => confirmDeleteMessage(msg.id));
    actions.appendChild(delBtn);
  }

  inner.appendChild(actions);
  group.appendChild(inner);
  return group;
}

function removeMessageEl(messageId) {
  const el = document.querySelector(`[data-msg-id="${messageId}"]`);
  if (el) el.remove();
  allMessages = allMessages.filter(m => m.id !== messageId);
}

function getCurrentUserId() {
  try { return JSON.parse(atob(token.split('.')[1])).id; } catch { return null; }
}

function scrollMessages() {
  const el = document.getElementById('messages');
  el.scrollTop = el.scrollHeight;
}

document.getElementById('message-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});
document.getElementById('send-btn').addEventListener('click', sendMessage);

function sendMessage() {
  const input = document.getElementById('message-input');
  const content = input.value.trim();
  if (!content || !currentChannel) return;
  socket.emit('send-message', { channelId: currentChannel.id, content, replyToId });
  input.value = '';
  clearReply();
}

// ============ REPLY ============

function setReply(msg) {
  replyToId = msg.id;
  replyToPreview = msg;
  const bar = document.getElementById('reply-bar');
  const preview = document.getElementById('reply-bar-preview');
  preview.textContent = `@${msg.username}: ${msg.content.slice(0, 60)}${msg.content.length > 60 ? '…' : ''}`;
  bar.classList.remove('hidden');
  document.getElementById('message-input').focus();
}

function clearReply() {
  replyToId = null;
  replyToPreview = null;
  document.getElementById('reply-bar').classList.add('hidden');
  document.getElementById('reply-bar-preview').textContent = '';
}

document.getElementById('reply-bar-close').addEventListener('click', clearReply);

// ============ DELETE MESSAGE ============

function confirmDeleteMessage(msgId) {
  showConfirm('Mesajı Sil', 'Bu mesaj kalıcı olarak silinecek.', async () => {
    try {
      await fetch(`/api/messages/${msgId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });
    } catch {}
  });
}

// ============ SEARCH ============

document.getElementById('search-toggle-btn').addEventListener('click', () => {
  searchActive = !searchActive;
  document.getElementById('search-bar').classList.toggle('hidden', !searchActive);
  if (searchActive) {
    document.getElementById('search-input').focus();
  } else {
    closeSearch();
    reloadCurrentMessages();
  }
});

document.getElementById('search-close-btn').addEventListener('click', () => {
  closeSearch();
  reloadCurrentMessages();
});

document.getElementById('search-input').addEventListener('input', (e) => {
  const q = e.target.value.trim().toLowerCase();
  renderSearchResults(q);
});

function closeSearch() {
  searchActive = false;
  document.getElementById('search-bar').classList.add('hidden');
  document.getElementById('search-input').value = '';
}

function renderSearchResults(q) {
  const messagesEl = document.getElementById('messages');
  messagesEl.innerHTML = '';
  if (!q) { reloadCurrentMessages(); return; }
  const filtered = allMessages.filter(m =>
    m.content.toLowerCase().includes(q) || m.username.toLowerCase().includes(q)
  );
  if (!filtered.length) {
    messagesEl.innerHTML = '<div class="search-empty">Sonuç bulunamadı</div>';
    return;
  }
  const prevSearchActive = searchActive;
  searchActive = false;
  lastMessageDate = null;
  filtered.forEach(msg => appendMessage(msg, false));
  searchActive = prevSearchActive;
}

async function reloadCurrentMessages() {
  if (currentChannel?.type === 'text') await loadMessages(currentChannel.id);
}

// ============ CHANNEL MENU (3 NOKTA) ============

document.getElementById('channel-menu-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  const dd = document.getElementById('channel-dropdown');
  dd.classList.toggle('hidden');
});

document.addEventListener('click', () => {
  document.getElementById('channel-dropdown')?.classList.add('hidden');
});

document.getElementById('menu-info').addEventListener('click', async () => {
  if (!currentChannel) return;
  try {
    const res = await fetch(`/api/channels/${currentChannel.id}/info`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await res.json();
    const body = document.getElementById('info-modal-body');
    document.getElementById('info-modal-title').textContent = `# ${currentChannel.name}`;
    body.innerHTML = `
      <div class="info-row"><span>📝 Toplam Mesaj</span><strong>${data.message_count}</strong></div>
      <div class="info-row"><span>👥 Farklı Kullanıcı</span><strong>${data.user_count}</strong></div>
    `;
    document.getElementById('info-modal-overlay').classList.remove('hidden');
  } catch {}
});

document.getElementById('menu-clear').addEventListener('click', () => {
  if (!currentChannel || !isAdmin) return;
  showConfirm('Sohbeti Temizle', `"${currentChannel.name}" kanalındaki tüm mesajlar silinecek. Bu işlem geri alınamaz.`, async () => {
    try {
      await fetch(`/api/channels/${currentChannel.id}/messages`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });
    } catch {}
  });
});

document.getElementById('info-modal-close').addEventListener('click', () => document.getElementById('info-modal-overlay').classList.add('hidden'));
document.getElementById('info-modal-ok').addEventListener('click', () => document.getElementById('info-modal-overlay').classList.add('hidden'));

// ============ CONFIRM MODAL ============

let confirmCallback = null;

function showConfirm(title, text, onConfirm) {
  document.getElementById('confirm-modal-title').textContent = title;
  document.getElementById('confirm-modal-text').textContent = text;
  confirmCallback = onConfirm;
  document.getElementById('confirm-modal-overlay').classList.remove('hidden');
}

document.getElementById('confirm-cancel-btn').addEventListener('click', () => {
  document.getElementById('confirm-modal-overlay').classList.add('hidden');
  confirmCallback = null;
});

document.getElementById('confirm-ok-btn').addEventListener('click', async () => {
  document.getElementById('confirm-modal-overlay').classList.add('hidden');
  if (confirmCallback) { await confirmCallback(); confirmCallback = null; }
});

// ============ VOICE ============

function renderVoiceParticipantsFromState(channelId) {
  const container = document.getElementById('voice-participants');
  container.innerHTML = '';
  const members = voiceStates[channelId] || [];
  members.forEach(m => {
    const sid = typeof m === 'string' ? `state-${m}` : m.socketId;
    const uname = typeof m === 'string' ? m : m.username;
    const avatar = typeof m === 'object' ? m.avatar : null;
    container.appendChild(createParticipantEl(sid, uname, avatar, false, false, false));
  });
}

function renderVoiceParticipants() {
  const container = document.getElementById('voice-participants');
  container.innerHTML = '';
  container.appendChild(createParticipantEl('me', username, myAvatar, webrtc?.isMuted, webrtc?.isSharing, true));
  Object.entries(voiceParticipants).forEach(([socketId, data]) => {
    const uname = typeof data === 'string' ? data : data.username;
    const avatar = typeof data === 'object' ? data.avatar : null;
    container.appendChild(createParticipantEl(socketId, uname, avatar, mutedUsers[socketId], sharingUsers[socketId], true));
  });
}

function createParticipantEl(socketId, uname, avatar, muted, sharing, interactive) {
  const el = document.createElement('div');
  el.className = 'voice-participant';
  el.id = `vp-${socketId}`;

  const av = document.createElement('div');
  av.className = `vp-avatar${muted ? ' muted' : ''}${sharing ? ' vp-sharing' : ''}`;
  if (avatar) {
    av.innerHTML = `<img src="${avatar}" alt="${uname}" />`;
    av.classList.add('has-img');
  } else {
    av.classList.add(`avatar-color-${avatarColor(uname)}`);
    av.textContent = uname[0].toUpperCase();
  }

  const name = document.createElement('div');
  name.className = 'vp-name';
  name.textContent = uname === username ? `${uname} (sen)` : uname;

  el.appendChild(av);
  el.appendChild(name);

  if (interactive) {
    if (socketId === 'me') {
      el.classList.add('vp-clickable');
      el.title = 'Ses ayarların için tıkla';
      el.addEventListener('click', () => openVolumePopover(el, 'self', 'me', uname, avatar));
    } else {
      el.classList.add('vp-clickable');
      el.title = 'Bu kullanıcının sesini ayarlamak için sağ tıkla';
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        openVolumePopover(el, 'user', socketId, uname, avatar);
      });
    }
  }

  if (isAdmin && socketId !== 'me' && !socketId.startsWith('state-') && uname !== username) {
    const adminBtns = document.createElement('div');
    adminBtns.className = 'vp-admin-btns';

    const kickBtn = document.createElement('button');
    kickBtn.className = 'vp-admin-btn kick';
    kickBtn.title = 'Kanaldan at';
    kickBtn.textContent = '✕';
    kickBtn.addEventListener('click', (e) => { e.stopPropagation(); socket.emit('admin-kick-voice', { targetSocketId: socketId }); });

    const moveBtn = document.createElement('button');
    moveBtn.className = 'vp-admin-btn move';
    moveBtn.title = 'Başka kanala taşı';
    moveBtn.textContent = '↗';
    moveBtn.addEventListener('click', (e) => { e.stopPropagation(); showMoveModal(socketId, uname); });

    adminBtns.appendChild(kickBtn);
    adminBtns.appendChild(moveBtn);
    el.appendChild(adminBtns);
  }

  return el;
}

function updateVoiceUI() {
  const isIn = voiceChannelId && voiceChannelId == currentChannel?.id;
  document.getElementById('join-voice-area').classList.add('hidden');
  document.getElementById('voice-controls').classList.toggle('hidden', !isIn);
  if (isIn) renderVoiceParticipants();
}

document.getElementById('join-voice-btn').addEventListener('click', async () => {
  if (!currentChannel || currentChannel.type !== 'voice') return;
  const btn = document.getElementById('join-voice-btn');
  btn.disabled = true;
  btn.textContent = 'Bağlanıyor...';
  try {
    if (voiceChannelId && voiceChannelId !== currentChannel.id) leaveVoice();
    await webrtc.joinVoice(currentChannel.id);
    webrtc.setMicVolume(audioSettings.mic);
    webrtc.setMasterVolume(audioSettings.master);
    voiceChannelId = currentChannel.id;
    voiceChannelName = currentChannel.name;
    voiceParticipants = {};
    mutedUsers = {};
    sharingUsers = {};
    updateVoiceUI();
    showVoiceBar(currentChannel.name);
  } catch (err) { alert(err.message); }
  finally { btn.disabled = false; btn.textContent = '🎤 Sese Katıl'; }
});

document.getElementById('mute-btn').addEventListener('click', toggleMute);
document.getElementById('vbar-mute').addEventListener('click', toggleMute);

function toggleMute() {
  if (!webrtc) return;
  const isMuted = webrtc.toggleMute();
  document.getElementById('mute-btn').classList.toggle('muted', isMuted);
  document.getElementById('mute-btn').querySelector('.btn-label').textContent = isMuted ? 'Sesi Aç' : 'Sessize Al';
  document.getElementById('vbar-mute').classList.toggle('muted', isMuted);
  document.getElementById('vbar-mute').textContent = isMuted ? '🔇' : '🎤';
  renderVoiceParticipants();
}

document.getElementById('screen-btn').addEventListener('click', toggleScreenShare);
document.getElementById('vbar-screen').addEventListener('click', toggleScreenShare);

async function toggleScreenShare() {
  if (!webrtc) return;
  try {
    if (webrtc.isSharing) {
      webrtc.stopScreenShare();
    } else {
      await webrtc.startScreenShare();
      showScreenShare('me', webrtc.screenStream, username);
      updateScreenBtn(true);
    }
  } catch (err) { if (!err.message.includes('iptal')) alert(err.message); updateScreenBtn(false); }
}

function updateScreenBtn(sharing) {
  document.getElementById('screen-btn').classList.toggle('sharing', sharing);
  document.getElementById('screen-btn').querySelector('.btn-label').textContent = sharing ? 'Paylaşımı Durdur' : 'Ekran Paylaş';
}

document.getElementById('leave-btn').addEventListener('click', leaveVoice);
document.getElementById('vbar-leave').addEventListener('click', leaveVoice);

function leaveVoice() {
  if (!webrtc) return;
  webrtc.leaveVoice();
  closeVolumePopover();
  voiceChannelId = null;
  voiceChannelName = null;
  voiceParticipants = {};
  mutedUsers = {};
  sharingUsers = {};
  activeShares = {};
  watchingShareId = null;
  document.getElementById('screen-shares').innerHTML = '';
  document.getElementById('screen-shares').classList.add('hidden');
  updateScreenBtn(false);
  document.getElementById('mute-btn').classList.remove('muted');
  document.getElementById('mute-btn').querySelector('.btn-label').textContent = 'Sessize Al';
  document.getElementById('vbar-mute').classList.remove('muted');
  document.getElementById('vbar-mute').textContent = '🎤';
  hideVoiceBar();
  updateVoiceUI();
  if (currentChannel?.type === 'voice') renderVoiceParticipantsFromState(currentChannel.id);
}

// ============ SES AYARLARI POPOVER ============

function openVolumePopover(anchorEl, type, socketId, uname, avatar) {
  const pop = document.getElementById('volume-popover');
  volumePopoverTarget = { type, socketId, uname };

  document.getElementById('vpop-name').textContent = type === 'self' ? `${uname} (Sen)` : uname;
  setAvatarEl(document.getElementById('vpop-avatar'), uname, avatar, 'vpop-avatar');

  document.getElementById('vpop-mic-row').classList.toggle('hidden', type !== 'self');
  document.getElementById('vpop-master-row').classList.toggle('hidden', type !== 'self');
  document.getElementById('vpop-user-row').classList.toggle('hidden', type !== 'user');

  if (type === 'self') {
    document.getElementById('vpop-mic-slider').value = audioSettings.mic;
    document.getElementById('vpop-mic-value').textContent = `${audioSettings.mic}%`;
    document.getElementById('vpop-master-slider').value = audioSettings.master;
    document.getElementById('vpop-master-value').textContent = `${audioSettings.master}%`;
  } else {
    const val = audioSettings.perUser[uname] ?? 100;
    document.getElementById('vpop-user-label').textContent = `${uname} Sesi`;
    document.getElementById('vpop-user-slider').value = val;
    document.getElementById('vpop-user-value').textContent = `${val}%`;
  }

  pop.classList.remove('hidden');
  positionVolumePopover(pop, anchorEl);
}

function positionVolumePopover(pop, anchorEl) {
  const rect = anchorEl.getBoundingClientRect();
  const popRect = pop.getBoundingClientRect();
  let left = rect.left + rect.width / 2 - popRect.width / 2;
  let top = rect.bottom + 8;
  left = Math.max(8, Math.min(left, window.innerWidth - popRect.width - 8));
  if (top + popRect.height > window.innerHeight - 8) top = rect.top - popRect.height - 8;
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
}

function closeVolumePopover() {
  document.getElementById('volume-popover').classList.add('hidden');
  volumePopoverTarget = null;
}

document.getElementById('vpop-mic-slider').addEventListener('input', (e) => {
  const val = parseInt(e.target.value, 10);
  document.getElementById('vpop-mic-value').textContent = `${val}%`;
  audioSettings.mic = val;
  webrtc?.setMicVolume(val);
  saveAudioSettings();
});

document.getElementById('vpop-master-slider').addEventListener('input', (e) => {
  const val = parseInt(e.target.value, 10);
  document.getElementById('vpop-master-value').textContent = `${val}%`;
  audioSettings.master = val;
  webrtc?.setMasterVolume(val);
  saveAudioSettings();
});

document.getElementById('vpop-user-slider').addEventListener('input', (e) => {
  const val = parseInt(e.target.value, 10);
  document.getElementById('vpop-user-value').textContent = `${val}%`;
  if (!volumePopoverTarget || volumePopoverTarget.type !== 'user') return;
  audioSettings.perUser[volumePopoverTarget.uname] = val;
  webrtc?.setPeerVolume(volumePopoverTarget.socketId, val);
  saveAudioSettings();
});

document.addEventListener('click', (e) => {
  const pop = document.getElementById('volume-popover');
  if (pop.classList.contains('hidden')) return;
  if (pop.contains(e.target)) return;
  if (e.target.closest('.voice-participant')) return;
  closeVolumePopover();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeVolumePopover();
});

function showVoiceBar(chName) {
  document.getElementById('voice-bar-channel').textContent = chName;
  document.getElementById('voice-bar').classList.remove('hidden');
}

function hideVoiceBar() {
  document.getElementById('voice-bar').classList.add('hidden');
}

function showScreenShare(socketId, stream, uname) {
  const existing = activeShares[socketId];
  activeShares[socketId] = { uname: uname || existing?.uname || username, stream: stream || existing?.stream || null };
  sharingUsers[socketId] = true;

  // Kendi paylaşımını her zaman otomatik göster; başkalarınınki "Katıl" bekler
  if (socketId === 'me' && watchingShareId === null) watchingShareId = 'me';

  renderShareStage();
  renderVoiceParticipants();
}

function hideScreenShare(socketId) {
  delete activeShares[socketId];
  delete sharingUsers[socketId];
  if (watchingShareId === socketId) watchingShareId = null;
  if (socketId === 'me') updateScreenBtn(false);
  renderShareStage();
  renderVoiceParticipants();
}

function watchShare(socketId) {
  watchingShareId = socketId;
  renderShareStage();
}

function renderShareStage() {
  const container = document.getElementById('screen-shares');
  container.innerHTML = '';
  const ids = Object.keys(activeShares);
  if (!ids.length) {
    container.classList.add('hidden');
    return;
  }
  container.classList.remove('hidden');

  if (watchingShareId && activeShares[watchingShareId]) {
    const { uname, stream } = activeShares[watchingShareId];
    const player = document.createElement('div');
    player.className = 'share-player';

    const header = document.createElement('div');
    header.className = 'share-player-header';

    const title = document.createElement('span');
    title.className = 'share-player-title';
    title.textContent = watchingShareId === 'me' ? 'Kendi paylaşımın' : `🖥️ ${uname}`;
    header.appendChild(title);

    const fsBtn = document.createElement('button');
    fsBtn.className = 'share-player-btn';
    fsBtn.textContent = '⛶ Tam Ekran';
    fsBtn.addEventListener('click', () => {
      if (!document.fullscreenElement) player.requestFullscreen?.();
      else document.exitFullscreen?.();
    });
    header.appendChild(fsBtn);

    if (watchingShareId !== 'me') {
      const leaveBtn = document.createElement('button');
      leaveBtn.className = 'share-player-btn';
      leaveBtn.textContent = 'İzlemeyi Bırak';
      leaveBtn.addEventListener('click', () => { watchingShareId = null; renderShareStage(); });
      header.appendChild(leaveBtn);
    }

    player.appendChild(header);

    if (stream) {
      const video = document.createElement('video');
      video.autoplay = true;
      video.playsInline = true;
      video.muted = (watchingShareId === 'me');
      video.srcObject = stream;
      player.appendChild(video);
    } else {
      const waiting = document.createElement('div');
      waiting.className = 'share-player-waiting';
      waiting.textContent = 'Yayına bağlanılıyor...';
      player.appendChild(waiting);
    }

    container.appendChild(player);
  }

  const others = ids.filter(id => id !== watchingShareId);
  if (others.length) {
    const prompts = document.createElement('div');
    prompts.className = 'share-prompts';
    others.forEach(id => {
      const { uname } = activeShares[id];
      const card = document.createElement('div');
      card.className = 'share-prompt-card';

      const icon = document.createElement('div');
      icon.className = 'share-prompt-icon';
      icon.textContent = '🖥️';

      const text = document.createElement('div');
      text.className = 'share-prompt-text';
      text.innerHTML = id === 'me' ? `<strong>Kendi yayınına</strong> dön` : `<strong>${uname}</strong> ekran paylaşıyor`;

      const btn = document.createElement('button');
      btn.className = 'share-join-btn';
      btn.textContent = id === 'me' ? 'Dön' : 'Katıl';
      btn.addEventListener('click', () => watchShare(id));

      card.appendChild(icon);
      card.appendChild(text);
      card.appendChild(btn);
      prompts.appendChild(card);
    });
    container.appendChild(prompts);
  }
}

// ============ PROFİL MODALI ============

document.getElementById('user-bar-btn').addEventListener('click', openProfileModal);

function openProfileModal() {
  pendingAvatarDataUrl = undefined;
  document.getElementById('profile-username-input').value = username;
  document.getElementById('profile-error').textContent = '';
  document.getElementById('avatar-file-input').value = '';
  updateProfileAvatarPreview(myAvatar);
  document.getElementById('avatar-remove-btn').classList.toggle('hidden', !myAvatar);
  document.getElementById('profile-modal-overlay').classList.remove('hidden');
}

function updateProfileAvatarPreview(src) {
  const preview = document.getElementById('profile-avatar-preview');
  if (src) {
    preview.innerHTML = `<img src="${src}" alt="avatar" />`;
    preview.className = 'profile-avatar-preview has-img';
  } else {
    preview.textContent = username[0].toUpperCase();
    preview.className = `profile-avatar-preview avatar-color-${avatarColor(username)}`;
  }
}

document.getElementById('avatar-file-input').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = 128; canvas.height = 128;
      const ctx = canvas.getContext('2d');
      const size = Math.min(img.width, img.height);
      const x = (img.width - size) / 2;
      const y = (img.height - size) / 2;
      ctx.drawImage(img, x, y, size, size, 0, 0, 128, 128);
      pendingAvatarDataUrl = canvas.toDataURL('image/jpeg', 0.85);
      updateProfileAvatarPreview(pendingAvatarDataUrl);
      document.getElementById('avatar-remove-btn').classList.remove('hidden');
    };
    img.src = ev.target.result;
  };
  reader.readAsDataURL(file);
});

document.getElementById('avatar-remove-btn').addEventListener('click', () => {
  pendingAvatarDataUrl = null;
  updateProfileAvatarPreview(null);
  document.getElementById('avatar-remove-btn').classList.add('hidden');
  document.getElementById('avatar-file-input').value = '';
});

document.getElementById('profile-modal-close').addEventListener('click', () => document.getElementById('profile-modal-overlay').classList.add('hidden'));
document.getElementById('profile-cancel-btn').addEventListener('click', () => document.getElementById('profile-modal-overlay').classList.add('hidden'));
document.getElementById('profile-modal-overlay').addEventListener('click', (e) => {
  if (e.target === document.getElementById('profile-modal-overlay')) document.getElementById('profile-modal-overlay').classList.add('hidden');
});

document.getElementById('profile-save-btn').addEventListener('click', async () => {
  const newUsername = document.getElementById('profile-username-input').value.trim();
  const errorEl = document.getElementById('profile-error');
  const saveBtn = document.getElementById('profile-save-btn');
  errorEl.textContent = '';
  const body = {};
  if (newUsername !== username) body.username = newUsername;
  if (pendingAvatarDataUrl !== undefined) body.avatar = pendingAvatarDataUrl;
  if (!Object.keys(body).length) { document.getElementById('profile-modal-overlay').classList.add('hidden'); return; }
  saveBtn.disabled = true; saveBtn.textContent = 'Kaydediliyor...';
  try {
    const res = await fetch('/api/profile', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (!res.ok) { errorEl.textContent = data.error || 'Hata oluştu'; return; }
    token = data.token; username = data.username; myAvatar = data.avatar || null;
    localStorage.setItem('token', token); localStorage.setItem('username', username);
    renderUserBar();
    document.getElementById('profile-modal-overlay').classList.add('hidden');
  } catch { errorEl.textContent = 'Sunucuya bağlanılamadı'; }
  finally { saveBtn.disabled = false; saveBtn.textContent = 'Kaydet'; }
});

// ============ TAŞI MODALI ============

function showMoveModal(socketId, uname) {
  pendingMoveSocketId = socketId;
  document.getElementById('move-modal-title').textContent = `"${uname}" kanalına taşı`;
  const select = document.getElementById('move-channel-select');
  select.innerHTML = '';
  channels.filter(c => c.type === 'voice').forEach(c => {
    const opt = document.createElement('option');
    opt.value = c.id; opt.textContent = c.name;
    select.appendChild(opt);
  });
  document.getElementById('move-modal-overlay').classList.remove('hidden');
}

document.getElementById('move-modal-close').addEventListener('click', () => { document.getElementById('move-modal-overlay').classList.add('hidden'); pendingMoveSocketId = null; });
document.getElementById('move-cancel-btn').addEventListener('click', () => { document.getElementById('move-modal-overlay').classList.add('hidden'); pendingMoveSocketId = null; });
document.getElementById('move-modal-overlay').addEventListener('click', (e) => {
  if (e.target === document.getElementById('move-modal-overlay')) { document.getElementById('move-modal-overlay').classList.add('hidden'); pendingMoveSocketId = null; }
});
document.getElementById('move-confirm-btn').addEventListener('click', () => {
  if (!pendingMoveSocketId) return;
  const channelId = parseInt(document.getElementById('move-channel-select').value);
  socket.emit('admin-move-voice', { targetSocketId: pendingMoveSocketId, channelId });
  document.getElementById('move-modal-overlay').classList.add('hidden');
  pendingMoveSocketId = null;
});

// ============ TOAST ============

function showToast(msg) {
  const existing = document.getElementById('toast-msg');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.id = 'toast-msg';
  toast.className = 'toast';
  toast.textContent = msg;
  document.body.appendChild(toast);
  setTimeout(() => toast.classList.add('show'), 10);
  setTimeout(() => { toast.classList.remove('show'); setTimeout(() => toast.remove(), 300); }, 3000);
}

// ============ UTILITIES ============

function avatarColor(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + hash * 31;
  return Math.abs(hash) % 8;
}

function formatTime(isoString) {
  return new Date(isoString).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
}

function escapeHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
