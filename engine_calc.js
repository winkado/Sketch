// engine_calc.js — run real battles in Showdown's `champions` mod and read
// the damage the ENGINE deals. No reimplementation. Crit turns are discarded.
//
// usage: node engine_calc.js jobs.json   (see runJobs for the job shape)
const {BattleStream, Teams, Dex} = require(require('./ps.js'));
const fs = require('fs');

const FORMAT = 'gen9championscustomgame';
function lcg(s) { let x = (s * 2654435761) >>> 0; const out = []; for (let i = 0; i < 4; i++) { x = (x * 1664525 + 1013904223) >>> 0; out.push(x % 65536); } return out; }
const FORMAT_D = 'gen9championsdoublescustomgame';
const DUMMY = {name:'Ditto', ability:'Imposter', item:'', nature:'Serious', evs:{hp:32}, moves:['Splash']};
DUMMY.ability='Limber'; // singles custom game, champions mod, no validation

function setToText(s) {
  const lines = [`${s.name}${s.item ? ' @ ' + s.item : ''}`, `Ability: ${s.ability}`, `Level: 50`];
  if (s.evs) lines.push('EVs: ' + Object.entries(s.evs).map(([k, v]) => `${v} ${k.toUpperCase()}`).join(' / '));
  if (s.ivs) lines.push('IVs: ' + Object.entries(s.ivs).map(([k, v]) => `${v} ${k.toUpperCase()}`).join(' / '));
  lines.push(`${s.nature || 'Serious'} Nature`);
  for (const m of s.moves) lines.push(`- ${m}`);
  return lines.join('\n');
}

async function oneBattle(atk, def, move, opts, seed) {
  const stream = new BattleStream();
  const dbl = !!opts.doubles;
  const teamA = Teams.pack(dbl ? [...Teams.import(setToText(atk)), ...Teams.import(setToText(DUMMY))] : Teams.import(setToText(atk)));
  const teamB = Teams.pack(dbl ? [...Teams.import(setToText(def)), ...Teams.import(setToText(DUMMY))] : Teams.import(setToText(def)));
  const chunks = [];
  const reader = (async () => { for await (const c of stream) chunks.push(c); })();
  stream.write(`>start ${JSON.stringify({formatid: dbl ? FORMAT_D : FORMAT, seed: lcg(seed)})}`);
  stream.write(`>player p1 ${JSON.stringify({name: 'A', team: teamA})}`);
  stream.write(`>player p2 ${JSON.stringify({name: 'B', team: teamB})}`);
  stream.write(dbl ? `>p1 team 12` : `>p1 team 1`);
  stream.write(dbl ? `>p2 team 12` : `>p2 team 1`);
  const mA = '', mB = '';
  if (dbl) {
    const mv = Dex.moves.get(move);
    const spread = ['allAdjacentFoes', 'allAdjacent', 'all'].includes(mv.target);
    stream.write(spread ? `>p1 move 1${mA}, move 1` : `>p1 move 1 1${mA}, move 1`);
    stream.write(`>p2 move 1${mB}, move 1`);
  } else {
    stream.write(`>p1 move 1${mA}`);
    stream.write(`>p2 move 1${mB}`);
  }
  stream.write(`>forcetie`);
  stream.writeEnd();
  await reader;
  const log = chunks.filter(c => c.startsWith('update')).join('\n');
  // find damage on p2a from the attacker's move; exclude crit
  const lines = log.split('\n');
  let dmg = null, crit = false, maxhp = null, minhp = null;
  for (const l of lines) {
    const sw = l.match(/^\|switch\|p2a: [^|]*\|[^|]*\|(\d+)\/(\d+)/);
    if (sw) maxhp = +sw[2];
    if (l.startsWith('|-crit|p2a')) crit = true;
    const m = l.match(/^\|-damage\|p2a: [^|]*\|(\d+)(?:\/(\d+))?/);
    if (m) { if (m[2]) maxhp = +m[2]; minhp = minhp === null ? +m[1] : Math.min(minhp, +m[1]); }
    if (l.startsWith('|faint|p2a')) minhp = 0;
  }
  if (minhp !== null) dmg = maxhp - minhp;
  if (dmg === null && /\|-immune\|p2a|\|-fail\|/.test(log)) dmg = 0;
  return {dmg, crit, maxhp, log};
}

async function calc(atk, def, move, opts = {}, seeds = 40) {
  atk = {...atk, moves: [move, 'Splash', ...(atk.moves || [])].slice(0, 4)};
  def = {...def, moves: opts.defPre ? [opts.defPre, 'Splash'] : [opts.defMove || 'Splash']};
  const rolls = [];
  let maxhp = null, lastlog = '';
  for (let s = 1; s <= seeds; s++) {
    const r = await oneBattle(atk, def, move, opts, s);
    lastlog = r.log;
    if (r.dmg === null) continue;
    maxhp = r.maxhp;
    if (!r.crit) rolls.push(r.dmg);
  }
  if (!rolls.length) return {error: 'no damage parsed', log: lastlog.slice(-1500)};
  const mn = Math.min(...rolls), mx = Math.max(...rolls);
  return {min: mn, max: mx, maxhp, min_pct: +(100 * mn / maxhp).toFixed(1), max_pct: +(100 * mx / maxhp).toFixed(1), n: rolls.length};
}

const {TeamValidator} = require(require('./ps.js'));
function validate(set) {
  const v = new TeamValidator('gen9championsvgc2026regmb');
  const team = Teams.import(setToText(set));
  const probs = v.validateTeam(team);
  return probs ? probs.filter(p => !/Min Team Size|team size|at least 6/i.test(p)) : [];
}
async function runJobs(path) {
  const jobs = JSON.parse(fs.readFileSync(path, 'utf8'));
  const out = [];
  for (const j of jobs) {
    for (const side of ['atk','def']) {
      const p = validate(j[side]);
      if (p.length) console.error(`  [validator] ${j[side].name}: ${p.join(' | ')}`);
    }
    const r = await calc(j.atk, j.def, j.move, j.opts || {}, j.seeds || 40);
    out.push({label: j.label, ...r});
    console.error(`${j.label.padEnd(48)} ${r.error ? 'ERR ' + r.error : `${r.min_pct}% - ${r.max_pct}%  (${r.min}-${r.max}/${r.maxhp}, n=${r.n})`}`);
    if (r.error) console.error(r.log);
  }
  fs.writeFileSync(path.replace('.json', '.out.json'), JSON.stringify(out, null, 1));
}

if (require.main === module) runJobs(process.argv[2]);
module.exports = {calc};
