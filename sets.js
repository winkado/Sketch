// sets.js — sample a full, legal opposing set for a species, consistent with what the game has revealed.
// Source: models/sets.json (from replays.js mine). This is the "determinization" step: the search agent
// runs against N sampled versions of the opponent instead of one it has hallucinated.
//
//   const {sampleSet, sampleTeam} = require('./sets.js');
//   sampleSet('Garchomp', {moves: ['Earthquake'], item: null, ability: 'Rough Skin'}, rng)
'use strict';
const fs = require('fs');
const path = require('path');
const {Dex, Teams, TeamValidator} = require(require('./ps.js'));
const D = Dex.mod('champions');
const FORMAT = 'gen9championsvgc2026regmb';
const SETS_PATH = process.env.SETS || ['./models/sets.json', path.join(__dirname, 'models/sets.json')].find(p => fs.existsSync(p));
const SETS = SETS_PATH ? JSON.parse(fs.readFileSync(SETS_PATH, 'utf8')) : {};
const validator = new TeamValidator(FORMAT);

// Items/abilities that never announce themselves in a replay log; reveal rates for these are meaningless (lower bounds near 0).
const SILENT_ITEMS = new Set(['Black Glasses', 'Charcoal', 'Mystic Water', 'Magnet', 'Miracle Seed', 'Never-Melt Ice', 'Black Belt', 'Poison Barb', 'Soft Sand', 'Sharp Beak', 'Twisted Spoon', 'Silver Powder', 'Hard Stone', 'Spell Tag', 'Dragon Fang', 'Metal Coat', 'Silk Scarf', 'Fairy Feather', 'Muscle Band', 'Wise Glasses', 'Expert Belt', 'Scope Lens', 'Wide Lens', 'Zoom Lens', 'Bright Powder', 'Choice Scarf', 'Focus Sash', 'Chople Berry', 'Occa Berry', 'Passho Berry', 'Wacan Berry', 'Rindo Berry', 'Yache Berry', 'Shuca Berry', 'Coba Berry', 'Payapa Berry', 'Tanga Berry', 'Charti Berry', 'Kasib Berry', 'Haban Berry', 'Colbur Berry', 'Babiri Berry', 'Chilan Berry', 'Roseli Berry', 'Kebia Berry']);
const SILENT_ABILITIES = new Set(['Prankster', 'Adaptability', 'Technician', 'Tough Claws', 'Huge Power', 'Pure Power', 'Sheer Force', 'Multiscale', 'Regenerator', 'Magic Guard', 'Unaware', 'Chlorophyll', 'Swift Swim', 'Sand Rush', 'Slush Rush', 'Unburden', 'Mold Breaker', 'Scrappy', 'Iron Fist', 'Strong Jaw', 'Sharpness', 'Infiltrator', 'Competitive', 'Poison Touch', 'Pressure', 'Rock Head', 'Reckless', 'Stamina', 'Guts', 'Solar Power', 'Blaze', 'Overgrow', 'Torrent', 'Swarm', 'No Guard', 'Inner Focus', 'Own Tempo', 'Oblivious', 'Shell Armor', 'Battle Armor', 'Thick Fat', 'Filter', 'Solid Rock', 'Fur Coat', 'Ice Scales', 'Skill Link', 'Serene Grace', 'Super Luck', 'Hyper Cutter', 'Anger Point', 'Contrary', 'Aerilate', 'Pixilate', 'Refrigerate', 'Mega Launcher', 'Berserk', 'Supreme Overlord']);
// Sash and pinch berries DO announce when they trigger, but only then; treat as half-silent by giving them residual mass too.

const NATURE = {atkspe: 'Jolly', atkhp: 'Adamant', spaspe: 'Timid', spahp: 'Modest', bulkdef: 'Impish', bulkspd: 'Careful', slowatk: 'Brave', slowspa: 'Quiet'};

function weightedPick(entries, rng, exclude = new Set()) {
  const pool = entries.filter(([k]) => !exclude.has(k));
  const tot = pool.reduce((a, [, w]) => a + w, 0);
  if (!tot) return null;
  let r = rng() * tot;
  for (const [k, w] of pool) { r -= w; if (r <= 0) return k; }
  return pool[pool.length - 1][0];
}

function learnset(species) {
  const sp = D.species.get(species);
  const ids = new Set();
  for (const s of [sp, sp.baseSpecies !== sp.name ? D.species.get(sp.baseSpecies) : null].filter(Boolean)) {
    const ls = D.species.getLearnsetData(s.id);
    if (ls && ls.learnset) for (const [m, src] of Object.entries(ls.learnset)) if (src.some(x => x.startsWith('9'))) ids.add(m);
  }
  return ids;
}

function chooseSpread(species, moves, ability, rng) {
  const sp = D.species.get(species);
  const b = sp.baseStats;
  const cats = moves.map(m => D.moves.get(m).category);
  const phys = cats.filter(c => c === 'Physical').length, spec = cats.filter(c => c === 'Special').length;
  const slow = ['trickroom'].some(id => moves.map(m => D.moves.get(m).id).includes(id)) || b.spe <= 45;
  const support = phys + spec <= 1;
  let evs, nature;
  if (support) { evs = {hp: 32, [b.def >= b.spd ? 'def' : 'spd']: 32, [b.def >= b.spd ? 'spd' : 'def']: 2}; nature = b.def >= b.spd ? NATURE.bulkdef : NATURE.bulkspd; }
  else if (phys >= spec) { if (slow) { evs = {hp: 32, atk: 32, def: 2}; nature = NATURE.slowatk; } else if (b.spe >= 80 && rng() < 0.7) { evs = {atk: 32, spe: 32, hp: 2}; nature = NATURE.atkspe; } else { evs = {atk: 32, hp: 32, spe: 2}; nature = NATURE.atkhp; } }
  else { if (slow) { evs = {hp: 32, spa: 32, def: 2}; nature = NATURE.slowspa; } else if (b.spe >= 80 && rng() < 0.7) { evs = {spa: 32, spe: 32, hp: 2}; nature = NATURE.spaspe; } else { evs = {spa: 32, hp: 32, spe: 2}; nature = NATURE.spahp; } }
  return {evs, nature};
}

function sampleSet(species, revealed = {}, rng = Math.random, tries = 12) {
  const sp = D.species.get(species);
  if (!sp.exists) throw new Error('unknown species ' + species);
  const data = SETS[sp.name] || SETS[sp.baseSpecies] || {moves: [], items: [], abilities: []};
  const legal = learnset(sp.name);
  const nameOf = (id) => D.moves.get(id).name;
  const legalNames = new Set([...legal].map(nameOf));
  for (let t = 0; t < tries; t++) {
    // moves: revealed first, then weighted by real reveal rates (+ tiny mass on the rest of the learnset)
    const moves = [...(revealed.moves || [])].filter(m => legalNames.has(m));
    const weights = data.moves.filter(([m]) => legalNames.has(m)).map(([m, w]) => [m, w + 0.02]);
    const seen = new Set(weights.map(([m]) => m));
    for (const id of legal) { const n = nameOf(id); if (!seen.has(n) && D.moves.get(id).basePower >= 60 || ['protect', 'trickroom', 'tailwind', 'fakeout', 'followme', 'ragepowder', 'taunt', 'encore', 'wideguard', 'helpinghand', 'icywind', 'thunderwave'].includes(id)) weights.push([n, 0.01]); }
    while (moves.length < 4) { const m = weightedPick(weights, rng, new Set(moves)); if (!m) break; moves.push(m); }
    // ability
    // ability: revealed rates for loud abilities; the unexplained residual goes to the species' silent abilities
    let abil = revealed.ability;
    if (!abil) {
      const legalAb = Object.values(sp.abilities);
      const rev = data.abilities.filter(([a]) => legalAb.includes(a));
      const known = rev.reduce((s, [, w]) => s + w, 0);
      const silent = legalAb.filter(a => SILENT_ABILITIES.has(a));
      const w = rev.map(([a, r]) => [a, r]);
      const residual = Math.max(0.05, 1 - known);
      for (const a of (silent.length ? silent : legalAb)) w.push([a, residual / (silent.length || legalAb.length)]);
      abil = weightedPick(w, rng) || sp.abilities['0'];
    }
    // item: mega stone if this is a mega; else revealed; else weighted; Item Clause handled by sampleTeam
    // item: loud items from reveal rates; residual mass to silent items that fit the set (STAB type item, Sash, resist berry, Scarf)
    let item = sp.requiredItem || revealed.item;
    if (!item) {
      const w = data.items.filter(([i]) => !SILENT_ITEMS.has(i) && D.items.get(i).exists).map(([i, r]) => [i, r]);
      const known = w.reduce((s, [, r]) => s + r, 0);
      const residual = Math.max(0.15, 1 - known);
      const stabTypes = sp.types;
      const TYPEITEM = {Fire: 'Charcoal', Water: 'Mystic Water', Electric: 'Magnet', Grass: 'Miracle Seed', Ice: 'Never-Melt Ice', Fighting: 'Black Belt', Poison: 'Poison Barb', Ground: 'Soft Sand', Flying: 'Sharp Beak', Psychic: 'Twisted Spoon', Bug: 'Silver Powder', Rock: 'Hard Stone', Ghost: 'Spell Tag', Dragon: 'Dragon Fang', Dark: 'Black Glasses', Steel: 'Metal Coat', Fairy: 'Fairy Feather', Normal: 'Silk Scarf'};
      const attackTypes = moves.map(m => D.moves.get(m)).filter(m => m.category !== 'Status').map(m => m.type).filter(t => stabTypes.includes(t));
      const cands = [];
      if (attackTypes.length) cands.push([TYPEITEM[attackTypes[0]], 0.35]);
      cands.push(['Focus Sash', sp.baseStats.hp + sp.baseStats.def + sp.baseStats.spd < 250 ? 0.3 : 0.1]);
      cands.push(['Choice Scarf', sp.baseStats.spe >= 60 && sp.baseStats.spe <= 110 ? 0.15 : 0.05]);
      cands.push(['Chople Berry', 0.1], ['Life Orb', known < 0.3 ? 0.2 : 0.05], ['Sitrus Berry', 0.1]);
      const ctot = cands.reduce((s, [, x]) => s + x, 0);
      for (const [i, x] of cands) w.push([i, residual * x / ctot]);
      item = weightedPick(w, rng) || 'Sitrus Berry';
    }
    const {evs, nature} = chooseSpread(sp.name, moves, abil, rng);
    const set = {name: sp.name, ability: abil, item, nature, evs, moves};
    const probs = validator.validateTeam(Teams.import(setText(set)));
    if (!probs || probs.every(p => /team size|Min Team|at least/i.test(p))) return set;
  }
  return null;
}

function setText(s) {
  return [`${s.name}${s.item ? ' @ ' + s.item : ''}`, `Ability: ${s.ability}`, 'Level: 50',
    'EVs: ' + Object.entries(s.evs).map(([k, v]) => `${v} ${k.toUpperCase()}`).join(' / '), `${s.nature} Nature`, ...s.moves.map(m => `- ${m}`)].join('\n');
}

// sample a full six, respecting Item Clause and one-Mega-in-practice; revealed = {Species: {moves, item, ability}}
function sampleTeam(speciesList, revealed = {}, rng = Math.random) {
  const used = new Set();
  const team = [];
  for (const sp of speciesList) {
    let set = null;
    for (let t = 0; t < 8 && !set; t++) {
      const cand = sampleSet(sp, revealed[sp] || {}, rng);
      if (cand && !used.has(cand.item)) set = cand;
    }
    if (!set) return null;
    used.add(set.item); team.push(set);
  }
  return team;
}

module.exports = {sampleSet, sampleTeam, setText};

if (require.main === module) {
  const rng = Math.random;
  const six = process.argv.slice(2);
  if (!six.length) { console.log('usage: node sets.js Garchomp Kingambit Whimsicott ...'); process.exit(0); }
  const team = sampleTeam(six, {}, rng);
  console.log(team ? team.map(setText).join('\n\n') : 'could not build a legal team');
}
