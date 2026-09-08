// infer.js — infer an opponent's stat points and nature from what the battle reveals, using Showdown's exact arithmetic.
//
// Champions (data/mods/champions/scripts.ts):  HP = base + pts + 75;  other = base + pts + 20;  nature: tr(stat*110/100) / tr(stat*90/100)
// Damage (sim/battle-actions.ts):   base = tr(tr(tr(tr(2L/5+2)*BP*A)/D)/50)+2 ;  spread modify(0.75) ; weather modify(1.5|0.5) ; crit tr(x*1.5) ;
//   random tr(tr(x*(100-r))/100), r in 0..15 ; STAB modify(1.5) ; type: x2 / /2 per step (tr) ; burn modify(0.5) ; item/ability modify(...) ; final tr, min 1
// modify(value, num, den): m = tr(num*4096/den); tr((tr(value*m) + 2048 - 1) / 4096)      (round half down)
// Spectator HP: floor(100*hp/maxhp) || 1  -> an interval on hp, not a value.
//
// Each opposing Pokémon keeps a candidate set per stat {points 0..32} x nature {-,0,+}; every observation deletes candidates
// that cannot have produced it. Point estimate = prior-weighted mean of survivors (prior: 32 pts 0.55, 2 pts 0.25, 0 pts 0.10, rest spread).
'use strict';
const tr = Math.trunc;
function modify(value, num, den = 1) { const m = tr(num * 4096 / den); return tr((tr(value * m) + 2048 - 1) / 4096); }
function statValue(base, pts, nat, isHp) { if (isHp) return base + pts + 75; let s = base + pts + 20; if (nat > 0) s = tr(tr(s * 110) / 100); else if (nat < 0) s = tr(tr(s * 90) / 100); return s; }
function boosted(stat, stage) { if (!stage) return stat; return stage > 0 ? tr(stat * (2 + stage) / 2) : tr(stat * 2 / (2 - stage)); }
// all 16 possible damage values for given attack/defense and modifiers
function damageRolls(A, D, bp, m) {
  for (const [num, den] of (m.bpMods || [])) bp = modify(bp, num, den);
  let base = tr(tr(tr(tr(2 * 50 / 5 + 2) * bp * A) / D) / 50) + 2;
  if (m.spread) base = modify(base, 3, 4);
  if (m.weather === 1.5) base = modify(base, 3, 2); else if (m.weather === 0.5) base = modify(base, 1, 2);
  if (m.crit) base = tr(base * 1.5);
  const out = [];
  for (let r = 0; r < 16; r++) {
    let d = tr(tr(base * (100 - r)) / 100);
    if (m.stab) d = modify(d, 3, 2);
    for (let k = 0; k < (m.typeMod || 0); k++) d *= 2; for (let k = 0; k < -(m.typeMod || 0); k++) d = tr(d / 2);
    if (m.burn) d = modify(d, 1, 2);
    for (const [num, den] of (m.mods || [])) d = modify(d, num, den);   // item/ability/Helping Hand/screens as [num,den]
    out.push(Math.max(1, tr(d)));
  }
  return out;
}
const PRIOR = (pts) => pts === 32 ? 0.55 : pts === 2 ? 0.25 : pts === 0 ? 0.10 : 0.10 / 30;
class StatBelief {
  constructor(base) {
    this.base = base; this.c = {}; this.observations = 0;
    // role-aware prior: the higher attacking stat and (if base speed >= 80) speed get the 32-point mass; the rest lean to 2/0; nature follows
    const off = base.atk >= base.spa ? 'atk' : 'spa', fast = base.spe >= 80;
    for (const k of ['hp', 'atk', 'def', 'spa', 'spd', 'spe']) {
      this.c[k] = [];
      for (let p = 0; p <= 32; p++) for (const n of (k === 'hp' ? [0] : [-1, 0, 1])) {
        let w;
        if (k === off) w = (p === 32 ? 0.8 : p === 2 ? 0.08 : p === 0 ? 0.04 : 0.08 / 30) * (n === 1 ? 0.55 : n === 0 ? 0.4 : 0.05);
        else if (k === 'spe') w = fast ? (p === 32 ? 0.6 : p === 2 ? 0.2 : p === 0 ? 0.1 : 0.1 / 30) * (n === 1 ? 0.5 : n === 0 ? 0.4 : 0.1) : (p === 32 ? 0.1 : p === 2 ? 0.45 : p === 0 ? 0.3 : 0.15 / 30) * (n === -1 ? 0.4 : n === 0 ? 0.5 : 0.1);
        else if (k === 'hp') w = fast ? (p === 32 ? 0.4 : p === 2 ? 0.45 : p === 0 ? 0.1 : 0.05 / 30) : (p === 32 ? 0.75 : p === 2 ? 0.15 : p === 0 ? 0.05 : 0.05 / 30);
        else if (k === (off === 'atk' ? 'spa' : 'atk')) w = (p === 0 ? 0.6 : p === 2 ? 0.3 : p === 32 ? 0.02 : 0.08 / 30) * (n === -1 ? 0.6 : n === 0 ? 0.38 : 0.02);
        else w = (p === 2 ? 0.45 : p === 0 ? 0.25 : p === 32 ? 0.2 : 0.1 / 30) * (n === 0 ? 0.7 : 0.15);
        this.c[k].push({p, n, w});
      }
    }
  }
  values(k) { return this.c[k].map(x => ({...x, v: statValue(this.base[k], x.p, x.n, k === 'hp')})); }
  keep(k, pred) { const before = this.c[k].length; const vals = this.values(k); const kept = vals.filter(pred); if (kept.length) { this.c[k] = kept.map(({p, n, w}) => ({p, n, w})); this.observations++; } return before - this.c[k].length; }
  estimate(k) { const vals = this.values(k); const W = vals.reduce((a, x) => a + x.w, 0); const mean = vals.reduce((a, x) => a + x.w * x.v, 0) / W; const pts = Math.round(vals.reduce((a, x) => a + x.w * x.p, 0) / W); const nat = Math.sign(Math.round(vals.reduce((a, x) => a + x.w * x.n, 0) / W));
    const sorted = [...vals].sort((a, b) => a.v - b.v); let acc = 0, lo = sorted[0].v, hi = sorted[sorted.length - 1].v; for (const x of sorted) { acc += x.w / W; if (acc >= 0.05 && lo === sorted[0].v) lo = x.v; if (acc >= 0.95) { hi = x.v; break; } }
    return {value: Math.round(mean), pts, nat, candidates: vals.length, min: Math.min(...vals.map(x => x.v)), max: Math.max(...vals.map(x => x.v)), ci90: [lo, hi]}; }
  // (1) their attack -> our exact HP loss. mods: everything except A (we know D exactly). hyps: list of item/ability multipliers to consider (kept as alternatives)
  // hyps: alternative {bpMods, mods} for unknown item/ability (e.g. none / type item / Life Orb)
  observeOutgoing(statKey, ourDef, bp, damage, m, hyps = [{}]) {
    // Bayesian: w *= sum_h P(h) * P(damage | candidate, h);  P(damage|.) = (#rolls equal to damage)/16
    const vals = this.values(statKey); const tot = hyps.reduce((a, h) => a + (h.p || 1), 0);
    let mass = 0; const nw = vals.map(x => { let like = 0; for (const h of hyps) { const rolls = damageRolls(boosted(x.v, m.atkStage || 0), ourDef, bp, {...m, bpMods: [...(m.bpMods || []), ...(h.bpMods || [])], mods: [...(m.mods || []), ...(h.mods || [])]}); const hits = rolls.filter(r => r === damage).length; like += ((h.p || 1) / tot) * hits / 16; } const w = x.w * like; mass += w; return w; });
    if (mass <= 0) return 0;   // inconsistent with every hypothesis (unmodelled effect): ignore rather than corrupt
    const before = this.c[statKey].length; this.c[statKey] = vals.map((x, i) => ({p: x.p, n: x.n, w: nw[i] / mass})).filter(x => x.w > 1e-6); this.observations++; return before - this.c[statKey].length;
  }
  // (2) our attack (exact A) -> their percent change. before/after are floor-percent readings; joint over (hp, def-stat).
  observeIncoming(defKey, ourAtk, bp, pctBefore, pctAfter, m, fainted = false) {
    const hpVals = this.values('hp'), dVals = this.values(defKey);
    const okHp = new Set(), okD = new Set();
    for (const h of hpVals) {
      const maxhp = h.v;
      const hpBeforeLo = pctBefore === 100 ? maxhp : Math.ceil(pctBefore * maxhp / 100), hpBeforeHi = pctBefore === 100 ? maxhp : Math.min(maxhp, Math.ceil((pctBefore + 1) * maxhp / 100) - 1);
      let dmgLo, dmgHi;
      if (fainted) { dmgLo = hpBeforeLo; dmgHi = 9999; } else { const afterLo = Math.ceil(pctAfter * maxhp / 100), afterHi = Math.min(maxhp, Math.ceil((pctAfter + 1) * maxhp / 100) - 1); dmgLo = Math.max(1, hpBeforeLo - afterHi); dmgHi = hpBeforeHi - afterLo; }
      for (const d of dVals) {
        const rolls = damageRolls(ourAtk, boosted(d.v, m.defStage || 0), bp, m);
        if (rolls.some(r => r >= dmgLo && r <= dmgHi)) { okHp.add(h.p + ':' + h.n); okD.add(d.p + ':' + d.n); }
      }
    }
    // Bayesian over the (hp, def) grid: likelihood = fraction of rolls landing in the damage interval
    const wHp = new Map(), wD = new Map(); let mass = 0;
    for (const h of hpVals) { const maxhp = h.v; const hpBeforeLo = pctBefore === 100 ? maxhp : Math.ceil(pctBefore * maxhp / 100), hpBeforeHi = pctBefore === 100 ? maxhp : Math.min(maxhp, Math.ceil((pctBefore + 1) * maxhp / 100) - 1);
      let dmgLo, dmgHi; if (fainted) { dmgLo = hpBeforeLo; dmgHi = 9999; } else { const afterLo = Math.ceil(pctAfter * maxhp / 100), afterHi = Math.min(maxhp, Math.ceil((pctAfter + 1) * maxhp / 100) - 1); dmgLo = Math.max(1, hpBeforeLo - afterHi); dmgHi = hpBeforeHi - afterLo; }
      for (const d of dVals) { const rolls = damageRolls(ourAtk, boosted(d.v, m.defStage || 0), bp, m); const like = rolls.filter(r => r >= dmgLo && r <= dmgHi).length / 16; const w = h.w * d.w * like; if (!w) continue; mass += w; wHp.set(h.p + ':' + h.n, (wHp.get(h.p + ':' + h.n) || 0) + w); wD.set(d.p + ':' + d.n, (wD.get(d.p + ':' + d.n) || 0) + w); } }
    if (mass <= 0) return 0;
    this.c.hp = hpVals.filter(x => wHp.has(x.p + ':' + x.n)).map(x => ({p: x.p, n: x.n, w: wHp.get(x.p + ':' + x.n) / mass}));
    this.c[defKey] = dVals.filter(x => wD.has(x.p + ':' + x.n)).map(x => ({p: x.p, n: x.n, w: wD.get(x.p + ':' + x.n) / mass}));
    this.observations++; return 1;
  }
  // (3) speed order: their effective speed vs a known speed. faster=true means they moved first (same priority, room state given)
  observeSpeed(knownSpeed, theyFaster, opts = {}) {
    const mult = (opts.scarf ? 1.5 : 1) * (opts.tailwind ? 2 : 1) * (opts.par ? 0.5 : 1);
    return this.keep('spe', x => { const s = tr(boosted(x.v, opts.stage || 0) * mult); return opts.trickRoom ? (theyFaster ? s < knownSpeed : s > knownSpeed) : (theyFaster ? s > knownSpeed : s < knownSpeed); });
  }
  summary() { const o = {}; for (const k of Object.keys(this.c)) o[k] = this.estimate(k); return o; }
}
module.exports = {StatBelief, damageRolls, statValue, boosted, modify};
