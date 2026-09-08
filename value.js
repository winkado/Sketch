// value.js — a learned evaluation for rollout leaves, trained on OUR OWN games.
//
//   node value.js train        -> models/value.json  (weights), prints held-out accuracy vs the hand-written score
//   const {evaluate} = require('./value.js'); evaluate(battle) -> P(we win) in [0,1]
//
// Model: logistic regression over ~20 hand features of a battle state (HP fractions, mons left, speed-control state,
// turn, threats). Trained by SGD, no dependencies. Labels: did we win the game the state came from.
// States are sampled from every turn of every replay in replays/own, reconstructed with live.js exactly the way the
// bot sees them during play, so train/serve features are identical.
// This is the piece that makes the player improve from its own games: the manager refits it on every refresh.
'use strict';
const fs = require('fs');
const path = require('path');
const MODEL = path.join(__dirname, 'models', 'value.json');

// ---------------------------------------------------------------- features from a Battle (we are p1)
const FEATURE_NAMES = ['bias','alive_diff','hp_diff','active_hp_diff','our_alive','their_alive','room_up','room_left','room_favours_us','room_favours_them','fast_no_room','slow_no_room','our_tailwind','their_tailwind','status_diff','boost_diff','turn','sun','rain','setter_alive',
  'our_ko_threats','their_ko_threats','our_best_dmg','their_best_dmg','our_2hko_cover','kills_needed_vs_room','sweeper_ok','our_protects','their_protects','our_redirect','their_redirect','our_priority_threat','their_priority_threat','our_sash_herb','their_items_left','we_forced','they_forced','our_speed_edge_room'];
function features(b) {
  const S = require('./sim.js'); const A = require('./arena.js');
  const st = A.stFromBattle(b, 'p1');
  const f = [];
  const side = (s) => {
    const alive = s.pokemon.filter(p => !p.fainted);
    const hp = alive.reduce((a, p) => a + p.hp / p.maxhp, 0);
    const act = s.active.filter(p => p && !p.fainted);
    return {alive: alive.length, hp, actHp: act.reduce((a, p) => a + p.hp / p.maxhp, 0), act, all: s.pokemon,
      status: alive.filter(p => p.status).length, boosts: act.reduce((a, p) => a + Object.values(p.boosts).reduce((x, y) => x + y, 0), 0)};
  };
  const me = side(b.p1), op = side(b.p2);
  const spe = (act) => act.map(p => (p.getStat ? p.getStat('spe') : p.storedStats.spe));
  const ms = spe(me.act), os = spe(op.act);
  const tr = b.field.pseudoWeather.trickroom; const trLeft = tr ? (tr.duration || 0) : 0;
  const mySlow = ms.length && os.length && Math.max(...ms) < Math.min(...os) ? 1 : 0;
  const myFast = ms.length && os.length && Math.min(...ms) > Math.max(...os) ? 1 : 0;
  f.push(1);
  f.push((me.alive - op.alive) / 4, (me.hp - op.hp) / 4, (me.actHp - op.actHp) / 2, me.alive / 4, op.alive / 4);
  f.push(tr ? 1 : 0, tr ? trLeft / 5 : 0, tr ? mySlow : 0, tr ? -myFast : 0, !tr ? myFast : 0, !tr ? -mySlow : 0);
  f.push(b.p1.sideConditions.tailwind ? 1 : 0, b.p2.sideConditions.tailwind ? 1 : 0);
  f.push((op.status - me.status) / 4, (me.boosts - op.boosts) / 6, Math.min(b.turn, 12) / 12);
  const w = b.field.weather || ''; f.push(w === 'sunnyday' ? 1 : 0, w === 'raindance' ? 1 : 0);
  f.push(me.all.some(p => !p.fainted && /Oranguru|Alakazam/.test(p.species.name)) ? 1 : 0);
  // ---- threat matrix (approximate, fast): best % damage between every active pair
  const ourAct = st.active.p1.filter(Boolean), theirAct = st.active.p2.filter(Boolean);
  const movesOf = (p) => p.moveSlots.map(m => m.move);
  const rec = (r) => r;
  let ourKO = 0, theirKO = 0, ourBest = 0, theirBest = 0, our2hko = 0;
  const pokeByRec = (sideObj, r) => sideObj.active.find(p => p && p.species.name === r.species) || sideObj.pokemon.find(p => p.species.name === r.species);
  for (const a of ourAct) { const pa = pokeByRec(b.p1, a); if (!pa) continue; for (const d of theirAct) { let best = 0; for (const mv of movesOf(pa)) { try { best = Math.max(best, S.estPct(a, mv, d, st, false)); } catch {} } ourBest = Math.max(ourBest, best); if (best >= 100 * d.hp / d.maxhp) ourKO++; else if (2 * best >= 100 * d.hp / d.maxhp) our2hko++; } }
  for (const d of theirAct) { const pd = pokeByRec(b.p2, d); if (!pd) continue; for (const a of ourAct) { let best = 0; for (const mv of movesOf(pd)) { try { best = Math.max(best, S.estPct(d, mv, a, st, false)); } catch {} } theirBest = Math.max(theirBest, best); if (best >= 100 * a.hp / a.maxhp) theirKO++; } }
  f.push(ourKO / 4, theirKO / 4, Math.min(ourBest, 150) / 150, Math.min(theirBest, 150) / 150, our2hko / 4);
  // ---- tempo: kills needed vs room turns left; sweeper health
  const killsNeeded = op.alive; f.push(tr && mySlow ? Math.max(0, (killsNeeded - trLeft)) / 4 : 0);
  const sweepers = me.all.filter(p => !p.fainted && /Camerupt|Torkoal|Ampharos|Avalugg|Crabominable|Tinkaton/.test(p.species.name)); f.push(sweepers.length ? Math.max(...sweepers.map(p => p.hp / p.maxhp)) : 0);
  // ---- defensive resources
  const prot = (act) => act.filter(p => p.moveSlots.some(m => /protect|detect|wideguard/.test(m.id) && m.pp > 0) && !(p.volatiles && p.volatiles.stall)).length;
  f.push(prot(me.act) / 2, prot(op.act) / 2);
  const redir = (act) => act.some(p => p.moveSlots.some(m => /followme|ragepowder/.test(m.id))) ? 1 : 0;
  f.push(redir(me.act), redir(op.act));
  const prio = (act, foes) => act.some(p => p.moveSlots.some(m => { const mv = b.dex.moves.get(m.id); return mv.priority > 0 && mv.category !== 'Status'; })) ? 1 : 0;
  f.push(prio(me.act, op.act), prio(op.act, me.act));
  f.push(me.all.filter(p => !p.fainted && /focussash|mentalherb|lumberry/.test(p.item)).length / 2, op.all.filter(p => !p.fainted && p.item).length / 4);
  // ---- initiative: a side is forced if one of its actives would be KO'd by the opposing best hit and cannot Protect
  const forced = (act, kos, protAvail) => act.length && kos > 0 && protAvail === 0 ? 1 : 0;
  f.push(forced(me.act, theirKO, prot(me.act)), forced(op.act, ourKO, prot(op.act)));
  f.push(tr ? (ms.length && os.length ? (Math.min(...os) - Math.max(...ms)) / 100 : 0) : 0);
  return f;
}
function explainEval(b) {
  const w = load(); if (!w) return null; const x = features(b); const contrib = FEATURE_NAMES.map((n, i) => [n, +((w[i] || 0) * (x[i] || 0)).toFixed(3)]).filter(c => Math.abs(c[1]) >= 0.05).sort((a, b2) => Math.abs(b2[1]) - Math.abs(a[1]));
  return {p: +(evaluate(b) || 0).toFixed(3), top: contrib.slice(0, 6)};
}
const sigmoid = (z) => 1 / (1 + Math.exp(-z));
let W = null;
function load() { if (W === null) { try { W = JSON.parse(fs.readFileSync(MODEL, 'utf8')).w; } catch { W = null; } } return W; }
function evaluate(b) {
  try { const NN = require('./nn.js'); if (NN.hasValue()) { const p = NN.valueProb(features(b)); if (p != null) return p; } } catch {}
  const w = load(); if (!w) return null;
  const x = features(b); let z = 0; for (let i = 0; i < w.length; i++) z += w[i] * (x[i] || 0);
  return sigmoid(z);
}
fs.watchFile && fs.existsSync(MODEL) && fs.watchFile(MODEL, {interval: 60000}, () => { W = null; });

// ---------------------------------------------------------------- training from own replays
function train() {
  const {LiveState} = require('./live.js');
  const S = require('./sim.js');
  const dirs = [[path.join(__dirname, 'replays', 'own'), 1.0], [path.join(__dirname, 'replays', 'selfplay'), 0.5]].filter(([d]) => fs.existsSync(d));
  const files = dirs.flatMap(([d, w]) => fs.readdirSync(d).filter(f => f.endsWith('.json')).map(f => ({p: path.join(d, f), w})));
  const X = [], Y = [], base = [], WGT = [];
  let games = 0;
  for (const {p: fpath, w: wgt} of files) {
    let rep; try { rep = JSON.parse(fs.readFileSync(fpath, 'utf8')); } catch { continue; }
    if (!rep.log || rep.won == null) continue;
    let team; try { team = JSON.parse(fs.readFileSync(path.join(__dirname, rep.team || 'team_trickroom_v7.json'), 'utf8')); } catch { continue; }
    const my = rep.selfplay ? 'p1' : (rep.log.includes(`|player|p2|${process.env.PS_USER || rep.players[1]}|`) ? 'p2' : 'p1');
    const live = new LiveState(team, my, process.env.PS_USER || rep.players[my === 'p1' ? 0 : 1]);
    live.rng = () => 0.5;
    let turn = 0, ok = 0;
    for (const l of rep.log.split('\n')) {
      live.feed(l);
      if (l.startsWith('|turn|')) {
        turn = +l.split('|')[2]; if (turn < 2) continue;
        try {
          const fakeReq = {side: {pokemon: team.map(t => ({details: t.name}))}};
          const b = live.build(fakeReq);
          X.push(features(b)); Y.push(rep.won ? 1 : 0); WGT.push(wgt);
          const A = require('./arena.js'); base.push(sigmoid(1.2 * A.material(b)));
          ok++;
        } catch {}
      }
    }
    if (ok) games++;
  }
  if (X.length < 200) { console.log(`only ${X.length} states from ${games} games; need more games before training`); return; }
  // shuffle, hold out 20% by game order (approx: last 20% of rows)
  const n = X.length, cut = Math.floor(n * 0.8);
  const d = X[0].length; let w = new Array(d).fill(0);
  const lr = 0.05, l2 = 1e-3, epochs = 40;
  for (let e = 0; e < epochs; e++) for (let i = 0; i < cut; i++) {
    const x = X[i]; let z = 0; for (let j = 0; j < d; j++) z += w[j] * x[j];
    const g = (sigmoid(z) - Y[i]) * WGT[i];
    for (let j = 0; j < d; j++) w[j] -= lr * (g * x[j] + l2 * w[j]);
  }
  const acc = (pred) => { let c = 0; for (let i = cut; i < n; i++) c += ((pred(i) >= 0.5) === (Y[i] === 1)) ? 1 : 0; return c / (n - cut); };
  const learned = acc(i => { let z = 0; for (let j = 0; j < d; j++) z += w[j] * X[i][j]; return sigmoid(z); });
  const hand = acc(i => base[i]);
  console.log(`trained on ${cut} states (${games} games incl. self-play), held-out ${n - cut}: learned ${(100 * learned).toFixed(1)}% vs hand-written material ${(100 * hand).toFixed(1)}%`);
  if (learned > hand) { fs.mkdirSync(path.dirname(MODEL), {recursive: true}); fs.writeFileSync(MODEL, JSON.stringify({w, trainedOn: cut, games, heldout: {learned, hand}, at: new Date().toISOString()}, null, 1)); console.log('saved models/value.json'); }
  else console.log('learned model not better than the hand-written score on held-out states; NOT saved (search keeps the hand-written one)');
}

module.exports = {features, evaluate, train, explainEval, FEATURE_NAMES};
if (require.main === module && process.argv[2] === 'train') train();
