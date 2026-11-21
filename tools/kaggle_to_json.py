#!/usr/bin/env python3
"""
PITWALL — converte o dataset histórico do Kaggle em JSON estático para o site.

Dataset: "Formula 1 World Championship (1950 - 20xx)" (Rohan Rao)
  https://www.kaggle.com/datasets/rohanrao/formula-1-world-championship-1950-2020
(Os CSV usam os mesmos identificadores da Ergast/Jolpica, por isso o site
 consegue misturar os dois.)

Uso:
    pip install pandas
    python kaggle_to_json.py caminho/para/pasta_dos_csv

Gera htdocs/data/history/ :
    index.json            épocas, campeões, fiabilidade por ano
    records.json          recordes de sempre
    drivers.json          todos os pilotos com estatísticas de carreira
    drivers/<id>.json     carreira detalhada de cada piloto
    constructors.json     equipas com estatísticas
    circuits.json         circuitos com nº de corridas e maiores vencedores
"""
from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

try:
    import pandas as pd
except ImportError:  # pragma: no cover
    sys.exit("Falta instalar o pandas:  pip install pandas")

HERE = Path(__file__).resolve().parent
OUT = HERE.parent / "htdocs" / "data" / "history"


def load(src: Path, name: str, required=True) -> pd.DataFrame:
    f = src / f"{name}.csv"
    if not f.exists():
        if required:
            sys.exit(f"Ficheiro em falta: {f}")
        return pd.DataFrame()
    return pd.read_csv(f, na_values=["\\N"], keep_default_na=True, encoding="utf-8")


def dump(path: Path, obj):
    """Grava .json (para o servidor) e .js (para abrir o site directamente do disco)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    txt = json.dumps(obj, ensure_ascii=False, separators=(",", ":"))
    path.write_text(txt, encoding="utf-8")
    key = data_key(path)
    path.with_suffix(".js").write_text(f'(window.__PW_DATA=window.__PW_DATA||{{}})[{json.dumps(key)}]={txt};\n', encoding="utf-8")


def data_key(path: Path) -> str:
    """Caminho a partir de 'data/', tal como o site o pede (ex.: data/history/index.json)."""
    parts = path.resolve().parts
    i = len(parts) - 1 - parts[::-1].index("data") if "data" in parts else None
    return "/".join(parts[i:]) if i is not None else "data/history/" + path.name


def num(v, nd=None):
    if v is None or pd.isna(v):
        return None
    v = float(v)
    if nd is None:
        return int(v) if v.is_integer() else round(v, 2)
    return round(v, nd)


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    src = Path(sys.argv[1])
    out = Path(sys.argv[2]) if len(sys.argv) > 2 else OUT

    races = load(src, "races")
    results = load(src, "results")
    drivers = load(src, "drivers")
    constructors = load(src, "constructors")
    circuits = load(src, "circuits")
    status = load(src, "status")
    dstand = load(src, "driver_standings")
    cstand = load(src, "constructor_standings")
    sprint = load(src, "sprint_results", required=False)

    races = races.sort_values(["year", "round"])
    last_year = int(races[races["raceId"].isin(results["raceId"])]["year"].max())
    race_year = races.set_index("raceId")["year"]
    drivers["name"] = drivers["forename"] + " " + drivers["surname"]
    dname = drivers.set_index("driverId")["name"].to_dict()
    dref = drivers.set_index("driverId")["driverRef"].to_dict()
    dnat = drivers.set_index("driverId")["nationality"].to_dict()
    cname = constructors.set_index("constructorId")["name"].to_dict()
    cref = constructors.set_index("constructorId")["constructorRef"].to_dict()
    stat = status.set_index("statusId")["status"].to_dict()

    R = results.merge(races[["raceId", "year", "round", "circuitId", "name", "date"]], on="raceId")
    R["finished"] = R["statusId"].map(stat).fillna("").str.match(r"^(Finished|\+\d+ Laps?)$")
    R["win"] = R["positionOrder"].eq(1) & R["position"].notna()
    R["podium"] = R["position"].le(3)
    R["pole"] = R["grid"].eq(1)
    R["fl"] = R["rank"].eq(1) if "rank" in R else False
    sp_pts = sprint.groupby("driverId")["points"].sum() if len(sprint) else pd.Series(dtype=float)

    # ---------- campeões por época ----------
    last_race = races[races["raceId"].isin(dstand["raceId"])].groupby("year")["raceId"].max()
    seasons = []
    titles_d, titles_c = {}, {}
    for year, rid in last_race.items():
        ds = dstand[dstand["raceId"] == rid].sort_values("position")
        cs = cstand[cstand["raceId"] == rid].sort_values("position")
        ry = R[R["year"] == year]
        nraces = int(races[races["year"] == year].shape[0])
        entry = {"year": int(year), "races": nraces}
        if len(ds):
            c = ds.iloc[0]
            team_id = ry[ry["driverId"] == c["driverId"]]["constructorId"].mode()
            tid = int(team_id.iloc[0]) if len(team_id) else None
            second = ds.iloc[1] if len(ds) > 1 else None
            entry["champion"] = {
                "id": dref[c["driverId"]], "name": dname[c["driverId"]], "nat": dnat[c["driverId"]], "points": num(c["points"]), "wins": int(c["wins"]),
                "team": cname.get(tid), "teamId": cref.get(tid), "margin": num(c["points"] - second["points"]) if second is not None else None,
                "runnerUp": dname[second["driverId"]] if second is not None else None,
            }
            if year < last_year or races[(races["year"] == year)]["raceId"].max() == rid:
                titles_d[c["driverId"]] = titles_d.get(c["driverId"], 0) + 1
        if len(cs):
            c = cs.iloc[0]
            entry["constructor"] = {"id": cref[c["constructorId"]], "name": cname[c["constructorId"]], "points": num(c["points"]), "wins": int(c["wins"])}
            if year < last_year or races[(races["year"] == year)]["raceId"].max() == rid:
                titles_c[c["constructorId"]] = titles_c.get(c["constructorId"], 0) + 1
        starters = ry.groupby("raceId").size()
        entry["avgStarters"] = num(starters.mean(), 1) if len(starters) else None
        entry["finishRate"] = num(ry["finished"].mean() * 100, 1) if len(ry) else None
        entry["winners"] = int(ry[ry["win"]]["driverId"].nunique())
        entry["poleWinRate"] = num((ry["win"] & ry["pole"]).sum() / max(1, ry["win"].sum()) * 100, 1)
        seasons.append(entry)
    # campeonato em curso: marcar
    if seasons and seasons[-1]["year"] == last_year:
        done = races[(races["year"] == last_year) & races["raceId"].isin(results["raceId"])].shape[0]
        seasons[-1]["inProgress"] = done < seasons[-1]["races"]

    # ---------- pilotos ----------
    g = R.groupby("driverId")
    career = pd.DataFrame({
        "starts": g.size(), "wins": g["win"].sum(), "podiums": g["podium"].sum(), "poles": g["pole"].sum(),
        "fl": g["fl"].sum(), "points": g["points"].sum(), "first": g["year"].min(), "last": g["year"].max(),
        "finished": g["finished"].sum(), "bestGrid": g["grid"].apply(lambda s: s[s > 0].min()),
    })
    career["points"] = career["points"].add(sp_pts, fill_value=0)
    drivers_out = []
    for did, row in career.iterrows():
        d = drivers[drivers["driverId"] == did].iloc[0]
        teams = R[R["driverId"] == did].sort_values(["year", "round"])["constructorId"].map(cname).drop_duplicates().tolist()
        drivers_out.append({
            "id": d["driverRef"], "name": d["name"], "code": d["code"] if isinstance(d["code"], str) else None,
            "num": num(d["number"]), "nat": d["nationality"], "dob": d["dob"] if isinstance(d["dob"], str) else None,
            "starts": int(row["starts"]), "wins": int(row["wins"]), "podiums": int(row["podiums"]), "poles": int(row["poles"]),
            "fl": int(row["fl"]), "points": num(row["points"]), "titles": titles_d.get(did, 0),
            "first": int(row["first"]), "last": int(row["last"]), "teams": teams,
        })
    drivers_out.sort(key=lambda x: (-x["titles"], -x["wins"], -x["podiums"], -x["starts"]))
    dump(out / "drivers.json", drivers_out)

    # ---------- detalhe de cada piloto ----------
    for did in career.index:
        rd = R[R["driverId"] == did].sort_values(["year", "round"])
        seasons_d = []
        for year, ry in rd.groupby("year"):
            lr = last_race.get(year)
            st = dstand[(dstand["raceId"] == lr) & (dstand["driverId"] == did)] if lr is not None else pd.DataFrame()
            seasons_d.append({
                "year": int(year), "team": ", ".join(ry["constructorId"].map(cname).drop_duplicates()),
                "teamId": cref.get(int(ry["constructorId"].mode().iloc[0])),
                "pos": num(st["position"].iloc[0]) if len(st) else None, "points": num(st["points"].iloc[0]) if len(st) else num(ry["points"].sum()),
                "starts": int(len(ry)), "wins": int(ry["win"].sum()), "podiums": int(ry["podium"].sum()), "poles": int(ry["pole"].sum()),
                "best": num(ry["position"].min()), "dnf": int((~ry["finished"]).sum()),
            })
        wins = [{"year": int(r["year"]), "round": int(r["round"]), "race": r["name"], "grid": num(r["grid"])} for _, r in rd[rd["win"]].iterrows()]
        dist = rd["position"].value_counts().sort_index()
        dump(out / "drivers" / f"{dref[did]}.json", {
            "id": dref[did], "seasons": seasons_d, "wins": wins,
            "finishes": {str(int(k)): int(v) for k, v in dist.items()}, "dnf": int((~rd["finished"]).sum()),
        })

    # ---------- construtores ----------
    gc = R.groupby("constructorId")
    cons = []
    for cid, row in pd.DataFrame({"entries": gc["raceId"].nunique(), "wins": gc["win"].sum(), "podiums": gc["podium"].sum(), "poles": gc["pole"].sum(), "points": gc["points"].sum(), "first": gc["year"].min(), "last": gc["year"].max()}).iterrows():
        cons.append({"id": cref[cid], "name": cname[cid], "nat": constructors.set_index("constructorId").at[cid, "nationality"], "races": int(row["entries"]), "wins": int(row["wins"]), "podiums": int(row["podiums"]), "poles": int(row["poles"]), "points": num(row["points"]), "titles": titles_c.get(cid, 0), "first": int(row["first"]), "last": int(row["last"])})
    cons.sort(key=lambda x: (-x["titles"], -x["wins"], -x["races"]))
    dump(out / "constructors.json", cons)

    # ---------- circuitos ----------
    circ = []
    for _, c in circuits.iterrows():
        rc = R[R["circuitId"] == c["circuitId"]]
        if not len(rc):
            continue
        w = rc[rc["win"]]["driverId"].value_counts().head(5)
        circ.append({
            "id": c["circuitRef"], "name": c["name"], "loc": c["location"], "country": c["country"], "lat": num(c["lat"], 4), "lng": num(c["lng"], 4),
            "races": int(rc["raceId"].nunique()), "first": int(rc["year"].min()), "last": int(rc["year"].max()),
            "topWinners": [{"id": dref[k], "name": dname[k], "v": int(v)} for k, v in w.items()],
        })
    dump(out / "circuits.json", circ)

    # ---------- recordes ----------
    def top(df, col, n=15, extra=None):
        d = df.sort_values(col, ascending=False).head(n)
        return [{"id": r["id"], "name": r["name"], "nat": r.get("nat"), "v": num(r[col]), **({extra: r[extra]} if extra else {})} for _, r in d.iterrows()]

    D = pd.DataFrame(drivers_out)
    C = pd.DataFrame(cons)
    D["winPct"] = (D["wins"] / D["starts"] * 100).round(1)
    D["podPct"] = (D["podiums"] / D["starts"] * 100).round(1)
    # mais vitórias numa época
    ws = R[R["win"]].groupby(["year", "driverId"]).size().reset_index(name="v").sort_values("v", ascending=False).head(15)
    season_wins = [{"id": dref[r["driverId"]], "name": dname[r["driverId"]], "year": int(r["year"]), "v": int(r["v"]), "of": int(races[races["year"] == r["year"]].shape[0])} for _, r in ws.iterrows()]
    # vencedores mais novos / mais velhos
    rw = R[R["win"]].merge(drivers[["driverId", "dob"]], on="driverId")
    rw["age"] = (pd.to_datetime(rw["date"]) - pd.to_datetime(rw["dob"])).dt.days / 365.25
    first_win = rw.sort_values("date").groupby("driverId").first().reset_index().sort_values("age")
    youngest = [{"id": dref[r["driverId"]], "name": dname[r["driverId"]], "v": round(float(r["age"]), 2), "race": f'{r["name"]} {int(r["year"])}'} for _, r in first_win.head(10).iterrows()]
    oldest = [{"id": dref[r["driverId"]], "name": dname[r["driverId"]], "v": round(float(r["age"]), 2), "race": f'{r["name"]} {int(r["year"])}'} for _, r in rw.sort_values("age", ascending=False).drop_duplicates("driverId").head(10).iterrows()]
    # vitórias de mais atrás na grelha
    far = R[R["win"] & R["grid"].gt(0)].sort_values("grid", ascending=False).head(10)
    from_back = [{"id": dref[r["driverId"]], "name": dname[r["driverId"]], "v": int(r["grid"]), "race": f'{r["name"]} {int(r["year"])}'} for _, r in far.iterrows()]
    closest = sorted([s for s in seasons if s.get("champion", {}).get("margin") is not None and not s.get("inProgress")], key=lambda s: s["champion"]["margin"])[:10]

    records = {
        "drivers": {
            "titles": top(D[D["titles"] > 0], "titles"), "wins": top(D, "wins"), "poles": top(D, "poles"), "podiums": top(D, "podiums"),
            "starts": top(D, "starts"), "points": top(D, "points"), "fl": top(D, "fl"),
            "winPct": top(D[D["starts"] >= 30], "winPct"), "podPct": top(D[D["starts"] >= 30], "podPct"),
        },
        "constructors": {"titles": top(C[C["titles"] > 0], "titles"), "wins": top(C, "wins"), "poles": top(C, "poles"), "races": top(C, "races"), "podiums": top(C, "podiums")},
        "seasonWins": season_wins, "youngestWinners": youngest, "oldestWinners": oldest, "winsFromBack": from_back,
        "closestTitles": [{"year": s["year"], "name": s["champion"]["name"], "runnerUp": s["champion"]["runnerUp"], "v": s["champion"]["margin"]} for s in closest],
        "totals": {"races": int(races[races["raceId"].isin(results["raceId"])].shape[0]), "drivers": len(drivers_out), "constructors": len(cons), "circuits": len(circ), "winners": int(R[R["win"]]["driverId"].nunique())},
        "notes": "Poles = largar do 1.º lugar da grelha. Voltas mais rápidas só existem nos dados a partir de 2004.",
    }
    dump(out / "records.json", records)
    dump(out / "index.json", {"generated": datetime.now(timezone.utc).isoformat(timespec="seconds"), "lastYear": last_year, "seasons": seasons, "titles": {"drivers": {dref[k]: v for k, v in titles_d.items()}}})
    print(f"✓ {len(seasons)} épocas, {len(drivers_out)} pilotos, {len(cons)} equipas, {len(circ)} circuitos → {out}")


if __name__ == "__main__":
    main()
