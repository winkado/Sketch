# KNOWLEDGE.md — everything the engine must understand to optimise for winning
Status: [x] implemented  [~] partial  [ ] missing.  Work down the [ ] items; re-check after each Regulation change.

## 1. Rules & mechanics (simulator)
- [x] Full damage formula incl. spread/weather/terrain/STAB/crit/roll/burn/screens/items/abilities (Showdown engine)
- [x] Champions deviations: stat points, no IVs, PP formula, Megas don't revert, changed abilities/moves, restricted items
- [x] Turn order: priority, speed, Trick Room, ties
- [x] Targeting & redirection (Follow Me/Rage Powder pull `normal` incl. Instruct; `adjacentAlly` immune) — [~] in decisions
- [x] Instruct/Encore fail lists (charge moves, Protect) — [~] in decisions
- [x] Protect decay; Wide/Quick Guard no decay
- [x] Weather/terrain durations & set-order; switch-in ability order
- [x] Priority blockers (Armor Tail, Queenly Majesty, Psychic Terrain) vs Mold Breaker
- [x] Faint replacement & end-of-turn order
- [x] Mega timing & pre-Mega ability window

## 2. Complete state
- [x] Per mon: HP, status, volatiles, stages, items consumed, abilities revealed, PP, last move, turns out, slot
- [x] Field: weather/terrain/room/screens/Tailwind with turns left
- [x] Request-slot mapping; fainted-in-slot; bench & counts
- [ ] Perish counters, Wish/Future Sight timers
- [~] Choice/Encore lock on opponent

## 3. Hidden information -> beliefs
- [x] Bench posterior from seen species (archetypes.js) — [ ] wired into live.js
- [~] Item/ability posteriors (priors + loud/silent correction; hard resample on contradiction; no soft posterior)
- [x] Movesets: reveal rates + co-occurrence — [ ] conditional on item/ability
- [~] Spreads assumed by role — [ ] inferred from observed damage / speed order
- [~] Which four they brought — [ ] lead->bench model wired in
- [x] Reveal pruning (moves/items/abilities) — [ ] damage-based inference
- [ ] Bo3 carry-over

## 4. Opponent model (what they do)
- [x] Move distribution | state (predict2.js)
- [~] Switch model (rates; no matchup features)
- [ ] Target-selection model
- [~] Protect timing on double-target turns
- [~] Lead selection | their six & Elo — [ ] conditioned on our six
- [ ] Per-player profiles & in-game adaptation
- [x] Skill-bracket differences
- [ ] Reaction to visible threats on our six

## 5. Decision (search)
- [x] Simultaneous-move root = matrix game (Nash) blended with model — [ ] at inner nodes
- [~] Chance: sampled seeds
- [ ] Depth > 1 with transposition cache
- [x] Joint-action pruning (Instruct into Protect, cancel own room, redirectable Instruct)
- [x] Eval: material + tempo + learned linear — [ ] neural
- [~] Tempo/resource accounting (room turns vs kills; Protects; Sash/Herb; PP)
- [ ] Exact endgame solve (2v2 / 1v2)
- [ ] Multi-turn plans (chip for a finisher)
- [x] Read-confidence thresholds

## 6. Team preview
- [~] Their likely leads | six & Elo (data exists)
- [x] Our bring by rules — [~] solved payoff matrix (bring4.py, not live)
- [x] Double-spread KO check (preview.py)
- [x] Mode selection rules
- [~] Archetype recognition

## 7. Self-knowledge
- [x] Exact numbers for our sets (engine)
- [~] Which of our moves are redirectable/blockable/punishable, in decisions
- [~] Deterministic line vs each known counter, encoded
- [x] Mega timing; item consumption in state — [~] in decisions

## 8. RNG management
- [x] Worst-case term; accuracy as a branch
- [~] Crit awareness at kill thresholds; speed ties; secondary effects as branches

## 9. Meta knowledge
- [x] Usage by bracket; real team library; leads; win rates
- [~] Named cores & their standard lines; known anti-plans as rules
- [ ] Regulation change ingestion (new Megas e.g. Feraligatr-Mega uncalc'd)

## 10. Practical
- [~] Timer/decision budget
- [x] Protocol robustness; explainability (EXPLAIN, shadow.js)
- [ ] Bo3

## 11. Learning loops
- [x] Opponent model refit; eval refit (gated); SPRT A/B; self-play with exploration
- [ ] Imitation from expert replays (shadow.js measures the gap only)
- [x] Loss attribution (losses.js)

Priority order for the [ ] items: damage/speed-based set inference (3) -> target & switch & adaptation models (4) -> depth + endgame solve (5) -> imitation from expert replays (11).
