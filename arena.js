// arena.js — run games directly on Showdown's Battle object (no streams) so we can CLONE states
// and search. P1 policies: 'heuristic' (sim.js plan) or 'search' (expectimax over the real engine).
// P2: the sim.js heuristic opponent (antiTR|greedy) or a replay-derived model (see replays.js).
//
// usage:  node arena.js <core|all> <games> <p1=search|heuristic> <p2policy=antiTR|greedy> [teamfile] [workers]
// env:    M (our candidate joint actions, default 8)  K (opp candidates, 4)  S (rng seeds per pair, 1)  ROLL (rollout turns, 8)
'use strict';
const {Battle, Teams, PRNG} = require('../pokemon-showdown');
const S = require('./sim.js');
const fs = require('fs');
const os = require('os');
const {Worker, isMainThread, parentPort, workerData} = require('worker_threads');

const M = +(process.env.M || 8), K = +(process.env.K || 4), SEEDS = +(process.env.S || 1), ROLL = +(process.env.ROLL || 8);

// choose + flush log (Showdown throws 'Infinite loop' if >1000 unsent log lines accumulate)
function ch(b, side, choice) { const ok = b.choose(side, choice); if (!ok) b.choose(side, 'default'); b.sendUpdates(); return ok; }

// ------------------------------------------------ state adapter: Battle -> sim.js `st` shape
function stFromBattle(b) {
  const st = S.newState();
  st.turn = b.turn;
  st.tr = !!b.field.pseudoWeather.trickroom;
  st.weather = b.field.weather || '';
  for (const side of b.sides) {
    const id = side.id;
    st.faints[id] = side.pokemon.filter(p => p.fainted).length;
    for (const p of side.pokemon) {
      const rec = {nick: p.name, species: p.species.name, hp: p.hp, maxhp: p.maxhp, slot: p.isActive ? 'ab'[p.position] : '',
        taunt: p.volatiles.taunt ? 1 : 0, protectedLast: !!(p.lastMove && /protect|detect|wideguard/.test(p.lastMove.id) && p.moveThisTurnResult !== false),
        fainted: p.fainted, firstTurn: p.activeTurns <= 1 ? b.turn : 0, lastMove: p.lastMove ? p.lastMove.name : undefined, side: id};
      st.sides[id][p.name] = rec;
    }
    st.active[id] = [0, 1].map(i => { const p = side.active[i]; return p && !p.fainted ? st.sides[id][p.name] : null; });
  }
  if (st.tr) st.events.tr_up_turn = b.field.pseudoWeather.trickroom.startTurn ?? b.turn;
  return st;
}

// ------------------------------------------------ enumerate legal joint choices for a side from its request
function enumerate(req, limit) {
  if (req.teamPreview || req.forceSwitch) return null;
  const per = req.active.map((act, i) => {
    const opts = [];
    for (const m of act.moves) {
      if (m.disabled) continue;
      const t = m.target;
      if (['normal', 'any', 'adjacentFoe'].includes(t)) { opts.push(`move ${m.move} 1`); opts.push(`move ${m.move} 2`); }
      else if (t === 'adjacentAlly') opts.push(`move ${m.move} ${i === 0 ? '-2' : '-1'}`);
      else if (t === 'adjacentAllyOrSelf') { opts.push(`move ${m.move} ${i === 0 ? '-2' : '-1'}`); }
      else opts.push(`move ${m.move}`);
    }
    if (!act.trapped) req.side.pokemon.forEach((p, k) => { if (!p.active && !/fnt/.test(p.condition)) opts.push(`switch ${k + 1}`); });
    return opts;
  });
  const joint = [];
  const a = per[0] || ['pass'], bb = per[1] || ['pass'];
  for (const x of a) for (const y of bb) {
    if (x.startsWith('switch') && x === y) continue;
    joint.push(req.active.length === 2 ? `${x}, ${y}` : x);
  }
  return joint;
}

// ------------------------------------------------ evaluation: rollout with heuristics, else material
function material(b) {
  const f = (side) => side.pokemon.reduce((s, p) => s + (p.fainted ? 0 : p.hp / p.maxhp), 0) + 0.35 * side.pokemon.filter(p => !p.fainted).length;
  return f(b.p1) - f(b.p2);
}
function playout(b, oppPolicy, maxTurns) {
  const end = b.turn + maxTurns;
  let guard = 0;
  while (!b.ended && b.turn < end && guard++ < 60) {
    if (!stepHeuristics(b, oppPolicy, 'heuristic')) break;
  }
  if (b.ended) return b.winner === 'TR' ? 1 : b.winner === 'META' ? 0 : 0.5;
  return 1 / (1 + Math.exp(-1.2 * material(b)));
}
// make one decision for every side that has a pending request, using heuristics
function stepHeuristics(b, oppPolicy, p1kind, rng = Math.random) {
  let acted = false;
  for (const side of b.sides) {
    const req = side.activeRequest;
    if (!req || req.wait || side.isChoiceDone()) continue;
    const st = stFromBattle(b);
    let choice;
    try {
      choice = side.id === 'p1' ? S.ourChoice(req, st, {pivot: 'sinistcha', switchOrder: ['Camerupt', 'Torkoal', 'Slowbro', 'Farigiraf']})
                                : S.oppChoice(req, st, b._core, oppPolicy, rng);
    } catch (e) { choice = 'default'; }
    ch(b, side.id, choice);
    acted = true;
  }
  return acted;
}

// ------------------------------------------------ the search policy for P1
function searchChoice(b, req, oppPolicy, rng) {
  const ours = enumerate(req, M);
  if (!ours) return null; // team preview / force switch handled by heuristic
  const st = stFromBattle(b);
  // rank our candidates by the heuristic's own pick first, then a cheap material lookahead
  const heur = (() => { try { return S.ourChoice(req, st, {pivot: 'sinistcha'}); } catch { return null; } })();
  const cand = [...new Set([heur, ...ours].filter(Boolean))].slice(0, Math.max(M, 1) + 24);
  // opponent candidates: heuristic picks under both policies with different randomness
  const oppReq = b.p2.activeRequest;
  const oppCands = new Set();
  for (let k = 0; k < K * 3 && oppCands.size < K; k++) {
    const r = S.mulberry ? S.mulberry(k * 7919 + b.turn) : (() => { let s = k * 7919 + b.turn; return () => { s = (s * 9301 + 49297) % 233280; return s / 233280; }; })();
    try { oppCands.add(S.oppChoice(oppReq, st, b._core, k % 2 ? 'greedy' : oppPolicy, r)); } catch {}
  }
  if (!oppCands.size) oppCands.add('default');
  const oppList = [...oppCands];
  const json = JSON.stringify(b.toJSON());
  let best = null;
  // quick pre-screen of our candidates by 1-step material (cheap), keep top M
  const screened = cand.map(c => {
    let v = 0;
    for (const o of oppList.slice(0, 2)) {
      const cb = Battle.fromJSON(json); cb._core = b._core; cb.sentLogPos = cb.log.length;
      ch(cb, 'p1', c); ch(cb, 'p2', o);
      v += material(cb);
    }
    return {c, v};
  }).sort((x, y) => y.v - x.v).slice(0, M);
  for (const {c} of screened) {
    let total = 0, n = 0;
    for (const o of oppList) for (let s = 0; s < SEEDS; s++) {
      const cb = Battle.fromJSON(json); cb._core = b._core; cb.sentLogPos = cb.log.length;
      cb.prng = new PRNG([1 + s, 2 + b.turn, 3, 4 + n]);
      ch(cb, 'p1', c); ch(cb, 'p2', o);
      total += playout(cb, oppPolicy, ROLL); n++;
    }
    const v = total / n;
    if (!best || v > best.v) best = {c, v};
  }
  return best ? best.c : heur;
}

// ------------------------------------------------ one game
function runGame(core, seed, p1kind, oppPolicy, ours) {
  const rng = S.mulberry ? S.mulberry(seed) : Math.random;
  const b = new Battle({formatid: S.FORMAT, seed: [seed & 0xffff, (seed * 7 + 1) & 0xffff, (seed * 13 + 2) & 0xffff, (seed * 17 + 3) & 0xffff]});
  b._core = core;
  b.setPlayer('p1', {name: 'TR', team: Teams.import(ours.map(S.setText).join('\n\n'))});
  b.setPlayer('p2', {name: 'META', team: Teams.import(core.team.map(S.setText).join('\n\n'))});
  let guard = 0;
  const events = {};
  while (!b.ended && guard++ < 400) {
    let acted = false;
    for (const side of b.sides) {
      const req = side.activeRequest;
      if (!req || req.wait || side.isChoiceDone()) continue;
      const st = stFromBattle(b);
      let choice = null;
      if (side.id === 'p1' && p1kind === 'search') choice = searchChoice(b, req, oppPolicy, rng);
      if (!choice) {
        try { choice = side.id === 'p1' ? S.ourChoice(req, st, {pivot: 'sinistcha'}) : S.oppChoice(req, st, core, oppPolicy, rng); }
        catch { choice = 'default'; }
      }
      ch(b, side.id, choice);
      acted = true;
    }
    if (!acted) break;
    if (b.field.pseudoWeather.trickroom && events.trUp === undefined) events.trUp = b.turn - 1;
  }
  return {win: b.winner === 'TR', tie: !b.winner, turns: b.turn, trUp: events.trUp};
}

// ------------------------------------------------ parallel driver
async function main() {
  const [which = 'all', N = '100', p1kind = 'search', oppPolicy = 'antiTR', teamfile, workersArg] = process.argv.slice(2);
  const ours = teamfile ? JSON.parse(fs.readFileSync(teamfile, 'utf8')) : S.OURS;
  const workers = +(workersArg || Math.max(1, os.cpus().length - 1));
  const cores = Object.entries(S.CORES).filter(([n]) => which === 'all' || which === n);
  for (const [name, core] of cores) {
    if (!S.validate(core.team, name)) continue;
    const per = Math.ceil(+N / workers);
    const jobs = Array.from({length: workers}, (_, w) => new Promise(res => {
      const wk = new Worker(__filename, {workerData: {name, per, offset: w * per, p1kind, oppPolicy, ours}});
      wk.on('message', res); wk.on('error', e => res({err: String(e)}));
    }));
    const parts = await Promise.all(jobs);
    const agg = parts.reduce((a, p) => { if (p.err) { console.error(p.err); return a; } a.g += p.g; a.w += p.w; a.t += p.t; a.turns += p.turns; a.tr1 += p.tr1; return a; }, {g: 0, w: 0, t: 0, turns: 0, tr1: 0});
    console.log(`=== ${name}  P1=${p1kind}  P2=${oppPolicy}  n=${agg.g} ===\n  win ${(100 * agg.w / agg.g).toFixed(1)}%  tie ${(100 * agg.t / agg.g).toFixed(1)}%  TR-up-T1 ${(100 * agg.tr1 / agg.g).toFixed(1)}%  avg turns ${(agg.turns / agg.g).toFixed(1)}`);
  }
}
if (!isMainThread) {
  const {name, per, offset, p1kind, oppPolicy, ours} = workerData;
  const core = S.CORES[name];
  const out = {g: 0, w: 0, t: 0, turns: 0, tr1: 0};
  for (let i = 0; i < per; i++) {
    try {
      const r = runGame(core, 1000 * (offset + i) + 7, p1kind, oppPolicy, ours);
      out.g++; out.w += r.win ? 1 : 0; out.t += r.tie ? 1 : 0; out.turns += r.turns; out.tr1 += r.trUp === 1 ? 1 : 0;
    } catch (e) { out.err = String(e).slice(0, 200); }
  }
  parentPort.postMessage(out);
} else if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = {runGame, searchChoice, stFromBattle, enumerate};
