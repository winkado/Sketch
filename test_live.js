const {BattleStream, Teams} = require(require('./ps.js'));
const S = require('./sim.js'); const {LiveState} = require('./live.js'); const A = require('./arena.js');
(async () => {
  const team = JSON.parse(require('fs').readFileSync('team_trickroom_v7.json'));
  const core = S.CORES[process.argv[2] || 'sunchomp']; const rng = S.mulberry(+(process.argv[3] || 7));
  const stream = new BattleStream(); const live = new LiveState(team, 'p2', 'TR');
  const chunks = []; (async () => { for await (const c of stream) chunks.push(c); })();
  stream.write(`>start ${JSON.stringify({formatid: S.FORMAT, seed: [3, 1, 4, 1]})}`);
  stream.write(`>player p1 ${JSON.stringify({name: 'META', team: Teams.pack(Teams.import(core.team.map(S.setText).join('\n\n')))})}`);
  stream.write(`>player p2 ${JSON.stringify({name: 'TR', team: Teams.pack(Teams.import(team.map(S.setText).join('\n\n')))})}`);
  let checks = 0, errs = 0, done = false, processed = 0, pending = null, quiet = 0;
  const real = () => stream.battle;
  const decide = (req) => {
    const b = live.build(req); const r = real();
    for (const p of b.p1.pokemon) { const rp = r.p2.pokemon.find(x => x.species.name === p.species.name); if (!rp) continue; checks++;
      const dh = Math.abs(p.hp / p.maxhp - rp.hp / rp.maxhp); const st1 = p.status || '', st2 = rp.fainted ? '' : (rp.status || '');
      if (dh > 0.02 || st1 !== st2 || p.isActive !== rp.isActive || JSON.stringify(p.boosts) !== JSON.stringify(rp.boosts)) { errs++; if (errs <= 6) console.log(`  MISMATCH T${b.turn} ${p.species.name}: hp ${p.hp}/${p.maxhp} vs ${rp.hp}/${rp.maxhp} status ${st1}|${st2} active ${p.isActive}|${rp.isActive} boosts ${JSON.stringify(p.boosts)} vs ${JSON.stringify(rp.boosts)}`); } }
    if (!!b.field.pseudoWeather.trickroom !== !!r.field.pseudoWeather.trickroom) { errs++; console.log(`  MISMATCH T${b.turn} trickroom ${!!b.field.pseudoWeather.trickroom} vs ${!!r.field.pseudoWeather.trickroom}`); }
    if ((b.field.weather || '') !== (r.field.weather || '')) { errs++; console.log(`  MISMATCH T${b.turn} weather '${b.field.weather}' vs '${r.field.weather}'`); }
    const oa = b.p2.active.filter(p => p && !p.fainted).map(p => p.species.name).sort().join('+'), ra = r.p1.active.filter(p => p && !p.fainted).map(p => p.species.name).sort().join('+');
    if (oa !== ra) { errs++; console.log(`  MISMATCH T${b.turn} opp actives ${oa} vs ${ra}`); }
    const st = A.stFromBattle(b, 'p1');
    const opts = {leads: ['Oranguru', 'Avalugg', 'Camerupt', 'Torkoal'], pivot: 'sinistcha'};
    let choice = process.env.SEARCH ? A.searchChoice(b, req, 'antiTR', rng) : null;
    if (!choice) choice = S.ourChoice(req, st, opts);
    stream.write('>p2 ' + choice);
  };
  const loop = async () => {
    while (!done) {
      await new Promise(r => setTimeout(r, 15));
      if (pending && processed === chunks.length) { if (++quiet >= 4) { const q = pending; pending = null; quiet = 0; decide(q); } } else quiet = 0;
      while (processed < chunks.length) {
        const chunk = chunks[processed++]; const lines = chunk.split('\n');
        if (lines[0] === 'update') {
          for (const l of lines) live.feed(l);
          if (chunk.includes('|win|') || chunk.includes('|tie|')) done = true;
        } else if (lines[0] === 'sideupdate') {
          const side = lines[1]; const rq = lines.find(l => l.startsWith('|request|')); if (!rq) continue;
          const req = JSON.parse(rq.slice(9)); if (req.wait) continue;
          if (side === 'p1') { stream.write('>p1 ' + S.oppChoice(req, A.stFromBattle(real()), core, 'antiTR', rng)); continue; }
          if (req.teamPreview) { stream.write('>p2 team 1342'); continue; }
          if (req.forceSwitch) { stream.write('>p2 ' + S.ourChoice(req, S.newState(), {})); continue; }
          pending = req;
        }
      }
    }
  };
  await Promise.race([loop(), new Promise(r => setTimeout(r, 90000))]);
  const w = (chunks.join('\n').match(/\|win\|(.*)/) || [])[1];
  console.log(`game over: winner ${w}  turns ${live.turn}  checks ${checks}  mismatches ${errs}`);
  stream.writeEnd(); process.exit(0);
})().catch(e => { console.log('ERR', e.stack.split('\n').slice(0, 6).join('\n')); process.exit(1); });
