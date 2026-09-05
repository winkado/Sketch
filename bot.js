// bot.js — Pokémon Showdown ladder client (one account, one battle at a time, Reg M-B).
//
//   npm install ws
//   PS_USER=name PS_PASS=pass node bot.js [team.json] [games=50]
//
// Decision policy v1: the plan logic from sim.js (ourChoice) with data-driven lead selection.
// Every finished battle is written to replays/own/<battle-id>.json (same shape as public replays),
// so `node replays.js mine` picks our own games up too. Rating of each opponent is logged.
//
// Showdown allows scripted play; this client uses only the information a human sees (the server
// enforces that anyway). It never runs more than one battle, never uses more than one account.
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const WebSocket = require('ws');
const {Teams} = require(require('./ps.js'));
const S = require('./sim.js');
const {LiveState} = require('./live.js');
const A = require('./arena.js');
const USE_SEARCH = process.env.SEARCH === '1';   // expectimax over the rebuilt Battle; else the plan logic
const DEBOUNCE_MS = +(process.env.DEBOUNCE_MS || 400);
console.log(`policy: ${USE_SEARCH ? `SEARCH (expectimax, M=${process.env.M || 8} K=${process.env.K || 4} S=${process.env.S || 1} ROLL=${process.env.ROLL || 8})` : 'RULES (plan logic)'} | live state layer: on | concurrent battles: ${process.env.CONCURRENT || 3}`);

const USER = process.env.PS_USER, PASS = process.env.PS_PASS;
const toID = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const USERID = toID(USER);
const TEAMFILE = process.argv[2] || 'team_trickroom_v7.json';
const MAX_GAMES = +(process.argv[3] || 50);
const FORMATS = (process.env.PS_FORMATS || 'gen9championsvgc2026regmb').split(',').map(s => s.trim()).filter(Boolean);   // search all of these at once
const SERVER = process.env.PS_SERVER || 'wss://sim3.psim.us/showdown/websocket';
const CONCURRENT = +(process.env.CONCURRENT || 3);   // battles open at once on this account (one pending search at a time is the server's rule)
if (!USER || !PASS) { console.error('set PS_USER and PS_PASS'); process.exit(1); }

const ASSIGN = path.join(__dirname, 'manager', 'assignment.json');
const teamCache = {};
function loadTeam(file) { if (!teamCache[file]) { const t = JSON.parse(fs.readFileSync(path.join(__dirname, file), 'utf8')); if (!S.validate(t, file)) throw new Error('invalid team ' + file); teamCache[file] = {team: t, packed: Teams.pack(Teams.import(t.map(S.setText).join('\n\n')))}; } return teamCache[file]; }
let gameCounter = 0;
function nextTeamFile() {
  // manager present: alternate incumbent / challenger game by game; else the fixed TEAMFILE
  try { if (fs.existsSync(ASSIGN)) { const a = JSON.parse(fs.readFileSync(ASSIGN, 'utf8')); if (a.alternate && a.challenger) { const chal = (gameCounter++ % 2 === 1); currentPolicy = chal ? (a.challengerPolicy || a.incumbentPolicy || {}) : (a.incumbentPolicy || {}); return chal ? a.challenger : a.incumbent; } if (a.incumbent) { currentPolicy = a.incumbentPolicy || {}; return a.incumbent; } } } catch {}
  currentPolicy = {}; return TEAMFILE;
}
let currentPolicy = {};
let current = loadTeam(nextTeamFile()); let team = current.team; let packed = current.packed; let currentFile = TEAMFILE;
fs.mkdirSync(path.join(__dirname, 'replays', 'own'), {recursive: true});

// lead rule from the replay-model sims: Sinistcha vs Fake Out / Intimidate cores, Avalugg otherwise
const FO_CORE = new Set(['Incineroar', 'Sneasler', 'Kangaskhan', 'Grimmsnarl', 'Lopunny', 'Sableye', 'Scrafty', 'Persian', 'Meowscarada']);
const TR_SETTERS = new Set(['Farigiraf', 'Oranguru', 'Hatterene', 'Sinistcha', 'Slowking', 'Slowbro', 'Reuniclus', 'Cofagrigus', 'Armarouge', 'Musharna', 'Porygon2', 'Spiritomb', 'Bronzong', 'Dusclops']);
function chooseLeads(oppSpecies, team) {
  // anti-Trick-Room bring when the team carries it and their six has 2+ setter species
  const setters = oppSpecies.filter(sp => TR_SETTERS.has(sp.replace(/-Mega.*$/, ''))).length;
  const perish = oppSpecies.some(sp => /^Gengar/.test(sp));
  if ((setters >= 2 || perish) && team.some(m => m.name === 'Whimsicott') && team.some(m => m.name === 'Kingambit')) {
    const rest = team.map(m => m.name).filter(n => !/Whimsicott|Kingambit|Oranguru|Sinistcha|Clefable|Indeedee/.test(n));
    return ['Whimsicott', 'Kingambit', ...rest.slice(0, 2)];
  }
  if ((setters >= 2 || perish) && team.some(m => m.name.startsWith('Alakazam')) && team.some(m => m.name === 'Weavile')) {
    const redirect = team.find(m => /Indeedee|Clefable/.test(m.name)); const rest = team.map(m => m.name).filter(n => !/Alakazam|Weavile|Oranguru|Indeedee|Clefable|Sinistcha/.test(n));
    return ['Alakazam-Mega', redirect ? redirect.name : 'Weavile', ...(redirect ? ['Weavile'] : []), ...rest].slice(0, 4);   // Alakazam + redirect lead, Weavile third
  }
  if (setters >= 2 && team.some(m => m.name.startsWith('Gengar')) && team.some(m => m.name === 'Garchomp')) {
    const rest = team.map(m => m.name).filter(n => !n.startsWith('Gengar') && n !== 'Garchomp' && !/Sinistcha|Avalugg|Raichu/.test(n));
    return ['Gengar-Mega', 'Garchomp', ...rest.slice(0, 2)];
  }
  const fo = oppSpecies.some(sp => FO_CORE.has(sp.replace(/-Mega.*$/, '')));
  const second = fo && team.some(m => m.name === 'Sinistcha') ? 'Sinistcha' : (team.some(m => m.name === 'Avalugg') ? 'Avalugg' : 'Sinistcha');
  const SUPPORT = new Set(['Oranguru', 'Sinistcha', 'Avalugg', 'Farigiraf', 'Raichu-Mega-Y', 'Dragapult']);
  const sweepers = team.map(m => m.name.replace(/-Mega.*$/, '')).filter(n => !SUPPORT.has(n) && n !== second);
  return ['Oranguru', second, ...sweepers.slice(0, 2)];
}

// our side may be p2: normalise every line so parseLine always sees us as p1
function swapSides(line) {
  return line.replace(/\bp([12])([ab]?)\b/g, (_, n, ab) => 'p' + (n === '1' ? '2' : '1') + ab);
}

let ws, games = 0, wins = 0, searching = false, activeGames = 0, draining = false, lastMessageAt = Date.now(), searchStartedAt = 0;
setInterval(() => {
  const idle = (Date.now() - lastMessageAt) / 1000;
  if (idle > 180) { console.log(`watchdog: no server message for ${idle | 0}s, reconnecting`); lastMessageAt = Date.now(); try { ws.terminate(); } catch {} }
  if (searching && searchStartedAt && Date.now() - searchStartedAt > 5 * 60 * 1000 && activeGames < CONCURRENT) { console.log('watchdog: search stuck 5 min, re-searching'); searching = false; searchStartedAt = 0; search(); }
  if (!searching && !draining && activeGames < CONCURRENT && games + activeGames < MAX_GAMES && Date.now() - lastMessageAt < 60000) search();
}, 30000).unref();
setInterval(() => console.log(`heartbeat: ${activeGames} active, ${games} finished, ${wins} won, searching=${searching}`), 5 * 60 * 1000).unref();
// graceful stop: finish every open battle, never start another. Triggered by SIGTERM/SIGINT (docker stop)
// or by creating the file replays/own/STOP. Forfeiting a battle costs rating; this never does.
function drain(reason) {
  if (draining) return;
  draining = true;
  console.log(`draining (${reason}): finishing ${activeGames} open battle(s), no new searches`);
  if (searching) send('|/cancelsearch');
  if (activeGames === 0) { console.log('no open battles, exiting'); setTimeout(() => process.exit(0), 500); }
  // safety: the server's game count can include rooms we don't handle (e.g. a Bo3 parent). If none of OUR tracked
  // battles is still running, leave everything and exit after a grace period rather than hanging forever.
  setInterval(() => { const live = Object.values(battles).filter(b => !b.done).length; if (live === 0) { console.log('drain: no tracked battles running, leaving remaining rooms and exiting'); for (const id of Object.keys(battles)) send(`${room(id)}|/leave`); setTimeout(() => process.exit(0), 2000); } }, 30000).unref();
}
process.on('SIGTERM', () => drain('SIGTERM'));
process.on('SIGINT', () => drain('SIGINT'));
setInterval(() => { if (fs.existsSync(path.join(__dirname, 'replays', 'own', 'STOP'))) drain('STOP file'); }, 5000);
const battles = {}; // id -> {st, lines, mySide, oppName, oppRating, leads, oppSpecies}

function send(msg) { ws.send(msg); }
function post(data) {
  return new Promise((res, rej) => {
    const body = new URLSearchParams(data).toString();
    const req = https.request({host: 'play.pokemonshowdown.com', path: '/action.php', method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body)}}, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(d)); });
    req.on('error', rej); req.write(body); req.end();
  });
}

async function login(challstr) {
  const r = await post({act: 'login', name: USER, pass: PASS, challstr});
  const j = JSON.parse(r.slice(1));
  if (!j.assertion) throw new Error('login failed: ' + r.slice(0, 200));
  send(`|/trn ${USER},0,${j.assertion}`);
  console.log('logged in as', USER);
  for (const id of Object.keys(battles)) if (!battles[id].done) { send(`|/join ${room(id)}`); console.log('  rejoining', room(id)); }
  setTimeout(search, 1500);
}
function search() {
  if (draining || searching || games + activeGames >= MAX_GAMES || activeGames >= CONCURRENT) return;
  searching = true; searchStartedAt = Date.now();
  currentFile = nextTeamFile(); current = loadTeam(currentFile); team = current.team; packed = current.packed;
  send(`|/utm ${packed}`);
  for (const f of FORMATS) send(`|/search ${f}`);
  console.log(`searching ${FORMATS.join(' + ')} (active ${activeGames}/${CONCURRENT}, finished ${games}/${MAX_GAMES})`);
}
function onUpdateSearch(json) {
  let j; try { j = JSON.parse(json); } catch { return; }
  searching = !!(j.searching && j.searching.length); if (!searching) searchStartedAt = 0;
  activeGames = j.games ? Object.keys(j.games).length : 0;
  // leave any game room we are not tracking as a live battle (dead Bo3 lobbies, stale rooms after reconnect)
  if (j.games) for (const r of Object.keys(j.games)) {
    if (battles['>' + r] && !battles['>' + r].done) continue;
    if (r.startsWith('battle-') && !battles['>' + r]) { send(`|/join ${r}`); console.log('  joining battle the server says we are in:', r); }   // resume after a restart; the server replays its log
    else if (!r.startsWith('battle-') || battles['>' + r].done) { send(`${r}|/leave`); console.log('  left room', r); }
  }
  activeGames = Object.values(battles).filter(x => !x.done).length;
  if (!searching) setTimeout(search, 500);   // a search just resolved into a battle (or ended): queue the next one
}

function room(id) { return id.replace(/^>/, ''); }   // server room id has no leading '>'
function handleBattleLine(id, line) {
  if (line.startsWith('|init|') && battles[id] && !battles[id].done) { battles[id].st = S.newState(); battles[id].live = null; battles[id].lines = []; battles[id].oppSpecies = []; }
  const b = battles[id] ??= {st: S.newState(), live: null, lines: [], mySide: null, oppName: null, oppRating: null, leads: null, oppSpecies: [], done: false, lastRq: 0, pending: null, timer: null};
  b.lines.push(line);
  const parts = line.split('|');
  const tag = parts[1];
  if (tag === 'init') { b.teamFile = currentFile; b.team = team; b.policy = currentPolicy; b.format = ''; send(`${room(id)}|/timer on`); console.log(`  battle started: https://play.pokemonshowdown.com/${room(id)}`); }
  if (tag === 'player' && parts[3]) {
    if (toID(parts[3]) === USERID) { b.mySide = parts[2]; b.live = new LiveState(b.team || team, b.mySide, USER); }
    else if (toID(parts[3]) !== USERID) { b.oppName = parts[3]; b.oppRating = parts[5] ? +parts[5] : null; }
    return;
  }
  if (tag === 'tier') b.format = parts[2] || '';
  if (tag === 'poke' && b.mySide && parts[2] !== b.mySide) b.oppSpecies.push(parts[3].split(',')[0].replace(/-\*$/, ''));
  if (tag === 'request') {
    if (!parts[2]) return;
    const req = JSON.parse(parts.slice(2).join('|'));
    if (req.wait) return;
    b.lastRq = req.rqid; b.lastReq = req; b.errors = 0;
    if (req.teamPreview || req.forceSwitch) { decide(id, b, req); return; }
    // move requests: the turn's log lines may still be arriving; decide once the burst settles
    b.pending = req; clearTimeout(b.timer); b.timer = setTimeout(() => { const q = b.pending; b.pending = null; if (q) decide(id, b, q); }, DEBOUNCE_MS);
    return;
  }
  if (tag === 'error') {
    console.log('  server error:', parts.slice(2).join('|').slice(0, 120));
    b.errors = (b.errors || 0) + 1;
    if (b.lastReq && b.errors <= 2) { try { const c = S.ourChoice(b.lastReq, b.st, {leads: b.leads || ['Oranguru', 'Avalugg'], pivot: 'sinistcha'}); send(`${room(id)}|/choose ${validChoice(b.lastReq, c) ? c : 'default'}|${b.lastRq}`); } catch { send(`${room(id)}|/choose default|${b.lastRq}`); } }
    else send(`${room(id)}|/choose default|${b.lastRq}`);
    return;
  }
  if (tag === 'win' || tag === 'tie') { finish(id, b, parts[2]); return; }
  // state tracking: the live layer (real Battle rebuild) plus the legacy tracker as fallback
  if (b.live) b.live.feed(line);
  const norm = b.mySide === 'p2' ? swapSides(line) : line;
  S.parseLine(b.st, norm);
  if (b.pending) { clearTimeout(b.timer); b.timer = setTimeout(() => { const q = b.pending; b.pending = null; if (q) decide(id, b, q); }, DEBOUNCE_MS); }
}

function validChoice(req, choice) {
  if (!req.active || req.teamPreview || req.forceSwitch) return true;
  const parts = choice.split(', ');
  if (parts.length !== req.active.length) return false;
  return parts.every((p, i) => { const m = p.match(/^move (.+?)(?: (-?\d))?(?: mega)?$/); if (!m) return /^(switch \d|pass)$/.test(p); const act = req.active[i]; return act && act.moves && act.moves.some(x => x.move === m[1] && !x.disabled); });
}
function decide(id, b, req) {
  let choice;
  if (req.rqid != null && b.lastRq != null && req.rqid !== b.lastRq) { console.log(`  [${room(id)}] dropped stale request rqid ${req.rqid} (latest ${b.lastRq})`); return; }
  if (!b.mySide && !req.teamPreview) console.log(`  WARNING [${room(id)}] own side unknown - name mismatch? player lines: ${b.lines.filter(l => l.startsWith('|player|')).join(' ')}`);
  const opts = {leads: b.leads || (b.leads = chooseLeads(b.oppSpecies, b.team || team)), pivot: 'sinistcha', imprisonFirst: false};
  try {
    if (!req.teamPreview && !req.forceSwitch && b.live && b.live.turn >= 1) {
      const t0 = Date.now();
      const battle = b.live.build(req);                      // real engine state, us as p1
      const st = A.stFromBattle(battle, 'p1');
      st.oppElo = b.oppRating == null ? 'tourney' : b.oppRating < 1300 ? '<1300' : b.oppRating < 1600 ? '1300-1599' : b.oppRating < 1900 ? '1600-1899' : '1900+';
      for (const r of Object.values(b.live.mons[b.live.oppSide])) { const rec = Object.values(st.sides.p2).find(x => x.species === r.species || x.species === r.species.replace(/-Mega.*$/, '')); if (rec) { rec.revealed = r.moves; rec.usedCount = r.ppUsed; rec.lastMove = r.lastMove || rec.lastMove; } }
      let via = 'rules';
      // HYBRID: the plan owns the setup (turn 1, and any turn the room is down and the setter can set it); the search
      // owns everything else. Live data: the search declined turn-1 Trick Room in 18/60 games and win rate fell 44% -> 33%.
      const roomDown = !battle.field.pseudoWeather.trickroom;
      const setterCanTR = st.active.p1.some(r => r && ['Oranguru', 'Sinistcha'].includes(r.species) && !r.taunt);
      const PT = (b.policy && b.policy.PLAN_TURNS != null) ? +b.policy.PLAN_TURNS : +(process.env.PLAN_TURNS || 2);
      const planTurn = b.live.turn <= PT || (PT > 0 && roomDown && setterCanTR && b.live.turn <= 3);   // PLAN_TURNS=0 -> search decides everything
      if (USE_SEARCH && !planTurn) { const sc = A.searchChoice(battle, req, 'antiTR', Math.random, b.policy || {}); if (sc) { choice = sc; via = 'search'; } else choice = S.ourChoice(req, st, opts); }
      else { choice = S.ourChoice(req, st, opts); via = planTurn ? 'plan' : 'rules'; }
      if (process.env.VERBOSE) console.log(`  [${room(id)}] T${b.live.turn} ${via} ${Date.now() - t0}ms -> ${choice}`);
      if (process.env.EXPLAIN && via === 'search' && A.lastExplain) {
        const e = A.lastExplain;
        console.log(`    opp sample: ${e.oppSample.join(' | ')}`);
        console.log(`    opp replies considered: ${e.oppReplies.join('  ||  ')}`);
        for (const x of e.considered) console.log(`    ${x.v.toFixed(3)} (mean ${x.mean} worst ${x.worst})  ${x.c}${x.c === e.heuristicPick ? '   <- rules would pick this' : ''}`);
      }
    } else choice = S.ourChoice(req, b.st, opts);
  } catch (e) { console.log('  live/search error, falling back:', e.message); try { choice = S.ourChoice(req, b.st, opts); } catch (e2) { choice = 'default'; } }
  if (!validChoice(req, choice)) {
    console.log(`  [${room(id)}] choice '${choice}' does not fit the current request; regenerating from rules`);
    try { choice = S.ourChoice(req, b.live && b.live.turn >= 1 ? A.stFromBattle(b.live.build(req), 'p1') : b.st, opts); } catch { choice = 'default'; }
    if (!validChoice(req, choice)) choice = 'default';
  }
  // live server reverts Megas to base forme: press the button on the first move
  if (req.active && !req.teamPreview && !req.forceSwitch) {
    choice = choice.split(', ').map((part, i) => (req.active[i] && req.active[i].canMegaEvo && part.startsWith('move ') && !/ mega$/.test(part)) ? part + ' mega' : part).join(', ');
  }
  if (req.teamPreview) console.log(`  vs ${b.oppName} (${b.oppRating ?? 'unrated'}) six: ${b.oppSpecies.join(', ')} -> lead ${b.leads[0]} + ${b.leads[1]}`);
  send(`${room(id)}|/choose ${choice}|${req.rqid}`);
}

function finish(id, b, winner) {
  if (b.done) return; b.done = true;
  games++;
  const won = toID(winner) === USERID;
  if (won) wins++;
  console.log(`game ${games}: ${won ? 'WIN' : 'LOSS'} vs ${b.oppName} (${b.oppRating ?? 'unrated'})  running ${wins}/${games}`);
  fs.writeFileSync(path.join(__dirname, 'replays', 'own', id.replace(/^>/, '') + '.json'),
    JSON.stringify({id: id.replace(/^>/, ''), team: b.teamFile || currentFile, format: b.format, players: b.mySide === 'p1' ? [USER, b.oppName] : [b.oppName, USER], rating: b.oppRating, leads: b.leads, oppSpecies: b.oppSpecies, won, log: b.lines.join('\n')}));
  fs.appendFileSync(path.join(__dirname, 'replays', 'own', 'results.csv'), `${new Date().toISOString()},${USER},${id.replace(/^>/, '')},${b.oppName},${b.oppRating ?? ''},${won ? 1 : 0},${b.leads.join('+')},${b.oppSpecies.join('+')},${b.teamFile || currentFile},${(b.format || '').replace(/,/g, ' ')}\n`);
  send(`${room(id)}|/leave`);
  delete battles[id];
  if ((draining || games >= MAX_GAMES) && activeGames <= 1) { console.log(draining ? 'drained, exiting' : 'done'); setTimeout(() => process.exit(0), 1000); }
}

function connect() {
  ws = new WebSocket(SERVER);
  ws.on('open', () => { console.log('connected'); clearInterval(ws._ka); ws._ka = setInterval(() => { try { ws.ping(); } catch {} }, 60000); });
  ws.on('message', (data) => {
    lastMessageAt = Date.now();
    try {
    const text = data.toString();
    let room = '';
    for (const raw of text.split('\n')) {
      if (!raw) continue;
      if (raw.startsWith('>')) { room = raw; continue; }
      if (raw.startsWith('|challstr|')) { login(raw.slice('|challstr|'.length)).catch(e => { console.error(e.message); process.exit(1); }); continue; }
      if (raw.startsWith('|updatesearch|')) { onUpdateSearch(raw.slice('|updatesearch|'.length)); continue; }
      if (room.startsWith('>battle-')) handleBattleLine(room, raw);
      else if (room.startsWith('>') && !raw.startsWith('|c|') && !raw.startsWith('|j|') && !raw.startsWith('|l|')) { if (process.env.VERBOSE) console.log(`  [${room}] ${raw.slice(0, 200)}`); if (/\|request\|/.test(raw)) console.log('  NOTE: request in a non-battle room — Bo3 protocol; paste this log'); }
      if (raw.startsWith('|popup|')) console.log('popup:', raw.slice(7, 200));
    }
    } catch (e) { console.log('handler error (ignored):', e.message.slice(0, 160)); }
  });
  ws.on('close', () => { console.log('disconnected, reconnecting in 10s'); setTimeout(connect, 10000); });
  ws.on('error', (e) => console.error('ws error', e.message));
}
connect();
