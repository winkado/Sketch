// shadow.js — replay a human's game through the bot's decision function and report every disagreement.
//   node shadow.js <replay.html|json> [team.json]
'use strict';
const fs = require('fs'); const path = require('path');
const {LiveState} = require('./live.js'); const A = require('./arena.js'); const S = require('./sim.js');
const file = process.argv[2]; const teamFile = process.argv[3] || 'team_main.json';
const team = JSON.parse(fs.readFileSync(path.join(__dirname, teamFile), 'utf8'));
let raw = fs.readFileSync(file, 'utf8');
if (file.endsWith('.html')) { const m = raw.match(/class="battle-log-data">([\s\S]*?)<\/script>/); raw = m ? m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\\\//g, '/') : raw; }
const lines = raw.split('\n').filter(l => l.startsWith('|'));
const me = (lines.find(l => /^\|player\|p[12]\|winkado/i.test(l)) || '').split('|')[2] || 'p2';
const live = new LiveState(team, me, 'Winkado'); live.rng = () => 0.5;
const decisions = []; let turn = 0; let pendingActs = [];
const flush = () => { if (turn >= 1 && pendingActs.length) decisions.push({turn, actual: pendingActs.slice()}); pendingActs = []; };
for (const l of lines) {
  if (l.startsWith('|turn|')) { flush(); turn = +l.split('|')[2]; }
  const mv = l.match(new RegExp('^\\|move\\|' + me + '([ab]): ([^|]+)\\|([^|]+)'));
  if (mv) pendingActs.push(`${mv[2]}: ${mv[3]}`);
  const sw = l.match(new RegExp('^\\|switch\\|' + me + '([ab]): ([^|]+)\\|([^,|]+)'));
  if (sw && turn >= 1) pendingActs.push(`switch -> ${sw[3]}`);
}
flush();
// now replay states and ask the bot
const live2 = new LiveState(team, me, 'Winkado'); live2.rng = () => 0.5;
let t = 0, out = [];
for (const l of lines) {
  live2.feed(l);
  if (l.startsWith('|turn|')) {
    t = +l.split('|')[2];
    try {
      const fakeReq = {side: {pokemon: team.map(x => ({details: x.name}))}};
      const b = live2.build(fakeReq);
      const req = b.p1.activeRequest; if (!req || !req.active) continue;
      const st = A.stFromBattle(b, 'p1');
      const roomDown = !b.field.pseudoWeather.trickroom; const setterCan = st.active.p1.some(r => r && ['Oranguru', 'Sinistcha', 'Alakazam-Mega'].includes(r.species) && !r.taunt);
      const planTurn = t <= 2 || (roomDown && setterCan && t <= 3);
      let bot, via;
      if (planTurn) { bot = S.ourChoice(req, st, {pivot: 'sinistcha', leads: ['Oranguru', 'Sinistcha']}); via = 'plan'; }
      else { bot = A.searchChoice(b, req, 'antiTR', () => 0.5, {M: 8, K: 4}) || S.ourChoice(req, st, {pivot: 'sinistcha'}); via = A.lastExplain && A.lastExplain.mode ? A.lastExplain.mode : 'search'; }
      const actives = st.active.p1.map(r => r ? r.species : '-');
      const actual = (decisions.find(d => d.turn === t) || {actual: []}).actual;
      out.push({t, actives, bot, via, actual});
    } catch (e) { out.push({t, error: e.message.slice(0, 80)}); }
  }
}
console.log(path.basename(file));
for (const o of out) { if (o.error) { console.log(`  T${o.t}  (rebuild error: ${o.error})`); continue; } console.log(`  T${o.t} [${o.actives.join(' / ')}]\n      you : ${o.actual.join(' | ') || '(no action logged)'}\n      bot : ${o.bot}   (${o.via})`); }
