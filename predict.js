// predict.js — the prediction-engine metric. Needs replays/*.json (run in the Codespace).
//
//   node predict.js            -> models/predict_report.json + console summary
//
// For every decision a real player made, predict a distribution over the moves that species has
// *revealed so far in this game* (plus its unrevealed learnset at low weight), from:
//   P0  uniform over revealed moves                              (floor)
//   P1  behaviour.json species x turn-bucket frequencies         (what we have now)
//   P2  P1 + Trick Room conditioning (protect rate under TR)      (cheap context)
//   P3  P2 + Elo bucket of the replay                             (your "1500 != 2000" point)
// Score: top-1 and top-3 accuracy, overall / by Elo bucket / by species. A model that doesn't beat
// P0 is not a model. Switch decisions are scored separately (predicted iff switchRate > 0.25).
'use strict';
const fs = require('fs');
const path = require('path');
const {parseReplay} = require('./replays.js');
const DIR = path.join(__dirname, 'replays'), OUT = path.join(__dirname, 'models');
const BEH = JSON.parse(fs.readFileSync(path.join(OUT, 'behaviour.json'), 'utf8'));
const RATING_BUCKETS = [[0, 1300, '<1300'], [1300, 1600, '1300-1599'], [1600, 1900, '1600-1899'], [1900, 9999, '1900+']];
const eloBucket = (r) => r == null ? 'tourney' : (RATING_BUCKETS.find(([lo, hi]) => r >= lo && r < hi) || [0, 0, '?'])[2];
const tb = (t) => t <= 1 ? 'T1' : t <= 3 ? 'T2-3' : 'T4+';
const PROTECT = new Set(['Protect', 'Detect', 'Spiky Shield', 'Baneful Bunker', "King's Shield", 'Wide Guard']);

function dist(species, turn, tr, elo, revealed, level) {
  const base = species.replace(/-Mega.*$/, '');
  const pooled = BEH.species[base] || BEH.species[species];
  const byElo = level >= 3 && BEH.speciesByElo[elo] ? (BEH.speciesByElo[elo][base] || BEH.speciesByElo[elo][species]) : null;
  const src = (byElo && byElo.actions >= 30) ? byElo : pooled;
  const freq = level >= 1 && src ? (src.moves[tb(turn)] || {}) : {};
  const cand = new Set([...revealed, ...Object.keys(freq)]);
  const out = {};
  for (const m of cand) {
    let w = level >= 1 ? (freq[m] || 0) + (revealed.has(m) ? 0.03 : 0.002) : (revealed.has(m) ? 1 : 0);
    if (level >= 2 && tr && PROTECT.has(m)) {
      const pr = (byElo && byElo.protectRateUnderTR) ?? (pooled && pooled.protectRate && pooled.protectRate.underTR);
      if (pr != null) w = Math.max(w, pr);
    }
    out[m] = w;
  }
  return out;
}
const topk = (d, k) => Object.entries(d).sort((a, b) => b[1] - a[1]).slice(0, k).map(([m]) => m);

function main() {
  const files = fs.readdirSync(DIR).filter(f => f.endsWith('.json'));
  const levels = [0, 1, 2, 3];
  const agg = {}; // key -> {n, top1:[..levels], top3:[..levels]}
  const bump = (key, hit1, hit3) => { const a = agg[key] ??= {n: 0, top1: levels.map(() => 0), top3: levels.map(() => 0)}; a.n++; levels.forEach((l, i) => { a.top1[i] += hit1[i]; a.top3[i] += hit3[i]; }); };
  let games = 0, sw = {n: 0, predicted: 0, hit: 0};
  for (const f of files) {
    let rep; try { rep = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch { continue; }
    if (!rep.log) continue;
    const st = parseReplay(rep.log, rep.players || []);
    const elo = eloBucket(rep.rating);
    games++;
    const revealed = {}; // side:species -> Set(moves)
    for (const a of st.actions) {
      const key = a.side + ':' + a.species;
      const rev = revealed[key] ??= new Set();
      if (a.kind === 'switch') {
        // switch prediction: did the model expect a switch?
        const base = a.species.replace(/-Mega.*$/, ''); const s = BEH.species[base];
        sw.n++; if (s && s.switchRate > 0.25) { sw.predicted++; sw.hit++; }
        continue;
      }
      if (a.turn === 0) { rev.add(a.move); continue; }
      const hit1 = [], hit3 = [];
      for (const l of levels) {
        const d = dist(a.species, a.turn, a.tr, elo, rev, l);
        hit1.push(topk(d, 1)[0] === a.move ? 1 : 0);
        hit3.push(topk(d, 3).includes(a.move) ? 1 : 0);
      }
      bump('ALL', hit1, hit3); bump('elo:' + elo, hit1, hit3); bump('sp:' + a.species, hit1, hit3); bump('turn:' + tb(a.turn), hit1, hit3);
      rev.add(a.move);
    }
  }
  const fmt = (a) => levels.map((l, i) => `P${l} ${(100 * a.top1[i] / a.n).toFixed(1)}/${(100 * a.top3[i] / a.n).toFixed(1)}`).join('  ');
  console.log(`games ${games}   (top-1 / top-3 accuracy, %)`);
  console.log(`ALL           n=${agg.ALL.n}   ${fmt(agg.ALL)}`);
  for (const k of Object.keys(agg).filter(k => k.startsWith('elo:') || k.startsWith('turn:')).sort()) console.log(`${k.padEnd(14)}n=${agg[k].n}   ${fmt(agg[k])}`);
  console.log(`switches: ${sw.n} real switches, model flagged switch-prone species on ${sw.predicted}`);
  const bySp = Object.entries(agg).filter(([k, a]) => k.startsWith('sp:') && a.n >= 200).sort((x, y) => y[1].n - x[1].n).slice(0, 20);
  console.log('\nhardest common species to predict (P3 top-1):');
  for (const [k, a] of bySp.sort((x, y) => (x[1].top1[3] / x[1].n) - (y[1].top1[3] / y[1].n)).slice(0, 10)) console.log(`  ${k.slice(3).padEnd(18)} n=${a.n}  ${fmt(a)}`);
  fs.writeFileSync(path.join(OUT, 'predict_report.json'), JSON.stringify({games, levels: ['uniform-revealed', 'freq', 'freq+TR', 'freq+TR+elo'], agg, switches: sw}, null, 1));
}
main();
