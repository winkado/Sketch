// resolves the pokemon-showdown checkout: PS_PATH env, else ./pokemon-showdown next to this repo, else the sandbox path
const fs = require('fs'), path = require('path');
const cands = [process.env.PS_PATH, path.join(__dirname, 'pokemon-showdown'), path.join(__dirname, '..', 'pokemon-showdown'), '/home/claude/pscheck/node_modules/pokemon-showdown'].filter(Boolean);
const found = cands.find(p => fs.existsSync(path.join(p, 'package.json')));
if (!found) { console.error('pokemon-showdown not found. Clone it next to this repo or set PS_PATH.'); process.exit(1); }
module.exports = found;
