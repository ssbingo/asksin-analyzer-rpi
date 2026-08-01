#!/usr/bin/env python3
"""
Prüft, dass der Fußsteg auf keiner Seite Text verdeckt.

Anlass: Über mehrere Ausgaben hinweg saß der Fußsteg **im** Satzspiegel statt
im Seitenrand — Chromium setzt fest positionierte Elemente zwingend dorthin.
Text lief darunter durch und wurde verdeckt. Das fällt beim Bauen nicht auf,
sondern erst beim Lesen, und dann sieht das Handbuch laienhaft aus.

Seit der Umstellung auf WeasyPrint liegt der Steg im Seitenrand. Diese Prüfung
hält das fest: Sie misst in der fertigen PDF-Datei, wo der Steg sitzt und wie
tief der Text reicht, und schlägt fehl, sobald sich beides nähert.

Geprüft wird:

  1. Der Fußsteg liegt auf jeder Seite an derselben Höhe (er ist ja fest).
  2. Zwischen dem tiefsten Text und der Oberkante des Stegs bleibt Abstand.
  3. Der Steg sitzt weit unten — nicht mitten auf der Seite.

Aufruf:
    python3 pruefe_fusssteg.py        # 0 = sauber, 1 = Überlappung
"""

from __future__ import annotations

import re
import subprocess
import sys
from collections import defaultdict
from pathlib import Path

HIER = Path(__file__).resolve().parent
PDF = HIER / "AskSin-Analyzer-Handbuch.pdf"

SEITE_HOEHE = 841.89          # A4 in Punkten
MINDESTABSTAND = 6.0          # pt zwischen Text und Steg — rund 2 mm
STEG_MINDESTTIEFE = 0.88      # der Steg muss unterhalb von 88 % der Seite sitzen

# Woran der Fußsteg zu erkennen ist. Diese Wörter stehen dort und sonst
# nirgends in dieser Zusammenstellung.
STEG_WORT = "Inhaltsverzeichnis"

WORT = re.compile(
    r'<word xMin="[\d.]+" yMin="([\d.]+)" xMax="[\d.]+" yMax="([\d.]+)">([^<]*)</word>'
)


def lies_seiten() -> dict[int, list[tuple[float, float, str]]]:
    roh = subprocess.run(
        ["pdftotext", "-bbox", str(PDF), "-"], capture_output=True, text=True
    ).stdout
    seiten: dict[int, list[tuple[float, float, str]]] = defaultdict(list)
    seite = 0
    for zeile in roh.splitlines():
        if "<page" in zeile:
            seite += 1
            continue
        m = WORT.search(zeile)
        if m:
            seiten[seite].append((float(m.group(1)), float(m.group(2)), m.group(3)))
    return seiten


def main() -> int:
    if not PDF.exists():
        print(f"{PDF} fehlt — erst ./build.sh laufen lassen.", file=sys.stderr)
        return 1

    seiten = lies_seiten()
    fehler: list[str] = []
    stegkanten: set[float] = set()

    for nr in sorted(seiten):
        woerter = seiten[nr]
        steg = [w for w in woerter if w[2] == STEG_WORT and w[0] > SEITE_HOEHE * 0.7]
        if not steg:
            # Deckblatt und Inhaltsverzeichnis tragen bewusst keinen Steg.
            continue
        stegoben = min(y0 for y0, _, _ in steg)
        stegunten = max(y1 for _, y1, _ in steg)
        stegkanten.add(round(stegoben, 1))

        if stegunten < SEITE_HOEHE * STEG_MINDESTTIEFE:
            fehler.append(
                f"Seite {nr}: Der Steg endet bei y={stegunten:.1f} und sitzt damit "
                f"zu hoch — erwartet unterhalb von "
                f"{SEITE_HOEHE * STEG_MINDESTTIEFE:.0f} pt."
            )

        # Der tiefste Text, der NICHT zum Steg gehört.
        inhalt = [w for w in woerter if w[0] < stegoben - 1]
        if not inhalt:
            continue
        tiefster = max(inhalt, key=lambda w: w[1])
        abstand = stegoben - tiefster[1]
        if abstand < MINDESTABSTAND:
            fehler.append(
                f"Seite {nr}: Text reicht bis y={tiefster[1]:.1f}, der Steg beginnt "
                f"bei y={stegoben:.1f} — nur {abstand:.1f} pt Abstand "
                f"(nötig: {MINDESTABSTAND}). Zuletzt: „{tiefster[2]}“"
            )

    if len(stegkanten) > 1:
        fehler.append(
            f"Der Steg sitzt nicht überall gleich hoch: {sorted(stegkanten)} — "
            f"ein fest positioniertes Element sollte das aber."
        )

    if fehler:
        print(f"{len(fehler)} Problem(e) am Fußsteg:", file=sys.stderr)
        for f in fehler[:20]:
            print(f"  - {f}", file=sys.stderr)
        if len(fehler) > 20:
            print(f"  … und {len(fehler) - 20} weitere", file=sys.stderr)
        return 1

    kante = stegkanten.pop() if stegkanten else 0.0
    print(
        f"Fußsteg in Ordnung — auf allen Seiten bei y={kante:.1f}, "
        f"{SEITE_HOEHE - kante:.0f} pt über der Blattkante, kein Text darunter."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
