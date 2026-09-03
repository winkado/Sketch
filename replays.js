// replays.js — mine REAL human games from Showdown's public replay archive (no botting, no accounts).
//
//   node replays.js fetch  [pages=20]          -> replays/<id>.json   (format gen9championsvgc2026regmb + bo3)
//   node replays.js mine                        -> models/behaviour.json  (per-species + per-player tables)
//
// Behaviour tables produced (all conditional on what a real human actually did):
//   species.leadRate, species.bringRate, species.moves[turnBucket][move] (T1 / T2-3 / T4+),
//   species.protectRate[under TR | not], species.fakeOutTarget (setter-like | other),
//   species.switchRate, species.tauntTarget, player.<name>.{leads, protectRate, switchRate, games}
// The arena can then sample an opponent's move from these tables instead of my heuristic.
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const FORMATS = ['gen9championsvgc2026regmb', 'gen9championsvgc2026regmbbo3'];
const DIR = path.join(__dirname, 'replays'), OUT = path.join(__dirname, 'models');
fs.mkdirSync(DIR, {recursive: true}); fs.mkdirSync(OUT, {recursive: true});

const get = (url) => new Promise((res, rej) => https.get(url, {headers: {'User-Agent': 'champ-research/1.0'}}, r => {
  let d = ''; r.on('data', c => d += c); r.on('end', () => res({status: r.statusCode, body: d}));
}).on('error', rej));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchAll(pages) {
  let n = 0;
  for (const fmt of FORMATS) {
    for (let p = 1; p <= pages; p++) {
      const r = await get(`https://replay.pokemonshowdown.com/search.json?format=${fmt}&page=${p}`);
      if (r.status !== 200) { console.error(fmt, 'page', p, 'status', r.status); break; }
      let list; try { list = JSON.parse(r.body); } catch { break; }
      if (!Array.isArray(list) || !list.length) break;
      for (const item of list) {
        const f = path.join(DIR, item.id + '.json');
        if (fs.existsSync(f)) continue;
        const rr = await get(`https://replay.pokemonshowdown.com/${item.id}.json`);
        if (rr.status === 200) { fs.writeFileSync(f, rr.body); n++; }
        await sleep(400); // be polite to their server
      }
      console.error(fmt, 'page', p, 'ok, total new', n);
      await sleep(600);
    }
  }
  console.error('fetched', n, 'new replays into', DIR);
}

// ------------------------------------------------------------- protocol parser (same protocol our sim emits)
function parseReplay(log, players) {
  const st = {turn: 0, tr: false, active: {p1: [null, null], p2: [null, null]}, mons: {p1: {}, p2: {}}, brought: {p1: new Set(), p2: new Set()},
    leads: {p1: [], p2: []}, actions: [], names: players, items: {}, abilities: {}, movesets: {}, hp: {}, faints: {p1: 0, p2: 0}};
  const pos = (s) => s && s.match(/^(p[12])([ab]): (.*)$/);
  for (const line of log.split('\n')) {
    const parts = line.split('|'); const tag = parts[1];
    if (tag === 'turn') st.turn = +parts[2];
    else if (tag === 'switch' || tag === 'drag') {
      const m = pos(parts[2]); if (!m) continue;
      const species = parts[3].split(',')[0].replace(/-\*$/, '');
      st.mons[m[1]][m[3]] = species;
      st.brought[m[1]].add(species);
      const slot = m[2] === 'a' ? 0 : 1;
      if (st.turn === 0) st.leads[m[1]][slot] = species;
      else if (tag === 'switch') st.actions.push({side: m[1], turn: st.turn, species: st.active[m[1]][slot], kind: 'switch', to: species, tr: st.tr, hp: st.hp[m[1] + ':' + st.active[m[1]][slot]] ?? 1, faints: st.faints[m[1]]});
      st.active[m[1]][slot] = species;
    } else if (tag === '-damage' || tag === '-heal' || tag === '-sethp') {
      const m = pos(parts[2]); if (m && parts[3]) { const h = parts[3].split(' ')[0]; const [a, b] = h.split('/').map(Number); st.hp[m[1] + ':' + (st.mons[m[1]][m[3]] || m[3])] = b ? a / b : 0; }
    } else if (tag === 'faint') {
      const m = pos(parts[2]); if (m) { st.faints[m[1]]++; st.hp[m[1] + ':' + (st.mons[m[1]][m[3]] || m[3])] = 0; }
    } else if (tag === '-item' || tag === '-enditem') {
      const m = pos(parts[2]); if (m && parts[3]) st.items[m[1] + ':' + (st.mons[m[1]][m[3]] || m[3])] = parts[3];
    } else if (tag === '-ability') {
      const m = pos(parts[2]); if (m && parts[3]) st.abilities[m[1] + ':' + (st.mons[m[1]][m[3]] || m[3])] = parts[3];
    } else if (tag === '-mega') {
      const m = pos(parts[2]); if (m && parts[4]) st.items[m[1] + ':' + (st.mons[m[1]][m[3]] || m[3])] = parts[4];
    } else if (tag === 'move') {
      const m = pos(parts[2]); if (!m) continue;
      { const key = m[1] + ':' + (st.mons[m[1]][m[3]] || m[3]); (st.movesets[key] ??= new Set()).add(parts[3]); }
      for (const p of parts.slice(4)) { const fi = p.match(/\[from\] (item|ability): (.+)/); if (fi) { const key = m[1] + ':' + (st.mons[m[1]][m[3]] || m[3]); (fi[1] === 'item' ? st.items : st.abilities)[key] = fi[2]; } }
      const tgt = pos(parts[4]);
      const targetSpecies = tgt ? (st.mons[tgt[1]][tgt[3]] || tgt[3]) : '';
      st.actions.push({side: m[1], turn: st.turn, species: st.mons[m[1]][m[3]] || m[3], kind: 'move', move: parts[3],
        target: targetSpecies, targetSide: tgt ? tgt[1] : '', tr: st.tr, hp: st.hp[m[1] + ':' + (st.mons[m[1]][m[3]] || m[3])] ?? 1, faints: st.faints[m[1]]});
    } else if (tag === '-fieldstart' && /Trick Room/.test(parts[2])) st.tr = true;
    else if (tag === '-fieldend' && /Trick Room/.test(parts[2])) st.tr = false;
    else if (tag === 'win') st.winner = parts[2];
    if (tag && tag.startsWith('-')) {
      const src = parts.find(p => /^\[of\] /.test(p)); const tgt = pos(parts[2]);
      for (const p of parts.slice(3)) { const fi = p.match(/^\[from\] (item|ability): (.+)/); if (fi) { const who = src ? pos(src.slice(5)) : tgt; if (who) (fi[1] === 'item' ? st.items : st.abilities)[who[1] + ':' + (st.mons[who[1]][who[3]] || who[3])] = fi[2]; } }
    }
  }
  return st;
}

const SETTER_LIKE = new Set(['Oranguru', 'Farigiraf', 'Hatterene', 'Sinistcha', 'Slowking', 'Slowbro', 'Slowbro-Mega', 'Reuniclus', 'Cofagrigus',
  'Armarouge', 'Musharna', 'Spiritomb', 'Porygon2', 'Torkoal', 'Indeedee']);
const bucket = (t) => t <= 1 ? 'T1' : t <= 3 ? 'T2-3' : 'T4+';
// Elo bucket. Ladder replays carry `rating`; tournament/challenge replays don't -> 'tourney'.
const RATING_BUCKETS = [[0, 1300, '<1300'], [1300, 1600, '1300-1599'], [1600, 1900, '1600-1899'], [1900, 9999, '1900+']];
const eloBucket = (r) => r == null ? 'tourney' : (RATING_BUCKETS.find(([lo, hi]) => r >= lo && r < hi) || [0, 0, '?'])[2];
// Dirichlet shrinkage toward the pooled distribution: small high-Elo buckets shouldn't produce fake certainty
const ALPHA = 8;
const shrink = (counts, pooled) => {
  const n = Object.values(counts).reduce((a, b) => a + b, 0);
  const keys = new Set([...Object.keys(counts), ...Object.keys(pooled)]);
  const out = {};
  for (const k of keys) out[k] = +(((counts[k] || 0) + ALPHA * (pooled[k] || 0)) / (n + ALPHA)).toFixed(3);
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]));
};
// total variation distance between two move distributions (0 = identical, 1 = disjoint)
const tvd = (p, q) => { const ks = new Set([...Object.keys(p), ...Object.keys(q)]); let d = 0; for (const k of ks) d += Math.abs((p[k] || 0) - (q[k] || 0)); return +(d / 2).toFixed(3); };
const inc = (o, k, by = 1) => { o[k] = (o[k] || 0) + by; };

function mine() {
  const files = fs.readdirSync(DIR).filter(f => f.endsWith('.json'));
  const species = {}, players = {}, byElo = {}; let games = 0; const gamesByElo = {}; const SETS = {}; const SWITCH = {};
  for (const f of files) {
    let rep; try { rep = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch { continue; }
    if (!rep.log) continue;
    const st = parseReplay(rep.log, rep.players || []);
    games++;
    const eb = eloBucket(rep.rating); inc(gamesByElo, eb);
    const E = byElo[eb] ??= {}; const EL = (byElo[eb]._leads ??= {pairs: {}, led: {}, brought: {}});
    for (const side of ['p1', 'p2']) {
      const pname = (rep.players || [])[side === 'p1' ? 0 : 1] || 'unknown';
      const P = players[pname] ??= {games: 0, leads: {}, protect: 0, moves: 0, switches: 0, wins: 0};
      P.games++; if (st.winner === pname) P.wins++; if (rep.rating != null) { P.ratings ??= []; P.ratings.push(rep.rating); }
      const leadKey = [...st.leads[side]].filter(Boolean).sort().join(' + ');
      if (leadKey) { inc(P.leads, leadKey); inc(EL.pairs, leadKey); }
      for (const sp of st.brought[side]) inc(EL.brought, sp);
      for (const sp of st.leads[side]) if (sp) inc(EL.led, sp);
      for (const sp of st.brought[side]) { const S_ = species[sp] ??= {brought: 0, led: 0, moves: {T1: {}, 'T2-3': {}, 'T4+': {}}, protectTR: [0, 0], protectNoTR: [0, 0], switches: 0, actions: 0, fakeOutOnSetter: [0, 0], tauntOnSetter: [0, 0]}; S_.brought++; }
      for (const sp of st.leads[side]) if (sp && species[sp]) species[sp].led++;
    }
    for (const [key, mv] of Object.entries(st.movesets)) {
      const sp = key.split(':')[1]; const S2 = SETS[sp] ??= {games: 0, moves: {}, items: {}, abilities: {}, combos: {}, pairs: {}};
      S2.games++;
      const list = [...mv].sort();
      for (const m of list) inc(S2.moves, m);
      for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) inc(S2.pairs, list[i] + ' | ' + list[j]);
      if (list.length >= 3) inc(S2.combos, list.join(' / '));
      if (st.items[key]) inc(S2.items, st.items[key]);
      if (st.abilities[key]) inc(S2.abilities, st.abilities[key]);
    }
    for (const a of st.actions) {
      if (a.species) { const hb = a.hp > 0.75 ? 'hi' : a.hp > 0.4 ? 'mid' : 'lo'; const SW = (SWITCH[a.species] ??= {hi: [0, 0], mid: [0, 0], lo: [0, 0], turn1: [0, 0], underTR: [0, 0]});
        SW[hb][1]++; if (a.kind === 'switch') SW[hb][0]++;
        if (a.turn === 1) { SW.turn1[1]++; if (a.kind === 'switch') SW.turn1[0]++; }
        if (a.tr) { SW.underTR[1]++; if (a.kind === 'switch') SW.underTR[0]++; } }
      const S_ = species[a.species]; if (!S_) continue;
      const pname = (rep.players || [])[a.side === 'p1' ? 0 : 1] || 'unknown';
      const P = players[pname];
      S_.actions++; P.moves++;
      if (a.kind === 'switch') { S_.switches++; P.switches++; const ES0 = E[a.species] ??= {moves: {T1: {}, 'T2-3': {}, 'T4+': {}}, protectTR: [0, 0], switches: 0, actions: 0}; ES0.switches++; ES0.actions++; continue; }
      inc(S_.moves[bucket(a.turn)], a.move);
      const ES = E[a.species] ??= {moves: {T1: {}, 'T2-3': {}, 'T4+': {}}, protectTR: [0, 0], switches: 0, actions: 0};
      ES.actions++; inc(ES.moves[bucket(a.turn)], a.move);
      const isProtect = /^(Protect|Detect|Spiky Shield|Baneful Bunker|King's Shield)$/.test(a.move);
      const pr = a.tr ? S_.protectTR : S_.protectNoTR; pr[1]++; if (isProtect) { pr[0]++; P.protect++; }
      if (a.tr) { ES.protectTR[1]++; if (isProtect) ES.protectTR[0]++; }
      if (a.move === 'Fake Out') { S_.fakeOutOnSetter[1]++; if (SETTER_LIKE.has(a.target)) S_.fakeOutOnSetter[0]++; }
      if (a.move === 'Taunt') { S_.tauntOnSetter[1]++; if (SETTER_LIKE.has(a.target)) S_.tauntOnSetter[0]++; }
    }
  }
  // normalise
  const out = {games, gamesByElo, generated: new Date().toISOString(), species: {}, speciesByElo: {}, eloDivergence: [], players: {}};
  for (const [sp, s] of Object.entries(species)) {
    const norm = (o) => { const t = Object.values(o).reduce((a, b) => a + b, 0) || 1; return Object.fromEntries(Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, +(v / t).toFixed(3)])); };
    out.species[sp] = {brought: s.brought, leadRate: +(s.led / s.brought).toFixed(3),
      moves: {T1: norm(s.moves.T1), 'T2-3': norm(s.moves['T2-3']), 'T4+': norm(s.moves['T4+'])},
      protectRate: {underTR: s.protectTR[1] ? +(s.protectTR[0] / s.protectTR[1]).toFixed(3) : null, noTR: s.protectNoTR[1] ? +(s.protectNoTR[0] / s.protectNoTR[1]).toFixed(3) : null},
      switchRate: +(s.switches / (s.actions || 1)).toFixed(3),
      fakeOutOnSetter: s.fakeOutOnSetter[1] ? +(s.fakeOutOnSetter[0] / s.fakeOutOnSetter[1]).toFixed(3) : null,
      tauntOnSetter: s.tauntOnSetter[1] ? +(s.tauntOnSetter[0] / s.tauntOnSetter[1]).toFixed(3) : null};
  }
  const normRaw = (o) => { const t = Object.values(o).reduce((a, b) => a + b, 0) || 1; return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v / t])); };
  out.leadsByElo = {};
  for (const [eb, E] of Object.entries(byElo)) {
    const L = E._leads || {pairs: {}, led: {}, brought: {}};
    out.leadsByElo[eb] = {topPairs: Object.entries(L.pairs).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, v]) => [k, v]),
      leadRate: Object.fromEntries(Object.entries(L.led).filter(([sp]) => (L.brought[sp] || 0) >= 10).map(([sp, v]) => [sp, +(v / L.brought[sp]).toFixed(3)]).sort((a, b) => b[1] - a[1]))};
    out.speciesByElo[eb] = {};
    for (const [sp, es] of Object.entries(E)) {
      if (sp === '_leads') continue;
      const pooled = species[sp] ? species[sp].moves : {T1: {}, 'T2-3': {}, 'T4+': {}};
      out.speciesByElo[eb][sp] = {actions: es.actions,
        moves: {T1: shrink(es.moves.T1, normRaw(pooled.T1)), 'T2-3': shrink(es.moves['T2-3'], normRaw(pooled['T2-3'])), 'T4+': shrink(es.moves['T4+'], normRaw(pooled['T4+']))},
        protectRateUnderTR: es.protectTR[1] ? +(es.protectTR[0] / es.protectTR[1]).toFixed(3) : null,
        switchRate: +(es.switches / (es.actions || 1)).toFixed(3)};
    }
  }
  // where does Elo change behaviour? TVD of T1 move distribution between the lowest and highest ladder buckets, per species
  const lo = out.speciesByElo['<1300'] || out.speciesByElo['1300-1599'], hi = out.speciesByElo['1900+'] || out.speciesByElo['1600-1899'];
  if (lo && hi) for (const sp of Object.keys(hi)) if (lo[sp] && lo[sp].actions >= 20 && hi[sp].actions >= 20)
    out.eloDivergence.push({species: sp, tvd_T1: tvd(lo[sp].moves.T1, hi[sp].moves.T1), tvd_T23: tvd(lo[sp].moves['T2-3'], hi[sp].moves['T2-3']),
      protectUnderTR: [lo[sp].protectRateUnderTR, hi[sp].protectRateUnderTR], switchRate: [lo[sp].switchRate, hi[sp].switchRate]});
  out.eloDivergence.sort((a, b) => (b.tvd_T1 + b.tvd_T23) - (a.tvd_T1 + a.tvd_T23));
  for (const [p, P] of Object.entries(players)) {
    if (P.games < 3) continue; // need a few games before a "quirk" is a quirk
    out.players[p] = {games: P.games, elo: P.ratings ? Math.round(P.ratings.reduce((a, b) => a + b, 0) / P.ratings.length) : null, winRate: +(P.wins / P.games).toFixed(3), protectRate: +(P.protect / (P.moves || 1)).toFixed(3),
      switchRate: +(P.switches / (P.moves || 1)).toFixed(3), topLeads: Object.entries(P.leads).sort((a, b) => b[1] - a[1]).slice(0, 3)};
  }
  out.switchModel = {};
  const rate = (p) => p[1] >= 20 ? +(p[0] / p[1]).toFixed(3) : null;
  for (const [sp, SW] of Object.entries(SWITCH)) out.switchModel[sp] = {hi: rate(SW.hi), mid: rate(SW.mid), lo: rate(SW.lo), turn1: rate(SW.turn1), underTR: rate(SW.underTR), n: SW.hi[1] + SW.mid[1] + SW.lo[1]};
  fs.writeFileSync(path.join(OUT, 'behaviour.json'), JSON.stringify(out, null, 1));
  // sets.json: per-species revealed move / item / ability frequencies + co-occurrence, for sampling full opposing sets
  const sets = {};
  for (const [sp, S2] of Object.entries(SETS)) {
    if (S2.games < 5) continue;
    const top = (o, n) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => [k, +(v / S2.games).toFixed(3)]);
    sets[sp] = {games: S2.games, moves: top(S2.moves, 14), items: top(S2.items, 8), abilities: top(S2.abilities, 4), pairs: top(S2.pairs, 20), combos3plus: top(S2.combos, 10)};
  }
  fs.writeFileSync(path.join(OUT, 'sets.json'), JSON.stringify(sets, null, 1));
  console.error(`sets.json: ${Object.keys(sets).length} species with >=5 games (moves/items/abilities are per-game REVEAL rates - a move used in 40% of games is carried by at least 40%)`);
  console.error(`mined ${games} games, ${Object.keys(out.species).length} species, ${Object.keys(out.players).length} players with >=3 games -> models/behaviour.json`);
}

if (require.main === module) {
  const cmd = process.argv[2];
  if (cmd === 'fetch') fetchAll(+(process.argv[3] || 20)).catch(e => { console.error(e); process.exit(1); });
  else if (cmd === 'mine') mine();
  else console.error('usage: node replays.js fetch [pages] | mine');
}
module.exports = {parseReplay, mine};
