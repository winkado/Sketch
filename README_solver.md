# bring-4 solver — Champions Reg M-B

```bash
export CHAMP_DATA=/path/to/your/data/pack     # dir with pokemon.csv, moves.csv, learnsets.csv
python3 bring4.py team_you.json team_opp.json [Sun|Rain|Sand|Snow]
```

## Files

| File | What it is |
|---|---|
| `champ_calc.py` | Damage calc + **legality validator**, reads the CSVs only |
| `bring4.py` | 90×90 payoff matrix + Nash LP solve |
| `team_you.json`, `team_opp.json` | **Placeholder teams I invented to prove the pipeline runs.** Not recommendations. Replace them. |
| `items.csv` | Regenerated from the `champions` mod (your uploads dir had no items.csv on disk) |
| `usage.csv` | Pikalytics pull — read the header comments before trusting it |
| `teams.md` | Empty scaffold. Only you can fill it. |

## The legality validator is the part I'd actually use daily

`build_mon()` refuses to construct anything the data pack says is illegal:

```
BLOCKED: Incineroar does NOT learn 'U-turn' in Champions (learnsets.csv).
BLOCKED: Incineroar does NOT learn 'Knock Off' in Champions (learnsets.csv).
BLOCKED: NOT LEGAL in Reg M-B (absent from pokemon.csv): 'Amoonguss'
BLOCKED: Incineroar cannot have 'Drought'; legal: ['Blaze', 'Intimidate']
```

It also checks EV totals ≤ 508 and that a Mega forme holds its own stone.

## Strategy space

Choose 4 of 6 (15) × choose the lead pair (6) = **90 pure strategies** a side.
Payoff matrix is 90×90 = 8100 cells; each cell reuses a precomputed 6×6 damage
matrix, so the whole solve is about a second.

Zero-sum, so the Nash equilibrium is an LP: maximin for you, minimax for them,
solved separately and cross-checked by the game value.

## What the payoff number is, and is not

Each cell is a **heuristic advantage index** squashed through a logistic, not a
win probability. Underneath it:

- real damage, computed from your CSVs (Champions BP, Champions movepools)
- real speed tiers, including Choice Scarf and Tailwind
- flag counts for Fake Out / redirection / Intimidate / speed control / spread

The aggregation weights in `WEIGHTS` are **my priors**. I did not fit them to
anything. Read the output as "which brings are live and which are dead," not
as percentages to follow.

Two honest symptoms of that, visible in the sample run:

1. Equilibrium support was **2 strategies out of 90**. Real bring-4 games have
   wider support. That narrowness comes from the logistic being too steep
   (`logistic_k`) relative to how coarse the advantage index is. Lower `k` if
   you want a less confident-looking mix.
2. The index has no model of Protect, switching, item consumption, PP, or
   multi-turn sequencing. It is a turn-1-and-coverage snapshot.

## Modelled mechanics — everything else is silently ignored

Abilities and items are enumerated in `MODELLED_ABILITIES`, `ITEM_MODS` and
`BERRY_RESIST` at the top of `champ_calc.py`. If an ability isn't in that
table it has **no damage effect** in this calc. Crits are not modelled.
Variable-BP moves (Eruption, Body Press, Gyro Ball, Grass Knot, weight moves)
return zero damage with a note — they need manual handling, and `Eruption` in
the placeholder opponent team is one of them, so that sample number is wrong
on purpose to make the failure visible.

**Verify anything that decides a game in a real calculator or in the Showdown
sim.** This is my reimplementation of the Gen 9 formula, not Showdown's engine.

## Upgrade path, in order of value

1. `PAYOFF_FN` is a hook. Swap `payoff_matchup` for N Showdown sim rollouts
   using the `champions` mod you already have installed. That replaces the
   guessed weights with measured outcomes.
2. Once `teams.md` has entries, fit `WEIGHTS` to your own `teampreview`-category
   losses. This is the only calibration that reflects how *you* pilot.
3. Add Protect/switch as explicit strategy dimensions if the sim rollouts show
   turn-1 Protect changing the equilibrium.
