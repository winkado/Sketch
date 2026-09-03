# Running the pipeline on your machine

```bash
git clone https://github.com/smogon/pokemon-showdown && cd pokemon-showdown && npm install && npm run build && cd ..
# put this folder next to it, then in every .js file change
#   /home/claude/pscheck/node_modules/pokemon-showdown   ->   ../pokemon-showdown
export CHAMP_DATA=/path/to/data-pack        # pokemon.csv / moves.csv / learnsets.csv
```
Use the git clone, not npm: npm's `pokemon-showdown` is months stale and won't have the M-C mod when it lands.

## 1. Real human data (do this first, it's the whole point)
```bash
node replays.js fetch 40      # ~40 pages x 2 formats of public Reg M-B replays, ~1 req/0.4s
node replays.js mine          # -> models/behaviour.json
```
`behaviour.json` gives, from what real players actually clicked: lead rates, moves by turn bucket,
Protect rate under/without Trick Room, Fake Out / Taunt targeting of setter-like mons, switch rates,
and per-player profiles for anyone with 3+ replays. Re-run `mine` whenever you add replays.

## 2. Policy-vs-policy at scale (all cores)
```bash
node sim.js all 2000 antiTR team_trickroom_v7.json          # heuristic vs heuristic, ~20 games/s/core
PIVOT=sinistcha node sim.js all 2000 greedy team_trickroom_v7.json
node arena.js all 300 search antiTR team_trickroom_v7.json  # search agent, uses all cores - 1
M=12 K=6 S=2 ROLL=10 node arena.js sunchomp 100 search antiTR team_trickroom_v7.json   # stronger, slower
```

## 3. What to build next, in order
1. **Opponent model from replays** — replace `oppChoice` sampling in `arena.js` with draws from
   `behaviour.json` (species -> move distribution by turn bucket, Protect rate under TR, Fake Out
   targeting). Mix: 70% replay model / 30% heuristic so the search can't overfit either.
2. **Offline prediction test** — for every real replay turn, predict the human's move from the state
   and score top-1 / top-3 accuracy. This is the "prediction engine" metric; it needs no ladder.
3. **Bring-4 at preview via search** — run `arena.js` for each of our 90 bring/lead options against
   each of their likely brings; feed the win matrix into `bring4.py` for the Nash mix.
4. **Coach mode** — a script that takes the current state (you type or paste it) and prints the
   search agent's recommendation with its value. You click. It works on Showdown and in the game.

## Findings so far (13k+ engine games, heuristic opponents)
- Turn-1 Trick Room: 100% across all four cores incl. Fake Out leads. Setup design holds.
- v5 (Oranguru / Sinistcha / Torkoal / Camerupt-Mega + fast pair) 83-95% vs heuristic AI;
  v4 with Farigiraf 4-36%. Pivot the sweeper in on T2 (Sinistcha out, Oranguru Protects).
- The search agent beats the heuristic AI by NOT setting TR on T1 (Protect + Strength Sap),
  because the AI always double-targets the setter. That is model exploitation, not strategy -
  the replay-derived opponent model is the fix, not more search.
- Open hole for v5: Basculegion Aqua Jet OHKOs Camerupt-Mega through Trick Room (engine-verified).
  Real players will find it; the heuristic AI mostly didn't.

## 5. Showdown ladder client (v1)
```bash
npm install ws
PS_USER=yourname PS_PASS=yourpass node bot.js team_trickroom_v7.json 20   # 20 games, then stops
```
One account, one battle at a time. Decisions = the plan logic from `sim.js` with the data-driven lead rule
(Sinistcha vs Fake Out cores, Avalugg otherwise). Every game is saved to `replays/own/` and appended to
`replays/own/results.csv` (time, id, opponent, rating, win, our leads, their six). `node replays.js mine`
picks up `replays/own` automatically if you copy them into `replays/`.
Start with a small game count and watch the console: v1 has not been run against the live server.
Search-agent decisions (arena.js) plug in once opponent-state injection into a local Battle exists — next.

**Stopping the bot without losing rating:** `docker compose stop` (SIGTERM) or `touch replays/own/STOP`. Either way the bot
cancels any pending search, plays every open battle to the end, then exits. `stop_grace_period` is 30 minutes so Docker
waits for it. `docker compose kill` is the only thing that forfeits.
