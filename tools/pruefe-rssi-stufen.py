#!/usr/bin/env python3
"""
Prüft, dass Telegrammliste und Übersichtsdiagramm denselben Pegel gleich
bewerten.

Anlass: Die RSSI-Spalte der Liste färbt seit jeher nach drei Stufen. Seit dem
19.08.2026 tragen auch die Punkte des Übersichtsdiagramms diese Bewertung —
gebaut aus derselben Tabelle `RSSI_STUFEN`, aber in einer zweiten Schreibweise
(ECharts `visualMap`-Stücke mit `gte`/`lt`). Zwei Schreibweisen derselben
Absicht laufen still auseinander: Wer eine Schwelle verschiebt und die andere
vergisst, bekommt ein Telegramm, das in der Liste „mittel" heißt und im
Diagramm gelb-orange danebenliegt — und niemand merkt es, weil beides für
sich plausibel aussieht.

Geprüft wird deshalb der Quelltext: Die Grenzen in `chart.ts` müssen aus
`RSSI_STUFEN` stammen und dürfen keine eigenen Zahlen sein.

Aufruf:
    python3 tools/pruefe-rssi-stufen.py    # 0 = stimmig, 1 = Beanstandung
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

WURZEL = Path(__file__).resolve().parent.parent
FORMAT = WURZEL / "webui" / "src" / "format.ts"
CHART = WURZEL / "webui" / "src" / "chart.ts"


def main() -> int:
    beanstandungen: list[str] = []

    format_text = FORMAT.read_text(encoding="utf-8")
    chart_text = CHART.read_text(encoding="utf-8")

    # 1. Die Tabelle muss es geben, und rssiKlasse muss sie benutzen.
    if "RSSI_STUFEN" not in format_text:
        beanstandungen.append("RSSI_STUFEN fehlt in format.ts")
    klasse = re.search(r"export function rssiKlasse\([^)]*\)[^{]*\{(.*?)\n\}",
                       format_text, re.S)
    if klasse is None:
        beanstandungen.append("rssiKlasse nicht gefunden")
    elif "RSSI_STUFEN" not in klasse.group(1):
        beanstandungen.append(
            "rssiKlasse benutzt RSSI_STUFEN nicht — die Liste hat wieder eigene Zahlen")

    # 2. Das Diagramm muss dieselbe Tabelle benutzen.
    stuecke = re.search(r"pieces:\s*\[(.*?)\n\s*\],", chart_text, re.S)
    if stuecke is None:
        beanstandungen.append("visualMap-Stuecke in chart.ts nicht gefunden")
    else:
        inhalt = stuecke.group(1)
        if "RSSI_STUFEN" not in inhalt:
            beanstandungen.append(
                "Die Diagramm-Stuecke stehen nicht auf RSSI_STUFEN")
        # Eigene Zahlen an gte/lt sind genau der Fehler, um den es geht.
        eigene = re.findall(r"(?:gte|lt):\s*(-?\d+)", inhalt)
        if eigene:
            beanstandungen.append(
                "Feste Grenzen in den Diagramm-Stuecken statt RSSI_STUFEN: "
                + ", ".join(eigene))

    # 3. Farben: Die Tabelle fuehrt sie, das Diagramm holt sie dort.
    farben = re.findall(r"farbe:\s*'(#[0-9a-fA-F]{3,8})'", format_text)
    if len(farben) < 3:
        beanstandungen.append("RSSI_STUFEN fuehrt keine drei Farben")
    if stuecke is not None and re.search(r"color:\s*'#", stuecke.group(1)):
        beanstandungen.append(
            "Feste Farbwerte in den Diagramm-Stuecken statt RSSI_STUFEN")

    if beanstandungen:
        print("Bewertung von Liste und Diagramm laeuft auseinander:", file=sys.stderr)
        for b in beanstandungen:
            print(f"  - {b}", file=sys.stderr)
        return 1

    print(f"Liste und Diagramm bewerten aus derselben Tabelle "
          f"({len(farben)} Stufen).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
