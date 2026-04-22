// Voice layer — WebRTC mesh keyed by (channelId, peerId).
//
// Why mesh: BOTC rooms are 5–15 players. Mesh is trivial to implement and has
// no server-side audio dependency. The existing WS server is used solely for
// signalling: the client sends `voice_signal` envelopes addressed to another
// peer, and the server forwards them (with a permission check that the
// recipient is also a member of the same channel).
//
// Mic mode: push-to-talk by default. The local audio track stays with
// `enabled = false` until Space is held. A mute button and a devices picker
// are exposed through the Voice UI panel.

(function () {
  const RTC_CONFIG = {
    iceServers: [
      // Public STUN only. For NAT'd relay (internet play behind symmetric NAT)
      // you should add a TURN server here — e.g. coturn on your own host.
      { urls: 'stun:stun.l.google.com:19302' },
    ],
  };

  class VoiceManager extends EventTarget {
    constructor(client) {
      super();
      this.client = client;
      this.channels = {};            // id -> { speakers, listeners, label }
      this.mine = { channels: [], roleInChannel: {} };
      this.localStream = null;       // MediaStream from getUserMedia
      // One peer connection per remote peer, NOT per channel.
      // Previously this was keyed `${channelId}::${peerId}`, which caused a
      // duplicate PC (and thus doubled audio) whenever two clients shared more
      // than one channel — typically ST ↔ player during a whisper, where both
      // are members of `table` and `whisper:<pid>`.
      this.peers = new Map();        // key `${peerId}` -> { pc, audioEl, signalingChannelId }
      this.peerSig = new Map();      // key `${peerId}` -> signature (rebuild PC on change)
      this.enabledChannels = new Set(); // channels the local mic is actively sending into
      this.ptt = true;               // push-to-talk vs open mic
      this.muted = true;             // mic armed? (PTT overrides this)
      this.talking = false;          // currently transmitting
      this.talkingRemote = new Map();// `${channelId}::${peerId}` -> bool
      this.selectedDeviceId = null;

      this.client.addEventListener('voicechannels', (ev) => this._onChannels(ev.detail));
      this.client.addEventListener('voicesignal',   (ev) => this._onSignal(ev.detail));
      this.client.addEventListener('voicemic',      (ev) => this._onMic(ev.detail));
      this.client.addEventListener('voiceice',      (ev) => this._onIce(ev.detail));
      this.client.addEventListener('close',         () => this.shutdown());

      this._wirePtt();
    }

    // Called once by the UI when the user clicks "Enable mic".
    async enable(deviceId = null) {
      if (this.localStream) return;
      const constraints = {
        audio: {
          deviceId: deviceId ? { exact: deviceId } : undefined,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      };
      this.localStream = await navigator.mediaDevices.getUserMedia(constraints);
      this.selectedDeviceId = deviceId;
      this._applyMicState();
      this.dispatchEvent(new CustomEvent('enabled'));
      await this._reconcilePeers();
    }

    async switchDevice(deviceId) {
      if (!this.localStream) return this.enable(deviceId);
      // Re-acquire with the new device, then replace tracks on every peer.
      const newStream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: deviceId }, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
      const newTrack = newStream.getAudioTracks()[0];
      for (const { pc } of this.peers.values()) {
        const sender = pc.getSenders().find(s => s.track && s.track.kind === 'audio');
        if (sender) await sender.replaceTrack(newTrack);
      }
      // Stop old tracks
      for (const t of this.localStream.getTracks()) t.stop();
      this.localStream = newStream;
      this.selectedDeviceId = deviceId;
      this._applyMicState();
    }

    async listDevices() {
      try {
        const all = await navigator.mediaDevices.enumerateDevices();
        return all.filter(d => d.kind === 'audioinput');
      } catch { return []; }
    }

    setPtt(on) { this.ptt = !!on; this._applyMicState(); }
    setMuted(on) { this.muted = !!on; this._applyMicState(); }

    shutdown() {
      for (const { pc, audioEl } of this.peers.values()) {
        try { pc.close(); } catch {}
        if (audioEl) audioEl.remove();
      }
      this.peers.clear();
      this.peerSig.clear();
      if (this.localStream) {
        for (const t of this.localStream.getTracks()) t.stop();
        this.localStream = null;
      }
      this.enabledChannels.clear();
    }

    // ----- Internal -----

    _applyMicState() {
      if (!this.localStream) return;
      // In PTT: track.enabled = holding-space && !muted
      //   off-PTT: track.enabled = !muted
      const shouldSpeak = this.ptt ? (this.talking && !this.muted) : !this.muted;
      for (const t of this.localStream.getAudioTracks()) t.enabled = shouldSpeak;
      // Broadcast talking state per channel where we are a speaker.
      for (const chId of this.enabledChannels) {
        this.client.send({ t: 'voice_mic', channelId: chId, talking: shouldSpeak });
      }
    }

    _wirePtt() {
      const isEditable = (el) => el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
      window.addEventListener('keydown', (ev) => {
        if (ev.code !== 'Space' || !this.ptt || ev.repeat) return;
        if (isEditable(document.activeElement)) return;
        ev.preventDefault();
        this.talking = true;
        this._applyMicState();
        this.dispatchEvent(new CustomEvent('ptt', { detail: true }));
      });
      window.addEventListener('keyup', (ev) => {
        if (ev.code !== 'Space' || !this.ptt) return;
        if (isEditable(document.activeElement)) return;
        ev.preventDefault();
        this.talking = false;
        this._applyMicState();
        this.dispatchEvent(new CustomEvent('ptt', { detail: false }));
      });
      // Safety: if the window loses focus while held.
      window.addEventListener('blur', () => {
        if (this.talking) {
          this.talking = false;
          this._applyMicState();
          this.dispatchEvent(new CustomEvent('ptt', { detail: false }));
        }
      });
    }

    async _onChannels({ channels, mine }) {
      this.channels = channels || {};
      this.mine = mine || { channels: [], roleInChannel: {} };
      this.dispatchEvent(new CustomEvent('channels', { detail: { channels: this.channels, mine: this.mine } }));
      await this._reconcilePeers();
    }

    // Walk the latest channel rosters and open / close peer connections.
    // Invariant: exactly one peer connection per remote peer we share at least
    // one channel with. When the set of shared channels (or our speak-bit into
    // that peer) changes, we rebuild the PC so tracks are attached correctly.
    async _reconcilePeers() {
      const me = this.client.clientId;
      if (!me) return;

      // For each remote peer, collect the channels we share with them.
      const peerChannels = new Map(); // peerId -> Set<channelId>
      for (const chId of this.mine.channels) {
        const ch = this.channels[chId];
        if (!ch) continue;
        const members = new Set([...ch.speakers, ...ch.listeners]);
        for (const pid of members) {
          if (pid === me) continue;
          if (!peerChannels.has(pid)) peerChannels.set(pid, new Set());
          peerChannels.get(pid).add(chId);
        }
      }

      // Update enabledChannels (where we can speak) BEFORE computing signatures
      // — _canSpeakTo reads this to decide whether to attach the mic.
      this.enabledChannels = new Set(
        this.mine.channels.filter(id => this.mine.roleInChannel[id] === 'speak')
      );
      this._applyMicState();

      // Close peers we no longer share any channel with.
      for (const pid of [...this.peers.keys()]) {
        if (!peerChannels.has(pid)) this._closePeer(pid);
      }

      if (!this.localStream) return; // need a mic before we can negotiate

      for (const [pid, chs] of peerChannels) {
        const sig = this._peerSignature(pid, chs);
        if (this.peers.has(pid) && this.peerSig.get(pid) === sig) continue;
        // Existing PC has a stale signature (e.g. ST just opened a whisper,
        // which flips us from listener-only to also-speaker). Tear it down and
        // reopen — simpler and more reliable than mid-call renegotiation.
        if (this.peers.has(pid)) this._closePeer(pid);
        this.peerSig.set(pid, sig);
        const initiator = me < pid; // deterministic polite peer
        const signalingChannelId = [...chs][0]; // any shared channel satisfies server-side auth
        this._createPeer(pid, signalingChannelId, initiator)
          .catch(err => console.warn('peer err', err));
      }
    }

    // True if we are a speaker on any channel we share with this peer.
    _canSpeakTo(peerId) {
      for (const chId of this.enabledChannels) {
        const ch = this.channels[chId];
        if (!ch) continue;
        const members = new Set([...ch.speakers, ...ch.listeners]);
        if (members.has(peerId)) return true;
      }
      return false;
    }

    // Stable key that changes whenever we need to rebuild the PC to this peer.
    _peerSignature(peerId, sharedChannels) {
      return [...sharedChannels].sort().join(',') + '|' + (this._canSpeakTo(peerId) ? 'S' : 'L');
    }

    _closePeer(peerId) {
      const entry = this.peers.get(peerId);
      if (!entry) return;
      try { entry.pc.close(); } catch {}
      if (entry.audioEl) entry.audioEl.remove();
      this.peers.delete(peerId);
      this.peerSig.delete(peerId);
    }

    async _createPeer(peerId, signalingChannelId, initiator) {
      const pc = new RTCPeerConnection(RTC_CONFIG);
      const audioEl = document.createElement('audio');
      audioEl.autoplay = true;
      audioEl.playsInline = true;
      audioEl.dataset.peer = peerId;
      document.body.appendChild(audioEl);
      this.peers.set(peerId, { pc, audioEl, peerId, signalingChannelId });

      // Attach our mic if we can speak to this peer on ANY shared channel.
      if (this.localStream && this._canSpeakTo(peerId)) {
        for (const t of this.localStream.getAudioTracks()) pc.addTrack(t, this.localStream);
      }

      pc.ontrack = (ev) => {
        audioEl.srcObject = ev.streams[0];
      };
      pc.onicecandidate = (ev) => {
        if (ev.candidate) {
          this.client.send({ t: 'voice_signal', to: peerId, channelId: signalingChannelId, ice: ev.candidate });
        }
      };
      pc.onconnectionstatechange = () => {
        if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) {
          // Let the reconcile loop re-create it on the next channel update.
        }
      };

      if (initiator) {
        const offer = await pc.createOffer({ offerToReceiveAudio: true });
        await pc.setLocalDescription(offer);
        this.client.send({ t: 'voice_signal', to: peerId, channelId: signalingChannelId, sdp: pc.localDescription });
      }
    }

    async _onSignal({ from, channelId, sdp, ice }) {
      let entry = this.peers.get(from);
      if (!entry) {
        // Remote initiated before our reconcile opened a peer; create a receiver.
        await this._createPeer(from, channelId, /*initiator=*/false);
        entry = this.peers.get(from);
      }
      const pc = entry.pc;
      // Reuse the channelId this signal arrived on for our reply — guarantees
      // both sides of the exchange reference the same server-authorised channel.
      const replyChannelId = channelId || entry.signalingChannelId;
      try {
        if (sdp) {
          await pc.setRemoteDescription(sdp);
          if (sdp.type === 'offer') {
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            this.client.send({ t: 'voice_signal', to: from, channelId: replyChannelId, sdp: pc.localDescription });
          }
        } else if (ice) {
          try { await pc.addIceCandidate(ice); } catch (_) {}
        }
      } catch (err) {
        console.warn('voice signal error', err);
      }
    }

    // Server-pushed ICE config (typically Cloudflare Realtime TURN). Replaces
    // the default public-STUN list so clients behind symmetric NAT can relay.
    // Existing peer connections keep their old config — only new/rebuilt PCs
    // pick up the change. That's fine: reconcile rebuilds on any channel
    // change, and no TURN is needed until a peer actually fails to connect
    // via the current config.
    _onIce({ iceServers }) {
      if (Array.isArray(iceServers) && iceServers.length) {
        RTC_CONFIG.iceServers = iceServers;
      }
    }

    _onMic({ from, channelId, talking }) {
      const key = `${channelId}::${from}`;
      this.talkingRemote.set(key, !!talking);
      this.dispatchEvent(new CustomEvent('remotemic', {
        detail: { peerId: from, channelId, talking: !!talking },
      }));
    }

    isRemoteTalking(channelId, peerId) {
      return !!this.talkingRemote.get(`${channelId}::${peerId}`);
    }
  }

  // Glue the WebSocket messages onto dispatchable events on the existing client.
  function wireVoiceEvents(client) {
    if (client.__voiceWired) return;
    client.__voiceWired = true;
    const orig = client._handle?.bind(client);
    // Subclasses of BotcClient call _handle internally; we can just subscribe to
    // a generic 'message' by monkey-patching it. Instead, piggyback the existing
    // dispatcher by adding event re-dispatch from _handle. Keep this simple.
    const wrap = client._handle;
    client._handle = function (msg) {
      wrap.call(this, msg);
      if (msg?.t === 'voice_channels') client.dispatchEvent(new CustomEvent('voicechannels', { detail: msg }));
      else if (msg?.t === 'voice_signal') client.dispatchEvent(new CustomEvent('voicesignal', { detail: msg }));
      else if (msg?.t === 'voice_mic') client.dispatchEvent(new CustomEvent('voicemic', { detail: msg }));
      else if (msg?.t === 'voice_ice') client.dispatchEvent(new CustomEvent('voiceice', { detail: msg }));
    };
  }

  window.VoiceManager = VoiceManager;
  window.wireVoiceEvents = wireVoiceEvents;
})();
