# Contributing to BOTC Pro

Thanks for your interest in improving BOTC Pro. This project is fan-made and
MIT-licensed; contributions of any size are welcome.

By participating you agree to abide by the [Code of Conduct](./CODE_OF_CONDUCT.md).

## Before you open a PR

- **Small fixes** (typos, obvious bugs, doc wording): open a PR directly.
- **Larger changes** (new script, protocol change, voice/WebRTC rework, new UI
  surface): open an issue first so we can agree on the approach. A good issue
  describes the problem, the proposed direction, and any alternatives you
  considered.
- **Rule or role accuracy** changes must cite the official Blood on the
  Clocktower rulebook or an authoritative clarification — this project tries
  to match official behaviour.

## Development setup

```bash
git clone <your-fork>
cd botc-pro
npm install
```

Running the app:

```bash
npm start                                   # Electron desktop app (dev)
node src/main/server-standalone.js          # headless server (web + ws on :7878)
```

The standalone server also serves the web client. Open
`http://localhost:7878/` in a browser to use the web build.

Docker (matches the production image):

```bash
docker compose build server
docker compose up -d server
```

## Running tests

```bash
node test-st-qol.js
```

The test script exits non-zero if any assertion fails. Add new assertions when
fixing a bug or adding a feature so it doesn't regress.

## Code style

There is no enforced linter yet. In the meantime:

- Keep comments explaining *why*, not *what*. Well-named identifiers should
  handle the *what*.
- Prefer editing existing files over adding new ones. Follow the structure of
  the file you're editing.
- No unprompted refactors — if you see something unrelated that could be
  improved, open a separate PR or issue.
- No new runtime dependencies without discussion. The desktop + server images
  are deliberately small.

## Commit + PR

- One logical change per PR. Small, reviewable diffs merge faster.
- Commit messages: imperative mood, a short subject line, optional body
  explaining motivation (*why*, not *what*).
- Include a short **Test plan** in the PR description: what you ran, what you
  clicked, and what you expected.
- If the change is user-visible, add an entry under `## [Unreleased]` in
  [CHANGELOG.md](./CHANGELOG.md).

## Security issues

Do NOT open a public issue for security vulnerabilities. See
[SECURITY.md](./SECURITY.md) for the private disclosure path.

## License of your contributions

By submitting a pull request you agree that your contribution is licensed
under the same [MIT License](./LICENSE) as the rest of the project.
