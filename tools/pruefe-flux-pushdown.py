#!/usr/bin/env python3
"""
Prüft, dass die Grafana-Abfragen so gebaut sind, dass InfluxDB sie
hineinschieben kann.

## Anlass

Am 20.08.2026 legte das Dashboard „Funkqualität" den Master lahm. Erst sah es
nach einem zu schnellen Aktualisierungstakt aus. Beim Nachmessen kam die
eigentliche Ursache heraus — dieselbe Abfrage, zweimal geschrieben:

    |> filter(fn: (r) => contains(value: r.standort, set: [...]))     12 731 ms
    |> filter(fn: (r) => r.standort =~ /^(...)$/)                        199 ms

**Faktor 64 bei identischem Ergebnis** (89 111 Zeilen in beiden Fällen). Bei
einem einzelnen Gerät war es sogar Faktor 550 (11 418 ms gegen 21 ms).

Der Grund: InfluxDB kann Vergleiche auf Etiketten in die Speicherschicht
hineinschieben — aber nur, wenn sie als `==` oder `=~` direkt im `filter()`
stehen. `contains()` ist eine gewöhnliche Funktion; sie muss ausserhalb
ausgewertet werden, und dafür liest die Datenbank ZUERST alles und wirft
danach weg.

Das stand 39-mal in acht Vorlagen. Nicht eine davon war „falsch" — sie waren
alle nur langsam, und zusammen mit einem 30-Sekunden-Takt reichte das.

## Was hier geprüft wird

Kein `contains()` in einer Dashboard-Abfrage. Wer eine Menge von Etiketten
filtern will, schreibt es als regulären Ausdruck:

    |> filter(fn: (r) => r.standort =~ /^(${standort:regex})$/)

Aufruf:
    python3 tools/pruefe-flux-pushdown.py    # 0 = in Ordnung, 1 = zu langsam
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ORDNER = Path(__file__).resolve().parent.parent / "deploy" / "grafana" / "dashboards"


def main() -> int:
    beanstandungen: list[str] = []
    abfragen = 0

    for pfad in sorted(ORDNER.glob("*.json")):
        d = json.loads(pfad.read_text(encoding="utf-8"))
        for panel in d.get("panels", []):
            for ziel in panel.get("targets", []):
                q = ziel.get("query") or ""
                if not q:
                    continue
                abfragen += 1
                if "contains(" in q:
                    beanstandungen.append(
                        f"{pfad.stem}: Panel „{panel.get('title')}" + "“ benutzt contains() — "
                        "als regulaeren Ausdruck schreiben (=~), sonst liest "
                        "InfluxDB alles und wirft danach weg")

    if beanstandungen:
        print("Abfragen, die InfluxDB nicht hineinschieben kann:", file=sys.stderr)
        for b in beanstandungen:
            print(f"  - {b}", file=sys.stderr)
        print("\nHintergrund: tools/pruefe-flux-pushdown.py, Kopf der Datei.",
              file=sys.stderr)
        return 1

    print(f"Flux-Abfragen sind hineinschiebbar — {abfragen} geprueft.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
