#!/usr/bin/env python3
"""
PITWALL — exportador de telemetria FastF1 para JSON estático.

Corre automaticamente no GitHub Actions (ver .github/workflows/fastf1.yml)
ou no seu computador. Gera ficheiros em
  htdocs/data/telemetry/

Instalação (uma vez):
    pip install fastf1

Exemplos:
    # Uma sessão: GP do Mónaco 2025, corrida
    python fastf1_export.py 2025 Monaco R

    # Qualificação e corrida de todos os GP já disputados de 2025
    python fastf1_export.py 2025 --all --sessions Q,R

    # Treinos livres 2 do GP de Portugal 2021, com todas as voltas de cada piloto
    python fastf1_export.py 2021 Portugal FP2 --laps all

    # Só os GP já disputados que ainda não estão no site (é o que o GitHub usa)
    python fastf1_export.py 2026 --missing --max-events 3 --no-js

Sessões: FP1, FP2, FP3, Q, SQ (qualificação sprint), S (sprint), R (corrida)
"""
from __future__ import annotations

import argparse
import json
import math
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

try:
    import fastf1
    import numpy as np
    import pandas as pd
except ImportError:  # pragma: no cover
    sys.exit("Falta instalar o FastF1:  pip install fastf1")

HERE = Path(__file__).resolve().parent
DEFAULT_OUT = HERE.parent / "htdocs" / "data" / "telemetry"
CACHE = HERE / ".fastf1-cache"
WRITE_JS = True  # ficheiros .js só servem para abrir o site directamente do disco
STEP_M = 5.0  # resolução da telemetria (metros)
SESSION_PT = {
    "Practice 1": "Treinos Livres 1", "Practice 2": "Treinos Livres 2", "Practice 3": "Treinos Livres 3",
    "Qualifying": "Qualificação", "Sprint Qualifying": "Qualificação Sprint", "Sprint Shootout": "Sprint Shootout",
    "Sprint": "Sprint", "Race": "Corrida",
}


def secs(v):
    """Timedelta -> segundos (float) ou None."""
    if v is None or pd.isna(v):
        return None
    try:
        return round(v.total_seconds(), 3)
    except AttributeError:
        return round(float(v), 3)


def clean(v):
    if v is None:
        return None
    if isinstance(v, (np.floating, float)):
        return None if math.isnan(v) else round(float(v), 3)
    if isinstance(v, (np.integer,)):
        return int(v)
    if isinstance(v, (np.bool_,)):
        return bool(v)
    if isinstance(v, pd.Timestamp):
        return v.isoformat()
    if isinstance(v, pd.Timedelta):
        return secs(v)
    return v


def slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


def resample_lap(tel: pd.DataFrame) -> dict:
    """Interpola a telemetria numa grelha uniforme de distância."""
    tel = tel.dropna(subset=["Distance"]).sort_values("Distance")
    tel = tel[~tel["Distance"].duplicated()]
    d = tel["Distance"].to_numpy(dtype=float)
    if len(d) < 10:
        return {}
    grid = np.arange(0.0, d[-1], STEP_M)
    t = tel["Time"].dt.total_seconds().to_numpy(dtype=float)
    out = {"d": grid.round(1).tolist(), "t": np.interp(grid, d, t).round(3).tolist()}
    for col, key, nd in [("Speed", "speed", 1), ("Throttle", "throttle", 0), ("RPM", "rpm", 0), ("X", "x", 0), ("Y", "y", 0)]:
        if col in tel:
            out[key] = np.interp(grid, d, tel[col].to_numpy(dtype=float)).round(nd).tolist()
    # canais discretos: valor mais próximo
    idx = np.clip(np.searchsorted(d, grid), 0, len(d) - 1)
    if "nGear" in tel:
        out["gear"] = tel["nGear"].to_numpy()[idx].astype(int).tolist()
    if "Brake" in tel:
        out["brake"] = (tel["Brake"].to_numpy()[idx].astype(float) * 100).astype(int).tolist()
    if "DRS" in tel:
        out["drs"] = [1 if v >= 10 else 0 for v in tel["DRS"].to_numpy()[idx]]
    return out


def export_session(year: int, event, ident: str, out_dir: Path, laps_mode: str = "fastest") -> dict | None:
    print(f"\n=== {year} · {event} · {ident} ===")
    session = fastf1.get_session(year, event, ident)
    session.load(laps=True, telemetry=True, weather=True, messages=True)
    ev = session.event
    sid = f"{year}-{int(ev['RoundNumber']):02d}-{slug(session.name)}"
    sdir = out_dir / sid
    sdir.mkdir(parents=True, exist_ok=True)

    res = session.results
    laps = session.laps
    drivers = []
    for _, r in res.iterrows():
        abbr = r["Abbreviation"]
        dl = laps.pick_drivers(abbr)
        fastest = dl.pick_fastest() if len(dl) else None
        color = r.get("TeamColor") or "888888"
        drivers.append({
            "abbr": abbr, "number": clean(r.get("DriverNumber")), "name": r.get("FullName"), "team": r.get("TeamName"),
            "color": "#" + str(color).lstrip("#") if color and str(color) != "nan" else "#888888",
            "headshot": r.get("HeadshotUrl") if isinstance(r.get("HeadshotUrl"), str) else None,
            "position": clean(r.get("Position")), "grid": clean(r.get("GridPosition")), "status": r.get("Status"),
            "points": clean(r.get("Points")),
            "bestLap": secs(fastest["LapTime"]) if fastest is not None and not pd.isna(fastest["LapTime"]) else None,
            "bestLapNumber": clean(fastest["LapNumber"]) if fastest is not None else None,
            "sectors": [secs(fastest[f"Sector{i}Time"]) for i in (1, 2, 3)] if fastest is not None else None,
            "compound": fastest["Compound"] if fastest is not None and isinstance(fastest["Compound"], str) else None,
        })

    # tabela de voltas (para tempos por volta e estratégia)
    lap_rows = []
    for _, l in laps.iterrows():
        lap_rows.append({
            "d": l["Driver"], "n": clean(l["LapNumber"]), "t": secs(l["LapTime"]),
            "s1": secs(l["Sector1Time"]), "s2": secs(l["Sector2Time"]), "s3": secs(l["Sector3Time"]),
            "c": l["Compound"] if isinstance(l["Compound"], str) else None, "life": clean(l["TyreLife"]), "stint": clean(l["Stint"]),
            "pos": clean(l.get("Position")), "pitIn": not pd.isna(l["PitInTime"]), "pitOut": not pd.isna(l["PitOutTime"]),
            "del": bool(l.get("Deleted")) if not pd.isna(l.get("Deleted")) else False, "st": clean(l.get("SpeedST")),
        })

    circuit = {"rotation": 0, "corners": []}
    try:
        ci = session.get_circuit_info()
        circuit["rotation"] = float(ci.rotation)
        circuit["corners"] = [
            {"n": int(c["Number"]), "l": c["Letter"] or "", "x": round(float(c["X"])), "y": round(float(c["Y"])),
             "dist": round(float(c["Distance"]), 1), "a": round(float(c["Angle"]), 1)}
            for _, c in ci.corners.iterrows()
        ]
    except Exception as e:  # noqa: BLE001
        print("  (sem info do circuito:", e, ")")

    status = []
    try:
        for _, m in session.race_control_messages.iterrows():
            if m.get("Category") in ("Flag", "SafetyCar") and isinstance(m.get("Message"), str):
                status.append({"lap": clean(m.get("Lap")), "msg": m["Message"], "flag": m.get("Flag") if isinstance(m.get("Flag"), str) else None})
    except Exception:  # noqa: BLE001
        pass

    weather = None
    try:
        w = session.weather_data
        weather = {"air": round(float(w["AirTemp"].mean()), 1), "track": round(float(w["TrackTemp"].mean()), 1),
                   "humidity": round(float(w["Humidity"].mean())), "rain": bool(w["Rainfall"].any())}
    except Exception:  # noqa: BLE001
        pass

    # telemetria por piloto
    exported = []
    for drv in drivers:
        abbr = drv["abbr"]
        dl = laps.pick_drivers(abbr)
        if not len(dl):
            continue
        targets = []
        fastest = dl.pick_fastest()
        if fastest is not None and not pd.isna(fastest["LapTime"]):
            targets.append(("fastest", fastest))
        if laps_mode == "all":
            for _, l in dl.iterlaps():
                if not pd.isna(l["LapTime"]):
                    targets.append((f"lap{int(l['LapNumber'])}", l))
        payload = {"abbr": abbr, "laps": {}}
        for key, lap in targets:
            try:
                tel = lap.get_telemetry()
                data = resample_lap(tel)
                if data:
                    data.update({"lap": clean(lap["LapNumber"]), "lapTime": secs(lap["LapTime"]), "compound": lap["Compound"] if isinstance(lap["Compound"], str) else None})
                    payload["laps"][key] = data
            except Exception as e:  # noqa: BLE001
                print(f"  {abbr} {key}: {e}")
        if payload["laps"]:
            write_data(sdir / f"{abbr}.json", payload, separators=(",", ":"))
            exported.append(abbr)
            print(f"  ✓ {abbr} ({len(payload['laps'])} volta(s))")

    meta = {
        "id": sid, "year": year, "round": int(ev["RoundNumber"]), "event": ev["EventName"], "country": ev["Country"],
        "location": ev["Location"], "session": session.name, "sessionName": SESSION_PT.get(session.name, session.name),
        "date": session.date.isoformat() if session.date is not None else None,
        "drivers": drivers, "laps": lap_rows, "circuit": circuit, "messages": status, "weather": weather,
        "telemetryDrivers": exported, "lapsMode": laps_mode, "step": STEP_M,
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    write_data(sdir / "meta.json", meta, separators=(",", ":"), default=clean)
    print(f"  → {sdir}")
    return {k: meta[k] for k in ("id", "year", "round", "event", "country", "location", "session", "sessionName", "date")} | {"drivers": exported}


def write_data(path: Path, obj, **kw):
    """Grava .json (servidor) e .js (abrir o site directamente do disco)."""
    txt = json.dumps(obj, **kw)
    path.write_text(txt, encoding="utf-8")
    if not WRITE_JS:
        return
    parts = path.resolve().parts
    i = len(parts) - 1 - parts[::-1].index("data") if "data" in parts else None
    key = "/".join(parts[i:]) if i is not None else "data/telemetry/" + path.name
    path.with_suffix(".js").write_text(f"(window.__PW_DATA=window.__PW_DATA||{{}})[{json.dumps(key)}]={txt};\n", encoding="utf-8")


def update_index(out_dir: Path, entries: list[dict]):
    idx_file = out_dir / "index.json"
    idx = {"sessions": []}
    if idx_file.exists():
        try:
            idx = json.loads(idx_file.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            pass
    by_id = {s["id"]: s for s in idx.get("sessions", [])}
    for e in entries:
        by_id[e["id"]] = e
    idx["sessions"] = sorted(by_id.values(), key=lambda s: (s["year"], s["round"], s["id"]), reverse=True)
    idx["updated"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    write_data(idx_file, idx, ensure_ascii=False, indent=1)
    print(f"\nÍndice actualizado: {idx_file} ({len(idx['sessions'])} sessões)")


def missing_jobs(year: int, out_dir: Path, max_events: int = 0) -> list:
    """GP terminados há mais de 1 dia que ainda não têm nenhuma sessão no índice.
    Exporta qualificação e corrida e, em fins-de-semana sprint, também a sprint."""
    done = set()
    idx_file = out_dir / "index.json"
    if idx_file.exists():
        try:
            for s in json.loads(idx_file.read_text(encoding="utf-8")).get("sessions", []):
                done.add((s.get("year"), s.get("round")))
        except json.JSONDecodeError:
            pass
    sched = fastf1.get_event_schedule(year, include_testing=False)
    limit = pd.Timestamp.now(tz="UTC").tz_localize(None) - pd.Timedelta(days=1)
    jobs, events = [], 0
    for _, ev in sched.iterrows():
        rnd = int(ev["RoundNumber"])
        if pd.Timestamp(ev["EventDate"]) > limit or (year, rnd) in done:
            continue
        sessions = ["Q", "R"]
        if "sprint" in str(ev.get("EventFormat", "")).lower():
            sessions = ["Q", "S", "R"]
        print(f"Em falta: ronda {rnd} · {ev['EventName']} ({', '.join(sessions)})")
        jobs += [(rnd, s) for s in sessions]
        events += 1
        if max_events and events >= max_events:
            break
    return jobs


def main():
    ap = argparse.ArgumentParser(description="Exporta telemetria FastF1 para o site PITWALL")
    ap.add_argument("year", type=int)
    ap.add_argument("event", nargs="?", help="Nome do GP (ex.: Monaco) ou número da ronda")
    ap.add_argument("session", nargs="?", default="R", help="FP1, FP2, FP3, Q, SQ, S, R")
    ap.add_argument("--all", action="store_true", help="todos os GP já disputados da época")
    ap.add_argument("--sessions", default="Q,R", help="com --all: sessões a exportar (ex.: Q,S,R)")
    ap.add_argument("--laps", choices=["fastest", "all"], default="fastest", help="exportar só a volta mais rápida (padrão) ou todas")
    ap.add_argument("--missing", action="store_true", help="GP já disputados da época que ainda não estão exportados")
    ap.add_argument("--max-events", type=int, default=0, help="com --missing: no máximo N GP por execução (0 = sem limite)")
    ap.add_argument("--no-js", action="store_true", help="não gerar os ficheiros .js (só .json)")
    ap.add_argument("--out", default=str(DEFAULT_OUT), help="pasta de saída (padrão: htdocs/data/telemetry)")
    a = ap.parse_args()
    global WRITE_JS
    WRITE_JS = not a.no_js

    CACHE.mkdir(exist_ok=True)
    fastf1.Cache.enable_cache(str(CACHE))
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)

    jobs = []
    if a.missing:
        jobs = missing_jobs(a.year, out, a.max_events)
        if not jobs:
            print("Nada de novo para exportar.")
            return
    elif a.all:
        sched = fastf1.get_event_schedule(a.year, include_testing=False)
        now = pd.Timestamp.now(tz="UTC").tz_localize(None)
        for _, ev in sched.iterrows():
            if pd.Timestamp(ev["EventDate"]) > now:
                continue
            for s in a.sessions.split(","):
                jobs.append((int(ev["RoundNumber"]), s.strip()))
    else:
        if not a.event:
            ap.error("indique o GP (ou use --all)")
        ev = int(a.event) if a.event.isdigit() else a.event
        jobs.append((ev, a.session))

    entries = []
    for ev, s in jobs:
        try:
            e = export_session(a.year, ev, s, out, a.laps)
            if e:
                entries.append(e)
        except Exception as ex:  # noqa: BLE001
            print(f"  ✗ {ev} {s}: {ex}")
    if entries:
        update_index(out, entries)


if __name__ == "__main__":
    main()
