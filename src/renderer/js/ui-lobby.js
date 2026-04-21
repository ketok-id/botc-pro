// Lobby UI: host LAN, join, connect to remote relay.

(function () {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  function initTabs() {
    $$('.tab').forEach(t => t.addEventListener('click', () => {
      $$('.tab').forEach(x => x.classList.remove('active'));
      t.classList.add('active');
      $$('.tabbody').forEach(x => x.classList.add('hidden'));
      $(`.tabbody[data-tab="${t.dataset.tab}"]`).classList.remove('active');
      $(`.tabbody[data-tab="${t.dataset.tab}"]`).classList.remove('hidden');
    }));
  }

  async function onHost(app) {
    const name = $('#hostName').value.trim() || 'Storyteller';
    const port = parseInt($('#hostPort').value, 10) || 0;
    if (!window.platform?.isElectron) {
      showError('Hosting requires the Electron desktop app (server runs in the main process).');
      return;
    }
    const info = await window.platform.startLocalServer({ port, bind: '0.0.0.0' });
    if (!info.ok) { showError(info.error || 'Failed to start server'); return; }
    const addr = (info.lan && info.lan[0] && info.lan[0].address) || 'localhost';
    const url = `ws://127.0.0.1:${info.port}`;
    $('#hostInfo').classList.remove('hidden');
    $('#hostInfo').innerHTML = `
      <div>Server running on port <code>${info.port}</code>.</div>
      <div>LAN players connect to <code>ws://${addr}:${info.port}</code></div>
      <div class="muted" style="margin-top:6px">You'll be the Storyteller.</div>
    `;
    try {
      await app.client.connect(url);
      app.client.createRoom(name);
    } catch (err) {
      showError(err.message);
    }
  }

  async function onJoin(app) {
    const name = $('#joinName').value.trim() || 'Player';
    const host = $('#joinHost').value.trim();
    const code = $('#joinCode').value.trim().toUpperCase();
    if (!host || !code) return showError('Host address and room code are required.');
    const url = host.startsWith('ws') ? host : `ws://${host}`;
    try {
      await app.client.connect(url);
      app.client.joinRoom(name, code);
    } catch (err) { showError(err.message); }
  }

  async function onRelayHost(app) {
    const name = $('#relayName').value.trim() || 'Storyteller';
    const url = $('#relayUrl').value.trim();
    if (!url) return showError('Server URL required.');
    try {
      await app.client.connect(url);
      app.client.createRoom(name);
    } catch (err) { showError(err.message); }
  }

  async function onRelayJoin(app) {
    const name = $('#relayName').value.trim() || 'Player';
    const url = $('#relayUrl').value.trim();
    const code = $('#relayCode').value.trim().toUpperCase();
    if (!url || !code) return showError('Server URL and room code required.');
    try {
      await app.client.connect(url);
      app.client.joinRoom(name, code);
    } catch (err) { showError(err.message); }
  }

  function showError(msg) {
    console.error(msg);
    window.platform?.showError(msg);
  }

  // Web users can't spawn a local server, so Host-LAN and the raw-IP Join
  // tab aren't meaningful. Hide them and point everyone at the Remote Server
  // tab, which we auto-fill with the page's own origin. Desktop users keep
  // every tab.
  function applyPlatformLobby(app) {
    if (window.platform?.isElectron) return;

    const hostTabBtn  = document.querySelector('.tab[data-tab="host"]');
    const joinTabBtn  = document.querySelector('.tab[data-tab="join"]');
    const relayTabBtn = document.querySelector('.tab[data-tab="relay"]');
    const hostBody    = document.querySelector('.tabbody[data-tab="host"]');
    const joinBody    = document.querySelector('.tabbody[data-tab="join"]');
    const relayBody   = document.querySelector('.tabbody[data-tab="relay"]');
    hostTabBtn?.classList.add('hidden');
    joinTabBtn?.classList.add('hidden');
    hostBody?.classList.add('hidden');
    joinBody?.classList.add('hidden');

    // Relay tab becomes the default and is renamed to something more
    // intuitive for the web experience.
    relayTabBtn?.classList.add('active');
    relayBody?.classList.remove('hidden');
    if (relayTabBtn) relayTabBtn.textContent = 'Play';

    // Prefill the server URL with the current origin (wss://<host>). The user
    // is *already* connected to the server — that's how they loaded the page.
    const urlInput = $('#relayUrl');
    if (urlInput && !urlInput.value) urlInput.value = window.platform.defaultServerUrl();

    // The Remote tab's copy assumes a tech-savvy desktop user. Simplify.
    const blurb = relayBody?.querySelector('p.muted');
    if (blurb) {
      blurb.innerHTML =
        'You’re connected to <code>' + window.location.host + '</code>. ' +
        'Create a new room to be the Storyteller, or join an existing one with a room code.';
    }
  }

  window.initLobby = function (app) {
    initTabs();
    applyPlatformLobby(app);
    $('#btnHost').addEventListener('click', () => onHost(app));
    $('#btnJoin').addEventListener('click', () => onJoin(app));
    $('#btnRelayHost').addEventListener('click', () => onRelayHost(app));
    $('#btnRelayJoin').addEventListener('click', () => onRelayJoin(app));
  };
})();
