# Security Policy

## Supported versions

This project is pre-1.0 and ships from `main`. Only the latest release (and
unreleased `main`) receive security fixes.

## Reporting a vulnerability

**Do not open a public GitHub issue for security problems.** Please report
privately using one of:

- GitHub's private vulnerability reporting: **Security → Report a
  vulnerability** on the repository page, or
- Email the maintainer listed in `package.json` (`author` field).

Please include:

- A clear description of the issue and why it matters.
- Steps to reproduce (a minimal proof-of-concept is ideal).
- Affected versions / commits.
- Whether the issue has been disclosed elsewhere.

We aim to acknowledge reports within **72 hours** and provide a fix or a
mitigation plan within **14 days** for confirmed issues. Once a fix is
released we will credit you in the release notes (opt-out on request).

## Scope

In scope:

- The WebSocket signaling / game server (`src/main/server.js`,
  `src/main/server-standalone.js`).
- The Electron main and preload processes (`src/main/index.js`,
  `src/main/preload.js`).
- The bundled web client (`src/renderer/`).
- The Dockerfile and `docker/` configuration.

Out of scope:

- Issues requiring the attacker to already have Storyteller privileges in a
  room they were invited to (ST is a trusted role by design).
- Rate-limiting / abuse-prevention gaps in the signaling server — this is a
  small fan project, not a hardened public service. Run your own instance
  behind a proxy (Caddy, Cloudflare) if you need DDoS protection.
- Findings against third-party services you deployed yourself (Cloudflare
  Tunnel, coturn, your reverse proxy).

## Non-security bugs

Please use the regular **Bug report** issue template for functional bugs.
