#!/usr/bin/env python3
"""
PITWALL — exportador de telemetria da OpenF1 para JSON estático.

Gera exactamente o mesmo formato que o fastf1_export.py (pasta htdocs/data/telemetry/),
mas usa a API gratuita da OpenF1 (dados de 2023 em diante), sem conta nem palavra-passe.
Corre automaticamente no GitHub Actions (.github/workflows/fastf1.yml).

Exemplos:
    pip install numpy
    python openf1_export.py 2026 --missing                # GP já disputados que faltam no site
    python openf1_export.py 2026 --missing --max-events 3
    python openf1_export.py 2025 --round 8                # um GP (qualificação, sprint, corrida)

Notas:
- Durante uma sessão ao vivo a OpenF1 fecha a API a quem não paga; o script pára sem erro
  e tenta outra vez na execução seguinte.
- Números das curvas e rotação do mapa vêm da API pública do MultiViewer (se responder).
"""
from __future__ import annotations

import argparse
import json
import math
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
DEFAULT_OUT = HERE.parent / "htdocs" / "data" / "telemetry"
API = "https://api.openf1.org/v1"
MULTIVIEWER = "https://api.multiviewer.app/api/v1/circuits/{key}/{year}"
UA = "PitwallFanSite/1.0 (+github actions)"
STEP_M = 5.0
MIN_INTERVAL = 2.1  # a OpenF1 gratuita aceita ~30 pedidos/minuto
WANTED = {"Qualifying": "Qualificação", "Sprint": "Sprint", "Race": "Corrida"}
WRITE_JS = True


class LiveLocked(Exception):
    """A OpenF1 está fechada (sessão ao vivo a decorrer)."""


_last = 0.0


def get(path: str, params: dict | None = None, raw_filters: list[str] | None = None, base: str = API):
    """GET com espaçamento entre pedidos e novas tentativas em caso de limite (429) ou erro."""
    global _last
    q = urllib.parse.urlencode(params or {})
    if raw_filters:  # filtros do tipo date>=... (a OpenF1 quer os operadores tal como estão)
        q = "&".join(x for x in [q, *raw_filters] if x)
    url = (f"{base}/{path}" + (f"?{q}" if q else "")) if base == API else path
    for attempt in range(6):
        wait = MIN_INTERVAL - (time.time() - _last)
        if wait > 0:
            time.sleep(wait)
        _last = time.time()
        req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", "replace")[:200]
            if e.code in (401, 403) and base == API:
                raise LiveLocked(body) from None
            if e.code == 404:
                return []
            if e.code in (429, 500, 502, 503, 504):
                time.sleep(min(60, 5 * 2 ** attempt))
                continue
            raise RuntimeError(f"HTTP {e.code} em {url}: {body}") from None
        except (urllib.error.URLError, TimeoutError):
            time.sleep(min(60, 5 * 2 ** attempt))
    raise RuntimeError(f"falhou depois de várias tentativas: {url}")


def ts(s: str | None) -> float | None:
    if not s:
        return None
    s = s.replace("Z", "+00:00")
    try:
        d = datetime.fromisoformat(s)
    except ValueError:
        return None
    if d.tzinfo is None:
        d = d.replace(tzinfo=timezone.utc)
    return d.timestamp()


def iso(t: float) -> str:
    return datetime.fromtimestamp(t, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3]


def slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


def r3(v):
    return None if v is None or (isinstance(v, float) and math.isnan(v)) else round(float(v), 3)


def write_data(path: Path, obj, **kw):
    txt = json.dumps(obj, **kw)
    path.write_text(txt, encoding="utf-8")
    if WRITE_JS:
        parts = path.resolve().parts
        i = len(parts) - 1 - parts[::-1].index("data")
        key = "/".join(parts[i:])
        path.with_suffix(".js").write_text(f"(window.__PW_DATA=window.__PW_DATA||{{}})[{json.dumps(key)}]={txt};\n", encoding="utf-8")


# ---------------------------------------------------------------- calendário
def season_meetings(year: int) -> list[dict]:
    """GP da época (sem testes), por ordem, com o número da ronda e as sessões que interessam."""
    meetings = [m for m in get("meetings", {"year": year}) if not re.search(r"test", m.get("meeting_name", ""), re.I)]
    meetings.sort(key=lambda m: m["date_start"])
    sessions = get("sessions", {"year": year})
    out, rnd, now = [], 0, time.time()
    for m in meetings:
        ss = [s for s in sessions if s["meeting_key"] == m["meeting_key"] and s["session_name"] in WANTED]
        ss.sort(key=lambda s: s["date_start"])
        race = next((s for s in ss if s["session_name"] == "Race"), None)
        # GP cancelados continuam na lista da OpenF1 mas sem resultados: não contam para a numeração das rondas
        if race and (ts(race.get("date_end")) or 9e18) < now - 86400 and not get("session_result", {"session_key": race["session_key"]}):
            print(f"(sem resultados, provavelmente cancelado: {m['meeting_name']})")
            continue
        rnd += 1
        out.append({"round": rnd, "meeting": m, "sessions": ss})
    return out


# ---------------------------------------------------------------- telemetria de uma volta
def lap_telemetry(session_key: int, num: int, lap: dict) -> dict | None:
    t0 = ts(lap["date_start"])
    if t0 is None or not lap.get("lap_duration"):
        return None
    t1 = t0 + lap["lap_duration"]
    flt = [f"session_key={session_key}", f"driver_number={num}", f"date>={iso(t0 - 0.5)}", f"date<={iso(t1 + 0.5)}"]
    car = get("car_data", raw_filters=flt)
    loc = get("location", raw_filters=flt)
    C = sorted(((ts(c["date"]), c) for c in car if c.get("date")), key=lambda x: x[0])
    C = [(t, c) for t, c in C if t is not None and t0 <= t <= t1]
    if len(C) < 20:
        return None
    tt = np.array([t for t, _ in C]) - t0
    spd = np.array([float(c.get("speed") or 0) for _, c in C])
    dist = np.concatenate([[0.0], np.cumsum((spd[1:] + spd[:-1]) / 2 / 3.6 * np.diff(tt))])
    # normalizar e garantir distância crescente
    keep = np.concatenate([[True], np.diff(dist) > 0])
    tt, spd, dist = tt[keep], spd[keep], dist[keep]
    Ck = [c for (k, (_, c)) in zip(keep, C) if k]
    grid = np.arange(0.0, dist[-1], STEP_M)
    out = {"d": grid.round(1).tolist(), "t": np.interp(grid, dist, tt).round(3).tolist(),
           "speed": np.interp(grid, dist, spd).round(1).tolist()}
    for key, col in (("throttle", "throttle"), ("rpm", "rpm")):
        vals = np.array([float(c.get(col) or 0) for c in Ck])
        out[key] = np.interp(grid, dist, vals).round(0).tolist()
    out["throttle"] = [min(100.0, max(0.0, v)) for v in out["throttle"]]
    idx = np.clip(np.searchsorted(dist, grid), 0, len(dist) - 1)
    out["gear"] = [int(Ck[i].get("n_gear") or 0) for i in idx]
    out["brake"] = [100 if (Ck[i].get("brake") or 0) > 0 else 0 for i in idx]
    out["drs"] = [1 if (Ck[i].get("drs") or 0) >= 10 else 0 for i in idx]
    P = sorted(((ts(p["date"]), p) for p in loc if p.get("date") and (p.get("x") or p.get("y"))), key=lambda x: x[0])
    P = [(t, p) for t, p in P if t is not None]
    if len(P) >= 10:
        pt = np.array([t for t, _ in P]) - t0
        gt = np.array(out["t"])
        out["x"] = np.interp(gt, pt, [float(p["x"]) for _, p in P]).round(0).tolist()
        out["y"] = np.interp(gt, pt, [float(p["y"]) for _, p in P]).round(0).tolist()
    return out


def circuit_info(circuit_key, year, ref: dict | None) -> dict:
    circ = {"rotation": 0, "corners": []}
    try:
        data = get(MULTIVIEWER.format(key=circuit_key, year=year), base="mv")
        if not isinstance(data, dict):
            raise RuntimeError("circuito não encontrado no MultiViewer")
        circ["rotation"] = float(data.get("rotation") or 0)
        xs = np.array(ref["x"]) if ref and "x" in ref else None
        ys = np.array(ref["y"]) if ref and "y" in ref else None
        for c in data.get("corners", []):
            x, y = float(c["trackPosition"]["x"]), float(c["trackPosition"]["y"])
            dist = None
            if xs is not None:
                i = int(np.argmin((xs - x) ** 2 + (ys - y) ** 2))
                dist = round(float(ref["d"][i]), 1)
            circ["corners"].append({"n": int(c["number"]), "l": c.get("letter") or "", "x": round(x), "y": round(y),
                                    "dist": dist, "a": round(float(c.get("angle") or 0), 1)})
    except Exception as e:  # noqa: BLE001
        print("  (sem info do circuito:", e, ")")
    return circ


# ---------------------------------------------------------------- uma sessão
def export_session(year: int, rnd: int, meeting: dict, s: dict, out_dir: Path) -> dict | None:
    K = s["session_key"]
    name = s["session_name"]
    print(f"\n=== {year} · R{rnd} {meeting['meeting_name']} · {name} ===")
    sid = f"{year}-{rnd:02d}-{slug(name)}"
    drv = get("drivers", {"session_key": K})
    if not drv:
        print("  sem pilotos — a saltar")
        return None
    laps = get("laps", {"session_key": K})
    stints = get("stints", {"session_key": K})
    result = {r["driver_number"]: r for r in get("session_result", {"session_key": K})}
    grid = {g["driver_number"]: g.get("position") for g in get("starting_grid", {"session_key": K})}
    weather = get("weather", {"session_key": K})
    rc = get("race_control", {"session_key": K})

    def stint_of(num, n):
        for st in stints:
            if st["driver_number"] == num and st.get("lap_start") is not None and st["lap_start"] <= n <= (st.get("lap_end") or 999):
                return st
        return None

    acr = {d["driver_number"]: d["name_acronym"] for d in drv}
    lap_rows, best = [], {}
    for l in sorted(laps, key=lambda l: (l["driver_number"], l["lap_number"])):
        num = l["driver_number"]
        if num not in acr:
            continue
        st = stint_of(num, l["lap_number"])
        row = {"d": acr[num], "n": l["lap_number"], "t": r3(l.get("lap_duration")),
               "s1": r3(l.get("duration_sector_1")), "s2": r3(l.get("duration_sector_2")), "s3": r3(l.get("duration_sector_3")),
               "c": st.get("compound") if st else None,
               "life": (st.get("tyre_age_at_start") or 0) + l["lap_number"] - st["lap_start"] if st else None,
               "stint": st.get("stint_number") if st else None, "pos": None,
               "pitIn": False, "pitOut": bool(l.get("is_pit_out_lap")), "del": False, "st": l.get("st_speed")}
        lap_rows.append(row)
        if row["t"] and not row["pitOut"] and (num not in best or row["t"] < best[num][0]["t"]):
            best[num] = (row, l)
    # volta de entrada nas boxes = a anterior a uma volta de saída
    out_laps = {(r["d"], r["n"]) for r in lap_rows if r["pitOut"]}
    for r in lap_rows:
        r["pitIn"] = (r["d"], r["n"] + 1) in out_laps

    drivers = []
    for d in drv:
        num = d["driver_number"]
        res = result.get(num, {})
        b = best.get(num)
        status = "DSQ" if res.get("dsq") else "DNS" if res.get("dns") else "DNF" if res.get("dnf") else ("Finished" if res else None)
        drivers.append({
            "abbr": d["name_acronym"], "number": num, "name": d.get("full_name"), "team": d.get("team_name"),
            "color": "#" + (d.get("team_colour") or "888888").lstrip("#"), "headshot": d.get("headshot_url"),
            "position": res.get("position") if isinstance(res.get("position"), int) else None, "grid": grid.get(num), "status": status, "points": res.get("points") if isinstance(res.get("points"), (int, float)) else None,
            "bestLap": b[0]["t"] if b else None, "bestLapNumber": b[0]["n"] if b else None,
            "sectors": [b[0]["s1"], b[0]["s2"], b[0]["s3"]] if b else None, "compound": b[0]["c"] if b else None,
        })
    drivers.sort(key=lambda d: (d["position"] is None, d["position"] or 99, d["bestLap"] or 9e9))

    sdir = out_dir / sid
    sdir.mkdir(parents=True, exist_ok=True)
    exported, ref = [], None
    for d in drivers:
        b = best.get(d["number"])
        if not b:
            continue
        try:
            data = lap_telemetry(K, d["number"], b[1])
        except LiveLocked:
            raise
        except Exception as e:  # noqa: BLE001
            print(f"  {d['abbr']}: {e}")
            data = None
        if not data:
            print(f"  {d['abbr']}: sem telemetria")
            continue
        data.update({"lap": b[0]["n"], "lapTime": b[0]["t"], "compound": b[0]["c"]})
        if ref is None and "x" in data:
            ref = data
        write_data(sdir / f"{d['abbr']}.json", {"abbr": d["abbr"], "laps": {"fastest": data}}, separators=(",", ":"))
        exported.append(d["abbr"])
        print(f"  ✓ {d['abbr']}")
    if not exported:
        print("  nenhum piloto com telemetria — a saltar")
        return None

    w = None
    if weather:
        def avg(k):
            v = [x[k] for x in weather if x.get(k) is not None]
            return round(sum(v) / len(v), 1) if v else None
        w = {"air": avg("air_temperature"), "track": avg("track_temperature"), "humidity": avg("humidity"),
             "rain": any((x.get("rainfall") or 0) > 0 for x in weather)}
    msgs = [{"lap": m.get("lap_number"), "msg": m["message"], "flag": m.get("flag")}
            for m in rc if m.get("category") in ("Flag", "SafetyCar") and m.get("message")]

    meta = {
        "id": sid, "year": year, "round": rnd, "event": meeting["meeting_name"], "country": meeting.get("country_name"),
        "location": meeting.get("location"), "session": name, "sessionName": WANTED.get(name, name),
        "date": s.get("date_start"), "drivers": drivers, "laps": lap_rows,
        "circuit": circuit_info(meeting.get("circuit_key"), year, ref), "messages": msgs, "weather": w,
        "telemetryDrivers": exported, "lapsMode": "fastest", "step": STEP_M, "source": "OpenF1",
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    write_data(sdir / "meta.json", meta, separators=(",", ":"))
    print(f"  → {sdir}")
    return {k: meta[k] for k in ("id", "year", "round", "event", "country", "location", "session", "sessionName", "date")} | {"drivers": exported}


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


def main():
    global WRITE_JS
    ap = argparse.ArgumentParser(description="Exporta telemetria da OpenF1 para o site PITWALL")
    ap.add_argument("year", type=int)
    ap.add_argument("--round", type=int, help="só esta ronda")
    ap.add_argument("--missing", action="store_true", help="GP terminados que ainda não estão no índice")
    ap.add_argument("--max-events", type=int, default=0, help="no máximo N GP por execução (0 = sem limite)")
    ap.add_argument("--no-js", action="store_true", help="não gerar os ficheiros .js (só .json)")
    ap.add_argument("--out", default=str(DEFAULT_OUT))
    a = ap.parse_args()
    WRITE_JS = not a.no_js
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)

    done = set()
    if (out / "index.json").exists():
        try:
            done = {(s["year"], s["round"]) for s in json.loads((out / "index.json").read_text(encoding="utf-8")).get("sessions", [])}
        except json.JSONDecodeError:
            pass

    entries = []
    try:
        cal = season_meetings(a.year)
        limit = (datetime.now(timezone.utc) - timedelta(hours=12)).timestamp()
        events = 0
        for ev in cal:
            if a.round and ev["round"] != a.round:
                continue
            if not ev["sessions"] or (ts(ev["sessions"][-1].get("date_end")) or 9e18) > limit:
                continue  # ainda não terminou
            if a.missing and (a.year, ev["round"]) in done:
                continue
            got = []  # só entra no índice quando o GP inteiro foi tratado
            for s in ev["sessions"]:
                try:
                    e = export_session(a.year, ev["round"], ev["meeting"], s, out)
                    if e:
                        got.append(e)
                except LiveLocked:
                    raise
                except Exception as ex:  # noqa: BLE001
                    print(f"  ✗ {s['session_name']}: {ex}")
            entries += got
            events += 1
            if a.max_events and events >= a.max_events:
                break
    except LiveLocked as e:
        print(f"\nA OpenF1 está fechada neste momento (sessão ao vivo?): {e}\nO que já foi exportado fica guardado; o resto fica para a próxima execução.")
    if entries:
        update_index(out, entries)
    else:
        print("Nada de novo para exportar.")


if __name__ == "__main__":
    main()
