// Phase-change overlay + chime. Listens on the BotcClient state stream and
// reacts when `state.phase` changes by:
//   1) fading a full-screen overlay in with the phase label
//   2) playing a short tone via the Web Audio API (no asset files needed)
//   3) fading out after ~1.5s
//
// Users can click the overlay to dismiss early. The first interaction with
// the page also unlocks the audio context — browsers block audio until a
// user gesture. If the game starts before any click, the first night chime
// will be silent but the visual still plays.

(function () {
  const OVERLAY_MS = 1500;

  const PHASE_LABEL = {
    lobby:        'Lobby',
    first_night:  'First Night',
    night:        'Night',
    day:          'Day',
    ended:        'Game Over',
  };

  const PHASE_SUBLABEL = {
    first_night: 'The town sleeps. Storyteller wakes roles in order.',
    night:       'The town sleeps again.',
    day:         'Discuss, accuse, and nominate.',
    ended:       null, // set per winner
  };

  // Simple two-note chimes. Each note is { frequency Hz, duration s, delay s }.
  const CHIMES = {
    first_night: [
      { f: 174.61, d: 0.6, t: 0.0, type: 'sine' },   // F3
      { f: 130.81, d: 0.9, t: 0.2, type: 'sine' },   // C3
    ],
    night: [
      { f: 196.00, d: 0.5, t: 0.0, type: 'sine' },   // G3
      { f: 146.83, d: 0.8, t: 0.15, type: 'sine' },  // D3
    ],
    day: [
      { f: 523.25, d: 0.25, t: 0.0, type: 'triangle' }, // C5
      { f: 659.26, d: 0.25, t: 0.15, type: 'triangle' }, // E5
      { f: 783.99, d: 0.45, t: 0.30, type: 'triangle' }, // G5
    ],
    ended: [
      { f: 523.25, d: 0.2, t: 0.0,  type: 'triangle' }, // C5
      { f: 659.26, d: 0.2, t: 0.2,  type: 'triangle' }, // E5
      { f: 783.99, d: 0.2, t: 0.4,  type: 'triangle' }, // G5
      { f: 1046.5, d: 0.5, t: 0.6,  type: 'triangle' }, // C6
    ],
  };

  let audioCtx = null;
  function getAudioCtx() {
    if (audioCtx) return audioCtx;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      audioCtx = new AC();
    } catch { return null; }
    return audioCtx;
  }
  // Resume ctx on first gesture — Chrome autoplay policy still applies inside Electron.
  const unlock = () => {
    const ctx = getAudioCtx();
    if (ctx && ctx.state === 'suspended') ctx.resume();
  };
  window.addEventListener('pointerdown', unlock, { once: false, capture: true });
  window.addEventListener('keydown', unlock, { once: false, capture: true });

  function playChime(phase) {
    const notes = CHIMES[phase];
    if (!notes) return;
    const ctx = getAudioCtx();
    if (!ctx || ctx.state === 'suspended') return;
    const now = ctx.currentTime;
    for (const n of notes) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = n.type || 'sine';
      osc.frequency.setValueAtTime(n.f, now + n.t);
      // ADSR-ish envelope to avoid clicks.
      gain.gain.setValueAtTime(0, now + n.t);
      gain.gain.linearRampToValueAtTime(0.28, now + n.t + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.001, now + n.t + n.d);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + n.t);
      osc.stop(now + n.t + n.d + 0.05);
    }
  }

  // Full-screen overlay — injected on demand, removed after its fade finishes.
  function showOverlay(state) {
    // Cancel any overlay mid-animation.
    document.querySelectorAll('.phase-overlay').forEach(n => n.remove());
    const ov = document.createElement('div');
    ov.className = 'phase-overlay';
    ov.dataset.phase = state.phase;

    const big   = PHASE_LABEL[state.phase] || state.phase;
    const suffix = state.dayNumber
      ? (state.phase === 'first_night' ? ' 1'
         : state.phase === 'night' ? ` ${state.dayNumber + 1}`
         : state.phase === 'day' ? ` ${state.dayNumber}`
         : '')
      : '';
    let sub = PHASE_SUBLABEL[state.phase] || '';
    if (state.phase === 'ended' && state.winner) {
      sub = state.winner === 'good' ? 'Good has prevailed.' : 'Evil has won.';
    }

    ov.innerHTML = `
      <div class="phase-overlay-inner">
        <div class="phase-overlay-big">${big}${suffix}</div>
        ${sub ? `<div class="phase-overlay-sub">${sub}</div>` : ''}
      </div>`;
    ov.addEventListener('click', () => ov.classList.add('fading'));
    document.body.appendChild(ov);

    // Trigger fade-in next tick.
    requestAnimationFrame(() => ov.classList.add('active'));

    // Auto-dismiss.
    setTimeout(() => ov.classList.add('fading'), OVERLAY_MS);
    setTimeout(() => { if (ov.parentNode) ov.remove(); }, OVERLAY_MS + 450);
  }

  // Watch for phase changes.
  let lastPhase = null;
  let lastDay = null;
  let lastWinner = null;
  function onState(state) {
    if (!state) return;
    const transitioned =
      (state.phase !== lastPhase) ||
      (state.phase === 'day'   && state.dayNumber !== lastDay) ||
      (state.phase === 'night' && state.dayNumber !== lastDay) ||
      (state.phase === 'ended' && state.winner && state.winner !== lastWinner);

    // Suppress the lobby "announcement" — nothing dramatic about opening the app.
    // Also suppress first render (lastPhase is null) unless phase is already past lobby.
    const firstRender = lastPhase === null;
    const suppress = (firstRender && state.phase === 'lobby') || state.phase === 'lobby';

    if (transitioned && !suppress) {
      showOverlay(state);
      playChime(state.phase);
    }
    lastPhase = state.phase;
    lastDay = state.dayNumber;
    lastWinner = state.winner;
  }

  window.initPhaseTransitions = function (app) {
    app.client.addEventListener('state', (ev) => onState(ev.detail));
  };
})();
