// Trouble Brewing — 22 core characters.
// Ability text is the short reminder text; see ../../../docs/rules.md for longer rules.
// This is a fan-made unofficial implementation. Blood on the Clocktower is © The Pandemonium Institute.

const CHARS = [
  // ---- Townsfolk (13) ----
  { id: 'washerwoman',   name: 'Washerwoman',   team: 'townsfolk', ability: 'You start knowing that 1 of 2 players is a particular Townsfolk.' },
  { id: 'librarian',     name: 'Librarian',     team: 'townsfolk', ability: 'You start knowing that 1 of 2 players is a particular Outsider. (Or that zero are in play.)' },
  { id: 'investigator',  name: 'Investigator',  team: 'townsfolk', ability: 'You start knowing that 1 of 2 players is a particular Minion.' },
  { id: 'chef',          name: 'Chef',          team: 'townsfolk', ability: 'You start knowing how many pairs of evil players there are.' },
  { id: 'empath',        name: 'Empath',        team: 'townsfolk', ability: 'Each night, you learn how many of your 2 alive neighbours are evil.' },
  { id: 'fortuneteller', name: 'Fortune Teller',team: 'townsfolk', ability: 'Each night, choose 2 players: you learn if either is a Demon. There is 1 good player that registers as a Demon to you.' },
  { id: 'undertaker',    name: 'Undertaker',    team: 'townsfolk', ability: 'Each night*, you learn which character died by execution today.' },
  { id: 'monk',          name: 'Monk',          team: 'townsfolk', ability: 'Each night*, choose a player (not yourself): they are safe from the Demon tonight.' },
  { id: 'ravenkeeper',   name: 'Ravenkeeper',   team: 'townsfolk', ability: 'If you die at night, you are woken to choose a player: you learn their character.' },
  { id: 'virgin',        name: 'Virgin',        team: 'townsfolk', ability: 'The 1st time you are nominated, if the nominator is a Townsfolk, they are executed immediately.' },
  { id: 'slayer',        name: 'Slayer',        team: 'townsfolk', ability: 'Once per game, during the day, publicly choose a player: if they are the Demon, they die.' },
  { id: 'soldier',       name: 'Soldier',       team: 'townsfolk', ability: 'You are safe from the Demon.' },
  { id: 'mayor',         name: 'Mayor',         team: 'townsfolk', ability: 'If only 3 players live & no execution occurs, your team wins. If you die at night, another player might die instead.' },

  // ---- Outsiders (4) ----
  { id: 'butler',        name: 'Butler',        team: 'outsider',  ability: 'Each night, choose a player (not yourself): tomorrow, you may only vote if they are voting too.' },
  { id: 'drunk',         name: 'Drunk',         team: 'outsider',  ability: 'You do not know you are the Drunk. You think you are a Townsfolk, but you are not.' },
  { id: 'recluse',       name: 'Recluse',       team: 'outsider',  ability: 'You might register as evil & as a Minion or Demon, even if dead.' },
  { id: 'saint',         name: 'Saint',         team: 'outsider',  ability: 'If you die by execution, your team loses.' },

  // ---- Minions (4) ----
  { id: 'poisoner',      name: 'Poisoner',      team: 'minion',    ability: 'Each night, choose a player: they are poisoned tonight and tomorrow day.' },
  { id: 'spy',           name: 'Spy',           team: 'minion',    ability: 'Each night, you see the Grimoire. You might register as good & as a Townsfolk or Outsider, even if dead.' },
  { id: 'scarletwoman',  name: 'Scarlet Woman', team: 'minion',    ability: 'If there are 5 or more players alive & the Demon dies, you become the Demon. (Travellers don’t count.)' },
  { id: 'baron',         name: 'Baron',         team: 'minion',    ability: 'There are extra Outsiders in play. [+2 Outsiders]' },

  // ---- Demon (1) ----
  { id: 'imp',           name: 'Imp',           team: 'demon',     ability: 'Each night*, choose a player: they die. If you kill yourself this way, a Minion becomes the Imp.' },
];

// Official Trouble Brewing setup: [townsfolk, outsiders, minions, demons] keyed by total players.
// Baron modifies this on the fly (+2 Outsiders, -2 Townsfolk).
const SETUP = {
  5:  [3, 0, 1, 1],
  6:  [3, 1, 1, 1],
  7:  [5, 0, 1, 1],
  8:  [5, 1, 1, 1],
  9:  [5, 2, 1, 1],
  10: [7, 0, 2, 1],
  11: [7, 1, 2, 1],
  12: [7, 2, 2, 1],
  13: [9, 0, 3, 1],
  14: [9, 1, 3, 1],
  15: [9, 2, 3, 1],
};

// Night order. Lower numbers wake first.
// `firstNight: 0` means the character does not act on the first night.
// `otherNight: 0` means the character does not act on subsequent nights.
const NIGHT_ORDER = {
  // Special "pseudo-characters" that book-end information phases:
  minionInfo:   { firstNight: 5,  otherNight: 0 },
  demonInfo:    { firstNight: 8,  otherNight: 0 },
  dusk:         { firstNight: 1,  otherNight: 1 },
  dawn:         { firstNight: 99, otherNight: 99 },

  poisoner:     { firstNight: 17, otherNight: 7 },
  spy:          { firstNight: 51, otherNight: 48 },
  washerwoman:  { firstNight: 32, otherNight: 0 },
  librarian:    { firstNight: 33, otherNight: 0 },
  investigator: { firstNight: 34, otherNight: 0 },
  chef:         { firstNight: 36, otherNight: 0 },
  empath:       { firstNight: 37, otherNight: 37 },
  fortuneteller:{ firstNight: 38, otherNight: 38 },
  butler:       { firstNight: 50, otherNight: 50 },

  monk:         { firstNight: 0,  otherNight: 12 },
  scarletwoman: { firstNight: 0,  otherNight: 19 },
  imp:          { firstNight: 0,  otherNight: 24 },
  ravenkeeper:  { firstNight: 0,  otherNight: 42 },
  undertaker:   { firstNight: 0,  otherNight: 46 },

  // Passive / no-night-action:
  drunk:        { firstNight: 0, otherNight: 0 },
  recluse:      { firstNight: 0, otherNight: 0 },
  saint:        { firstNight: 0, otherNight: 0 },
  baron:        { firstNight: 0, otherNight: 0 },
  virgin:       { firstNight: 0, otherNight: 0 },
  slayer:       { firstNight: 0, otherNight: 0 },
  soldier:      { firstNight: 0, otherNight: 0 },
  mayor:        { firstNight: 0, otherNight: 0 },
};

const SCRIPT = {
  id: 'trouble-brewing',
  name: 'Trouble Brewing',
  edition: 'Official',
  description: 'The beginner-friendly official edition of Blood on the Clocktower.',
  characters: CHARS,
  setup: SETUP,
  nightOrder: NIGHT_ORDER,
  minPlayers: 5,
  maxPlayers: 15,
};

module.exports = { SCRIPT, CHARS, SETUP, NIGHT_ORDER };
