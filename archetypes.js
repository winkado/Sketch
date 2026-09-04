// archetypes.js — build the opponent population for simulation from REAL teams, and a belief model for hidden info.
//
//   node archetypes.js build     -> models/teams.json   (real six-mon teams from replays, labelled by archetype)
//                                -> models/belief.json  (teammate co-occurrence, lead->bench statistics)
//   const {teamPosterior} = require('./archetypes.js'); teamPosterior(['Dragonite','Milotic']) -> {species: prob}
//
// Archetype labels (heuristic, from composition): trickroom, tailwind, tailroom, weather, hyperoffense, balance.
// A team is TR if it carries a known TR-setter species; tailwind if it carries a Tailwind-common species; both = tailroom;
// weather if it carries a weather setter; hyperoffense if mean base speed >= 95 and mean offence >= 105; else balance.
// Sub/cross archetypes are represented by the real teams themselves; the label is only for sampling balance.
'use strict';
const fs = require('fs');
const path = require('path');
const {Dex} = require(require('./ps.js'));
const D = Dex.mod('champions');
const OUT = path.join(__dirname, 'models');
const TR_SETTERS = new Set(['Farigiraf', 'Oranguru', 'Hatterene', 'Sinistcha', 'Slowking', 'Slowbro', 'Reuniclus', 'Cofagrigus', 'Armarouge', 'Musharna', 'Porygon2', 'Indeedee', 'Spiritomb', 'Gothitelle', 'Beheeyem', 'Bronzong', 'Dusclops']);
const TW_SETTERS = new Set(['Whimsicott', 'Talonflame', 'Pelipper', 'Tornadus', 'Murkrow', 'Corviknight', 'Staraptor', 'Aerodactyl', 'Noivern', 'Kilowattrel', 'Vivillon', 'Braviary']);
const WEATHER = new Set(['Torkoal', 'Charizard', 'Pelipper', 'Politoed', 'Tyranitar', 'Hippowdon', 'Abomasnow', 'Ninetales-Alola', 'Ninetales', 'Kyogre', 'Groudon']);

function label(species) {
  const base = species.map(s => s.replace(/-Mega.*$/, ''));
  const tr = base.some(s => TR_SETTERS.has(s)), tw = base.some(s => TW_SETTERS.has(s)), wx = base.some(s => WEATHER.has(s));
  if (tr && tw) return 'tailroom'; if (tr) return 'trickroom'; if (tw) return 'tailwind'; if (wx) return 'weather';
  const stats = base.map(s => D.species.get(s)).filter(s => s.exists);
  const spe = stats.reduce((a, s) => a + s.baseStats.spe, 0) / Math.max(1, stats.length);
  const off = stats.reduce((a, s) => a + Math.max(s.baseStats.atk, s.baseStats.spa), 0) / Math.max(1, stats.length);
  return spe >= 95 && off >= 105 ? 'hyperoffense' : 'balance';
}

function build() {
  const {parseReplay} = require('./replays.js');
  const dirs = ['replays', 'replays/own'].map(d => path.join(__dirname, d)).filter(d => fs.existsSync(d));
  const files = dirs.flatMap(d => fs.readdirSync(d).filter(f => f.endsWith('.json')).map(f => path.join(d, f)));
  const teams = {}, pair = {}, single = {}, leadToBench = {}; let sides = 0;
  for (const fp of files) {
    let rep; try { rep = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { continue; }
    if (!rep.log) continue;
    const six = {p1: [], p2: []};
    for (const l of rep.log.split('\n')) { const m = l.match(/^\|poke\|(p[12])\|([^,|]+)/); if (m) six[m[1]].push(m[2].replace(/-\*$/, '')); }
    const st = parseReplay(rep.log, rep.players || []);
    for (const side of ['p1', 'p2']) {
      const sp = six[side]; if (sp.length !== 6) continue; sides++;
      const key = [...sp].sort().join('|');
      const t = teams[key] ??= {species: [...sp].sort(), n: 0, wins: 0, leads: {}, rating: [], sets: {}};
      t.n++; if (st.winner && rep.players && st.winner === rep.players[side === 'p1' ? 0 : 1]) t.wins++;
      if (rep.rating) t.rating.push(rep.rating);
      const lead = st.leads[side].filter(Boolean).sort().join('+'); if (lead) t.leads[lead] = (t.leads[lead] || 0) + 1;
      for (const [k, mv] of Object.entries(st.movesets)) { if (!k.startsWith(side)) continue; const s = k.split(':')[1]; const ss = t.sets[s] ??= {moves: {}, items: {}, abilities: {}}; for (const m of mv) ss.moves[m] = (ss.moves[m] || 0) + 1; if (st.items[k]) ss.items[st.items[k]] = (ss.items[st.items[k]] || 0) + 1; if (st.abilities[k]) ss.abilities[st.abilities[k]] = (ss.abilities[st.abilities[k]] || 0) + 1; }
      for (const a of sp) { single[a] = (single[a] || 0) + 1; for (const b of sp) if (a < b) pair[a + '|' + b] = (pair[a + '|' + b] || 0) + 1; }
      const L = st.leads[side].filter(Boolean); if (L.length === 2) { const lk = [...L].sort().join('+'); const lb = leadToBench[lk] ??= {n: 0, bench: {}}; lb.n++; for (const s of sp) if (!L.includes(s)) lb.bench[s] = (lb.bench[s] || 0) + 1; }
    }
  }
  const list = Object.values(teams).filter(t => t.n >= 2).map(t => ({...t, archetype: label(t.species), winRate: +(t.wins / t.n).toFixed(3), rating: t.rating.length ? Math.round(t.rating.reduce((a, b) => a + b, 0) / t.rating.length) : null,
    leads: Object.entries(t.leads).sort((a, b) => b[1] - a[1]).slice(0, 3)})).sort((a, b) => b.n - a.n);
  const byArch = {}; for (const t of list) byArch[t.archetype] = (byArch[t.archetype] || 0) + 1;
  fs.writeFileSync(path.join(OUT, 'teams.json'), JSON.stringify({sides, teams: list.slice(0, 600), byArchetype: byArch}, null, 1));
  fs.writeFileSync(path.join(OUT, 'belief.json'), JSON.stringify({sides, single, pair, leadToBench}, null, 1));
  console.log(`${sides} team-sides, ${list.length} distinct teams seen >=2x. archetypes:`, byArch);
}

// ---------------------------------------------------------------- belief: P(species on their team | species seen so far)
let BEL = null;
function loadBelief() { if (!BEL) { try { BEL = JSON.parse(fs.readFileSync(path.join(OUT, 'belief.json'), 'utf8')); } catch { BEL = null; } } return BEL; }
function teamPosterior(seen, exclude = []) {
  const B = loadBelief(); if (!B) return {};
  const out = {};
  for (const [sp, n] of Object.entries(B.single)) {
    if (seen.includes(sp) || exclude.includes(sp)) continue;
    // naive Bayes: log P(sp) + sum log P(seen_i | sp) with add-1 smoothing
    let lp = Math.log((n + 1) / (B.sides + 1));
    for (const s of seen) { const k = s < sp ? s + '|' + sp : sp + '|' + s; lp += Math.log(((B.pair[k] || 0) + 0.5) / (n + 1)) - Math.log(((B.single[s] || 0) + 1) / (B.sides + 1)); }
    out[sp] = lp;
  }
  const mx = Math.max(...Object.values(out)); const e = Object.fromEntries(Object.entries(out).map(([k, v]) => [k, Math.exp(v - mx)])); const tot = Object.values(e).reduce((a, b) => a + b, 0);
  return Object.fromEntries(Object.entries(e).map(([k, v]) => [k, +(v / tot).toFixed(4)]).sort((a, b) => b[1] - a[1]).slice(0, 12));
}
module.exports = {build, label, teamPosterior};
if (require.main === module) { if (process.argv[2] === 'build') build(); else if (process.argv[2] === 'posterior') console.log(teamPosterior(process.argv.slice(3))); }
