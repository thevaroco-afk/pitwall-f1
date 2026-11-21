#!/usr/bin/env python3
"""Descarrega o dataset histórico do Kaggle (Rohan Rao) e escreve no ecrã a pasta dos CSV.
Usado pelo GitHub Actions (.github/workflows/historico.yml).
Se existirem as variáveis KAGGLE_USERNAME e KAGGLE_KEY, são usadas; senão tenta sem conta."""
import sys
from pathlib import Path

import kagglehub

DATASET = "rohanrao/formula-1-world-championship-1950-2020"

path = Path(kagglehub.dataset_download(DATASET, force_download=True))
hits = sorted(path.rglob("races.csv"))
if not hits:
    sys.exit(f"Não encontrei races.csv em {path}")
print(hits[0].parent)
