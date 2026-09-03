"""
champ_calc.py — Pokemon Champions (Reg M-B) damage calculator + legality validator.

Reads the data pack as the ONLY source of truth:
  pokemon.csv   -> legality + base stats + abilities + mega mapping
  learnsets.csv -> movepool legality (Champions, NOT mainline)
  moves.csv     -> Champions BP / PP / target
  items.csv     -> legal item pool

Nothing here is drawn from mainline VGC memory. If a species, move or item is
not in the CSVs, build_mon() raises.

Level 50. Doubles. STAT POINTS not EVs - see build_mon(). Crits are not modelled (they are noise, not signal, for
bring-4 selection).

SCOPE WARNING - read before trusting a number.
This is an independent reimplementation of the Gen 9 damage formula, not
Showdown's engine. It models the mechanics listed in MODELLED_ABILITIES and
ITEM_MODS below and NOTHING ELSE. Verify any number that decides a game in the
real calculator or the Showdown sim.
"""

import csv
import math
import os
import re
from dataclasses import dataclass, field

DATA_DIR = os.environ.get("CHAMP_DATA", "/mnt/user-data/uploads")
ITEMS_PATH = os.environ.get("CHAMP_ITEMS", os.path.join(os.path.dirname(__file__), "items.csv"))

# ---------------------------------------------------------------- type chart
TYPES = ["Normal", "Fire", "Water", "Electric", "Grass", "Ice", "Fighting", "Poison",
         "Ground", "Flying", "Psychic", "Bug", "Rock", "Ghost", "Dragon", "Dark",
         "Steel", "Fairy"]

_SUPER = {
    "Normal": {}, 
    "Fire": {"Grass": 2, "Ice": 2, "Bug": 2, "Steel": 2, "Fire": .5, "Water": .5, "Rock": .5, "Dragon": .5},
    "Water": {"Fire": 2, "Ground": 2, "Rock": 2, "Water": .5, "Grass": .5, "Dragon": .5},
    "Electric": {"Water": 2, "Flying": 2, "Electric": .5, "Grass": .5, "Dragon": .5, "Ground": 0},
    "Grass": {"Water": 2, "Ground": 2, "Rock": 2, "Fire": .5, "Grass": .5, "Poison": .5,
              "Flying": .5, "Bug": .5, "Dragon": .5, "Steel": .5},
    "Ice": {"Grass": 2, "Ground": 2, "Flying": 2, "Dragon": 2, "Fire": .5, "Water": .5, "Ice": .5, "Steel": .5},
    "Fighting": {"Normal": 2, "Ice": 2, "Rock": 2, "Dark": 2, "Steel": 2, "Poison": .5,
                 "Flying": .5, "Psychic": .5, "Bug": .5, "Fairy": .5, "Ghost": 0},
    "Poison": {"Grass": 2, "Fairy": 2, "Poison": .5, "Ground": .5, "Rock": .5, "Ghost": .5, "Steel": 0},
    "Ground": {"Fire": 2, "Electric": 2, "Poison": 2, "Rock": 2, "Steel": 2,
               "Grass": .5, "Bug": .5, "Flying": 0},
    "Flying": {"Grass": 2, "Fighting": 2, "Bug": 2, "Electric": .5, "Rock": .5, "Steel": .5},
    "Psychic": {"Fighting": 2, "Poison": 2, "Psychic": .5, "Steel": .5, "Dark": 0},
    "Bug": {"Grass": 2, "Psychic": 2, "Dark": 2, "Fire": .5, "Fighting": .5, "Poison": .5,
            "Flying": .5, "Ghost": .5, "Steel": .5, "Fairy": .5},
    "Rock": {"Fire": 2, "Ice": 2, "Flying": 2, "Bug": 2, "Fighting": .5, "Ground": .5, "Steel": .5},
    "Ghost": {"Psychic": 2, "Ghost": 2, "Dark": .5, "Normal": 0},
    "Dragon": {"Dragon": 2, "Steel": .5, "Fairy": 0},
    "Dark": {"Psychic": 2, "Ghost": 2, "Fighting": .5, "Dark": .5, "Fairy": .5},
    "Steel": {"Ice": 2, "Rock": 2, "Fairy": 2, "Fire": .5, "Water": .5, "Electric": .5, "Steel": .5},
    "Fairy": {"Fighting": 2, "Dragon": 2, "Dark": 2, "Fire": .5, "Poison": .5, "Steel": .5},
}


def type_eff(move_type, defender_types):
    m = 1.0
    for t in defender_types:
        m *= _SUPER.get(move_type, {}).get(t, 1.0)
    return m


# ------------------------------------------------- modelled abilities / items
# Anything not in these tables is treated as having NO damage effect.
MODELLED_ABILITIES = {
    # attacker-side multipliers
    "Adaptability": "STAB 2.0 instead of 1.5",
    "Technician": "1.5x if BP <= 60",
    "Tough Claws": "1.3x on contact moves",
    "Huge Power": "Attack x2",
    "Pure Power": "Attack x2",
    "Sheer Force": "1.3x on moves with a secondary (secondary suppressed)",
    "Iron Fist": "1.2x on punch moves",
    "Strong Jaw": "1.5x on bite moves",
    "Sharpness": "1.5x on slicing moves",
    "Guts": "Attack x1.5 when statused (burn Atk drop ignored)",
    "Solar Power": "SpA x1.5 in sun",
    "Swarm/Overgrow/Blaze/Torrent": "1.5x on own type at <=1/3 HP",
    # defender-side multipliers
    "Thick Fat": "Fire/Ice damage halved",
    "Multiscale": "halved at full HP",
    "Shadow Shield": "halved at full HP",
    "Solid Rock": "supereffective damage x0.75",
    "Filter": "supereffective damage x0.75",
    "Prism Armor": "supereffective damage x0.75",
    "Fur Coat": "physical damage halved",
    "Ice Scales": "special damage halved",
    "Levitate": "Ground immunity",
    "Water Absorb": "Water immunity",
    "Volt Absorb": "Electric immunity",
    "Flash Fire": "Fire immunity",
    "Sap Sipper": "Grass immunity",
    "Lightning Rod": "Electric immunity",
    "Storm Drain": "Water immunity",
    "Motor Drive": "Electric immunity",
    "Dry Skin": "Water immunity, Fire x1.25",
    "Well-Baked Body": "Fire immunity",
    "Earth Eater": "Ground immunity",
    "Purifying Salt": "Ghost damage halved",
    # weather setters (auto-applied if weather='auto')
    "Drought": "sets Sun", "Drizzle": "sets Rain",
    "Sand Stream": "sets Sand", "Snow Warning": "sets Snow",
    "Orichalcum Pulse": "sets Sun", "Hadron Engine": "sets Electric Terrain",
}

ITEM_MODS = {
    "Life Orb": ("all", 1.3), "Expert Belt": ("se_only", 1.2),
    "Muscle Band": ("physical", 1.1), "Wise Glasses": ("special", 1.1),
    "Black Belt": ("type:Fighting", 1.2), "Black Glasses": ("type:Dark", 1.2),
    "Charcoal": ("type:Fire", 1.2), "Dragon Fang": ("type:Dragon", 1.2),
    "Fairy Feather": ("type:Fairy", 1.2), "Hard Stone": ("type:Rock", 1.2),
    "Magnet": ("type:Electric", 1.2), "Metal Coat": ("type:Steel", 1.2),
    "Miracle Seed": ("type:Grass", 1.2), "Mystic Water": ("type:Water", 1.2),
    "Never-Melt Ice": ("type:Ice", 1.2), "Poison Barb": ("type:Poison", 1.2),
    "Sharp Beak": ("type:Flying", 1.2), "Silk Scarf": ("type:Normal", 1.2),
    "Silver Powder": ("type:Bug", 1.2), "Soft Sand": ("type:Ground", 1.2),
    "Spell Tag": ("type:Ghost", 1.2), "Twisted Spoon": ("type:Psychic", 1.2),
}
# Resist berries: halve one supereffective hit of that type.
BERRY_RESIST = {
    "Babiri Berry": "Steel", "Charti Berry": "Rock", "Chople Berry": "Fighting",
    "Coba Berry": "Flying", "Colbur Berry": "Dark", "Haban Berry": "Dragon",
    "Kasib Berry": "Ghost", "Kebia Berry": "Poison", "Occa Berry": "Fire",
    "Passho Berry": "Water", "Payapa Berry": "Psychic", "Rindo Berry": "Grass",
    "Roseli Berry": "Fairy", "Shuca Berry": "Ground", "Tanga Berry": "Bug",
    "Wacan Berry": "Electric", "Yache Berry": "Ice",
}

NATURES = {
    "Adamant": ("atk", "spa"), "Modest": ("spa", "atk"), "Jolly": ("spe", "spa"),
    "Timid": ("spe", "atk"), "Bold": ("def", "atk"), "Calm": ("spd", "atk"),
    "Impish": ("def", "spa"), "Careful": ("spd", "spa"), "Brave": ("atk", "spe"),
    "Quiet": ("spa", "spe"), "Relaxed": ("def", "spe"), "Sassy": ("spd", "spe"),
    "Naive": ("spe", "spd"), "Hasty": ("spe", "def"), "Lonely": ("atk", "def"),
    "Naughty": ("atk", "spd"), "Mild": ("spa", "def"), "Rash": ("spa", "spd"),
    "Serious": (None, None), "Hardy": (None, None), "Docile": (None, None),
    "Bashful": (None, None), "Quirky": (None, None),
}


# ------------------------------------------------------------------ data load
class Dex:
    def __init__(self, data_dir=DATA_DIR, items_path=ITEMS_PATH):
        self.species, self.moves, self.items = {}, {}, {}
        self.learnset = {}
        with open(os.path.join(data_dir, "pokemon.csv"), newline="", encoding="utf-8") as f:
            for r in csv.DictReader(f):
                for k in ("hp", "atk", "def", "spa", "spd", "spe", "bst", "ndex"):
                    r[k] = int(r[k])
                r["types"] = r["types"].split("/")
                r["weight_kg"] = float(r["weight_kg"] or 0)
                self.species[r["name"].lower()] = r
        with open(os.path.join(data_dir, "moves.csv"), newline="", encoding="utf-8") as f:
            for r in csv.DictReader(f):
                r["bp"] = int(r["bp"])
                r["pp"] = int(r["pp"])
                r["priority"] = int(r["priority"])
                r["crit_ratio"] = int(r["crit_ratio"] or 1)
                r["flagset"] = set(r["flags"].split())
                self.moves[r["name"].lower()] = r
        with open(os.path.join(data_dir, "learnsets.csv"), newline="", encoding="utf-8") as f:
            for r in csv.DictReader(f):
                self.learnset.setdefault(r["pokemon"].lower(), set()).add(r["move"].lower())
        with open(items_path, newline="", encoding="utf-8") as f:
            for r in csv.DictReader(f):
                self.items[r["name"].lower()] = r

    def sp(self, name):
        s = self.species.get(name.lower())
        if not s:
            raise ValueError(f"NOT LEGAL in Reg M-B (absent from pokemon.csv): {name!r}")
        return s

    def mv(self, name):
        m = self.moves.get(name.lower())
        if not m:
            raise ValueError(f"Move not in Champions moves.csv: {name!r}")
        return m

    def it(self, name):
        i = self.items.get(name.lower())
        if not i:
            raise ValueError(f"Item not in Champions items.csv: {name!r}")
        return i

    def can_learn(self, species, move):
        """Movepool check. Megas inherit the base forme's Champions pool."""
        s = self.sp(species)
        pools = [s["name"].lower()]
        if s["base_species"] and s["base_species"].lower() != s["name"].lower():
            pools.append(s["base_species"].lower())
        return any(move.lower() in self.learnset.get(p, ()) for p in pools)


# --------------------------------------------------------------------- mon
@dataclass
class Mon:
    name: str
    ability: str
    item: str
    nature: str
    evs: dict
    ivs: dict
    moves: list
    level: int = 50
    stats: dict = field(default_factory=dict)
    types: list = field(default_factory=list)
    boosts: dict = field(default_factory=lambda: {k: 0 for k in "atk def spa spd spe".split()})
    status: str = ""
    hp_pct: float = 1.0

    def stat(self, k):
        v = self.stats[k]
        if k != "hp":
            b = self.boosts.get(k, 0)
            v = math.floor(v * ((2 + b) / 2 if b >= 0 else 2 / (2 - b)))
        return v


def build_mon(dex, spec, strict=True):
    """spec: dict(name, ability, item, nature, evs, moves[, ivs, boosts, status, hp_pct])
    Raises on anything the data pack says is illegal."""
    s = dex.sp(spec["name"])
    evs = {k: 0 for k in "hp atk def spa spd spe".split()}
    evs.update(spec.get("evs", {}))
    ivs = {k: 31 for k in evs}
    ivs.update(spec.get("ivs", {}))

    ability = spec.get("ability", "")
    legal_ab = [a for a in (s["ability0"], s["ability1"], s["abilityH"]) if a]
    if strict and ability and ability not in legal_ab:
        raise ValueError(f"{s['name']} cannot have {ability!r}; legal: {legal_ab}")
    ability = ability or legal_ab[0]

    item = spec.get("item", "")
    if item:
        dex.it(item)
        if s["is_mega"] == "Y" and s["mega_stone"] and item != s["mega_stone"]:
            raise ValueError(f"{s['name']} must hold {s['mega_stone']}, got {item!r}")

    moves = spec.get("moves", [])
    for m in moves:
        dex.mv(m)
        if strict and not dex.can_learn(s["name"], m):
            raise ValueError(
                f"{s['name']} does NOT learn {m!r} in Champions "
                f"(learnsets.csv). This is where mainline memory goes wrong.")

    nat = spec.get("nature", "Serious")
    if nat not in NATURES:
        raise ValueError(f"Unknown nature {nat!r}")
    up, dn = NATURES[nat]
    lvl = spec.get("level", 50)

    # ---- Pokémon Champions stat system (per Showdown data/mods/champions/scripts.ts) ----
    # "evs" here are STAT POINTS: max 32 per stat, max 66 total. IVs are irrelevant (fixed 31).
    #   HP    = base + points + 75
    #   other = base + points + 20, then nature x1.1 / x0.9 (truncated)
    # Consequence: speed cannot be lowered below (base+20)*0.9 - there are no 0 IVs.
    if any(v > 32 for v in evs.values()):
        raise ValueError(f"{s['name']}: a stat has more than 32 Stat Points (Champions cap)")
    if sum(evs.values()) > 66:
        raise ValueError(f"{s['name']}: {sum(evs.values())} Stat Points > 66 (Champions cap)")
    stats = {}
    for k in evs:
        base = s[k]
        if k == "hp":
            stats[k] = base + evs[k] + 75
        else:
            v = base + evs[k] + 20
            if k == up:
                v = math.floor(v * 1.1)
            elif k == dn:
                v = math.floor(v * 0.9)
            stats[k] = v

    m = Mon(name=s["name"], ability=ability, item=item, nature=nat, evs=evs, ivs=ivs,
            moves=list(moves), level=lvl, stats=stats, types=list(s["types"]),
            status=spec.get("status", ""), hp_pct=spec.get("hp_pct", 1.0))
    m.boosts.update(spec.get("boosts", {}))
    return m


# ---------------------------------------------------------------- speed
def effective_speed(mon, tailwind=False, paralysis=None):
    spe = mon.stat("spe")
    if mon.item == "Choice Scarf":
        spe = math.floor(spe * 1.5)
    if mon.item == "Iron Ball":
        spe = math.floor(spe * 0.5)
    par = mon.status == "par" if paralysis is None else paralysis
    if par:
        spe = math.floor(spe * 0.5)
    if tailwind:
        spe *= 2
    return spe


# ---------------------------------------------------------------- damage
def damage(dex, atk_mon, def_mon, move_name, *, spread=False, weather="",
           crit=False, terrain=""):
    """Return dict with min/avg/max damage and %-of-max-HP. Returns zeros for
    status moves and immunities."""
    mv = dex.mv(move_name)
    if mv["category"] == "Status":
        return _zero(mv, "status move")

    mtype = mv["type"]
    eff = type_eff(mtype, def_mon.types)

    # ability immunities
    da = def_mon.ability
    imm = {
        "Levitate": "Ground", "Water Absorb": "Water", "Storm Drain": "Water",
        "Dry Skin": "Water", "Volt Absorb": "Electric", "Lightning Rod": "Electric",
        "Motor Drive": "Electric", "Flash Fire": "Fire", "Well-Baked Body": "Fire",
        "Sap Sipper": "Grass", "Earth Eater": "Ground",
    }
    if imm.get(da) == mtype or eff == 0:
        return _zero(mv, "immune")

    bp = mv["bp"]
    if bp == 0:
        return _zero(mv, "variable/zero BP - model manually")

    phys = mv["category"] == "Physical"
    a_key, d_key = ("atk", "def") if phys else ("spa", "spd")
    A = atk_mon.stat(a_key)
    D = def_mon.stat(d_key)

    aa = atk_mon.ability
    if aa in ("Huge Power", "Pure Power") and phys:
        A = math.floor(A * 2)
    if aa == "Guts" and atk_mon.status and phys:
        A = math.floor(A * 1.5)
    if aa == "Solar Power" and weather == "Sun" and not phys:
        A = math.floor(A * 1.5)

    # BP modifiers
    bp_mod = 1.0
    fl = mv["flagset"]
    if aa == "Technician" and bp <= 60:
        bp_mod *= 1.5
    if aa == "Tough Claws" and "contact" in fl:
        bp_mod *= 1.3
    if aa == "Iron Fist" and "punch" in fl:
        bp_mod *= 1.2
    if aa == "Strong Jaw" and "bite" in fl:
        bp_mod *= 1.5
    if aa == "Sharpness" and "slicing" in fl:
        bp_mod *= 1.5
    if aa == "Sheer Force" and mv["secondary"]:
        bp_mod *= 1.3
    pinch = {"Overgrow": "Grass", "Blaze": "Fire", "Torrent": "Water", "Swarm": "Bug"}
    if pinch.get(aa) == mtype and atk_mon.hp_pct <= 1 / 3:
        bp_mod *= 1.5
    bp = max(1, math.floor(bp * bp_mod))

    base = math.floor(math.floor(math.floor(2 * atk_mon.level / 5 + 2) * bp * A / D) / 50) + 2

    mod = 1.0
    if spread:
        mod *= 0.75
    if weather == "Sun":
        mod *= 1.5 if mtype == "Fire" else (0.5 if mtype == "Water" else 1)
    elif weather == "Rain":
        mod *= 1.5 if mtype == "Water" else (0.5 if mtype == "Fire" else 1)
    if terrain == "Electric" and mtype == "Electric":
        mod *= 1.3
    if terrain == "Grassy" and mtype == "Grass":
        mod *= 1.3
    if terrain == "Psychic" and mtype == "Psychic":
        mod *= 1.3

    stab = 1.0
    if mtype in atk_mon.types:
        stab = 2.0 if aa == "Adaptability" else 1.5

    # item
    if atk_mon.item in ITEM_MODS:
        kind, mult = ITEM_MODS[atk_mon.item]
        if (kind == "all"
                or (kind == "physical" and phys)
                or (kind == "special" and not phys)
                or (kind == "se_only" and eff > 1)
                or (kind.startswith("type:") and kind[5:] == mtype)):
            mod *= mult
    if atk_mon.item == "Light Ball" and atk_mon.name.startswith("Pikachu"):
        A = math.floor(A * 2)

    # defender ability
    if da == "Thick Fat" and mtype in ("Fire", "Ice"):
        mod *= 0.5
    if da == "Dry Skin" and mtype == "Fire":
        mod *= 1.25
    if da in ("Multiscale", "Shadow Shield") and def_mon.hp_pct >= 1.0:
        mod *= 0.5
    if da in ("Solid Rock", "Filter", "Prism Armor") and eff > 1:
        mod *= 0.75
    if da == "Fur Coat" and phys:
        mod *= 0.5
    if da == "Ice Scales" and not phys:
        mod *= 0.5
    if da == "Purifying Salt" and mtype == "Ghost":
        mod *= 0.5
    if BERRY_RESIST.get(def_mon.item) == mtype and eff > 1:
        mod *= 0.5
    if def_mon.item == "Chilan Berry" and mtype == "Normal":
        mod *= 0.5

    if atk_mon.status == "brn" and phys and aa != "Guts":
        mod *= 0.5

    lo, hi = [], []
    for r in range(85, 101):
        d = math.floor(base * r / 100)
        d = math.floor(d * stab)
        d = math.floor(d * eff)
        d = max(1, math.floor(d * mod))
        lo.append(d)
    mx_hp = def_mon.stats["hp"]
    return {
        "move": mv["name"], "type": mtype, "eff": eff, "spread": spread,
        "min": min(lo), "max": max(lo), "avg": sum(lo) / len(lo),
        "min_pct": 100 * min(lo) / mx_hp, "max_pct": 100 * max(lo) / mx_hp,
        "avg_pct": 100 * (sum(lo) / len(lo)) / mx_hp,
        "target_hp": mx_hp, "note": "",
    }


def _zero(mv, note):
    return {"move": mv["name"], "type": mv["type"], "eff": 0, "spread": False,
            "min": 0, "max": 0, "avg": 0, "min_pct": 0, "max_pct": 0, "avg_pct": 0,
            "target_hp": 0, "note": note}


def best_move(dex, atk, dfn, **kw):
    """Highest average-damage legal attacking move atk has into dfn."""
    best, bestd = None, None
    for mn in atk.moves:
        mv = dex.mv(mn)
        if mv["category"] == "Status":
            continue
        sp = kw.pop("force_spread", None)
        spread = mv["target"] in ("allAdjacentFoes", "allAdjacent") if sp is None else sp
        d = damage(dex, atk, dfn, mn, spread=spread, **kw)
        if bestd is None or d["avg"] > bestd["avg"]:
            best, bestd = mn, d
    if bestd is None:
        return {"move": None, "avg_pct": 0.0, "min_pct": 0.0, "max_pct": 0.0,
                "avg": 0, "note": "no attacking moves"}
    return bestd
