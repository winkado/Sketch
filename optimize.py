"""Stat-point search: for each mon, enumerate (hp, def, spd, offense) with 32 cap / 66 total,
keep allocations that satisfy max-roll survival constraints, rank by objective. Verify winners in engine."""
from champ_calc import Dex, build_mon, damage
d=Dex()
B=lambda **k: build_mon(d,k)
KING=B(name="Kingambit",ability="Defiant",item="Black Glasses",nature="Adamant",evs={"atk":32,"hp":32,"spe":2},moves=["Kowtow Cleave"])
CHOMP=B(name="Garchomp",ability="Rough Skin",item="Life Orb",nature="Jolly",evs={"atk":32,"spe":32,"hp":2},moves=["Earthquake","Rock Slide"])
BASC=B(name="Basculegion",ability="Adaptability",item="Life Orb",nature="Adamant",evs={"atk":32,"spe":32,"hp":2},moves=["Wave Crash","Aqua Jet"])
ZARD=B(name="Charizard-Mega-Y",ability="Drought",item="Charizardite Y",nature="Modest",evs={"spa":32,"spe":32,"hp":2},moves=["Overheat","Heat Wave"])
SYLV=B(name="Sylveon",ability="Pixilate",item="Wise Glasses",nature="Modest",evs={"spa":32,"hp":32,"spd":2},moves=["Hyper Voice"])
STAR=B(name="Staraptor-Mega",ability="Contrary",item="Staraptite",nature="Jolly",evs={"atk":32,"spe":32,"hp":2},moves=["Brave Bird"])
GHOL=B(name="Gholdengo",ability="Good as Gold",item="Life Orb",nature="Modest",evs={"spa":32,"spe":32,"hp":2},moves=["Make It Rain"])

def mx(a,dfn,mv,spread=False,w=""): return damage(d,a,dfn,mv,spread=spread,weather=w)["max"]
def search(name,ability,item,natures,offkey,constraints,objective,fixed={}):
    best=[]
    for nat in natures:
        for hp in range(0,33):
            for de in range(0,33):
                for sd in range(0,33):
                    off=66-hp-de-sd
                    if off<0 or off>32: continue
                    evs={"hp":hp,"def":de,"spd":sd,offkey:off}; evs.update(fixed)
                    m=B(name=name,ability=ability,item=item,nature=nat,evs=evs,moves=[])
                    ok=True
                    for (atk,mv,spread,w,margin) in constraints:
                        if mx(atk,m,mv,spread,w)*(1+margin) >= m.stats["hp"]: ok=False; break
                    if not ok: continue
                    best.append((objective(m),nat,hp,de,sd,off,m))
    best.sort(key=lambda t:-t[0])
    return best

def show(title,res,n=4):
    print(f"\n### {title}")
    if not res: print("   NO allocation satisfies the constraints"); return
    for sc,nat,hp,de,sd,off,m in res[:n]:
        print(f"   {nat:8} HP{hp:3} Def{de:3} SpD{sd:3} Off{off:3} -> {m.stats}  score {sc:.1f}")

# ---- Oranguru: must survive max-roll Kowtow (2% margin, calc vs engine) and LO Wave Crash; maximise special bulk (Overheat/Heat Wave sun)
res=search("Oranguru","Inner Focus","Mental Herb",["Relaxed","Sassy","Bold","Calm"],"spa",
    [(KING,"Kowtow Cleave",False,"",0.02),(BASC,"Wave Crash",False,"",0.02)],
    lambda m: 100*(1 - mx(ZARD,m,"Overheat",False,"Sun")/m.stats["hp"]) + 100*(1-mx(ZARD,m,"Heat Wave",True,"Sun")/m.stats["hp"]) + 100*(1-mx(SYLV,m,"Hyper Voice",True)/m.stats["hp"]))
show("Oranguru (survive Kowtow+WaveCrash; max special bulk)",res)

# ---- Camerupt-Mega: survive LO Garchomp EQ (spread) and Kowtow; maximise SpA
res=search("Camerupt-Mega","Sheer Force","Cameruptite",["Quiet"],"spa",
    [(CHOMP,"Earthquake",True,"",0.02),(KING,"Kowtow Cleave",False,"",0.02)],
    lambda m: m.stats["spa"]*10 + m.stats["hp"]*0.1)
show("Camerupt-Mega (survive LO EQ spread + Kowtow; max SpA)",res)

# ---- Torkoal: survive LO EQ spread, Wave Crash in sun, Make It Rain (sun own); maximise SpA
res=search("Torkoal","Drought","Charcoal",["Quiet"],"spa",
    [(CHOMP,"Earthquake",True,"",0.02),(BASC,"Wave Crash",False,"Sun",0.02),(GHOL,"Make It Rain",False,"Sun",0.02)],
    lambda m: m.stats["spa"]*10 + m.stats["hp"]*0.1)
show("Torkoal (survive EQ spread, sun Wave Crash, Make It Rain; max SpA)",res)

# ---- Sinistcha: absorber - maximise the minimum HP left after each common single hit
hits=[(KING,"Kowtow Cleave",False,""),(STAR,"Brave Bird",False,""),(BASC,"Wave Crash",False,""),(CHOMP,"Rock Slide",False,"")]
res=search("Sinistcha","Hospitality","Sitrus Berry",["Relaxed","Bold","Sassy","Calm"],"spa",[],
    lambda m: min(m.stats["hp"]-mx(a,m,mv,sp,w) for a,mv,sp,w in hits) + 0.3*(m.stats["hp"]-mx(ZARD,m,"Heat Wave",True,"Sun")))
show("Sinistcha (maximise worst-case HP left after one hit)",res)

# calibration line: my calc vs engine on a known case
o=B(name="Oranguru",ability="Inner Focus",item="Mental Herb",nature="Relaxed",evs={"hp":32,"def":32,"spd":2},moves=[])
r=damage(d,KING,o,"Kowtow Cleave"); print(f"\ncalibration Kowtow->Oranguru 32/32: calc {r['min']}-{r['max']}  engine 164-194")
