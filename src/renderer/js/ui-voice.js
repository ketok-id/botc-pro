// Voice panel UI — renders a compact card listing channels, members, talking
// indicators, and a push-to-talk hint. The ST also gets a whisper picker.

(function () {
  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }

  function render(app) {
    const mount = document.getElementById('voice-panel');
    if (!mount) return;

    const v = app.voice;
    const state = app.client.state;
    const channels = v.channels || {};
    const mine = v.mine || { channels: [], roleInChannel: {} };
    const me = state?.players?.find(p => p.id === app.client.clientId);
    const isSt = !!me?.isSt;

    const nameOf = (id) => state?.players?.find(p => p.id === id)?.name || '…';

    const enabled = !!v.localStream;
    const ptt = v.ptt;
    const muted = v.muted;
    const talking = v.talking;

    // Channel blocks
    const chBlocks = mine.channels.map((id) => {
      const ch = channels[id];
      if (!ch) return '';
      const role = mine.roleInChannel[id];
      const members = [...new Set([...ch.speakers, ...ch.listeners])];
      const rows = members.map(pid => {
        const isSpeaker = ch.speakers.includes(pid);
        const talkingNow = v.isRemoteTalking(id, pid) || (pid === app.client.clientId && talking && role === 'speak');
        const mark = isSpeaker ? '🎙' : '🎧';
        const cls = (talkingNow ? 'talking' : '') + (pid === app.client.clientId ? ' me' : '');
        return `<li class="${cls}"><span>${mark}</span> ${escapeHtml(nameOf(pid))}</li>`;
      }).join('');
      return `<div class="voice-ch">
        <div class="voice-ch-head">
          <span class="voice-ch-name">${escapeHtml(ch.label || id)}</span>
          <span class="voice-ch-role">${role === 'speak' ? 'speak' : 'listen'}</span>
        </div>
        <ul class="voice-members">${rows}</ul>
      </div>`;
    }).join('');

    // Controls
    const deviceOpts = (v.devices || []).map(d => {
      const selected = d.deviceId === v.selectedDeviceId ? 'selected' : '';
      return `<option value="${escapeHtml(d.deviceId)}" ${selected}>${escapeHtml(d.label || 'Microphone')}</option>`;
    }).join('');

    mount.innerHTML = `
      <h4>Voice ${enabled ? `<span class="pill ${muted ? 'pill-off' : 'pill-on'}" style="float:right;font-weight:400">${muted ? 'muted' : (ptt ? (talking ? 'transmitting' : 'ready') : 'open')}</span>` : ''}</h4>
      ${enabled ? `
        <div class="voice-controls">
          <button data-act="mute" class="${muted ? 'primary' : ''}">${muted ? 'Unmute' : 'Mute'}</button>
          <label class="voice-ptt">
            <input type="checkbox" ${ptt ? 'checked' : ''} data-act="ptt" />
            Push-to-talk <span class="kbd">Space</span>
          </label>
          ${v.devices && v.devices.length ? `
            <select data-act="device" title="Microphone">${deviceOpts}</select>
          ` : ''}
        </div>
        ${chBlocks || '<div class="muted" style="font-size:12px">No active channels yet.</div>'}
        ${isSt ? whisperPicker(state) : ''}
      ` : `
        <div class="muted" style="font-size:12px;margin-bottom:8px">
          Voice chat is off. Your mic won't transmit until you turn it on.
        </div>
        <button data-act="enable" class="primary">Enable microphone</button>
      `}
    `;

    mount.querySelectorAll('[data-act]').forEach(el => {
      const act = el.dataset.act;
      if (act === 'enable') el.addEventListener('click', () => onEnable(app));
      if (act === 'mute') el.addEventListener('click', () => { app.voice.setMuted(!app.voice.muted); render(app); });
      if (act === 'ptt')  el.addEventListener('change', () => { app.voice.setPtt(el.checked); render(app); });
      if (act === 'device') el.addEventListener('change', () => onDevice(app, el.value));
      if (act === 'whisper-open')  el.addEventListener('click', () => { app.client.send({ t: 'voice_whisper', playerId: el.dataset.pid, open: true }); });
      if (act === 'whisper-close') el.addEventListener('click', () => { app.client.send({ t: 'voice_whisper', playerId: el.dataset.pid, open: false }); });
    });
  }

  function whisperPicker(state) {
    const open = Object.keys(state ? {} : {});
    // Extract open whispers from current channels instead:
    const seated = state.players.filter(p => !p.isSt);
    const openIds = Object.keys(window.app?.voice?.channels || {})
      .filter(id => id.startsWith('whisper:'))
      .map(id => id.slice('whisper:'.length));
    const rows = seated.map(p => {
      const on = openIds.includes(p.id);
      return `<div class="whisper-row">
        <span>${escapeHtml(p.name)}</span>
        <button data-act="${on ? 'whisper-close' : 'whisper-open'}" data-pid="${p.id}">
          ${on ? 'End whisper' : 'Whisper'}
        </button>
      </div>`;
    }).join('');
    return `<div class="whisper-picker">
      <div class="voice-ch-name" style="margin-top:10px">ST whispers</div>
      ${rows || '<div class="muted" style="font-size:12px">No players.</div>'}
    </div>`;
  }

  async function onEnable(app) {
    try {
      const devices = await app.voice.listDevices();
      app.voice.devices = devices;
      await app.voice.enable(devices[0]?.deviceId || null);
      // Re-enumerate with labels now that permission was granted.
      app.voice.devices = await app.voice.listDevices();
      render(app);
    } catch (err) {
      // Most common cause on Windows: OS-level mic privacy is off. Push users
      // straight into the Settings modal where they can open Windows settings.
      if (window.botcSettings?.open) {
        try { await window.botcSettings.open(); } catch {}
      } else {
        const m = 'Could not access microphone: ' + (err?.message || err);
        window.platform?.showError(m);
      }
    }
  }

  async function onDevice(app, deviceId) {
    try { await app.voice.switchDevice(deviceId); render(app); }
    catch (err) { console.warn(err); }
  }

  window.initVoiceUI = function (app) {
    if (!window.VoiceManager) return;
    window.wireVoiceEvents(app.client);
    app.voice = new VoiceManager(app.client);

    app.voice.addEventListener('channels', () => render(app));
    app.voice.addEventListener('remotemic', () => render(app));
    app.voice.addEventListener('ptt',       () => render(app));
    app.voice.addEventListener('enabled',   () => render(app));
    app.client.addEventListener('state',    () => render(app));

    render(app);
  };
})();
