'use strict';

console.log('[WebRTC] webrtc.js v3 yüklendi (ayrı ses/ekran paylaşım bağlantıları)');

class WebRTCManager {
  constructor(socket) {
    this.socket = socket;
    this.peers = {};           // socketId -> RTCPeerConnection (sadece mikrofon)
    this.sharePeers = {};      // socketId -> RTCPeerConnection (sadece ekran paylaşım videosu, ses bağlantısından bağımsız)
    this.rawMicStream = null;  // ham mikrofon stream (donanımdan gelen)
    this.localStream = null;   // kazanç uygulanmış, peer'lara gönderilen stream
    this.screenStream = null;  // ekran paylaşım stream
    this.currentChannel = null;
    this.isMuted = false;
    this.isSharing = false;

    // Web Audio - ses karıştırma/kazanç kontrolü
    this.audioCtx = null;
    this.micGainNode = null;
    this.micVolume = 1;              // 0-2 (0-200%)
    this.masterVolume = 1;           // 0-2, tüm gelen sesleri etkiler
    this.peerVolumes = {};           // socketId -> 0-2, kişiye özel ses seviyesi
    this.peerAudioNodes = {};        // socketId -> { source, gainNode }

    // Konuşma tespiti - 'me' dahil her ses kaynağı için bir analyser tutulur
    this._speakingAnalysers = {};    // socketId ('me' dahil) -> { analyser, data }
    this.speakingStates = {};        // socketId -> boolean
    this._speakingLoopId = null;
    this._SPEAKING_THRESHOLD = 12;   // 0-255 ölçeğinde RMS eşiği

    // Callbacks (app.js tarafından set edilir)
    this.onParticipantJoined = null;
    this.onParticipantLeft = null;
    this.onScreenShareStart = null;
    this.onScreenShareStop = null;
    this.onLocalScreenShareStop = null; // kendi paylaşımım (tarayıcının "durdur" çubuğu dahil) bittiğinde
    this.onSpeakingChange = null;    // (socketId, speaking) => {}

    this.iceConfig = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
      ]
    };

    this._setupSocketListeners();
  }

  // Web Audio bağlamını hazırla (kullanıcı etkileşimi sonrası çağrılmalı)
  _ensureAudioContext() {
    if (!this.audioCtx) {
      this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (this.audioCtx.state === 'suspended') this.audioCtx.resume();
    return this.audioCtx;
  }

  // Sesli kanala katıl
  async joinVoice(channelId) {
    try {
      this.rawMicStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      const ctx = this._ensureAudioContext();

      // Mikrofonu kazanç düğümünden geçirip peer'lara o işlenmiş stream'i gönderiyoruz
      const source = ctx.createMediaStreamSource(this.rawMicStream);
      this.micGainNode = ctx.createGain();
      this.micGainNode.gain.value = this.micVolume;
      const dest = ctx.createMediaStreamDestination();
      source.connect(this.micGainNode).connect(dest);
      this._micSource = source;
      this.localStream = dest.stream;

      this._setupSpeakingAnalyser('me', this.micGainNode);
      this._startSpeakingLoop();

      this.currentChannel = channelId;
      this.socket.emit('join-voice', channelId);
      return true;
    } catch (err) {
      console.error('Mikrofon erişim hatası:', err);
      if (err.name === 'NotAllowedError') {
        throw new Error('Mikrofon izni verilmedi. Tarayıcı ayarlarından izin ver.');
      }
      throw new Error('Mikrofon açılamadı: ' + err.message);
    }
  }

  // Sesli kanaldan ayrıl
  leaveVoice() {
    if (!this.currentChannel) return;

    this.socket.emit('leave-voice');

    // Tüm ses bağlantılarını kapat
    Object.values(this.peers).forEach(pc => pc.close());
    this.peers = {};

    // Tüm ekran paylaşım bağlantılarını kapat
    this._closeAllSharePeers();

    // Gelen ses düğümlerini temizle
    Object.values(this.peerAudioNodes).forEach(({ source, gainNode }) => {
      try { source.disconnect(); gainNode.disconnect(); } catch (e) {}
    });
    this.peerAudioNodes = {};

    // Konuşma tespitini durdur
    this._stopSpeakingLoop();
    Object.keys(this._speakingAnalysers).forEach(id => this._removeSpeakingAnalyser(id));

    // Mikrofonu durdur
    if (this._micSource) { try { this._micSource.disconnect(); } catch (e) {} this._micSource = null; }
    if (this.micGainNode) { try { this.micGainNode.disconnect(); } catch (e) {} this.micGainNode = null; }
    if (this.rawMicStream) {
      this.rawMicStream.getTracks().forEach(t => t.stop());
      this.rawMicStream = null;
    }
    if (this.localStream) {
      this.localStream.getTracks().forEach(t => t.stop());
      this.localStream = null;
    }

    // Ekran paylaşımını durdur
    if (this.screenStream) {
      this.screenStream.getTracks().forEach(t => t.stop());
      this.screenStream = null;
    }

    this.currentChannel = null;
    this.isMuted = false;
    this.isSharing = false;
  }

  // Kendi mikrofon ses seviyemi ayarla (0-200)
  setMicVolume(percent) {
    this.micVolume = Math.max(0, Math.min(200, percent)) / 100;
    if (this.micGainNode) this.micGainNode.gain.value = this.micVolume;
  }

  // Gelen tüm seslerin genel seviyesini ayarla (0-200)
  setMasterVolume(percent) {
    this.masterVolume = Math.max(0, Math.min(200, percent)) / 100;
    Object.entries(this.peerAudioNodes).forEach(([socketId, { gainNode }]) => {
      const peerVol = this.peerVolumes[socketId] ?? 1;
      gainNode.gain.value = peerVol * this.masterVolume;
    });
  }

  // Belirli bir kullanıcıdan gelen sesin seviyesini ayarla (0-200)
  setPeerVolume(socketId, percent) {
    const vol = Math.max(0, Math.min(200, percent)) / 100;
    this.peerVolumes[socketId] = vol;
    const node = this.peerAudioNodes[socketId];
    if (node) node.gainNode.gain.value = vol * this.masterVolume;
  }

  // Mikrofon aç/kapat
  toggleMute() {
    if (!this.localStream) return false;
    const audioTrack = this.localStream.getAudioTracks()[0];
    if (!audioTrack) return false;
    audioTrack.enabled = !audioTrack.enabled;
    this.isMuted = !audioTrack.enabled;
    this.socket.emit('mute-status', { channelId: this.currentChannel, muted: this.isMuted });
    return this.isMuted;
  }

  // ============ EKRAN PAYLAŞIMI ============
  // Ekran paylaşımı, mikrofon bağlantısından tamamen ayrı, kendine özel
  // RTCPeerConnection'lar (sharePeers) üzerinden yürür. Bu sayede ses ve video
  // aynı bağlantıda renegotiation çakışmasına (m-line sırası hatası) girmez.

  async startScreenShare() {
    if (this.isSharing) return;
    try {
      this.screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 30, cursor: 'always' },
        audio: true
      });

      const videoTrack = this.screenStream.getVideoTracks()[0];
      videoTrack.onended = () => this.stopScreenShare();

      this.isSharing = true;
      this.socket.emit('screen-share-started', { channelId: this.currentChannel });

      // Sesli kanalda şu an bağlı olan herkese ayrı bir video bağlantısı aç
      Object.keys(this.peers).forEach(socketId => this._sendShareOfferTo(socketId));

      return true;
    } catch (err) {
      console.error('Ekran paylaşım hatası:', err);
      if (err.name === 'NotAllowedError') {
        throw new Error('Ekran paylaşımı iptal edildi.');
      }
      throw new Error('Ekran paylaşılamadı: ' + err.message);
    }
  }

  stopScreenShare() {
    if (!this.isSharing) return;

    if (this.screenStream) {
      this.screenStream.getTracks().forEach(t => t.stop());
      this.screenStream = null;
    }

    this._closeAllSharePeers();

    this.isSharing = false;
    this.socket.emit('screen-share-stopped', { channelId: this.currentChannel });
    if (this.onLocalScreenShareStop) this.onLocalScreenShareStop();
  }

  // Belirli bir kullanıcıya kendi ekran paylaşım videomu göndermek için yeni bağlantı kur
  async _sendShareOfferTo(socketId) {
    if (!this.screenStream) return;
    console.log('[WebRTC/Share] teklif gönderiliyor ->', socketId);
    try {
      const pc = this._createSharePeerConnection(socketId);
      const videoTrack = this.screenStream.getVideoTracks()[0];
      if (!videoTrack) return;
      pc.addTrack(videoTrack, this.screenStream);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.socket.emit('webrtc-offer', {
        to: socketId,
        offer: pc.localDescription,
        channelId: this.currentChannel,
        kind: 'share'
      });
      console.log('[WebRTC/Share] teklif gönderildi ->', socketId);
    } catch (err) {
      console.error('[WebRTC/Share] Ekran paylaşım teklifi hatası:', err);
    }
  }

  _createSharePeerConnection(socketId) {
    const existing = this.sharePeers[socketId];
    if (existing) { try { existing.close(); } catch (e) {} }

    const pc = new RTCPeerConnection(this.iceConfig);

    pc.ontrack = (event) => {
      console.log('[WebRTC/Share] ontrack:', socketId, event.track.kind, 'muted=', event.track.muted);
      if (event.track.kind !== 'video') return;
      const track = event.track;
      const stream = event.streams[0];
      track.onunmute = () => {
        console.log('[WebRTC/Share] video unmute:', socketId);
        if (this.onScreenShareStart) this.onScreenShareStart(socketId, stream);
      };
      track.onended = () => {
        if (this.onScreenShareStop) this.onScreenShareStop(socketId);
      };
      if (!track.muted) {
        if (this.onScreenShareStart) this.onScreenShareStart(socketId, stream);
      }
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.socket.emit('webrtc-ice', { to: socketId, candidate: event.candidate, kind: 'share' });
      }
    };

    pc.onconnectionstatechange = () => {
      console.log('[WebRTC/Share] connectionState:', socketId, pc.connectionState);
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        delete this.sharePeers[socketId];
      }
    };

    pc.oniceconnectionstatechange = () => {
      console.log('[WebRTC/Share] iceConnectionState:', socketId, pc.iceConnectionState);
    };

    this.sharePeers[socketId] = pc;
    return pc;
  }

  async _handleShareOffer(from, offer) {
    console.log('[WebRTC/Share] teklif alındı <-', from);
    try {
      const pc = this._createSharePeerConnection(from);
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.socket.emit('webrtc-answer', { to: from, answer: pc.localDescription, kind: 'share' });
      console.log('[WebRTC/Share] cevap gönderildi ->', from);
    } catch (err) {
      console.error('[WebRTC/Share] Ekran paylaşım cevabı hatası:', err);
    }
  }

  async _handleShareAnswer(from, answer) {
    console.log('[WebRTC/Share] cevap alındı <-', from);
    const pc = this.sharePeers[from];
    if (!pc) { console.warn('[WebRTC/Share] cevap için sharePeer bulunamadı:', from); return; }
    try {
      if (pc.signalingState === 'have-local-offer') {
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
      }
    } catch (err) {
      console.error('Ekran paylaşım cevabı işleme hatası:', err);
    }
  }

  async _handleShareICE(from, candidate) {
    const pc = this.sharePeers[from];
    if (!pc || !candidate) return;
    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
      // ICE state hatası genellikle zararsızdır
    }
  }

  _closeSharePeer(socketId) {
    const pc = this.sharePeers[socketId];
    if (pc) {
      pc.close();
      delete this.sharePeers[socketId];
    }
  }

  _closeAllSharePeers() {
    Object.keys(this.sharePeers).forEach(id => this._closeSharePeer(id));
  }

  // ============ MİKROFON (SES) BAĞLANTILARI ============

  // Yeni peer bağlantısı oluştur (sadece mikrofon sesi taşır)
  _createPeerConnection(socketId) {
    const pc = new RTCPeerConnection(this.iceConfig);

    // Yerel ses track'lerini ekle
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => {
        pc.addTrack(track, this.localStream);
      });
    }

    // Gelen ses track'ini işle
    pc.ontrack = (event) => {
      if (event.track.kind === 'audio') {
        this._playRemoteAudio(socketId, event.streams[0]);
      }
    };

    // ICE adaylarını sunucu üzerinden gönder
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.socket.emit('webrtc-ice', { to: socketId, candidate: event.candidate });
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        delete this.peers[socketId];
        this._stopRemoteAudio(socketId);
      }
    };

    this.peers[socketId] = pc;
    return pc;
  }

  // Teklif gönder (yeni katılan olarak)
  async _createOffer(socketId) {
    const pc = this._createPeerConnection(socketId);
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.socket.emit('webrtc-offer', {
        to: socketId,
        offer: pc.localDescription,
        channelId: this.currentChannel
      });
    } catch (err) {
      console.error('Teklif oluşturma hatası:', err);
    }
  }

  // Gelen teklifi işle
  async _handleOffer(from, offer) {
    const isNewPeer = !this.peers[from];
    const pc = this.peers[from] || this._createPeerConnection(from);
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.socket.emit('webrtc-answer', { to: from, answer: pc.localDescription });

      // Yeni katılan biriyle ses bağlantısı kurulduysa ve ben şu an ekran paylaşıyorsam,
      // ona da ayrı bir video bağlantısı aç
      if (isNewPeer && this.isSharing) {
        this._sendShareOfferTo(from);
      }
    } catch (err) {
      console.error('Cevap oluşturma hatası:', err);
    }
  }

  // Gelen cevabı işle
  async _handleAnswer(from, answer) {
    const pc = this.peers[from];
    if (!pc) return;
    try {
      if (pc.signalingState === 'have-local-offer') {
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
      }
    } catch (err) {
      console.error('Cevap işleme hatası:', err);
    }
  }

  // ICE adayını ekle
  async _handleICE(from, candidate) {
    const pc = this.peers[from];
    if (!pc || !candidate) return;
    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
      // ICE state hatası genellikle zararsızdır
    }
  }

  // Gelen sesi Web Audio grafiğine bağla (kişi başı + genel ses kontrolü için)
  _playRemoteAudio(socketId, stream) {
    const ctx = this._ensureAudioContext();
    const existing = this.peerAudioNodes[socketId];
    if (existing) {
      try { existing.source.disconnect(); existing.gainNode.disconnect(); } catch (e) {}
    }
    const source = ctx.createMediaStreamSource(stream);
    const gainNode = ctx.createGain();
    const peerVol = this.peerVolumes[socketId] ?? 1;
    gainNode.gain.value = peerVol * this.masterVolume;
    source.connect(gainNode).connect(ctx.destination);
    this.peerAudioNodes[socketId] = { source, gainNode };

    // Konuşma tespiti kişisel ses seviyesinden etkilenmesin diye kaynağı (gainNode öncesi) dinle
    this._setupSpeakingAnalyser(socketId, source);
  }

  _stopRemoteAudio(socketId) {
    const node = this.peerAudioNodes[socketId];
    if (node) {
      try { node.source.disconnect(); node.gainNode.disconnect(); } catch (e) {}
      delete this.peerAudioNodes[socketId];
    }
    this._removeSpeakingAnalyser(socketId);
  }

  // ============ KONUŞMA TESPİTİ ============

  _setupSpeakingAnalyser(id, audioNode) {
    this._removeSpeakingAnalyser(id);
    const ctx = this._ensureAudioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.6;
    audioNode.connect(analyser);
    this._speakingAnalysers[id] = { analyser, data: new Uint8Array(analyser.frequencyBinCount) };
  }

  _removeSpeakingAnalyser(id) {
    const entry = this._speakingAnalysers[id];
    if (entry) {
      try { entry.analyser.disconnect(); } catch (e) {}
      delete this._speakingAnalysers[id];
    }
    if (this.speakingStates[id]) {
      this.speakingStates[id] = false;
      if (this.onSpeakingChange) this.onSpeakingChange(id, false);
    }
    delete this.speakingStates[id];
  }

  _startSpeakingLoop() {
    if (this._speakingLoopId) return;
    const tick = () => {
      Object.entries(this._speakingAnalysers).forEach(([id, { analyser, data }]) => {
        analyser.getByteTimeDomainData(data);
        let sumSquares = 0;
        for (let i = 0; i < data.length; i++) {
          const v = data[i] - 128;
          sumSquares += v * v;
        }
        const rms = Math.sqrt(sumSquares / data.length);
        const speaking = rms > this._SPEAKING_THRESHOLD && !(id === 'me' && this.isMuted);
        if (this.speakingStates[id] !== speaking) {
          this.speakingStates[id] = speaking;
          if (this.onSpeakingChange) this.onSpeakingChange(id, speaking);
        }
      });
      this._speakingLoopId = requestAnimationFrame(tick);
    };
    this._speakingLoopId = requestAnimationFrame(tick);
  }

  _stopSpeakingLoop() {
    if (this._speakingLoopId) {
      cancelAnimationFrame(this._speakingLoopId);
      this._speakingLoopId = null;
    }
  }

  // Socket olaylarını dinle
  _setupSocketListeners() {
    // Mevcut katılımcılar listesi geldi - hepsine teklif gönder ve arayüze bildir
    this.socket.on('voice-participants', ({ participants }) => {
      participants.forEach(({ socketId, username: uname, avatar }) => {
        this._createOffer(socketId);
        if (this.onParticipantJoined) this.onParticipantJoined(socketId, uname, avatar);
      });
    });

    // Yeni biri katıldı - onlar bize teklif gönderecek, bekliyoruz
    this.socket.on('user-joined-voice', ({ socketId, username, avatar }) => {
      if (this.onParticipantJoined) this.onParticipantJoined(socketId, username, avatar);
    });

    // Biri ayrıldı
    this.socket.on('user-left-voice', ({ socketId }) => {
      if (this.peers[socketId]) {
        this.peers[socketId].close();
        delete this.peers[socketId];
      }
      this._closeSharePeer(socketId);
      this._stopRemoteAudio(socketId);
      delete this.peerVolumes[socketId];
      if (this.onParticipantLeft) this.onParticipantLeft(socketId);
    });

    // WebRTC sinyalleşme - "kind" alanına göre ses ya da ekran paylaşım bağlantısına yönlendir
    this.socket.on('webrtc-offer', async ({ from, offer, kind }) => {
      if (kind === 'share') await this._handleShareOffer(from, offer);
      else await this._handleOffer(from, offer);
    });

    this.socket.on('webrtc-answer', async ({ from, answer, kind }) => {
      if (kind === 'share') await this._handleShareAnswer(from, answer);
      else await this._handleAnswer(from, answer);
    });

    this.socket.on('webrtc-ice', async ({ from, candidate, kind }) => {
      if (kind === 'share') await this._handleShareICE(from, candidate);
      else await this._handleICE(from, candidate);
    });

    // Ekran paylaşım bildirimleri (gerçek video bağlantısından önce/bağımsız gelen bildirim)
    this.socket.on('screen-share-update', ({ socketId, username, sharing }) => {
      console.log('[WebRTC/Share] screen-share-update:', socketId, username, 'sharing=', sharing);
      if (sharing) {
        if (this.onScreenShareStart) this.onScreenShareStart(socketId, null, username);
      } else {
        this._closeSharePeer(socketId);
        if (this.onScreenShareStop) this.onScreenShareStop(socketId);
      }
    });
  }
}
