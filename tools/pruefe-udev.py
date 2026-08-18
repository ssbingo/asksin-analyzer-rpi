#!/usr/bin/env python3
"""Kein Gerät darf zwei Namen aus unserem Namensraum bekommen.

    python3 tools/pruefe-udev.py [regeldatei]

Warum es diese Prüfung gibt
---------------------------
Am 18.08.2026 kam der Zigbee-Mithörer dazu. Der SONOFF ZBDongle-E benutzt
denselben CP2102N wie die USB-Variante der Analyzer-Platine — gleiche
Hersteller- und Modellnummer, nur andere Zeichenketten. Die Auffangregel für
`asksin-usb` griff damit auch auf ihm.

Das Fehlerbild wäre gewesen: „Der Analyzer empfängt nichts mehr, seit der
Zigbee-Stick dran ist." Das sieht nach Funk aus, nach Störung, nach Hardware —
nach allem, nur nicht nach einer Zeile in einer Regeldatei.

Wie geprüft wird — und warum nicht anders
-----------------------------------------
Der erste Entwurf verglich die Bedingungen zweier Regeln auf Teilmengen:
„ist Regel A allgemeiner als B?". Das erkennt genau diesen Fall NICHT — die
beiden Regeln greifen auf **verschiedenen Merkmalen desselben Geräts** zu
(`manufacturer`/`product` gegen `idVendor`/`idProduct`), da ist keine Menge
Teilmenge der anderen. Die Gegenprobe bestand, obwohl der Fehler drin war.

Deshalb wird jetzt das Naheliegende getan: Die Regeln werden gegen einen
**Katalog bekannter Geräte** ausgewertet, und es wird nachgesehen, welche
Namen dabei herauskommen. Das ist exakt, nachvollziehbar, und der Katalog ist
zugleich Dokumentation dessen, was an einem Analyzer stecken kann.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

WURZEL = Path(__file__).resolve().parent.parent
STANDARD = WURZEL / "hardware/99-asksin-analyzer.rules"

# --- Katalog: was an einem Analyzer stecken kann ----------------------------
# Merkmale so, wie udev sie sieht. `erwartet` ist die vollständige Menge der
# Namen, die dieses Gerät bekommen soll — nicht mehr und nicht weniger.
GERAETE = [
    {
        "was": "Analyzer-Platine über USB, Seriennummer programmiert",
        "attr": {"SUBSYSTEM": "tty", "ATTRS{idVendor}": "10c4",
                 "ATTRS{idProduct}": "ea60", "ATTRS{serial}": "ASKSIN-0001",
                 "ATTRS{product}": "CP2102N USB to UART Bridge Controller"},
        "erwartet": {"asksin", "asksin-usb"},   # Zweitname ausdrücklich gewollt
    },
    {
        "was": "Analyzer-Platine über USB, ohne programmierte Seriennummer",
        "attr": {"SUBSYSTEM": "tty", "ATTRS{idVendor}": "10c4",
                 "ATTRS{idProduct}": "ea60", "ATTRS{serial}": "0001",
                 "ATTRS{product}": "CP2102N USB to UART Bridge Controller"},
        "erwartet": {"asksin-usb"},
    },
    {
        # Derselbe CP2102N, nur mit von Itead programmierten Zeichenketten.
        # Genau hier lag der Fehler.
        "was": "Zigbee-Mithörer SONOFF ZBDongle-E V2",
        "attr": {"SUBSYSTEM": "tty", "ATTRS{idVendor}": "10c4",
                 "ATTRS{idProduct}": "ea60", "ATTRS{manufacturer}": "Itead",
                 "ATTRS{product}": "Sonoff Zigbee 3.0 USB Dongle Plus V2",
                 "ATTRS{serial}": "<geraetespezifisch, wird nicht gematcht>"},
        "erwartet": {"asksin-zigbee"},
    },
    {
        "was": "Sniffer-HAT über den GPIO-Header",
        "attr": {"SUBSYSTEM": "tty", "KERNEL": "ttyAMA0"},
        "erwartet": {"asksin-hat"},
    },
]

BEDINGUNG = re.compile(r'(\w+(?:\{[^}]+\})?)\s*(==|!=)\s*"([^"]*)"')
SYMLINK = re.compile(r'SYMLINK\+="([^"]+)"')


def passt(wert: str, muster: str) -> bool:
    """udev-Mustervergleich, so weit wir ihn brauchen (* am Ende)."""
    if muster.endswith("*"):
        return wert.startswith(muster[:-1])
    return wert == muster


def regeln_lesen(pfad: Path) -> list[dict]:
    text = re.sub(r"\\\s*\n", " ", pfad.read_text(encoding="utf-8"))
    regeln = []
    for nr, zeile in enumerate(text.splitlines(), 1):
        zeile = zeile.strip()
        if not zeile or zeile.startswith("#"):
            continue
        namen = SYMLINK.findall(zeile)
        if not namen:
            continue
        ein, aus = {}, {}
        for schluessel, op, wert in BEDINGUNG.findall(zeile):
            if schluessel == "SYMLINK+":
                continue
            (ein if op == "==" else aus)[schluessel] = wert
        regeln.append({"zeile": nr, "namen": namen, "ein": ein, "aus": aus})
    return regeln


def greift(regel: dict, attr: dict) -> bool:
    for k, v in regel["ein"].items():
        if k not in attr or not passt(attr[k], v):
            return False
    for k, v in regel["aus"].items():
        # Fehlt das Merkmal, ist die Ungleichbedingung erfüllt.
        if k in attr and passt(attr[k], v):
            return False
    return True


def main(argv: list[str]) -> int:
    pfad = Path(argv[0]) if argv else STANDARD
    if not pfad.exists():
        print(f"Regeldatei nicht gefunden: {pfad}")
        return 1

    regeln = regeln_lesen(pfad)
    if not regeln:
        print("Keine Regel mit SYMLINK gefunden.")
        return 1

    fehler: list[str] = []
    for g in GERAETE:
        namen, quellen = set(), []
        for r in regeln:
            if greift(r, g["attr"]):
                namen |= set(r["namen"])
                quellen.append(f"Zeile {r['zeile']}")
        zuviel = namen - g["erwartet"]
        zuwenig = g["erwartet"] - namen
        if zuviel:
            fehler.append(
                f"{g['was']}: bekommt zusätzlich {', '.join(sorted(zuviel))} "
                f"(greifende Regeln: {', '.join(quellen)})"
            )
        if zuwenig:
            fehler.append(
                f"{g['was']}: bekommt {', '.join(sorted(zuwenig))} NICHT"
            )

    if fehler:
        print(f"udev-Regeln in {pfad.name} passen nicht zum Gerätekatalog:")
        for f in fehler:
            print(f"  - {f}")
        return 1

    for g in GERAETE:
        print(f"  {g['was']}\n      -> {', '.join(sorted(g['erwartet']))}")
    print(f"udev-Regeln in Ordnung — {len(regeln)} Regeln gegen "
          f"{len(GERAETE)} bekannte Geräte geprüft.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
