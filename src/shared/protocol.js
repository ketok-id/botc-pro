// Wire protocol — tiny, versioned, JSON messages over WebSocket.
// Every message is: { v: 1, t: "<type>", ... }
// Client -> Server types and Server -> Client types are both listed here.

const PROTOCOL_VERSION = 1;

const C2S = {
  HELLO:            'hello',         // { name }
  CREATE_ROOM:      'create_room',   // { name, script }
  JOIN_ROOM:        'join_room',     // { name, code }
  RESUME:           'resume',        // { clientId, code, name } — re-attach to an existing player after a drop
  LEAVE_ROOM:       'leave_room',
  CLOSE_ROOM:       'close_room',    // ST-only: tear the whole room down
  CHAT:             'chat',          // { text }
  ST_ACTION:        'st_action',     // { action, payload }   (storyteller-only actions)
  PLAYER_ACTION:    'player_action', // { action, payload }   (in-seat actions)
  PING:             'ping',
  // --- Voice ---
  VOICE_SIGNAL:     'voice_signal',  // { to, channelId, sdp? | ice? }  (relayed peer-to-peer via server)
  VOICE_MIC:        'voice_mic',     // { channelId, talking: bool }    (talking indicator broadcast)
  VOICE_WHISPER:    'voice_whisper', // ST-only: { open: bool, playerId }
};

const S2C = {
  WELCOME:          'welcome',       // { clientId, version }
  ROOM_STATE:       'room_state',    // full redacted state for this viewer
  PRIVATE_INFO:     'private_info',  // { reason, payload } — night info etc, visible only to you
  CHAT:             'chat',          // { from, text, ts }
  ERROR:            'error',         // { message }
  ROOM_CLOSED:      'room_closed',   // { reason } — room destroyed; client should return to lobby
  PONG:             'pong',
  // --- Voice ---
  VOICE_CHANNELS:   'voice_channels',// { channels:{id:{id,label,speakers,listeners}}, mine:{channels,roleInChannel} }
  VOICE_SIGNAL:     'voice_signal',  // { from, channelId, sdp? | ice? }
  VOICE_MIC:        'voice_mic',     // { from, channelId, talking }
};

const PHASES = {
  LOBBY:        'lobby',
  FIRST_NIGHT:  'first_night',
  DAY:          'day',
  NIGHT:        'night',
  ENDED:        'ended',
};

module.exports = { PROTOCOL_VERSION, C2S, S2C, PHASES };
