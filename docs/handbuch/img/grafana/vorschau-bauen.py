#!/usr/bin/env python3
"""
Zeichnet schematische Vorschauen der neun Grafana-Ansichten.

Warum gezeichnet und nicht abfotografiert: Ein echter Bildschirmabzug aus
Grafana zeigt die Namen der Homematic-Geräte im Haus — und dieses Repo ist
öffentlich. Die Bilder wären also entweder unbrauchbar geschwärzt oder eine
Datenschutzpanne. Eine Zeichnung zeigt genau das, was der Leser braucht:
**wo was steht**, mit Nummern, auf die der Text zeigen kann.

Die Werte darin sind erfunden, aber plausibel — ein Duty-Cycle von 91 % und
ein RSSI von −93 dBm sehen so aus, wie es im Betrieb wirklich aussieht.

Aufruf:
    python3 vorschau-bauen.py     # schreibt *.svg neben dieses Skript
"""

from __future__ import annotations

import math
from pathlib import Path

HIER = Path(__file__).resolve().parent

# Farben aus dem Handbuch, damit die Bilder nicht wie Fremdkörper wirken.
GRUND = "#1f2529"
PANEL = "#272e33"
RAHMEN = "#3a4348"
TEXT = "#d6dde1"
MATT = "#8d999f"
PETROL = "#2b7a8c"
GRUEN = "#4a9d5f"
GELB = "#c9922e"
ROT = "#b8503f"

BREITE, HOEHE = 1000, 620
KOPF = 46


def kopf(titel: str) -> str:
    return (
        f'<rect width="{BREITE}" height="{HOEHE}" fill="{GRUND}"/>'
        f'<rect width="{BREITE}" height="{KOPF}" fill="{PANEL}"/>'
        f'<circle cx="24" cy="{KOPF//2}" r="9" fill="{PETROL}"/>'
        f'<text x="44" y="{KOPF//2+5}" font-family="DejaVu Sans, sans-serif" '
        f'font-size="15" fill="{TEXT}" font-weight="bold">{titel}</text>'
        f'<text x="{BREITE-16}" y="{KOPF//2+5}" text-anchor="end" '
        f'font-family="DejaVu Sans, sans-serif" font-size="12" fill="{MATT}">'
        f'letzte 24 Stunden</text>'
    )


def marke(n: int, x: float, y: float) -> str:
    """Nummernkreis, auf den der Handbuchtext zeigt."""
    return (
        f'<circle cx="{x}" cy="{y}" r="12" fill="{PETROL}"/>'
        f'<text x="{x}" y="{y+5}" text-anchor="middle" font-size="13" '
        f'font-weight="bold" fill="#ffffff" '
        f'font-family="DejaVu Sans, sans-serif">{n}</text>'
    )


def rahmen(x: float, y: float, w: float, h: float, titel: str, nr: int) -> str:
    return (
        f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="6" fill="{PANEL}" '
        f'stroke="{RAHMEN}"/>'
        f'<text x="{x+14}" y="{y+22}" font-family="DejaVu Sans, sans-serif" '
        f'font-size="13" fill="{TEXT}">{titel}</text>'
        + marke(nr, x + w - 20, y + 18)
    )


def kurve(x: float, y: float, w: float, h: float, saat: int,
          farbe: str = PETROL, fuellung: bool = True) -> str:
    """Eine plausibel zappelnde Linie — deterministisch aus der Saat."""
    punkte = []
    n = 40
    for i in range(n + 1):
        t = i / n
        wert = (
            math.sin(t * 6 + saat) * 0.22
            + math.sin(t * 17 + saat * 2) * 0.10
            + math.sin(t * 3.3 + saat * 0.7) * 0.16
        )
        punkte.append((x + t * w, y + h * (0.5 - wert)))
    linie = " ".join(f"{px:.1f},{py:.1f}" for px, py in punkte)
    aus = ""
    if fuellung:
        flaeche = f"{x},{y+h} " + linie + f" {x+w},{y+h}"
        aus += f'<polygon points="{flaeche}" fill="{farbe}" opacity="0.16"/>'
    aus += f'<polyline points="{linie}" fill="none" stroke="{farbe}" stroke-width="2"/>'
    return aus


def kennzahl(x: float, y: float, w: float, h: float, titel: str, wert: str,
             farbe: str, nr: int) -> str:
    return (
        rahmen(x, y, w, h, titel, nr)
        + f'<text x="{x+w/2}" y="{y+h/2+18}" text-anchor="middle" '
        f'font-family="DejaVu Sans, sans-serif" font-size="30" '
        f'font-weight="bold" fill="{farbe}">{wert}</text>'
    )


def band(x: float, y: float, w: float, h: float, muster: list[tuple[float, str]]) -> str:
    """Zustandsband: farbige Abschnitte nebeneinander."""
    aus, cx = "", x
    for anteil, farbe in muster:
        bw = w * anteil
        aus += f'<rect x="{cx:.1f}" y="{y}" width="{bw:.1f}" height="{h}" fill="{farbe}"/>'
        cx += bw
    return aus


def zeilen(x: float, y: float, w: float, eintraege: list[tuple[str, str, str]]) -> str:
    """Tabellenzeilen: Name, Wert, Farbe des Wertfeldes."""
    aus = ""
    for i, (name, wert, farbe) in enumerate(eintraege):
        zy = y + i * 26
        aus += (
            f'<rect x="{x}" y="{zy}" width="{w}" height="22" rx="3" '
            f'fill="{GRUND}" opacity="0.5"/>'
            f'<text x="{x+10}" y="{zy+16}" font-family="DejaVu Sans, sans-serif" '
            f'font-size="12" fill="{TEXT}">{name}</text>'
            f'<rect x="{x+w-92}" y="{zy+3}" width="82" height="16" rx="3" fill="{farbe}"/>'
            f'<text x="{x+w-51}" y="{zy+16}" text-anchor="middle" '
            f'font-family="DejaVu Sans, sans-serif" font-size="11" '
            f'fill="#ffffff">{wert}</text>'
        )
    return aus


def schreibe(name: str, inhalt: str) -> None:
    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{BREITE}" '
        f'height="{HOEHE}" viewBox="0 0 {BREITE} {HOEHE}">{inhalt}</svg>\n'
    )
    (HIER / f"{name}.svg").write_text(svg, encoding="utf8")
    print(f"  {name}.svg")


# ----------------------------------------------------------------- Ansichten

def leitstand() -> None:
    i = kopf("AskSin — Leitstand")
    i += kennzahl(16, 60, 236, 92, "Analyzer online", "4", GRUEN, 1)
    i += kennzahl(260, 60, 236, 92, "Telegramme pro Minute", "138", TEXT, 2)
    i += kennzahl(504, 60, 236, 92, "Bekannte Geräte", "63", TEXT, 3)
    i += kennzahl(748, 60, 236, 92, "Höchster Duty-Cycle", "91 %", ROT, 4)

    i += rahmen(16, 164, 968, 140, "Verbindung je Standort", 5)
    for k, (name, muster) in enumerate([
        ("Büro Keller", [(1.0, GRUEN)]),
        ("Gartenhaus", [(0.42, GRUEN), (0.06, ROT), (0.52, GRUEN)]),
        ("Dachboden", [(1.0, GRUEN)]),
        ("Kellertreppe", [(0.78, GRUEN), (0.22, ROT)]),
    ]):
        y = 196 + k * 26
        i += (f'<text x="30" y="{y+13}" font-family="DejaVu Sans, sans-serif" '
              f'font-size="11" fill="{MATT}">{name}</text>')
        i += band(150, y, 818, 18, muster)

    i += rahmen(16, 316, 476, 148, "Telegramme pro Minute", 6)
    for k in range(4):
        i += kurve(32, 348, 444, 100, k * 2, [PETROL, GRUEN, GELB, "#7f6bb5"][k], k == 0)
    i += rahmen(508, 316, 476, 148, "Grundrauschen", 7)
    for k in range(2):
        i += kurve(524, 348, 444, 100, 5 + k * 3, [PETROL, GELB][k], k == 0)

    i += rahmen(16, 476, 968, 128, "Bekannte Geräte", 8)
    i += kurve(32, 508, 936, 84, 9, GRUEN)
    schreibe("leitstand", i)


def funkqualitaet() -> None:
    i = kopf("AskSin — Funkqualität (Auswahl)")
    # Die Auswahlfelder sind der eigentliche Unterschied zur alten Fassung:
    # Vorgabe sind die schwaechsten Geraete, nicht alle zweihundert.
    i += (f'<rect x="16" y="52" width="300" height="26" rx="5" fill="{PANEL}" '
          f'stroke="{RAHMEN}"/>'
          f'<text x="28" y="70" font-family="DejaVu Sans, sans-serif" font-size="12" '
          f'fill="{MATT}">Geräte:</text>'
          f'<text x="86" y="70" font-family="DejaVu Sans, sans-serif" font-size="12" '
          f'fill="{TEXT}">die 20 schwächsten ▾</text>')
    i += marke(1, 300, 65)
    i += rahmen(16, 88, 968, 212, "Empfangsstärke je Gerät (dBm)", 2)
    for k in range(6):
        i += kurve(32, 124, 936, 152, k * 1.7,
                   [PETROL, GRUEN, GELB, "#7f6bb5", "#c07a4e", "#4e9bc0"][k], False)
    i += (f'<line x1="32" y1="240" x2="968" y2="240" stroke="{ROT}" '
          f'stroke-width="1.5" stroke-dasharray="6 4"/>'
          f'<text x="960" y="235" text-anchor="end" font-size="11" fill="{ROT}" '
          f'font-family="DejaVu Sans, sans-serif">−95 dBm — darunter unzuverlässig</text>')

    i += rahmen(16, 312, 476, 292, "Die schwächsten Empfänge", 3)
    i += zeilen(32, 348, 444, [
        ("Fenster_Gartenhaus_Nord", "−98 dBm", ROT),
        ("Bewegung_Carport", "−96 dBm", ROT),
        ("Temperatur_Dachboden", "−93 dBm", GELB),
        ("Rauchmelder_Flur_OG", "−88 dBm", GELB),
        ("Heizung_Bad", "−74 dBm", GRUEN),
        ("Fenster_Küche", "−61 dBm", GRUEN),
        ("Schalter_Wohnzimmer", "−58 dBm", GRUEN),
    ])
    i += rahmen(508, 312, 476, 292, "Schwankung der Empfangsstärke", 4)
    for k in range(3):
        i += kurve(524, 356, 444, 220, 3 + k * 2.5, [PETROL, GELB, GRUEN][k], k == 0)
    schreibe("funkqualitaet", i)


def funkqualitaet_standorte() -> None:
    """Dieselben Messwerte, aber je Standort verdichtet — drei Linien statt
    zweihundert. Beantwortet die Frage, die man zuerst stellt: Wo im Haus ist
    der Empfang gut?"""
    i = kopf("AskSin — Funkqualität je Standort")
    i += rahmen(16, 60, 968, 268, "Mittlere Empfangsstärke je Standort (dBm)", 1)
    for k in range(3):
        i += kurve(32, 96, 936, 212, 1 + k * 3.1, [PETROL, GRUEN, GELB][k], k == 0)
    i += (f'<text x="960" y="112" text-anchor="end" font-size="11" fill="{MATT}" '
          f'font-family="DejaVu Sans, sans-serif">Keller · Dachboden · Gartenhaus</text>')

    i += rahmen(16, 340, 476, 264, "Schwächster Empfang je Standort", 2)
    for k in range(3):
        i += kurve(32, 376, 444, 200, 7 + k * 2.2, [PETROL, GRUEN, GELB][k], False)
    i += rahmen(508, 340, 476, 264, "Schwankung je Standort", 3)
    for k in range(3):
        i += kurve(524, 376, 444, 200, 11 + k * 1.9, [PETROL, GRUEN, GELB][k], False)
    schreibe("funkqualitaet-standorte", i)


def dutycycle() -> None:
    i = kopf("AskSin — Duty-Cycle-Wächter")
    i += kennzahl(16, 60, 316, 92, "Geräte über der Schwelle", "1", ROT, 1)
    i += kennzahl(340, 60, 316, 92, "Höchster Duty-Cycle", "91 %", ROT, 2)
    i += kennzahl(664, 60, 320, 92, "Spitzenwert im Zeitraum", "97 %", ROT, 3)

    i += rahmen(16, 164, 968, 236, "Duty-Cycle je Gerät (%)", 4)
    i += (f'<line x1="32" y1="232" x2="968" y2="232" stroke="{ROT}" stroke-width="1.5" '
          f'stroke-dasharray="6 4"/>'
          f'<text x="960" y="227" text-anchor="end" font-size="11" fill="{ROT}" '
          f'font-family="DejaVu Sans, sans-serif">100 % — Sendeverbot</text>'
          f'<line x1="32" y1="268" x2="968" y2="268" stroke="{GELB}" stroke-width="1.5" '
          f'stroke-dasharray="6 4"/>'
          f'<text x="960" y="263" text-anchor="end" font-size="11" fill="{GELB}" '
          f'font-family="DejaVu Sans, sans-serif">80 % — wird eng</text>')
    i += kurve(32, 200, 936, 90, 1, ROT)
    for k in range(3):
        i += kurve(32, 320, 936, 60, 4 + k * 2, [GRUEN, PETROL, "#7f6bb5"][k], False)

    i += rahmen(16, 412, 968, 192, "Die lautesten Geräte", 5)
    i += zeilen(32, 448, 936, [
        ("Defekt_BWM Carport (klemmt)", "91 %", ROT),
        ("Wetterstation_Garten", "34 %", GELB),
        ("Heizung_Wohnzimmer", "8 %", GRUEN),
        ("Fenster_Küche", "2 %", GRUEN),
        ("Temperatur_Wäschekeller", "0.4 %", GRUEN),
    ])
    schreibe("dutycycle", i)


def geraetedetail() -> None:
    i = kopf("AskSin — Gerätedetail")
    i += (f'<rect x="16" y="60" width="300" height="34" rx="5" fill="{PANEL}" '
          f'stroke="{PETROL}" stroke-width="2"/>'
          f'<text x="30" y="82" font-family="DejaVu Sans, sans-serif" font-size="13" '
          f'fill="{TEXT}">Gerät: Fenster_Gartenhaus_Nord  ▾</text>')
    i += marke(1, 330, 77)

    i += kennzahl(16, 108, 316, 88, "Zuletzt gehört vor", "4 min", GRUEN, 2)
    i += kennzahl(340, 108, 316, 88, "Duty-Cycle", "1,2 %", GRUEN, 3)
    i += kennzahl(664, 108, 320, 88, "Empfangsstärke", "−93 dBm", GELB, 4)

    i += rahmen(16, 208, 968, 200, "Empfangsstärke je Standort (dBm)", 5)
    for k, farbe in enumerate([PETROL, GRUEN, GELB, "#7f6bb5"]):
        i += kurve(32, 244, 936, 148, 2 + k * 3, farbe, k == 0)
    for k, (name, farbe) in enumerate([
        ("Büro Keller", PETROL), ("Gartenhaus", GRUEN),
        ("Dachboden", GELB), ("Kellertreppe", "#7f6bb5"),
    ]):
        x = 40 + k * 170
        i += (f'<rect x="{x}" y="386" width="10" height="10" rx="2" fill="{farbe}"/>'
              f'<text x="{x+16}" y="395" font-family="DejaVu Sans, sans-serif" '
              f'font-size="11" fill="{MATT}">{name}</text>')

    i += rahmen(16, 420, 476, 184, "Duty-Cycle", 6)
    i += kurve(32, 456, 444, 132, 7, GRUEN)
    i += rahmen(508, 420, 476, 184, "Telegramme pro Zeitfenster", 7)
    i += kurve(524, 456, 444, 132, 11, PETROL)
    schreibe("geraetedetail", i)


def stoerungen() -> None:
    i = kopf("AskSin — Störungssuche")
    i += rahmen(16, 60, 968, 200, "Grundrauschen (dBm)", 1)
    for k in range(2):
        i += kurve(32, 96, 936, 148, 2 + k * 4, [PETROL, GELB][k], k == 0)

    i += rahmen(16, 272, 968, 216, "Grundrauschen nach Tageszeit", 2)
    for stunde in range(24):
        for tag in range(6):
            x = 40 + stunde * 38
            y = 312 + tag * 27
            # Abends und nachts staerker — so sieht ein Stoerer mit Zeitschaltuhr aus.
            hitze = 0.15 + (0.75 if 18 <= stunde <= 23 else 0.1) + (tag % 3) * 0.05
            farbe = ROT if hitze > 0.7 else GELB if hitze > 0.4 else PETROL
            i += (f'<rect x="{x}" y="{y}" width="34" height="23" rx="2" '
                  f'fill="{farbe}" opacity="{min(0.95, hitze):.2f}"/>')
    i += (f'<text x="40" y="505" font-family="DejaVu Sans, sans-serif" font-size="11" '
          f'fill="{MATT}">00</text>'
          f'<text x="800" y="505" font-family="DejaVu Sans, sans-serif" font-size="11" '
          f'fill="{MATT}">20 Uhr</text>')
    i += marke(3, 800, 330)

    i += rahmen(16, 500, 968, 104, "Telegramme pro Minute zum Vergleich", 4)
    i += kurve(32, 528, 936, 62, 13, GRUEN)
    schreibe("stoerungen", i)


def batterie() -> None:
    i = kopf("AskSin — Batterie- und Ausfallwächter")
    i += kennzahl(16, 60, 316, 92, "Seit über 24 h stumm", "2", ROT, 1)
    i += kennzahl(340, 60, 316, 92, "Seit über 6 h stumm", "3", GELB, 2)
    i += kennzahl(664, 60, 320, 92, "Bekannte Geräte", "63", TEXT, 3)

    i += rahmen(16, 164, 968, 292, "Zuletzt gehört", 4)
    i += zeilen(32, 200, 936, [
        ("Fenster_Gartenhaus_Nord", "6 Tage", ROT),
        ("Rauchmelder_Keller", "31 Std.", ROT),
        ("Temperatur_Dachboden", "9 Std.", GELB),
        ("Bewegung_Carport", "7 Std.", GELB),
        ("Fenster_Küche", "12 min", GRUEN),
        ("Heizung_Bad", "4 min", GRUEN),
        ("Schalter_Wohnzimmer", "48 s", GRUEN),
        ("Wetterstation_Garten", "12 s", GRUEN),
    ])

    i += rahmen(16, 468, 968, 136, "Zahl der Geräte", 5)
    i += (f'<polyline points="32,540 200,538 380,536 560,538 640,556 820,558 968,556" '
          f'fill="none" stroke="{GELB}" stroke-width="2.5"/>')
    i += (f'<circle cx="640" cy="556" r="5" fill="{ROT}"/>'
          f'<text x="654" y="552" font-family="DejaVu Sans, sans-serif" font-size="11" '
          f'fill="{ROT}">hier ist ein Gerät verstummt</text>')
    schreibe("batterie", i)


def verbund() -> None:
    i = kopf("AskSin — Verbund-Vergleich")
    i += rahmen(16, 60, 968, 130, "Verbindung je Standort", 1)
    for k, (name, muster) in enumerate([
        ("Büro Keller", [(1.0, GRUEN)]),
        ("Gartenhaus", [(0.42, GRUEN), (0.06, ROT), (0.52, GRUEN)]),
        ("Dachboden", [(1.0, GRUEN)]),
        ("Kellertreppe", [(0.78, GRUEN), (0.22, ROT)]),
    ]):
        y = 92 + k * 24
        i += (f'<text x="30" y="{y+13}" font-family="DejaVu Sans, sans-serif" '
              f'font-size="11" fill="{MATT}">{name}</text>')
        i += band(150, y, 818, 16, muster)

    i += rahmen(16, 202, 968, 402, "Empfangsmatrix: Gerät × Standort", 2)
    spalten = ["Büro Keller", "Gartenhaus", "Dachboden", "Kellertreppe"]
    for k, sp in enumerate(spalten):
        i += (f'<text x="{440 + k*140}" y="256" text-anchor="middle" '
              f'font-family="DejaVu Sans, sans-serif" font-size="11" fill="{MATT}">{sp}</text>')
    daten = [
        ("Fenster_Gartenhaus_Nord", [(-98, ROT), (-52, GRUEN), (None, None), (-95, GELB)]),
        ("Bewegung_Carport", [(-96, ROT), (-71, GRUEN), (-99, ROT), (-88, GELB)]),
        ("Temperatur_Dachboden", [(-93, GELB), (None, None), (-49, GRUEN), (-91, GELB)]),
        ("Rauchmelder_Flur_OG", [(-84, GELB), (-97, ROT), (-66, GRUEN), (-79, GRUEN)]),
        ("Heizung_Bad", [(-74, GRUEN), (None, None), (-81, GELB), (-70, GRUEN)]),
        ("Fenster_Küche", [(-61, GRUEN), (-93, GELB), (-88, GELB), (-58, GRUEN)]),
        ("Schalter_Wohnzimmer", [(-58, GRUEN), (None, None), (-79, GRUEN), (-63, GRUEN)]),
        ("Wetterstation_Garten", [(-77, GRUEN), (-44, GRUEN), (-86, GELB), (-80, GELB)]),
        ("Bewegung_Kellertreppe", [(-69, GRUEN), (None, None), (None, None), (-41, GRUEN)]),
    ]
    for r, (name, werte) in enumerate(daten):
        y = 274 + r * 34
        i += (f'<text x="32" y="{y+18}" font-family="DejaVu Sans, sans-serif" '
              f'font-size="12" fill="{TEXT}">{name}</text>')
        for k, (wert, farbe) in enumerate(werte):
            x = 440 + k * 140 - 52
            if wert is None:
                i += (f'<rect x="{x}" y="{y}" width="104" height="26" rx="3" '
                      f'fill="{GRUND}" stroke="{RAHMEN}" stroke-dasharray="3 3"/>'
                      f'<text x="{x+52}" y="{y+18}" text-anchor="middle" font-size="11" '
                      f'fill="{MATT}" font-family="DejaVu Sans, sans-serif">nicht gehört</text>')
            else:
                i += (f'<rect x="{x}" y="{y}" width="104" height="26" rx="3" fill="{farbe}"/>'
                      f'<text x="{x+52}" y="{y+18}" text-anchor="middle" font-size="12" '
                      f'fill="#ffffff" font-family="DejaVu Sans, sans-serif">{wert} dBm</text>')
    schreibe("verbund", i)


def geraetezustand() -> None:
    i = kopf("AskSin — Gerätezustand")
    i += rahmen(16, 60, 476, 180, "Temperatur (°C)", 1)
    i += kurve(32, 96, 444, 128, 2, GELB)
    i += rahmen(508, 60, 476, 180, "Lüfterdrehzahl (U/min)", 2)
    i += kurve(524, 96, 444, 128, 6, PETROL)

    i += rahmen(16, 252, 476, 180, "Systemlast", 3)
    i += kurve(32, 288, 444, 128, 9, GRUEN)
    i += rahmen(508, 252, 476, 180, "Freier Arbeitsspeicher (%)", 4)
    i += kurve(524, 288, 444, 128, 12, PETROL)

    i += rahmen(16, 444, 968, 160, "Freier Plattenplatz (%)", 5)
    i += (f'<polyline points="32,500 200,506 380,512 560,520 740,528 968,538" '
          f'fill="none" stroke="{GELB}" stroke-width="2.5"/>'
          f'<text x="960" y="558" text-anchor="end" font-family="DejaVu Sans, sans-serif" '
          f'font-size="11" fill="{MATT}">langsam fallend — hier wächst die Datenbank</text>')
    schreibe("geraetezustand", i)


def nie_gehoert() -> None:
    """Die Arbeitsliste: Wer steht in der CCU und wurde von niemandem gehoert?"""
    i = kopf("Verschollene Geräte")
    i += kennzahl(24, 70, 300, 96, "Verschollen", "3", ROT, 1)
    i += kennzahl(344, 70, 300, 96, "In der CCU-Liste", "214", PETROL, 2)

    i += rahmen(24, 186, 952, 176, "Von keinem Analyzer je gehört", 3)
    i += zeilen(44, 212, 912, [
        ("Dachboden Rauchmelder", "NEQ7654321", ROT),
        ("Garage Fensterkontakt", "MEQ0245901", ROT),
        ("Gartenhaus Thermostat", "OEQ0918823", ROT),
        ("Carport Bewegungsmelder", "MEQ1180042", ROT),
    ])

    i += rahmen(24, 378, 952, 218, "Wer hört wen — je Standort", 4)
    spalten = ["Dachboden", "Keller", "Werkstatt", "Garten"]
    for s, txt in enumerate(spalten):
        i += (f'<text x="{560 + s * 100}" y="424" text-anchor="middle" '
              f'font-family="DejaVu Sans, sans-serif" font-size="11" '
              f'fill="{MATT}">{txt}</text>')
    matrix = [
        ("Wäschekeller Fenster", [1, 1, 0, 0]),
        ("Dachboden Rauchmelder", [0, 0, 0, 0]),
        ("Gartenhaus Thermostat", [0, 0, 0, 0]),
        ("Carport Bewegungsmelder", [0, 0, 0, 1]),
        ("Küche Heizung", [1, 1, 1, 1]),
    ]
    for r, (name, werte) in enumerate(matrix):
        y = 452 + r * 28
        i += (f'<rect x="44" y="{y-15}" width="912" height="22" rx="3" '
              f'fill="{GRUND}" opacity="0.5"/>'
              f'<text x="54" y="{y}" font-family="DejaVu Sans, sans-serif" '
              f'font-size="12" fill="{TEXT}">{name}</text>')
        for s, w in enumerate(werte):
            i += (f'<text x="{560 + s * 100}" y="{y}" text-anchor="middle" '
                  f'font-family="DejaVu Sans, sans-serif" font-size="12" '
                  f'font-weight="bold" fill="{GRUEN if w else ROT}">{w}</text>')
    schreibe("nie-gehoert", i)


def zigbee() -> None:
    """Die Zigbee-Ansicht: Empfangsguete auf 2,4 GHz statt nur 'erreichbar'."""
    i = kopf("Zigbee-Mithörer")
    i += kennzahl(24, 70, 228, 96, "Geräte gehört", "34", PETROL, 1)
    i += kennzahl(268, 70, 228, 96, "Grenzwertig", "4", GELB, 2)
    i += kennzahl(512, 70, 228, 96, "Nie gehört", "1", ROT, 3)
    i += kennzahl(756, 70, 220, 96, "Fremde Netze", "2", MATT, 4)

    i += rahmen(24, 186, 470, 210, "Empfangsstärke je Gerät (dBm)", 5)
    for n, saat in enumerate((11, 29, 47)):
        i += kurve(44, 212, 430, 170, saat, farbe=(PETROL, GRUEN, GELB)[n])

    i += rahmen(506, 186, 470, 210, "Anteil schwach empfangener Pakete", 6)
    i += band(526, 300, 430, 40, [(0.62, GRUEN), (0.22, GELB), (0.16, ROT)])
    i += (f'<text x="526" y="368" font-family="DejaVu Sans, sans-serif" '
          f'font-size="11" fill="{MATT}">LQI bricht unter etwa −87 dBm ein — '
          f'die Kante ist gemessen, nicht geschätzt</text>')

    i += rahmen(24, 412, 952, 184, "Geräte je Standort — schwächster zuerst", 7)
    i += zeilen(44, 438, 912, [
        ("LED − Terrasse oben 04", "−89 dBm · LQI 6", ROT),
        ("LED − Terrasse unten 03", "−88 dBm · LQI 28", ROT),
        ("LED − Garten Weg 04", "−84 dBm · LQI 253", GELB),
        ("Router − Zwischenstecker Garage", "−61 dBm · LQI 255", GRUEN),
    ])
    schreibe("zigbee", i)


def uebersicht() -> None:
    """Der Ordner in Grafana, damit man weiss, wo man klicken muss."""
    i = (f'<rect width="{BREITE}" height="{HOEHE}" fill="{GRUND}"/>'
         f'<rect width="{BREITE}" height="{KOPF}" fill="{PANEL}"/>'
         f'<text x="24" y="{KOPF//2+5}" font-family="DejaVu Sans, sans-serif" '
         f'font-size="15" fill="{TEXT}" font-weight="bold">Dashboards</text>')
    i += (f'<text x="24" y="86" font-family="DejaVu Sans, sans-serif" font-size="14" '
          f'fill="{PETROL}" font-weight="bold">📁 AskSin-Analyzer</text>')
    eintraege = [
        ("Leitstand", "Läuft alles?"),
        ("Funkqualität (Auswahl)", "Wer wird wie gut gehört?"),
        ("Funkqualität je Standort", "Wo im Haus ist der Empfang gut?"),
        ("Duty-Cycle-Wächter", "Wer sendet zu viel?"),
        ("Gerätedetail", "Ein Gerät über alle Standorte"),
        ("Störungssuche", "Wann stört was?"),
        ("Batterie- und Ausfallwächter", "Wer schweigt?"),
        ("Verbund-Vergleich", "Die Funkloch-Karte"),
        ("Gerätezustand", "Wie geht es den Analyzern?"),
        ("Verschollene Geräte", "Wen hört niemand?"),
        ("Zigbee-Mithörer", "Empfangsgüte auf 2,4 GHz"),
    ]
    # Der Zeilenabstand richtet sich nach der Anzahl, damit das Bild dieselbe
    # Hoehe behaelt wie die uebrigen Abbildungen. Sonst faellt es im Handbuch
    # aus der Reihe — beim neunten Eintrag ist das schon einmal passiert.
    abstand = min(55, (HOEHE - 130) // max(len(eintraege), 1))
    for k, (name, zweck) in enumerate(eintraege):
        y = 104 + k * abstand
        i += (f'<rect x="40" y="{y}" width="920" height="44" rx="6" fill="{PANEL}" '
              f'stroke="{RAHMEN}"/>'
              f'<text x="62" y="{y+29}" font-family="DejaVu Sans, sans-serif" '
              f'font-size="14" fill="{TEXT}">{name}</text>'
              f'<text x="520" y="{y+28}" font-family="DejaVu Sans, sans-serif" '
              f'font-size="12" fill="{MATT}">{zweck}</text>')
        i += marke(k + 1, 936, y + 22)
    schreibe("uebersicht", i)


if __name__ == "__main__":
    ansichten = (uebersicht, leitstand, funkqualitaet, funkqualitaet_standorte,
                 dutycycle, geraetedetail, stoerungen, batterie, verbund,
                 geraetezustand, nie_gehoert, zigbee)
    for bauen in ansichten:
        bauen()
    # Die Zahl wird gezaehlt und nicht abgetippt: Beim neunten Eintrag stand
    # hier einmal monatelang eine falsche.
    print(f"\n{len(ansichten) - 1} Vorschauen in {HIER}")
