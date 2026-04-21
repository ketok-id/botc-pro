// Settings modal: OS microphone permission + device picker + live level meter.
//
// The OS mic-permission state (Windows/macOS) is the #1 reason audio silently
// fails to transmit even though getUserMedia "succeeds" on an earlier Chromium
// build. We surface it here with a direct link to the OS settings page.

(function () {
  const LS_DEVICE_KEY = 'botc.mic.deviceId';
  const LS_BANNER_DISMISSED = 'botc.mic.bannerDismissedForStatus';

  const state = {
    osStatus: 'unknown',   // granted | denied | restricted | not-determined | unknown
    platform: 'unknown',
    devices: [],
    selectedDeviceId: null,
    testStream: null,
    audioCtx: null,
    analyser: null,
    rafId: null,
  };

  function $(s, root = document) { return root.querySelector(s); }

  function statusPillClass(s) {
    if (s === 'granted') return 'pill-on';
    if (s === 'denied' || s === 'restricted') return 'pill-off';
    return '';
  }
  function statusLabel(s) {
    switch (s) {
      case 'granted': return 'granted';
      case 'denied': return 'blocked by OS';
      case 'restricted': return 'restricted by OS';
      case 'not-determined': return 'not yet requested';
      default: return 'unknown';
    }
  }

  async function refreshStatus() {
    if (!window.platform?.micStatus) return;
    try {
      const r = await window.platform.micStatus();
      state.osStatus = r.status || 'unknown';
      state.platform = r.platform || 'unknown';
    } catch { /* ignore */ }
  }

  async function refreshDevices() {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      state.devices = all.filter(d => d.kind === 'audioinput');
      const saved = localStorage.getItem(LS_DEVICE_KEY);
      if (saved && state.devices.some(d => d.deviceId === saved)) {
        state.selectedDeviceId = saved;
      } else if (!state.selectedDeviceId && state.devices[0]) {
        state.selectedDeviceId = state.devices[0].deviceId;
      }
    } catch { /* ignore */ }
  }

  function stopTest() {
    if (state.rafId) cancelAnimationFrame(state.rafId);
    state.rafId = null;
    if (state.testStream) {
      for (const t of state.testStream.getTracks()) t.stop();
      state.testStream = null;
    }
    if (state.audioCtx && state.audioCtx.state !== 'closed') {
      state.audioCtx.close().catch(() => {});
    }
    state.audioCtx = null;
    state.analyser = null;
  }

  async function startTest() {
    stopTest();
    try {
      const constraints = {
        audio: {
          deviceId: state.selectedDeviceId ? { exact: state.selectedDeviceId } : undefined,
          echoCancellation: true, noiseSuppression: true, autoGainControl: true,
        },
        video: false,
      };
      state.testStream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      // getUserMedia failed -- re-check status; on Windows this usually means
      // the OS-level permission is off.
      await refreshStatus();
      render();
      const msg = 'Could not open microphone: ' + (err?.message || err);
      window.platform?.showError(msg);
      return;
    }
    // Refresh device labels now that we have permission.
    await refreshDevices();
    await refreshStatus();

    const AC = window.AudioContext || window.webkitAudioContext;
    state.audioCtx = new AC();
    const src = state.audioCtx.createMediaStreamSource(state.testStream);
    state.analyser = state.audioCtx.createAnalyser();
    state.analyser.fftSize = 512;
    src.connect(state.analyser);

    const buf = new Uint8Array(state.analyser.fftSize);
    const bar = $('#micLevelBar');
    const tick = () => {
      if (!state.analyser || !bar) return;
      state.analyser.getByteTimeDomainData(buf);
      let peak = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = Math.abs(buf[i] - 128);
        if (v > peak) peak = v;
      }
      const pct = Math.min(100, Math.round((peak / 128) * 140));
      bar.style.width = pct + '%';
      bar.classList.toggle('hot', pct > 80);
      state.rafId = requestAnimationFrame(tick);
    };
    tick();
    render();
  }

  function render() {
    const body = $('#settingsBody');
    if (!body) return;

    const showAsk = state.osStatus === 'not-determined' || state.osStatus === 'denied';
    const settingsLabel =
      state.platform === 'win32' ? 'Open Windows Settings' :
      state.platform === 'darwin' ? 'Open System Settings' :
      state.platform === 'web' ? 'How to allow access' :
      'Open System Settings';

    const osBox = `
      <section class="settings-section">
        <h3>Microphone access <span class="pill ${statusPillClass(state.osStatus)}" style="float:right">${statusLabel(state.osStatus)}</span></h3>
        ${renderPermissionHelp()}
        <div class="settings-row">
          ${showAsk && (state.platform === 'darwin' || state.platform === 'web') ?
            `<button id="btnAskMic" class="primary">Request access</button>` : ''}
          <button id="btnOpenMicSettings">${settingsLabel}</button>
          <button id="btnRecheck">Re-check</button>
        </div>
      </section>
    `;

    const deviceOpts = state.devices.map(d => {
      const sel = d.deviceId === state.selectedDeviceId ? 'selected' : '';
      const label = d.label || `Microphone (${d.deviceId.slice(0, 6)}…)`;
      return `<option value="${d.deviceId}" ${sel}>${escapeHtml(label)}</option>`;
    }).join('') || '<option value="">(no input devices found)</option>';

    const deviceBox = `
      <section class="settings-section">
        <h3>Input device</h3>
        <label>Microphone
          <select id="micDevice">${deviceOpts}</select>
        </label>
        <p class="muted" style="font-size:12px;margin-top:4px">
          Labels show only after you grant permission once.
        </p>
        <div class="settings-row">
          <button id="btnMicTest" class="${state.testStream ? '' : 'primary'}">${state.testStream ? 'Stop test' : 'Test microphone'}</button>
        </div>
        <div class="mic-meter" aria-hidden="true"><div id="micLevelBar" class="mic-meter-bar"></div></div>
        <p class="muted" style="font-size:12px;margin-top:4px">
          Speak at a normal volume — the bar should fill at least halfway.
          Nothing moving? Your OS is likely still blocking access.
        </p>
      </section>
    `;

    const voiceBox = renderVoicePrefs();

    body.innerHTML = osBox + deviceBox + voiceBox;

    // Wire up
    const q = (s) => body.querySelector(s);
    q('#btnAskMic')?.addEventListener('click', async () => {
      try { await window.platform.askMic(); } catch {}
      await refreshStatus();
      render();
    });
    q('#btnOpenMicSettings')?.addEventListener('click', async () => {
      try { await window.platform.openMicSettings(); } catch {}
    });
    q('#btnRecheck')?.addEventListener('click', async () => {
      await refreshStatus();
      await refreshDevices();
      render();
    });
    q('#micDevice')?.addEventListener('change', async (ev) => {
      state.selectedDeviceId = ev.target.value || null;
      if (state.selectedDeviceId) localStorage.setItem(LS_DEVICE_KEY, state.selectedDeviceId);
      if (window.app?.voice?.localStream && state.selectedDeviceId) {
        try { await window.app.voice.switchDevice(state.selectedDeviceId); } catch {}
      }
      if (state.testStream) await startTest(); // re-open on new device
    });
    q('#btnMicTest')?.addEventListener('click', async () => {
      if (state.testStream) { stopTest(); render(); }
      else await startTest();
    });
    wireVoicePrefs(body);
  }

  function renderPermissionHelp() {
    if (state.osStatus === 'granted') {
      return `<p class="muted" style="font-size:13px">
        Your OS is allowing microphone access for this app. If voice still isn't
        transmitting, check the device below and the Voice panel in-game.
      </p>`;
    }
    if (state.platform === 'win32') {
      return `<div class="help-box">
        <p><b>Windows is blocking the microphone.</b> Open
           <i>Settings → Privacy &amp; security → Microphone</i> and make sure:</p>
        <ol>
          <li><b>Microphone access</b> is <b>On</b></li>
          <li><b>Let desktop apps access your microphone</b> is <b>On</b></li>
          <li>Restart BOTC Pro after changing the setting.</li>
        </ol>
      </div>`;
    }
    if (state.platform === 'darwin') {
      return `<div class="help-box">
        <p><b>macOS is blocking the microphone.</b> Open
           <i>System Settings → Privacy &amp; Security → Microphone</i> and toggle
           BOTC Pro on. You may need to restart the app.</p>
      </div>`;
    }
    if (state.platform === 'web') {
      return `<div class="help-box">
        <p><b>Your browser is blocking the microphone for this site.</b>
           Click the lock / tune icon in the address bar, open <i>Site settings</i>
           (or <i>Permissions</i>), set <b>Microphone</b> to <i>Allow</i>, then
           reload the page.</p>
      </div>`;
    }
    return `<p class="muted" style="font-size:13px">
      The OS is reporting microphone access is not available. Check your system
      privacy settings, then click Re-check.
    </p>`;
  }

  function renderVoicePrefs() {
    const v = window.app?.voice;
    if (!v) return '';
    return `
      <section class="settings-section">
        <h3>Voice chat preferences</h3>
        <label class="settings-check">
          <input type="checkbox" id="prefPtt" ${v.ptt ? 'checked' : ''} />
          Push-to-talk (hold <span class="kbd">Space</span>)
        </label>
        <label class="settings-check">
          <input type="checkbox" id="prefMuted" ${v.muted ? 'checked' : ''} />
          Start muted
        </label>
      </section>
    `;
  }

  function wireVoicePrefs(root) {
    const v = window.app?.voice;
    if (!v) return;
    root.querySelector('#prefPtt')?.addEventListener('change', (ev) => v.setPtt(ev.target.checked));
    root.querySelector('#prefMuted')?.addEventListener('change', (ev) => v.setMuted(ev.target.checked));
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }

  async function open() {
    await refreshStatus();
    await refreshDevices();
    $('#settingsOverlay')?.classList.remove('hidden');
    $('#settingsOverlay')?.setAttribute('aria-hidden', 'false');
    render();
  }

  function close() {
    stopTest();
    $('#settingsOverlay')?.classList.add('hidden');
    $('#settingsOverlay')?.setAttribute('aria-hidden', 'true');
  }

  function renderBanner() {
    const el = $('#micBanner');
    if (!el) return;
    const bad = state.osStatus === 'denied' || state.osStatus === 'restricted';
    const dismissed = localStorage.getItem(LS_BANNER_DISMISSED) === state.osStatus;
    if (!bad || dismissed) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    const where = state.platform === 'win32' ? 'Windows Settings' : 'System Settings';
    el.innerHTML = `
      <span><b>Microphone blocked by the OS.</b> Voice chat won't transmit until you enable it in ${where}.</span>
      <span class="spacer"></span>
      <button class="primary" id="bannerSettings">Fix it</button>
      <button id="bannerDismiss" aria-label="Dismiss">✕</button>
    `;
    $('#bannerSettings')?.addEventListener('click', () => open());
    $('#bannerDismiss')?.addEventListener('click', () => {
      localStorage.setItem(LS_BANNER_DISMISSED, state.osStatus);
      el.classList.add('hidden');
    });
  }

  async function boot() {
    await refreshStatus();
    // enumerate without triggering a permission prompt; labels will be blank
    // until the user grants access, which is fine for the banner decision.
    try { state.devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput'); } catch {}
    renderBanner();
  }

  // Public wiring
  document.addEventListener('DOMContentLoaded', () => {
    $('#btnSettings')?.addEventListener('click', () => open());
    $('#settingsClose')?.addEventListener('click', () => close());
    $('#settingsOverlay')?.addEventListener('click', (ev) => {
      if (ev.target.id === 'settingsOverlay') close();
    });
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && !$('#settingsOverlay')?.classList.contains('hidden')) close();
    });
    boot();
  });

  window.botcSettings = { open, close, refreshStatus };
})();
