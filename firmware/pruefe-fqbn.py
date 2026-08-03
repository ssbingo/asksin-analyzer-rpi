#!/usr/bin/env python3
"""Prüft jede FQBN in der Dokumentation gegen die Optionen von MiniCore 3.1.2.

Anlass (03.08.2026): Im Handbuch stand jahrelang

    --fqbn MiniCore:avr:328:bootloader=uart0,clock=external_8MHz

MiniCore kennt diese Taktangabe nicht — sie heißt ``8MHz_external``. Wer den
Befehl aus dem Handbuch kopierte, bekam eine Fehlermeldung statt einer Datei.
Aufgefallen ist das nur nebenbei, beim Nachschlagen einer ganz anderen Option.

Das ist die unangenehme Sorte Fehler: Er steht in einer Anleitung, die
niemand nachrechnet, und er trifft ausgerechnet den Anfänger, der sich an den
Wortlaut hält, weil er es nicht besser weiß.

Deshalb wird die Zeichenkette hier maschinell geprüft. Die Optionstabelle ist
aus ``avr/boards.txt`` von MiniCore 3.1.2 abgeschrieben und liegt bewusst im
Repo: Die Prüfung soll ohne Netz laufen — sonst wird sie beim ersten Ausfall
übersprungen und ist damit wertlos.

Aufruf:
    python3 firmware/pruefe-fqbn.py       # 0 = alle FQBN gültig, 1 = Fehler
"""

import pathlib
import re
import sys

# --- MiniCore 3.1.2, Board "328" -------------------------------------------
# Quelle: github.com/MCUdude/MiniCore, Tag v3.1.2, avr/boards.txt
# Nur die Optionen, die wir tatsächlich verwenden oder verwechseln könnten.
ERLAUBT = {
    "variant": {"modelP", "modelNonP", "modelPB"},
    "bootloader": {"uart0", "uart1", "no_bootloader"},
    "BOD": {"2v7", "4v3", "1v8", "disabled"},
    "eeprom": {"keep", "erase"},
    "LTO": {"Os_flto", "Os"},
    "clock": {
        "16MHz_external", "20MHz_external", "18_432MHz_external",
        "14_7456MHz_external", "12MHz_external", "11_0592MHz_external",
        "9_216MHz_external", "8MHz_external", "7_3728MHz_external",
        "6MHz_external", "4MHz_external", "3_6864MHz_external",
        "2MHz_external", "1_8432MHz_external", "1MHz_external",
        "8MHz_internal", "4MHz_internal", "2MHz_internal", "1MHz_internal",
    },
}

# Was dieses Projekt zusätzlich verlangt: Die Firmware ist für 8 MHz Quarz
# gebaut, und die mitgelieferte HEX-Datei entsteht nur mit LTO. Eine FQBN in
# unserer Doku, die davon abweicht, ist auch dann falsch, wenn MiniCore sie
# akzeptiert.
PFLICHT = {
    "clock": "8MHz_external",
    "LTO": "Os_flto",
    "variant": "modelP",
}

DURCHSUCHEN = [
    "docs/handbuch/handbuch.html",
    "docs/firmware-neu.md",
    "firmware/README.md",
    "README.md",
]

# MiniCore:avr:328:option=wert,option=wert — Zeilenumbrüche mit \ am Ende
# kommen im Handbuch vor, weil der Befehl sonst zu breit wird.
MUSTER = re.compile(r"MiniCore:avr:328:([A-Za-z0-9_=,\\\s]+)")


def zerlege(roh):
    """Macht aus dem Optionsteil ein dict — Umbrüche und Backslashes raus."""
    sauber = re.sub(r"\\\s*", "", roh).strip()
    sauber = re.sub(r"\s+", "", sauber)
    paare = {}
    for stueck in sauber.split(","):
        if "=" not in stueck:
            continue
        schluessel, _, wert = stueck.partition("=")
        if schluessel in ERLAUBT:
            paare[schluessel] = wert
    return paare


def main():
    wurzel = pathlib.Path(__file__).resolve().parent.parent
    fehler = []
    gefunden = 0

    for rel in DURCHSUCHEN:
        pfad = wurzel / rel
        if not pfad.exists():
            continue
        text = pfad.read_text(encoding="utf8")
        for treffer in MUSTER.finditer(text):
            zeile = text[: treffer.start()].count("\n") + 1
            optionen = zerlege(treffer.group(1))
            if not optionen:
                continue
            gefunden += 1
            ort = f"{rel}:{zeile}"

            for schluessel, wert in optionen.items():
                if wert not in ERLAUBT[schluessel]:
                    nah = [k for k in ERLAUBT[schluessel]
                           if sorted(k.lower()) == sorted(wert.lower())]
                    tipp = f" — gemeint war wohl {nah[0]}" if nah else ""
                    fehler.append(
                        f"{ort}: MiniCore kennt kein {schluessel}={wert}{tipp}")

            for schluessel, erwartet in PFLICHT.items():
                ist = optionen.get(schluessel)
                if ist is None:
                    fehler.append(
                        f"{ort}: {schluessel} fehlt — muss {erwartet} sein")
                elif ist != erwartet:
                    fehler.append(
                        f"{ort}: {schluessel}={ist}, dieses Projekt braucht "
                        f"{erwartet}")

    if not gefunden:
        print("Keine FQBN gefunden — steht der Befehl noch in der Doku?",
              file=sys.stderr)
        return 1

    if fehler:
        for f in fehler:
            print(f"  FEHLER  {f}", file=sys.stderr)
        print(f"\n{len(fehler)} Beanstandung(en) bei {gefunden} FQBN.",
              file=sys.stderr)
        print("Ein falscher Bezeichner bricht arduino-cli sofort ab — der",
              file=sys.stderr)
        print("Leser sieht eine Fehlermeldung statt einer HEX-Datei.",
              file=sys.stderr)
        return 1

    print(f"{gefunden} FQBN in der Dokumentation, alle Optionen gültig "
          f"(MiniCore 3.1.2) und für 8 MHz mit LTO.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
