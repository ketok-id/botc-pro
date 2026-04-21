// Game engine — pure logic, no I/O. Consumed by the server (and theoretically
// usable by the client for local simulation). Implements BOTC phase flow for
// the Trouble Brewing MVP: seating, role assignment, day/night cycle, nominations,
// voting, execution, and win-condition checking.
//
// Storyteller authority: the ST is the source of truth for info delivered to
// players (BOTC is a ST-driven game). The engine supports that by routing
// `deliverInfo` actions from the ST to a specific player.

const { SCRIPT: TB } = require('./data/trouble-brewing');
const { PHASES } = require('./protocol');

function shuffle(arr, rng = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function createGame(scriptId = 'trouble-brewing') {
  const script = scriptId === 'trouble-brewing' ? TB : TB;
  return {
    scriptId: script.id,
    phase: PHASES.LOBBY,
    dayNumber: 0,
    players: [],       // { id, name, seat, alive, character, team, isSt, ghostVote, reminders: [] }
    storytellerId: null,
    nominations: [],   // { nominator, nominee, votes:[ids], resolved }
    currentNomination: null,
    executedToday: null, // character id
    voteHistory: [],   // [{ day, executed, nominations: [{ nominator, nominee, yesCount, threshold, votes }] }]
    log: [],           // public game log
    winner: null,      // 'good' | 'evil' | null
    createdAt: Date.now(),
  };
}

function addPlayer(game, { id, name, isSt = false }) {
  if (game.players.find(p => p.id === id)) return;
  if (isSt) {
    if (!game.storytellerId) game.storytellerId = id;
  }
  game.players.push({
    id,
    name,
    seat: game.players.filter(p => !p.isSt).length,
    alive: true,
    character: null,
    team: null,
    isSt,
    ghostVote: true,
    reminders: [],
    // Drunk/Poisoned status — the Storyteller toggles `poisoned` when the
    // Poisoner targets someone. The Drunk character (p.character === 'drunk')
    // is always treated as "malfunctioning" regardless of this flag.
    poisoned: false,
  });
  return game;
}

function removePlayer(game, id) {
  game.players = game.players.filter(p => p.id !== id);
  if (game.storytellerId === id) game.storytellerId = null;
  // Re-seat remaining non-ST players
  let seat = 0;
  for (const p of game.players) {
    if (!p.isSt) p.seat = seat++;
  }
  return game;
}

function seatedPlayers(game) {
  return game.players.filter(p => !p.isSt).sort((a, b) => a.seat - b.seat);
}

function alivePlayers(game) {
  return seatedPlayers(game).filter(p => p.alive);
}

// --- Setup / role distribution ---

function computeSetup(script, numPlayers, { baronInPlay = false } = {}) {
  const base = script.setup[numPlayers];
  if (!base) throw new Error(`No setup defined for ${numPlayers} players in ${script.name}`);
  let [t, o, m, d] = base;
  if (baronInPlay) { t -= 2; o += 2; }
  return { townsfolk: t, outsiders: o, minions: m, demons: d };
}

function assignRoles(game, { rng = Math.random, includeBaron = false } = {}) {
  const script = TB; // MVP: single script
  const seated = seatedPlayers(game);
  const n = seated.length;
  if (n < script.minPlayers) throw new Error(`Need at least ${script.minPlayers} players`);
  if (n > script.maxPlayers) throw new Error(`Max ${script.maxPlayers} players`);

  // Decide whether a Baron is rolled into this game (storyteller may force via flag).
  const minionChars = script.characters.filter(c => c.team === 'minion');
  const dist = computeSetup(script, n, { baronInPlay: includeBaron });

  const pick = (pool, k) => shuffle(pool, rng).slice(0, k);
  const townsfolk = pick(script.characters.filter(c => c.team === 'townsfolk'), dist.townsfolk);
  const outsiders = pick(script.characters.filter(c => c.team === 'outsider'), dist.outsiders);
  const minions   = includeBaron
    ? [script.characters.find(c => c.id === 'baron'), ...pick(minionChars.filter(c => c.id !== 'baron'), dist.minions - 1)]
    : pick(minionChars, dist.minions);
  const demons    = pick(script.characters.filter(c => c.team === 'demon'), dist.demons);

  const bag = shuffle([...townsfolk, ...outsiders, ...minions, ...demons], rng);
  const seats = shuffle(seated.slice(), rng);
  seats.forEach((p, i) => {
    const c = bag[i];
    p.character = c.id;
    p.team = (c.team === 'demon' || c.team === 'minion') ? 'evil' : 'good';
  });
  return dist;
}

// --- Phase transitions ---

function startGame(game, opts = {}) {
  if (game.phase !== PHASES.LOBBY) throw new Error('Game already started');
  assignRoles(game, opts);
  placeAutoReminders(game, opts.rng || Math.random);
  game.phase = PHASES.FIRST_NIGHT;
  game.dayNumber = 0;
  logPublic(game, 'Night 1 begins. Storyteller is waking players for info.');
  return game;
}

// Drop any start-of-game reminders that the ST would otherwise need to remember
// to place by hand. Currently:
//   - Fortune Teller's Red Herring (any Good player, per official rules — can
//     include the Fortune Teller themself).
// Safe to re-run; it only places a reminder if one doesn't already exist.
function placeAutoReminders(game, rng = Math.random) {
  const hasFT = game.players.some(p => p.character === 'fortuneteller');
  if (hasFT) {
    const already = game.players.some(p =>
      (p.reminders || []).some(r => r.roleSource === 'fortuneteller' && /red herring/i.test(r.text))
    );
    if (!already) {
      const goodPool = game.players.filter(p => !p.isSt && p.team === 'good');
      if (goodPool.length) {
        const target = goodPool[Math.floor(rng() * goodPool.length)];
        if (!Array.isArray(target.reminders)) target.reminders = [];
        target.reminders.push({
          id: 'rh-' + Math.random().toString(36).slice(2, 8),
          text: 'Red herring',
          roleSource: 'fortuneteller',
        });
      }
    }
  }
}

function advanceToDay(game) {
  if (game.phase !== PHASES.FIRST_NIGHT && game.phase !== PHASES.NIGHT) {
    throw new Error(`Cannot go to day from phase ${game.phase}`);
  }
  // Archive the previous day's nominations so the vote-history panel can keep
  // showing them. `game.dayNumber` still points at the day that just ended.
  if (game.dayNumber > 0 && game.nominations.length > 0) {
    if (!Array.isArray(game.voteHistory)) game.voteHistory = [];
    game.voteHistory.push({
      day: game.dayNumber,
      executed: game.executedToday,
      nominations: game.nominations.map(n => ({
        nominator: n.nominator,
        nominee: n.nominee,
        yesCount: n.yesCount ?? null,
        threshold: n.threshold ?? null,
        resolved: !!n.resolved,
        votes: n.votes.map(v => ({ voter: v.voter, yes: !!v.yes })),
      })),
    });
  }
  game.phase = PHASES.DAY;
  game.dayNumber += 1;
  game.nominations = [];
  game.currentNomination = null;
  game.executedToday = null;
  logPublic(game, `Day ${game.dayNumber} begins.`);
  checkWinConditions(game);
  return game;
}

function advanceToNight(game) {
  if (game.phase !== PHASES.DAY) throw new Error('Night can only follow Day');
  game.phase = PHASES.NIGHT;
  logPublic(game, `Night ${game.dayNumber + 1} begins.`);
  return game;
}

// --- Nominations & voting ---

function openNomination(game, nominatorId, nomineeId) {
  if (game.phase !== PHASES.DAY) throw new Error('Nominations only happen during the day');
  const nominator = game.players.find(p => p.id === nominatorId);
  const nominee = game.players.find(p => p.id === nomineeId);
  if (!nominator || !nominee) throw new Error('Unknown player');
  if (!nominator.alive) throw new Error('Dead players cannot nominate');
  // Standard BOTC: each living player nominates at most once per day, each player may be nominated once per day.
  if (game.nominations.some(n => n.nominator === nominatorId)) throw new Error('You already nominated today');
  if (game.nominations.some(n => n.nominee === nomineeId)) throw new Error('That player was already nominated today');
  const nom = { nominator: nominatorId, nominee: nomineeId, votes: [], resolved: false };
  game.nominations.push(nom);
  game.currentNomination = nom;
  logPublic(game, `${nominator.name} nominates ${nominee.name}.`);
  return nom;
}

function castVote(game, voterId, voteYes) {
  const nom = game.currentNomination;
  if (!nom || nom.resolved) throw new Error('No active nomination');
  const voter = game.players.find(p => p.id === voterId);
  if (!voter) throw new Error('Unknown voter');
  if (!voter.alive && !voter.ghostVote) throw new Error('No ghost vote remaining');
  // Replace existing vote if any
  nom.votes = nom.votes.filter(v => v.voter !== voterId);
  nom.votes.push({ voter: voterId, yes: !!voteYes });
}

// Resolve the current nomination. Caller (ST) decides when voting ends.
function resolveNomination(game) {
  const nom = game.currentNomination;
  if (!nom || nom.resolved) throw new Error('No active nomination');
  const yes = nom.votes.filter(v => v.yes).length;
  const threshold = Math.ceil(alivePlayers(game).length / 2);
  nom.resolved = true;
  nom.yesCount = yes;
  nom.threshold = threshold;

  // Consume ghost votes for dead voters who voted yes
  for (const v of nom.votes) {
    if (!v.yes) continue;
    const voter = game.players.find(p => p.id === v.voter);
    if (voter && !voter.alive) voter.ghostVote = false;
  }

  // Check if this tally beats current highest — in BOTC only the highest tally (above threshold) is "on the block"
  const prevTop = Math.max(0, ...game.nominations.filter(n => n.resolved && n !== nom).map(n => n.yesCount));
  if (yes >= threshold && yes > prevTop) {
    game.onTheBlock = nom.nominee;
    logPublic(game, `${labelOf(game, nom.nominee)} is on the block with ${yes} votes.`);
  } else if (yes >= threshold && yes === prevTop) {
    game.onTheBlock = null;
    logPublic(game, `Tied at ${yes} votes; no one is on the block.`);
  } else {
    logPublic(game, `${labelOf(game, nom.nominee)} receives ${yes} votes. Not enough.`);
  }
  game.currentNomination = null;
  return nom;
}

function endDay(game) {
  if (game.phase !== PHASES.DAY) throw new Error('Not day');
  const blockId = game.onTheBlock;
  if (blockId) {
    const p = game.players.find(pp => pp.id === blockId);
    if (p) {
      p.alive = false;
      game.executedToday = p.character;
      logPublic(game, `${p.name} is executed.`);
    }
  } else {
    logPublic(game, 'No execution today.');
  }
  game.onTheBlock = null;
  checkWinConditions(game);
  if (game.phase !== PHASES.ENDED) advanceToNight(game);
  return game;
}

// --- Storyteller kills (at night) ---

function stKill(game, playerId, reason = 'demon') {
  const p = game.players.find(pp => pp.id === playerId);
  if (!p) throw new Error('Unknown player');
  p.alive = false;
  logPublic(game, `${p.name} died in the night.`);
  checkWinConditions(game);
  return game;
}

// --- Win conditions (Trouble Brewing) ---

function checkWinConditions(game) {
  const aliveSeats = alivePlayers(game);
  const demonAlive = aliveSeats.some(p => getCharTeam(p.character) === 'demon');
  // Good wins if no living demon
  if (!demonAlive && game.phase !== PHASES.LOBBY) {
    game.phase = PHASES.ENDED;
    game.winner = 'good';
    logPublic(game, 'Good wins — no Demon remains alive.');
    return;
  }
  // Evil wins if 2 or fewer players alive (and one is demon)
  if (aliveSeats.length <= 2 && demonAlive) {
    game.phase = PHASES.ENDED;
    game.winner = 'evil';
    logPublic(game, 'Evil wins — only the Demon and one other remain.');
    return;
  }
  // Saint execution = good loss
  if (game.executedToday === 'saint') {
    game.phase = PHASES.ENDED;
    game.winner = 'evil';
    logPublic(game, 'Evil wins — the Saint was executed.');
    return;
  }
  // Mayor: 3 players live, no execution today, game continues until storyteller ends
  if (aliveSeats.length === 3 && game.phase === PHASES.DAY && game.executedToday === null) {
    // Storyteller is trusted to end the day without an execution for Mayor to trigger;
    // this is checked again in endDay once no-one is on the block.
  }
}

function getCharTeam(id) {
  const c = TB.characters.find(cc => cc.id === id);
  return c?.team;
}

function getCharName(id) {
  const c = TB.characters.find(cc => cc.id === id);
  return c?.name || id;
}

function isEvilTeam(team) {
  return team === 'minion' || team === 'demon';
}

function pickRandom(arr, rng = Math.random) {
  if (!arr || arr.length === 0) return null;
  return arr[Math.floor(rng() * arr.length)];
}

// --- Automatic "ability-correct" private info generator ---
//
// Given the current game state + a target player, compute the canonical
// (truthful) info the Storyteller would normally deliver for that character.
// Returns:
//   { text, detail? }  — info that can be sent directly as PRIVATE_INFO.payload
//   null               — role does not have an auto-generatable info for this phase,
//                        or the role needs the ST to pick something first.
//
// The ST is free to ignore this and type their own info for bluffs and
// misinformation (drunk/poisoned/spy); this function just produces the
// "correct" reading.
function isMalfunctioning(p) {
  return !!p && (p.character === 'drunk' || p.poisoned === true);
}

function generateAutoInfo(game, playerId, { targets = [], rng = Math.random } = {}) {
  const p = game.players.find(pp => pp.id === playerId);
  if (!p) throw new Error('Unknown player');
  if (!p.character) return null;

  const phase = game.phase;
  const others = (filter) => game.players.filter(x => !x.isSt && x.id !== p.id && (filter ? filter(x) : true));
  const seatedSorted = game.players.filter(x => !x.isSt).sort((a, b) => a.seat - b.seat);
  const malfunctioning = isMalfunctioning(p);
  const malfunctionNote = malfunctioning ? ' (drunk/poisoned)' : '';

  function twoOfOne(targetTeam, targetLabelFn) {
    const pool = game.players.filter(x => !x.isSt && x.id !== p.id && getCharTeam(x.character) === targetTeam);
    if (pool.length === 0) return null;
    let truthPlayer, shownChar;
    if (malfunctioning) {
      // Pick any other non-self non-same-role player as the "truth"; and a
      // random character from that team that is not actually that player's
      // character (so the info is at least internally consistent, but wrong).
      const anyPool = others();
      truthPlayer = pickRandom(anyPool, rng);
      if (!truthPlayer) return null;
      const roleOptions = TB.characters.filter(c => c.team === targetTeam && c.id !== truthPlayer.character);
      shownChar = pickRandom(roleOptions, rng)?.id;
      if (!shownChar) shownChar = pickRandom(TB.characters.filter(c => c.team === targetTeam), rng)?.id;
    } else {
      truthPlayer = pickRandom(pool, rng);
      shownChar = truthPlayer.character;
    }
    const decoyPool = others(x => x.id !== truthPlayer.id);
    const decoy = pickRandom(decoyPool, rng);
    if (!decoy) return null;
    const [a, b] = shuffle([truthPlayer, decoy], rng);
    return {
      text: `${a.name} or ${b.name} is the ${targetLabelFn(shownChar)}.${malfunctionNote}`,
      detail: { kind: 'two-of-one', shown: [a.id, b.id], character: shownChar, malfunctioning },
    };
  }

  switch (p.character) {
    case 'washerwoman': {
      if (phase !== PHASES.FIRST_NIGHT) return null;
      return twoOfOne('townsfolk', getCharName);
    }
    case 'librarian': {
      if (phase !== PHASES.FIRST_NIGHT) return null;
      if (malfunctioning) {
        // A drunk/poisoned Librarian may be told "zero" or a wrong pairing.
        if (rng() < 0.5) {
          return { text: `There are no Outsiders in play.${malfunctionNote}`, detail: { kind: 'zero-outsiders', malfunctioning: true } };
        }
        return twoOfOne('outsider', getCharName) || { text: `There are no Outsiders in play.${malfunctionNote}`, detail: { kind: 'zero-outsiders', malfunctioning: true } };
      }
      const outs = game.players.filter(x => !x.isSt && getCharTeam(x.character) === 'outsider');
      if (outs.length === 0) {
        return { text: 'There are no Outsiders in play.', detail: { kind: 'zero-outsiders' } };
      }
      return twoOfOne('outsider', getCharName);
    }
    case 'investigator': {
      if (phase !== PHASES.FIRST_NIGHT) return null;
      return twoOfOne('minion', getCharName);
    }
    case 'chef': {
      if (phase !== PHASES.FIRST_NIGHT) return null;
      const n = seatedSorted.length;
      let pairs = 0;
      for (let i = 0; i < n; i++) {
        const a = seatedSorted[i], b = seatedSorted[(i + 1) % n];
        if (isEvilTeam(getCharTeam(a.character)) && isEvilTeam(getCharTeam(b.character))) pairs++;
      }
      let shown = pairs;
      if (malfunctioning) {
        const max = Math.max(2, Math.floor(n / 2));
        const options = [];
        for (let i = 0; i <= max; i++) if (i !== pairs) options.push(i);
        shown = pickRandom(options, rng) ?? pairs;
      }
      return {
        text: `You learn: ${shown} pair${shown === 1 ? '' : 's'} of evil players sit together.${malfunctionNote}`,
        detail: { kind: 'chef', pairs: shown, truePairs: pairs, malfunctioning },
      };
    }
    case 'empath': {
      if (phase !== PHASES.FIRST_NIGHT && phase !== PHASES.NIGHT) return null;
      const n = seatedSorted.length;
      const idx = seatedSorted.findIndex(x => x.id === p.id);
      if (idx < 0) return null;
      let left = null, right = null;
      for (let k = 1; k < n; k++) {
        const c = seatedSorted[(idx - k + n) % n];
        if (c.alive && c.id !== p.id) { left = c; break; }
      }
      for (let k = 1; k < n; k++) {
        const c = seatedSorted[(idx + k) % n];
        if (c.alive && c.id !== p.id && c.id !== left?.id) { right = c; break; }
      }
      let count = 0;
      if (left  && isEvilTeam(getCharTeam(left.character)))  count++;
      if (right && isEvilTeam(getCharTeam(right.character))) count++;
      let shown = count;
      if (malfunctioning) {
        const options = [0, 1, 2].filter(v => v !== count);
        shown = pickRandom(options, rng);
      }
      return {
        text: `You learn: ${shown} of your alive neighbours ${shown === 1 ? 'is' : 'are'} evil.${malfunctionNote}`,
        detail: { kind: 'empath', count: shown, trueCount: count, left: left?.id || null, right: right?.id || null, malfunctioning },
      };
    }
    case 'undertaker': {
      if (phase !== PHASES.NIGHT) return null;
      if (!game.executedToday && !malfunctioning) {
        return { text: 'No one was executed today.', detail: { kind: 'undertaker', executed: null } };
      }
      let shown = game.executedToday;
      if (malfunctioning) {
        // Drunk/poisoned undertaker learns a random character that wasn't
        // actually executed (any TB character other than the truth).
        const opts = TB.characters.filter(c => c.id !== game.executedToday);
        shown = pickRandom(opts, rng)?.id || shown;
      }
      return {
        text: `The executed character was: ${getCharName(shown)}.${malfunctionNote}`,
        detail: { kind: 'undertaker', executed: shown, trueExecuted: game.executedToday, malfunctioning },
      };
    }
    case 'fortuneteller': {
      if (phase !== PHASES.FIRST_NIGHT && phase !== PHASES.NIGHT) return null;
      if (!targets || targets.length !== 2) return null; // caller must supply 2 targets
      const t1 = game.players.find(x => x.id === targets[0]);
      const t2 = game.players.find(x => x.id === targets[1]);
      if (!t1 || !t2 || t1.id === t2.id) return null;
      // Truth: either target is a Demon OR has a fortuneteller Red Herring reminder.
      const isRH = (pp) => (pp.reminders || []).some(r => r.roleSource === 'fortuneteller' && /red herring/i.test(r.text));
      const demon = (pp) => getCharTeam(pp.character) === 'demon';
      const truthYes = demon(t1) || demon(t2) || isRH(t1) || isRH(t2);
      const shownYes = malfunctioning ? (rng() < 0.5) : truthYes;
      return {
        text: `Fortune Teller — ${t1.name} & ${t2.name}: ${shownYes ? 'YES, one of them registers as a Demon.' : 'NO, neither registers as a Demon.'}${malfunctionNote}`,
        detail: { kind: 'fortuneteller', targets: [t1.id, t2.id], yes: shownYes, trueYes: truthYes, malfunctioning },
      };
    }
    case 'ravenkeeper': {
      if (phase !== PHASES.NIGHT) return null;
      if (!targets || targets.length !== 1) return null;
      const t = game.players.find(x => x.id === targets[0]);
      if (!t || !t.character) return null;
      let shown = t.character;
      if (malfunctioning) {
        const opts = TB.characters.filter(c => c.id !== t.character);
        shown = pickRandom(opts, rng)?.id || shown;
      }
      return {
        text: `Ravenkeeper — ${t.name} is the ${getCharName(shown)}.${malfunctionNote}`,
        detail: { kind: 'ravenkeeper', target: t.id, character: shown, trueCharacter: t.character, malfunctioning },
      };
    }
    case 'butler':
    case 'monk':
    case 'poisoner':
    case 'imp':
      // These are action roles with no outgoing info — still nothing to send.
      return null;
    case 'spy': {
      // Spy sees the grimoire. Under malfunction, the grim is nominally
      // scrambled; as a simple approximation we shuffle the role labels.
      if (phase !== PHASES.FIRST_NIGHT && phase !== PHASES.NIGHT) return null;
      const labels = seatedSorted.map(x => ({ seat: x.seat + 1, name: x.name, char: x.character, team: getCharTeam(x.character), alive: x.alive }));
      if (malfunctioning) {
        const chars = shuffle(labels.map(l => l.char), rng);
        for (let i = 0; i < labels.length; i++) {
          labels[i].char = chars[i];
          labels[i].team = getCharTeam(chars[i]);
        }
      }
      const lines = labels.map(x => `${x.seat}. ${x.name} — ${getCharName(x.char) || '—'} (${x.team || '?'}${x.alive ? '' : ', dead'})`);
      return { text: `Grimoire:\n${lines.join('\n')}${malfunctionNote}`, detail: { kind: 'spy', malfunctioning } };
    }
  }
  return null;
}

// First-night mass info for evil team: minions see the demon + each other,
// demon sees the minions + 3 good-character bluffs.
function generateEvilTeamInfo(game, { rng = Math.random } = {}) {
  if (game.phase !== PHASES.FIRST_NIGHT) return [];
  const seated = game.players.filter(x => !x.isSt);
  const demon = seated.find(x => getCharTeam(x.character) === 'demon');
  const minions = seated.filter(x => getCharTeam(x.character) === 'minion');
  if (!demon) return [];
  const minionLabels = minions.map(m => `${m.name} (${getCharName(m.character)})`).join(', ') || 'none';

  // 3 bluffs drawn from good characters not in play.
  const inPlay = new Set(seated.map(s => s.character).filter(Boolean));
  const goodPool = TB.characters
    .filter(c => (c.team === 'townsfolk' || c.team === 'outsider') && !inPlay.has(c.id))
    .map(c => c.name);
  const bluffs = shuffle(goodPool, rng).slice(0, 3);

  const deliveries = [];
  // Demon gets minion names + bluffs.
  deliveries.push({
    playerId: demon.id,
    info: {
      text: `Your minions: ${minionLabels}.\n\nThree good characters NOT in play (bluffs): ${bluffs.join(', ')}.`,
      detail: { kind: 'demon-info', minions: minions.map(m => m.id), bluffs },
    },
  });
  // Each minion sees the demon + other minions.
  for (const m of minions) {
    const peers = minions.filter(mm => mm.id !== m.id).map(mm => mm.name);
    const peerLine = peers.length ? `Fellow minions: ${peers.join(', ')}.\n` : '';
    deliveries.push({
      playerId: m.id,
      info: {
        text: `The Demon is: ${demon.name} (${getCharName(demon.character)}).\n${peerLine}`,
        detail: { kind: 'minion-info', demonId: demon.id, peers: peers },
      },
    });
  }
  return deliveries;
}

// --- Redaction for over-the-wire state ---

function redactedStateFor(game, viewerId) {
  const viewer = game.players.find(p => p.id === viewerId);
  const isSt = !!(viewer && viewer.isSt);
  return {
    scriptId: game.scriptId,
    phase: game.phase,
    dayNumber: game.dayNumber,
    storytellerId: game.storytellerId,
    players: game.players.map(p => ({
      id: p.id,
      name: p.name,
      seat: p.seat,
      alive: p.alive,
      ghostVote: p.ghostVote,
      isSt: p.isSt,
      // Character visible to: self, or the ST, or everyone after game end.
      character: (isSt || p.id === viewerId || game.phase === PHASES.ENDED) ? p.character : null,
      team:      (isSt || p.id === viewerId || game.phase === PHASES.ENDED) ? p.team      : null,
      // Reminders only visible to ST
      reminders: isSt ? p.reminders : undefined,
      // Poisoned status is ST-only too; players shouldn't see their own flag.
      poisoned: isSt ? !!p.poisoned : undefined,
    })),
    nominations: game.nominations.map(n => ({
      nominator: n.nominator,
      nominee: n.nominee,
      resolved: n.resolved,
      yesCount: n.yesCount,
      // Individual votes visible after resolution (BOTC default: votes are public).
      votes: n.resolved || isSt ? n.votes : n.votes.map(v => ({ voter: v.voter, yes: undefined })),
    })),
    currentNomination: game.currentNomination ? {
      nominator: game.currentNomination.nominator,
      nominee: game.currentNomination.nominee,
      votes: game.currentNomination.votes.map(v => ({ voter: v.voter, yes: v.yes })),
    } : null,
    // Past days' nominations — votes are public after resolution, so this is
    // fine to broadcast to everyone. Storyteller only sees extras (e.g.
    // executed character id, which is also public once it happens).
    voteHistory: (game.voteHistory || []).map(d => ({
      day: d.day,
      executed: d.executed,
      nominations: d.nominations.map(n => ({
        nominator: n.nominator,
        nominee: n.nominee,
        yesCount: n.yesCount,
        threshold: n.threshold,
        resolved: n.resolved,
        votes: n.votes.map(v => ({ voter: v.voter, yes: v.yes })),
      })),
    })),
    onTheBlock: game.onTheBlock ?? null,
    log: game.log.slice(-100),
    winner: game.winner,
  };
}

function labelOf(game, id) {
  return game.players.find(p => p.id === id)?.name ?? '?';
}

function logPublic(game, text) {
  game.log.push({ ts: Date.now(), text });
}

// --- Voice channel authority ---
//
// Voice channels are derived from the game state so players can't cheat by
// flipping a local flag — the server is the source of truth for who can hear
// whom. The engine only produces rosters; transport (WebRTC signaling) is
// handled by the server in src/main/server.js.
//
// Returned shape:
//   {
//     channels: {
//       table: { id, label, speakers: [ids], listeners: [ids] },
//       evil:  { id, label, speakers, listeners },            // only during night phases
//       'whisper:<pid>': { id, label, speakers, listeners }   // opened explicitly by ST
//     },
//     perClient: { [clientId]: { channels: [ids], roleInChannel: {id: 'speak'|'listen'} } },
//   }
function computeVoiceChannels(game, openWhispers = []) {
  const channels = {};
  const isNight = game.phase === PHASES.NIGHT || game.phase === PHASES.FIRST_NIGHT;
  const seated = game.players.filter(p => !p.isSt);
  const stId = game.storytellerId;

  // TABLE — always on. Alive seated players speak; dead players + ST listen.
  {
    const speakers = seated.filter(p => p.alive).map(p => p.id);
    const listeners = [
      ...seated.filter(p => !p.alive).map(p => p.id),
      ...(stId ? [stId] : []),
    ];
    channels.table = { id: 'table', label: 'Table', speakers, listeners };
  }

  // EVIL — active during night phases once roles are dealt.
  // Alive evil speaks; dead evil listens. ST is not a member (uses whispers instead).
  if (isNight) {
    const evilSeats = seated.filter(p => p.team === 'evil');
    if (evilSeats.length > 0) {
      const speakers = evilSeats.filter(p => p.alive).map(p => p.id);
      const listeners = evilSeats.filter(p => !p.alive).map(p => p.id);
      channels.evil = { id: 'evil', label: 'Evil Team', speakers, listeners };
    }
  }

  // WHISPERS — ST ↔ single player, opened explicitly by ST.
  for (const w of openWhispers) {
    const p = game.players.find(pp => pp.id === w);
    if (!p || !stId) continue;
    const id = `whisper:${w}`;
    channels[id] = {
      id,
      label: `ST \u2194 ${p.name}`,
      speakers: [stId, w],
      listeners: [],
    };
  }

  const perClient = {};
  for (const p of game.players) perClient[p.id] = { channels: [], roleInChannel: {} };
  for (const c of Object.values(channels)) {
    for (const id of c.speakers) {
      if (!perClient[id]) continue;
      perClient[id].channels.push(c.id);
      perClient[id].roleInChannel[c.id] = 'speak';
    }
    for (const id of c.listeners) {
      if (!perClient[id]) continue;
      perClient[id].channels.push(c.id);
      perClient[id].roleInChannel[c.id] = 'listen';
    }
  }

  return { channels, perClient };
}

module.exports = {
  createGame,
  addPlayer,
  removePlayer,
  seatedPlayers,
  alivePlayers,
  assignRoles,
  startGame,
  advanceToDay,
  advanceToNight,
  openNomination,
  castVote,
  resolveNomination,
  endDay,
  stKill,
  checkWinConditions,
  redactedStateFor,
  computeSetup,
  computeVoiceChannels,
  generateAutoInfo,
  generateEvilTeamInfo,
  placeAutoReminders,
};
