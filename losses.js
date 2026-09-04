// losses.js — attribute every one of OUR games to a cause. This is the team-iteration signal:
// the cause histogram says whether the next change is a set, a slot, or a piloting rule.
//
//   node losses.js [replays/own]
//
// Causes (first that applies):
//   NO_TR_T1        Trick Room never went up on turn 1 — sub-cause: setter slept / taunted / flinched / KO'd / other
//   SWEEPER_NEVER   a sweeper (Camerupt/Torkoal) never got an attack off
//   SWEEPER_ENTRY   a sweeper was KO'd the turn it entered or the turn after, before its second attack
//   PROTECT_STALL   opponent Protected on >=40% of their actions while our room was up
//   ROOM_EXPIRED    room ran out with 3+ opposing mons left
//   LATE_GAME       we had the room, traded, and lost the endgame
//   FORFEIT/TIMER   we never chose (server default) or the game ended by timer
'use strict';
const fs = require('fs');
const path = require('path');
const {parseReplay} = require('./replays.js');
const DIR = process.argv[2] || path.join(__dirname, 'replays', 'own');
const OUR = new Set(['Oranguru', 'Sinistcha', 'Camerupt', 'Camerupt-Mega', 'Torkoal', 'Avalugg', 'Raichu', 'Raichu-Mega-Y', 'Farigiraf']);
const SWEEPERS = new Set(['Camerupt', 'Camerupt-Mega', 'Torkoal', 'Ampharos', 'Ampharos-Mega']);
const PROTECT = /^(Protect|Detect|Spiky Shield|Baneful Bunker|King's Shield|Wide Guard)$/;

function analyse(rep) {
  const st = parseReplay(rep.log, rep.players || []);
  const toID = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); const ME = toID(process.env.PS_USER || 'winkado');
  const pl = rep.log.split('\n').filter(x => x.startsWith('|player|')).map(x => x.split('|')); const mineLine = pl.find(x => toID(x[3]) === ME); const me = mineLine ? mineLine[2] : null;
  const my = me || (st.leads.p2.some(s => OUR.has(s)) ? 'p2' : 'p1');
  const opp = my === 'p1' ? 'p2' : 'p1';
  const mine = st.actions.filter(a => a.side === my), theirs = st.actions.filter(a => a.side === opp);
  const won = rep.won;
  const out = {won, turns: st.turn, myLead: st.leads[my].join('+'), oppLead: st.leads[opp].join('+'), opp: rep.oppSpecies || [], rating: rep.rating, cause: null, sub: null};
  // events on turn 1
  const log = rep.log.split('\n');
  const t1 = []; let turn = 0;
  for (const l of log) { if (l.startsWith('|turn|')) turn = +l.split('|')[2]; if (turn === 1) t1.push(l); }
  const trT1 = t1.some(l => l.startsWith('|-fieldstart|move: Trick Room'));
  const setterNick = my + 'a: Oranguru';
  const setterHit = (re) => t1.some(l => re.test(l) && l.includes(my + 'a: Oranguru') || re.test(l) && l.includes(my + 'b: Oranguru'));
  if (!trT1) {
    out.cause = 'NO_TR_T1';
    out.sub = setterHit(/\|-status\|.*\|slp/) ? 'slept' : setterHit(/\|-start\|.*\|move: Taunt/) ? 'taunted' : setterHit(/\|cant\|.*\|flinch/) ? 'flinched' : setterHit(/\|faint\|/) ? 'setter KOd' : t1.some(l => /\|move\|p[12][ab]: Oranguru\|Trick Room/.test(l)) ? 'TR cancelled/failed' : 'setter did not click TR';
    if (won) out.cause = 'WON_WITHOUT_TR';
    return out;
  }
  const mySweeperAttacks = mine.filter(a => a.kind === 'move' && SWEEPERS.has(a.species) && !PROTECT.test(a.move)).length;
  const sweeperEntered = log.some(l => /\|switch\|p[12][ab]: (Camerupt|Torkoal)/.test(l) && l.includes(my));
  if (!won && sweeperEntered && mySweeperAttacks === 0) { out.cause = 'SWEEPER_NEVER'; return out; }
  // sweeper KO'd within a turn of entering
  let entryTurn = {}; turn = 0; let earlyKO = false;
  for (const l of log) { if (l.startsWith('|turn|')) turn = +l.split('|')[2]; const m = l.match(/^\|switch\|(p[12])[ab]: ([^|]+)\|/); if (m && m[1] === my && /Camerupt|Torkoal|Ampharos/.test(m[2])) entryTurn[m[2]] = turn; const f = l.match(/^\|faint\|(p[12])[ab]: ([^|]+)/); if (f && f[1] === my && entryTurn[f[2]] != null && turn - entryTurn[f[2]] <= 1) earlyKO = true; }
  if (!won && earlyKO) { out.cause = 'SWEEPER_ENTRY'; return out; }
  const theirUnderTR = theirs.filter(a => a.kind === 'move' && a.tr); const theirProtectTR = theirUnderTR.filter(a => PROTECT.test(a.move)).length;
  if (!won && theirUnderTR.length >= 4 && theirProtectTR / theirUnderTR.length >= 0.4) { out.cause = 'PROTECT_STALL'; out.sub = `${theirProtectTR}/${theirUnderTR.length}`; return out; }
  const oppLeft = (() => { const fainted = new Set(log.filter(l => l.startsWith('|faint|' + opp)).map(l => l.split('|')[2])); const brought = new Set(log.filter(l => l.startsWith('|switch|' + opp) || l.startsWith('|drag|' + opp)).map(l => l.split('|')[2])); return brought.size - fainted.size; })();
  if (!won && st.turn >= 6 && oppLeft >= 3) { out.cause = 'ROOM_EXPIRED'; return out; }
  out.cause = won ? 'WIN' : 'LATE_GAME';
  return out;
}

const files = fs.readdirSync(DIR).filter(f => f.endsWith('.json'));
const rows = [];
for (const f of files) { try { const rep = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); if (!rep.log || rep.won == null) continue; rows.push(analyse(rep)); } catch (e) {} }
const inc = (o, k) => { o[k] = (o[k] || 0) + 1; };
const causes = {}, subs = {}, byMyLead = {}, byOppLead = {};
for (const r of rows) { inc(causes, r.cause); if (r.sub) inc(subs, r.cause + ':' + r.sub); const L = byMyLead[r.myLead] ??= {n: 0, w: 0}; L.n++; L.w += r.won ? 1 : 0; if (!r.won) inc(byOppLead, r.oppLead); }
console.log(`${rows.length} games, ${rows.filter(r => r.won).length} wins (${(100 * rows.filter(r => r.won).length / rows.length).toFixed(0)}%)\n`);
console.log('cause of each game:'); for (const [k, v] of Object.entries(causes).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(16)} ${v}`);
console.log('\nsub-causes:'); for (const [k, v] of Object.entries(subs).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(36)} ${v}`);
console.log('\nour lead -> win rate:'); for (const [k, v] of Object.entries(byMyLead).sort((a, b) => b[1].n - a[1].n)) console.log(`  ${k.padEnd(24)} n=${v.n}  ${(100 * v.w / v.n).toFixed(0)}%`);
console.log('\nopposing leads we lost to most:'); for (const [k, v] of Object.entries(byOppLead).sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(`  ${k.padEnd(30)} ${v}`);
fs.writeFileSync(path.join(__dirname, 'models', 'losses.json'), JSON.stringify(rows, null, 1));
