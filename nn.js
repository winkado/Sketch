// nn.js — inference for the numpy-trained MLPs (models/policy_nn.json, models/value_nn.json). Hot-reloads on change.
'use strict';
const fs = require('fs'); const path = require('path');
const cache = {};
function load(name) {
  const p = path.join(__dirname, 'models', name); if (!fs.existsSync(p)) return null;
  const mt = fs.statSync(p).mtimeMs; if (cache[name] && cache[name].mt === mt) return cache[name].w;
  const w = JSON.parse(fs.readFileSync(p, 'utf8')); cache[name] = {mt, w}; return w;
}
function score(w, x) { // single example: x (d) -> scalar
  const h = new Array(w.b1.length); for (let j = 0; j < h.length; j++) { let s = w.b1[j]; for (let i = 0; i < x.length; i++) s += (x[i] || 0) * w.W1[i][j]; h[j] = s > 0 ? s : 0; }
  let out = w.b2[0]; for (let j = 0; j < h.length; j++) out += h[j] * w.W2[j][0]; return out;
}
function policyProbs(candFeatures) { const w = load('policy_nn.json'); if (!w) return null; const s = candFeatures.map(x => score(w, x)); const m = Math.max(...s); const e = s.map(v => Math.exp(v - m)); const t = e.reduce((a, b) => a + b, 0); return e.map(v => v / t); }
function valueProb(features) { const w = load('value_nn.json'); if (!w) return null; return 1 / (1 + Math.exp(-score(w, features))); }
module.exports = {policyProbs, valueProb, hasPolicy: () => !!load('policy_nn.json'), hasValue: () => !!load('value_nn.json')};
