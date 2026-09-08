// crawl.js — exhaust Showdown's public replay archive for every doubles/VGC format, politely, resumably.
//   node crawl.js [formats.json] [concurrency=4] [sleepMs=250]
// Paginates by page, then by `before=<uploadtime>` until each format runs dry. Resumes: skips replays already on disk,
// remembers the oldest timestamp reached per format in data/crawl_state.json. Output: replays/all/<format>/<id>.json
// Champions formats are ALSO copied into replays/ (the set/number models); everything feeds the behaviour models.
'use strict';
const fs = require('fs'); const path = require('path'); const https = require('https');
const FORMATS_FILE = process.argv[2] || path.join(__dirname, 'data', 'formats.json');
const CONC = +(process.argv[3] || 4), SLEEP = +(process.argv[4] || 250);
const OUT = path.join(__dirname, 'replays', 'all'); const STATE = path.join(__dirname, 'data', 'crawl_state.json');
const formats = JSON.parse(fs.readFileSync(FORMATS_FILE, 'utf8'));
const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : {};
const save = () => fs.writeFileSync(STATE, JSON.stringify(state, null, 1));
const get = (url) => new Promise((res, rej) => https.get(url, {headers: {'User-Agent': 'sketch-research/2.0 (replay crawl; contact via github winkado/Sketch)'}}, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res({status: r.statusCode, body: d})); }).on('error', rej));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function crawlFormat(fmt) {
  const dir = path.join(OUT, fmt); fs.mkdirSync(dir, {recursive: true});
  const st = state[fmt] ??= {oldest: null, done: false, saved: 0, seen: 0};
  if (st.done) { console.error(fmt, 'already exhausted'); return; }
  let before = st.oldest, empty = 0;
  for (let page = 1; ; page++) {
    const url = `https://replay.pokemonshowdown.com/search.json?format=${fmt}` + (before ? `&before=${before}` : `&page=${page}`);
    const r = await get(url);
    if (r.status === 429) { console.error(fmt, 'rate limited, backing off 60s'); await sleep(60000); page--; continue; }
    if (r.status !== 200) { console.error(fmt, 'status', r.status, 'stopping'); break; }
    let list; try { list = JSON.parse(r.body); } catch { break; }
    if (!Array.isArray(list) || !list.length) { empty++; if (empty >= 2) { st.done = true; break; } continue; }
    st.seen += list.length;
    const batch = list.filter(it => !fs.existsSync(path.join(dir, it.id + '.json')));
    for (let i = 0; i < batch.length; i += CONC) {
      await Promise.all(batch.slice(i, i + CONC).map(async it => {
        try { const rr = await get(`https://replay.pokemonshowdown.com/${it.id}.json`); if (rr.status === 200) { fs.writeFileSync(path.join(dir, it.id + '.json'), rr.body); st.saved++; if (/champions/.test(fmt)) fs.writeFileSync(path.join(__dirname, 'replays', it.id + '.json'), rr.body); } } catch {}
      }));
      await sleep(SLEEP);
    }
    const oldest = Math.min(...list.map(it => it.uploadtime || 0).filter(Boolean));
    if (oldest && (!before || oldest < before)) before = oldest; else if (!before && page >= 100) before = oldest;   // switch from page to time pagination
    st.oldest = before; save();
    console.error(`${fmt}: seen ${st.seen}, saved ${st.saved}, oldest ${before ? new Date(before * 1000).toISOString().slice(0, 10) : '-'}`);
    await sleep(SLEEP * 2);
  }
  save();
}
(async () => { for (const f of formats) await crawlFormat(f); console.error('crawl complete'); })();
