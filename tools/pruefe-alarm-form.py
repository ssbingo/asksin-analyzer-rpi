#!/usr/bin/env python3
"""
Prüft, dass jede Alarmabfrage eine **wide series** liefert.

## Anlass

Am 21.08.2026 meldete sich die Regel „Analyzer offline" tagelang mit
DatasourceError, während kein einziger Analyzer ausgefallen war. Grafana
protokollierte dazu **nichts**; der Grund stand nur in der Oberfläche unter
Alerting → Alert rules:

    [sse.readDataError] [A] got error: input data must be a wide series
    but got type long

Grafanas Ausdrucksauswertung (`reduce`, `threshold`) verlangt: Zeitspalte,
eine Zahlenspalte, Etiketten als Gruppenschlüssel. Kommen mehrere Textspalten
mit, hält Grafana das Ergebnis für eine *long series* und bricht ab.

Ob das passiert, hängt an derselben Unterscheidung wie beim `duplicate` einen
Tag zuvor — nur mit umgekehrtem Vorzeichen:

    last(), max(), min()   WAEHLEN eine Zeile aus und behalten ALLE Spalten,
                           also auch _field und _measurement    -> long
    mean()                 fasst zusammen und laesst sie fallen -> wide

Gemessen:

    offline    _start,_stop,_time,_value,_field,_measurement,standort   long
    rauschen   _start,_stop,standort,_value,_time                       wide

Deshalb endet jede Abfrage mit einem `keep()`, das nur Zeit, Wert und den
Gruppenschlüssel stehen lässt.

## Was hier geprüft wird

Jede Abfrage einer Alarmregel endet mit `keep(columns: [...])`, und dieses
`keep` lässt höchstens eine Textspalte übrig. Das ist eine Näherung — sie
fängt aber genau den Fehler, der hier zwei Tage gekostet hat.

Aufruf:
    python3 tools/pruefe-alarm-form.py    # 0 = wide, 1 = droht long
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ALARME = (Path(__file__).resolve().parent.parent
          / "deploy/grafana/provisioning/alerting/asksin-alarme.yaml")

ZEIT_UND_WERT = {"_time", "_value", "_start", "_stop"}


def main() -> int:
    if not ALARME.exists():
        print(f"{ALARME} fehlt", file=sys.stderr)
        return 1

    t = ALARME.read_text(encoding="utf-8")
    beanstandungen: list[str] = []
    geprueft = 0

    for m in re.finditer(r'title: (.*?)\n.*?query: \|\n(.*?)(?=\n\s+- refId|\Z)', t, re.S):
        titel, q = m.group(1).strip(), m.group(2)
        geprueft += 1
        letzte = [z.strip() for z in q.splitlines() if z.strip()][-1]

        k = re.search(r'keep\(columns:\s*\[(.*?)\]\)', letzte)
        if k is None:
            # mean() & Co. raeumen selbst auf — das ist die einzige Ausnahme.
            if re.search(r'\|>\s*(mean|sum|count|stddev|median)\(', q):
                continue
            beanstandungen.append(
                f"„{titel}“: endet nicht mit keep(...). Ohne das behalten "
                f"last()/max()/min() auch _field und _measurement — Grafana "
                f"haelt das Ergebnis dann fuer eine long series und bricht ab.")
            continue

        spalten = [s.strip().strip('"') for s in k.group(1).split(",")]
        text = [s for s in spalten if s not in ZEIT_UND_WERT]
        if len(text) > 1:
            beanstandungen.append(
                f"„{titel}“: keep laesst {len(text)} Textspalten stehen "
                f"({', '.join(text)}) — hoechstens eine (der Gruppenschluessel) "
                f"ergibt eine wide series.")

    if beanstandungen:
        print("Alarmabfragen, die Grafana nicht auswerten kann:", file=sys.stderr)
        for b in beanstandungen:
            print(f"  - {b}", file=sys.stderr)
        print("\nHintergrund: tools/pruefe-alarm-form.py, Kopf der Datei.",
              file=sys.stderr)
        return 1

    print(f"Alarmabfragen liefern wide series — {geprueft} geprueft.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
