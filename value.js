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
function features(b) {
  const f = [];
  const side = (s) => {
    const alive = s.pokemon.filter(p => !p.fainted);
    const hp = alive.reduce((a, p) => a + p.hp / p.maxhp, 0);
    const act = s.active.filter(p => p && !p.fainted);
    return {alive: alive.length, hp, actHp: act.reduce((a, p) => a + p.hp / p.maxhp, 0), act,
      status: alive.filter(p => p.status).length, boosts: act.reduce((a, p) => a + Object.values(p.boosts).reduce((x, y) => x + y, 0), 0)};
  };
  const me = side(b.p1), op = side(b.p2);
  const spe = (act) => act.map(p => (p.getStat ? p.getStat('spe') : p.storedStats.spe));
  const ms = spe(me.act), os = spe(op.act);
  const tr = b.field.pseudoWeather.trickroom; const trLeft = tr ? (tr.duration || 0) : 0;
  const mySlow = ms.length && os.length && Math.max(...ms) < Math.min(...os) ? 1 : 0;
  const myFast = ms.length && os.length && Math.min(...ms) > Math.max(...os) ? 1 : 0;
  f.push(1);                                         // bias
  f.push((me.alive - op.alive) / 4);
  f.push((me.hp - op.hp) / 4);
  f.push((me.actHp - op.actHp) / 2);
  f.push(me.alive / 4, op.alive / 4);
  f.push(tr ? 1 : 0, tr ? trLeft / 5 : 0);
  f.push(tr ? mySlow : 0, tr ? -myFast : 0);        // room favours us / them
  f.push(!tr ? myFast : 0, !tr ? -mySlow : 0);      // natural speed edge without room
  f.push(b.p1.sideConditions.tailwind ? 1 : 0, b.p2.sideConditions.tailwind ? 1 : 0);
  f.push((op.status - me.status) / 4);
  f.push((me.boosts - op.boosts) / 6);
  f.push(Math.min(b.turn, 12) / 12);
  const w = b.field.weather || ''; f.push(w === 'sunnyday' ? 1 : 0, w === 'raindance' ? 1 : 0);
  f.push(b.p1.pokemon.some(p => !p.fainted && /Oranguru/.test(p.species.name)) ? 1 : 0);   // setter alive
  return f;
}
const sigmoid = (z) => 1 / (1 + Math.exp(-z));
let W = null;
function load() { if (W === null) { try { W = JSON.parse(fs.readFileSync(MODEL, 'utf8')).w; } catch { W = null; } } return W; }
function evaluate(b) {
  const w = load(); if (!w) return null;
  const x = features(b); let z = 0; for (let i = 0; i < w.length; i++) z += w[i] * (x[i] || 0);
  return sigmoid(z);
}
fs.watchFile && fs.existsSync(MODEL) && fs.watchFile(MODEL, {interval: 60000}, () => { W = null; });

// ---------------------------------------------------------------- training from own replays
function train() {
  const {LiveState} = require('./live.js');
  const S = require('./sim.js');
  const dir = path.join(__dirname, 'replays', 'own');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  const X = [], Y = [], base = [];
  let games = 0;
  for (const fname of files) {
    let rep; try { rep = JSON.parse(fs.readFileSync(path.join(dir, fname), 'utf8')); } catch { continue; }
    if (!rep.log || rep.won == null) continue;
    let team; try { team = JSON.parse(fs.readFileSync(path.join(__dirname, rep.team || 'team_trickroom_v7.json'), 'utf8')); } catch { continue; }
    const my = rep.log.includes(`|player|p2|${process.env.PS_USER || rep.players[1]}|`) ? 'p2' : 'p1';
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
          X.push(features(b)); Y.push(rep.won ? 1 : 0);
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
    const g = sigmoid(z) - Y[i];
    for (let j = 0; j < d; j++) w[j] -= lr * (g * x[j] + l2 * w[j]);
  }
  const acc = (pred) => { let c = 0; for (let i = cut; i < n; i++) c += ((pred(i) >= 0.5) === (Y[i] === 1)) ? 1 : 0; return c / (n - cut); };
  const learned = acc(i => { let z = 0; for (let j = 0; j < d; j++) z += w[j] * X[i][j]; return sigmoid(z); });
  const hand = acc(i => base[i]);
  console.log(`trained on ${cut} states (${games} games), held-out ${n - cut}: learned ${(100 * learned).toFixed(1)}% vs hand-written material ${(100 * hand).toFixed(1)}%`);
  if (learned > hand) { fs.mkdirSync(path.dirname(MODEL), {recursive: true}); fs.writeFileSync(MODEL, JSON.stringify({w, trainedOn: cut, games, heldout: {learned, hand}, at: new Date().toISOString()}, null, 1)); console.log('saved models/value.json'); }
  else console.log('learned model not better than the hand-written score on held-out states; NOT saved (search keeps the hand-written one)');
}

module.exports = {features, evaluate, train};
if (require.main === module && process.argv[2] === 'train') train();
