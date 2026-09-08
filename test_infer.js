const {BattleStream, Teams, getPlayerStreams} = require(require('./ps.js')); const S = require('./sim.js'); const {LiveState} = require('./live.js'); const A = require('./arena.js');
(async () => {
  const team = JSON.parse(require('fs').readFileSync('team_main.json')); const core = S.CORES[process.argv[2] || 'sunchomp']; const rng = S.mulberry(+(process.argv[3] || 3));
  const stream = new BattleStream(); const streams = getPlayerStreams(stream); const live = new LiveState(team, 'p2', 'TR');
  const p1q = [], p2q = []; let done = false, hidden = null;
  (async () => { for await (const c of streams.p1) p1q.push(c); })();
  (async () => { for await (const c of streams.p2) p2q.push(c); })();
  (async () => { for await (const c of streams.omniscient) { if (c.includes('|win|') || c.includes('|tie|')) done = true; } })();
  streams.omniscient.write(`>start ${JSON.stringify({formatid: S.FORMAT, seed: [3, 1, 4, 1]})}`);
  streams.omniscient.write(`>player p1 ${JSON.stringify({name: 'META', team: Teams.pack(Teams.import(core.team.map(S.setText).join('\n\n')))})}`);
  streams.omniscient.write(`>player p2 ${JSON.stringify({name: 'TR', team: Teams.pack(Teams.import(team.map(S.setText).join('\n\n')))})}`);
  let pending = null, quiet = 0, i1 = 0, i2 = 0;
  const loop = async () => { while (!done) { await new Promise(r => setTimeout(r, 15));
    let moved = false;
    while (i1 < p1q.length) { const c = p1q[i1++]; moved = true; for (const l of c.split('\n')) if (l.startsWith('|request|')) { const req = JSON.parse(l.slice(9)); if (!req.wait) streams.p1.write(S.oppChoice(req, A.stFromBattle(stream.battle), core, 'antiTR', rng)); } }
    while (i2 < p2q.length) { const c = p2q[i2++]; moved = true; for (const l of c.split('\n')) { if (l.startsWith('|request|')) { const req = JSON.parse(l.slice(9)); if (req.wait) continue; if (req.teamPreview) streams.p2.write('team 1234'); else if (req.forceSwitch) streams.p2.write(S.ourChoice(req, S.newState(), {})); else pending = req; } else live.feed(l); } }
    if (pending && !moved) { if (++quiet >= 4) { const q = pending; pending = null; quiet = 0; const b = live.build(q); streams.p2.write(S.ourChoice(q, A.stFromBattle(b, 'p1'), {leads: ['Oranguru', 'Sinistcha'], pivot: 'sinistcha'})); } } else quiet = 0; } };
  await Promise.race([loop(), new Promise(r => setTimeout(r, 60000))]);
  console.log(`game over after ${live.turn} turns. inferred vs TRUE stats (90% interval ~ estimate / TRUE):`);
  for (const set of core.team) { const inf = live.inferredSpread(set.name); if (!inf) continue; const tp = stream.battle.p1.pokemon.find(p => p.species.name === set.name); if (!tp) continue;
    console.log(`  ${set.name.padEnd(16)} obs=${inf.observations}  ` + ['hp', 'atk', 'def', 'spa', 'spd', 'spe'].map(k => `${k}:${inf.summary[k].ci90[0]}-${inf.summary[k].ci90[1]}~${inf.summary[k].value}/${k === 'hp' ? tp.maxhp : tp.storedStats[k]}`).join(' ')); }
  process.exit(0);
})();
