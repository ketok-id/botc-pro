// Runtime platform shim.
//
// The renderer runs in TWO environments:
//   * Electron desktop   — preload exposes `window.botc.*` (mic permission
//                          queries, system dialogs, local-server spawning).
//   * Plain web browser  — served over HTTP(S) from the same Node server that
//                          handles WebSockets. No preload. Uses browser APIs.
//
// Every caller should go through `window.platform` instead of touching
// `window.botc` directly, so the same UI works in both environments.

(function () {
  const isElectron = !!(window.botc && typeof window.botc.appInfo === 'function');

  // Default WS URL for the browser build: the current origin, upgraded to wss
  // when the page itself is https. Leaves an obvious fallback for local dev
  // over http://.
  function defaultServerUrl() {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${window.location.host}`;
  }

  async function appInfo() {
    if (isElectron) return window.botc.appInfo();
    return {
      version: 'web',
      platform: navigator.platform || 'web',
      hostname: window.location.host,
      interfaces: [],
    };
  }

  function showError(msg) {
    if (isElectron) return window.botc.showError(msg);
    alert(msg);
  }

  async function micStatus() {
    if (isElectron) return window.botc.micStatus();
    // Browser: use the Permissions API where available. Chromium + Firefox
    // support `microphone`; Safari reports 'denied' before the first prompt.
    let status = 'not-determined';
    try {
      if (navigator.permissions?.query) {
        const r = await navigator.permissions.query({ name: 'microphone' });
        // 'prompt' maps to Electron's 'not-determined'.
        status = r.state === 'prompt' ? 'not-determined' : r.state;
      }
    } catch { /* ignore — Safari throws for some names */ }
    return { platform: 'web', status };
  }

  async function askMic() {
    if (isElectron) return window.botc.askMic();
    // The browser prompt fires on the first getUserMedia call — do that now
    // and immediately release the track.
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      for (const t of s.getTracks()) t.stop();
      return { granted: true, status: 'granted' };
    } catch (err) {
      return { granted: false, status: 'denied', error: err?.message || String(err) };
    }
  }

  function openMicSettings() {
    if (isElectron) return window.botc.openMicSettings();
    // No cross-browser API to deep-link into site permissions. Show the user
    // where to click instead.
    alert(
      'To change microphone access for this site:\n\n' +
      '  • Click the lock/tune icon in the address bar\n' +
      '  • Open "Site settings" or "Permissions"\n' +
      '  • Allow the Microphone permission\n\n' +
      'Then reload the page.'
    );
    return Promise.resolve();
  }

  // Desktop-only embedded server controls. Web returns a sensible "not here".
  async function startLocalServer(opts) {
    if (isElectron) return window.botc.startServer(opts);
    return { ok: false, error: 'Hosting a local server requires the desktop app.' };
  }
  async function stopLocalServer() {
    if (isElectron) return window.botc.stopServer();
    return { ok: true };
  }

  window.platform = {
    isElectron,
    isWeb: !isElectron,
    defaultServerUrl,
    appInfo,
    showError,
    micStatus,
    askMic,
    openMicSettings,
    startLocalServer,
    stopLocalServer,
  };
})();
