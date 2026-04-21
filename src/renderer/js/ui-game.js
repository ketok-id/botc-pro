// Game UI: renders the seating circle, a role panel, log, chat, and controls
// that adapt to whether the viewer is the Storyteller or a seated player.
//
// Visuals:
//   - Seats use SVG character tokens from window.Tokens (tokens.js).
//     Storyteller sees every seat's token; players see their own token and
//     generic "unknown" discs for everyone else.
//   - Reminder tokens (Storyteller-only) render as small chips clustered
//     beneath each seat. ST can add/remove them from a popover bar.
//   - The right-hand panel includes a clickable night-order list during
//     night phases; clicking a row briefly pulses every matching seat.

(function () {
  const $ = (s, r = document) => r.querySelector(s);

  // TB data mirrored client-side for rendering. Keep in sync with src/shared/data/trouble-brewing.js.
  const TB_CHARS = {
    washerwoman:   { name: 'Washerwoman',   team: 'townsfolk', ability: 'You start knowing that 1 of 2 players is a particular Townsfolk.' },
    librarian:     { name: 'Librarian',     team: 'townsfolk', ability: 'You start knowing that 1 of 2 players is a particular Outsider. (Or that zero are in play.)' },
    investigator:  { name: 'Investigator',  team: 'townsfolk', ability: 'You start knowing that 1 of 2 players is a particular Minion.' },
    chef:          { name: 'Chef',          team: 'townsfolk', ability: 'You start knowing how many pairs of evil players there are.' },
    empath:        { name: 'Empath',        team: 'townsfolk', ability: 'Each night, you learn how many of your 2 alive neighbours are evil.' },
    fortuneteller: { name: 'Fortune Teller',team: 'townsfolk', ability: 'Each night, choose 2 players: you learn if either is a Demon. There is 1 good player that registers as a Demon to you.' },
    undertaker:    { name: 'Undertaker',    team: 'townsfolk', ability: 'Each night*, you learn which character died by execution today.' },
    monk:          { name: 'Monk',          team: 'townsfolk', ability: 'Each night*, choose a player (not yourself): they are safe from the Demon tonight.' },
    ravenkeeper:   { name: 'Ravenkeeper',   team: 'townsfolk', ability: 'If you die at night, you are woken to choose a player: you learn their character.' },
    virgin:        { name: 'Virgin',        team: 'townsfolk', ability: 'The 1st time you are nominated, if the nominator is a Townsfolk, they are executed immediately.' },
    slayer:        { name: 'Slayer',        team: 'townsfolk', ability: 'Once per game, during the day, publicly choose a player: if they are the Demon, they die.' },
    soldier:       { name: 'Soldier',       team: 'townsfolk', ability: 'You are safe from the Demon.' },
    mayor:         { name: 'Mayor',         team: 'townsfolk', ability: 'If only 3 players live & no execution occurs, your team wins. If you die at night, another player might die instead.' },
    butler:        { name: 'Butler',        team: 'outsider',  ability: 'Each night, choose a player (not yourself): tomorrow, you may only vote if they are voting too.' },
    drunk:         { name: 'Drunk',         team: 'outsider',  ability: 'You do not know you are the Drunk. You think you are a Townsfolk, but you are not.' },
    recluse:       { name: 'Recluse',       team: 'outsider',  ability: 'You might register as evil & as a Minion or Demon, even if dead.' },
    saint:         { name: 'Saint',         team: 'outsider',  ability: 'If you die by execution, your team loses.' },
    poisoner:      { name: 'Poisoner',      team: 'minion',    ability: 'Each night, choose a player: they are poisoned tonight and tomorrow day.' },
    spy:           { name: 'Spy',           team: 'minion',    ability: 'Each night, you see the Grimoire. You might register as good & as a Townsfolk or Outsider, even if dead.' },
    scarletwoman:  { name: 'Scarlet Woman', team: 'minion',    ability: 'If there are 5+ players alive & the Demon dies, you become the Demon.' },
    baron:         { name: 'Baron',         team: 'minion',    ability: '[+2 Outsiders]' },
    imp:           { name: 'Imp',           team: 'demon',     ability: 'Each night*, choose a player: they die. If you kill yourself, a Minion becomes the Imp.' },
  };

  let app = null;
  let selectedSeatId = null;      // Which seat the ST currently has focused.
  let reminderPickerFor = null;   // Non-null when the reminder picker is open for a seat.
  // When non-null the ST is in "pick targets for auto-info" mode (Fortune Teller,
  // Ravenkeeper). Shape: { playerId, role, needed, picks: [playerId, ...] }.
  // Clicks on seats populate `picks`; when `picks.length === needed` the auto_info
  // action is dispatched and this is cleared.
  let autoInfoPickMode = null;

  function render() {
    const state = app.client.state;
    const root = $('#game');
    root.innerHTML = '';
    if (!state) return;

    // If pick mode is active but the underlying player or phase no longer
    // supports it (e.g. phase advanced, player removed), bail out cleanly so
    // seats don't stay stuck in pick-candidate styling.
    if (autoInfoPickMode) {
      const srcPlayer = state.players.find(pp => pp.id === autoInfoPickMode.playerId);
      const stillValid = srcPlayer
        && srcPlayer.character === autoInfoPickMode.role
        && canAutoInfo(state, srcPlayer);
      if (!stillValid) autoInfoPickMode = null;
    }

    root.appendChild(leftPanel(state));
    root.appendChild(boardPanel(state));
    root.appendChild(rightPanel(state));
    root.appendChild(bottomControls(state));
  }

  // ---------- Left panel ----------
  function leftPanel(state) {
    const el = div('left');
    el.appendChild(phaseCard(state));
    el.appendChild(myRoleCard(state));
    const voice = div('card');
    voice.id = 'voice-panel';
    el.appendChild(voice);
    el.appendChild(chatCard(state));
    return el;
  }

  function phaseCard(state) {
    const c = div('card');
    c.innerHTML = `<h4>Status</h4>
      <div style="display:flex;align-items:center;gap:8px">
        <span class="phase-pill phase-${state.phase}">${labelForPhase(state.phase)}${state.dayNumber ? ' · Day '+state.dayNumber : ''}</span>
        ${state.winner ? `<span class="pill ${state.winner==='good'?'pill-on':'pill-off'}">${state.winner.toUpperCase()} WINS</span>` : ''}
      </div>
      <div class="muted" style="margin-top:6px;font-size:12px">
        Room <b>${app.client.roomCode ?? ''}</b> · ${state.players.filter(p=>!p.isSt).length} seated
      </div>`;
    return c;
  }

  function myRoleCard(state) {
    const me = state.players.find(p => p.id === app.client.clientId);
    if (!me) return div();
    if (me.isSt) {
      const c = div('card');
      c.innerHTML = `<h4>You are the Storyteller</h4>
        <div class="muted" style="font-size:12px">You see every seat's role and run the night phase. Click a seat to manage it.</div>`;
      return c;
    }
    if (!me.character) {
      const c = div('card');
      c.innerHTML = `<h4>Waiting for game to start</h4>
        <div class="muted" style="font-size:12px">The Storyteller will deal roles when everyone is seated.</div>`;
      return c;
    }
    const ch = TB_CHARS[me.character] || { name: me.character, team: '?', ability: '' };
    const c = div('myrole');
    c.innerHTML = `
      <div class="myrole-token" data-almanac-role="${escapeHtml(me.character)}" tabindex="0">${window.Tokens.tokenSvg(me.character, { dead: !me.alive })}</div>
      <div class="team team-${me.team || ch.team}">${ch.team.toUpperCase()}</div>
      <div class="name">${ch.name}</div>
      <div class="ability">${ch.ability}</div>
      ${!me.alive ? '<div class="muted" style="margin-top:8px">You are dead. You keep 1 ghost vote.</div>' : ''}
    `;
    return c;
  }

  function chatCard(state) {
    const c = div('card chat');
    c.innerHTML = `<h4>Chat</h4>
      <div class="chatlog" id="chatlog"></div>
      <form class="chatinput" id="chatform">
        <input id="chatinput" placeholder="Say something..." autocomplete="off" />
        <button class="primary">Send</button>
      </form>`;
    // repopulate from app-level chat buffer
    const log = c.querySelector('#chatlog');
    for (const m of (app.chatMessages || [])) {
      const line = document.createElement('div');
      line.className = 'msg';
      line.innerHTML = `<b>${escapeHtml(m.from)}:</b> ${escapeHtml(m.text)}`;
      log.appendChild(line);
    }
    log.scrollTop = log.scrollHeight;
    c.querySelector('#chatform').addEventListener('submit', (ev) => {
      ev.preventDefault();
      const input = c.querySelector('#chatinput');
      const txt = input.value.trim();
      if (!txt) return;
      app.client.chat(txt);
      input.value = '';
    });
    return c;
  }

  // ---------- Board (seating circle) ----------
  function boardPanel(state) {
    const el = div('board');
    const me = state.players.find(p => p.id === app.client.clientId);
    const isSt = !!me?.isSt;
    const seated = state.players.filter(p => !p.isSt).sort((a,b)=>a.seat - b.seat);
    const n = seated.length;
    const seats = div('seats');
    for (let i = 0; i < n; i++) {
      const p = seated[i];
      const angle = (-Math.PI / 2) + (i / n) * Math.PI * 2;
      const rx = 44, ry = 40; // % of container
      const x = 50 + Math.cos(angle) * rx;
      const y = 50 + Math.sin(angle) * ry;
      const seat = document.createElement('div');
      seat.className = 'seat';
      seat.dataset.seatId = p.id;
      if (p.character) seat.dataset.role = p.character;
      if (!p.alive) seat.classList.add('dead');
      if (p.id === app.client.clientId) seat.classList.add('me');
      if (state.currentNomination?.nominee === p.id) seat.classList.add('nominee');
      if (state.onTheBlock === p.id) seat.classList.add('on-block');
      if (selectedSeatId === p.id) seat.classList.add('selected');
      if (p.poisoned) seat.classList.add('poisoned');
      if (autoInfoPickMode) {
        if (autoInfoPickMode.picks.includes(p.id)) seat.classList.add('pick-selected');
        else seat.classList.add('pick-candidate');
      }
      seat.style.left = x + '%';
      seat.style.top = y + '%';

      // Build the seat body: token + name label + (ST-only) reminder chips.
      const showToken = !!p.character && (isSt || p.id === app.client.clientId || state.phase === 'ended');
      const tokenSvg = showToken
        ? window.Tokens.tokenSvg(p.character, {
            dead: !p.alive,
            showOrder: isSt && (state.phase === 'first_night' || state.phase === 'night'),
            firstNight: state.phase === 'first_night',
          })
        : window.Tokens.unknownTokenSvg({ dead: !p.alive });

      const reminderChips = (isSt && p.reminders && p.reminders.length)
        ? `<div class="reminders">` + p.reminders.map(r => {
            const sourceMeta = r.roleSource ? window.Tokens.TOKEN_META[r.roleSource] : null;
            const teamCls = sourceMeta ? `team-${sourceMeta.team}` : '';
            return `<span class="reminder-chip ${teamCls}" title="From ${escapeHtml(sourceMeta?.name || 'Custom')} · click to remove"
                          data-rid="${escapeHtml(r.id)}" data-seat="${escapeHtml(p.id)}">
                      ${escapeHtml(r.text)}<span class="x">×</span>
                    </span>`;
          }).join('') + `</div>`
        : '';

      const tokenAlmanacAttr = showToken && p.character
        ? ` data-almanac-role="${escapeHtml(p.character)}"`
        : '';
      seat.innerHTML = `
        <div class="token"${tokenAlmanacAttr}>${tokenSvg}</div>
        <div class="label">${escapeHtml(p.name)}${!p.alive && p.ghostVote ? ' <span class="ghost-dot" title="Ghost vote available">·</span>' : ''}</div>
        ${reminderChips}
      `;
      seat.addEventListener('click', (ev) => {
        // Reminder chip? Let its own handler manage removal.
        if (ev.target.closest('.reminder-chip')) return;
        selectedSeatId = p.id;
        onSeatClick(state, p);
      });
      seats.appendChild(seat);
    }
    el.appendChild(seats);

    // Wire reminder-chip removal as delegated clicks.
    seats.addEventListener('click', (ev) => {
      const chip = ev.target.closest('.reminder-chip');
      if (!chip) return;
      ev.stopPropagation();
      const seatId = chip.dataset.seat, rid = chip.dataset.rid;
      app.client.st('remove_reminder', { playerId: seatId, reminderId: rid });
    });

    // Center overlays
    const center = document.createElement('div');
    center.style.position = 'absolute';
    center.style.top = '50%'; center.style.left = '50%';
    center.style.transform = 'translate(-50%, -50%)';
    center.style.textAlign = 'center';
    center.style.pointerEvents = 'none';  // don't block seat clicks underneath

    if (autoInfoPickMode && isSt) {
      // ST is mid-pick for an auto-info role — show a directive banner and
      // a Cancel escape hatch. Clicks on seats are handled by onSeatClick.
      const forPlayer = state.players.find(pp => pp.id === autoInfoPickMode.playerId);
      const roleMeta = window.Tokens.TOKEN_META[autoInfoPickMode.role];
      const pickNames = autoInfoPickMode.picks
        .map(id => state.players.find(pp => pp.id === id)?.name)
        .filter(Boolean);
      const remaining = autoInfoPickMode.needed - autoInfoPickMode.picks.length;
      center.style.pointerEvents = 'auto';
      center.innerHTML = `
        <div class="pick-banner">
          <div class="pick-title">Pick ${autoInfoPickMode.needed} target${autoInfoPickMode.needed===1?'':'s'} for ${escapeHtml(roleMeta?.name || autoInfoPickMode.role)}</div>
          <div class="pick-sub">${escapeHtml(forPlayer?.name || '?')} — ${remaining} more to pick</div>
          ${pickNames.length ? `<div class="pick-sub">Chosen: ${pickNames.map(escapeHtml).join(', ')}</div>` : ''}
          <button id="pickCancel" class="btn">Cancel</button>
        </div>`;
      // Wire cancel after innerHTML replaces children.
      setTimeout(() => {
        const c = document.getElementById('pickCancel');
        if (c) c.addEventListener('click', () => { autoInfoPickMode = null; render(); });
      }, 0);
    } else if (state.phase === 'lobby') {
      center.innerHTML = `<div class="muted" style="font-size:14px">${n} player${n===1?'':'s'} seated · waiting for Storyteller to start</div>`;
    } else if (state.currentNomination) {
      const nor = state.players.find(p => p.id === state.currentNomination.nominator);
      const nee = state.players.find(p => p.id === state.currentNomination.nominee);
      const votesYes = state.currentNomination.votes.filter(v => v.yes).length;
      center.style.pointerEvents = 'auto';
      center.innerHTML = nominationWidget(state, me, nor, nee, votesYes);
    } else if (state.phase === 'day') {
      center.innerHTML = `<div class="muted">Day ${state.dayNumber} · discuss, then nominate</div>`;
    } else if (state.phase === 'night' || state.phase === 'first_night') {
      center.innerHTML = `<div class="muted">The town sleeps...</div>`;
    } else if (state.phase === 'ended' && state.winner) {
      center.innerHTML = `<div style="font-size:32px;color:var(--accent)">${state.winner.toUpperCase()} WINS</div>`;
    }
    el.appendChild(center);
    return el;
  }

  function nominationWidget(state, me, nor, nee, yesCount) {
    if (!me) return '';
    const canVote = me.alive || me.ghostVote;
    const myVote = state.currentNomination.votes.find(v => v.voter === me.id);
    const have = myVote ? (myVote.yes ? 'YES' : 'NO') : '—';
    return `
      <div class="nomwidget">
        <div class="who">${escapeHtml(nor.name)} → ${escapeHtml(nee.name)}</div>
        <div class="votes">${yesCount} vote${yesCount===1?'':'s'} · your vote: ${have}</div>
        ${canVote && !me.isSt ? `
          <div class="vote-actions">
            <button onclick="window._vote(true)">Vote YES</button>
            <button onclick="window._vote(false)">Vote NO</button>
          </div>` : ''}
      </div>`;
  }

  window._vote = (yes) => app.client.playerAction('vote', { yes });

  function onSeatClick(state, p) {
    const me = state.players.find(pp => pp.id === app.client.clientId);
    if (!me) return;
    if (me.isSt) {
      // If the ST is in auto-info pick mode (Fortune Teller / Ravenkeeper),
      // route the click into the target list instead of re-selecting seats.
      if (autoInfoPickMode) {
        const mode = autoInfoPickMode;
        const idx = mode.picks.indexOf(p.id);
        if (idx >= 0) {
          mode.picks.splice(idx, 1);
        } else if (mode.picks.length < mode.needed) {
          mode.picks.push(p.id);
        }
        // When the ST has picked enough targets, dispatch and clear.
        if (mode.picks.length === mode.needed) {
          const { playerId, picks } = mode;
          autoInfoPickMode = null;
          app.client.st('auto_info', { playerId, targets: picks });
        }
        render();
        return;
      }
      // ST: re-render so the newly selected seat picks up the .selected class,
      // and so the bottom control strip shows reminder/kill tools for it.
      reminderPickerFor = null;
      render();
      return;
    }
    // Player can nominate during day if alive and not already nominated
    if (state.phase === 'day' && me.alive && !state.currentNomination) {
      if (confirm(`Nominate ${p.name}?`)) {
        app.client.playerAction('nominate', { nomineeId: p.id });
      }
    }
  }

  // ---------- Right panel ----------
  function rightPanel(state) {
    const el = div('right');
    const me = state.players.find(p => p.id === app.client.clientId);
    const isSt = !!me?.isSt;
    if (isSt && state.phase !== 'lobby' && state.phase !== 'ended') {
      el.appendChild(nightOrderPanel(state));
    }
    if (hasAnyVotes(state)) {
      el.appendChild(voteHistoryPanel(state));
    }
    el.appendChild(scriptPanel(state));
    el.appendChild(logPanel(state));
    return el;
  }

  function hasAnyVotes(state) {
    if (state.nominations && state.nominations.length > 0) return true;
    if (state.voteHistory && state.voteHistory.length > 0) return true;
    return false;
  }

  // Vote history: today's live nominations on top, then past days in reverse
  // order. Each nomination shows tally (yes/threshold), and the list of who
  // voted yes. Votes are public in BOTC so this is visible to everyone.
  function voteHistoryPanel(state) {
    const c = div('card vote-history');
    const nameOf = (id) => {
      const pp = state.players.find(p => p.id === id);
      return pp ? pp.name : '?';
    };
    const pstrip = (votes) => {
      const yesVotes = votes.filter(v => v.yes === true);
      if (yesVotes.length === 0) return '<span class="muted">no yes votes</span>';
      return yesVotes.map(v => `<span class="vh-voter">${escapeHtml(nameOf(v.voter))}</span>`).join(' ');
    };
    const renderNom = (n, { live = false } = {}) => {
      const tallyTxt = n.resolved
        ? `${n.yesCount ?? 0}/${n.threshold ?? '?'}`
        : (live ? `${(n.votes||[]).filter(v=>v.yes===true).length} so far` : '—');
      const pass = n.resolved && n.yesCount != null && n.threshold != null && n.yesCount >= n.threshold;
      const cls = live ? 'live' : (pass ? 'passed' : 'nope');
      return `
        <div class="vh-row ${cls}">
          <div class="vh-head">
            <span class="vh-nor">${escapeHtml(nameOf(n.nominator))}</span>
            <span class="vh-arrow">→</span>
            <span class="vh-nee">${escapeHtml(nameOf(n.nominee))}</span>
            <span class="vh-tally">${tallyTxt}</span>
          </div>
          <div class="vh-votes">${pstrip(n.votes || [])}</div>
        </div>`;
    };

    const sections = [];
    const today = state.nominations || [];
    if (today.length > 0) {
      const header = state.phase === 'day'
        ? `Day ${state.dayNumber} (today)`
        : `Day ${state.dayNumber}`;
      sections.push(`<div class="vh-day"><div class="vh-day-head">${escapeHtml(header)}</div>${today.map(n => renderNom(n, { live: !n.resolved })).join('')}</div>`);
    }

    const past = (state.voteHistory || []).slice().reverse();
    for (const d of past) {
      const exec = d.executed ? ` · executed: ${escapeHtml(charName(d.executed))}` : ' · no execution';
      sections.push(`<div class="vh-day past">
        <div class="vh-day-head">Day ${d.day}${exec}</div>
        ${d.nominations.map(n => renderNom(n)).join('')}
      </div>`);
    }

    c.innerHTML = `<h4>Vote history</h4>${sections.join('') || '<div class="muted">No nominations yet.</div>'}`;
    return c;
  }

  function charName(id) {
    if (window.Tokens && window.Tokens.TOKEN_META && window.Tokens.TOKEN_META[id]) {
      return window.Tokens.TOKEN_META[id].name;
    }
    return id || '—';
  }

  // Clickable night-order list shown to the Storyteller. Pulses matching
  // seats when a row is clicked so the ST can find the right player.
  function nightOrderPanel(state) {
    const c = div('card night-order');
    const firstNight = state.phase === 'first_night';
    const inPlayIds = state.players.filter(p => p.character).map(p => p.character);
    const entries = window.Tokens.nightOrder({ firstNight, inPlayRoleIds: inPlayIds });
    const rows = entries.map(({ id, order, meta, inPlay }) => {
      const isPseudo = !window.Tokens.TOKEN_META[id];
      const teamCls = isPseudo ? '' : `team-${meta.team}`;
      const dim = isPseudo ? '' : (inPlay ? '' : 'dim');
      const dotSrc = (!isPseudo && inPlay) ? state.players.find(p => p.character === id) : null;
      return `
        <div class="no-row ${teamCls} ${dim}" data-role="${escapeHtml(id)}" data-pseudo="${isPseudo ? '1' : '0'}"
             data-almanac-role="${escapeHtml(id)}">
          <div class="no-order">${order === 99 ? '—' : order}</div>
          <div class="no-symbol">${meta.symbol}</div>
          <div class="no-body">
            <div class="no-name">${escapeHtml(meta.name)}${inPlay && dotSrc ? ` <span class="muted">· ${escapeHtml(dotSrc.name)}</span>` : ''}</div>
            ${isPseudo
              ? `<div class="no-ability muted">${escapeHtml(meta.note || '')}</div>`
              : `<div class="no-ability muted">${escapeHtml((TB_CHARS[id] || {}).ability || '')}</div>`}
          </div>
        </div>`;
    }).join('');
    c.innerHTML = `<h4>Night order · ${firstNight ? 'First night' : 'Other nights'}</h4>
                   <div class="no-list">${rows || '<div class="muted">No roles act tonight.</div>'}</div>`;
    // Click to pulse matching seats.
    c.querySelector('.no-list').addEventListener('click', (ev) => {
      const row = ev.target.closest('.no-row');
      if (!row) return;
      const role = row.dataset.role;
      if (row.dataset.pseudo === '1') return;
      document.querySelectorAll(`.seat[data-role="${CSS.escape(role)}"]`).forEach(seat => {
        seat.classList.remove('pulsing');
        // force reflow so the animation can restart
        void seat.offsetWidth;
        seat.classList.add('pulsing');
      });
    });
    return c;
  }

  function scriptPanel(state) {
    const c = div('card');
    const active = Object.keys(TB_CHARS);
    const rows = active.map(id => {
      const ch = TB_CHARS[id];
      const cls = ch.team === 'townsfolk' ? 'tf'
               : ch.team === 'outsider'  ? 'out'
               : ch.team === 'minion'    ? 'min' : 'dem';
      const inPlay = state.players.some(p => p.character === id);
      return `<div class="charrow ${cls}" data-almanac-role="${escapeHtml(id)}" tabindex="0" style="opacity:${inPlay?1:0.55}">
        <span>${ch.name}${inPlay?' ●':''}</span>
        <span class="muted">${ch.team}</span>
      </div>`;
    }).join('');
    c.innerHTML = `<h4>Trouble Brewing</h4>
      <div class="charlist">${rows}</div>`;
    return c;
  }

  function logPanel(state) {
    const c = div('card');
    const lines = (state.log || []).slice(-25).map(l => `<div class="line">${escapeHtml(l.text)}</div>`).join('');
    c.innerHTML = `<h4>Game Log</h4><div class="log">${lines}</div>`;
    return c;
  }

  // ---------- Bottom controls ----------
  function bottomControls(state) {
    const el = div('bottom');
    const me = state.players.find(p => p.id === app.client.clientId);
    if (!me) return el;

    if (me.isSt) {
      el.appendChild(storytellerControls(state));
    } else {
      el.appendChild(playerControls(state, me));
    }
    return el;
  }

  function storytellerControls(state) {
    const wrap = div('controls');

    // When a seat is selected, show seat-specific actions before phase actions.
    const sel = state.players.find(p => p.id === selectedSeatId && !p.isSt);
    if (sel && state.phase !== 'lobby' && state.phase !== 'ended') {
      wrap.appendChild(selectedSeatStrip(state, sel));
    }

    if (state.phase === 'lobby') {
      const n = state.players.filter(p => !p.isSt).length;
      const btn = button('Start game', 'primary');
      if (n < 5) btn.disabled = true;
      btn.title = n < 5 ? `Need at least 5 seated players (have ${n})` : '';
      btn.addEventListener('click', () => app.client.st('start_game', {}));
      wrap.appendChild(btn);
    } else if (state.phase === 'first_night' || state.phase === 'night') {
      if (state.phase === 'first_night') {
        const evilInfoBtn = button('Evil team info', 'primary');
        evilInfoBtn.title = 'Reveal the Demon to Minions and the Minions + 3 bluffs to the Demon.';
        evilInfoBtn.addEventListener('click', () => app.client.st('deliver_evil_team_info', {}));
        wrap.appendChild(evilInfoBtn);
      }
      const toDay = button('To Day →', 'primary');
      toDay.addEventListener('click', () => app.client.st('to_day', {}));
      wrap.appendChild(toDay);
    } else if (state.phase === 'day') {
      if (state.currentNomination && !state.currentNomination.resolved) {
        const resolve = button('Resolve nomination', 'primary');
        resolve.addEventListener('click', () => app.client.st('resolve_nomination', {}));
        wrap.appendChild(resolve);
      }
      const endDay = button('End Day →', 'primary');
      endDay.addEventListener('click', () => app.client.st('end_day', {}));
      wrap.appendChild(endDay);
    } else if (state.phase === 'ended') {
      wrap.appendChild(Object.assign(document.createElement('div'), { textContent: 'Game over.' }));
    }
    return wrap;
  }

  // Mirrors the engine's generateAutoInfo eligibility — which roles can have
  // canonical info auto-generated in the current phase. The engine returns
  // null if ineligible, but this keeps the button click from round-tripping
  // just to surface an error.
  const AUTO_INFO_FIRST_NIGHT = new Set(['washerwoman', 'librarian', 'investigator', 'chef', 'empath', 'fortuneteller', 'spy']);
  const AUTO_INFO_NIGHT       = new Set(['empath', 'undertaker', 'fortuneteller', 'ravenkeeper', 'spy']);
  function canAutoInfo(state, p) {
    if (!p || !p.character) return false;
    if (state.phase === 'first_night') return AUTO_INFO_FIRST_NIGHT.has(p.character);
    if (state.phase === 'night')       return AUTO_INFO_NIGHT.has(p.character);
    return false;
  }
  // How many seats the ST needs to pick before auto-info can be generated for
  // this role. Zero means no picker is required.
  function autoInfoTargetsNeeded(role) {
    if (role === 'fortuneteller') return 2;
    if (role === 'ravenkeeper')   return 1;
    return 0;
  }

  // The selected-seat strip: shows who's selected, their role, and tools for
  // kill/revive + add/remove reminder tokens.
  function selectedSeatStrip(state, p) {
    const wrap = div('seat-strip');
    const role = p.character ? window.Tokens.describe(p.character) : null;
    const mini = p.character
      ? `<span class="mini-token" data-almanac-role="${escapeHtml(p.character)}" tabindex="0">${window.Tokens.tokenSvg(p.character, { dead: !p.alive })}</span>`
      : '';
    const who = `
      <div class="seat-strip-who">
        ${mini}
        <div>
          <div><b>${escapeHtml(p.name)}</b> ${p.alive ? '' : '<span class="muted">(dead)</span>'}</div>
          <div class="muted" style="font-size:12px">${role ? `${role.name} · ${role.team}` : 'No role assigned yet'}</div>
        </div>
      </div>`;
    const killBtn = button(p.alive ? 'Kill' : 'Revive');
    killBtn.addEventListener('click', () => app.client.st('set_alive', { playerId: p.id, alive: !p.alive }));

    const poisonBtn = button(p.poisoned ? 'Cure' : 'Poison');
    poisonBtn.title = p.poisoned
      ? 'Remove poisoned status — auto-info will be truthful again.'
      : 'Mark as poisoned — auto-info for this player will return false info tonight.';
    if (p.poisoned) poisonBtn.classList.add('poisoned-active');
    poisonBtn.addEventListener('click', () => app.client.st('set_poisoned', { playerId: p.id, poisoned: !p.poisoned }));

    const reminderBtn = button(reminderPickerFor === p.id ? 'Close reminders' : '+ Reminder');
    reminderBtn.addEventListener('click', () => {
      reminderPickerFor = reminderPickerFor === p.id ? null : p.id;
      render();
    });

    const deliverBtn = button('Deliver info…');
    deliverBtn.addEventListener('click', () => {
      const text = prompt(`Send private info to ${p.name}:`);
      if (text && text.trim()) {
        app.client.st('deliver_private', { playerId: p.id, info: { text: text.trim() } });
      }
    });

    // Ability-correct info button — only surface when the engine is able to
    // auto-generate for this role in the current phase.
    const autoEligible = canAutoInfo(state, p);
    const autoBtn = button(autoEligible ? 'Auto-info' : 'Auto-info (n/a)', autoEligible ? 'primary' : '');
    autoBtn.title = autoEligible
      ? `Compute & deliver ability-correct info for ${p.name} (${role?.name || ''})`
      : 'Auto-info is not available for this role/phase (or requires a target choice first).';
    if (!autoEligible) autoBtn.disabled = true;
    autoBtn.addEventListener('click', () => {
      const needed = autoInfoTargetsNeeded(p.character);
      if (needed > 0) {
        // Roles that need targets (Fortune Teller, Ravenkeeper) enter a seat-
        // picker mode. Clicking seats populates `picks`; once full, auto_info
        // fires with targets. See onSeatClick for the pick handling.
        autoInfoPickMode = { playerId: p.id, role: p.character, needed, picks: [] };
        render();
        return;
      }
      app.client.st('auto_info', { playerId: p.id });
    });

    const closeBtn = button('×');
    closeBtn.title = 'Deselect seat';
    closeBtn.addEventListener('click', () => { selectedSeatId = null; reminderPickerFor = null; render(); });

    wrap.innerHTML = who;
    wrap.appendChild(killBtn);
    wrap.appendChild(poisonBtn);
    wrap.appendChild(reminderBtn);
    wrap.appendChild(autoBtn);
    wrap.appendChild(deliverBtn);
    wrap.appendChild(closeBtn);

    if (reminderPickerFor === p.id) {
      wrap.appendChild(reminderPicker(state, p));
    }
    return wrap;
  }

  // The picker shows every role's reminder token grouped by team, plus a free
  // text field. Clicking any token attaches it to the selected seat.
  function reminderPicker(state, p) {
    const wrap = div('reminder-picker');
    const groups = { townsfolk: [], outsider: [], minion: [], demon: [] };
    for (const [id, meta] of Object.entries(window.Tokens.TOKEN_META)) {
      for (const r of meta.reminders) {
        groups[meta.team].push({ role: meta.name, roleId: id, text: r });
      }
    }
    const section = (team, label) => {
      if (!groups[team].length) return '';
      return `<div class="rp-section">
        <div class="rp-label team-${team}">${label}</div>
        <div class="rp-chips">
          ${groups[team].map(({ roleId, role, text }) =>
            `<button class="rp-chip team-${team}" data-role="${escapeHtml(roleId)}" data-text="${escapeHtml(text)}">
               <span class="rp-role">${escapeHtml(role)}</span>
               <span class="rp-text">${escapeHtml(text)}</span>
             </button>`
          ).join('')}
        </div>
      </div>`;
    };
    wrap.innerHTML = `
      ${section('townsfolk', 'Townsfolk')}
      ${section('outsider',  'Outsiders')}
      ${section('minion',    'Minions')}
      ${section('demon',     'Demon')}
      <div class="rp-section">
        <div class="rp-label">Custom</div>
        <form class="rp-custom">
          <input type="text" maxlength="40" placeholder="Custom reminder (e.g. 'Used ability')" />
          <button class="primary" type="submit">Add</button>
        </form>
      </div>
    `;
    wrap.querySelectorAll('.rp-chip').forEach(btn => {
      btn.addEventListener('click', () => {
        app.client.st('add_reminder', { playerId: p.id, text: btn.dataset.text, roleSource: btn.dataset.role });
      });
    });
    wrap.querySelector('.rp-custom').addEventListener('submit', (ev) => {
      ev.preventDefault();
      const input = ev.currentTarget.querySelector('input');
      const t = input.value.trim();
      if (!t) return;
      app.client.st('add_reminder', { playerId: p.id, text: t });
      input.value = '';
    });
    return wrap;
  }

  function playerControls(state, me) {
    const wrap = div('controls');
    if (state.phase === 'lobby') {
      wrap.innerHTML = `<div class="muted">Waiting for Storyteller to start the game. You are seat #${me.seat + 1}.</div>`;
    } else if (state.phase === 'day') {
      if (!me.alive && !me.ghostVote) {
        wrap.innerHTML = `<div class="muted">You are dead and have used your ghost vote.</div>`;
      } else if (!state.currentNomination) {
        wrap.innerHTML = `<div class="muted">Click a player on the board to nominate them. You may nominate once per day.</div>`;
      }
    } else if (state.phase === 'night' || state.phase === 'first_night') {
      wrap.innerHTML = `<div class="muted">Night phase. The Storyteller will contact you privately if your role acts tonight.</div>`;
    } else if (state.phase === 'ended') {
      wrap.innerHTML = `<div class="muted">Game over. ${state.winner ? state.winner.toUpperCase() + ' wins.' : ''}</div>`;
    }
    return wrap;
  }

  // ---------- Private info popups ----------
  function onPrivate(msg) {
    const div = document.createElement('div');
    div.style.cssText = `position:fixed;right:20px;bottom:20px;max-width:340px;padding:14px;
                         background:#1a140a;border:1px solid var(--accent);border-radius:10px;
                         color:var(--fg);box-shadow:var(--shadow);z-index:1000;font-size:13px`;
    const body = typeof msg.payload === 'string'
      ? msg.payload
      : (msg.payload?.text || JSON.stringify(msg.payload));
    div.innerHTML = `<b style="color:var(--accent)">Storyteller</b>
                     <div style="margin-top:6px">${escapeHtml(body)}</div>
                     <button style="margin-top:10px">Dismiss</button>`;
    div.querySelector('button').addEventListener('click', () => div.remove());
    document.body.appendChild(div);
    setTimeout(() => { if (document.body.contains(div)) div.remove(); }, 20000);
  }

  // ---------- Helpers ----------
  function div(cls) { const d = document.createElement('div'); if (cls) d.className = cls; return d; }
  function button(label, cls = '') { const b = document.createElement('button'); b.textContent = label; if (cls) b.className = cls; return b; }
  function labelForPhase(p) {
    return { lobby:'Lobby', first_night:'First Night', day:'Day', night:'Night', ended:'Ended' }[p] || p;
  }
  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  window.initGame = function (application) {
    app = application;
    app.chatMessages = app.chatMessages || [];
    app.client.addEventListener('state', render);
    app.client.addEventListener('chat', (ev) => {
      app.chatMessages.push(ev.detail);
      const log = document.getElementById('chatlog');
      if (log) {
        const line = document.createElement('div');
        line.className = 'msg';
        line.innerHTML = `<b>${escapeHtml(ev.detail.from)}:</b> ${escapeHtml(ev.detail.text)}`;
        log.appendChild(line);
        log.scrollTop = log.scrollHeight;
      }
    });
    app.client.addEventListener('private', (ev) => onPrivate(ev.detail));
    // Escape cancels auto-info pick mode cleanly. We don't stopPropagation
    // because app.js also uses Escape to close side drawers; both should run.
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && autoInfoPickMode) {
        autoInfoPickMode = null;
        render();
      }
    });
    render();
  };
})();
