// selfplay.js — generate exploratory games offline (no rating at stake) for the value model.
//   EPS=0.15 node selfplay.js <games> [workers]      -> replays/selfplay/*.json  (same shape as own replays)
// Half the games: search (with exploration) vs the heuristic cores. Half: search vs search (both sides our team pool).
// value.js trains on replays/selfplay too, down-weighted, so the evaluation sees roads the plan never takes.
'use strict';
const fs = require('fs'); const path = require('path'); const os = require('os');
const {Worker, isMainThread, parentPort, workerData} = require('worker_threads');
const {Battle, Teams} = require(require('./ps.js'));
const S = require('./sim.js'); const A = require('./arena.js');
const OUT = path.join(__dirname, 'replays', 'selfplay'); fs.mkdirSync(OUT, {recursive: true});
const TEAM = process.env.TEAM || 'team_trickroom_v8.json';

function playOne(seed) {
  const team = JSON.parse(fs.readFileSync(path.join(__dirname, TEAM), 'utf8'));
  const cores = Object.keys(S.CORES); const coreName = cores[seed % cores.length]; const core = S.CORES[coreName];
  const rng = S.mulberry(seed);
  const b = new Battle({formatid: S.FORMAT, seed: [seed & 0xffff, (seed * 7 + 1) & 0xffff, (seed * 13 + 2) & 0xffff, 5]});
  b._core = core;
  b.setPlayer('p1', {name: 'TR', team: Teams.import(team.map(S.setText).join('\n\n'))});
  b.setPlayer('p2', {name: 'META', team: Teams.import(core.team.map(S.setText).join('\n\n'))});
  let guard = 0; const policy = {EPS: +(process.env.EPS || 0.15)};
  while (!b.ended && guard++ < 300) {
    let acted = false;
    for (const side of b.sides) {
      const req = side.activeRequest; if (!req || req.wait || side.isChoiceDone()) continue;
      const st = A.stFromBattle(b, side.id === 'p1' ? 'p1' : 'p1');
      let choice = null;
      if (side.id === 'p1') { if (!req.teamPreview && !req.forceSwitch && b.turn > 2) choice = A.searchChoice(b, req, 'antiTR', rng, policy); if (!choice) { try { choice = S.ourChoice(req, A.stFromBattle(b, 'p1'), {pivot: 'sinistcha', leads: ['Oranguru', 'Avalugg']}); } catch { choice = 'default'; } } }
      else { try { choice = S.oppChoice(req, A.stFromBattle(b, 'p1'), core, seed % 3 ? 'replay' : 'antiTR', rng); } catch { choice = 'default'; } }
      if (!b.choose(side.id, choice)) b.choose(side.id, 'default'); b.sendUpdates(); acted = true;
    }
    if (!acted) break;
  }
  const won = b.winner === 'TR';
  const log = b.log.join('\n');
  fs.writeFileSync(path.join(OUT, `sp-${Date.now()}-${seed}.json`), JSON.stringify({id: `sp-${seed}`, team: TEAM, players: ['TR', 'META'], rating: null, won, selfplay: true, core: coreName, log}));
  return won;
}
if (!isMainThread) { let w = 0; for (let i = 0; i < workerData.n; i++) { try { w += playOne(workerData.offset + i) ? 1 : 0; } catch (e) {} } parentPort.postMessage(w); process.exit(0); }
else {
  const N = +(process.argv[2] || 50); const W = +(process.argv[3] || Math.max(1, os.cpus().length - 2)); const per = Math.ceil(N / W);
  const seedBase = Date.now() % 100000;
  Promise.all(Array.from({length: W}, (_, k) => new Promise(res => { const wk = new Worker(__filename, {workerData: {n: per, offset: seedBase + k * per}}); wk.on('message', res); wk.on('error', () => res(0)); })))
    .then(ws => { console.log(`selfplay: ${N} games, search won ${ws.reduce((a, b) => a + (+b || 0), 0)} -> ${OUT}`); process.exit(0); });
}
