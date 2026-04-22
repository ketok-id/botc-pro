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
        const rebuilding = this.peers.has(pid);
        if (rebuilding) this._closePeer(pid);
        this.peerSig.set(pid, sig);
        // On fresh creation use the deterministic polite-peer rule (me < pid)
        // so both sides don't both offer. On REBUILD, the side that detected
        // the state change must initiate — the remote still has its stale PC
        // and won't know to rebuild on its own. _onSignal handles the
        // tear-down on receipt of a new offer for an existing entry.
        const initiator = rebuilding ? true : (me < pid);
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
    // NB: mirrors what _createPeer actually does — attaches a local track only
    // when BOTH conditions hold. If we keyed purely on channel role, a
    // listener-only PC created before the mic was enabled would match the
    // post-enable signature and the reconcile pass would skip the rebuild,
    // leaving the PC silent. (This was the root cause of #5.)
    _peerSignature(peerId, sharedChannels) {
      const canSend = !!this.localStream && this._canSpeakTo(peerId);
      return [...sharedChannels].sort().join(',') + '|' + (canSend ? 'S' : 'L');
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
      const canSpeak = this.localStream && this._canSpeakTo(peerId);
      if (canSpeak) {
        for (const t of this.localStream.getAudioTracks()) pc.addTrack(t, this.localStream);
      }
      // Always declare a recv audio transceiver. Without this, listener-only
      // peers negotiate an SDP with no recv m-line on Safari/WebKit (the
      // legacy `offerToReceiveAudio` flag is unreliable there), so remote
      // audio never flows.
      if (!canSpeak) {
        try { pc.addTransceiver('audio', { direction: 'recvonly' }); } catch {}
      }

      pc.ontrack = (ev) => {
        // `ev.streams[0]` is empty in some unified-plan paths (notably Safari);
        // fall back to wrapping the raw track.
        const stream = ev.streams && ev.streams[0]
          ? ev.streams[0]
          : new MediaStream([ev.track]);
        audioEl.srcObject = stream;
        // Autoplay policies on macOS Chrome/Safari block playback on audio
        // elements appended after the initial user gesture. The "Enable mic"
        // click counts as a gesture, so kicking .play() here is allowed — and
        // is what unsticks previously-silent remote streams.
        const p = audioEl.play();
        if (p && typeof p.catch === 'function') {
          p.catch(err => console.warn('voice audio play blocked', err));
        }
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
        // The recvonly transceiver (when listener-only) or the sent track
        // (when speaker) already defines the m-line; no legacy offer options
        // needed.
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        this.client.send({ t: 'voice_signal', to: peerId, channelId: signalingChannelId, sdp: pc.localDescription });
      }
    }

    async _onSignal({ from, channelId, sdp, ice }) {
      let entry = this.peers.get(from);
      // A fresh OFFER for an existing peer means the remote has torn down
      // their old PC and rebuilt it (e.g. because their role flipped from
      // listener to speaker). Our local PC is now stale SDP-wise; wipe it
      // and answer with a fresh one. Also: remember the expected signature
      // here so a later reconcile doesn't needlessly close-and-rebuild us.
      if (entry && sdp && sdp.type === 'offer') {
        this._closePeer(from);
        entry = null;
      }
      if (!entry) {
        // Remote initiated before our reconcile opened a peer; create a receiver.
        await this._createPeer(from, channelId, /*initiator=*/false);
        entry = this.peers.get(from);
        // Seed peerSig with the PC's actual post-creation signature so a
        // subsequent reconcile doesn't pointlessly tear this down. When the
        // user later enables the mic, _peerSignature flips L->S for speaker
        // channels and reconcile correctly rebuilds to attach local tracks.
        const chs = new Set();
        for (const chId of this.mine.channels) {
          const ch = this.channels[chId];
          if (!ch) continue;
          if (ch.speakers.includes(from) || ch.listeners.includes(from)) chs.add(chId);
        }
        if (chs.size) this.peerSig.set(from, this._peerSignature(from, chs));
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
    };
  }

  window.VoiceManager = VoiceManager;
  window.wireVoiceEvents = wireVoiceEvents;
})();
