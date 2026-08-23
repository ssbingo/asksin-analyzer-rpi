#!/usr/bin/env python3
"""
Prüft, dass kein Skript die Alarmregeln roh nach /etc/grafana kopiert.

## Anlass

Seit M14.3 lassen sich die vier Alarme in der Weboberfläche einzeln
abschalten. Geschaltet wird über `isPaused` in Grafanas Provisionierung —
also in **derselben Datei**, die `update.sh` und das Einrichtungsskript aus
dem Projekt kopieren.

Damit gibt es zwei Stellen, die dieselbe Datei schreiben. Kopiert eine davon
die Vorlage unverändert, gehen alle abgeschalteten Alarme wieder an — still,
ohne Meldung, und der Betreiber merkt es erst an der Meldung, die er
abbestellt hatte. Es sähe aus wie ein Fehler im Schalter, wäre aber einer im
Aktualisierungsskript.

Das ist der häufigste Fehlertyp dieses Projekts: Zwei Seiten, eine Annahme,
niemand meldet sich. Deshalb steht er hier als harte Prüfung.

## Was geprüft wird

1. Jede Zeile, die `asksin-alarme.yaml` nach `/etc/grafana` bzw. nach
   `$GRAFANA_PROV` bringt, muss über `core/bin/alarme-rendern.ts` gehen.
2. Der Renderer selbst ist vorhanden und ausführbar.
3. Der Root-Helfer und seine beiden Units liegen im Projekt.

Aufruf:
    python3 tools/pruefe-alarmschalter.py    # 0 = sauber, 1 = Fund
"""

from __future__ import annotations

import pathlib
import re
import sys

WURZEL = pathlib.Path(__file__).resolve().parent.parent
ZIELNAME = "asksin-alarme.yaml"
RENDERER = "core/bin/alarme-rendern.ts"

# Nur Skripte, die auf dem Gerät laufen. Die Prüfskripte in tools/ und die
# Tests dürfen den Dateinamen selbstverständlich nennen.
SKRIPTE = ["install.sh", "update.sh"] + [
    f"deploy/{p.name}" for p in sorted((WURZEL / "deploy").glob("*.sh"))
]

PFLICHTDATEIEN = [
    RENDERER,
    "core/src/langzeit/alarmschalter.ts",
    "deploy/alarmschalter-anwenden.sh",
    "deploy/asksin-analyzer-alarmschalter.path",
    "deploy/asksin-analyzer-alarmschalter.service",
]


def main() -> int:
    beanstandungen: list[str] = []
    geprueft = 0

    for name in SKRIPTE:
        datei = WURZEL / name
        if not datei.exists():
            continue
        for nr, zeile in enumerate(datei.read_text(encoding="utf-8").splitlines(), 1):
            nackt = zeile.strip()
            if nackt.startswith("#") or ZIELNAME not in nackt:
                continue
            geprueft += 1
            # Der Helfer kopiert die FERTIGE Datei aus dem Datenverzeichnis —
            # die ist bereits gerendert und darf hier durch.
            if "alarmschalter-anwenden" in name or "grafana-alarme.yaml" in nackt:
                continue
            # Ein `install`/`cp`/`sed` auf die Vorlage ist der Fund.
            if re.search(r"\b(install|cp|sed|rsync)\b", nackt) and RENDERER not in nackt:
                beanstandungen.append(
                    f"{name}:{nr}: kopiert {ZIELNAME} roh — das schaltet "
                    f"abgeschaltete Alarme wieder ein. Ueber {RENDERER} gehen.\n"
                    f"      {nackt}")

    for pflicht in PFLICHTDATEIEN:
        if not (WURZEL / pflicht).exists():
            beanstandungen.append(f"{pflicht} fehlt — die Schalter wirken dann nirgends.")

    if beanstandungen:
        print("Alarmschalter: gefundene Luecken", file=sys.stderr)
        for b in beanstandungen:
            print(f"  - {b}", file=sys.stderr)
        print("\nHintergrund: tools/pruefe-alarmschalter.py, Kopf der Datei.",
              file=sys.stderr)
        return 1

    print(f"Alarmschalter: Regeldatei geht ueberall durch den Renderer "
          f"({geprueft} Fundstellen, {len(PFLICHTDATEIEN)} Pflichtdateien).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
