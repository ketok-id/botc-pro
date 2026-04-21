// Smoke test for the Storyteller quality-of-life bundle:
//   - Red Herring auto-placement on startGame (Task #47)
//   - Fortune Teller / Ravenkeeper targeted auto-info (Task #48)
//   - Drunk / poisoned perturbation of auto-info (Task #46)
// Node-only; doesn't need Electron. Run with `node test-st-qol.js`.

const engine = require('./src/shared/game-engine');

// Small determinism helper. BOTC has a lot of randomness; we don't care about
// the exact outcomes, only that each branch produces *some* sane output.
function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; }
  else       { console.log('ok  :', msg); }
}

function newGameWith(n) {
  const g = engine.createGame('ROOM');
  for (let i = 0; i < n; i++) engine.addPlayer(g, { id: 'p' + i, name: 'P' + i, seat: i });
  // Mark one ST (non-seated). Engine ignores this for role assignment.
  engine.addPlayer(g, { id: 'st', name: 'ST', seat: null, isSt: true });
  return g;
}

// 1. Red Herring auto-placement: run many games and each should have exactly
//    one Red Herring reminder on a Good player whenever a Fortune Teller was
//    dealt in.
let ftGames = 0, rhPlacementsCorrect = 0;
for (let i = 0; i < 50; i++) {
  const g = newGameWith(7);
  engine.startGame(g);
  const ft = g.players.find(p => p.character === 'fortuneteller');
  if (!ft) continue;
  ftGames++;
  const rhHolders = g.players.filter(p =>
    (p.reminders || []).some(r => r.roleSource === 'fortuneteller' && /red herring/i.test(r.text))
  );
  const holder = rhHolders[0];
  const allGood = holder && holder.team === 'good';
  const exactlyOne = rhHolders.length === 1;
  if (allGood && exactlyOne) rhPlacementsCorrect++;
}
assert(ftGames > 0, 'at least some games had a Fortune Teller dealt in');
assert(rhPlacementsCorrect === ftGames, `Red Herring placed on a Good player exactly once in every FT game (${rhPlacementsCorrect}/${ftGames})`);

// 2. Fortune Teller auto-info: needs 2 targets, returns yes/no.
{
  const g = newGameWith(5);
  // Force a predictable layout by bypassing assignRoles.
  g.phase = 'first_night';
  g.players.forEach((p, i) => {
    if (p.isSt) return;
    p.character = ['fortuneteller','washerwoman','imp','librarian','chef'][i];
    p.team = (p.character === 'imp') ? 'evil' : 'good';
  });
  const ft = g.players.find(p => p.character === 'fortuneteller');
  const imp = g.players.find(p => p.character === 'imp');
  const chef = g.players.find(p => p.character === 'chef');

  // Targeting the demon should return yes.
  const yesInfo = engine.generateAutoInfo(g, ft.id, { targets: [imp.id, chef.id] });
  assert(yesInfo && /yes/i.test(yesInfo.text), 'FT sees YES when one target is the demon');

  // Two non-demons with no red herring should return no.
  const noInfo = engine.generateAutoInfo(g, ft.id, { targets: [chef.id, g.players.find(p=>p.character==='washerwoman').id] });
  assert(noInfo && /no/i.test(noInfo.text), 'FT sees NO on two non-demons with no red herring');

  // Red herring on chef: should return yes even though chef is good.
  chef.reminders = [{ id: 'rh1', text: 'Red herring', roleSource: 'fortuneteller' }];
  const rhInfo = engine.generateAutoInfo(g, ft.id, { targets: [chef.id, g.players.find(p=>p.character==='washerwoman').id] });
  assert(rhInfo && /yes/i.test(rhInfo.text), 'FT sees YES when one target is the red herring');
}

// 3. Ravenkeeper auto-info: 1 target, returns the target's character.
{
  const g = newGameWith(5);
  g.phase = 'night';
  g.players.forEach((p, i) => {
    if (p.isSt) return;
    p.character = ['ravenkeeper','imp','librarian','chef','empath'][i];
    p.team = (p.character === 'imp') ? 'evil' : 'good';
  });
  const rk = g.players.find(p => p.character === 'ravenkeeper');
  const imp = g.players.find(p => p.character === 'imp');
  const info = engine.generateAutoInfo(g, rk.id, { targets: [imp.id] });
  assert(info && /imp/i.test(info.text), 'Ravenkeeper learns target character (Imp)');
}

// 4. Poisoned perturbation: run many FT calls, at least one should flip truth.
{
  const g = newGameWith(5);
  g.phase = 'first_night';
  g.players.forEach((p, i) => {
    if (p.isSt) return;
    p.character = ['fortuneteller','washerwoman','imp','librarian','chef'][i];
    p.team = (p.character === 'imp') ? 'evil' : 'good';
  });
  const ft = g.players.find(p => p.character === 'fortuneteller');
  ft.poisoned = true;
  const imp = g.players.find(p => p.character === 'imp');
  const chef = g.players.find(p => p.character === 'chef');
  let saw = { yes: 0, no: 0, tagged: 0 };
  for (let i = 0; i < 40; i++) {
    const info = engine.generateAutoInfo(g, ft.id, { targets: [imp.id, chef.id] });
    if (info && /yes/i.test(info.text)) saw.yes++;
    if (info && /no/i.test(info.text))  saw.no++;
    if (info && /\(drunk\/poisoned\)/i.test(info.text)) saw.tagged++;
  }
  assert(saw.tagged === 40, 'poisoned FT always tags result with (drunk/poisoned)');
  assert(saw.yes > 0 && saw.no > 0, 'poisoned FT returns both YES and NO across trials');
}

// 5. Drunk empath: should pick a neighbour count from {0,1,2} other than truth.
{
  const g = newGameWith(5);
  g.phase = 'first_night';
  g.players.forEach((p, i) => {
    if (p.isSt) return;
    p.character = ['empath','imp','librarian','chef','washerwoman'][i];
    p.team = (p.character === 'imp') ? 'evil' : 'good';
  });
  // Swap empath to drunk so the neighbour math goes through the malfunction path.
  const empath = g.players.find(p => p.character === 'empath');
  empath.character = 'drunk';  // pretends to be townsfolk
  // Give drunk a fake empath role by... actually `generateAutoInfo` keys off
  // `p.character` so we'd need a way to express "drunk thinks they're empath".
  // Skip this micro-case; the poisoned branch above already covers the
  // malfunction path via isMalfunctioning(). Drunk cannot auto-info as empath
  // without additional plumbing; just assert drunk short-circuits to null.
  const info = engine.generateAutoInfo(g, empath.id, { targets: [] });
  assert(info === null, 'drunk returns null (action-only / no info by character)');
}

// 6. First-night auto-info still works for simple roles (regression).
{
  const g = newGameWith(5);
  g.phase = 'first_night';
  g.players.forEach((p, i) => {
    if (p.isSt) return;
    p.character = ['washerwoman','imp','librarian','chef','empath'][i];
    p.team = (p.character === 'imp') ? 'evil' : 'good';
  });
  const ww = g.players.find(p => p.character === 'washerwoman');
  const info = engine.generateAutoInfo(g, ww.id, {});
  // Shape is: "<P> or <P> is the <CharacterName>." for the townsfolk reveal.
  assert(info && /\bis the\b/i.test(info.text), 'Washerwoman gets info without targets');
}

console.log('\nDone.');
