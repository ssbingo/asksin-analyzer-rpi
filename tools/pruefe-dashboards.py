#!/usr/bin/env python3
"""Jedes Grafana-Dashboard steht im Handbuch — und umgekehrt.

    python3 tools/pruefe-dashboards.py

Warum es diese Prüfung gibt
---------------------------
Handbuch 19.8 beschreibt jede Ansicht einzeln: schematische Abbildung,
nummerierte Tabelle, Erklärung. Das ist der aufwendigste Teil des Kapitels —
und genau deshalb bleibt er beim Hinzufügen einer Ansicht liegen.

Am 16.08.2026 kam mit `nie-gehoert` die neunte Vorlage dazu. Das Handbuch
sprach danach an vier Stellen weiterhin von „acht Ansichten", die Abbildung
des Ordners zeigte acht Einträge, und die neue Ansicht war nirgends erklärt.
Aufgefallen ist es erst, weil jemand nachgefragt hat.

Geprüft wird deshalb dreierlei, jeweils gegen die erzeugten Dateien:

  1. Zu jeder Vorlage in `deploy/grafana/dashboards/` gibt es eine
     schematische Abbildung in `docs/handbuch/img/grafana/`.
  2. Zu jeder Vorlage gibt es ein `<img src="img/grafana/…">` im Handbuch.
  3. Die im Text genannte Anzahl („neun Ansichten") stimmt.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

WURZEL = Path(__file__).resolve().parent.parent
VORLAGEN = WURZEL / "deploy/grafana/dashboards"
BILDER = WURZEL / "docs/handbuch/img/grafana"
HANDBUCH = WURZEL / "docs/handbuch/handbuch.html"

# Der Ordnerüberblick gehört zu keiner einzelnen Ansicht.
KEIN_DASHBOARD = {"uebersicht"}

ZAHLWORT = {
    1: "eine", 2: "zwei", 3: "drei", 4: "vier", 5: "fünf", 6: "sechs",
    7: "sieben", 8: "acht", 9: "neun", 10: "zehn", 11: "elf", 12: "zwölf",
}


def main() -> int:
    fehler: list[str] = []

    namen = sorted(p.stem for p in VORLAGEN.glob("*.json"))
    if not namen:
        print(f"Keine Vorlagen in {VORLAGEN.relative_to(WURZEL)} gefunden.")
        return 1

    text = HANDBUCH.read_text(encoding="utf-8")
    eingebunden = set(re.findall(r'<img src="img/grafana/([^".]+)\.svg"', text))

    for name in namen:
        if not (BILDER / f"{name}.svg").exists():
            fehler.append(
                f"{name}: keine Abbildung docs/handbuch/img/grafana/{name}.svg — "
                "in vorschau-bauen.py ergaenzen"
            )
        if name not in eingebunden:
            fehler.append(
                f"{name}: im Handbuch nicht eingebunden — Abschnitt 19.8 fehlt "
                "die Beschreibung dieser Ansicht"
            )

    # Bilder ohne Vorlage: entweder eine geloeschte Ansicht oder ein Tippfehler.
    for bild in sorted(p.stem for p in BILDER.glob("*.svg")):
        if bild in KEIN_DASHBOARD:
            continue
        if bild not in namen:
            fehler.append(
                f"{bild}: Abbildung ohne Vorlage — Ansicht entfernt, Bild und "
                "Handbuchtext aber stehengeblieben?"
            )

    # Die im Text genannte Anzahl.
    zahl = len(namen)
    wort = ZAHLWORT.get(zahl, str(zahl))
    falsch = [w for n, w in ZAHLWORT.items() if n != zahl
              and f"{w} Ansichten" in text]
    if falsch:
        fehler.append(
            f'Handbuch spricht von {falsch[0]} Ansichten, es sind aber '
            f'{zahl} ({wort})'
        )

    if fehler:
        print("Grafana-Vorlagen und Handbuch passen nicht zusammen:")
        for f in fehler:
            print(f"  - {f}")
        return 1

    print(
        f'Dashboards in Ordnung — {zahl} Vorlagen, jede mit Abbildung und '
        f'Beschreibung im Handbuch, Anzahl im Text stimmt ({wort} Ansichten).'
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
