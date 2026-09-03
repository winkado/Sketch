"""
bring4.py — Champions VGC bring-4 matchup solver.

Strategy space per side: choose 4 of 6 (15 subsets) x choose the lead pair
(6 orderings-as-sets) = 90 pure strategies.

Builds a 90x90 zero-sum payoff matrix from the damage matrix + speed tiers,
then solves for the Nash mixed strategy by linear programming.

HONEST LABEL ON THE PAYOFF FUNCTION
-----------------------------------
The payoff entries are NOT win probabilities. They are a heuristic advantage
index squashed through a logistic. The damage numbers underneath are real
(computed from the Champions data pack); the way they are aggregated into a
single number is a prior I picked, with weights in WEIGHTS below.

That prior is the weakest link in this whole tool. Two ways to fix it, in
increasing order of value:
  1. Swap payoff_matchup() for N Showdown sim rollouts (hook: PAYOFF_FN).
  2. Calibrate WEIGHTS against your own game log once teams.md has entries.

Until then: read the mixed strategy as "these brings are live, these are not",
not as "bring this 34.2% of the time".
"""

import itertools
import json
import math
import sys

import numpy as np
from scipy.optimize import linprog

from champ_calc import Dex, build_mon, best_move, effective_speed, damage

WEIGHTS = {
    "lead_pressure": 1.6,   # who wins the opening exchange
    "team_coverage": 1.0,   # 4v4 offensive answers
    "speed_edge": 0.5,      # lead speed control
    "fake_out": 0.12,       # per Fake Out user in the bring
    "redirect": 0.10,       # per Follow Me / Rage Powder user
    "intimidate": 0.10,     # per Intimidate mon in the bring
    "speed_control": 0.14,  # per Tailwind / Trick Room / Icy Wind / T-Wave user
    "spread_move": 0.06,    # per spread attacker
    "logistic_k": 2.2,      # squash steepness
}

FAKE_OUT = {"fake out"}
REDIRECT = {"follow me", "rage powder"}
SPEED_CTRL = {"tailwind", "trick room", "icy wind", "electroweb", "thunder wave",
              "glare", "bulldoze", "rock tomb", "scary face"}


def load_team(dex, path_or_list, strict=True):
    specs = path_or_list
    if isinstance(path_or_list, str):
        with open(path_or_list, encoding="utf-8") as f:
            specs = json.load(f)
    if len(specs) != 6:
        raise ValueError(f"team must have exactly 6, got {len(specs)}")
    return [build_mon(dex, s, strict=strict) for s in specs]


def damage_matrix(dex, teamA, teamB, weather="", terrain=""):
    """dmg[i][j] = avg % of B[j]'s HP removed by A[i]'s best move (single-target
    framing; spread moves keep their 0.75)."""
    M = np.zeros((len(teamA), len(teamB)))
    detail = {}
    for i, a in enumerate(teamA):
        for j, b in enumerate(teamB):
            d = best_move(dex, a, b, weather=weather, terrain=terrain)
            M[i, j] = d["avg_pct"]
            detail[(a.name, b.name)] = d
    return M, detail


def _flags(dex, mons):
    f = {"fake_out": 0, "redirect": 0, "intimidate": 0, "speed_control": 0, "spread_move": 0}
    for m in mons:
        low = {x.lower() for x in m.moves}
        f["fake_out"] += len(low & FAKE_OUT) > 0
        f["redirect"] += len(low & REDIRECT) > 0
        f["speed_control"] += len(low & SPEED_CTRL) > 0
        f["intimidate"] += m.ability == "Intimidate"
        f["spread_move"] += any(
            dex.mv(x)["target"] in ("allAdjacentFoes", "allAdjacent") and dex.mv(x)["bp"] > 0
            for x in m.moves)
    return f


def payoff_matchup(dex, teamA, teamB, dmgAB, dmgBA, bringA, leadA, bringB, leadB,
                   tailwindA=False, tailwindB=False):
    """Heuristic advantage index -> pseudo win share in [0,1]."""
    # lead pressure: best fraction of a lead's HP each side removes per turn
    myLead = np.mean([max(dmgAB[i][j] for j in leadB) for i in leadA]) / 100
    thLead = np.mean([max(dmgBA[j][i] for i in leadA) for j in leadB]) / 100
    lead_adv = myLead - thLead

    # team coverage: for each of their 4, my best answer; and vice versa
    myCov = np.mean([max(dmgAB[i][j] for i in bringA) for j in bringB]) / 100
    thCov = np.mean([max(dmgBA[j][i] for j in bringB) for i in bringA]) / 100
    team_adv = myCov - thCov

    # speed on the leads
    sA = [effective_speed(teamA[i], tailwind=tailwindA) for i in leadA]
    sB = [effective_speed(teamB[j], tailwind=tailwindB) for j in leadB]
    wins = sum(1 for x in sA for y in sB if x > y)
    speed_adv = (wins - (4 - wins)) / 4

    fA, fB = _flags(dex, [teamA[i] for i in bringA]), _flags(dex, [teamB[j] for j in bringB])

    W = WEIGHTS
    score = (W["lead_pressure"] * lead_adv
             + W["team_coverage"] * team_adv
             + W["speed_edge"] * speed_adv)
    for k in ("fake_out", "redirect", "intimidate", "speed_control", "spread_move"):
        score += W[k] * (fA[k] - fB[k])
    return 1 / (1 + math.exp(-W["logistic_k"] * score))


PAYOFF_FN = payoff_matchup  # swap for sim rollouts


def strategies():
    """90 pure strategies: (bring4 indices, lead2 indices)."""
    out = []
    for bring in itertools.combinations(range(6), 4):
        for lead in itertools.combinations(bring, 2):
            out.append((bring, lead))
    return out


def build_payoff(dex, teamA, teamB, weather="", terrain=""):
    dmgAB, detAB = damage_matrix(dex, teamA, teamB, weather, terrain)
    dmgBA, detBA = damage_matrix(dex, teamB, teamA, weather, terrain)
    S = strategies()
    P = np.zeros((len(S), len(S)))
    for r, (bA, lA) in enumerate(S):
        for c, (bB, lB) in enumerate(S):
            P[r, c] = PAYOFF_FN(dex, teamA, teamB, dmgAB, dmgBA, bA, lA, bB, lB)
    return P, S, (dmgAB, dmgBA, detAB, detBA)


def solve_nash(P):
    """Row player's maximin mixed strategy for a zero-sum game.
    Returns (row_strategy, col_strategy, game_value)."""
    n, m = P.shape
    shift = P.min() - 1.0
    Q = P - shift  # make strictly positive

    # Row player: max v s.t. x^T Q >= v, sum x = 1
    c = np.zeros(n + 1); c[-1] = -1.0
    A_ub = np.hstack([-Q.T, np.ones((m, 1))])
    b_ub = np.zeros(m)
    A_eq = np.zeros((1, n + 1)); A_eq[0, :n] = 1.0
    res = linprog(c, A_ub=A_ub, b_ub=b_ub, A_eq=A_eq, b_eq=[1.0],
                  bounds=[(0, None)] * n + [(None, None)], method="highs")
    if not res.success:
        raise RuntimeError("row LP failed: " + res.message)
    x, v = res.x[:n], res.x[-1]

    # Column player: min w s.t. Q y <= w, sum y = 1
    c2 = np.zeros(m + 1); c2[-1] = 1.0
    A_ub2 = np.hstack([Q, -np.ones((n, 1))])
    b_ub2 = np.zeros(n)
    A_eq2 = np.zeros((1, m + 1)); A_eq2[0, :m] = 1.0
    res2 = linprog(c2, A_ub=A_ub2, b_ub=b_ub2, A_eq=A_eq2, b_eq=[1.0],
                   bounds=[(0, None)] * m + [(None, None)], method="highs")
    if not res2.success:
        raise RuntimeError("col LP failed: " + res2.message)
    y = res2.x[:m]
    return x, y, v + shift


def report(teamA, teamB, P, S, x, y, val, top=6, dmg=None):
    nA = [m.name for m in teamA]
    nB = [m.name for m in teamB]
    L = []
    L.append(f"Game value (your advantage index, 0.5 = even): {val:.3f}")
    L.append("NOT a win probability. See the header of bring4.py.\n")

    def fmt(side_names, S, w, label):
        L.append(f"--- {label}: optimal mix ---")
        idx = np.argsort(-w)
        shown = 0
        for k in idx:
            if w[k] < 1e-4 or shown >= top:
                break
            bring, lead = S[k]
            b = ", ".join(side_names[i] for i in bring)
            ld = " + ".join(side_names[i] for i in lead)
            L.append(f"  {w[k]*100:5.1f}%  lead {ld:<34} back {', '.join(side_names[i] for i in bring if i not in lead)}")
            shown += 1
        used = int((w > 1e-4).sum())
        L.append(f"  ({used} of {len(S)} brings in support)\n")

    fmt(nA, S, x, "YOU")
    fmt(nB, S, y, "OPPONENT")

    # marginal bring rates
    L.append("--- your marginal inclusion rate per mon ---")
    marg = {n: 0.0 for n in nA}
    for k, (bring, lead) in enumerate(S):
        for i in bring:
            marg[nA[i]] += x[k]
    for n, p in sorted(marg.items(), key=lambda t: -t[1]):
        bar = "#" * int(round(p * 30))
        L.append(f"  {n:<22} {p*100:5.1f}%  {bar}")
    return "\n".join(L)


def main(pathA, pathB, weather="", terrain=""):
    dex = Dex()
    A, B = load_team(dex, pathA), load_team(dex, pathB)
    P, S, dm = build_payoff(dex, A, B, weather, terrain)
    x, y, v = solve_nash(P)
    print(report(A, B, P, S, x, y, v, dmg=dm))


if __name__ == "__main__":
    a = sys.argv[1] if len(sys.argv) > 1 else "team_you.json"
    b = sys.argv[2] if len(sys.argv) > 2 else "team_opp.json"
    w = sys.argv[3] if len(sys.argv) > 3 else ""
    main(a, b, w)
