// WebSocket server for BOTC Pro.
// Hosts rooms; each room has a game state and a set of connected clients.
// Works identically on a LAN-hosted Electron instance and on a dedicated Node host.

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { WebSocketServer } = require('ws');
const { nanoid, customAlphabet } = require('nanoid');
const { C2S, S2C, PROTOCOL_VERSION, PHASES } = require('../shared/protocol');
const engine = require('../shared/game-engine');
const turn = require('./turn');

// Static files served at `/` when a webRoot is provided. Limited to the file
// types the renderer actually ships so we don't accidentally expose anything
// else (.env, source maps, etc).
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.ico':  'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
};

const roomCodeGen = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 5);

// How long an empty room is kept alive after the last client drops, to give
// disconnected players a chance to reconnect and resume their seat.
const ROOM_GRACE_MS = 10 * 60 * 1000;   // 10 minutes

// How often the server actively pings each client. If the socket doesn't
// respond for 2 pings in a row, ws closes it and handleDisconnect fires.
const SERVER_PING_INTERVAL_MS = 45 * 1000;

function makeRoom() {
  const code = roomCodeGen();
  return {
    code,
    clients: new Map(),         // clientId -> { ws, name }
    game: engine.createGame('trouble-brewing'),
    createdAt: Date.now(),
    openWhispers: new Set(),    // player ids currently in an ST whisper channel
    voice: { channels: {}, perClient: {} },
    cleanupTimer: null,         // setTimeout handle while the room is in grace period
  };
}

// `webRoot` (optional): absolute path to a directory whose contents should be
// served for plain HTTP requests on the same port. When set, the same URL can
// be opened in a browser (web client) or targeted via wss:// (desktop client).
// Pass `null` to run WS-only (matches the old behaviour).
function startServer({ port = 0, bind = '0.0.0.0', webRoot = null } = {}) {
  return new Promise((resolve, reject) => {
    const httpServer = http.createServer(async (req, res) => {
      if (!webRoot) {
        res.writeHead(426, { 'Content-Type': 'text/plain' });
        return res.end('Upgrade required (WebSocket).');
      }
      try { await serveStatic(req, res, webRoot); }
      catch (err) { res.writeHead(500); res.end(err.message); }
    });

    const wss = new WebSocketServer({ server: httpServer });
    httpServer.on('error', (err) => reject(err));

    const rooms = new Map();     // code -> room
    const clients = new Map();   // clientId -> { ws, roomCode, name }

    httpServer.listen(port, bind, () => {
      const address = httpServer.address();
      const actualPort = typeof address === 'object' ? address.port : port;
      resolve({
        port: actualPort,
        wss,
        httpServer,
        rooms,
        close: () => new Promise((res) => {
          wss.close(() => httpServer.close(() => res()));
        }),
      });
    });

    wss.on('error', (err) => {
      console.error('[botc-pro] ws server error:', err);
    });

    // Server-driven heartbeat. The `ws` library exposes a native ping() / pong
    // flow; if pong doesn't arrive between two ping cycles, the socket is dead
    // and we close it. This catches Cloudflare-style silent disconnects on the
    // server side, complementing the client's own 30s ping.
    const heartbeat = setInterval(() => {
      for (const ws of wss.clients) {
        if (ws.isAlive === false) { try { ws.terminate(); } catch {} continue; }
        ws.isAlive = false;
        try { ws.ping(); } catch {}
      }
    }, SERVER_PING_INTERVAL_MS);
    wss.on('close', () => clearInterval(heartbeat));

    wss.on('connection', async (ws, req) => {
      // A "session" is a single WebSocket. Its clientId can be RE-KEYED later
      // if the client RESUMEs an old session — so we keep it mutable here.
      const session = {
        clientId: nanoid(10),
        ws,
        roomCode: null,
        name: null,
      };
      ws.isAlive = true;
      ws.on('pong', () => { ws.isAlive = true; });
      clients.set(session.clientId, session);

      // Attach message/close listeners BEFORE the async TURN mint — the
      // `ws` library doesn't buffer messages for late listeners, so clients
      // that send immediately after WS open (e.g. `create_room` right after
      // connect()) would otherwise be silently dropped while mint is pending.
      // None of the message handlers depend on WELCOME having been delivered
      // first, so processing them early is safe.
      ws.on('message', (buf) => {
        let msg;
        try {
          msg = JSON.parse(buf.toString());
        } catch {
          return send(ws, { t: S2C.ERROR, message: 'Invalid JSON' });
        }
        handleMessage(session, msg).catch(err => {
          send(ws, { t: S2C.ERROR, message: err.message });
        });
      });

      ws.on('close', () => {
        handleDisconnect(session);
      });

      // If Cloudflare Realtime TURN is configured, mint ephemeral creds and
      // push them BEFORE welcome. The client is driven by voice_channels /
      // localStream to build PCs, not by welcome directly — but sending
      // voice_ice ahead of welcome still guarantees RTC_CONFIG is populated
      // before any subsequent voice_channels broadcast. getIceServers() is
      // cached and bounded by a short fetch timeout, so the added connect
      // latency is negligible. A failure falls through to public STUN — which
      // still works on friendly NAT / same-LAN setups.
      if (turn.isConfigured()) {
        try {
          const iceServers = await turn.getIceServers();
          if (iceServers && ws.readyState === ws.OPEN) {
            send(ws, { t: S2C.VOICE_ICE, iceServers });
          }
        } catch (err) {
          console.warn('[botc-pro] turn mint error:', err.message);
        }
        if (ws.readyState !== ws.OPEN) return; // client gave up while we minted
      }

      send(ws, { t: S2C.WELCOME, clientId: session.clientId, version: PROTOCOL_VERSION });
    });

    async function handleMessage(session, msg) {
      const ws = session.ws;

      switch (msg.t) {
        case C2S.PING:
          return send(ws, { t: S2C.PONG });

        case C2S.HELLO:
          session.name = sanitizeName(msg.name);
          return send(ws, { t: S2C.WELCOME, clientId: session.clientId, version: PROTOCOL_VERSION });

        case C2S.CREATE_ROOM: {
          if (session.roomCode) throw new Error('Already in a room');
          session.name = sanitizeName(msg.name || session.name || 'Storyteller');
          const room = makeRoom();
          rooms.set(room.code, room);
          console.log(`[botc-pro] CREATE_ROOM code=${room.code} by=${session.name} (${session.clientId}); active rooms: ${rooms.size} [${[...rooms.keys()].join(',')}]`);
          joinRoomAs(room, session, /*isSt=*/true);
          return;
        }

        case C2S.JOIN_ROOM: {
          const rawCode = String(msg.code || '');
          const code = rawCode.toUpperCase().trim();
          const room = rooms.get(code);
          const activeCodes = [...rooms.keys()];
          console.log(`[botc-pro] JOIN_ROOM code="${code}" (raw="${rawCode}") by=${sanitizeName(msg.name)} matched=${!!room}; active rooms: ${activeCodes.length} [${activeCodes.join(',')}]`);
          if (!room) {
            // Clearer error so the ST/joiner can tell "server was restarted /
            // room never existed" from "you mistyped the code".
            const hint = activeCodes.length === 0
              ? 'no rooms active on this server — the Storyteller needs to create one first (or the server was restarted)'
              : `${activeCodes.length} other room${activeCodes.length===1?'':'s'} active — double-check the code, or the Storyteller may be on a different server`;
            throw new Error(`Room ${code} not found (${hint})`);
          }
          if (session.roomCode) throw new Error('Already in a room');
          session.name = sanitizeName(msg.name || session.name || 'Player');
          joinRoomAs(room, session, /*isSt=*/false);
          return;
        }

        case C2S.RESUME: {
          const code = (msg.code || '').toUpperCase().trim();
          const room = rooms.get(code);
          if (!room) throw new Error('Room no longer exists');
          const oldId = String(msg.clientId || '');
          const player = oldId ? room.game.players.find(p => p.id === oldId) : null;

          if (!player) {
            // No record of this clientId (e.g. grace period expired and the
            // room was newly created with the same code) — fall back to a
            // fresh join so the user still ends up in a valid state.
            if (!session.roomCode) {
              session.name = sanitizeName(msg.name || session.name || 'Player');
              joinRoomAs(room, session, /*isSt=*/false);
            }
            return;
          }

          // Re-key this session to use the old clientId. All existing
          // references in game state (storytellerId, nominations, votes)
          // remain valid because we keep the same id.
          clients.delete(session.clientId);
          session.clientId = oldId;
          session.roomCode = room.code;
          session.name = player.name;
          clients.set(oldId, session);
          room.clients.set(oldId, { ws, name: player.name });
          cancelRoomCleanup(room);

          send(ws, {
            t: S2C.WELCOME, clientId: oldId, version: PROTOCOL_VERSION,
            room: { code: room.code, isSt: player.isSt },
          });
          broadcastRoomState(room);
          return;
        }

        case C2S.LEAVE_ROOM: {
          const room = rooms.get(session.roomCode);
          if (!room) return;
          // If the Storyteller leaves, the game can't continue — close the
          // whole room for everyone. A seated player leaving just drops them.
          if (room.game.storytellerId === session.clientId) {
            closeRoom(room, 'The Storyteller left the room.');
            return;
          }
          engine.removePlayer(room.game, session.clientId);
          room.clients.delete(session.clientId);
          session.roomCode = null;
          broadcastRoomState(room);
          if (room.clients.size === 0) scheduleRoomCleanup(room);
          return;
        }

        case C2S.CLOSE_ROOM: {
          const room = rooms.get(session.roomCode);
          if (!room) throw new Error('Not in a room');
          if (room.game.storytellerId !== session.clientId) {
            throw new Error('Only the Storyteller can close the room');
          }
          closeRoom(room, 'The Storyteller closed the room.');
          return;
        }

        case C2S.CHAT: {
          const room = rooms.get(session.roomCode);
          if (!room) throw new Error('Not in a room');
          const payload = { t: S2C.CHAT, from: session.name, text: String(msg.text || '').slice(0, 500), ts: Date.now() };
          for (const { ws: w } of room.clients.values()) send(w, payload);
          return;
        }

        case C2S.ST_ACTION: {
          const room = rooms.get(session.roomCode);
          if (!room) throw new Error('Not in a room');
          if (room.game.storytellerId !== session.clientId) throw new Error('Only the Storyteller can do that');
          handleStAction(room, msg.action, msg.payload || {});
          broadcastRoomState(room);
          return;
        }

        case C2S.PLAYER_ACTION: {
          const room = rooms.get(session.roomCode);
          if (!room) throw new Error('Not in a room');
          handlePlayerAction(room, session.clientId, msg.action, msg.payload || {});
          broadcastRoomState(room);
          return;
        }

        // -------- Voice --------
        case C2S.VOICE_SIGNAL: {
          const room = rooms.get(session.roomCode);
          if (!room) throw new Error('Not in a room');
          const { to, channelId } = msg;
          if (!to || !channelId) throw new Error('voice_signal missing to/channelId');
          if (!peerAllowedInChannel(room, session.clientId, channelId) ||
              !peerAllowedInChannel(room, to, channelId)) {
            throw new Error('Not allowed on this voice channel');
          }
          const target = room.clients.get(to);
          if (!target) return;
          send(target.ws, {
            t: S2C.VOICE_SIGNAL,
            from: session.clientId,
            channelId,
            sdp: msg.sdp,
            ice: msg.ice,
          });
          return;
        }

        case C2S.VOICE_MIC: {
          const room = rooms.get(session.roomCode);
          if (!room) return;
          const { channelId, talking } = msg;
          if (!peerAllowedInChannel(room, session.clientId, channelId)) return;
          const ch = room.voice.channels[channelId];
          if (!ch) return;
          const members = [...ch.speakers, ...ch.listeners];
          for (const mid of members) {
            if (mid === session.clientId) continue;
            const t = room.clients.get(mid);
            if (t) send(t.ws, { t: S2C.VOICE_MIC, from: session.clientId, channelId, talking: !!talking });
          }
          return;
        }

        case C2S.VOICE_WHISPER: {
          const room = rooms.get(session.roomCode);
          if (!room) throw new Error('Not in a room');
          if (room.game.storytellerId !== session.clientId) throw new Error('Only the Storyteller can open whispers');
          const { playerId, open } = msg;
          if (!playerId) throw new Error('playerId required');
          if (open) room.openWhispers.add(playerId);
          else room.openWhispers.delete(playerId);
          broadcastRoomState(room);
          return;
        }

        default:
          throw new Error(`Unknown message type: ${msg.t}`);
      }
    }

    function peerAllowedInChannel(room, clientId, channelId) {
      const ch = room.voice.channels[channelId];
      if (!ch) return false;
      return ch.speakers.includes(clientId) || ch.listeners.includes(clientId);
    }

    function joinRoomAs(room, session, isSt) {
      room.clients.set(session.clientId, { ws: session.ws, name: session.name });
      session.roomCode = room.code;
      engine.addPlayer(room.game, { id: session.clientId, name: session.name, isSt });
      cancelRoomCleanup(room);
      send(session.ws, {
        t: S2C.WELCOME, clientId: session.clientId, version: PROTOCOL_VERSION,
        room: { code: room.code, isSt },
      });
      broadcastRoomState(room);
    }

    // Tear a room down now: notify every connected client, detach their
    // sessions, and drop the room from the registry. Used by ST close-room
    // and by an ST leaving (the game can't continue without a Storyteller).
    function closeRoom(room, reason) {
      const msg = { t: S2C.ROOM_CLOSED, reason: String(reason || 'Room closed.') };
      for (const [cid, { ws }] of room.clients.entries()) {
        send(ws, msg);
        const s = clients.get(cid);
        if (s) s.roomCode = null;
      }
      room.clients.clear();
      cancelRoomCleanup(room);
      rooms.delete(room.code);
      console.log(`[botc-pro] closeRoom code=${room.code} reason="${reason}"; active rooms: ${rooms.size}`);
    }

    function scheduleRoomCleanup(room) {
      clearTimeout(room.cleanupTimer);
      room.cleanupTimer = setTimeout(() => {
        if (room.clients.size === 0) {
          console.log(`[botc-pro] room ${room.code} expired after ${ROOM_GRACE_MS/1000}s grace period`);
          rooms.delete(room.code);
        }
      }, ROOM_GRACE_MS);
    }

    function cancelRoomCleanup(room) {
      if (room.cleanupTimer) {
        clearTimeout(room.cleanupTimer);
        room.cleanupTimer = null;
      }
    }

    function handleStAction(room, action, payload) {
      const g = room.game;
      switch (action) {
        case 'start_game':
          engine.startGame(g, { includeBaron: !!payload.includeBaron });
          break;
        case 'to_day':
          engine.advanceToDay(g);
          break;
        case 'to_night':
          engine.advanceToNight(g);
          break;
        case 'end_day':
          engine.endDay(g);
          break;
        case 'resolve_nomination':
          engine.resolveNomination(g);
          break;
        case 'st_kill':
          engine.stKill(g, payload.playerId, payload.reason);
          break;
        case 'set_character': {
          // ST overrides a role (e.g. Scarlet Woman becomes Imp).
          const p = g.players.find(pp => pp.id === payload.playerId);
          if (!p) throw new Error('Unknown player');
          p.character = payload.characterId;
          break;
        }
        case 'set_alive': {
          const p = g.players.find(pp => pp.id === payload.playerId);
          if (!p) throw new Error('Unknown player');
          p.alive = !!payload.alive;
          break;
        }
        case 'set_poisoned': {
          const p = g.players.find(pp => pp.id === payload.playerId);
          if (!p) throw new Error('Unknown player');
          p.poisoned = !!payload.poisoned;
          break;
        }
        case 'add_reminder': {
          const p = g.players.find(pp => pp.id === payload.playerId);
          if (!p) throw new Error('Unknown player');
          // `roleSource` is the role id the reminder is tied to (for styling
          // chips by originating role's team colour). Optional and free-form.
          p.reminders.push({
            id: nanoid(6),
            text: String(payload.text || '').slice(0, 40),
            roleSource: payload.roleSource ? String(payload.roleSource).slice(0, 30) : null,
          });
          break;
        }
        case 'remove_reminder': {
          const p = g.players.find(pp => pp.id === payload.playerId);
          if (!p) throw new Error('Unknown player');
          p.reminders = p.reminders.filter(r => r.id !== payload.reminderId);
          break;
        }
        case 'deliver_private': {
          // Send a targeted private info blob to a single player.
          const target = room.clients.get(payload.playerId);
          if (!target) throw new Error('Unknown target');
          send(target.ws, {
            t: S2C.PRIVATE_INFO,
            reason: payload.reason || 'storyteller',
            payload: payload.info,
          });
          break;
        }
        case 'auto_info': {
          // Compute and deliver ability-correct private info for a single player.
          // Response back to ST includes the generated text so they can review
          // or override. `payload.targets` is an array of player IDs used by
          // target-picking roles (Fortune Teller, Ravenkeeper).
          const info = engine.generateAutoInfo(g, payload.playerId, {
            targets: Array.isArray(payload.targets) ? payload.targets : [],
          });
          if (!info) {
            throw new Error('No auto-info available for this role/phase. The ST may need to pick a target first.');
          }
          const target = room.clients.get(payload.playerId);
          if (target) {
            send(target.ws, {
              t: S2C.PRIVATE_INFO,
              reason: payload.reason || 'auto',
              payload: info,
            });
          }
          // Echo to the requesting ST as a chat-style log entry so they can
          // see what was sent.
          const stWs = room.clients.get(room.game.storytellerId)?.ws;
          if (stWs) {
            send(stWs, {
              t: S2C.PRIVATE_INFO,
              reason: 'auto-echo',
              payload: { text: `[Auto-info sent to ${room.game.players.find(pp=>pp.id===payload.playerId)?.name || '?'}]\n${info.text}` },
            });
          }
          break;
        }
        case 'kick_player': {
          // Remove a seated player from the game. Useful when a player has
          // dropped their socket (tab closed, bad connection) and won't
          // reconnect — handleDisconnect keeps their record for resume, so
          // without an explicit kick the seat stays occupied indefinitely.
          const targetId = payload.playerId;
          if (!targetId) throw new Error('playerId required');
          if (targetId === g.storytellerId) throw new Error('Cannot kick the Storyteller');
          if (!g.players.find(pp => pp.id === targetId)) throw new Error('Unknown player');
          const targetEntry = room.clients.get(targetId);
          if (targetEntry) {
            send(targetEntry.ws, {
              t: S2C.ROOM_CLOSED,
              reason: 'You were removed from the game by the Storyteller.',
            });
          }
          const targetSession = clients.get(targetId);
          if (targetSession) targetSession.roomCode = null;
          room.clients.delete(targetId);
          engine.removePlayer(g, targetId);
          break;
        }
        case 'deliver_evil_team_info': {
          // First-night mass delivery to the whole evil team.
          const deliveries = engine.generateEvilTeamInfo(g);
          for (const d of deliveries) {
            const target = room.clients.get(d.playerId);
            if (target) {
              send(target.ws, {
                t: S2C.PRIVATE_INFO,
                reason: 'evil-team',
                payload: d.info,
              });
            }
          }
          const stWs = room.clients.get(room.game.storytellerId)?.ws;
          if (stWs) {
            send(stWs, {
              t: S2C.PRIVATE_INFO,
              reason: 'auto-echo',
              payload: { text: `[Evil team info delivered to ${deliveries.length} player${deliveries.length===1?'':'s'}]` },
            });
          }
          break;
        }
        default:
          throw new Error(`Unknown storyteller action: ${action}`);
      }
    }

    function handlePlayerAction(room, clientId, action, payload) {
      const g = room.game;
      switch (action) {
        case 'nominate':
          engine.openNomination(g, clientId, payload.nomineeId);
          break;
        case 'vote':
          engine.castVote(g, clientId, !!payload.yes);
          break;
        default:
          throw new Error(`Unknown player action: ${action}`);
      }
    }

    function broadcastRoomState(room) {
      // 1) Recompute voice channels from authoritative game state.
      const openWhispers = [...room.openWhispers].filter(pid => room.clients.has(pid));
      const voice = engine.computeVoiceChannels(room.game, openWhispers);
      room.voice = voice;

      // 2) Room state (per-client redaction) + per-client voice view.
      for (const [cid, { ws }] of room.clients.entries()) {
        const state = engine.redactedStateFor(room.game, cid);
        send(ws, { t: S2C.ROOM_STATE, room: { code: room.code }, state });
        send(ws, {
          t: S2C.VOICE_CHANNELS,
          channels: voice.channels,
          mine: voice.perClient[cid] || { channels: [], roleInChannel: {} },
        });
      }
    }

    function handleDisconnect(session) {
      const room = rooms.get(session.roomCode);
      if (room) {
        // Keep the player record in the game so they can RESUME into the same
        // seat if they reconnect within the grace period. Only drop the live
        // socket mapping.
        room.clients.delete(session.clientId);
        broadcastRoomState(room);
        if (room.clients.size === 0) scheduleRoomCleanup(room);
      }
      clients.delete(session.clientId);
    }
  });
}

function sanitizeName(s) {
  return String(s || '').replace(/\s+/g, ' ').trim().slice(0, 24) || 'Player';
}

function send(ws, obj) {
  try {
    ws.send(JSON.stringify({ v: PROTOCOL_VERSION, ...obj }));
  } catch (_) { /* socket may be closing */ }
}

async function stopServer(srv) {
  if (!srv) return;
  await srv.close();
}

// Minimal, dependency-free static file server. Serves files below `root`,
// rejects path traversal, falls back to index.html for `/`.
async function serveStatic(req, res, root) {
  // Strip query/hash and normalise.
  let rel = decodeURIComponent((req.url || '/').split('?')[0].split('#')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';
  // Resolve inside root and make sure we didn't escape (../ etc).
  const abs = path.normalize(path.join(root, rel));
  if (!abs.startsWith(path.normalize(root + path.sep)) && abs !== path.normalize(root)) {
    res.writeHead(403); return res.end('Forbidden');
  }
  let stat;
  try { stat = await fsp.stat(abs); }
  catch { res.writeHead(404); return res.end('Not Found'); }
  if (stat.isDirectory()) {
    res.writeHead(301, { Location: rel.endsWith('/') ? rel + 'index.html' : rel + '/index.html' });
    return res.end();
  }
  const ext = path.extname(abs).toLowerCase();
  const mime = MIME[ext];
  if (!mime) { res.writeHead(404); return res.end('Not Found'); }
  res.writeHead(200, {
    'Content-Type': mime,
    'Content-Length': stat.size,
    // Short cache so updates ship quickly during active development. Tune up
    // in production if you version asset URLs.
    'Cache-Control': 'public, max-age=60',
  });
  fs.createReadStream(abs).pipe(res);
}

module.exports = { startServer, stopServer };
