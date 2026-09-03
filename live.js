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
    this.rng = Math.random;
  }
  rec(side, nick, species) {
    const r = this.mons[side][nick] ??= {nick, species: species || nick, hp: 1, status: '', boosts: {}, fainted: false, item: undefined, ability: undefined, moves: new Set(), ppUsed: {}, volatiles: {}, lastMove: null, activeTurns: 0, mega: false};
    if (species) r.species = species;
    return r;
  }
  feed(line) {
    const parts = line.split('|'); const tag = parts[1];
    if (tag === 'turn') { this.turn = +parts[2]; for (const s of ['p1', 'p2']) for (const r of this.active[s]) if (r) r.activeTurns++; return; }
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
      const hb = hpFrom(parts[3]); if (hb) { r.hp = hb[1] ? hb[0] / hb[1] : 0; if (hb[1] > 100) r.hpAbs = hb; }
      const status = (parts[3] || '').split(' ')[1]; if (status && status !== 'fnt') r.status = status;
      const from = parts.find(p => /^\[from\] item: /.test(p)); if (from) { const who = parts.find(p => p.startsWith('[of] ')); const tgt = who ? pos(who.slice(5)) : m; if (tgt) this.rec(tgt[1], tgt[3]).item = from.replace('[from] item: ', ''); }
      return;
    }
    if (tag === 'faint') { const m = pos(parts[2]); if (m) { const r = this.rec(m[1], m[3]); r.hp = 0; r.fainted = true; r.status = ''; /* stays in its slot until replaced, as the engine does */ } return; }
    if (tag === 'move') {
      const m = pos(parts[2]); if (!m) return; const r = this.rec(m[1], m[3]);
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
    const opp = this.ensureSampled();
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
