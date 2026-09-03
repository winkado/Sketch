# Sketch

Teambuilding and decision engine for **Pokémon Champions VGC doubles** (Regulation M-B, M-C when it ships), built on Pokémon Showdown's `champions` mod as the only source of truth.

Named after Smeargle's move: it doesn't invent, it copies what it has watched. The engine learns how real players at each rating band actually lead, Protect, and switch, then searches against that instead of against a guess.

> **Repo description (one line):** Data-grounded Trick Room teambuilder, battle simulator and opponent-modelling engine for Pokémon Champions VGC — every number from the engine, every set validated, no memory.

---

## Principles

1. **Nothing from memory.** Every species, move, ability, item and stat is checked against the data pack or Showdown's engine. Four "known" facts were wrong when checked (Incineroar has no Knock Off, Staraptor-Mega is Contrary, Unseen Fist is nerfed, and Champions doesn't use EVs at all).
2. **Any RNG is treated as 100%.** A 90% move is not an answer. A 30% flinch is a flinch. Team and lines are built to be deterministic where the format allows it, and the residual holes are named, not hidden.
3. **Engine numbers, not calculator numbers.** `engine_calc.js` runs real battles in the `champions` mod and reads the damage the engine dealt. The Python calc exists for searching; the engine is for deciding.
4. **The sim is honest about what it can't tell you.** Win rates against the heuristic opponent are a ranking of variants, not a forecast. Setup metrics (did Trick Room go up on turn 1, why not) are the reliable output. Several "obviously correct" defensive rules lost win rate in simulation because the heuristic opponent doesn't do the thing they defend against — those are logged as opponent-model-dependent and gated behind flags until replay data settles them.
5. **No ladder bots.** This engine advises a human who plays on their own account. Nothing here presses buttons against other people.

---

## What's here

| File | Purpose |
|---|---|
| `champ_calc.py` | Champions stat-point calculator and legality validator, reads the CSVs only. Refuses illegal species/moves/abilities/items and >32/66 stat points. |
| `engine_calc.js` | Exact damage via real Showdown battles (singles or doubles), crits excluded, sets validated against the Reg M-B ruleset first. |
| `optimize.py` | Constrained stat-point search: survive these hits at max roll, maximise this objective. |
| `preview.py` | You see six species and nothing else. Lists every hidden capability each one *could* carry against the setup, plus every pair that can spread-KO the setter before Trick Room. |
| `bring4.py` | 90×90 bring/lead payoff matrix solved for the Nash mixed strategy (scipy LP). Payoff function is a labelled heuristic; the hook is there for engine rollouts. |
| `sim.js` | Heuristic-vs-heuristic engine battles at ~20 games/s/core against six meta cores (sun/Garchomp, sand, rain, Fake Out balance, Trick Room mirror, Mega Dragonite). Reports win rate and setup reliability. |
| `arena.js` | Expectimax search agent: clones the live battle, tries candidate actions against sampled opponent replies, rolls forward with the real engine. Multi-core. |
| `replays.js` | Fetches public Reg M-B replays from Showdown and mines them into `models/behaviour.json`: per-species move/Protect/switch/lead tables, **stratified by Elo bucket** with Dirichlet shrinkage, per-player profiles, and a divergence report showing where rating changes behaviour. |
| `team_trickroom_v7.json` | Current team. Passes Showdown's Reg M-B validator. |
| `teams.md` | Loss log. One entry per game, one deciding turn per entry. |
| `usage.csv`, `items.csv` | Pikalytics per-species record data (caveats in header); Champions item pool. |
| `README_run.md` | Exact commands to run everything, and what to build next. |

Data pack (`pokemon.csv`, `moves.csv`, `learnsets.csv`, `abilities.csv`) is generated from Showdown's mod with `extract.js` and is not committed here — regenerate from a fresh Showdown clone.

---

## The team (v7)

Trick Room core: **Oranguru** (Inner Focus, Mental Herb — the only setter immune to Rock Slide flinch and Fake Out flinch; the only Instruct learner), **Sinistcha** (Focus Sash — Ghost, so Fake Out can't stop Rage Powder), **Camerupt-Mega** (Sheer Force, 18/29/19 — survives a Life Orb Earthquake entry), **Torkoal** (Drought, Eruption / Earth Power / Burning Jealousy — the only 100%-accurate Fire spread).
Second lead: **Avalugg** (Sturdy, Wide Guard / Ice Spinner / Body Press — walls double-spread leads, 2HKOs Mega Dragonite through Multiscale, OHKOs Kingambit with Body Press). Sixth: **Raichu-Mega-Y** (No Guard: Zap Cannon and Focus Blast never miss).

Lead rule (from 2,400 games vs the replay-derived opponent model, <1300 bucket): **default lead is Oranguru + Avalugg** (63–95% across cores; Wide Guard beats the Charizard + Garchomp / Venusaur / Whimsicott leads that dominate the bracket). **Oranguru + Sinistcha** only when their six carries Fake Out / Intimidate cores (Incineroar, Sneasler, Kangaskhan, Grimmsnarl) — 81% vs 72% there. Camerupt + Torkoal in the back either way.

Opponent model: `sim.js ... replay` samples moves from `models/behaviour.json` (70/30 with the heuristic), leads from real pair frequencies, Elo bucket via `ELO=`. Real players Protect 28–35% of turns under Trick Room; Fake Out almost never targets the setter; Sneasler's Taunt does 43% of the time.

Turn-1 Trick Room went up in 100% of ~13,000 simulated games against cores that don't lead two spread attackers. Against the ones that do, the setter dies before it moves, and `preview.py` tells you which pairs those are.

---

## Status

- Setup design is validated in sim and in live games. Live losses so far were all one deciding turn: the pivot turn, where Oranguru must Protect.
- Known structural holes, all named in `preview.py` output: double-spread leads (~25 common pairs), Mega Dragonite (no line in the TR core), Scrappy Fake Out into the redirector, Mold Breaker Rock Slide, faster Imprison + Trick Room.
- **Not yet done:** replay-derived opponent model (the single most important missing piece), offline prediction scorer, engine-rollout payoffs for `bring4.py`, coach mode.

## Quickstart

See `README_run.md`. Short version: clone Showdown from git (not npm), fix the require path, `node replays.js fetch 60 && node replays.js mine`, then `node sim.js all 2000 antiTR team_trickroom_v6.json`.

## Format notes worth knowing before you touch anything

- Champions uses **Stat Points**, not EVs/IVs: max 32 per stat, 66 total, `HP = base + points + 75`, others `base + points + 20` before nature. There are no 0-IV speed drops; the floor is `(base+20)×0.9`.
- Effective PP is `(raw/5 + 1) × 4`, capped at 20. Protect has 8.
- Megas start the battle already Mega Evolved and don't revert on fainting.
- Wide Guard has no consecutive-use penalty.
- Several abilities differ from mainline. Check `abilities.csv`, not your memory.
