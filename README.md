# BOTC Pro

An unofficial client for **Blood on the Clocktower**. Play on the **desktop**
(Electron build for macOS / Windows / Linux) or in any modern **web browser**
against a hosted server — the same renderer runs in both. Host a game on
your LAN with one click, or point at a hosted server for internet play. Ships
with the **Trouble Brewing** script (official beginner edition, 5–15 players)
and a full Storyteller + seated-player experience.

> Blood on the Clocktower is © The Pandemonium Institute. This is a fan-made
> tool, not affiliated with or endorsed by them. The MIT license covers only
> the code in this repository, not any Blood on the Clocktower intellectual
> property. Use responsibly and support the official game.

## Features (MVP)

- **Desktop + web** — the same client works as an Electron app and as a plain
  browser page. Players can join without installing anything; Storytellers
  who want the richer OS-level mic permission flow can use the desktop build.
- **One-click LAN host** — the Electron app runs an embedded WebSocket server
  on your machine; friends on the same Wi-Fi connect directly via desktop or
  browser.
- **Hosted / internet play** — run `src/main/server-standalone.js` on any
  Node 18+ host (a VPS, a Raspberry Pi, `ngrok`, etc.) and connect from any
  client via `ws://` / `wss://`, or open the same URL in a browser.
- **Room codes** — 5-character room codes, multiple concurrent games per server.
- **Storyteller mode** — grimoire view, seating circle, full role visibility, night-order reminder, kill/revive controls, private info delivery to individual players.
- **Player mode** — private role reveal, seating chart, one-click nominations, yes/no voting, dead-player ghost votes.
- **Trouble Brewing script** — all 22 core characters (13 Townsfolk, 4 Outsiders, 4 Minions, Imp), official setup distribution 5–15 players, Baron adjustment support.
- **Win conditions** — automatic checks for good-wins (no living demon), evil-wins (≤2 alive with demon), Saint-executed (evil wins).
- **Voice chat** — WebRTC mesh with team-aware channels:
  - **Table** (default): all living players speak, dead players and the ST listen.
  - **Evil team** (night only): Demon + Minions talk privately while the town sleeps.
  - **ST whisper**: 1:1 channel between Storyteller and a chosen player, opened from the ST voice panel.
  - Push-to-talk on **Space** by default; mute button and input-device picker in the Voice card.

## Quick start

### Desktop (Electron)

```bash
npm install
npm start            # launches the desktop app in dev mode
```

### Web / headless server

The standalone server serves the web client on the same port it uses for
WebSocket signaling:

```bash
node src/main/server-standalone.js --port 7878
# open http://localhost:7878/ in any modern browser, or
# point the desktop app at ws://<server-ip>:7878 from the Remote Server tab
```

Pass `--no-web` to run WebSocket-only (legacy headless mode).

### Run tests

```bash
npm test             # engine smoke tests (Node-only, no Electron needed)
```

## Hosting on the internet

The bundled server speaks plain WebSocket. To expose it safely:

1. Put it behind a TLS-terminating reverse proxy (Caddy / nginx) and point clients at `wss://your.domain`.
2. Or use a tunnel: `ngrok http 7878`, `cloudflared tunnel`, `tailscale serve`, etc.

There is no built-in auth — the room code is the only gate. Don't reuse codes across sessions.

## Docker deployment

The repository ships with a multi-stage `Dockerfile` and a `docker-compose.yml` that runs the headless server. The Electron desktop client is **not** containerised — players install it on their own machines and point it at the hosted server.

### Minimum: just the game server

```bash
docker compose up -d
```

This builds `botc-pro/server:latest` and exposes plain WebSocket on port `7878`. Override the host port with `BOTC_PORT=9000 docker compose up -d`. Point clients at `ws://<host>:7878`.

```bash
docker compose logs -f server     # tail logs
docker compose ps                 # health status
docker compose down               # stop
```

The server image runs as a non-root user (`botc`) and ships with a TCP
healthcheck. `node_modules` is installed with `--omit=dev`. The web client
(`src/renderer/`) is bundled into the image so players can open the tunnel
URL in a browser without installing the desktop app; if you want the old
WS-only container, start it with `CMD [..., "--no-web"]`.

### Expose from home without a static IP (Cloudflare Tunnel)

If you're hosting on a laptop, home PC, or Raspberry Pi, you almost certainly don't have a static public IP — and your ISP may even put you behind CGNAT, where port-forwarding doesn't work at all. Cloudflare Tunnel sidesteps the whole problem: it opens an outbound connection from the container to Cloudflare's edge, so players reach the server through `*.trycloudflare.com` or your own domain, with no open inbound ports.

**Quick tunnel (zero config, ephemeral URL)**:

```bash
docker compose --profile tunnel-quick up -d
docker compose logs -f cloudflared-quick
# look for a line like: https://random-words-1234.trycloudflare.com
```

Players connect with `wss://random-words-1234.trycloudflare.com` in the Remote Server tab. The URL changes every restart — fine for a one-off game.

**Named tunnel (permanent URL on your own domain)**:

1. Sign up for a free Cloudflare account and add a domain you own.
2. In the **Cloudflare Zero Trust** dashboard → **Networks → Tunnels**, create a tunnel and copy the install token.
3. Still in that tunnel's settings, open **Public Hostnames** and add a route:
   - **Subdomain / Hostname**: `botc.yourdomain.com`
   - **Service type**: `HTTP`
   - **URL**: `server:7878`
4. Create a `.env` file next to `docker-compose.yml` with the token:
   ```bash
   echo 'CLOUDFLARE_TUNNEL_TOKEN=eyJhIjoi...your-token-here' >> .env
   ```
5. Start it:
   ```bash
   docker compose --profile tunnel up -d
   ```

Players now connect with `wss://botc.yourdomain.com`, stable across restarts. Cloudflare handles TLS and DDoS protection for free.

Cloudflare Tunnel replaces the `tls` profile — don't run both at once, and you don't need to open ports 80/443 on your router.

### Add TLS (recommended for public internet)

Caddy is included as an optional service that terminates TLS with Let's Encrypt and proxies `wss://` to the server:

```bash
# Point a DNS A record for your domain at this machine, then:
BOTC_DOMAIN=botc.example.com docker compose --profile tls up -d
```

Clients now connect with `wss://botc.example.com` (no port needed). The Caddyfile lives at `docker/caddy/Caddyfile` if you want to tweak it.

### Add TURN (for symmetric-NAT voice)

Pure STUN fails for maybe 10–20% of peers depending on their network. Running a TURN server fixes that:

```bash
cp docker/coturn/turnserver.conf.example docker/coturn/turnserver.conf
# Edit realm, external-ip, and credentials in the new file.
docker compose --profile turn up -d
```

Then edit `src/renderer/js/voice.js` → `RTC_CONFIG.iceServers` and add:

```js
{
  urls: ["turn:turn.example.com:3478", "turn:turn.example.com:3478?transport=tcp"],
  username: "botc",
  credential: "the-secret-from-turnserver.conf",
}
```

TURN runs with `network_mode: host` because it needs a wide UDP port range for relaying media. Open `3478/udp`, `3478/tcp`, and the `min-port`–`max-port` range in `turnserver.conf` on your firewall.

### Everything together

```bash
BOTC_DOMAIN=botc.example.com docker compose --profile tls --profile turn up -d
```

Result: the server is reachable at `wss://botc.example.com`, players whose NAT blocks raw P2P audio transparently fall back to the TURN relay, and your machine runs no long-lived processes outside of Docker.

## How a game flows

1. The Storyteller clicks **Host LAN** (or **Remote Server** → **Create room on server**). They get a room code.
2. Players join using the host's LAN address + the code.
3. When 5+ players are seated, the ST clicks **Start game**. Roles are dealt according to the Trouble Brewing setup distribution.
4. **First night**: ST follows the night-order reminder in the bottom bar, clicks seats to deliver private info with *Deliver private info* (planned: dedicated per-role wizards).
5. **Day**: players discuss. Anyone alive can click a seat to nominate; alive players and dead players with ghost-votes cast YES / NO. ST resolves nominations; highest-above-threshold goes on the block. ST clicks **End Day** to execute whoever is on the block.
6. **Nights 2+** the ST applies the demon's kill via the kill dropdown and can mark additional deaths. Then **To Day**.
7. Good wins if the demon dies. Evil wins if only 2 players are alive and the demon is one of them, or if the Saint is executed.

## Trouble Brewing — character summary

**Townsfolk (good, 13):** Washerwoman, Librarian, Investigator, Chef, Empath, Fortune Teller, Undertaker, Monk, Ravenkeeper, Virgin, Slayer, Soldier, Mayor.

**Outsiders (good, 4):** Butler, Drunk, Recluse, Saint.

**Minions (evil, 4):** Poisoner, Spy, Scarlet Woman, Baron.

**Demon (evil, 1):** Imp.

Full ability text is visible in the right-hand panel inside the app and in `src/shared/data/trouble-brewing.js`.

### Setup distribution

| Players | Townsfolk | Outsiders | Minions | Demons |
|---|---|---|---|---|
| 5 | 3 | 0 | 1 | 1 |
| 6 | 3 | 1 | 1 | 1 |
| 7 | 5 | 0 | 1 | 1 |
| 8 | 5 | 1 | 1 | 1 |
| 9 | 5 | 2 | 1 | 1 |
| 10 | 7 | 0 | 2 | 1 |
| 11 | 7 | 1 | 2 | 1 |
| 12 | 7 | 2 | 2 | 1 |
| 13 | 9 | 0 | 3 | 1 |
| 14 | 9 | 1 | 3 | 1 |
| 15 | 9 | 2 | 3 | 1 |

The Baron minion, if in play, shifts this by +2 Outsiders / -2 Townsfolk.

### Night order (Trouble Brewing)

First night: Minion Info → Demon Info → Poisoner → Spy → Washerwoman → Librarian → Investigator → Chef → Empath → Fortune Teller → Butler.

Other nights: Poisoner → Monk → Spy → Scarlet Woman → Imp → Ravenkeeper (if killed) → Undertaker → Empath → Fortune Teller → Butler.

## Architecture

```
src/
  main/
    index.js             Electron main process, IPC, embedded server wiring
    preload.js           Context bridge for safe renderer APIs
    server.js            WebSocket server — rooms, routing, ST auth
    server-standalone.js Headless launcher for hosted deployments
  renderer/
    index.html           Lobby + game container
    styles.css
    js/
      client.js          WebSocket client, event emitter
      ui-lobby.js        Host / Join / Relay tabs
      ui-game.js         Seating circle, grimoire, log, chat, controls
      app.js             Orchestrates lobby <-> game transitions
  shared/
    protocol.js          Message type constants + version (incl. voice messages)
    game-engine.js       Pure game logic + computeVoiceChannels(game, openWhispers)
    data/
      trouble-brewing.js All 22 TB characters, setup table, night order
```

### Voice architecture

Audio is a WebRTC **mesh**: every pair of clients in the same voice channel opens a direct `RTCPeerConnection`. Signaling (SDP offers/answers and ICE candidates) is tunneled through the existing WebSocket server via `voice_signal` messages. The server never sees audio bytes — it only forwards envelopes between clients and refuses to route if the sender or recipient aren't members of the channel.

Channel membership is derived server-side from game state in `computeVoiceChannels`, so players can't self-promote themselves into the Evil channel by editing local JavaScript. A public STUN server is used for NAT traversal; for hard-NATed internet play you should configure a TURN server (e.g. coturn) in `src/renderer/js/voice.js` → `RTC_CONFIG`.

The server and the engine have **zero DOM dependencies**, so the same engine could later power offline / single-device play or automated tests.

## Packaging / Distribution

Players shouldn't need `npm install`. The repo is wired up with [electron-builder](https://www.electron.build/) to produce native installers for macOS, Windows, and Linux out of `build/` and `src/`.

### Build on your own machine

```bash
npm install                  # one-time; pulls Electron + electron-builder
npm run dist:mac             # .dmg + .zip   (arm64 + x64)
npm run dist:win             # .exe (NSIS) + portable .exe  (x64)
npm run dist:linux           # .AppImage + .deb  (x64)
npm run dist                 # try all three (only works on Linux + Docker or a mac with wine)
```

Artifacts land in `dist/` at the repo root. Typical outputs:

```
dist/
  BOTC Pro-0.1.0-arm64.dmg
  BOTC Pro-0.1.0.dmg
  BOTC Pro-0.1.0-arm64-mac.zip
  BOTC Pro Setup 0.1.0.exe
  BOTC Pro 0.1.0.exe                 # portable, no install
  BOTC Pro-0.1.0.AppImage
  botc-pro_0.1.0_amd64.deb
```

You can only build a given OS's installer on that OS (or inside a matching CI container). Building Windows installers from macOS is possible with `wine`/`mono`, but the easiest thing is to let GitHub Actions do it per-OS.

### Quick "just run it" without installing

```bash
npm install
npm run pack                 # unpacked app in dist/mac, dist/win-unpacked, or dist/linux-unpacked
```

`pack` skips installer generation — useful for smoke-testing a build before shipping.

### App identity

- `appId`: `id.ketok.botcpro`
- `productName`: `BOTC Pro`
- Icons live in `build/` (`icon.icns`, `icon.ico`, `icon.png`) and are re-generated from `build/icon.svg`.

### macOS — unsigned-app workarounds

The build is **not code-signed** (no Apple Developer account wired up). Gatekeeper will refuse to open it on first launch. Two ways to get past it:

1. **Right-click → Open** in Finder once, then click *Open* in the warning dialog. macOS remembers and lets you double-click from then on.
2. Or, from Terminal after copying to `/Applications`:
   ```bash
   xattr -cr "/Applications/BOTC Pro.app"
   ```
   This strips the `com.apple.quarantine` attribute Safari/Chrome added when you downloaded the `.dmg`.

If you ever want a signed + notarized build, add an Apple Developer ID, set `CSC_LINK` / `CSC_KEY_PASSWORD` env vars, and flip `hardenedRuntime: true` + add an `entitlements.mac.plist` — electron-builder's [signing docs](https://www.electron.build/code-signing) cover the rest.

### Windows — SmartScreen warning

Unsigned `.exe`s trigger the "Windows protected your PC" blue dialog on first launch. Click **More info → Run anyway**. To suppress it permanently you need an EV code-signing certificate (~$200/yr). Not worth it for a fan tool.

### Linux

- `.AppImage`: `chmod +x BOTC\ Pro-0.1.0.AppImage && ./BOTC\ Pro-0.1.0.AppImage`. No install required.
- `.deb`: `sudo apt install ./botc-pro_0.1.0_amd64.deb` on Debian/Ubuntu.

### What gets bundled

The `build.files` rules in `package.json` keep the installer lean: only `src/**`, `package.json`, and runtime `node_modules` go in. Everything Docker-related (`Dockerfile`, `docker/`, `docker-compose.yml`, `.dockerignore`, `.env*`) is excluded — those live only in the git repo for server operators.

## What's next

This is MVP scaffolding. Likely next steps:

- Per-role info wizards for the ST (Washerwoman / Librarian / Investigator pick-2, Chef pair count, etc.).
- Drag-to-rearrange seats in lobby.
- Reminder-token UI on the grimoire.
- Bad Moon Rising and Sects & Violets scripts.
- Custom script JSON import (Pandemonium Institute Script Tool format).
- Reconnect-with-seat-preserved when a client drops.
- Text-to-speech night calls for the ST.
- Auth / persistence if you want ranked or longer-running servers.

## Credits & sources

- Official game: [Blood on the Clocktower — Trouble Brewing](https://bloodontheclocktower.com/pages/trouble-brewing)
- Rules reference used while building:
  - [Blood on the Clocktower Wiki — Setup](https://wiki.bloodontheclocktower.com/Setup)
  - [Blood on the Clocktower Wiki — Trouble Brewing](https://wiki.bloodontheclocktower.com/Trouble_Brewing)
  - [Blood on the Clocktower Wiki — Character Types](https://wiki.bloodontheclocktower.com/Character_Types)
  - [Pocket Grimoire — TB character sheet](https://www.pocketgrimoire.co.uk/en_GB/sheet?name=Trouble+Brewing)
  - [Official Rulebook PDF](https://www.web3us.com/sites/default/files/Rulebook.pdf)

## Contributing

Issues and pull requests are welcome. Before opening a non-trivial PR, read
[CONTRIBUTING.md](./CONTRIBUTING.md) and open an issue so we can agree on the
approach. All participants are expected to follow the
[Code of Conduct](./CODE_OF_CONDUCT.md).

Please report security issues privately — see [SECURITY.md](./SECURITY.md).

## License

[MIT](./LICENSE), for the code in this repository. Game content, character
names, ability text, and artwork remain the property of The Pandemonium
Institute — the MIT license does not grant rights to any Blood on the
Clocktower intellectual property.
