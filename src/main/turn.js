// Cloudflare Realtime TURN helper.
//
// Mints short-lived ICE server credentials from the Cloudflare Realtime API
// and hands them to clients via the WebSocket welcome flow. The long-lived
// API token stays on the server; only the ephemeral username/credential
// ever reach browsers.
//
// Configure with env vars:
//   CF_TURN_TOKEN_ID   — the TURN app's Token ID (public-ish identifier)
//   CF_TURN_API_TOKEN  — the API token (secret)
//   CF_TURN_TTL        — optional, seconds; default 86400 (24h)
//
// When the env vars are absent, getIceServers() resolves to null so the
// client falls back to its built-in public STUN list.

const API_BASE = 'https://rtc.live.cloudflare.com/v1/turn/keys';
const REFRESH_MARGIN_MS = 10 * 60 * 1000; // refresh 10 min before expiry
// Connection-setup blocks on this mint, so a hung fetch would hang the
// client's initial WELCOME. 3s is plenty for Cloudflare's API and keeps
// the worst case well under user-perceptible latency.
const MINT_TIMEOUT_MS = 3000;

let cache = null; // { iceServers, expiresAt }
let inflight = null;

function isConfigured() {
  return !!(process.env.CF_TURN_TOKEN_ID && process.env.CF_TURN_API_TOKEN);
}

async function mint() {
  const tokenId = process.env.CF_TURN_TOKEN_ID;
  const apiToken = process.env.CF_TURN_API_TOKEN;
  const ttl = Number(process.env.CF_TURN_TTL) || 86400;

  const res = await fetch(`${API_BASE}/${tokenId}/credentials/generate`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ttl }),
    signal: AbortSignal.timeout(MINT_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Cloudflare TURN mint failed: HTTP ${res.status} ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  // Cloudflare returns `iceServers` as a single object; RTCPeerConnection
  // expects an array, so wrap it.
  const server = data.iceServers;
  if (!server || !server.urls) throw new Error('Cloudflare TURN response missing iceServers');
  return {
    iceServers: [server],
    expiresAt: Date.now() + ttl * 1000,
  };
}

// Returns an array suitable for RTCConfiguration.iceServers, or null if
// Cloudflare TURN is not configured / mint failed.
async function getIceServers() {
  if (!isConfigured()) return null;
  const now = Date.now();
  if (cache && cache.expiresAt - now > REFRESH_MARGIN_MS) {
    return cache.iceServers;
  }
  if (!inflight) {
    inflight = mint()
      .then(fresh => { cache = fresh; return fresh.iceServers; })
      .catch(err => { console.warn('[botc-pro]', err.message); return null; })
      .finally(() => { inflight = null; });
  }
  return inflight;
}

module.exports = { getIceServers, isConfigured };
