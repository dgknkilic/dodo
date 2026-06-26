'use strict';

class WebRTCManager {
  constructor(socket) {
    this.socket = socket;
    this.peers = {};           // socketId -> RTCPeerConnection
    this.localStream = null;   // mikrofon stream
    this.screenStream = null;  // ekran paylaşım stream
    this.currentChannel = null;
    this.isMuted = false;
    this.isSharing = false;

    // Callbacks (app.js tarafından set edilir)
    this.onParticipantJoined = null;
    this.onParticipantLeft = null;
    this.onScreenShareStart = null;
    this.onScreenShareStop = null;

    this.iceConfig = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
      ]
    };

    this._setupSocketListeners();
  }

  // Sesli kanala katıl
  async joinVoice(channelId) {
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
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

    // Tüm peer bağlantılarını kapat
    Object.values(this.peers).forEach(pc => pc.close());
    this.peers = {};

    // Mikrofonu durdur
    if (this.localStream) {
      this.localStream.getTracks().forEach(t => t.stop());
      this.localStream = null;
    }

    // Ekran paylaşımını durdur
    if (this.screenStream) {
      this.screenStream.getTracks().forEach(t => t.stop());
      this.screenStream = null;
    }

    // Ses elementlerini temizle
    document.querySelectorAll('[data-peer-audio]').forEach(el => el.remove());

    this.currentChannel = null;
    this.isMuted = false;
    this.isSharing = false;
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

  // Ekran paylaşımını başlat
  async startScreenShare() {
    if (this.isSharing) return;
    try {
      this.screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 30, cursor: 'always' },
        audio: true
      });

      const videoTrack = this.screenStream.getVideoTracks()[0];

      // Tüm peer bağlantılarına video track ekle (renegotiation tetikler)
      for (const [socketId, pc] of Object.entries(this.peers)) {
        const videoSender = pc.getSenders().find(s => s.track?.kind === 'video');
        if (videoSender) {
          await videoSender.replaceTrack(videoTrack);
        } else {
          pc.addTrack(videoTrack, this.screenStream);
        }
      }

      videoTrack.onended = () => this.stopScreenShare();

      this.isSharing = true;
      this.socket.emit('screen-share-started', { channelId: this.currentChannel });
      return true;
    } catch (err) {
      console.error('Ekran paylaşım hatası:', err);
      if (err.name === 'NotAllowedError') {
        throw new Error('Ekran paylaşımı iptal edildi.');
      }
      throw new Error('Ekran paylaşılamadı: ' + err.message);
    }
  }

  // Ekran paylaşımını durdur
  stopScreenShare() {
    if (!this.isSharing) return;

    if (this.screenStream) {
      this.screenStream.getTracks().forEach(t => t.stop());
      this.screenStream = null;
    }

    // Video track'i peer bağlantılarından kaldır
    for (const pc of Object.values(this.peers)) {
      const videoSender = pc.getSenders().find(s => s.track?.kind === 'video');
      if (videoSender) pc.removeTrack(videoSender);
    }

    this.isSharing = false;
    this.socket.emit('screen-share-stopped', { channelId: this.currentChannel });
  }

  // Yeni peer bağlantısı oluştur
  _createPeerConnection(socketId) {
    const pc = new RTCPeerConnection(this.iceConfig);

    // Yerel ses track'lerini ekle
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => {
        pc.addTrack(track, this.localStream);
      });
    }

    // Gelen track'leri işle
    pc.ontrack = (event) => {
      const track = event.track;
      const stream = event.streams[0];

      if (track.kind === 'audio') {
        this._addAudioElement(socketId, stream);
      } else if (track.kind === 'video') {
        // Ekran paylaşımı
        track.onunmute = () => {
          if (this.onScreenShareStart) this.onScreenShareStart(socketId, stream);
        };
        track.onended = () => {
          if (this.onScreenShareStop) this.onScreenShareStop(socketId);
        };
        if (!track.muted) {
          if (this.onScreenShareStart) this.onScreenShareStart(socketId, stream);
        }
      }
    };

    // ICE adaylarını sunucu üzerinden gönder
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.socket.emit('webrtc-ice', { to: socketId, candidate: event.candidate });
      }
    };

    // Renegotiation (ekran paylaşımı başlayınca tetiklenir)
    pc.onnegotiationneeded = async () => {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        this.socket.emit('webrtc-offer', {
          to: socketId,
          offer: pc.localDescription,
          channelId: this.currentChannel
        });
      } catch (err) {
        console.error('Renegotiation hatası:', err);
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        delete this.peers[socketId];
        this._removeAudioElement(socketId);
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
    const pc = this._createPeerConnection(from);
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.socket.emit('webrtc-answer', { to: from, answer: pc.localDescription });
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

  // Ses elementi ekle
  _addAudioElement(socketId, stream) {
    let audio = document.querySelector(`[data-peer-audio="${socketId}"]`);
    if (!audio) {
      audio = document.createElement('audio');
      audio.dataset.peerAudio = socketId;
      audio.autoplay = true;
      document.getElementById('audio-container').appendChild(audio);
    }
    audio.srcObject = stream;
  }

  _removeAudioElement(socketId) {
    const audio = document.querySelector(`[data-peer-audio="${socketId}"]`);
    if (audio) audio.remove();
  }

  // Socket olaylarını dinle
  _setupSocketListeners() {
    // Mevcut katılımcılar listesi geldi - hepsine teklif gönder
    this.socket.on('voice-participants', ({ participants }) => {
      participants.forEach(({ socketId }) => {
        this._createOffer(socketId);
      });
    });

    // Yeni biri katıldı - onlar bize teklif gönderecek, bekliyoruz
    this.socket.on('user-joined-voice', ({ socketId, username }) => {
      if (this.onParticipantJoined) this.onParticipantJoined(socketId, username);
    });

    // Biri ayrıldı
    this.socket.on('user-left-voice', ({ socketId }) => {
      if (this.peers[socketId]) {
        this.peers[socketId].close();
        delete this.peers[socketId];
      }
      this._removeAudioElement(socketId);
      if (this.onParticipantLeft) this.onParticipantLeft(socketId);
    });

    // WebRTC sinyalleşme
    this.socket.on('webrtc-offer', async ({ from, offer }) => {
      await this._handleOffer(from, offer);
    });

    this.socket.on('webrtc-answer', async ({ from, answer }) => {
      await this._handleAnswer(from, answer);
    });

    this.socket.on('webrtc-ice', async ({ from, candidate }) => {
      await this._handleICE(from, candidate);
    });

    // Ekran paylaşım bildirimleri
    this.socket.on('screen-share-update', ({ socketId, username, sharing }) => {
      if (sharing) {
        if (this.onScreenShareStart) this.onScreenShareStart(socketId, null, username);
      } else {
        if (this.onScreenShareStop) this.onScreenShareStop(socketId);
      }
    });
  }
}
