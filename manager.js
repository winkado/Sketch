// manager.js — the automatic improvement loop. Runs alongside bot.js on the same machine.
//
//   node manager.js            (long-running; state in manager/state.json)
//
// What it does, without anyone looking at it:
//   1. TEAM A/B. Keeps an incumbent and one challenger in manager/. bot.js alternates teams game by game
//      (reads manager/assignment.json). Every game result is scored with a Sequential Probability Ratio Test
//      (H1: challenger wins p1 = incumbent + DELTA vs H0: equal). Accept -> challenger becomes incumbent;
//      reject -> next challenger; undecided -> keep playing. Same account, interleaved games, so rating drift
//      and time-of-day affect both teams equally.
//   2. CHALLENGER GENERATION. When the queue is empty: run losses.js on our replays, pick the dominant cause,
//      and generate ONE mutation aimed at it (spread variant for the mon that dies most; item swap for setup
//      causes; Imprison-timing rule flag for stall causes). Hand-written challengers in manager/queue/*.json
//      go first. Every generated team is validated before it is queued.
//   3. MODEL REFRESH. Every REFRESH_GAMES games: node replays.js mine (own games included) so behaviour.json
//      and sets.json follow the ladder; bot.js hot-reloads them.
'use strict';
const fs = require('fs');
const path = require('path');
const {execSync} = require('child_process');
const S = require('./sim.js');

const DIR = path.join(__dirname, 'manager');
const STATE = path.join(DIR, 'state.json');
const QUEUE = path.join(DIR, 'queue');
const persist = (file) => { try { const out = path.join(__dirname, 'teams_out'); if (fs.existsSync(out)) fs.copyFileSync(path.join(__dirname, file), path.join(out, file)); } catch {} };
const RESULTS = path.join(__dirname, 'replays', 'own', 'results.csv');
fs.mkdirSync(QUEUE, {recursive: true});

// ---- SPRT parameters (Stockfish-style, on win/loss only)
const DELTA = +(process.env.SPRT_DELTA || 0.05);   // challenger must be this much better in win rate
const ALPHA = 0.05, BETA = 0.10;
const LLR_ACCEPT = Math.log((1 - BETA) / ALPHA), LLR_REJECT = Math.log(BETA / (1 - ALPHA));
const MIN_GAMES = +(process.env.SPRT_MIN || 60), MAX_GAMES = +(process.env.SPRT_MAX || 400);
const REFRESH_GAMES = +(process.env.REFRESH_GAMES || 50);

function load() {
  if (fs.existsSync(STATE)) return JSON.parse(fs.readFileSync(STATE, 'utf8'));
  const inc = process.env.INCUMBENT || 'team_trickroom_v8.json';
  return {incumbent: inc, challenger: null, challengerLabel: null, inc: {w: 0, n: 0}, chal: {w: 0, n: 0}, seenRows: 0, gamesSinceRefresh: 0, history: [], tried: []};
}
const save = (st) => fs.writeFileSync(STATE, JSON.stringify(st, null, 1));
function publish(st) {
  fs.writeFileSync(path.join(DIR, 'assignment.json'), JSON.stringify({incumbent: st.incumbent, challenger: st.challenger, challengerPolicy: st.challengerPolicy || null, incumbentPolicy: st.incumbentPolicy || null, alternate: !!st.challenger}, null, 1));
}

// ---- SPRT on paired sequence: LLR of challenger having win rate p0+DELTA vs p0 (p0 = incumbent's observed rate, floored)
function llr(st) {
  if (st.inc.n < 10 || st.chal.n < 10) return 0;
  const p0 = Math.min(0.9, Math.max(0.1, st.inc.w / st.inc.n));
  const p1 = Math.min(0.95, p0 + DELTA);
  const w = st.chal.w, l = st.chal.n - st.chal.w;
  return w * Math.log(p1 / p0) + l * Math.log((1 - p1) / (1 - p0));
}

// ---- consume new rows of results.csv (format: time,account,id,opp,rating,win,leads,oppsix,team)
function ingest(st) {
  if (!fs.existsSync(RESULTS)) return 0;
  const rows = fs.readFileSync(RESULTS, 'utf8').trim().split('\n');
  let added = 0;
  for (let i = st.seenRows; i < rows.length; i++) {
    const c = rows[i].split(',');
    const team = c[8]; const win = c[5] === '1';
    if (!team) continue;
    if (team === st.incumbent) { st.inc.n++; st.inc.w += win ? 1 : 0; }
    else if (team === st.challenger) { st.chal.n++; st.chal.w += win ? 1 : 0; }
    added++; st.gamesSinceRefresh++;
  }
  st.seenRows = rows.length;
  return added;
}

// ---- challenger generation
function validTeam(team) { try { return S.validate(team, 'challenger'); } catch { return false; } }
function lossHistogram() {
  try { execSync('node losses.js', {cwd: __dirname, stdio: 'ignore'}); return JSON.parse(fs.readFileSync(path.join(__dirname, 'models', 'losses.json'), 'utf8')); } catch { return []; }
}
function dominantCause(rows) {
  const c = {}; for (const r of rows) if (!r.won) c[r.cause] = (c[r.cause] || 0) + 1;
  return Object.entries(c).sort((a, b) => b[1] - a[1])[0] || [null, 0];
}
function whoDiesOnEntry() {
  // reuse losses.json rows? entry deaths are per-species in the replays: cheap recount
  const dir = path.join(__dirname, 'replays', 'own'); const who = {};
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
    try { const rep = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); if (!rep.log || rep.won) continue;
      const my = rep.players[1] && rep.players[1] !== rep.oppName && rep.leads ? (rep.log.includes('|player|p2|' + rep.players[1]) && rep.players[1] === process.env.PS_USER ? 'p2' : 'p1') : 'p1';
      let turn = 0; const entry = {};
      for (const l of rep.log.split('\n')) { if (l.startsWith('|turn|')) turn = +l.split('|')[2]; const sw = l.match(/^\|switch\|(p[12])[ab]: ([^|]+)\|([^,|]+)/); if (sw && sw[1] === my && !/Oranguru|Sinistcha|Avalugg|Farigiraf/.test(sw[3])) entry[sw[2]] = [turn, sw[3]]; const ft = l.match(/^\|faint\|(p[12])[ab]: ([^|]+)/); if (ft && ft[1] === my && entry[ft[2]] && turn - entry[ft[2]][0] <= 1) who[entry[ft[2]][1]] = (who[entry[ft[2]][1]] || 0) + 1; }
    } catch {}
  }
  return Object.entries(who).sort((a, b) => b[1] - a[1])[0];
}
const SPREADS = [ {hp: 32, def: 32, spa: 2}, {hp: 32, spd: 32, spa: 2}, {hp: 32, def: 16, spa: 18}, {hp: 32, spd: 16, spa: 18}, {hp: 18, def: 29, spa: 19}, {hp: 32, def: 24, spd: 10} ];
function generateChallenger(st) {
  // 1) hand-written queue first
  const queued = fs.readdirSync(QUEUE).filter(f => f.endsWith('.json')).sort();
  for (const f of queued) { const p = path.join(QUEUE, f); const team = JSON.parse(fs.readFileSync(p, 'utf8')); fs.unlinkSync(p); if (validTeam(team)) { const out = `team_chal_${Date.now()}.json`; fs.writeFileSync(path.join(__dirname, out), JSON.stringify(team, null, 1)); persist(out); return {file: out, label: 'queued:' + f}; } }
  // 2) generated from the dominant loss cause
  const inc = JSON.parse(fs.readFileSync(path.join(__dirname, st.incumbent), 'utf8'));
  const [cause, n] = dominantCause(lossHistogram());
  if (!cause || n < 8) return null;
  let team = JSON.parse(JSON.stringify(inc)), label = null;
  if (cause === 'SWEEPER_ENTRY') {
    const w = whoDiesOnEntry(); if (!w) return null;
    const mon = team.find(m => m.name.replace(/-Mega.*$/, '') === w[0].replace(/-Mega.*$/, '')); if (!mon) return null;
    const off = mon.evs.spa != null ? 'spa' : 'atk';
    for (const sp of SPREADS) { const evs = {}; for (const [k, v] of Object.entries(sp)) evs[k === 'spa' ? off : k] = v; const key = mon.name + JSON.stringify(evs); if (st.tried.includes(key)) continue; st.tried.push(key); mon.evs = evs; label = `spread:${mon.name}:${JSON.stringify(evs)}`; break; }
  } else if (cause === 'NO_TR_T1') {
    const ora = team.find(m => m.name === 'Oranguru'); const items = ['Lum Berry', 'Mental Herb', 'Sitrus Berry', 'Focus Sash', 'Colbur Berry'];
    for (const it of items) { const key = 'item:Oranguru:' + it; if (it === ora.item || st.tried.includes(key) || team.some(m => m.item === it)) continue; st.tried.push(key); ora.item = it; label = key; break; }
  } else if (cause === 'PROTECT_STALL' || cause === 'ROOM_EXPIRED') {
    const ora = team.find(m => m.name === 'Oranguru'); const key = 'moves:Oranguru:FoulPlay'; if (!st.tried.includes(key) && ora.moves.includes('Imprison')) { st.tried.push(key); ora.moves = ora.moves.map(m => m === 'Imprison' ? 'Foul Play' : m); label = key; }
  }
  if (!label) {
    // no team mutation left for this cause: try a search-policy variant (same team, different search parameters)
    const grid = [{ROBUST: 0.15}, {ROBUST: 0.55}, {K: 6}, {ROLL: 12}, {M: 12}, {S: 2}];
    for (const g of grid) { const key = 'policy:' + JSON.stringify(g); if (st.tried.includes(key)) continue; st.tried.push(key); const out = `team_chal_${Date.now()}.json`; fs.writeFileSync(path.join(__dirname, out), JSON.stringify(inc, null, 1)); persist(out); return {file: out, label: key, policy: g}; }
    return null;
  }
  if (!validTeam(team)) return null;
  const out = `team_chal_${Date.now()}.json`; fs.writeFileSync(path.join(__dirname, out), JSON.stringify(team, null, 1)); persist(out);
  return {file: out, label};
}

function step(st) {
  const added = ingest(st);
  if (st.gamesSinceRefresh >= REFRESH_GAMES) {
    try { execSync('node replays.js mine', {cwd: __dirname, stdio: 'ignore'}); console.log(new Date().toISOString(), 'opponent model refreshed'); } catch (e) { console.log('refresh failed', e.message); }
    try { const out = execSync('node value.js train', {cwd: __dirname, env: process.env}).toString().trim(); console.log(new Date().toISOString(), 'value model:', out.split('\n').pop()); } catch (e) { console.log('value training failed', e.message.slice(0, 120)); }
    st.gamesSinceRefresh = 0;
  }
  if (!st.challenger) {
    const c = generateChallenger(st);
    if (c) { st.challenger = c.file; st.challengerLabel = c.label; st.challengerPolicy = c.policy || null; st.chal = {w: 0, n: 0}; st.inc = {w: 0, n: 0}; console.log(new Date().toISOString(), 'new challenger', c.label); }
  } else {
    const L = llr(st); const total = st.inc.n + st.chal.n;
    const decided = total >= MIN_GAMES && (L >= LLR_ACCEPT || L <= LLR_REJECT || total >= MAX_GAMES);
    if (added) console.log(new Date().toISOString(), `inc ${st.inc.w}/${st.inc.n}  chal ${st.chal.w}/${st.chal.n}  LLR ${L.toFixed(2)}  [${LLR_REJECT.toFixed(2)}, ${LLR_ACCEPT.toFixed(2)}]  ${st.challengerLabel}`);
    if (decided) {
      const accept = L >= LLR_ACCEPT;
      st.history.push({challenger: st.challengerLabel, file: st.challenger, inc: st.inc, chal: st.chal, llr: +L.toFixed(2), accepted: accept, at: new Date().toISOString()});
      console.log(new Date().toISOString(), accept ? `ACCEPT ${st.challengerLabel} -> new incumbent` : `reject ${st.challengerLabel}`);
      if (accept) { const newName = `team_incumbent_${Date.now()}.json`; fs.copyFileSync(path.join(__dirname, st.challenger), path.join(__dirname, newName)); persist(newName); st.incumbent = newName; if (st.challengerPolicy) st.incumbentPolicy = {...(st.incumbentPolicy || {}), ...st.challengerPolicy}; }
      st.challengerPolicy = null;
      st.challenger = null; st.challengerLabel = null; st.inc = {w: 0, n: 0}; st.chal = {w: 0, n: 0};
    }
  }
  publish(st); save(st);
}

const st = load(); publish(st); save(st);
console.log('manager: incumbent', st.incumbent, 'challenger', st.challenger || '(none yet)');
step(st);
setInterval(() => { try { step(st); } catch (e) { console.log('manager error', e.message); } }, 30000);
