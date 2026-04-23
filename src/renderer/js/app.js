// Renderer entry point. Wires lobby -> game transitions and global connection state.

(function () {
  const $ = (s) => document.querySelector(s);

  const app = {
    client: new BotcClient(),
    chatMessages: [],
  };

  // Surface connection state to the top bar
  function setConn(text, on) {
    const el = $('#connState');
    el.textContent = text;
    el.className = 'pill ' + (on ? 'pill-on' : 'pill-off');
  }

  function showRoomPill(code) {
    const el = $('#roomCode');
    el.textContent = code ? 'Room ' + code : '';
    el.classList.toggle('hidden', !code);
    syncLeaveButton();
  }

  // The topbar "Leave / Close" button reflects the viewer's role: the
  // Storyteller sees "Close room" (destroys the room for everyone), seated
  // players see "Leave room" (drop themselves).
  function syncLeaveButton() {
    const btn = $('#btnLeaveRoom');
    if (!btn) return;
    const inRoom = !!app.client.roomCode;
    btn.classList.toggle('hidden', !inRoom);
    if (!inRoom) return;
    const isSt = !!app.client.isSt;
    btn.textContent = isSt ? 'Close room' : 'Leave game';
    btn.title = isSt
      ? 'Close this room — kicks every player out and deletes the game.'
      : 'Leave the game and free your seat. You can rejoin from the lobby.';
  }

  $('#btnLeaveRoom')?.addEventListener('click', () => {
    if (!app.client.roomCode) return;
    const isSt = !!app.client.isSt;
    const ok = window.confirm(
      isSt
        ? 'Close this room? Every player will be kicked out and the game state will be deleted.'
        : 'Leave the game? Your seat will be freed for someone else.'
    );
    if (!ok) return;
    if (isSt) app.client.closeRoom();
    else      app.client.leaveRoom();
    // Server will confirm via close / room_closed; we also proactively reset
    // the UI so there's no lag.
    showRoomPill(null);
    swapToLobby();
  });

  function swapToGame() {
    $('#lobby').classList.add('hidden');
    $('#game').classList.remove('hidden');
    $('#panelToggles').style.display = '';   // revealed by CSS media query only when narrow
  }
  function swapToLobby() {
    $('#game').classList.add('hidden');
    $('#game').classList.remove('left-open', 'right-open');
    $('#lobby').classList.remove('hidden');
    $('#panelToggles').style.display = 'none';
  }

  // Side-panel drawer toggles (only do anything below ~1100px via CSS).
  const game = $('#game');
  $('#toggleLeft').addEventListener('click', () => {
    game.classList.toggle('left-open');
    game.classList.remove('right-open');
    syncToggleState();
  });
  $('#toggleRight').addEventListener('click', () => {
    game.classList.toggle('right-open');
    game.classList.remove('left-open');
    syncToggleState();
  });
  // Click the scrim (the ::before/::after pseudo) or press Esc to close.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      game.classList.remove('left-open', 'right-open');
      syncToggleState();
    }
  });
  // Clicking outside the drawer area closes it. We detect this by checking
  // that the click target isn't inside the drawer element or the toggle button.
  document.addEventListener('click', (e) => {
    if (game.classList.contains('hidden')) return;
    const inLeft  = e.target.closest('.game .left');
    const inRight = e.target.closest('.game .right');
    const onToggleL = e.target.closest('#toggleLeft');
    const onToggleR = e.target.closest('#toggleRight');
    if (game.classList.contains('left-open')  && !inLeft  && !onToggleL) game.classList.remove('left-open');
    if (game.classList.contains('right-open') && !inRight && !onToggleR) game.classList.remove('right-open');
    syncToggleState();
  }, true);

  function syncToggleState() {
    $('#toggleLeft').classList.toggle('active',  game.classList.contains('left-open'));
    $('#toggleRight').classList.toggle('active', game.classList.contains('right-open'));
  }

  // Start hidden; swapToGame reveals once a welcome message lands.
  $('#panelToggles').style.display = 'none';

  app.client.addEventListener('open',    () => setConn('connected', true));
  app.client.addEventListener('close',   () => { setConn('disconnected', false); showRoomPill(null); swapToLobby(); });
  app.client.addEventListener('error',   () => setConn('error', false));
  app.client.addEventListener('reconnecting', (ev) => {
    setConn(`reconnecting… (${ev.detail.attempt})`, false);
  });
  app.client.addEventListener('welcome', (ev) => {
    if (ev.detail?.room?.code) {
      showRoomPill(ev.detail.room.code);
      swapToGame();
    }
    syncLeaveButton();
  });
  app.client.addEventListener('servererror', (ev) => {
    console.error('Server error:', ev.detail);
    window.platform?.showError(ev.detail);
  });
  app.client.addEventListener('roomclosed', (ev) => {
    setConn('disconnected', false);
    showRoomPill(null);
    swapToLobby();
    window.platform?.showError(ev.detail?.reason || 'Room closed.');
  });

  initLobby(app);
  initGame(app);
  initVoiceUI(app);
  if (typeof window.initPhaseTransitions === 'function') initPhaseTransitions(app);
  if (typeof window.initAlmanac === 'function') initAlmanac();

  // Show version footer (works in Electron and web via the platform shim).
  window.platform?.appInfo().then(info => {
    $('#appVersion').textContent = `v${info.version} · ${info.platform} · ${info.hostname}`;
  });

  window.app = app;
})();
