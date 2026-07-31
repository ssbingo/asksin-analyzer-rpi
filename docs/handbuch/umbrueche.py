#!/usr/bin/env python3
"""
Setzt die Umbruchregeln des Handbuchs durch — inklusive der Regel, die sich in
CSS nicht ausdrücken lässt.

Die Regeln (Grundregel der Handbuchgestaltung):

  1. **Major-Kapitel** (1, 2, 3 …) beginnen immer auf einer neuen Seite.
  2. **Minor-Kapitel** (1.1, 5.3, 10.2 …) dürfen einer Seite folgen, aber
     **keines darf unterhalb der Seitenmitte beginnen** — sonst bekommt es
     eine eigene Seite. Das gilt auch für das erste Minor-Kapitel eines
     Major-Kapitels.
  3. „Über dieses Handbuch" und „Inhalt" beginnen immer auf einer eigenen
     Seite.

Regel 1 und 3 sind reines CSS. Regel 2 nicht: Wo eine Überschrift landet,
weiß man erst **nach** dem Satz. Deshalb arbeitet dieses Skript in Runden:

    HTML auszeichnen  →  PDF bauen  →  Lage aller Minor-Überschriften messen
    →  die unterhalb der Mitte auf „neue Seite" umstellen  →  von vorn

Markierungen werden nur **hinzugefügt**, nie zurückgenommen. Damit endet die
Schleife garantiert: Die Menge der markierten Überschriften wächst monoton und
ist endlich. Nach wenigen Runden ändert sich nichts mehr.

Aufruf:
    python3 umbrueche.py
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

HIER = Path(__file__).resolve().parent
HTML = HIER / "handbuch.html"
PDF = HIER / "AskSin-Analyzer-Handbuch.pdf"
MAX_RUNDEN = 12

# A4 in PostScript-Punkten; die Hälfte ist die Grenze aus Regel 2.
SEITE_HOEHE = 841.92
MITTE = SEITE_HOEHE / 2

H2 = re.compile(r'^<h2(?: class="[^"]*")?>(\d+\.\d+)')


def markiere(text: str, umbruch: set[str]) -> str:
    """Allen Minor-Überschriften aus `umbruch` die Klasse setzen, sonst keine."""
    zeilen = text.splitlines()
    for i, z in enumerate(zeilen):
        m = H2.match(z)
        if m is None:
            continue
        nummer = m.group(1)
        inhalt = z[z.index(">", z.index("<h2")) + 1:]
        zeilen[i] = (
            f'<h2 class="umbruch">{inhalt}' if nummer in umbruch else f"<h2>{inhalt}"
        )
    return "\n".join(zeilen) + "\n"


def alle_minor(text: str) -> list[str]:
    return [m.group(1) for z in text.splitlines() if (m := H2.match(z))]


def baue_pdf() -> None:
    subprocess.run(["./build.sh"], cwd=HIER, check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def lage_der_ueberschriften() -> dict[str, float]:
    """Y-Position jeder Minor-Überschrift in Punkten ab Seitenoberkante.

    Gezählt wird nur das **erste** Vorkommen einer Nummer: Dieselbe Zahl taucht
    auch im Inhaltsverzeichnis und in Querverweisen auf.
    """
    roh = subprocess.run(["pdftotext", "-bbox", str(PDF), "-"],
                         capture_output=True, text=True).stdout
    lage: dict[str, float] = {}
    im_inhalt = True
    for zeile in roh.splitlines():
        m = re.search(
            r'<word xMin="[\d.]+" yMin="([\d.]+)"[^>]*>([^<]*)</word>', zeile)
        if m is None:
            continue
        y, wort = float(m.group(1)), m.group(2)
        # Das Inhaltsverzeichnis endet mit dem ersten Kapitelanfang.
        if im_inhalt:
            if wort == "1.1":
                continue
            im_inhalt = False
        if re.fullmatch(r"\d{1,2}\.\d{1,2}", wort) and wort not in lage:
            lage[wort] = y
    return lage


def seitenzahl() -> str:
    aus = subprocess.run(["pdfinfo", str(PDF)], capture_output=True,
                         text=True).stdout
    m = re.search(r"Pages:\s+(\d+)", aus)
    return m.group(1) if m else "?"


def main() -> int:
    umbruch: set[str] = set()
    for runde in range(1, MAX_RUNDEN + 1):
        text = markiere(HTML.read_text(encoding="utf8"), umbruch)
        HTML.write_text(text, encoding="utf8")
        baue_pdf()

        lage = lage_der_ueberschriften()
        neu = {
            nr for nr in alle_minor(text)
            if nr not in umbruch and lage.get(nr, 0.0) > MITTE
        }
        if not neu:
            print(f"Runde {runde}: stabil — {seitenzahl()} Seiten, "
                  f"{len(umbruch)} Überschriften auf eigener Seite.")
            return 0

        print(f"Runde {runde}: {len(neu)} Überschriften beginnen unter der "
              f"Seitenmitte → eigene Seite: {', '.join(sorted(neu))}")
        umbruch |= neu

    print(f"Kein stabiler Satz nach {MAX_RUNDEN} Runden — bitte nachsehen.",
          file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
