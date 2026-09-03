# teams.md

Your teams, and a log of losses with the turn that decided each.

**This file is empty on purpose.** You asked me to start it with the losses.
I don't have any of your games — no replays, no results, no team lists have
been shared in this project. Anything I put here would be invented, and an
invented loss log is worse than no loss log: it would silently corrupt every
downstream calibration that reads it.

Fill it in yourself, or paste replays into chat and I'll write the entries.

---

## Teams

Copy the format below per team. `bring4.py` reads the JSON version
(`team_*.json`) — keep the two in sync or generate one from the other.

### Team: <name>
- **Built**: YYYY-MM-DD · **Regulation**: M-B
- **Mega**: <species> (only one per battle)
- **Speed control**: <Tailwind / Trick Room / Icy Wind / paralysis / none>
- **Intimidate count**: <n>
- **Redirection**: <Follow Me / Rage Powder / none>
- **Fake Out**: <n>
- **Known holes**: <what beats this and you know it>

| # | Pokémon | Ability | Item | Nature | EVs | Moves |
|---|---------|---------|------|--------|-----|-------|
| 1 |  |  |  |  |  |  |
| 2 |  |  |  |  |  |  |
| 3 |  |  |  |  |  |  |
| 4 |  |  |  |  |  |  |
| 5 |  |  |  |  |  |  |
| 6 |  |  |  |  |  |  |

---

## Losses

### W-001 — 2026-09-03 — vs unknown (first live game, v6)
- **My bring**: Oranguru / Sinistcha / Torkoal / Camerupt-M · **Leads**: Oranguru + Sinistcha
- **What happened**: they double-targeted Sinistcha through Rage Powder, TR went up T1, sweeper entered free on the faint. Game over.
- **Category**: design worked as simulated (matches the 100% T1-TR sim result)

### L-001 — 2026-09-03 — vs sand + Staraptor
- **Replay**: (paste)
- **My bring**: Oranguru / Sinistcha / Torkoal / Camerupt-M · **Leads**: Oranguru + Sinistcha
- **Their bring / leads**: (fill) — sand core with Staraptor (Intimidate) or Staraptor-Mega (Contrary)
- **Deciding turn**: T2 — Sinistcha survived T1 so the pivot rule applied (Sinistcha out → sweeper in). On the pivot turn Oranguru is the only target on the field that isn't a fresh switch-in; it MUST Protect. I clicked Imprison. Double target → Oranguru KO'd → no Instruct, no second TR.
- **What was correct**: Oranguru Protect on every pivot turn, no exceptions. Imprison has no role on T2 (sims: opp Trick Room 0.0% across 13k games).
- **Why I chose wrong**: Imprison was on the set, so it was a button that could be pressed at the wrong time.
- **Category**: `sequencing`
- **Fixed by**: remove Imprison from Oranguru (see v6.1 note) so the pivot turn has exactly one correct click; log opp team + replay to confirm the T2 double-target was on Oranguru and not a spread.

One entry per loss. The **deciding turn** field is the point of the file —
if you can't name a single turn, write down why not, because "I was just
outclassed" is usually three bad turns you haven't separated yet.

### L-001 — YYYY-MM-DD — vs <opponent archetype>
- **Replay**: <url>
- **My team**: <team name>
- **My bring**: <4> · **Leads**: <2>
- **Their bring**: <4> · **Leads**: <2>
- **Deciding turn**: T<n> — <the specific decision, not "I lost momentum">
- **What I chose**: 
- **What was correct**: 
- **Why I chose wrong**: <read? sequencing? didn't know a calc? didn't know a set?>
- **Category**: `teampreview` | `calc` | `speed` | `sequencing` | `read` | `variance`
- **Fixed by**: <team change / habit / nothing, it was variance>

---


### L-002 / L-003 — 2026-09-03 — vs Tsareena (Grass-type Taunt) x2
- **Deciding turn**: T2 (pivot turn). Taunt landed on Oranguru after Mental Herb was spent T1 -> no Instruct for the rest of the room.
- **Why it could land**: Grass-types ignore Rage Powder. Under TR Oranguru (72) always moves BEFORE Tsareena (min 82), so a Taunt can only ever cost Oranguru FUTURE turns - the one turn it can't be blocked by moving first is T1, which the Herb covers. A Taunt that sticks on T2 means Oranguru did not Protect on the pivot turn.
- **What was correct**: T1 TR (Herb eats Taunt) -> T2 Protect (Taunt fails) -> T3 sweeper Eruption, Oranguru Instruct, second Eruption removes Tsareena (engine: 85-100% into max-SpD Tsareena, 100% into max-Def) BEFORE her T3 Taunt resolves.
- **Category**: `sequencing`  (same root cause as L-001)
- **Sim check**: Tsareena TR core, 800 games: Oranguru taunted in 0.5-2.5% of games, win 71-74%.

## Rolling counts

Update as entries accumulate. This is what tells you whether your problem is
the team or the piloting.

| Category | Count |
|---|---|
| teampreview (wrong bring) | 0 |
| calc (didn't know the number) | 0 |
| speed (lost a tier I should have known) | 0 |
| sequencing (right moves, wrong order) | 3 |
| read (correct process, wrong guess) | 0 |
| variance (crit / miss / 15% roll) | 0 |

Once `teampreview` and `calc` entries exist, they are the calibration set for
`WEIGHTS` in `bring4.py`. Until then those weights are my guesses.
