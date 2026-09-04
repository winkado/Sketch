// predict2.js — contextual opponent-move predictor (replaces species×turn frequencies as the read).
//
//   node predict2.js train      -> models/predictor.json, prints held-out top-1/top-3 vs the frequency baseline
//   const {predictDist} = require('./predict2.js'); predictDist(ctx) -> {move: prob}
//
// For each opponent decision, the candidate set is what we could know at that moment: moves revealed so far this game
// plus that species' common moves (sets.json reveal rate >= 0.12). Each candidate gets features:
//   estimated damage into our two actives (max, min), KO threat, is-Protect, is-status, is-priority, is-spread,
//   user HP bucket, target HP bucket, used-last-turn, times-used-this-game, species prior (behaviour.json), turn, room state.
// A single weight vector scores every candidate; softmax over the set gives the distribution (conditional logit).
'use strict';
const fs = require('fs');
const path = require('path');
const {Dex} = require(require('./ps.js'));
const D = Dex.mod('champions');
const MODEL = path.join(__dirname, 'models', 'predictor.json');
const BEH = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'models', 'behaviour.json'), 'utf8')); } catch { return null; } })();
const SETS = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'models', 'sets.json'), 'utf8')); } catch { return {}; } })();
const PROTECT = new Set(['Protect', 'Detect', 'Spiky Shield', 'Baneful Bunker', "King's Shield", 'Wide Guard', 'Quick Guard']);

// cheap damage estimate (fraction of target HP) from species/base stats only — the predictor sees what a human sees
function estDmg(attacker, moveName, target) {
  const mv = D.moves.get(moveName); if (!mv.exists || mv.category === 'Status' || !mv.basePower) return 0;
  const a = D.species.get(attacker), t = D.species.get(target); if (!a.exists || !t.exists) return 0;
  if (!D.getImmunity(mv.type, t.types)) return 0;
  const eff = Math.pow(2, D.getEffectiveness(mv.type, t.types));
  const phys = mv.category === 'Physical';
  const A = a.baseStats[phys ? 'atk' : 'spa'] + 52, Df = t.baseStats[phys ? 'def' : 'spd'] + 36, HP = t.baseStats.hp + 107;
  const base = Math.floor(Math.floor(22 * mv.basePower * A / Df) / 50) + 2;
  return Math.min(2, base * 0.925 * eff * (a.types.includes(mv.type) ? 1.5 : 1) * (['allAdjacentFoes', 'allAdjacent'].includes(mv.target) ? 0.75 : 1) / HP);
}
function candidates(species, revealed) {
  const base = species.replace(/-Mega.*$/, '');
  const set = new Set(revealed);
  const s = SETS[species] || SETS[base];
  if (s) for (const [m, r] of s.moves) if (r >= 0.12) set.add(m);
  if (set.size < 2 && BEH) { const b = BEH.species[base] || BEH.species[species]; if (b) for (const tb of ['T1', 'T2-3', 'T4+']) for (const m of Object.keys(b.moves[tb] || {})) set.add(m); }
  return [...set].filter(m => D.moves.get(m).exists);
}
const hpb = (h) => h > 0.75 ? 0 : h > 0.4 ? 1 : 2;
function feats(ctx, move) {
  // ctx: {species, foes:[sp], foeHp:[..], hp, turn, tr, lastMove, usedCount:{move:n}, elo, revealed:Set}
  const mv = D.moves.get(move); const f = [];
  const dm = ctx.foes.map(sp => estDmg(ctx.species, move, sp));
  const maxD = dm.length ? Math.max(...dm) : 0, minD = dm.length ? Math.min(...dm) : 0;
  const koIdx = dm.findIndex((d, i) => d >= (ctx.foeHp[i] ?? 1));
  const isProt = PROTECT.has(move) ? 1 : 0, isStatus = mv.category === 'Status' && !isProt ? 1 : 0;
  const base = ctx.species.replace(/-Mega.*$/, ''); const pooled = BEH && (BEH.species[base] || BEH.species[ctx.species]);
  const tb = ctx.turn <= 1 ? 'T1' : ctx.turn <= 3 ? 'T2-3' : 'T4+';
  const prior = pooled ? (pooled.moves[tb] || {})[move] || 0 : 0;
  const eloS = BEH && BEH.speciesByElo[ctx.elo] && (BEH.speciesByElo[ctx.elo][base] || BEH.speciesByElo[ctx.elo][ctx.species]);
  const priorElo = eloS ? (eloS.moves[tb] || {})[move] || 0 : prior;
  f.push(1, isProt, isStatus, mv.priority > 0 ? 1 : 0, ['allAdjacentFoes', 'allAdjacent'].includes(mv.target) ? 1 : 0);
  f.push(maxD, minD, koIdx >= 0 ? 1 : 0, dm.filter(d => d >= 0.5).length / 2);
  f.push(isProt * (hpb(ctx.hp) === 2 ? 1 : 0), isProt * (ctx.turn === 1 ? 1 : 0), isProt * (ctx.tr ? 1 : 0), isProt * (ctx.lastMove && PROTECT.has(ctx.lastMove) ? 1 : 0));
  f.push(ctx.lastMove === move ? 1 : 0, Math.min(3, ctx.usedCount[move] || 0) / 3, ctx.revealed.has(move) ? 1 : 0);
  f.push(Math.log(prior + 0.01), Math.log(priorElo + 0.01));
  f.push(mv.category === 'Status' && !isProt && ctx.turn === 1 ? 1 : 0);          // setup/support on T1
  f.push(maxD * (ctx.tr ? 1 : 0), maxD * hpb(ctx.hp) / 2);
  return f;
}
let W = null;
function load() { if (W === null) { try { W = JSON.parse(fs.readFileSync(MODEL, 'utf8')).w; } catch { W = null; } } return W; }
function predictDist(ctx) {
  const w = load(); const cands = candidates(ctx.species, [...ctx.revealed]);
  if (!cands.length) return {};
  if (!w) { const out = {}; for (const c of cands) out[c] = 1 / cands.length; return out; }
  const z = cands.map(c => { const x = feats(ctx, c); let s = 0; for (let i = 0; i < w.length; i++) s += w[i] * (x[i] || 0); return s; });
  const m = Math.max(...z); const e = z.map(v => Math.exp(v - m)); const tot = e.reduce((a, b) => a + b, 0);
  const out = {}; cands.forEach((c, i) => out[c] = e[i] / tot); return out;
}

// ---------------------------------------------------------------- training
function train() {
  const {parseReplay} = require('./replays.js');
  const dirs = ['replays', 'replays/own'].map(d => path.join(__dirname, d)).filter(d => fs.existsSync(d));
  const files = dirs.flatMap(d => fs.readdirSync(d).filter(f => f.endsWith('.json')).map(f => path.join(d, f)));
  const RB = [[0, 1300, '<1300'], [1300, 1600, '1300-1599'], [1600, 1900, '1600-1899'], [1900, 9999, '1900+']];
  const elo = (r) => r == null ? 'tourney' : (RB.find(([lo, hi]) => r >= lo && r < hi) || [0, 0, '?'])[2];
  const EX = []; let games = 0;
  for (const fp of files) {
    let rep; try { rep = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { continue; }
    if (!rep.log) continue; games++;
    const st = parseReplay(rep.log, rep.players || []);
    const revealed = {}, used = {}, last = {};
    for (const a of st.actions) {
      const key = a.side + ':' + a.species;
      revealed[key] ??= new Set(); used[key] ??= {};
      if (a.kind === 'move' && a.turn >= 1) {
        const ctx = {species: a.species, foes: a.foes || [], foeHp: a.foeHp || [], hp: a.hp ?? 1, turn: a.turn, tr: !!a.tr, lastMove: last[key] || null, usedCount: used[key], elo: elo(rep.rating), revealed: revealed[key]};
        const cands = candidates(a.species, [...revealed[key]]);
        if (cands.includes(a.move) && cands.length >= 2) EX.push({X: cands.map(c => feats(ctx, c)), y: cands.indexOf(a.move), cands, prior: cands.map(c => { const base = a.species.replace(/-Mega.*$/, ''); const p = BEH && (BEH.species[base] || BEH.species[a.species]); const tb = a.turn <= 1 ? 'T1' : a.turn <= 3 ? 'T2-3' : 'T4+'; return p ? (p.moves[tb] || {})[c] || 0 : 0; })});
        revealed[key].add(a.move); used[key][a.move] = (used[key][a.move] || 0) + 1; last[key] = a.move;
      } else if (a.kind === 'switch') last[key] = 'switch';
    }
  }
  if (EX.length < 500) { console.log(`only ${EX.length} decisions from ${games} games; need more`); return; }
  // shuffle by game order: hold out the last 20%
  const cut = Math.floor(EX.length * 0.8); const d = EX[0].X[0].length;
  let w = new Array(d).fill(0); const lr = 0.03, l2 = 1e-4;
  for (let ep = 0; ep < 12; ep++) for (let i = 0; i < cut; i++) {
    const {X, y} = EX[i]; const z = X.map(x => { let s = 0; for (let j = 0; j < d; j++) s += w[j] * x[j]; return s; });
    const m = Math.max(...z); const e = z.map(v => Math.exp(v - m)); const tot = e.reduce((a, b) => a + b, 0);
    for (let k = 0; k < X.length; k++) { const g = e[k] / tot - (k === y ? 1 : 0); for (let j = 0; j < d; j++) w[j] -= lr * (g * X[k][j] + l2 * w[j] / X.length); }
  }
  const score = (rank) => { let t1 = 0, t3 = 0; for (let i = cut; i < EX.length; i++) { const r = rank(EX[i]); t1 += r[0] === EX[i].y ? 1 : 0; t3 += r.slice(0, 3).includes(EX[i].y) ? 1 : 0; } return [100 * t1 / (EX.length - cut), 100 * t3 / (EX.length - cut)]; };
  const learned = score(ex => ex.X.map((x, k) => { let s = 0; for (let j = 0; j < d; j++) s += w[j] * x[j]; return [s, k]; }).sort((a, b) => b[0] - a[0]).map(p => p[1]));
  const baseline = score(ex => ex.prior.map((p, k) => [p, k]).sort((a, b) => b[0] - a[0]).map(p => p[1]));
  console.log(`${EX.length} decisions from ${games} games. held-out top-1/top-3: contextual ${learned[0].toFixed(1)}/${learned[1].toFixed(1)}  vs frequency baseline ${baseline[0].toFixed(1)}/${baseline[1].toFixed(1)}`);
  if (learned[0] > baseline[0]) { fs.writeFileSync(MODEL, JSON.stringify({w, n: cut, games, heldout: {learned, baseline}, at: new Date().toISOString()}, null, 1)); console.log('saved models/predictor.json'); }
  else console.log('contextual model not better than frequency baseline; NOT saved');
}
module.exports = {predictDist, candidates, feats, train};
if (require.main === module && process.argv[2] === 'train') train();
