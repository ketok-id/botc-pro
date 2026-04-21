// WebSocket client wrapper shared by lobby & game UIs.
// Features:
//   - Typed sends for create/join/chat/actions.
//   - Keep-alive ping every 30s so Cloudflare / NAT boxes don't idle us out.
//   - Auto-reconnect with a RESUME message that re-keys to the old clientId
//     so the server can snap us back into our old seat (roles, votes intact).

(function () {
  const PROTOCOL_VERSION = 1;
  const PING_INTERVAL_MS = 30 * 1000;
  const MAX_RECONNECT_ATTEMPTS = 8;
  const RECONNECT_BASE_MS = 1500;       // first retry after 1.5s
  const RECONNECT_MAX_MS = 20 * 1000;   // cap backoff at 20s

  class BotcClient extends EventTarget {
    constructor() {
      super();
      this.ws = null;
      this.url = null;
      this.clientId = null;
      this.roomCode = null;
      this.name = null;
      this.isSt = false;
      this.state = null;               // last room state

      this._pingTimer = null;
      this._reconnectAttempts = 0;
      this._reconnecting = false;
      this._intentionalClose = false;  // set when user explicitly leaves
    }

    connect(url) {
      this.url = url;
      this._intentionalClose = false;
      return this._open(url);
    }

    _open(url) {
      return new Promise((resolve, reject) => {
        let ws;
        try { ws = new WebSocket(url); }
        catch (err) { return reject(err); }
        this.ws = ws;
        const onOpen = () => {
          ws.removeEventListener('open', onOpen);
          ws.removeEventListener('error', onErr);
          this._attachListeners(ws);
          this._startKeepalive();
          this.dispatchEvent(new Event('open'));
          resolve();
        };
        const onErr = (e) => {
          ws.removeEventListener('open', onOpen);
          ws.removeEventListener('error', onErr);
          reject(new Error('Could not connect to ' + url));
        };
        ws.addEventListener('open', onOpen);
        ws.addEventListener('error', onErr);
      });
    }

    _attachListeners(ws) {
      ws.addEventListener('message', (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        this._handle(msg);
      });
      ws.addEventListener('close', () => {
        this._stopKeepalive();
        if (this._intentionalClose || !this.url) {
          this._reset();
          this.dispatchEvent(new Event('close'));
          return;
        }
        // Automatic reconnect if we had an active room or clientId to resume.
        if ((this.roomCode || this.clientId) && this._reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
          this._scheduleReconnect();
        } else {
          this._reset();
          this.dispatchEvent(new Event('close'));
        }
      });
      ws.addEventListener('error', () => {
        this.dispatchEvent(new Event('error'));
      });
    }

    _scheduleReconnect() {
      this._reconnecting = true;
      this._reconnectAttempts++;
      const delay = Math.min(
        RECONNECT_BASE_MS * Math.pow(1.6, this._reconnectAttempts - 1),
        RECONNECT_MAX_MS
      );
      this.dispatchEvent(new CustomEvent('reconnecting', {
        detail: { attempt: this._reconnectAttempts, delayMs: delay },
      }));
      setTimeout(() => this._doReconnect(), delay);
    }

    async _doReconnect() {
      try {
        await this._open(this.url);
        // Now ask the server to reattach us to the existing seat.
        if (this.clientId && this.roomCode) {
          this.send({ t: 'resume', clientId: this.clientId, code: this.roomCode, name: this.name });
        }
        // Successful open — reset retry counter on first room_state/welcome.
      } catch (err) {
        if (this._reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
          this._scheduleReconnect();
        } else {
          this._reset();
          this.dispatchEvent(new Event('close'));
        }
      }
    }

    _startKeepalive() {
      this._stopKeepalive();
      this._pingTimer = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.send({ t: 'ping' });
        }
      }, PING_INTERVAL_MS);
    }

    _stopKeepalive() {
      if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; }
    }

    _reset() {
      this._reconnecting = false;
      this._reconnectAttempts = 0;
    }

    _handle(msg) {
      switch (msg.t) {
        case 'welcome':
          this.clientId = msg.clientId || this.clientId;
          if (msg.room) {
            this.roomCode = msg.room.code;
            this.isSt = !!msg.room.isSt;
          }
          this._reset();
          this.dispatchEvent(new CustomEvent('welcome', { detail: msg }));
          break;
        case 'room_state':
          this.state = msg.state;
          if (msg.room) this.roomCode = msg.room.code;
          this._reset();
          this.dispatchEvent(new CustomEvent('state', { detail: msg.state }));
          break;
        case 'private_info':
          this.dispatchEvent(new CustomEvent('private', { detail: msg }));
          break;
        case 'chat':
          this.dispatchEvent(new CustomEvent('chat', { detail: msg }));
          break;
        case 'error':
          // If resume failed because the room is gone, give up and surface it.
          if (/no longer exists|Room not found/i.test(msg.message || '')) {
            this._intentionalClose = true;
            this.roomCode = null;
          }
          this.dispatchEvent(new CustomEvent('servererror', { detail: msg.message }));
          break;
        case 'room_closed':
          // The room was destroyed server-side (ST left / closed). Prevent
          // auto-reconnect attempts and surface an event so the UI can swap
          // back to the lobby with an explanation.
          this._intentionalClose = true;
          this.roomCode = null;
          this.clientId = null;
          this.state = null;
          this.dispatchEvent(new CustomEvent('roomclosed', { detail: { reason: msg.reason || 'Room closed.' } }));
          try { this.ws?.close(); } catch {}
          break;
        case 'pong':
          // keep-alive response, no-op
          break;
        // voice_channels / voice_signal / voice_mic are re-dispatched as
        // 'voicechannels' / 'voicesignal' / 'voicemic' events by the
        // wireVoiceEvents() monkey-patch in voice.js — no handling here.
      }
    }

    send(obj) {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      this.ws.send(JSON.stringify({ v: PROTOCOL_VERSION, ...obj }));
    }

    hello(name)             { this.name = name; this.send({ t: 'hello', name }); }
    createRoom(name)        { this.name = name; this.send({ t: 'create_room', name }); }
    joinRoom(name, code)    { this.name = name; this.roomCode = code; this.send({ t: 'join_room', name, code }); }
    leaveRoom()             {
      this._intentionalClose = true;
      this.send({ t: 'leave_room' });
      this.roomCode = null;
      this.clientId = null;
      this.state = null;
      try { this.ws?.close(); } catch {}
    }
    // Storyteller-only. The server will reject if called by a non-ST, and the
    // UI only exposes it for the ST, so this just sends the intent.
    closeRoom()             {
      this._intentionalClose = true;
      this.send({ t: 'close_room' });
      this.roomCode = null;
      this.clientId = null;
      this.state = null;
      try { this.ws?.close(); } catch {}
    }
    chat(text)              { this.send({ t: 'chat', text }); }
    st(action, payload)     { this.send({ t: 'st_action', action, payload }); }
    playerAction(action, payload) { this.send({ t: 'player_action', action, payload }); }
  }

  window.BotcClient = BotcClient;
})();
