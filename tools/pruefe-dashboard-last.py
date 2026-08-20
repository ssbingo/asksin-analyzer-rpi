#!/usr/bin/env python3
"""
Prüft, dass kein Grafana-Dashboard die Datenbank überfährt.

## Anlass

Am 20.08.2026 war Analyzer 01 zweimal nicht mehr erreichbar. Ping ging, alle
Ports waren offen, aber kein Prozess antwortete mehr — die Last stieg binnen
sieben Minuten von 0,1 auf 16,3. Kein Speichermangel, kein E/A-Fehler, keine
volle Platte.

Ausgelöst hat es das Dashboard „Funkqualität". Gemessen:

  * EINE seiner Abfragen lieferte **447 352 Zeilen** (rund 200 Reihen mal
    1440 Minutenfenster über 24 Stunden).
  * Eine einzige `stddev`-Abfrage davon trieb die Last allein auf 10.
  * Das Dashboard führte alle **30 Sekunden** drei solche Abfragen aus.

Damit war die Ursache nicht die einzelne Abfrage, sondern das Verhältnis:
Sie brauchte länger als der Takt, in dem sie wiederholt wurde. InfluxDB
protokollierte reihenweise `context canceled` — Grafana gab auf, die Arbeit
lief weiter, und die nächste Runde kam obendrauf.

## Was hier geprüft wird

Zwei Regeln, beide aus diesem Vorfall:

  1. Der Aktualisierungstakt muss zum Zeitbereich passen. Ein Tagesverlauf
     ändert sich nicht alle 30 Sekunden — er alle 30 Sekunden neu zu rechnen
     ist keine Aktualität, sondern Dauerlast.
  2. Jedes Zeitreihen-Panel braucht eine Obergrenze für die Punktzahl
     (`maxDataPoints`). Ohne sie wählt Grafana das Fenster nach der Bildbreite;
     bei vielen Geräten entstehen daraus Hunderttausende Zeilen.

Aufruf:
    python3 tools/pruefe-dashboard-last.py    # 0 = tragbar, 1 = zu scharf
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

WURZEL = Path(__file__).resolve().parent.parent
ORDNER = WURZEL / "deploy" / "grafana" / "dashboards"

# Kleinster vertretbarer Takt je Zeitbereich. Grosszuegig gewaehlt: Es geht
# nicht um Feinschliff, sondern darum, dass eine Abfrage fertig wird, bevor
# die naechste startet.
MINDESTTAKT_S = {
    "now-1h": 30, "now-6h": 60, "now-12h": 300,
    "now-24h": 300, "now-2d": 300, "now-7d": 900, "now-30d": 1800,
}

# Panel-Arten, die eine Zeitreihe zeichnen und deshalb eine Obergrenze
# brauchen. Tabellen und Einzelwerte liefern von sich aus wenige Zeilen.
ZEITREIHEN = {"timeseries", "barchart", "heatmap"}


def sekunden(takt: str | None) -> int | None:
    """'30s' -> 30, '5m' -> 300, None/'' -> None (kein Selbstauffrischen)."""
    if not takt:
        return None
    einheit, zahl = takt[-1], takt[:-1]
    faktor = {"s": 1, "m": 60, "h": 3600, "d": 86400}.get(einheit)
    if faktor is None or not zahl.isdigit():
        return None
    return int(zahl) * faktor


def main() -> int:
    beanstandungen: list[str] = []
    geprueft = 0

    for pfad in sorted(ORDNER.glob("*.json")):
        d = json.loads(pfad.read_text(encoding="utf-8"))
        name = pfad.stem
        geprueft += 1

        von = (d.get("time") or {}).get("from", "")
        takt = sekunden(d.get("refresh"))
        mindest = MINDESTTAKT_S.get(von)
        if mindest is not None and takt is not None and takt < mindest:
            beanstandungen.append(
                f"{name}: Takt {d.get('refresh')} bei Zeitbereich {von} — "
                f"mindestens {mindest} s noetig")

        for p in d.get("panels", []):
            if p.get("type") in ZEITREIHEN and p.get("maxDataPoints") is None:
                beanstandungen.append(
                    f"{name}: Panel „{p.get('title')}" + "“ ohne maxDataPoints")

    if beanstandungen:
        print("Dashboards koennen die Datenbank ueberfahren:", file=sys.stderr)
        for b in beanstandungen:
            print(f"  - {b}", file=sys.stderr)
        print("\nHintergrund: tools/pruefe-dashboard-last.py, Kopf der Datei.",
              file=sys.stderr)
        return 1

    print(f"Dashboard-Last in Ordnung — {geprueft} Vorlagen geprueft.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
