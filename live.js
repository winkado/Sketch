// live.js — turn the battle protocol into a REAL Showdown Battle object at every decision.
//
// We never step a local battle in lockstep with the server (RNG diverges). Instead, at each request we build a
// fresh Battle: our known team + a sampled opponent team consistent with everything revealed (sets.js), then
// overwrite it with the observed state — HP, status, stat stages, positions, faints, items consumed, weather,
// terrain, Trick Room and side conditions with remaining durations, PP used. The engine then owns every
// mechanic, and arena.searchChoice can clone it.
//
// Positions are the server's (p1/p2); `mySide` tells us which is ours.
'use strict';
const {Battle, Teams, Dex} = require(require('./ps.js'));
const S = require('./sim.js');
const {sampleTeam} = require('./sets.js');
const {StatBelief, statValue, boosted} = require('./infer.js');
const fs = require('fs');
const BP_ITEM = {'Life Orb': {mods: [[5324, 4096]]}, 'Expert Belt': {mods: [[4915, 4096]], seOnly: true}, 'Muscle Band': {bpMods: [[4505, 4096]], phys: true}, 'Wise Glasses': {bpMods: [[4505, 4096]], spec: true}};
const TYPE_ITEMS = new Set(['Charcoal','Mystic Water','Magnet','Miracle Seed','Never-Melt Ice','Black Belt','Poison Barb','Soft Sand','Sharp Beak','Twisted Spoon','Silver Powder','Hard Stone','Spell Tag','Dragon Fang','Black Glasses','Metal Coat','Silk Scarf','Fairy Feather']);
const D = Dex.mod('champions');
const FORMAT = S.FORMAT;

const pos = (s) => s && s.match(/^(p[12])([ab]): (.*)$/);
const toId = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const hpFrom = (str) => { const m = (str || '').match(/^(\d+)(?:\/(\d+))?/); if (!m) return null; if (!m[2]) return [+m[1], 100]; return [+m[1], +m[2]]; };
const WEATHER = {SunnyDay: 'sunnyday', RainDance: 'raindance', Sandstorm: 'sandstorm', Snowscape: 'snowscape', Snow: 'snowscape', Hail: 'snowscape'};

const obsHas = (obs, p) => Object.values(obs).some(r => r.species === p.species.name || r.species.replace(/-Mega.*$/, '') === p.species.baseSpecies);
class LiveState {
  constructor(myTeam, mySide, myName) {
    this.myTeam = myTeam; this.mySide = mySide; this.oppSide = mySide === 'p1' ? 'p2' : 'p1'; this.myName = myName;
    this.turn = 0; this.oppSix = []; this.myBring = null;
    this.mons = {p1: {}, p2: {}};          // nick -> record
    this.active = {p1: [null, null], p2: [null, null]};
    this.weather = null; this.weatherTurn = 0; this.terrain = null; this.terrainTurn = 0;
    this.tr = false; this.trTurn = 0;
    this.side = {p1: {}, p2: {}};          // side conditions -> start turn
    this.sampled = null;                   // current sampled opponent team (resampled when a reveal contradicts it)
    this.belief = {};                      // opp species -> StatBelief (inferred stat points / nature)
    this.ctx = {move: null, crit: false, turnMoves: []};   // per-line context for damage attribution / speed order
    this.rng = Math.random;
  }
  beliefFor(species) { const base = D.species.get(species); if (!base.exists) return null; return this.belief[species] ??= new StatBelief(base.baseStats); }
  ourSet(species) { return this.myTeam.find(m => m.name === species || m.name.replace(/-Mega.*$/, '') === species.replace(/-Mega.*$/, '')); }
  ourStat(species, key, stage = 0, rec = null) {
    const set = this.ourSet(species); if (!set) return null;
    // pre-Mega, our stats are the BASE forme's (the record's species tells us which forme is on the field)
    const megaNow = rec ? /-Mega/.test(rec.species) : /-Mega/.test(species);
    const sp = D.species.get(megaNow ? set.name : set.name.replace(/-Mega.*$/, ''));
    const nat = D.natures.get(set.nature); const n = nat.plus === key ? 1 : nat.minus === key ? -1 : 0;
    return boosted(statValue(sp.baseStats[key], (set.evs || {})[key] || 0, n, key === 'hp'), stage);
  }
  ourTypes(species, rec = null) { const set = this.ourSet(species); if (!set) return []; const megaNow = rec ? /-Mega/.test(rec.species) : /-Mega/.test(species); return D.species.get(megaNow ? set.name : set.name.replace(/-Mega.*$/, '')).types; }
  weatherMult(moveType) { const w = this.weather || ''; if (/Sunny/.test(w)) return moveType === 'Fire' ? 1.5 : moveType === 'Water' ? 0.5 : 1; if (/Rain/.test(w)) return moveType === 'Water' ? 1.5 : moveType === 'Fire' ? 0.5 : 1; return 1; }
  // ---- observation: a move just did `damage` (exact) to our mon, or changed their mon from pctBefore to pctAfter
  onDamage(attRec, attSide, move, tgtRec, tgtSide, exactDamage, pctBefore, pctAfter, fainted) {
    const mv = D.moves.get(move); if (!mv.exists || mv.category === 'Status' || !mv.basePower || mv.basePowerCallback || mv.multihit || mv.damage) return;
    const phys = mv.category === 'Physical';
    const attTypes = attSide === this.mySide ? this.ourTypes(attRec.species, attRec) : D.species.get(attRec.species).types;
    const tgtTypes = tgtSide === this.mySide ? this.ourTypes(tgtRec.species, tgtRec) : D.species.get(tgtRec.species).types;
    if (!D.getImmunity(mv.type, tgtTypes)) return;
    const typeMod = D.getEffectiveness(mv.type, tgtTypes);
    const m = {spread: this.ctx.spread, crit: this.ctx.crit, stab: attTypes.includes(mv.type), typeMod, burn: attRec.status === 'brn' && phys && attRec.ability !== 'Guts', weather: this.weatherMult(mv.type), mods: [], bpMods: []};
    if (this.ctx.helpingHand) m.bpMods.push([6144, 4096]);
    const tgtSideConds = this.side[tgtSide] || {}; if ((phys && tgtSideConds['Reflect']) || (!phys && tgtSideConds['Light Screen']) || tgtSideConds['Aurora Veil']) m.mods.push([2732, 4096]);
    const atkKey = phys ? 'atk' : 'spa', defKey = phys ? 'def' : 'spd';
    if (tgtSide === this.mySide && attSide === this.oppSide && exactDamage > 0) {
      // THEIR attack into OUR exact HP -> constrain their attacking stat (item hypotheses unless revealed)
      const B = this.beliefFor(attRec.species); if (!B) return;
      const ourD = this.ourStat(tgtRec.species, defKey, (tgtRec.boosts || {})[defKey] || 0, tgtRec); if (!ourD) return;
      m.atkStage = (attRec.boosts || {})[atkKey] || 0;
      let hyps;
      const item = attRec.item;
      if (item && BP_ITEM[item] && (!BP_ITEM[item].seOnly || typeMod > 0) && !(BP_ITEM[item].phys && !phys) && !(BP_ITEM[item].spec && phys)) hyps = [BP_ITEM[item]];
      else if (item && TYPE_ITEMS.has(item)) hyps = [{bpMods: [[4915, 4096]]}];   // assume it matches the move type; harmless if not
      else if (item === '' || (item && !BP_ITEM[item] && !TYPE_ITEMS.has(item))) hyps = [{}];
      else { let lo = 0.25; try { const SETS = JSON.parse(fs.readFileSync(require('path').join(__dirname, 'models', 'sets.json'), 'utf8')); const s = SETS[attRec.species] || SETS[attRec.species.replace(/-Mega.*$/, '')]; const li = s && s.items.find(([i]) => i === 'Life Orb'); if (li) lo = Math.min(0.8, Math.max(0.05, li[1])); } catch {}
        hyps = [{p: (1 - lo) * 0.5}, {p: (1 - lo) * 0.5, bpMods: [[4915, 4096]]}, {p: lo, mods: [[5324, 4096]]}]; }   // none / type item / Life Orb, weighted by usage
      if (attRec.ability === 'Sheer Force' && mv.secondary) hyps = hyps.map(h => ({...h, bpMods: [...(h.bpMods || []), [5325, 4096]]}));
      if (/Huge Power|Pure Power/.test(attRec.ability || '') && phys) hyps = hyps.map(h => ({...h, mods: [...(h.mods || []), [8192, 4096]]}));
      const rem = B.observeOutgoing(atkKey, ourD, mv.basePower, exactDamage, m, hyps);
      if (process.env.INFER_DEBUG) console.error(`  dmg obs: ${attRec.species} ${move} -> our ${tgtRec.species} ${exactDamage} (D=${ourD}) removed ${rem}, left ${B.c[atkKey].length}`);
    } else if (attSide === this.mySide && tgtSide === this.oppSide && pctBefore != null) {
      // OUR exact attack into THEIR percent -> joint constraint on their HP and defending stat
      const B = this.beliefFor(tgtRec.species); if (!B) return;
      const set = this.ourSet(attRec.species); if (!set) return;
      const ourA = this.ourStat(attRec.species, atkKey, (attRec.boosts || {})[atkKey] || 0, attRec);
      if (set.item && BP_ITEM[set.item] && (!BP_ITEM[set.item].seOnly || typeMod > 0)) { m.mods.push(...(BP_ITEM[set.item].mods || [])); m.bpMods.push(...(BP_ITEM[set.item].bpMods || [])); }
      else if (set.item && TYPE_ITEMS.has(set.item) && D.items.get(set.item).onBasePower) m.bpMods.push([4915, 4096]);
      if (set.ability === 'Sheer Force' && mv.secondary) m.bpMods.push([5325, 4096]);
      m.defStage = (tgtRec.boosts || {})[defKey] || 0;
      B.observeIncoming(defKey, ourA, mv.basePower, pctBefore, pctAfter, m, fainted);
    }
  }
  rec(side, nick, species) {
    const r = this.mons[side][nick] ??= {nick, species: species || nick, hp: 1, status: '', boosts: {}, fainted: false, item: undefined, ability: undefined, moves: new Set(), ppUsed: {}, volatiles: {}, lastMove: null, activeTurns: 0, mega: false};
    if (species) r.species = species;
    return r;
  }
  feed(line) {
    const parts = line.split('|'); const tag = parts[1];
    if (tag === 'turn') { this.finishTurnSpeed(); this.turn = +parts[2]; this.ctx = {move: null, crit: false, turnMoves: []}; for (const s of ['p1', 'p2']) for (const r of this.active[s]) if (r) r.activeTurns++; return; }
    if (tag === '-crit') { this.ctx.crit = true; return; }
    if (tag === '-singleturn') { const m = pos(parts[2]); if (m && /Helping Hand/.test(parts[3] || '')) this.rec(m[1], m[3]).helpingHand = true; return; }
    if (tag === 'poke') { if (parts[2] === this.oppSide) this.oppSix.push(parts[3].split(',')[0].replace(/-\*$/, '')); return; }
    if (tag === 'switch' || tag === 'drag' || tag === 'replace') {
      const m = pos(parts[2]); if (!m) return;
      const species = parts[3].split(',')[0];
      const r = this.rec(m[1], m[3], species);
      const hb = hpFrom(parts[4]) || [100, 100]; r.hp = hb[1] ? hb[0] / hb[1] : 0; r.hpAbs = hb[1] > 100 ? hb : null;
      const status = (parts[4] || '').split(' ')[1]; r.status = status && status !== 'fnt' ? status : '';
      r.boosts = {}; r.volatiles = {}; r.activeTurns = 0; r.fainted = false;
      const slot = m[2] === 'a' ? 0 : 1;
      const prev = this.active[m[1]][slot]; if (prev && prev !== r) prev.isActive = false;
      this.active[m[1]][slot] = r; r.isActive = true; r.slot = slot;
      return;
    }
    if (tag === 'detailschange') { const m = pos(parts[2]); if (m) { const r = this.rec(m[1], m[3]); r.species = parts[3].split(',')[0]; if (/-Mega/.test(r.species)) r.mega = true; } return; }
    if (tag === '-damage' || tag === '-heal' || tag === '-sethp') {
      const m = pos(parts[2]); if (!m) return; const r = this.rec(m[1], m[3]);
      const prevHp = r.hp, prevAbs = r.hpAbs ? r.hpAbs[0] : null;
      const hb = hpFrom(parts[3]); if (hb) { r.hp = hb[1] ? hb[0] / hb[1] : 0; if (hb[1] > 100) r.hpAbs = hb; }
      // attribute this damage to the current move (not residual/item/recoil damage: those carry [from])
      if (tag === '-damage' && this.ctx.move && !parts.some(p => /^\[from\]/.test(p)) && this.ctx.move.side !== m[1]) {
        const cm = this.ctx.move;
        if (m[1] === this.mySide && prevAbs != null && r.hpAbs) this.onDamage(cm.rec, cm.side, cm.name, r, m[1], prevAbs - r.hpAbs[0], null, null, false);
        else if (m[1] === this.oppSide && hb && hb[1] <= 100) this.onDamage(cm.rec, cm.side, cm.name, r, m[1], 0, Math.round(prevHp * 100), hb[0], false);
      }
      const status = (parts[3] || '').split(' ')[1]; if (status && status !== 'fnt') r.status = status;
      const from = parts.find(p => /^\[from\] item: /.test(p)); if (from) { const who = parts.find(p => p.startsWith('[of] ')); const tgt = who ? pos(who.slice(5)) : m; if (tgt) this.rec(tgt[1], tgt[3]).item = from.replace('[from] item: ', ''); }
      return;
    }
    if (tag === 'faint') { const m = pos(parts[2]); if (m) { const r = this.rec(m[1], m[3]); if (m[1] === this.oppSide && this.ctx.move && this.ctx.move.side === this.mySide && r.hp > 0) this.onDamage(this.ctx.move.rec, this.ctx.move.side, this.ctx.move.name, r, m[1], 0, Math.round(r.hp * 100), 0, true); r.hp = 0; r.fainted = true; r.status = ''; } return; }
    if (tag === 'move') {
      const m = pos(parts[2]); if (!m) return; const r = this.rec(m[1], m[3]);
      this.ctx.move = {rec: r, side: m[1], name: parts[3], spread: line.includes('[spread]')}; this.ctx.crit = false; this.ctx.helpingHand = !!r.helpingHand; r.helpingHand = false;
      const mvd = D.moves.get(parts[3]); this.ctx.turnMoves.push({rec: r, side: m[1], priority: mvd.exists ? mvd.priority : 0, turn: this.turn, tr: this.tr, ourTW: !!(this.side[this.mySide] || {})['Tailwind'], theirTW: !!(this.side[this.oppSide] || {})['Tailwind']});
      r.moves.add(parts[3]); r.ppUsed[parts[3]] = (r.ppUsed[parts[3]] || 0) + 1; r.lastMove = parts[3];
      r.volatiles.stall = /^(Protect|Detect|Spiky Shield|Baneful Bunker|King's Shield|Wide Guard|Quick Guard)$/.test(parts[3]) && !line.includes('[still]');
      const fa = parts.find(p => /^\[from\] ability: /.test(p)); if (fa) r.ability = fa.replace('[from] ability: ', '');
      return;
    }
    if (tag === '-boost' || tag === '-unboost') { const m = pos(parts[2]); if (!m) return; const r = this.rec(m[1], m[3]); r.boosts[parts[3]] = Math.max(-6, Math.min(6, (r.boosts[parts[3]] || 0) + (tag === '-boost' ? 1 : -1) * (+parts[4] || 1))); return; }
    if (tag === '-setboost') { const m = pos(parts[2]); if (m) this.rec(m[1], m[3]).boosts[parts[3]] = +parts[4]; return; }
    if (tag === '-clearallboost') { for (const s of ['p1', 'p2']) for (const r of Object.values(this.mons[s])) r.boosts = {}; return; }
    if (tag === '-clearboost') { const m = pos(parts[2]); if (m) this.rec(m[1], m[3]).boosts = {}; return; }
    if (tag === '-clearnegativeboost') { const m = pos(parts[2]); if (m) { const r = this.rec(m[1], m[3]); for (const k in r.boosts) if (r.boosts[k] < 0) r.boosts[k] = 0; } return; }
    if (tag === '-status') { const m = pos(parts[2]); if (m) this.rec(m[1], m[3]).status = parts[3]; return; }
    if (tag === '-curestatus') { const m = pos(parts[2]); if (m) this.rec(m[1], m[3]).status = ''; return; }
    if (tag === '-start') { const m = pos(parts[2]); if (!m) return; const r = this.rec(m[1], m[3]); const v = (parts[3] || '').replace(/^move: /, ''); r.volatiles[toId(v)] = {turn: this.turn, move: parts[4] || null}; return; }
    if (tag === '-end') { const m = pos(parts[2]); if (!m) return; const r = this.rec(m[1], m[3]); delete r.volatiles[toId((parts[3] || '').replace(/^move: /, ''))]; return; }
    if (tag === '-item') { const m = pos(parts[2]); if (m) this.rec(m[1], m[3]).item = parts[3]; return; }
    if (tag === '-enditem') { const m = pos(parts[2]); if (m) { const r = this.rec(m[1], m[3]); r.item = ''; r.itemConsumed = parts[3]; } return; }
    if (tag === '-ability') { const m = pos(parts[2]); if (m) this.rec(m[1], m[3]).ability = parts[3]; return; }
    if (tag === '-mega') { const m = pos(parts[2]); if (m) { const r = this.rec(m[1], m[3]); r.mega = true; r.item = parts[4] || r.item; } return; }
    if (tag === '-weather') { const w = parts[2]; if (w === 'none') { this.weather = null; } else { if (!parts.includes('[upkeep]')) this.weatherTurn = this.turn; this.weather = w; } return; }
    if (tag === '-fieldstart') { const f = (parts[2] || '').replace(/^move: /, ''); if (/Trick Room/.test(f)) { this.tr = true; this.trTurn = this.turn; } else if (/Terrain/.test(f)) { this.terrain = f; this.terrainTurn = this.turn; } return; }
    if (tag === '-fieldend') { const f = (parts[2] || '').replace(/^move: /, ''); if (/Trick Room/.test(f)) this.tr = false; else if (/Terrain/.test(f)) this.terrain = null; return; }
    if (tag === '-sidestart' || tag === '-sideend') { const side = (parts[2] || '').slice(0, 2); const cond = (parts[3] || '').replace(/^move: /, ''); if (tag === '-sidestart') this.side[side][cond] = this.turn; else delete this.side[side][cond]; return; }
  }

  finishTurnSpeed() {
    const mv = this.ctx.turnMoves.filter(x => x.priority === 0 && x.rec && !x.rec.fainted);
    for (let i = 0; i + 1 < mv.length; i++) {
      const a = mv[i], b = mv[i + 1]; if (a.side === b.side) continue;
      const ours = a.side === this.mySide ? a : b, theirs = a.side === this.mySide ? b : a; const theyFirst = theirs === a;
      const ourSpe = this.ourStat(ours.rec.species, 'spe', (ours.rec.boosts || {}).spe || 0, ours.rec); if (!ourSpe) continue;
      const ourEff = Math.trunc(ourSpe * (ours.ourTW ? 2 : 1) * (ours.rec.status === 'par' ? 0.5 : 1));
      const B = this.beliefFor(theirs.rec.species); if (!B) continue;
      const opts = {trickRoom: a.tr, tailwind: theirs.theirTW, par: theirs.rec.status === 'par', stage: (theirs.rec.boosts || {}).spe || 0, scarf: theirs.rec.item === 'Choice Scarf'};
      const removed = B.observeSpeed(ourEff, theyFirst, opts);
      if (process.env.INFER_DEBUG) console.error(`  speed obs T${a.turn}: ${theirs.rec.species} ${theyFirst ? 'before' : 'after'} our ${ours.rec.species}(${ourEff}) tr=${opts.trickRoom} -> removed ${removed}, left ${B.c.spe.length}`);
      if (removed === 0 && !opts.scarf && theirs.rec.item == null) { const before = B.c.spe.length; B.observeSpeed(ourEff, theyFirst, {...opts, scarf: true}); if (B.c.spe.length < before) theirs.rec.scarfLikely = true; }
    }
  }
  inferredSpread(species) {
    const B = this.belief[species] || this.belief[species.replace(/-Mega.*$/, '')]; if (!B || B.observations === 0) return null;
    const s = B.summary(); const evs = {}; let tot = 0; for (const k of ['hp', 'atk', 'def', 'spa', 'spd', 'spe']) { evs[k] = s[k].pts; tot += s[k].pts; }
    if (tot > 66) { const scale = 66 / tot; for (const k in evs) evs[k] = Math.floor(evs[k] * scale); }
    const plus = ['atk', 'spa', 'spe', 'def', 'spd'].find(k => s[k].nat > 0), minus = ['atk', 'spa', 'spe', 'def', 'spd'].find(k => s[k].nat < 0 && k !== plus);
    const NAT = {'atk|spa': 'Adamant', 'atk|spe': 'Brave', 'spa|atk': 'Modest', 'spa|spe': 'Quiet', 'spe|atk': 'Jolly', 'spe|spa': 'Timid', 'def|atk': 'Bold', 'def|spa': 'Impish', 'spd|atk': 'Calm', 'spd|spa': 'Careful', 'def|spe': 'Relaxed', 'spd|spe': 'Sassy', 'atk|def': 'Lonely', 'spa|def': 'Mild', 'spe|def': 'Hasty', 'spa|spd': 'Rash', 'atk|spd': 'Naughty', 'spe|spd': 'Naive'};
    const nature = plus ? (NAT[plus + '|' + (minus || (plus === 'spe' ? 'spa' : 'spe'))] || 'Serious') : 'Serious';
    return {evs, nature, observations: B.observations, summary: s};
  }

  // ---- opponent team: sampled sets, forced consistent with reveals; resampled only when a reveal contradicts
  oppRevealed() {
    const out = {};
    for (const r of Object.values(this.mons[this.oppSide])) {
      const base = r.species.replace(/-Mega.*$/, '');
      out[base] = {moves: [...r.moves], item: r.item || r.itemConsumed || null, ability: r.ability || null, mega: r.mega ? r.species : null};
    }
    return out;
  }
  ensureSampled() {
    const rev = this.oppRevealed();
    // dedupe by base species; a revealed Mega replaces its base
    const byBase = {};
    for (const sp of [...this.oppSix, ...Object.keys(rev)]) { const base = sp.replace(/-Mega.*$/, ''); byBase[base] = (rev[base] && rev[base].mega) || byBase[base] || sp; }
    const species = Object.keys(byBase);
    const ok = this.sampled && this.sampled.every(set => {
      const base = set.name.replace(/-Mega.*$/, ''); const r = rev[base]; if (!r) return true;
      if (r.moves.some(m => !set.moves.includes(m))) return false;
      if (r.item && set.item !== r.item) return false;
      if (r.ability && set.ability !== r.ability) return false;
      return true;
    });
    if (ok) return this.sampled;
    const names = species.map(sp => byBase[sp]);
    const revealedByName = Object.fromEntries(Object.entries(rev).map(([k, v]) => [v.mega || k, {moves: v.moves, item: v.item, ability: v.ability}]));
    for (let t = 0; t < 6; t++) {
      const team = sampleTeam(names, revealedByName, this.rng);
      if (team) { this.sampled = team; return team; }
    }
    if (process.env.VERBOSE) console.error('sampleTeam failed for', names.join(','), JSON.stringify(revealedByName));
    // last resort: generic sets from the learnset
    this.sampled = names.map(sp => {
      const spec = D.species.get(sp); const base = spec.baseSpecies !== spec.name ? D.species.get(spec.baseSpecies) : spec;
      const ids = new Set(); for (const s of [spec, base]) { const ls = D.species.getLearnsetData(s.id); if (ls && ls.learnset) for (const [m, src] of Object.entries(ls.learnset)) if (src.some(x => x.startsWith('9'))) ids.add(m); }
      const dmg = [...ids].map(id => D.moves.get(id)).filter(m => m.basePower >= 60 && m.accuracy === true || m.accuracy >= 90).sort((a, b) => (b.basePower * (spec.types.includes(b.type) ? 1.5 : 1)) - (a.basePower * (spec.types.includes(a.type) ? 1.5 : 1)));
      const moves = [...(revealedByName[sp] ? revealedByName[sp].moves : [])]; for (const m of dmg) { if (moves.length >= 4) break; if (!moves.includes(m.name)) moves.push(m.name); }
      const phys = dmg.filter(m => m.category === 'Physical').length >= dmg.filter(m => m.category === 'Special').length;
      return {name: sp, ability: (revealedByName[sp] && revealedByName[sp].ability) || spec.abilities['0'], item: spec.requiredItem || '', nature: phys ? 'Adamant' : 'Modest', evs: phys ? {atk: 32, hp: 32, spe: 2} : {spa: 32, hp: 32, spe: 2}, moves};
    });
    return this.sampled;
  }

  // ---- build the Battle for this decision
  
  build(request) {
    const opp = this.ensureSampled().map(set => { const inf = this.inferredSpread(set.name); return inf ? {...set, evs: inf.evs, nature: inf.nature} : set; });
    const b = new Battle({formatid: FORMAT, seed: [1, 2, 3, 4]});
    // local seats: we are ALWAYS p1 locally (sim/arena assume it); map server sides accordingly
    const local = (serverSide) => this.mySide === 'p1' ? serverSide : (serverSide === 'p1' ? 'p2' : 'p1');
    const my = 'p1', op = 'p2';
    b.setPlayer('p1', {name: 'TR', team: Teams.import(this.myTeam.map(S.setText).join('\n\n'))});
    b.setPlayer('p2', {name: 'META', team: Teams.import(opp.map(S.setText).join('\n\n'))});
    // team preview: our bring order from the request's side.pokemon; their bring = revealed + fill
    const myOrder = request.side.pokemon.map(p => this.myTeam.findIndex(t => p.details.startsWith(t.name.replace(/-Mega.*$/, '')) || p.details.startsWith(t.name)) + 1);
    const oppSeen = Object.values(this.mons[this.oppSide]).map(r => r.species.replace(/-Mega.*$/, ''));
    const oppOrder = [...oppSeen, ...opp.map(s => s.name.replace(/-Mega.*$/, '')).filter(n => !oppSeen.includes(n))].slice(0, 4).map(n => opp.findIndex(s => s.name.replace(/-Mega.*$/, '') === n) + 1);
    b.choose(my, 'team ' + myOrder.filter(x => x > 0).join('')); b.choose(op, 'team ' + oppOrder.filter(x => x > 0).join(''));
    b.sendUpdates();
    // overwrite with observed state
    for (const serverSide of ['p1', 'p2']) {
      const sideId = local(serverSide);
      const side = b.sides.find(s => s.id === sideId);
      const obs = this.mons[serverSide];
      const byBase = {}; for (const p of side.pokemon) byBase[p.species.baseSpecies] = p, byBase[p.species.name] = p;
      // clear actives, then place observed actives
      for (const p of side.pokemon) { p.isActive = false; }
      side.active = [null, null];
      for (const r of Object.values(obs)) {
        const p = byBase[r.species] || byBase[r.species.replace(/-Mega.*$/, '')]; if (!p) continue;
        const maxhp = p.maxhp;
        p.hp = r.fainted ? 0 : Math.max(1, Math.round(r.hp * maxhp));
        p.fainted = r.fainted;
        p.status = r.status || ''; p.statusState = p.status ? {id: p.status, time: p.status === 'slp' ? 2 : 0, startTime: 3} : {};
        p.boosts = {atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0, ...r.boosts};
        if (r.item === '') p.item = ''; else if (r.item && sideId === op) p.item = toId(r.item);
        if (r.ability && sideId === op) { try { p.setAbility(toId(r.ability)); } catch {} }
        for (const [mv, n] of Object.entries(r.ppUsed)) { const slot = p.moveSlots.find(s => s.move === mv); if (slot) slot.pp = Math.max(0, slot.pp - n); }
        p.lastMove = r.lastMove && D.moves.get(r.lastMove).exists ? b.dex.getActiveMove(D.moves.get(r.lastMove).id) : null;
        p.activeTurns = r.activeTurns; p.activeMoveActions = Object.values(r.ppUsed).reduce((a, c) => a + c, 0);
        if (r.isActive) { side.active[r.slot] = p; p.isActive = true; p.position = r.slot; }
        for (const [v, info] of Object.entries(r.volatiles)) {
          if (v === 'stall') { if (info) { p.addVolatile('stall'); } continue; }
          if (v === 'taunt' || v === 'encore' || v === 'substitute' || v === 'leechseed' || v === 'confusion' || v === 'yawn' || v === 'perishsong') {
            try { p.addVolatile(v); if (p.volatiles[v] && info.turn != null) { const dur = v === 'taunt' ? 3 : v === 'encore' ? 3 : v === 'yawn' ? 2 : v === 'perishsong' ? 3 : 999; if (p.volatiles[v].duration != null) p.volatiles[v].duration = Math.max(1, dur - (this.turn - info.turn)); } } catch {}
          }
        }
      }
      for (let k = 0; k < 2; k++) if (!side.active[k]) { const filler = side.pokemon.find(p => !p.isActive); if (filler) { side.active[k] = filler; filler.isActive = true; filler.position = k; if (!obsHas(obs, filler)) { filler.hp = 0; filler.fainted = true; } } }
      side.pokemonLeft = side.pokemon.filter(p => !p.fainted).length;
    }
    // field: wipe whatever the fresh battle's switch-in abilities generated, then apply what was observed
    try { b.field.clearWeather(); } catch {} try { b.field.clearTerrain(); } catch {}
    for (const pw of Object.keys(b.field.pseudoWeather)) { try { b.field.removePseudoWeather(pw); } catch {} }
    for (const side of b.sides) for (const sc of Object.keys(side.sideConditions)) { try { side.removeSideCondition(sc); } catch {} }
    b.sentLogPos = b.log.length;
    const anyActive = b.sides.flatMap(s => s.active).find(Boolean) || b.p1.pokemon[0];
    if (this.weather && WEATHER[this.weather]) { try { b.field.setWeather(WEATHER[this.weather], anyActive); b.field.weatherState.duration = Math.max(1, 5 - (this.turn - this.weatherTurn)); } catch {} }
    if (this.terrain) { try { b.field.setTerrain(toId(this.terrain), anyActive); b.field.terrainState.duration = Math.max(1, 5 - (this.turn - this.terrainTurn)); } catch {} }
    if (this.tr) { try { b.field.addPseudoWeather('trickroom', anyActive); b.field.pseudoWeather.trickroom.duration = Math.max(1, 5 - (this.turn - this.trTurn)); } catch {} }
    for (const serverSide of ['p1', 'p2']) { const side = b.sides.find(s => s.id === local(serverSide)); for (const [cond, t0] of Object.entries(this.side[serverSide])) { try { side.addSideCondition(toId(cond), anyActive); const sc = side.sideConditions[toId(cond)]; if (sc && sc.duration != null) sc.duration = Math.max(1, (cond === 'Tailwind' ? 4 : 5) - (this.turn - t0)); } catch {} } }
    b.turn = this.turn;
    b.queue.clear();
    b.requestState = 'move';
    for (const side of b.sides) side.clearChoice();
    b.makeRequest('move');
    b.sendUpdates();
    return b;
  }
}
module.exports = {LiveState};
