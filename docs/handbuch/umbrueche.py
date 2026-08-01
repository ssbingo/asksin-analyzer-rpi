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

# Die Ueberschriften tragen inzwischen auch eine id (Sprungmarke fuers PDF).
# Das Muster muss beliebige Attribute vertragen — mit der frueheren, engeren
# Fassung fand das Skript gar keine Ueberschrift mehr und meldete trotzdem
# "stabil". Ein Suchmuster, das still nichts findet, ist schlimmer als eines,
# das scheitert: Deshalb prueft main() zusaetzlich, dass ueberhaupt welche
# gefunden wurden.
H2 = re.compile(r'^<h2([^>]*)>(\d+\.\d+)')
# Zwischenueberschriften tragen keine Nummer, dafuer eine Sprungmarke.
# Fuer sie gilt dieselbe Regel: Wer unterhalb der Seitenmitte anfaengt,
# reisst seinen Abschnitt gleich nach dem ersten Satz auseinander.
H3 = re.compile(r'^<h3([^>]*)>(.*?)</h3>')
ID = re.compile(r'\sid="([^"]*)"')


def markiere(text: str, umbruch: set[str]) -> str:
    """Allen Überschriften aus `umbruch` die Klasse setzen, sonst keine."""
    zeilen = text.splitlines()
    for i, z in enumerate(zeilen):
        m2 = H2.match(z)
        if m2 is not None:
            attribute, nummer = m2.group(1), m2.group(2)
            marke = ID.search(attribute)
            kennung = f' id="{marke.group(1)}"' if marke else ""
            klasse = ' class="umbruch"' if nummer in umbruch else ""
            zeilen[i] = f"<h2{klasse}{kennung}>{z[m2.end(1) + 1:]}"
            continue
        m3 = H3.match(z)
        if m3 is None:
            continue
        marke = ID.search(m3.group(1))
        if marke is None:
            continue                       # ohne Marke nicht ansprechbar
        klasse = ' class="umbruch"' if marke.group(1) in umbruch else ""
        zeilen[i] = f'<h3{klasse} id="{marke.group(1)}">{m3.group(2)}</h3>'
    return "\n".join(zeilen) + "\n"


def alle_minor(text: str) -> list[str]:
    """Alle ansprechbaren Überschriften in Dokumentreihenfolge.

    Minor-Kapitel über ihre Nummer, Zwischenüberschriften über ihre
    Sprungmarke — für die Regel sind beide gleich.
    """
    aus: list[str] = []
    for z in text.splitlines():
        if (m := H2.match(z)):
            aus.append(m.group(2))
        elif (m := H3.match(z)) and (marke := ID.search(m.group(1))):
            aus.append(marke.group(1))
    return aus


def h3_texte(text: str) -> dict[str, list[str]]:
    """Sprungmarke → Wortfolge der Überschrift, zum Wiederfinden im PDF."""
    aus: dict[str, list[str]] = {}
    for z in text.splitlines():
        m = H3.match(z)
        if m and (marke := ID.search(m.group(1))):
            roh = re.sub(r"<[^>]+>", "", m.group(2))
            aus[marke.group(1)] = roh.replace("\u00a0", " ").split()
    return aus


def baue_pdf() -> None:
    subprocess.run(["./build.sh"], cwd=HIER, check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def lage_der_ueberschriften() -> dict[str, float]:
    """Y-Position jeder ansprechbaren Überschrift, ab Seitenoberkante.

    Minor-Kapitel sind an ihrer Nummer zu erkennen. Zwischenüberschriften
    tragen keine — sie werden über ihre **Wortfolge** wiedergefunden, und zwar
    in Dokumentreihenfolge: Der Wortstrom des PDF läuft in derselben Ordnung
    wie die Datei. Eine Suche über das ganze Dokument würde bei Überschriften,
    deren Wortlaut auch im Fliesstext vorkommt, danebengreifen.

    Gezählt wird nur das **erste** Vorkommen: Nummern tauchen auch im
    Inhaltsverzeichnis und in Querverweisen auf.
    """
    roh = subprocess.run(["pdftotext", "-bbox", str(PDF), "-"],
                         capture_output=True, text=True).stdout
    strom: list[tuple[float, str]] = []
    for zeile in roh.splitlines():
        m = re.search(
            r'<word xMin="[\d.]+" yMin="([\d.]+)"[^>]*>([^<]*)</word>', zeile)
        if m:
            strom.append((float(m.group(1)), m.group(2)))

    lage: dict[str, float] = {}
    im_inhalt = True
    for y, wort in strom:
        if im_inhalt:
            if wort == "1.1":
                continue
            im_inhalt = False
        if re.fullmatch(r"\d{1,2}\.\d{1,2}", wort) and wort not in lage:
            lage[wort] = y

    # Zwischenueberschriften der Reihe nach im Wortstrom suchen.
    texte = h3_texte(HTML.read_text(encoding="utf8"))
    stelle = 0
    for kennung, woerter in texte.items():
        if not woerter:
            continue
        for i in range(stelle, len(strom) - len(woerter) + 1):
            if all(strom[i + k][1] == woerter[k] for k in range(len(woerter))):
                lage[kennung] = strom[i][0]
                stelle = i + len(woerter)
                break
    return lage


def seitenzahl() -> str:
    aus = subprocess.run(["pdfinfo", str(PDF)], capture_output=True,
                         text=True).stdout
    m = re.search(r"Pages:\s+(\d+)", aus)
    return m.group(1) if m else "?"


TABELLE = re.compile(r'^<tr><th>(.*?)</tr>')


def tabellenkoepfe(text: str) -> list[list[str]]:
    """Die Wortfolge jeder Tabellenkopfzeile, in Dokumentreihenfolge."""
    aus: list[list[str]] = []
    for z in text.splitlines():
        m = TABELLE.match(z)
        if m:
            roh = re.sub(r"<[^>]+>", " ", m.group(1))
            aus.append(roh.replace("\u00a0", " ").split())
    return aus


def verwaiste_koepfe() -> list[tuple[str, ...]]:
    """Welche Tabellenkopfzeilen stehen allein am Seitenfuss?

    Eine Kopfzeile ohne Tabelle darunter sagt gar nichts — der Leser blaettert
    um und muss sich merken, wie die Spalten hiessen. Der saubere CSS-Weg
    (`break-after: avoid` auf thead) wird von WeasyPrint in Tabellen nicht
    umgesetzt; deshalb wird im fertigen Satz nachgemessen.

    Gesucht wird SEITENWEISE, nicht der Reihe nach: Lange Tabellen wiederholen
    ihre Kopfzeile auf jeder Folgeseite, und ein fortlaufender Zeiger geriet
    dadurch aus dem Takt und uebersprang die naechsten Tabellen.

    Zurueck kommt die Wortfolge jeder betroffenen Kopfzeile.
    """
    roh = subprocess.run(["pdftotext", "-bbox", str(PDF), "-"],
                         capture_output=True, text=True).stdout
    seiten: dict[int, list[tuple[float, str]]] = {}
    seite = 0
    for zeile in roh.splitlines():
        if "<page" in zeile:
            seite += 1
            continue
        m = re.search(
            r'<word xMin="[\d.]+" yMin="([\d.]+)"[^>]*>([^<]*)</word>', zeile)
        if m:
            seiten.setdefault(seite, []).append((float(m.group(1)), m.group(2)))

    bekannt = {tuple(k) for k in tabellenkoepfe(HTML.read_text(encoding="utf8")) if k}
    betroffen: list[tuple[str, ...]] = []
    for woerter in seiten.values():
        # Der Fusssteg liegt unter dem Satzspiegel und zaehlt nicht mit.
        inhalt = [w for w in woerter if w[0] < 790]
        if not inhalt:
            continue
        unterste = max(y for y, _ in inhalt)
        letzte = tuple(t for y, t in inhalt if abs(y - unterste) < 2)
        if letzte in bekannt and letzte not in betroffen:
            betroffen.append(letzte)
    return betroffen


def markiere_tabellen(text: str, umbruch: set[tuple[str, ...]]) -> str:
    """Setzt die Klasse an allen Tabellen mit betroffener Kopfzeile.

    Angesprochen wird ueber die Wortfolge des Kopfes, nicht ueber eine
    laufende Nummer: Nummern verschieben sich, sobald jemand eine Tabelle
    ergaenzt, und dann traefe die Marke die falsche.
    """
    zeilen = text.splitlines()
    letzte_tabelle = -1
    for i, z in enumerate(zeilen):
        if z.startswith("<table"):
            letzte_tabelle = i
            continue
        m = TABELLE.match(z)
        if m is None or letzte_tabelle < 0:
            continue
        kopf = tuple(re.sub(r"<[^>]+>", " ", m.group(1)).replace("\u00a0", " ").split())
        zeilen[letzte_tabelle] = (
            '<table class="umbruch">' if kopf in umbruch else "<table>")
        letzte_tabelle = -1
    return "\n".join(zeilen) + "\n"


def behebe_tabellen() -> set[tuple[str, ...]]:
    """Schiebt Tabellen weiter, deren Kopfzeile allein am Seitenfuss steht."""
    marken: set[tuple[str, ...]] = set()
    for runde in range(1, 7):
        betroffen = [k for k in verwaiste_koepfe() if k not in marken]
        if not betroffen:
            break
        marken |= set(betroffen)
        for k in betroffen:
            print(f"  Kopfzeile „{' '.join(k)}“ stand allein am Seitenfuss "
                  f"→ Tabelle auf die naechste Seite")
        HTML.write_text(markiere_tabellen(HTML.read_text(encoding="utf8"), marken),
                        encoding="utf8")
        baue_pdf()
    return marken


def raeume_auf(umbruch: set[str]) -> set[str]:
    """Entfernt Marken, die sich im fertigen Satz als überflüssig erweisen.

    Der Aufbau in Runden hat einen eingebauten Nachteil: Eine Marke aus der
    ersten Runde verschiebt alles Folgende — und wird dadurch womöglich selbst
    überflüssig. Zurückgenommen wurde sie nie, weil die Schleife nur wächst.
    Das Ergebnis waren 23 Seiten unter 45 % Füllung; ganze Seiten mit drei
    Zeilen darauf sehen nach Nachlässigkeit aus, und das zu Recht.

    Hier wird deshalb jede Marke einmal versuchsweise entfernt. Hält die Regel
    danach immer noch, bleibt sie weg. Das kostet einen Satzlauf je Marke —
    einige Minuten —, aber es passiert nur beim Bauen des Handbuchs, nicht im
    Betrieb.

    Vorgegangen wird von hinten nach vorn: Eine Änderung wirkt sich nur auf
    das aus, was danach kommt. Wer vorne anfängt, verwirft mit jeder Entnahme
    die Arbeit an allem Folgenden.
    """
    # Nach Dokumentreihenfolge, von hinten: Eine Entnahme wirkt sich nur auf
    # das aus, was danach kommt. Nummern und Sprungmarken stehen gemischt in
    # der Menge — die Reihenfolge nimmt deshalb die aus dem Dokument.
    ordnung = alle_minor(HTML.read_text(encoding="utf8"))
    kandidaten = [n for n in reversed(ordnung) if n in umbruch]
    entfernt = 0
    for nr in kandidaten:
        versuch = umbruch - {nr}
        HTML.write_text(markiere(HTML.read_text(encoding="utf8"), versuch), encoding="utf8")
        baue_pdf()
        lage = lage_der_ueberschriften()
        # Haelt die Regel fuer ALLE, nicht nur fuer die entfernte?
        if all(lage.get(x, 0.0) <= MITTE for x in alle_minor(HTML.read_text(encoding="utf8"))
               if x not in versuch):
            umbruch = versuch
            entfernt += 1
            print(f"  {nr} braucht keine eigene Seite mehr")
        else:
            HTML.write_text(markiere(HTML.read_text(encoding="utf8"), umbruch), encoding="utf8")
    print(f"Aufräumen: {entfernt} von {len(kandidaten)} Marken entfernt.")
    return umbruch


def main() -> int:
    umbruch: set[str] = set()
    gefunden = alle_minor(HTML.read_text(encoding="utf8"))
    if not gefunden:
        print("Keine Minor-Ueberschrift gefunden — passt das Suchmuster noch "
              "zum HTML? (Abbruch statt stiller Erfolgsmeldung.)",
              file=sys.stderr)
        return 1
    print(f"{len(gefunden)} Minor-Ueberschriften gefunden.")

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
            if "--schnell" not in sys.argv:
                umbruch = raeume_auf(umbruch)
                HTML.write_text(markiere(HTML.read_text(encoding="utf8"), umbruch),
                                encoding="utf8")
                baue_pdf()
            # Zum Schluss die Tabellen: Das Aufraeumen verschiebt den Satz, und
            # eine vorher behobene Kopfzeile koennte danach wieder verwaisen.
            marken = behebe_tabellen()
            if marken:
                print(f"{len(marken)} Tabelle(n) auf die Folgeseite geschoben.")
                print(f"Fertig — {seitenzahl()} Seiten, {len(umbruch)} "
                      f"Überschriften auf eigener Seite.")
            return 0

        print(f"Runde {runde}: {len(neu)} Überschriften beginnen unter der "
              f"Seitenmitte → eigene Seite: {', '.join(sorted(neu))}")
        umbruch |= neu

    print(f"Kein stabiler Satz nach {MAX_RUNDEN} Runden — bitte nachsehen.",
          file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
