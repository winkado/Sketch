// dataset.js — export training data from every replay directory. All game logic stays in JS (single source of truth).
//   node dataset.js moves   -> data/moves.jsonl   one line per human decision: {x: [[cand features...]...], y: idx, fmt, elo}
//   node dataset.js value   -> data/value.jsonl   one line per turn state (Champions only): {x: [features], y: 0/1}
'use strict';
const fs = require('fs'); const path = require('path');
const {parseReplay} = require('./replays.js'); const P = require('./predict2.js');
const dirs = ['replays', 'replays/own', 'replays/all'].map(d => path.join(__dirname, d)).filter(d => fs.existsSync(d));
function* allFiles() { for (const d of dirs) for (const e of fs.readdirSync(d, {withFileTypes: true})) { if (e.isDirectory() && e.name !== 'own' && e.name !== 'selfplay') { for (const f of fs.readdirSync(path.join(d, e.name))) if (f.endsWith('.json')) yield path.join(d, e.name, f); } else if (e.isFile() && e.name.endsWith('.json')) yield path.join(d, e.name); } }
const RB = [[0, 1300, 0], [1300, 1600, 1], [1600, 1900, 2], [1900, 9999, 3]]; const elo = (r) => r == null ? 4 : (RB.find(([lo, hi]) => r >= lo && r < hi) || [0, 0, 4])[2];
if (process.argv[2] === 'moves') {
  const out = fs.createWriteStream(path.join(__dirname, 'data', 'moves.jsonl')); let n = 0, g = 0;
  for (const fp of allFiles()) {
    let rep; try { rep = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { continue; } if (!rep.log || rep.selfplay) continue; g++;
    const fmt = (rep.format || (rep.log.match(/\|tier\|([^\n]*)/) || [])[1] || fp.split(path.sep).slice(-2)[0] || '').toString();
    const st = parseReplay(rep.log, rep.players || []); const revealed = {}, used = {}, last = {};
    for (const a of st.actions) {
      const key = a.side + ':' + a.species; revealed[key] ??= new Set(); used[key] ??= {};
      if (a.kind === 'move' && a.turn >= 1) {
        const ctx = {species: a.species, foes: a.foes || [], foeHp: a.foeHp || [], hp: a.hp ?? 1, turn: a.turn, tr: !!a.tr, lastMove: last[key] || null, usedCount: used[key], elo: ['<1300', '1300-1599', '1600-1899', '1900+', 'tourney'][elo(rep.rating)], revealed: revealed[key]};
        try { const cands = P.candidates(a.species, [...revealed[key]]); if (cands.includes(a.move) && cands.length >= 2) { out.write(JSON.stringify({x: cands.map(c => P.feats(ctx, c).map(v => +(+v).toFixed(4))), y: cands.indexOf(a.move), fmt: /champions/i.test(fmt) ? 1 : 0, elo: elo(rep.rating)}) + '\n'); n++; } } catch {}
        revealed[key].add(a.move); used[key][a.move] = (used[key][a.move] || 0) + 1; last[key] = a.move;
      } else if (a.kind === 'switch') last[key] = 'switch';
    }
  }
  out.end(); console.error(`moves: ${n} decisions from ${g} games -> data/moves.jsonl`);
} else if (process.argv[2] === 'value') {
  const {LiveState} = require('./live.js'); const V = require('./value.js');
  const out = fs.createWriteStream(path.join(__dirname, 'data', 'value.jsonl')); let n = 0, g = 0;
  for (const fp of [...allFiles()].filter(f => /replays[\/\\](own|selfplay)/.test(f) || !/replays[\/\\]all/.test(f))) {
    let rep; try { rep = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { continue; } if (!rep.log || rep.won == null) continue;
    let team; try { team = JSON.parse(fs.readFileSync(path.join(__dirname, rep.team || 'team_trickroom_v7.json'), 'utf8')); } catch { continue; }
    const my = rep.selfplay ? 'p1' : (new RegExp(`\\|player\\|p2\\|${process.env.PS_USER || 'winkado'}\\|`, 'i').test(rep.log) ? 'p2' : 'p1');
    const live = new LiveState(team, my, process.env.PS_USER || 'winkado'); live.rng = () => 0.5; g++;
    for (const l of rep.log.split('\n')) { live.feed(l); if (l.startsWith('|turn|') && +l.split('|')[2] >= 2) { try { const b = live.build({side: {pokemon: team.map(t => ({details: t.name}))}}); out.write(JSON.stringify({x: V.features(b).map(v => +(+v).toFixed(4)), y: rep.won ? 1 : 0, w: rep.selfplay ? 0.5 : 1}) + '\n'); n++; } catch {} } }
  }
  out.end(); console.error(`value: ${n} states from ${g} games -> data/value.jsonl`);
}
