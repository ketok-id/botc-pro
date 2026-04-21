// Character token rendering — generates SVG strings for each Trouble Brewing
// role. Tokens are inline SVG so we don't need a separate art pipeline; the
// visual consists of a parchment disc, a team-coloured outer ring, a large
// emoji symbol, and the role name. The first-night-order ribbon is an
// optional overlay used on the Storyteller's grimoire view.
//
// This keeps us unambiguously in "original stylised assets" territory — none
// of the official Blood on the Clocktower artwork is used.

(function () {
  const TEAM_COLOUR = {
    townsfolk: '#5ad19b', // green
    outsider:  '#6aa8ff', // cold blue
    minion:    '#e55a6a', // pink red
    demon:     '#a8233a', // deep blood red
  };

  // Per-role metadata. Symbol is an emoji rendered as SVG text — Chromium
  // (Electron 31) has built-in colour emoji font support, so a single text
  // glyph covers us without bespoke paths. Reminders mirror the official
  // physical reminder tokens for Trouble Brewing.
  const TOKEN_META = {
    washerwoman:   { name: 'Washerwoman',   team: 'townsfolk', symbol: '\u{1F9FA}', firstNight: 32, otherNight: 0,  reminders: ['Townsfolk', 'Wrong'],
                     ability: 'You start knowing that 1 of 2 players is a particular Townsfolk.' },
    librarian:     { name: 'Librarian',     team: 'townsfolk', symbol: '\u{1F4D6}', firstNight: 33, otherNight: 0,  reminders: ['Outsider', 'Wrong'],
                     ability: 'You start knowing that 1 of 2 players is a particular Outsider. (Or that zero are in play.)' },
    investigator:  { name: 'Investigator',  team: 'townsfolk', symbol: '\u{1F50D}', firstNight: 34, otherNight: 0,  reminders: ['Minion', 'Wrong'],
                     ability: 'You start knowing that 1 of 2 players is a particular Minion.' },
    chef:          { name: 'Chef',          team: 'townsfolk', symbol: '\u{1F373}', firstNight: 36, otherNight: 0,  reminders: [],
                     ability: 'You start knowing how many pairs of evil players there are.' },
    empath:        { name: 'Empath',        team: 'townsfolk', symbol: '\u{1F49E}', firstNight: 37, otherNight: 37, reminders: [],
                     ability: 'Each night, you learn how many of your 2 alive neighbours are evil.' },
    fortuneteller: { name: 'Fortune Teller',team: 'townsfolk', symbol: '\u{1F52E}', firstNight: 38, otherNight: 38, reminders: ['Red herring'],
                     ability: 'Each night, choose 2 players: you learn if either is a Demon. There is 1 good player that registers as a Demon to you.' },
    undertaker:    { name: 'Undertaker',    team: 'townsfolk', symbol: '\u{26B0}',  firstNight: 0,  otherNight: 46, reminders: ['Died today'],
                     ability: 'Each night*, you learn which character died by execution today.' },
    monk:          { name: 'Monk',          team: 'townsfolk', symbol: '\u{1F64F}', firstNight: 0,  otherNight: 12, reminders: ['Safe'],
                     ability: 'Each night*, choose a player (not yourself): they are safe from the Demon tonight.' },
    ravenkeeper:   { name: 'Ravenkeeper',   team: 'townsfolk', symbol: '\u{1F985}', firstNight: 0,  otherNight: 42, reminders: [],
                     ability: 'If you die at night, you are woken to choose a player: you learn their character.' },
    virgin:        { name: 'Virgin',        team: 'townsfolk', symbol: '\u{1F339}', firstNight: 0,  otherNight: 0,  reminders: ['No ability'],
                     ability: 'The 1st time you are nominated, if the nominator is a Townsfolk, they are executed immediately.' },
    slayer:        { name: 'Slayer',        team: 'townsfolk', symbol: '\u{1F3F9}', firstNight: 0,  otherNight: 0,  reminders: ['No ability'],
                     ability: 'Once per game, during the day, publicly choose a player: if they are the Demon, they die.' },
    soldier:       { name: 'Soldier',       team: 'townsfolk', symbol: '\u{1F6E1}', firstNight: 0,  otherNight: 0,  reminders: [],
                     ability: 'You are safe from the Demon.' },
    mayor:         { name: 'Mayor',         team: 'townsfolk', symbol: '\u{1F451}', firstNight: 0,  otherNight: 0,  reminders: [],
                     ability: 'If only 3 players live & no execution occurs, your team wins. If you die at night, another player might die instead.' },

    butler:        { name: 'Butler',        team: 'outsider',  symbol: '\u{1F514}', firstNight: 50, otherNight: 50, reminders: ['Master'],
                     ability: 'Each night, choose a player (not yourself): tomorrow, you may only vote if they are voting too.' },
    drunk:         { name: 'Drunk',         team: 'outsider',  symbol: '\u{1F37A}', firstNight: 0,  otherNight: 0,  reminders: ['Is the Drunk'],
                     ability: 'You do not know you are the Drunk. You think you are a Townsfolk, but you are not.' },
    recluse:       { name: 'Recluse',       team: 'outsider',  symbol: '\u{1F9D9}', firstNight: 0,  otherNight: 0,  reminders: [],
                     ability: 'You might register as evil & as a Minion or Demon, even if dead.' },
    saint:         { name: 'Saint',         team: 'outsider',  symbol: '\u{1F607}', firstNight: 0,  otherNight: 0,  reminders: [],
                     ability: 'If you die by execution, your team loses.' },

    poisoner:      { name: 'Poisoner',      team: 'minion',    symbol: '\u{1F9EA}', firstNight: 17, otherNight: 7,  reminders: ['Poisoned'],
                     ability: 'Each night, choose a player: they are poisoned tonight and tomorrow day.' },
    spy:           { name: 'Spy',           team: 'minion',    symbol: '\u{1F441}', firstNight: 51, otherNight: 48, reminders: [],
                     ability: 'Each night, you see the Grimoire. You might register as good & as a Townsfolk or Outsider, even if dead.' },
    scarletwoman:  { name: 'Scarlet Woman', team: 'minion',    symbol: '\u{1F484}', firstNight: 0,  otherNight: 19, reminders: ['Is the Demon'],
                     ability: 'If there are 5 or more players alive & the Demon dies, you become the Demon. (Travellers don\u2019t count.)' },
    baron:         { name: 'Baron',         team: 'minion',    symbol: '\u{1F3F0}', firstNight: 0,  otherNight: 0,  reminders: ['+2 Outsiders'],
                     ability: 'There are extra Outsiders in play. [+2 Outsiders]' },

    imp:           { name: 'Imp',           team: 'demon',     symbol: '\u{1F47F}', firstNight: 0,  otherNight: 24, reminders: ['Dead', 'Is the Demon'],
                     ability: 'Each night*, choose a player: they die. If you kill yourself this way, a Minion becomes the Imp.' },
  };

  // A few pseudo-entries for night-order bookends the ST walks through
  // without a seat on the grimoire.
  const PSEUDO_META = {
    dusk:       { name: 'Dusk',        symbol: '\u{1F319}', firstNight: 1,  otherNight: 1,  note: 'The sun sets. Storyteller wakes roles in order.' },
    minionInfo: { name: 'Minion Info', symbol: '\u{1F5E1}', firstNight: 5,  otherNight: 0,  note: 'If 7+ players, wake Minions together; they learn who the Demon is and any bluffs.' },
    demonInfo:  { name: 'Demon Info',  symbol: '\u{1F525}', firstNight: 8,  otherNight: 0,  note: 'If 7+ players, wake the Demon; show them their Minions and 3 good-character bluffs.' },
    dawn:       { name: 'Dawn',        symbol: '\u{1F305}', firstNight: 99, otherNight: 99, note: 'All night actions done. Announce deaths, then open the day.' },
  };

  const TEAM_LABEL = {
    townsfolk: 'Townsfolk',
    outsider:  'Outsider',
    minion:    'Minion',
    demon:     'Demon',
  };

  function teamColour(team) { return TEAM_COLOUR[team] || '#999'; }

  // Escape for SVG attribute contexts.
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  // Build a gradient + filter pair unique to each token so many SVGs on the
  // same page don't collide. Uses the role id as the suffix when supplied.
  function gradIds(suffix) {
    return {
      parchment: `pg_${suffix}`,
      rim:       `pr_${suffix}`,
      shadow:    `ps_${suffix}`,
    };
  }

  /**
   * Render a character token as an inline SVG string.
   *
   * @param {string} roleId    - id from TOKEN_META
   * @param {object} opts
   * @param {boolean} opts.dead        - apply grayscale + skull overlay
   * @param {boolean} opts.showOrder   - show the first-night-order ribbon
   * @param {boolean} opts.firstNight  - use firstNight order (vs otherNight) for the ribbon
   * @param {boolean} opts.unknown     - render as "?" (used for players whose role isn't revealed to you)
   */
  function tokenSvg(roleId, opts = {}) {
    const { dead = false, showOrder = false, firstNight = true, unknown = false } = opts;
    const meta = TOKEN_META[roleId];
    if (unknown || !meta) return unknownTokenSvg({ dead });

    const team = meta.team;
    const colour = teamColour(team);
    const g = gradIds(roleId);
    const orderNum = firstNight ? meta.firstNight : meta.otherNight;

    return `
<svg viewBox="0 0 120 120" class="token-svg ${dead ? 'is-dead' : ''}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${esc(meta.name)}">
  <defs>
    <radialGradient id="${g.parchment}" cx="0.5" cy="0.38" r="0.75">
      <stop offset="0%"  stop-color="#fbe9b8"/>
      <stop offset="55%" stop-color="#d6a95e"/>
      <stop offset="100%" stop-color="#7a5423"/>
    </radialGradient>
    <linearGradient id="${g.rim}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${colour}" stop-opacity="1"/>
      <stop offset="100%" stop-color="${colour}" stop-opacity="0.55"/>
    </linearGradient>
    <radialGradient id="${g.shadow}" cx="0.5" cy="0.85" r="0.6">
      <stop offset="0%" stop-color="#000" stop-opacity="0.28"/>
      <stop offset="100%" stop-color="#000" stop-opacity="0"/>
    </radialGradient>
  </defs>

  <!-- outer team ring -->
  <circle cx="60" cy="60" r="56" fill="url(#${g.rim})" />
  <!-- parchment face -->
  <circle cx="60" cy="60" r="50" fill="url(#${g.parchment})" stroke="#3a2810" stroke-width="1.2"/>
  <!-- inner glow + shadow -->
  <circle cx="60" cy="60" r="50" fill="url(#${g.shadow})"/>

  <!-- central symbol -->
  <text x="60" y="66" text-anchor="middle" dominant-baseline="middle"
        font-size="40" style="user-select:none">${meta.symbol}</text>

  <!-- role name -->
  <text x="60" y="98" text-anchor="middle" font-size="11"
        font-family="-apple-system, Segoe UI, Inter, sans-serif"
        font-weight="700" fill="#2b1d04" letter-spacing="0.5">
    ${esc(meta.name.toUpperCase())}
  </text>

  ${showOrder && orderNum > 0 ? `
  <g transform="translate(60,14)">
    <circle cx="0" cy="0" r="11" fill="${colour}" stroke="#2b1d04" stroke-width="1.2"/>
    <text x="0" y="4" text-anchor="middle" font-size="12" font-weight="700" fill="#1a0f00">${orderNum}</text>
  </g>` : ''}

  ${dead ? `
  <g class="death-overlay">
    <circle cx="60" cy="60" r="56" fill="rgba(0,0,0,0.45)"/>
    <text x="60" y="72" text-anchor="middle" font-size="48" fill="#eee" opacity="0.9">\u2620</text>
  </g>` : ''}
</svg>`.trim();
  }

  // Placeholder for viewers who haven't been shown a seat's role.
  function unknownTokenSvg({ dead = false } = {}) {
    const g = gradIds('unknown');
    return `
<svg viewBox="0 0 120 120" class="token-svg ${dead ? 'is-dead' : ''}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Unknown role">
  <defs>
    <radialGradient id="${g.parchment}" cx="0.5" cy="0.38" r="0.75">
      <stop offset="0%"  stop-color="#d8c89a"/>
      <stop offset="55%" stop-color="#9d7e3f"/>
      <stop offset="100%" stop-color="#4e3416"/>
    </radialGradient>
  </defs>
  <circle cx="60" cy="60" r="56" fill="#3a2d58"/>
  <circle cx="60" cy="60" r="50" fill="url(#${g.parchment})" stroke="#2b1d04" stroke-width="1.2"/>
  <text x="60" y="72" text-anchor="middle" font-size="54" fill="#2b1d04" font-weight="800">?</text>
  ${dead ? `<g><circle cx="60" cy="60" r="56" fill="rgba(0,0,0,0.45)"/><text x="60" y="72" text-anchor="middle" font-size="48" fill="#eee" opacity="0.9">\u2620</text></g>` : ''}
</svg>`.trim();
  }

  // Map a role id or a pseudo-order key to its display metadata (name +
  // symbol). Used by the night-order panel.
  function describe(id) {
    return TOKEN_META[id] || PSEUDO_META[id] || null;
  }

  // Combined night-order list for the current phase. Returns an array of
  // `{ id, order, meta, inPlay }` sorted by order. Pseudo entries (dusk, minion
  // info, demon info, dawn) are always included for the first night.
  function nightOrder({ firstNight = true, inPlayRoleIds = [] } = {}) {
    const entries = [];
    const add = (id, meta) => {
      const order = firstNight ? meta.firstNight : meta.otherNight;
      if (order > 0) entries.push({ id, order, meta, inPlay: inPlayRoleIds.includes(id) });
    };
    for (const [id, meta] of Object.entries(PSEUDO_META)) add(id, meta);
    for (const [id, meta] of Object.entries(TOKEN_META)) add(id, meta);
    entries.sort((a, b) => a.order - b.order);
    return entries;
  }

  window.Tokens = {
    TOKEN_META,
    PSEUDO_META,
    TEAM_COLOUR,
    TEAM_LABEL,
    teamColour,
    tokenSvg,
    unknownTokenSvg,
    describe,
    nightOrder,
  };
})();
