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

const USER = process.env.PS_USER, PASS = process.env.PS_PASS;
const TEAMFILE = process.argv[2] || 'team_trickroom_v7.json';
const MAX_GAMES = +(process.argv[3] || 50);
const FORMAT = 'gen9championsvgc2026regmb';
const SERVER = process.env.PS_SERVER || 'wss://sim3.psim.us/showdown/websocket';
const CONCURRENT = +(process.env.CONCURRENT || 3);   // battles open at once on this account (one pending search at a time is the server's rule)
if (!USER || !PASS) { console.error('set PS_USER and PS_PASS'); process.exit(1); }

const team = JSON.parse(fs.readFileSync(TEAMFILE, 'utf8'));
if (!S.validate(team, TEAMFILE)) process.exit(1);
const packed = Teams.pack(Teams.import(team.map(S.setText).join('\n\n')));
fs.mkdirSync(path.join(__dirname, 'replays', 'own'), {recursive: true});

// lead rule from the replay-model sims: Sinistcha vs Fake Out / Intimidate cores, Avalugg otherwise
const FO_CORE = new Set(['Incineroar', 'Sneasler', 'Kangaskhan', 'Grimmsnarl', 'Lopunny', 'Sableye', 'Scrafty', 'Persian', 'Meowscarada']);
function chooseLeads(oppSpecies) {
  const fo = oppSpecies.some(sp => FO_CORE.has(sp.replace(/-Mega.*$/, '')));
  const second = fo && team.some(m => m.name === 'Sinistcha') ? 'Sinistcha' : (team.some(m => m.name === 'Avalugg') ? 'Avalugg' : 'Sinistcha');
  return ['Oranguru', second, 'Camerupt', 'Torkoal'];
}

// our side may be p2: normalise every line so parseLine always sees us as p1
function swapSides(line) {
  return line.replace(/\bp([12])([ab]?)\b/g, (_, n, ab) => 'p' + (n === '1' ? '2' : '1') + ab);
}

let ws, games = 0, wins = 0, searching = false, activeGames = 0, draining = false;
// graceful stop: finish every open battle, never start another. Triggered by SIGTERM/SIGINT (docker stop)
// or by creating the file replays/own/STOP. Forfeiting a battle costs rating; this never does.
function drain(reason) {
  if (draining) return;
  draining = true;
  console.log(`draining (${reason}): finishing ${activeGames} open battle(s), no new searches`);
  if (searching) send('|/cancelsearch');
  if (activeGames === 0) { console.log('no open battles, exiting'); setTimeout(() => process.exit(0), 500); }
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
  setTimeout(search, 1500);
}
function search() {
  if (draining || searching || games + activeGames >= MAX_GAMES || activeGames >= CONCURRENT) return;
  searching = true;
  send(`|/utm ${packed}`);
  send(`|/search ${FORMAT}`);
  console.log(`searching ${FORMAT} (active ${activeGames}/${CONCURRENT}, finished ${games}/${MAX_GAMES})`);
}
function onUpdateSearch(json) {
  let j; try { j = JSON.parse(json); } catch { return; }
  searching = !!(j.searching && j.searching.length);
  activeGames = j.games ? Object.keys(j.games).length : 0;
  if (!searching) setTimeout(search, 500);   // a search just resolved into a battle (or ended): queue the next one
}

function room(id) { return id.replace(/^>/, ''); }   // server room id has no leading '>'
function handleBattleLine(id, line) {
  const b = battles[id] ??= {st: S.newState(), lines: [], mySide: null, oppName: null, oppRating: null, leads: null, oppSpecies: [], done: false, lastRq: 0};
  b.lines.push(line);
  const parts = line.split('|');
  const tag = parts[1];
  if (tag === 'init') { send(`${room(id)}|/timer on`); console.log(`  battle started: https://play.pokemonshowdown.com/${room(id)}`); }
  if (tag === 'player' && parts[3]) {
    if (parts[3] === USER) b.mySide = parts[2];
    else { b.oppName = parts[3]; b.oppRating = parts[5] ? +parts[5] : null; }
    return;
  }
  if (tag === 'poke' && b.mySide && parts[2] !== b.mySide) b.oppSpecies.push(parts[3].split(',')[0].replace(/-\*$/, ''));
  if (tag === 'request') {
    if (!parts[2]) return;
    const req = JSON.parse(parts.slice(2).join('|'));
    if (req.wait) return;
    b.lastRq = req.rqid;
    decide(id, b, req);
    return;
  }
  if (tag === 'error') { console.log('  server error:', parts.slice(2).join('|').slice(0, 120)); send(`${room(id)}|/choose default|${b.lastRq}`); return; }
  if (tag === 'win' || tag === 'tie') { finish(id, b, parts[2]); return; }
  // state tracking (normalised so we are p1)
  const norm = b.mySide === 'p2' ? swapSides(line) : line;
  S.parseLine(b.st, norm);
}

function decide(id, b, req) {
  let choice;
  try {
    const opts = {leads: b.leads || (b.leads = chooseLeads(b.oppSpecies)), pivot: 'sinistcha', imprisonFirst: false};
    choice = S.ourChoice(req, b.st, opts);
  } catch (e) { console.log('  choice error', e.message); choice = 'default'; }
  // live server reverts Megas to base forme: press the button on the first move
  if (req.active && !req.teamPreview && !req.forceSwitch) {
    choice = choice.split(', ').map((part, i) => (req.active[i] && req.active[i].canMegaEvo && part.startsWith('move ') && !/ mega$/.test(part)) ? part + ' mega' : part).join(', ');
  }
  if (req.teamPreview) console.log(`  vs ${b.oppName} (${b.oppRating ?? 'unrated'}) six: ${b.oppSpecies.join(', ')} -> lead ${b.leads[0]} + ${b.leads[1]}`);
  if (process.env.VERBOSE) console.log(`  [${room(id)}] T${b.st.turn} -> ${choice}`);
  send(`${room(id)}|/choose ${choice}|${req.rqid}`);
}

function finish(id, b, winner) {
  if (b.done) return; b.done = true;
  games++;
  const won = winner === USER;
  if (won) wins++;
  console.log(`game ${games}: ${won ? 'WIN' : 'LOSS'} vs ${b.oppName} (${b.oppRating ?? 'unrated'})  running ${wins}/${games}`);
  fs.writeFileSync(path.join(__dirname, 'replays', 'own', id.replace(/^>/, '') + '.json'),
    JSON.stringify({id: id.replace(/^>/, ''), players: b.mySide === 'p1' ? [USER, b.oppName] : [b.oppName, USER], rating: b.oppRating, leads: b.leads, oppSpecies: b.oppSpecies, won, log: b.lines.join('\n')}));
  fs.appendFileSync(path.join(__dirname, 'replays', 'own', 'results.csv'), `${new Date().toISOString()},${USER},${id.replace(/^>/, '')},${b.oppName},${b.oppRating ?? ''},${won ? 1 : 0},${b.leads.join('+')},${b.oppSpecies.join('+')}\n`);
  send(`${room(id)}|/leave`);
  delete battles[id];
  if ((draining || games >= MAX_GAMES) && activeGames <= 1) { console.log(draining ? 'drained, exiting' : 'done'); setTimeout(() => process.exit(0), 1000); }
}

function connect() {
  ws = new WebSocket(SERVER);
  ws.on('open', () => console.log('connected'));
  ws.on('message', (data) => {
    const text = data.toString();
    let room = '';
    for (const raw of text.split('\n')) {
      if (!raw) continue;
      if (raw.startsWith('>')) { room = raw; continue; }
      if (raw.startsWith('|challstr|')) { login(raw.slice('|challstr|'.length)).catch(e => { console.error(e.message); process.exit(1); }); continue; }
      if (raw.startsWith('|updatesearch|')) { onUpdateSearch(raw.slice('|updatesearch|'.length)); continue; }
      if (room.startsWith('>battle-')) handleBattleLine(room, raw);
      if (raw.startsWith('|popup|')) console.log('popup:', raw.slice(7, 200));
    }
  });
  ws.on('close', () => { console.log('disconnected, reconnecting in 10s'); setTimeout(connect, 10000); });
  ws.on('error', (e) => console.error('ws error', e.message));
}
connect();
