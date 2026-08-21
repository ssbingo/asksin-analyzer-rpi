#!/usr/bin/env python3
"""
Prüft die Flux-Abfragen aus Alarmregeln und Dashboards auf grobe Fehler.

## Anlass

Am 20.08.2026 habe ich eine Alarmregel repariert und dabei eine Erklärung
DIREKT IN die Abfrage geschrieben — mit `#` am Zeilenanfang, so wie in YAML,
Shell und Python. **Flux kennt kein `#`.** Der Kommentar dort heisst `//`.

Die Regel liess sich danach gar nicht mehr übersetzen:

    compilation failed: error @7:3-7:4: invalid statement: #

Das lief 472-mal in zwanzig Stunden, alle fünf Minuten, und meldete sich als
derselbe DatasourceError wie zuvor. Aus einem stillen Fehler war ein lauterer
geworden — die Reparatur war schlimmer als der Schaden.

Aufgefallen ist es nur, weil der Betreiber gefragt hat, warum die Meldung
immer noch kommt.

## Die eigentliche Lehre

Ich hatte die Abfrage von Hand nachgebaut und gegen die Datenbank geprüft —
aber nicht den Text, der ausgeliefert wurde. Zwischen beiden lagen acht
Kommentarzeilen. **Prüfen, was man ausliefert, nicht was man gemeint hat.**

Diese Prüfung fängt den mechanischen Teil davon ab; den Rest tut, wer die
Abfragen einmal gegen eine echte Datenbank laufen lässt.

## Was geprüft wird

  * kein `#` am Anfang einer Zeile innerhalb einer Flux-Abfrage
  * ausgeglichene Klammern — fängt abgeschnittene Abfragen

Aufruf:
    python3 tools/pruefe-flux-syntax.py    # 0 = in Ordnung, 1 = kaputt
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

WURZEL = Path(__file__).resolve().parent.parent
ALARME = WURZEL / "deploy/grafana/provisioning/alerting/asksin-alarme.yaml"
DASHBOARDS = WURZEL / "deploy/grafana/dashboards"


def abfragen() -> list[tuple[str, str, str]]:
    """(Herkunft, Bezeichnung, Abfragetext) für alles, was ausgeliefert wird."""
    gefunden: list[tuple[str, str, str]] = []

    if ALARME.exists():
        t = ALARME.read_text(encoding="utf-8")
        for m in re.finditer(r'title: (.*?)\n.*?query: \|\n(.*?)(?=\n\s+- refId|\n\s+relativeTime|\Z)',
                             t, re.S):
            gefunden.append((ALARME.name, m.group(1).strip(), m.group(2)))

    for pfad in sorted(DASHBOARDS.glob("*.json")):
        d = json.loads(pfad.read_text(encoding="utf-8"))
        for panel in d.get("panels", []):
            for ziel in panel.get("targets", []):
                if ziel.get("query"):
                    gefunden.append((pfad.name, str(panel.get("title")), ziel["query"]))
        for v in d.get("templating", {}).get("list", []):
            q = v.get("query")
            if isinstance(q, dict) and q.get("query"):
                gefunden.append((pfad.name, f"Variable {v.get('name')}", q["query"]))
    return gefunden


def main() -> int:
    beanstandungen: list[str] = []
    geprueft = 0

    for herkunft, was, q in abfragen():
        geprueft += 1
        for nr, zeile in enumerate(q.splitlines(), 1):
            if zeile.strip().startswith("#"):
                beanstandungen.append(
                    f"{herkunft} / {was}, Zeile {nr}: '#' ist in Flux KEIN "
                    f"Kommentar — die Abfrage laesst sich nicht uebersetzen. "
                    f"Kommentar nach aussen verschieben oder '//' benutzen.")
        for auf, zu, name in (("(", ")", "runde"), ("{", "}", "geschweifte"),
                              ("[", "]", "eckige")):
            if q.count(auf) != q.count(zu):
                beanstandungen.append(
                    f"{herkunft} / {was}: {name} Klammern unausgeglichen "
                    f"({q.count(auf)} auf, {q.count(zu)} zu)")

    if beanstandungen:
        print("Flux-Abfragen mit Fehlern:", file=sys.stderr)
        for b in beanstandungen:
            print(f"  - {b}", file=sys.stderr)
        print("\nHintergrund: tools/pruefe-flux-syntax.py, Kopf der Datei.",
              file=sys.stderr)
        return 1

    print(f"Flux-Abfragen syntaktisch in Ordnung — {geprueft} geprueft.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
