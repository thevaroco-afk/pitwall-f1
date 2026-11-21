#!/usr/bin/env python3
"""Junta os módulos de htdocs/assets/js/src num único script clássico por página.
Assim o site funciona também quando se abre o index.html directamente do disco (file://).
Corra depois de alterar qualquer ficheiro em src/:  python tools/build_js.py"""
import re
from pathlib import Path

JS = Path(__file__).resolve().parent.parent / "htdocs" / "assets" / "js"
SRC = JS / "src"
ENTRIES = ["home", "epoca", "live", "telemetry", "history", "drivers", "circuits", "newspage"]
IMP = re.compile(r"^import\s+\{[^}]*\}\s+from\s+'\./([\w-]+)\.js';\s*$", re.M)


def collect(name, seen, order):
    if name in seen:
        return
    seen.add(name)
    code = (SRC / f"{name}.js").read_text(encoding="utf-8")
    for dep in IMP.findall(code):
        collect(dep, seen, order)
    order.append(name)


for entry in ENTRIES:
    order = []
    collect(entry, set(), order)
    parts = []
    for m in order:
        code = IMP.sub("", (SRC / f"{m}.js").read_text(encoding="utf-8"))
        code = re.sub(r"^export\s+(?=(async\s+)?(function|const|let|class)\b)", "", code, flags=re.M)
        parts.append(f"// ---- {m}.js ----\n{code}")
    out = "/* gerado por tools/build_js.py — edite os ficheiros em src/ */\n(() => {\n'use strict';\n" + "\n".join(parts) + "\n})();\n"
    (JS / f"{entry}.js").write_text(out, encoding="utf-8")
    print(f"✓ {entry}.js  ({' + '.join(order)})")
