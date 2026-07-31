#!/usr/bin/env python3
"""
Setzt die Umbruchregeln des Handbuchs durch — inklusive der einen Regel, die
sich in CSS nicht ausdrücken lässt.

Die Regeln (Grundregel der Handbuchgestaltung):

  1. **Major-Kapitel** (1, 2, 3 …) beginnen immer auf einer neuen Seite.
  2. **Minor-Kapitel** (1.1, 5.3, 10.2 …) beginnen immer auf einer neuen Seite.
  3. **Ausnahme:** Das *erste* Minor-Kapitel eines Major-Kapitels (10.1 zu 10)
     beginnt auf derselben Seite wie sein Major-Kapitel — **solange es in der
     oberen Hälfte der Seite beginnt**.
  4. „Über dieses Handbuch" und „Inhalt" beginnen immer auf einer eigenen Seite.

Regel 1, 2 und 4 sind reines CSS. Regel 3 nicht: Ob eine Überschrift in der
oberen Seitenhälfte landet, weiß man erst **nach** dem Satz. Deshalb arbeitet
dieses Skript in Runden:

    HTML auszeichnen  →  PDF bauen  →  Lage der ersten Minor-Überschriften
    messen  →  die zu tief gerutschten auf „neue Seite" umstellen  →  von vorn

Nach wenigen Runden ändert sich nichts mehr; dann ist der Satz stabil.

Aufruf:
    python3 umbrueche.py            # markieren, bauen, messen, wiederholen
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

HIER = Path(__file__).resolve().parent
HTML = HIER / "handbuch.html"
PDF = HIER / "AskSin-Analyzer-Handbuch.pdf"
MAX_RUNDEN = 6

# A4 in PostScript-Punkten; die Hälfte ist die Grenze aus Regel 3.
SEITE_HOEHE = 841.92


def markiere_erste_minor(text: str) -> str:
    """Dem ersten <h2> nach jedem Major-Kapitel die Klasse `erste` geben.

    Die Klasse allein bewirkt noch nichts — sie hebt nur den Seitenumbruch aus
    Regel 2 auf. Ob das bestehen bleibt, entscheidet die Messung.
    """
    zeilen = text.splitlines()
    erwarte_erste = False
    for i, z in enumerate(zeilen):
        if '<h1 class="kapitel"' in z:
            erwarte_erste = True
            continue
        m = re.match(r"^<h2(?: class=\"[^\"]*\")?>", z)
        if m is None:
            continue
        rest = z[m.end():]
        if erwarte_erste:
            # Vorhandene Entscheidung aus einer früheren Runde bewahren.
            umbruch = 'umbruch' in m.group(0)
            klasse = "erste umbruch" if umbruch else "erste"
            zeilen[i] = f'<h2 class="{klasse}">{rest}'
            erwarte_erste = False
        else:
            zeilen[i] = f"<h2>{rest}"
    return "\n".join(zeilen) + "\n"


def baue_pdf() -> None:
    subprocess.run(["./build.sh"], cwd=HIER, check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def ueberschriften_lage() -> dict[str, float]:
    """Y-Position jeder Überschrift „N.M …" in Punkten ab Seitenoberkante."""
    roh = subprocess.run(["pdftotext", "-bbox", str(PDF), "-"],
                         capture_output=True, text=True).stdout
    lage: dict[str, float] = {}
    aktuelle_woerter: list[tuple[str, float]] = []
    for zeile in roh.splitlines():
        if "<page" in zeile:
            aktuelle_woerter = []
        m = re.search(r'<word xMin="[\d.]+" yMin="([\d.]+)"[^>]*>([^<]*)</word>', zeile)
        if m is None:
            continue
        y, wort = float(m.group(1)), m.group(2)
        aktuelle_woerter.append((wort, y))
        # Überschriften beginnen mit „12.3"
        if re.fullmatch(r"\d+\.\d+", wort) and wort not in lage:
            lage[wort] = y
    return lage


def erste_minor_nummern(text: str) -> list[str]:
    """Nummern der als `erste` markierten Minor-Überschriften."""
    return re.findall(r'<h2 class="erste[^"]*">(\d+\.\d+)', text)


def main() -> int:
    for runde in range(1, MAX_RUNDEN + 1):
        text = markiere_erste_minor(HTML.read_text(encoding="utf8"))
        HTML.write_text(text, encoding="utf8")
        baue_pdf()

        lage = ueberschriften_lage()
        grenze = SEITE_HOEHE / 2
        zu_tief = [
            nr for nr in erste_minor_nummern(text)
            if nr in lage and lage[nr] > grenze
        ]
        if not zu_tief:
            seiten = subprocess.run(["pdfinfo", str(PDF)], capture_output=True,
                                    text=True).stdout
            n = re.search(r"Pages:\s+(\d+)", seiten)
            print(f"Runde {runde}: stabil — {n.group(1) if n else '?'} Seiten.")
            return 0

        print(f"Runde {runde}: {len(zu_tief)} erste Minor-Überschriften stehen "
              f"in der unteren Seitenhälfte → eigene Seite: {', '.join(zu_tief)}")
        for nr in zu_tief:
            text = re.sub(
                rf'<h2 class="erste">({re.escape(nr)} )',
                r'<h2 class="erste umbruch">\1',
                text,
            )
        HTML.write_text(text, encoding="utf8")

    print("Kein stabiler Satz nach "
          f"{MAX_RUNDEN} Runden — bitte von Hand nachsehen.", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
