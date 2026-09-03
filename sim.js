// sim.js — thousands of real Showdown battles (champions mod, VGC Reg M-B rules)
// P1 = our Trick Room team with a scripted plan. P2 = a meta core piloted by a heuristic AI.
//
// HONEST LABEL: the opponent is a heuristic, not a human. It maximises estimated damage,
// Fake Outs / Taunts / double-targets the setter, and Protects when it expects a KO.
// Win rate against it is an upper-bound-ish sanity check. The SETUP metrics
// (did Trick Room go up on T1/T2, why not) are the reliable output.
//
// usage: node sim.js <coreName|all> <games> [oppPolicy=antiTR|greedy] [ourVariant]
'use strict';
const {BattleStream, Teams, Dex, TeamValidator} = require(require('./ps.js'));
const fs = require('fs');
const D = Dex.mod('champions');
const FORMAT = 'gen9championsvgc2026regmb';

// ------------------------------------------------------------------ teams
const TEAM_PATH = (require.main === module && process.argv[5]) || ['team_trickroom_v7.json', 'team_trickroom_v6.json', 'team_trickroom_v4.json'].map(f => require('path').join(__dirname, f)).find(f => fs.existsSync(f));
const OURS = TEAM_PATH ? JSON.parse(fs.readFileSync(TEAM_PATH, 'utf8')) : [];

const A = (name, ability, item, nature, evs, moves) => ({name, ability, item, nature, evs, moves});
const CORES = {
  sunchomp: { // #2 usage archetype
    team: [
      A('Garchomp', 'Rough Skin', 'Life Orb', 'Jolly', {atk: 32, spe: 32, hp: 2}, ['Earthquake', 'Rock Slide', 'Dragon Claw', 'Protect']),
      A('Kingambit', 'Defiant', 'Black Glasses', 'Adamant', {atk: 32, hp: 32, spe: 2}, ['Kowtow Cleave', 'Sucker Punch', 'Iron Head', 'Protect']),
      A('Whimsicott', 'Prankster', 'Focus Sash', 'Timid', {spa: 32, spe: 32, hp: 2}, ['Moonblast', 'Tailwind', 'Encore', 'Protect']),
      A('Basculegion', 'Adaptability', 'Mystic Water', 'Adamant', {atk: 32, spe: 32, hp: 2}, ['Last Respects', 'Aqua Jet', 'Wave Crash', 'Protect']),
      A('Charizard-Mega-Y', 'Drought', 'Charizardite Y', 'Modest', {spa: 32, spe: 32, hp: 2}, ['Heat Wave', 'Weather Ball', 'Solar Beam', 'Protect']),
      A('Floette-Eternal', 'Flower Veil', 'Fairy Feather', 'Modest', {spa: 32, hp: 32, spe: 2}, ['Moonblast', 'Dazzling Gleam', 'Calm Mind', 'Protect']),
    ],
    brings: [[0, 1, 2, 4], [0, 2, 3, 4], [1, 2, 3, 4], [0, 1, 3, 5]], // first two = leads
  },
  sand: { // #1 usage archetype
    team: [
      A('Tyranitar-Mega', 'Sand Stream', 'Tyranitarite', 'Adamant', {atk: 32, hp: 32, spe: 2}, ['Rock Slide', 'Knock Off', 'Low Kick', 'Protect']),
      A('Excadrill', 'Mold Breaker', 'Focus Sash', 'Jolly', {atk: 32, spe: 32, hp: 2}, ['Earthquake', 'Rock Slide', 'Iron Head', 'Protect']),
      A('Milotic', 'Competitive', 'Leftovers', 'Modest', {spa: 32, hp: 32, spd: 2}, ['Muddy Water', 'Ice Beam', 'Icy Wind', 'Protect']),
      A('Sinistcha', 'Hospitality', 'Sitrus Berry', 'Bold', {hp: 32, def: 32, spd: 2}, ['Matcha Gotcha', 'Rage Powder', 'Trick Room', 'Protect']),
      A('Staraptor', 'Intimidate', 'Choice Scarf', 'Jolly', {atk: 32, spe: 32, hp: 2}, ['Brave Bird', 'Close Combat', 'Double-Edge', 'U-turn']),
      A('Gholdengo', 'Good as Gold', 'Life Orb', 'Modest', {spa: 32, spe: 32, hp: 2}, ['Make It Rain', 'Shadow Ball', 'Nasty Plot', 'Protect']),
    ],
    brings: [[0, 1, 2, 5], [1, 4, 2, 3], [0, 1, 3, 5], [4, 5, 0, 1]],
  },
  rain: {
    team: [
      A('Pelipper', 'Drizzle', 'Focus Sash', 'Modest', {spa: 32, spe: 32, hp: 2}, ['Hurricane', 'Weather Ball', 'Tailwind', 'Wide Guard']),
      A('Archaludon', 'Stamina', 'Leftovers', 'Modest', {spa: 32, hp: 32, spd: 2}, ['Electro Shot', 'Flash Cannon', 'Dragon Pulse', 'Protect']),
      A('Swampert-Mega', 'Swift Swim', 'Swampertite', 'Adamant', {atk: 32, hp: 32, spe: 2}, ['Wave Crash', 'Earthquake', 'Ice Punch', 'Protect']),
      A('Grimmsnarl', 'Prankster', 'Light Clay', 'Careful', {hp: 32, spd: 32, def: 2}, ['Fake Out', 'Reflect', 'Light Screen', 'Spirit Break']),
      A('Basculegion', 'Adaptability', 'Sitrus Berry', 'Adamant', {atk: 32, spe: 32, hp: 2}, ['Last Respects', 'Aqua Jet', 'Wave Crash', 'Protect']),
      A('Venusaur', 'Chlorophyll', 'Life Orb', 'Modest', {spa: 32, hp: 32, spe: 2}, ['Sludge Bomb', 'Energy Ball', 'Sleep Powder', 'Protect']),
    ],
    brings: [[0, 1, 2, 3], [3, 0, 2, 1], [0, 2, 4, 3], [3, 1, 0, 4]],
  },
  balance: { // #6 archetype, Fake Out + Intimidate
    team: [
      A('Sneasler', 'Unburden', 'Focus Sash', 'Jolly', {atk: 32, spe: 32, hp: 2}, ['Close Combat', 'Dire Claw', 'Fake Out', 'Protect']),
      A('Blastoise-Mega', 'Mega Launcher', 'Blastoisinite', 'Modest', {spa: 32, hp: 32, spe: 2}, ['Water Pulse', 'Dark Pulse', 'Ice Beam', 'Protect']),
      A('Kingambit', 'Defiant', 'Chople Berry', 'Adamant', {atk: 32, hp: 32, spe: 2}, ['Kowtow Cleave', 'Sucker Punch', 'Iron Head', 'Protect']),
      A('Incineroar', 'Intimidate', 'Sitrus Berry', 'Careful', {hp: 32, spd: 32, atk: 2}, ['Fake Out', 'Flare Blitz', 'Parting Shot', 'Darkest Lariat']),
      A('Delphox', 'Blaze', 'Life Orb', 'Timid', {spa: 32, spe: 32, hp: 2}, ['Heat Wave', 'Psychic', 'Dazzling Gleam', 'Protect']),
      A('Sinistcha', 'Hospitality', 'Leftovers', 'Bold', {hp: 32, def: 32, spd: 2}, ['Matcha Gotcha', 'Rage Powder', 'Trick Room', 'Protect']),
    ],
    brings: [[3, 0, 2, 1], [3, 2, 0, 4], [0, 3, 1, 2], [3, 1, 2, 5]],
  },
  metatr: { // Trick Room mirror: Armor Tail setter, sun Eruption, Scrappy Fake Out (breaks our Ghost redirect)
    tr: true,
    team: [
      A('Farigiraf', 'Armor Tail', 'Sitrus Berry', 'Sassy', {hp: 32, spd: 32, def: 2}, ['Trick Room', 'Psychic', 'Helping Hand', 'Protect']),
      A('Torkoal', 'Drought', 'Charcoal', 'Quiet', {hp: 32, spa: 32, spd: 2}, ['Eruption', 'Heat Wave', 'Earth Power', 'Protect']),
      A('Mawile-Mega', 'Huge Power', 'Mawilite', 'Brave', {hp: 32, atk: 32, def: 2}, ['Play Rough', 'Iron Head', 'Sucker Punch', 'Protect']),
      A('Sinistcha', 'Hospitality', 'Leftovers', 'Relaxed', {hp: 32, def: 32, spd: 2}, ['Matcha Gotcha', 'Rage Powder', 'Trick Room', 'Protect']),
      A('Kangaskhan', 'Scrappy', 'Silk Scarf', 'Adamant', {atk: 32, hp: 32, spe: 2}, ['Fake Out', 'Double-Edge', 'Sucker Punch', 'Protect']),
      A('Venusaur', 'Chlorophyll', 'Focus Sash', 'Modest', {spa: 32, spe: 32, hp: 2}, ['Sludge Bomb', 'Energy Ball', 'Sleep Powder', 'Protect']),
    ],
    brings: [[0, 4, 1, 2], [3, 0, 1, 2], [4, 0, 1, 5], [0, 2, 1, 3]],
  },
  tsareena: { // Trick Room + Tsareena: Grass-type Taunt ignores Rage Powder and re-Taunts after Mental Herb
    tr: true,
    team: [
      A('Farigiraf', 'Armor Tail', 'Leftovers', 'Sassy', {hp: 32, spd: 32, def: 2}, ['Trick Room', 'Psychic', 'Helping Hand', 'Protect']),
      A('Tsareena', 'Queenly Majesty', 'Sitrus Berry', 'Impish', {hp: 32, def: 32, spd: 2}, ['Taunt', 'Trop Kick', 'U-turn', 'Protect']),
      A('Torkoal', 'Drought', 'Charcoal', 'Quiet', {hp: 32, spa: 32, spd: 2}, ['Eruption', 'Heat Wave', 'Earth Power', 'Protect']),
      A('Mawile-Mega', 'Huge Power', 'Mawilite', 'Brave', {hp: 32, atk: 32, def: 2}, ['Play Rough', 'Iron Head', 'Sucker Punch', 'Protect']),
      A('Kangaskhan', 'Scrappy', 'Silk Scarf', 'Adamant', {atk: 32, hp: 32, spe: 2}, ['Fake Out', 'Double-Edge', 'Sucker Punch', 'Protect']),
      A('Milotic', 'Competitive', 'Focus Sash', 'Modest', {spa: 32, hp: 32, spd: 2}, ['Muddy Water', 'Ice Beam', 'Icy Wind', 'Protect']),
    ],
    brings: [[1, 0, 2, 3], [1, 4, 0, 2], [0, 1, 3, 5], [1, 2, 0, 4]],
  },
  sunspam: { // the lead that beat us live: Zard-Y + Chandelure double Heat Wave
    team: [
      A('Charizard-Mega-Y', 'Drought', 'Charizardite Y', 'Modest', {spa: 32, spe: 32, hp: 2}, ['Heat Wave', 'Air Slash', 'Solar Beam', 'Protect']),
      A('Chandelure', 'Flash Fire', 'Charcoal', 'Modest', {spa: 32, spe: 32, hp: 2}, ['Heat Wave', 'Shadow Ball', 'Energy Ball', 'Protect']),
      A('Garchomp', 'Rough Skin', 'Life Orb', 'Jolly', {atk: 32, spe: 32, hp: 2}, ['Earthquake', 'Rock Slide', 'Dragon Claw', 'Protect']),
      A('Kingambit', 'Defiant', 'Black Glasses', 'Adamant', {atk: 32, hp: 32, spe: 2}, ['Kowtow Cleave', 'Sucker Punch', 'Iron Head', 'Protect']),
      A('Venusaur', 'Chlorophyll', 'Focus Sash', 'Modest', {spa: 32, spe: 32, hp: 2}, ['Sludge Bomb', 'Energy Ball', 'Sleep Powder', 'Protect']),
      A('Whimsicott', 'Prankster', 'Sitrus Berry', 'Timid', {spa: 32, spe: 32, hp: 2}, ['Moonblast', 'Tailwind', 'Encore', 'Protect']),
    ],
    brings: [[0, 1, 2, 3], [0, 1, 4, 3], [0, 1, 2, 5], [1, 0, 3, 4]],
  },
  dragonite: { // Mega Dragonite + Garchomp + Tailwind
    team: [
      A('Dragonite-Mega', 'Multiscale', 'Dragoninite', 'Adamant', {atk: 32, hp: 32, spe: 2}, ['Extreme Speed', 'Dragon Claw', 'Iron Head', 'Protect']),
      A('Garchomp', 'Rough Skin', 'Life Orb', 'Jolly', {atk: 32, spe: 32, hp: 2}, ['Earthquake', 'Rock Slide', 'Dragon Claw', 'Protect']),
      A('Whimsicott', 'Prankster', 'Focus Sash', 'Timid', {spa: 32, spe: 32, hp: 2}, ['Moonblast', 'Tailwind', 'Encore', 'Protect']),
      A('Kingambit', 'Defiant', 'Black Glasses', 'Adamant', {atk: 32, hp: 32, spe: 2}, ['Kowtow Cleave', 'Sucker Punch', 'Iron Head', 'Protect']),
      A('Arcanine-Hisui', 'Intimidate', 'Sitrus Berry', 'Adamant', {atk: 32, hp: 32, spe: 2}, ['Flare Blitz', 'Rock Slide', 'Extreme Speed', 'Protect']),
      A('Floette-Eternal', 'Flower Veil', 'Fairy Feather', 'Modest', {spa: 32, hp: 32, spe: 2}, ['Moonblast', 'Dazzling Gleam', 'Calm Mind', 'Protect']),
    ],
    brings: [[2, 0, 1, 3], [0, 1, 2, 4], [2, 1, 0, 5], [4, 2, 0, 3]],
  },
};

function setText(s) {
  return [`${s.name}${s.item ? ' @ ' + s.item : ''}`, `Ability: ${s.ability}`, `Level: 50`,
    'EVs: ' + Object.entries(s.evs).map(([k, v]) => `${v} ${k.toUpperCase()}`).join(' / '),
    `${s.nature} Nature`, ...s.moves.map(m => `- ${m}`)].join('\n');
}
function validate(team, label) {
  const v = new TeamValidator(FORMAT);
  const p = v.validateTeam(Teams.import(team.map(setText).join('\n\n')));
  if (p) { console.error(`INVALID ${label}:\n  ` + p.join('\n  ')); return false; } return true;
}

// ------------------------------------------------------------------ battle state (parsed from omniscient log)
function newState() {
  return {turn: 0, tr: false, weather: '', sides: {p1: {}, p2: {}}, faints: {p1: 0, p2: 0},
          active: {p1: [null, null], p2: [null, null]}, log: [], events: {}};
}
function parseLine(st, l) {
  const parts = l.split('|');
  const tag = parts[1];
  const pos = (s) => s && s.match(/^(p[12])([ab]): (.*)$/);
  if (tag === 'turn') st.turn = +parts[2];
  else if (tag === 'switch' || tag === 'drag' || tag === 'detailschange') {
    const m = pos(parts[2]); if (!m) return;
    const species = parts[3].split(',')[0];
    const [hp, mx] = (parts[4] || '100/100').split(' ')[0].split('/').map(Number);
    const rec = st.sides[m[1]][m[3]] || (st.sides[m[1]][m[3]] = {});
    Object.assign(rec, {nick: m[3], species, hp, maxhp: mx || rec.maxhp, slot: m[2], taunt: 0, protectedLast: false, fainted: false, firstTurn: st.turn, fresh: true, boosts: {}, status: rec.status || ''});
    if (tag !== 'detailschange') st.active[m[1]][m[2] === 'a' ? 0 : 1] = rec;
  } else if (tag === '-damage' || tag === '-heal' || tag === '-sethp') {
    const m = pos(parts[2]); if (!m) return;
    const rec = st.sides[m[1]][m[3]]; if (!rec) return;
    const hp = parts[3].split(' ')[0];
    if (hp.includes('/')) { rec.hp = +hp.split('/')[0]; } else rec.hp = 0;
  } else if (tag === 'faint') {
    const m = pos(parts[2]); if (!m) return;
    const rec = st.sides[m[1]][m[3]]; if (rec) { rec.hp = 0; rec.fainted = true; }
    st.faints[m[1]]++;
    st.active[m[1]] = st.active[m[1]].map(r => (r && r.nick === m[3]) ? null : r);
  } else if (tag === '-fieldstart') { if (/Trick Room/.test(parts[2])) { st.tr = true; st.events['tr_up_turn'] ??= st.turn; } }
  else if (tag === '-fieldend') { if (/Trick Room/.test(parts[2])) st.tr = false; }
  else if (tag === '-weather') { st.weather = parts[2]; }
  else if (tag === '-boost' || tag === '-unboost') {
    const m = pos(parts[2]); if (!m) return; const r = st.sides[m[1]][m[3]]; if (!r) return;
    r.boosts ??= {}; r.boosts[parts[3]] = Math.max(-6, Math.min(6, (r.boosts[parts[3]] || 0) + (tag === '-boost' ? 1 : -1) * (+parts[4] || 1)));
  } else if (tag === '-setboost') { const m = pos(parts[2]); const r = m && st.sides[m[1]][m[3]]; if (r) { r.boosts ??= {}; r.boosts[parts[3]] = +parts[4]; } }
  else if (tag === '-clearallboost') { for (const side of ['p1', 'p2']) for (const r of Object.values(st.sides[side])) r.boosts = {}; }
  else if (tag === '-clearboost' || tag === '-clearnegativeboost' || tag === '-clearpositiveboost') { const m = pos(parts[2]); const r = m && st.sides[m[1]][m[3]]; if (r && r.boosts) { for (const k of Object.keys(r.boosts)) if (tag === '-clearboost' || (tag === '-clearnegativeboost' && r.boosts[k] < 0) || (tag === '-clearpositiveboost' && r.boosts[k] > 0)) r.boosts[k] = 0; } }
  else if (tag === '-status') { const m = pos(parts[2]); const r = m && st.sides[m[1]][m[3]]; if (r) r.status = parts[3]; }
  else if (tag === '-curestatus') { const m = pos(parts[2]); const r = m && st.sides[m[1]][m[3]]; if (r) r.status = ''; }
  else if (tag === '-sidestart' || tag === '-sideend') { const side = (parts[2] || '').slice(0, 2); const cond = (parts[3] || '').replace(/^move: /, ''); st.sideConds ??= {p1: {}, p2: {}}; if (st.sideConds[side]) st.sideConds[side][cond] = tag === '-sidestart'; }
  else if (tag === '-start') {
    const m = pos(parts[2]); if (m && /Taunt/.test(parts[3])) { const r = st.sides[m[1]][m[3]]; if (r) r.taunt = 3; if (m[1] === 'p1') st.events['taunted_' + m[3]] ??= st.turn; }
    if (m && /Encore/.test(parts[3]) && m[1] === 'p1') st.events['encored_' + m[3]] ??= st.turn;
  } else if (tag === '-end') {
    const m = pos(parts[2]); if (m && /Taunt/.test(parts[3])) { const r = st.sides[m[1]][m[3]]; if (r) r.taunt = 0; }
  } else if (tag === 'cant') {
    const m = pos(parts[2]); if (m && m[1] === 'p1') st.events[`cant_${m[3]}_${parts[3]}`] ??= st.turn;
  } else if (tag === 'move') {
    const m = pos(parts[2]); if (!m) return;
    const rec = st.sides[m[1]][m[3]]; if (rec) { rec.fresh = false; rec.lastMove = parts[3]; rec.protectedLast = /Protect|Detect|Wide Guard/.test(parts[3]) && !l.includes('[still]'); }
    if (m[1] === 'p1' && parts[3] === 'Trick Room') st.events['tr_attempt_turn'] ??= st.turn;
    if (m[1] === 'p2' && parts[3] === 'Trick Room') st.events['opp_tr_turn'] ??= st.turn;
  } else if (tag === 'win') st.winner = parts[2];
  else if (tag === 'tie') st.winner = 'tie';
}

// ------------------------------------------------------------------ damage estimate (for AI choice only)
function stat(species, key, invest) {
  const b = D.species.get(species).baseStats[key];
  return key === 'hp' ? b + invest + 75 : b + invest + 20;
}
function estPct(atkRec, mv, defRec, st, spread) {
  const move = D.moves.get(mv);
  if (move.category === 'Status') return 0;
  const atkS = D.species.get(atkRec.species), defS = D.species.get(defRec.species);
  let bp = move.basePower;
  if (move.id === 'eruption') bp = Math.max(1, Math.floor(150 * atkRec.hp / atkRec.maxhp));
  if (move.id === 'lastrespects') bp = 50 + 50 * st.faints[atkRec.side];
  if (move.id === 'weatherball') bp = st.weather && st.weather !== 'none' ? 100 : 50;
  if (move.id === 'lowkick') bp = defS.weightkg > 100 ? 100 : defS.weightkg > 50 ? 80 : 60;
  if (!bp) return 0;
  let type = move.type;
  if (move.id === 'weatherball' && /Sunny/.test(st.weather)) type = 'Fire';
  if (!D.getImmunity(type, defS.types)) return 0;
  if (defS.abilities['0'] === 'Levitate' && type === 'Ground') return 0;
  const eff = Math.pow(2, D.getEffectiveness(type, defS.types));
  const phys = move.category === 'Physical';
  const stage = (b) => b >= 0 ? (2 + b) / 2 : 2 / (2 - b);
  const aKey = move.id === 'bodypress' ? 'def' : (phys ? 'atk' : 'spa'), dKey = phys ? 'def' : 'spd';
  const Aస = Math.floor(stat(atkRec.species, aKey, 32) * stage((atkRec.boosts || {})[aKey] || 0));
  const Dx = Math.floor(stat(defRec.species, dKey, 16) * stage((defRec.boosts || {})[dKey] || 0));
  let base = Math.floor(Math.floor(22 * bp * Aస / Dx) / 50) + 2;
  let mod = eff * (atkS.types.includes(type) ? 1.5 : 1) * (spread ? 0.75 : 1);
  if (/Sunny/.test(st.weather)) mod *= type === 'Fire' ? 1.5 : type === 'Water' ? 0.5 : 1;
  if (/Rain/.test(st.weather)) mod *= type === 'Water' ? 1.5 : type === 'Fire' ? 0.5 : 1;
  if (atkRec.status === 'brn' && phys && move.id !== 'facade') mod *= 0.5;
  if (st.terrain && /Psychic/.test(st.terrain) && type === 'Psychic') mod *= 1.3;
  if (st.terrain && /Grassy/.test(st.terrain) && type === 'Grass') mod *= 1.3;
  if (st.terrain && /Electric/.test(st.terrain) && type === 'Electric') mod *= 1.3;
  if (st.terrain && /Misty/.test(st.terrain) && type === 'Dragon') mod *= 0.5;
  if (st.sideConds && st.sideConds[defRec.side] && ((phys && st.sideConds[defRec.side]['Reflect']) || (!phys && st.sideConds[defRec.side]['Light Screen']) || st.sideConds[defRec.side]['Aurora Veil'])) mod *= 2 / 3;
  return 100 * base * 0.925 * mod / stat(defRec.species, 'hp', 32);
}

// ------------------------------------------------------------------ choice helpers
function foeSlotTarget(slotIdx) { return slotIdx === 0 ? '1' : '2'; } // p_a -> 1, p_b -> 2 (foe positions)
function allyTarget(mySlotIdx) { return mySlotIdx === 0 ? '-2' : '-1'; }

function chooseSwitchIn(req, prefer) {
  const bench = req.side.pokemon.map((p, i) => ({p, i})).filter(x => !x.p.active && !/fnt/.test(x.p.condition));
  if (!bench.length) return null;
  for (const name of prefer) { const b = bench.find(x => x.p.details.startsWith(name)); if (b) return b.i + 1; }
  return bench[0].i + 1;
}

// ---- our scripted plan
function ourChoice(req, st, opts) {
  if (req.teamPreview) {
    // bring 4: Oranguru, Sinistcha lead; Camerupt, Farigiraf back
    const order = (opts.leads || ['Oranguru', 'Sinistcha', 'Camerupt', 'Farigiraf']);
    const idx = order.map(n => req.side.pokemon.findIndex(p => p.details.startsWith(n)) + 1);
    return `team ${idx.join('')}`;
  }
  if (req.forceSwitch) {
    const taken = new Set();
    return req.forceSwitch.map(f => {
      if (!f) return 'pass';
      const bench = req.side.pokemon.map((p, i) => ({p, i})).filter(x => !x.p.active && !/fnt/.test(x.p.condition) && !taken.has(x.i));
      const order = opts.switchOrder || ['Ampharos', 'Camerupt', 'Torkoal', 'Slowbro', 'Avalugg', 'Farigiraf', 'Sinistcha', 'Oranguru'];
      let pick = null; for (const n of order) { const b = bench.find(x => x.p.details.startsWith(n)); if (b) { pick = b; break; } }
      pick = pick || bench[0];
      if (!pick) return 'pass';
      taken.add(pick.i); return 'switch ' + (pick.i + 1);
    }).join(', ');
  }
  const foes = st.active.p2.filter(Boolean);
  const choices = [];
  const oppSpecies = new Set(Object.values(st.sides.p2).map(r => r.species));
  const oppCanTR = [...oppSpecies].some(s => { const ls = D.species.getLearnsetData(D.species.get(s).id); return ls && ls.learnset && ls.learnset.trickroom; });
  const attackerOut = st.active.p1.some(r => r && !['Oranguru', 'Sinistcha', 'Farigiraf'].includes(r.species) && !(r.species.startsWith('Avalugg') && opts.leads && opts.leads[1] === 'Avalugg' && st.turn <= 2));
  const benchAttacker = chooseSwitchIn(req, opts.switchOrder || ['Camerupt', 'Torkoal', 'Slowbro', 'Farigiraf']);
  const benchIsAttacker = benchAttacker && !/Oranguru|Sinistcha/.test(req.side.pokemon[benchAttacker - 1].details);
  // which support leaves on the pivot turn?
  //  sinistcha: Sinistcha out, sweeper enters her slot, Oranguru Protects (keeps Instruct next turn; sweeper eats anything aimed at Sinistcha's slot)
  //  oranguru : Oranguru out, sweeper enters his slot, Sinistcha Rage Powders (sweeper untouchable by single-target this turn; no Instruct until Oranguru returns)
  //  adaptive : oranguru-pivot if Sinistcha is healthy enough to keep redirecting (>= PIVOT_HP % ), else sinistcha-pivot
  const sin = st.active.p1.find(r => r && r.species === 'Sinistcha');
  let who = opts.pivot;
  if (who === 'adaptive') who = (sin && sin.hp / sin.maxhp >= (opts.pivotHp || 0.6)) ? 'oranguru' : 'sinistcha';
  const pivotSlot = (st.tr && !attackerOut && benchIsAttacker && st.turn >= 2)
    ? st.active.p1.findIndex(r => r && r.species === (who === 'oranguru' ? 'Oranguru' : 'Sinistcha')) : -1;
  req.active.forEach((act, i) => {
    const me = st.active.p1[i];
    if (!me || !act || !act.moves) { choices.push('pass'); return; }
    const mv = (n) => act.moves.find(m => m.move === n && !m.disabled);
    const partner = st.active.p1[1 - i];
    let c = null;
    if (i === pivotSlot && !act.trapped) { choices.push('switch ' + benchAttacker); return; }
    const bestTarget = (moveName) => {
      let best = null, bd = -1;
      st.active.p2.forEach((f, j) => { if (!f) return; const d = estPct(me, moveName, f, st, false); if (d > bd) { bd = d; best = j; } });
      return {j: best, d: bd};
    };
    if (me.species === 'Oranguru') {
      if (!st.tr && mv('Trick Room') && !(st.turn === 1 && oppCanTR && opts.imprisonFirst && mv('Imprison'))) c = 'move Trick Room';
      else if (st.turn === 1 && mv('Imprison') && !st.tr) c = 'move Imprison';
      else if (partner && !['Sinistcha', 'Farigiraf'].includes(partner.species) && mv('Instruct') && st.tr && !(opts.foProtect !== false && st.active.p2.some(f => f && f.fresh && (() => { const ls = D.species.getLearnsetData(D.species.get(f.species).id); return !!(ls && ls.learnset && ls.learnset.fakeout); })()))) c = 'move Instruct ' + allyTarget(i);
      else if (partner && !['Sinistcha', 'Farigiraf'].includes(partner.species) && st.tr && mv('Imprison') && me.lastMove !== 'Imprison') c = 'move Imprison';
      else if (mv('Protect') && !me.protectedLast) c = 'move Protect';
      else if (mv('Imprison') && me.lastMove !== 'Imprison') c = 'move Imprison';
      else if (mv('Trick Room') && !st.tr) c = 'move Trick Room';
      else c = 'move ' + act.moves.find(m => !m.disabled).move;
    } else if (me.species === 'Sinistcha') {
      if (mv('Rage Powder') && (st.turn <= 2 || (partner && partner))) c = 'move Rage Powder';
      else if (mv('Strength Sap') && me.hp < me.maxhp * 0.6) { const t = bestTarget('Strength Sap'); c = 'move Strength Sap ' + foeSlotTarget(t.j ?? 0); }
      else if (mv('Trick Room') && !st.tr) c = 'move Trick Room';
      else if (mv('Protect') && !me.protectedLast) c = 'move Protect';
      else c = 'move ' + act.moves.find(m => !m.disabled).move;
    } else if (me.species.startsWith('Avalugg') && mv('Wide Guard') && !me.protectedLast && st.active.p2.some(f => f && (() => {
        // real-player data: is this species' most likely click right now a spread move?
        const d = (typeof replayMoveDist === 'function') ? replayMoveDist(f.species, st.turn) : null;
        if (d && d.moves) { const top = Object.entries(d.moves).sort((a, b) => b[1] - a[1])[0]; if (top && top[1] >= 0.3) { const mvx = D.moves.get(top[0]); if (['allAdjacentFoes', 'allAdjacent'].includes(mvx.target) && mvx.category !== 'Status') return true; } }
        return false; })()) ) {
      c = 'move Wide Guard';
    } else if (me.species.startsWith('Avalugg') && mv('Wide Guard') && (st.turn === 1 || (!st.tr && st.active.p2.filter(Boolean).length === 2)) && st.active.p2.some(f => f && (() => { const ls = D.species.getLearnsetData(D.species.get(f.species).id); return ls && ls.learnset && Object.keys(ls.learnset).some(k => ['heatwave','eruption','earthquake','rockslide','hypervoice','makeitrain','muddywater','dazzlinggleam','blizzard','sludgewave','snarl','icywind','matchagotcha','bulldoze','discharge','lavaplume','surf'].includes(k)); })())) {
      c = 'move Wide Guard';
    } else if (!['Oranguru', 'Sinistcha', 'Farigiraf'].includes(me.species)) {
      const canLearnFO = (f) => { const ls = D.species.getLearnsetData(D.species.get(f.species).id); return !!(ls && ls.learnset && ls.learnset.fakeout); };
      const freshFO = st.active.p2.some(f => f && canLearnFO(f) && f.fresh);
      if (opts.foProtect !== false && freshFO && st.tr && mv('Protect') && !me.protectedLast) { choices.push('move Protect'); return; }
      // generic sweeper: prefer the foe that threatens to KO us and that we can remove in <=2 hits (Instruct), else best damage
      const attacks = act.moves.filter(m => !m.disabled && D.moves.get(m.move).category !== 'Status');
      const foesIdx = st.active.p2.map((f, j) => f ? j : -1).filter(j => j >= 0);
      let best = null;
      const threatTo = (f) => { let t = 0; for (const ty of D.species.get(f.species).types) t = Math.max(t, estPct({...f}, 'Hyper Beam', me, st, false) * (Math.pow(2, D.getEffectiveness(ty, D.species.get(me.species).types)) / 1) * 0.6); return t; };
      for (const m of attacks) {
        const move = D.moves.get(m.move);
        const spread = ['allAdjacentFoes', 'allAdjacent'].includes(move.target);
        if (spread) {
          let v = 0, kos = 0; for (const j of foesIdx) { const f = st.active.p2[j]; const d = estPct(me, m.move, f, st, true); v += d; if (d >= 100 * f.hp / f.maxhp) kos++; }
          const canLearn = (f, mv) => { const ls = D.species.getLearnsetData(D.species.get(f.species).id); return !!(ls && ls.learnset && ls.learnset[mv]); };
          if (opts.prioAware && move.id === 'eruption') {
            // Sucker Punch lands before we move: re-estimate Eruption at the HP we'd actually have
            let chip = 0; for (const j of foesIdx) { const f = st.active.p2[j]; if (canLearn(f, 'suckerpunch')) chip = Math.max(chip, estPct(f, 'Sucker Punch', me, st, false)); }
            if (chip > 0) { const meChipped = {...me, hp: Math.max(1, me.hp - chip / 100 * me.maxhp)}; v = 0; kos = 0; for (const j of foesIdx) { const f = st.active.p2[j]; const d = estPct(meChipped, m.move, f, st, true); v += d; if (d >= 100 * f.hp / f.maxhp) kos++; } }
          }   // expect ~35-45% chip before we move
          if (opts.prioAware && foesIdx.some(j => canLearn(st.active.p2[j], 'wideguard') && !st.active.p2[j].seenNoWideGuard)) v *= 0.5;
          if (move.target === 'allAdjacent' && partner) v -= 0.8 * estPct(me, m.move, partner, st, true);
          v += 35 * kos;
          if (!best || v > best.v) best = {c: `move ${m.move}`, v};
        } else {
          for (const j of foesIdx) {
            const f = st.active.p2[j];
            const d = estPct(me, m.move, f, st, false);
            const hpPct = 100 * f.hp / f.maxhp;
            const canInstruct = partner && partner.species === 'Oranguru' && st.tr && !partner.taunt;
            let v = d;
            if (d >= hpPct) v += 45;                       // KO now
            else if (canInstruct && 2 * d >= hpPct) v += 35 + threatTo(f) * 0.5; // KO with Instruct, weighted by how dangerous it is
            v += threatTo(f) * 0.25;
            if (!best || v > best.v) best = {c: `move ${m.move} ${foeSlotTarget(j)}`, v};
          }
        }
      }
      if (best) c = best.c;
      else if (mv('Protect') && !me.protectedLast) c = 'move Protect';
      else c = 'move ' + act.moves.find(m => !m.disabled).move;
    } else if (me.species === 'Farigiraf') {
      if (!st.tr && mv('Trick Room')) c = 'move Trick Room';
      else if (mv('Imprison') && me.lastMove !== 'Imprison' && st.turn <= 3) c = 'move Imprison';
      else if (mv('Foul Play')) { const t = bestTarget('Foul Play'); c = 'move Foul Play ' + foeSlotTarget(t.j ?? 0); }
      else c = 'move ' + act.moves.find(m => !m.disabled).move;
    } else c = 'move ' + act.moves.find(m => !m.disabled).move;
    choices.push(c);
  });
  return choices.join(', ');
}

// ---- opponent heuristic AI
function oppChoice(req, st, core, policy, rng) {
  if (policy === 'replay') {
    if (req.teamPreview) { const b = replayLeads(core, rng) || core.brings[Math.floor(rng() * core.brings.length)]; return 'team ' + b.map(i => i + 1).join(''); }
    if (!req.forceSwitch && BEH && BEH.switchModel) {
      // voluntary switch: real per-species rate by HP bucket (falls back to pooled 21%); target = bench mon that takes least from our actives
      const parts = [];
      let any = false;
      req.active.forEach((act, i) => {
        const me = st.active.p2[i]; if (!me || act.trapped) { parts.push(null); return; }
        const sm = BEH.switchModel[me.species] || BEH.switchModel[me.species.replace(/-Mega.*$/, '')];
        const hb = me.hp / me.maxhp > 0.75 ? 'hi' : me.hp / me.maxhp > 0.4 ? 'mid' : 'lo';
        let p = sm ? (st.tr && sm.underTR != null ? sm.underTR : (sm[hb] ?? 0.2)) : 0.2;
        if (st.turn === 1) p = sm && sm.turn1 != null ? sm.turn1 : 0.05;
        if (rng() < p) {
          const bench = req.side.pokemon.map((pk, k) => ({pk, k})).filter(x => !x.pk.active && !/fnt/.test(x.pk.condition));
          if (bench.length) {
            let best = null;
            for (const b of bench) {
              const spName = b.pk.details.split(',')[0]; const fake = {species: spName, hp: 1, maxhp: 1, side: 'p2'};
              let threat = 0; st.active.p1.forEach(f => { if (!f) return; for (const mv of ['Eruption', 'Earth Power', 'Ice Spinner', 'Flash Cannon']) threat = Math.max(threat, estPct(f, mv, fake, st, false)); });
              if (!best || threat < best.threat) best = {k: b.k, threat};
            }
            parts.push('switch ' + (best.k + 1)); any = true; return;
          }
        }
        parts.push(null);
      });
      if (any) {
        const rc = replayChoice(req, st, core, rng) || [];
        const merged = parts.map((p, i) => p || rc[i] || null);
        if (merged.every(Boolean) && new Set(merged.filter(m => m.startsWith('switch'))).size === merged.filter(m => m.startsWith('switch')).length) return merged.join(', ');
      }
    }
    if (!req.forceSwitch && rng() < 0.7) {
      const rc = replayChoice(req, st, core, rng);
      if (rc && rc.every(c => c !== null)) return rc.join(', ');
    }
    return oppChoice(req, st, core, 'antiTR', rng);
  }
  if (req.teamPreview) {
    const b = core.brings[Math.floor(rng() * core.brings.length)];
    return 'team ' + b.map(i => i + 1).join('');
  }
  if (req.forceSwitch) {
    const taken = new Set();
    return req.forceSwitch.map(f => {
      if (!f) return 'pass';
      const b = req.side.pokemon.map((p, i) => ({p, i})).find(x => !x.p.active && !/fnt/.test(x.p.condition) && !taken.has(x.i));
      if (!b) return 'pass'; taken.add(b.i); return 'switch ' + (b.i + 1);
    }).join(', ');
  }
  const setter = st.active.p1.findIndex(r => r && (r.species === 'Oranguru' || r.species === 'Farigiraf'));
  const sweeper = st.active.p1.findIndex(r => r && r.species.startsWith('Camerupt'));
  const choices = [];
  req.active.forEach((act, i) => {
    const me = st.active.p2[i];
    if (!me || !act || !act.moves) { choices.push('pass'); return; }
    const mv = (n) => act.moves.find(m => m.move === n && !m.disabled);
    const options = [];
    for (const m of act.moves) {
      if (m.disabled) continue;
      const move = D.moves.get(m.move);
      if (move.category === 'Status') {
        if (move.id === 'taunt' && setter >= 0 && !st.active.p1[setter].taunt) options.push({c: `move Taunt ${foeSlotTarget(setter)}`, v: st.tr ? 75 : 60});
        if (move.id === 'protect' && !me.protectedLast) {
          // expect a KO on us?
          let incoming = 0;
          st.active.p1.forEach(f => { if (!f) return; for (const fm of ['Earth Power', 'Eruption', 'Foul Play', 'Flash Cannon']) incoming = Math.max(incoming, estPct(f, fm, me, st, fm === 'Eruption')); });
          const willDie = incoming * (st.tr ? 2 : 1) >= 100 * me.hp / me.maxhp;
          if (willDie && st.tr) options.push({c: 'move Protect', v: 55});
        }
        if (move.id === 'tailwind' && !st.tr && st.turn === 1 && policy !== 'antiTR') options.push({c: 'move Tailwind', v: 30});
        if (move.id === 'tailwind' && !st.tr && st.turn === 1 && policy === 'antiTR' && core.team.some(t => t.name.startsWith('Dragonite') || t.name.startsWith('Arcanine'))) options.push({c: 'move Tailwind', v: 65});
        if (core.tr && move.id === 'trickroom' && !st.tr && !me.taunt) options.push({c: 'move Trick Room', v: st.turn === 1 ? 95 : 70});
        if (core.tr && (move.id === 'ragepowder' || move.id === 'followme') && !st.tr && st.active.p2[1 - i]) options.push({c: `move ${m.move}`, v: 90});
        if (core.tr && move.id === 'helpinghand' && st.tr && st.active.p2[1 - i]) options.push({c: `move Helping Hand ${i === 0 ? '-2' : '-1'}`, v: 40});
        if (move.id === 'encore' && setter >= 0 && st.active.p1[setter].lastMove === 'Trick Room' && st.tr) options.push({c: `move Encore ${foeSlotTarget(setter)}`, v: 70});
        continue;
      }
      const spread = ['allAdjacentFoes', 'allAdjacent'].includes(move.target);
      if (spread) {
        let v = 0; st.active.p1.forEach(f => { if (f) v += estPct(me, m.move, f, st, true); });
        if (move.target === 'allAdjacent' && st.active.p2[1 - i]) v -= 0.5 * estPct(me, m.move, st.active.p2[1 - i], st, true);
        options.push({c: `move ${m.move}`, v});
      } else {
        st.active.p1.forEach((f, j) => {
          if (!f) return;
          let v = estPct(me, m.move, f, st, false);
          if (move.id === 'fakeout') { v = (setter === j && policy === 'antiTR' && !st.tr) ? 90 : (me.firstTurn === st.turn ? 25 : -1); }
          if (move.id === 'suckerpunch' && (f.species === 'Oranguru' || f.species === 'Sinistcha')) v *= 0.2;
          if (policy === 'antiTR' && j === setter && !st.tr) v *= 1.8;   // focus the setter
          if (sweeper >= 0 && j === sweeper && st.tr) v *= 1.5;         // kill the sweeper under TR
          if (v >= 100 * f.hp / f.maxhp) v += 40;                        // KO bonus
          options.push({c: `move ${m.move} ${foeSlotTarget(j)}`, v});
        });
      }
    }
    if (!options.length) { choices.push('move ' + act.moves.find(m => !m.disabled).move); return; }
    options.sort((a, b) => b.v - a.v);
    // small randomness so we don't replay one line thousands of times
    const pick = options[rng() < 0.85 ? 0 : Math.min(1, options.length - 1)];
    choices.push(pick.c);
  });
  return choices.join(', ');
}

// ------------------------------------------------------------------ replay-derived opponent model
const BEH_PATH = process.env.BEH || [require('path').join(__dirname, 'models/behaviour.json'), './models/behaviour.json', './behaviour.json'].find(p => fs.existsSync(p));
let BEH = BEH_PATH ? JSON.parse(fs.readFileSync(BEH_PATH, 'utf8')) : null;
let BEH_MTIME = BEH_PATH ? fs.statSync(BEH_PATH).mtimeMs : 0;
function refreshBeh() { try { if (BEH_PATH && fs.statSync(BEH_PATH).mtimeMs !== BEH_MTIME) { BEH = JSON.parse(fs.readFileSync(BEH_PATH, 'utf8')); BEH_MTIME = fs.statSync(BEH_PATH).mtimeMs; console.error('behaviour.json reloaded'); } } catch {} }
setInterval(refreshBeh, 60000).unref();
const ELO_BUCKET = process.env.ELO || '<1300';
function replayMoveDist(species, turn) {
  if (!BEH) return null;
  const tb = turn <= 1 ? 'T1' : turn <= 3 ? 'T2-3' : 'T4+';
  const base = species.replace(/-Mega.*$/, '');
  const byElo = (BEH.speciesByElo[ELO_BUCKET] || {})[base] || (BEH.speciesByElo[ELO_BUCKET] || {})[species];
  const pooled = BEH.species[base] || BEH.species[species];
  const src = byElo && byElo.actions >= 30 ? byElo : pooled;
  return src ? {moves: src.moves[tb] || {}, protectTR: (byElo && byElo.protectRateUnderTR) ?? (pooled && pooled.protectRate && pooled.protectRate.underTR), switchRate: src.switchRate} : null;
}
function replayChoice(req, st, core, rng) {
  // per active mon: sample a move from the real distribution restricted to this set, else fall back to heuristic
  const choices = [];
  req.active.forEach((act, i) => {
    const me = st.active.p2[i];
    if (!me) { choices.push('pass'); return; }
    const dist = replayMoveDist(me.species, st.turn);
    const legal = act.moves.filter(m => !m.disabled);
    let pick = null;
    if (dist) {
      const w = legal.map(m => (dist.moves[m.move] || 0) + 0.01);
      const tot = w.reduce((a, b) => a + b, 0);
      let r = rng() * tot; for (let k = 0; k < legal.length; k++) { r -= w[k]; if (r <= 0) { pick = legal[k]; break; } }
      if (!pick) pick = legal[legal.length - 1];
    }
    if (!pick) { choices.push(null); return; }
    const move = D.moves.get(pick.move);
    if (['normal', 'any', 'adjacentFoe'].includes(move.target)) {
      // target: real data has no target info, so use damage-max targeting (what humans mostly do)
      let best = 0, bd = -1; st.active.p1.forEach((f, j) => { if (!f) return; const d = estPct(me, pick.move, f, st, false) + (move.category === 'Status' ? (f.species === 'Oranguru' ? 50 : 0) : 0); if (d > bd) { bd = d; best = j; } });
      choices.push(`move ${pick.move} ${foeSlotTarget(best)}`);
    } else if (move.target === 'adjacentAlly' || move.target === 'adjacentAllyOrSelf') choices.push(`move ${pick.move} ${i === 0 ? '-2' : '-1'}`);
    else choices.push(`move ${pick.move}`);
  });
  return choices;
}
function replayLeads(core, rng) {
  if (!BEH || !BEH.leadsByElo) return null;
  const pairs = (BEH.leadsByElo[ELO_BUCKET] || BEH.leadsByElo['<1300'] || {}).topPairs || [];
  const names = core.team.map(t => t.name.replace(/-Mega.*$/, ''));
  const cands = pairs.map(([k, v]) => { const [a, b] = k.split(' + '); const ia = names.indexOf(a), ib = names.indexOf(b); return ia >= 0 && ib >= 0 && ia !== ib ? {ia, ib, v} : null; }).filter(Boolean);
  if (!cands.length) return null;
  const tot = cands.reduce((a, c) => a + c.v, 0); let r = rng() * tot;
  for (const c of cands) { r -= c.v; if (r <= 0) { const rest = [0, 1, 2, 3, 4, 5].filter(i => i !== c.ia && i !== c.ib).sort(() => rng() - 0.5).slice(0, 2); return [c.ia, c.ib, ...rest]; } }
  return null;
}

// ------------------------------------------------------------------ run one battle
function mulberry(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

async function runBattle(core, seed, policy, opts) {
  const rng = mulberry(seed);
  const stream = new BattleStream({keepAlive: false});
  const st = newState();
  const teamA = Teams.pack(Teams.import(OURS.map(setText).join('\n\n')));
  const teamB = Teams.pack(Teams.import(core.team.map(setText).join('\n\n')));
  const pending = {p1: null, p2: null};
  const done = (async () => {
    for await (const chunk of stream) {
      const lines = chunk.split('\n');
      if (lines[0] === 'update') { for (const l of lines) { parseLine(st, l); if (opts.keepLog && /\|(move|switch|-damage|faint|turn|-fieldstart|-fieldend|cant|-start|-fail|-immune|-activate|-enditem|-weather|-boost|-unboost|error)\|/.test(l)) st.log.push(l); } }
      else if (lines[0] === 'sideupdate') {
        const side = lines[1];
        const rq = lines.find(l => l.startsWith('|request|'));
        if (rq) {
          const req = JSON.parse(rq.slice(9));
          if (req.wait) continue;
          Object.values(st.sides[side]).forEach(r => { r.side = side; });
          Object.values(st.sides[side === 'p1' ? 'p2' : 'p1']).forEach(r => { r.side = side === 'p1' ? 'p2' : 'p1'; });
          let choice;
          try { choice = side === 'p1' ? ourChoice(req, st, opts) : oppChoice(req, st, core, policy, rng); }
          catch (e) { choice = 'default'; }
          stream.write(`>${side} ${choice}`);
        }
        const err = lines.find(l => l.startsWith('|error|'));
        if (err && !/Unavailable choice/.test(err)) { stream.write(`>${side} default`); }
      } else if (lines[0] === 'end') { break; }
    }
  })();
  const s = [Math.floor(rng() * 65536), Math.floor(rng() * 65536), Math.floor(rng() * 65536), Math.floor(rng() * 65536)];
  stream.write(`>start ${JSON.stringify({formatid: FORMAT, seed: s})}`);
  stream.write(`>player p1 ${JSON.stringify({name: 'TR', team: teamA})}`);
  stream.write(`>player p2 ${JSON.stringify({name: 'META', team: teamB})}`);
  const timer = setTimeout(() => { try { stream.write('>forcetie'); } catch {} }, 20000);
  await done;
  clearTimeout(timer);
  return st;
}

async function main() {
  const which = process.argv[2] || 'all';
  const N = +(process.argv[3] || 200);
  const policy = process.argv[4] || 'antiTR';
  const opts = {leads: process.env.LEADS ? process.env.LEADS.split(',') : undefined, prioAware: process.env.PRIOAWARE === '1', foProtect: process.env.FOPROTECT === '1', imprisonFirst: process.env.IMPRISON === '1', pivot: process.env.PIVOT || 'sinistcha', pivotHp: +(process.env.PIVOT_HP || 0.6)};
  validate(OURS, 'OUR TEAM');
  const results = {};
  for (const [name, core] of Object.entries(CORES)) {
    if (which !== 'all' && which !== name) continue;
    if (!validate(core.team, name)) continue;
    const agg = {games: 0, wins: 0, ties: 0, trT1: 0, trT2: 0, trEver: 0, oranguruDeadT1: 0, taunted: 0, flinched: 0, encored: 0, oppTR: 0, turns: 0, fails: {}};
    for (let g = 0; g < N; g++) {
      let st;
      try { st = await runBattle(core, 1000 * g + 7, policy, opts); } catch (e) { agg.fails[String(e).slice(0, 60)] = (agg.fails[String(e).slice(0, 60)] || 0) + 1; continue; }
      agg.games++;
      if (st.winner === 'TR') agg.wins++; else if (st.winner === 'tie' || !st.winner) agg.ties++;
      const up = st.events.tr_up_turn;
      if (up === 1) agg.trT1++;
      if (up && up <= 2) agg.trT2++;
      if (up) agg.trEver++;
      const ora = Object.values(st.sides.p1).find(r => r.species === 'Oranguru');
      if (ora && ora.fainted && (st.events.tr_up_turn === undefined || st.events.tr_up_turn > 1) && st.turn <= 2) agg.oranguruDeadT1++;
      if (st.events.taunted_Oranguru) agg.taunted++;
      if (Object.keys(st.events).some(k => k.startsWith('cant_Oranguru'))) agg.flinched++;
      if (st.events.encored_Oranguru) agg.encored++;
      if (st.events.opp_tr_turn) agg.oppTR++;
      agg.turns += st.turn;
      if (!up) {
        const why = ora && ora.fainted ? 'setter KOd before TR' : st.events.taunted_Oranguru ? 'taunted' : Object.keys(st.events).find(k => k.startsWith('cant_Oranguru')) || 'other';
        agg.fails[why] = (agg.fails[why] || 0) + 1;
      }
    }
    results[name] = agg;
    const pct = (x) => (100 * x / agg.games).toFixed(1) + '%';
    console.log(`\n=== ${name}  (${policy}, n=${agg.games}) ===`);
    console.log(`  win ${pct(agg.wins)}   tie ${pct(agg.ties)}   avg turns ${(agg.turns / agg.games).toFixed(1)}`);
    console.log(`  Trick Room up T1 ${pct(agg.trT1)}   by T2 ${pct(agg.trT2)}   ever ${pct(agg.trEver)}`);
    console.log(`  Oranguru taunted ${pct(agg.taunted)}  flinched ${pct(agg.flinched)}  encored ${pct(agg.encored)}  opp used TR ${pct(agg.oppTR)}`);
    if (Object.keys(agg.fails).length) console.log('  no-TR causes:', JSON.stringify(agg.fails));
  }
  fs.writeFileSync(require('path').join(__dirname, `sim_${which}_${policy}.json`), JSON.stringify(results, null, 1));
}
if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = {mulberry, CORES, OURS, setText, validate, newState, parseLine, estPct, ourChoice, oppChoice, foeSlotTarget, allyTarget, chooseSwitchIn, FORMAT, D};
