// matrix.js — our team vs the real opponent population, by archetype and style. The "insanely high win rate vs
// all archetypes" check: where is it not?    REALTEAMS=1 node matrix.js <team.json> <gamesPerCell> [styles=neutral,aggressive,defensive,tournament]
'use strict';
const {execSync} = require('child_process'); const fs = require('fs');
const team = process.argv[2] || 'team_trickroom_v8.json', N = +(process.argv[3] || 100);
const styles = (process.argv[4] || 'neutral,aggressive,defensive,tournament').split(',');
const S = require('./sim.js'); const cores = Object.entries(S.CORES).filter(([n, c]) => c.archetype);
const rows = [];
for (const [name, c] of cores) for (const style of styles) {
  const out = execSync(`REALTEAMS=1 STYLE=${style} LEADS=Oranguru,Avalugg,Ampharos,Torkoal node sim.js ${name} ${N} replay ${team} 2>/dev/null`, {cwd: __dirname, env: {...process.env, REALTEAMS: '1'}}).toString();
  const win = +(out.match(/win ([\d.]+)%/) || [0, 0])[1];
  rows.push({core: name, arch: c.archetype, style, win, seen: c.seen, oppWinRate: c.winRate, six: c.team.map(m => m.name).join(', ')});
  console.error(`${name.padEnd(16)} ${style.padEnd(11)} ${win.toFixed(0).padStart(3)}%   ${rows[rows.length - 1].six}`);
}
const byArch = {}; for (const r of rows) { const a = byArch[r.arch] ??= []; a.push(r.win); }
console.log('\nmean win by archetype:'); for (const [a, v] of Object.entries(byArch)) console.log(`  ${a.padEnd(13)} ${(v.reduce((x, y) => x + y, 0) / v.length).toFixed(1)}%  (n=${v.length} cells)`);
console.log('\nworst 8 cells:'); for (const r of [...rows].sort((a, b) => a.win - b.win).slice(0, 8)) console.log(`  ${r.win.toFixed(0)}%  ${r.core} ${r.style}  ${r.six}`);
fs.writeFileSync('models/matrix.json', JSON.stringify(rows, null, 1));
