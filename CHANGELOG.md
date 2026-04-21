# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Web client: the standalone server now serves `src/renderer/` over HTTP on
  the same port as the WebSocket signaling endpoint, so players can join
  from any browser without installing the desktop app.
- Settings modal with microphone permission status, device picker, and a
  live input-level meter. Works on both desktop and web.
- Startup microphone-permission check. On Windows the app explains how to
  enable access in Privacy & Security; on macOS it triggers the native OS
  prompt.
- Storyteller can close a room (kicks every player out and deletes the game).
  A player leaving a room no longer drops everyone; an ST leaving still
  closes the room because the game can't continue without one.
- Platform shim (`src/renderer/js/platform.js`) so the same renderer runs in
  Electron and the browser.

### Fixed

- Voice chat: audio doubling when the Storyteller opened a whisper with a
  player. Peer connections are now keyed per remote peer instead of per
  (channel, peer), so a shared whisper and table channel no longer produce
  two concurrent RTCPeerConnections between the same pair.

## [0.1.0] - 2026-04-01

Initial release.

### Added

- Electron desktop client for Blood on the Clocktower.
- Embedded WebSocket signaling / game server; one-click LAN hosting.
- Standalone headless server (`src/main/server-standalone.js`) for hosted
  internet play.
- Trouble Brewing script: 13 Townsfolk, 4 Outsiders, 4 Minions, Imp; official
  setup distribution for 5–15 players.
- Storyteller grimoire: seating circle, full role visibility, night-order
  reminder, kill/revive controls, private info delivery, reminder tokens.
- Seated-player view: private role reveal, nomination/voting, ghost votes.
- Voice chat (WebRTC mesh) with team-aware channels: Table, Evil Team
  (night only), and 1:1 ST ↔ player Whisper.
- Docker Compose stack with optional Caddy (TLS), coturn (TURN), and
  Cloudflare Tunnel profiles.
