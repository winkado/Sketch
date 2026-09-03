"""
preview.py — you see 6 species and nothing else. For each, list every hidden
capability (ability / move / item) it COULD have that interacts with the
Oranguru + Sinistcha Trick Room setup, straight from the data pack.

Rule: if a species can carry it, assume it does.

usage: python3 preview.py Garchomp Kingambit Whimsicott Basculegion Floette-Eternal Charizard-Mega-Y
"""
import sys
from champ_calc import Dex

# threat -> (why it matters, test)
def threats(dex, name):
    s = dex.sp(name)
    base = dex.species.get(s["base_species"].lower(), s)
    pools = set(dex.learnset.get(s["name"].lower(), ())) | set(dex.learnset.get(base["name"].lower(), ()))
    # abilities: a Mega's ability is fixed; a non-Mega could be any of its three.
    # A species that CAN mega has both its base abilities and the mega's — we can't see the stone.
    abil = {a for a in (s["ability0"], s["ability1"], s["abilityH"]) if a}
    if s["is_mega"] == "N":
        for m in dex.species.values():
            if m["base_species"] == s["name"] and m["is_mega"] == "Y":
                abil |= {a for a in (m["ability0"], m["ability1"], m["abilityH"]) if a}
    grass = "Grass" in s["types"]
    out = []
    A = lambda *xs: any(x in abil for x in xs)
    M = lambda *xs: [x for x in xs if x in pools]

    if A("Mold Breaker", "Teravolt", "Turboblaze") and M("rock slide"):
        out.append("BREAKS T1: Mold Breaker Rock Slide flinches Oranguru through Inner Focus")
    if A("Mold Breaker", "Teravolt", "Turboblaze") and M("fake out"):
        out.append("delays T1: Mold Breaker Fake Out flinches Oranguru")
    if A("Scrappy", "Mind's Eye") and M("fake out"):
        out.append("BREAKS REDIRECT: Scrappy Fake Out hits Sinistcha -> Rage Powder fails, one hit/Taunt reaches Oranguru")
    if grass and M("taunt"):
        out.append("Grass-type Taunt ignores Rage Powder -> consumes Mental Herb (2nd one sticks)")
    if grass and M("encore"):
        out.append("Grass-type Encore ignores Rage Powder -> Oranguru must Protect on T2")
    if grass and M("fake out"):
        out.append("Grass-type Fake Out ignores Rage Powder (Inner Focus still blocks the flinch)")
    if M("imprison") and M("trick room"):
        spe_max = int((s["spe"] + 52) * 1.1)
        out.append(f"MIRROR LOCK: Imprison + Trick Room, max speed {spe_max} — if faster than Oranguru (72) its Imprison resolves first and your TR is locked")
    elif M("trick room"):
        out.append("Trick Room user: T1 TRs cancel each other -> Oranguru should Imprison T1, TR T2")
    if M("quash"):
        out.append("Quash: forces your sweeper to move last (single-target, redirected while Sinistcha is up)")
    if M("gastro acid", "skill swap", "entrainment", "worry seed", "simple beam"):
        out.append(f"ability removal {M('gastro acid','skill swap','entrainment','worry seed','simple beam')} (single-target, redirected T1)")
    if M("roar", "whirlwind", "dragon tail", "circle throw"):
        out.append(f"phazing {M('roar','whirlwind','dragon tail','circle throw')} on the sweeper (single-target)")
    if M("perish song"):
        out.append("Perish Song: 3-turn clock on the sweep")
    if M("feint"):
        out.append("Feint: their Protect-break (+2 priority)")
    if M("detect", "spiky shield", "baneful bunker", "king's shield"):
        out.append(f"shield not locked by Imprison: {M('detect','spiky shield','baneful bunker','kings shield')}")
    if M("sucker punch"):
        out.append("Sucker Punch on Camerupt while attacking (Farigiraf's Armor Tail stops it)")
    water = [m for m in pools if dex.mv(m)["type"] == "Water" and dex.mv(m)["bp"] >= 60]
    ground = [m for m in pools if dex.mv(m)["type"] == "Ground" and dex.mv(m)["bp"] >= 60]
    if water:
        out.append(f"4x WATER into Camerupt-Mega: {sorted(water)[:6]}")
    if ground:
        out.append(f"2x GROUND into Camerupt-Mega: {sorted(ground)[:6]}")
    spe_min = int((s["spe"] + 20) * 0.9)
    if spe_min <= 36:
        out.append(f"can tie/undercut Camerupt-Mega's 36 speed under TR (min {spe_min})")
    return s, out


def double_spread_check(dex, names, setter=("Oranguru","Inner Focus","Mental Herb","Relaxed",{"hp":32,"def":32,"spd":2})):
    """Worst-case: every species gets 32 offense + 32 speed, its best spread move, and the team's weather if any of the six sets it."""
    from champ_calc import build_mon, damage
    from itertools import combinations
    ora = build_mon(dex, {"name": setter[0], "ability": setter[1], "item": setter[2], "nature": setter[3], "evs": setter[4], "moves": []})
    weather = ""
    sp_all = []
    for n in names:
        try: sp = dex.sp(n)
        except ValueError: continue
        abil = {a for a in (sp["ability0"], sp["ability1"], sp["abilityH"]) if a}
        if abil & {"Drought"}: weather = weather or "Sun"
        if abil & {"Drizzle"}: weather = weather or "Rain"
        sp_all.append(sp)
    out = []
    for sp in sp_all:
        base = dex.species.get(sp["base_species"].lower(), sp)
        pool = set(dex.learnset.get(sp["name"].lower(), ())) | set(dex.learnset.get(base["name"].lower(), ()))
        best = (0, None)
        for mid in pool:
            mv = dex.mv(mid)
            if mv["target"] not in ("allAdjacentFoes", "allAdjacent") or mv["bp"] < 50 or mv["category"] == "Status": continue
            off = "atk" if mv["category"] == "Physical" else "spa"
            nat = "Adamant" if off == "atk" else "Modest"
            ab = sp["ability0"]
            try:
                m = build_mon(dex, {"name": sp["name"], "ability": ab, "item": (sp["mega_stone"] or "Life Orb"), "nature": nat, "evs": {off: 32, "spe": 32, "hp": 2}, "moves": [mid]}, strict=False)
                dmg = damage(dex, m, ora, mid, spread=True, weather=weather)["max"]
            except Exception: continue
            if dmg > best[0]: best = (dmg, mv["name"])
        if best[1]: out.append((sp["name"], best[1], best[0]))
    pairs = []
    for a, b in combinations(out, 2):
        tot = a[2] + b[2]
        if tot >= 0.95 * ora.stats["hp"]:
            pairs.append((100 * tot / ora.stats["hp"], f"{a[0]} {a[1]} + {b[0]} {b[1]}"))
    pairs.sort(reverse=True)
    print(f"== DOUBLE-SPREAD CHECK vs {setter[0]} ({ora.stats['hp']} HP){' in ' + weather if weather else ''}: pairs that can KO before Trick Room (max rolls, worst-case Life Orb sets)")
    for t, lab in pairs: print(f"   {t:4.0f}%  {lab}")
    if not pairs: print("   none - Trick Room lead is safe from a turn-1 spread KO")
    else: print("   -> if they lead one of these pairs, the TR lead loses on turn 1. Consider the fast pair.")
    print()

def main(names):
    dex0 = Dex(); double_spread_check(dex0, names)
    dex = Dex()
    print("Opposing six -> worst-case capabilities (Champions data pack)\n")
    for n in names:
        try:
            s, out = threats(dex, n)
        except ValueError as e:
            print(f"{n}: {e}\n"); continue
        print(f"== {s['name']} ({'/'.join(s['types'])}, spe range {int((s['spe']+20)*0.9)}-{int((s['spe']+52)*1.1)})")
        for o in out or ["no setup interaction found"]:
            print("   -", o)
        print()


if __name__ == "__main__":
    main(sys.argv[1:])
