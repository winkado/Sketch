# Architecture — where Sketch stands against the Stockfish recipe

Sources: Stockfish blog "Introducing NNUE Evaluation" (2020), Stockfish Docs FAQ, chessprogramming.org (NNUE, Stockfish NNUE).

## Stockfish, reduced to its three parts
1. **Search** — alpha-beta / principal variation search, iterative deepening, transposition tables, move ordering, pruning. Tens of millions of nodes per second.
2. **Evaluation** — NNUE: a small CPU-evaluated neural network scoring a position, trained on millions of positions labelled by the engine's own search at moderate depth (supervised + RL). Hand-written evaluation removed in Stockfish 16.
3. **Testing** — Fishtest: every change accepted only after SPRT over tens of thousands of games.

## Why the recipe does not port directly to VGC
| Chess | VGC doubles (Champions) | Consequence |
|---|---|---|
| Alternating moves | Simultaneous moves | A node is a matrix game, not a max over my moves. The correct node solution is a mixed strategy (Nash). Alpha-beta as written does not apply. |
| Deterministic | Damage rolls, accuracy, crits, secondary effects | Every node is also a chance node (expectiminimax / sampling). |
| Perfect information | Hidden sets, items, abilities, bench | State is a belief; search runs over determinizations (sampled sets) or a belief state. |
| Move generation in nanoseconds | Showdown's engine: milliseconds per turn | ~10^6 slower. Depth comes from node count; node count comes from speed. This is the wall. |
| ~35 moves, 40+ plies | ~10–30 joint actions per side, ~8 turns | Branching wide, depth short. Depth 2–3 with pruning is meaningful; depth 20 is not needed. |

## What Sketch has today (mapped)
- **Search**: one-ply over our candidates x their sampled replies, heuristic rollouts to ROLL turns, learned leaf evaluation. Root now solved as a **matrix game** (regret matching -> Nash mix), blended with the opponent model (`NASH` weight). Plan line is the default under the room; nonsense joint actions pruned.
- **Evaluation**: logistic regression on state features (`value.js`), trained on own games, refit on refresh, gated by held-out accuracy vs the hand-written score. = a linear NNUE with ~20 inputs.
- **Opponent model**: contextual softmax over candidate moves (`predict2.js`), 44/85 top-1/top-3 on 114k human decisions; set sampler with silent-item priors; team posterior (`archetypes.js`).
- **Testing**: `manager.js` SPRT, incumbent vs challenger, teams or policy parameters. = Fishtest, single machine.

## Roadmap, in dependency order
1. **Matrix-game root** — done (this commit). Next: sample our action from the equilibrium mix when values are close (unexploitable), argmax when one line dominates.
2. **Iterative deepening + transposition cache** on the rebuilt battle (state hash on species/HP/status/boosts/field). Depth 2 where time allows. Bounded by engine speed.
3. **Fast rollout simulator** — reduced mechanics (damage, KO, speed order, status, weather/terrain, room) for rollouts only; Showdown remains ground truth at the root and the verifier for every reduced-model number. Target: 100x more nodes. This is the compromise short of a Rust rewrite (poke-engine did the rewrite for singles; months of work, every mechanic re-verified).
4. **NNUE-style evaluation** — small MLP over richer state features, trained on millions of self-play positions labelled by the search (step 3 supplies the volume). Nightly retrain on the mini; promoted only if it beats the incumbent on held-out real states and then on the ladder.
5. **Policy prior for our own moves** — needed for MCTS-style selective deepening; the opponent prior exists already.

## What "let it train" honestly means on one M4
- Heuristic self-play: ~150–200 games/s across cores (~10^7 positions/day). Search-labelled positions: 10^4–10^5/day at current engine speed; ~10^6–10^7/day after step 3.
- Stockfish's networks see billions of positions. We will be orders of magnitude short for years; the loop still improves monotonically because every step is gated by tests.
- The sim-vs-human gap (measured: ~80% in sim, ~45% live) caps what self-play can teach. The ladder remains the objective function; the manager remains the gate.

## Pokémon-specific prior art (verified vs from memory)
- Verified: `foul-play` + `poke-engine` (Rust engine, MCTS/expectiminimax, singles only), `poke-env` (Python client/framework), Showdown's own engine (used here as ground truth).
- From memory, unverified — do not build on without checking: Metagrok (RL, 2018), PokéLLMon (LLM agent), academic work on simultaneous-move MCTS (Bošanský et al.) and CFR for imperfect information. No public engine exists for Champions doubles.
