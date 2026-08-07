#!/usr/bin/env python3
"""
Prüft die Kapitelnummerierung des Handbuchs — hart, mit Abbruch.

Anlass: In Kapitel 14 trugen die Abschnitte die Nummern 23.1 und 23.2, im
Anhang (24) hiessen sie 23.3 und 23.4. Beides sah im Fliesstext nur schief
aus, war aber schlimmer: Die Sprungmarken (`id="k23-1"`) gab es dadurch
doppelt, und der Verweis aus dem Inhaltsverzeichnis landete im falschen
Kapitel — Browser springen zur **ersten** passenden Marke.

Geprüft wird:

  1. Jede Abschnittsnummer beginnt mit der Nummer ihres Kapitels.
  2. Abschnitte sind innerhalb ihres Kapitels lückenlos von 1 an durchnummeriert.
  3. Jede Sprungmarke kommt genau einmal vor.
  4. Die Sprungmarke passt zur Nummer (23.1 → k23-1).
  5. Jeder Verweis im Dokument zeigt auf eine Marke, die es gibt.

Aufruf:
    python3 pruefe_nummerierung.py        # 0 = in Ordnung, 1 = Fehler
"""

from __future__ import annotations

import re
import sys
from collections import Counter
from pathlib import Path

HTML = Path(__file__).resolve().parent / "handbuch.html"

H1 = re.compile(r'<h1[^>]*\bid="([^"]*)"[^>]*>.*?<span class="knr">(\d+)</span>([^<]*)')
H2 = re.compile(r'<h2([^>]*)>(\d+)\.(\d+)\s*([^<]*)')
ID = re.compile(r'\sid="([^"]*)"')
OHNE_NUMMER = re.compile(r'<h2[^>]*>(?!\s*\d+\.\d)([^<]+)')
VERWEIS = re.compile(r'href="#([^"]+)"')


OHNE_TAGS = re.compile(r"<[^>]*>")


def main() -> int:
    text = HTML.read_text(encoding="utf8")
    fehler: list[str] = []

    kapitel = "?"           # Nummer des zuletzt gesehenen Major-Kapitels
    kapitelname = ""
    erwartet = 1            # naechste Abschnittsnummer in diesem Kapitel
    marken: list[str] = []

    for nr, zeile in enumerate(text.splitlines(), 1):
        m1 = H1.search(zeile)
        if m1:
            marken.append(m1.group(1))
            kapitel, kapitelname = m1.group(2), m1.group(3).strip()
            erwartet = 1
            continue

        # Eine Ueberschrift OHNE Nummer faellt durch jedes Raster: Sie wird
        # weder hier geprueft noch von umbrueche.py umbrochen. Genau so kam
        # "Eine Telegrammzeile lesen" mitten auf einer Seite zu liegen und
        # riss ihren Abschnitt auseinander. Deshalb ist eine unnummerierte
        # Unterueberschrift jetzt selbst ein Fehler.
        roh = OHNE_NUMMER.search(zeile)
        if roh is not None:
            fehler.append(
                f"Zeile {nr}: „{roh.group(1).strip()}“ ist ein Unterkapitel "
                f"ohne Nummer — es faellt damit aus der Umbruchregel heraus. "
                f"Erwartet: {kapitel}.{erwartet}")
            continue

        m2 = H2.search(zeile)
        if m2 is None:
            continue
        attribute, haupt, unter, titel = m2.groups()
        marke = ID.search(attribute)
        if marke:
            marken.append(marke.group(1))

        # Regel 1: Kapitelnummer muss stimmen.
        if haupt != kapitel:
            fehler.append(
                f"Zeile {nr}: „{haupt}.{unter} {titel.strip()}“ steht in "
                f"Kapitel {kapitel} ({kapitelname}) — erwartet "
                f"{kapitel}.{erwartet}")
        # Regel 2: lueckenlos ab 1.
        elif int(unter) != erwartet:
            fehler.append(
                f"Zeile {nr}: „{haupt}.{unter} {titel.strip()}“ — erwartet "
                f"{kapitel}.{erwartet} (Luecke oder Doppelung)")
        erwartet = int(unter) + 1 if haupt == kapitel else erwartet + 1

        # Regel 4: Marke passt zur Nummer.
        soll = f"k{haupt}-{unter}"
        if marke and marke.group(1) != soll:
            fehler.append(
                f"Zeile {nr}: Sprungmarke „{marke.group(1)}“ passt nicht zu "
                f"{haupt}.{unter} — erwartet „{soll}“")

    # Regel 3: keine Marke doppelt.
    for marke, wie_oft in Counter(marken).items():
        if wie_oft > 1:
            fehler.append(
                f"Sprungmarke „{marke}“ kommt {wie_oft}-mal vor — Verweise "
                f"darauf landen immer beim ersten Vorkommen")

    # Regel 5: kein Verweis ins Leere.
    vorhanden = set(marken) | set(ID.findall(text))
    for ziel in sorted(set(VERWEIS.findall(text))):
        if ziel not in vorhanden:
            fehler.append(f"Verweis auf „#{ziel}“ — diese Marke gibt es nicht")

    # Regel 6: Verweise im FLIESSTEXT müssen es auch geben.
    #
    # Anlass (04.08.2026): Beim Einschieben von Abschnitt 7.2 wurden die
    # folgenden hochgezählt. Die Sprungmarken zog ein Skript sauber nach —
    # der Satz „springt direkt zu 7.4" blieb aber stehen und zeigte danach
    # auf den falschen Abschnitt. Regel 5 bemerkt das nicht: Dort steht keine
    # Marke, nur eine Zahl im Text.
    #
    # Genau diese Verweise sind die, denen ein Anfänger folgt.
    nummern = set()
    for ueber in re.finditer(
            r'<h[123][^>]*>(?:<span class="knr">(\d+)</span>)?\s*([\d.]+)?',
            text):
        if ueber.group(1):
            nummern.add(ueber.group(1))
        if ueber.group(2):
            nummern.add(ueber.group(2).rstrip("."))

    for treffer in re.finditer(
            r"(?:Kapitel|Abschnitt|siehe|springt direkt zu)\s+(\d{1,2}\.\d{1,2})",
            OHNE_TAGS.sub(" ", text)):
        ziel = treffer.group(1)
        if ziel not in nummern:
            fehler.append(
                f"Verweis auf Abschnitt {ziel} im Fließtext — den gibt es "
                f"nicht (Umnummerierung vergessen?)")

    if fehler:
        print(f"{len(fehler)} Problem(e) in der Nummerierung:", file=sys.stderr)
        for f in fehler:
            print(f"  - {f}", file=sys.stderr)
        return 1

    print(f"Nummerierung in Ordnung — {len(marken)} Sprungmarken, alle "
          f"eindeutig, alle Verweise gehen ins Ziel.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
