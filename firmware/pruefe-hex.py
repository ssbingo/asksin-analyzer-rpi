#!/usr/bin/env python3
"""
Prüft eine Intel-HEX-Datei, bevor sie auf den Mikrocontroller geht.

Der Analyzer prüft beim Hochladen nur, ob die Datei überhaupt nach Intel-HEX
aussieht. Das reicht, um eine verwechselte Datei abzuweisen — aber nicht, um
die beiden Fallen zu erkennen, die hier wirklich weh tun:

  * Die Variante **mit** Bootloader. Sie sieht genauso aus wie die richtige,
    reicht aber bis in den geschützten Speicherbereich. Über den Bootloader
    lässt sie sich nicht schreiben; der Versuch endet mit einer Fehlermeldung
    und einem halb beschriebenen Chip.
  * Eine unvollständig heruntergeladene Datei. Sie ist syntaktisch tadellos,
    nur eben zu kurz — und der Sniffer schweigt danach.

Aufruf:
    python3 pruefe-hex.py AskSinSniffer328P.ino.hex
"""

from __future__ import annotations

import sys
from pathlib import Path

# ATmega328P: 32 KiB Flash. Der Optiboot-Bootloader liegt ganz oben und belegt
# 512 Byte; alles darunter gehört dem Programm.
FLASH = 32 * 1024
BOOTLOADER_AB = FLASH - 512


def lies_hex(pfad: Path) -> tuple[dict[int, int], list[str]]:
    """Liest die Datei und gibt belegte Adressen samt Beanstandungen zurück."""
    speicher: dict[int, int] = {}
    fehler: list[str] = []
    basis = 0
    ende_gesehen = False

    for nr, roh in enumerate(pfad.read_text(encoding="ascii", errors="replace")
                             .splitlines(), 1):
        zeile = roh.strip()
        if zeile == "":
            continue
        if not zeile.startswith(":"):
            fehler.append(f"Zeile {nr}: beginnt nicht mit ':'")
            continue
        try:
            bytes_ = bytes.fromhex(zeile[1:])
        except ValueError:
            fehler.append(f"Zeile {nr}: keine gültige Hex-Zeichenfolge")
            continue
        if len(bytes_) < 5:
            fehler.append(f"Zeile {nr}: zu kurz für einen Datensatz")
            continue

        laenge, adr_hoch, adr_tief, typ = bytes_[0], bytes_[1], bytes_[2], bytes_[3]
        daten = bytes_[4:-1]
        pruefsumme = bytes_[-1]

        if len(daten) != laenge:
            fehler.append(
                f"Zeile {nr}: Längenangabe {laenge}, tatsächlich {len(daten)}")
            continue
        # Die Prüfsumme ist das Zweierkomplement der Summe aller Bytes davor.
        # Sie faengt genau die Fehler, die man sonst erst am toten Geraet merkt.
        if (sum(bytes_[:-1]) + pruefsumme) & 0xFF != 0:
            fehler.append(f"Zeile {nr}: Prüfsumme stimmt nicht")
            continue

        if typ == 0x00:                       # Daten
            adresse = basis + (adr_hoch << 8) + adr_tief
            for i, b in enumerate(daten):
                if adresse + i in speicher:
                    fehler.append(
                        f"Zeile {nr}: Adresse {adresse + i:#06x} doppelt belegt")
                speicher[adresse + i] = b
        elif typ == 0x01:                     # Dateiende
            ende_gesehen = True
        elif typ == 0x04:                     # obere Adresshälfte
            basis = ((daten[0] << 8) + daten[1]) << 16
        elif typ == 0x02:                     # Segmentadresse
            basis = ((daten[0] << 8) + daten[1]) << 4

    if not ende_gesehen:
        fehler.append("Die Endekennung ':00000001FF' fehlt — Datei unvollständig?")
    return speicher, fehler


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    pfad = Path(sys.argv[1])
    if not pfad.is_file():
        print(f"{pfad} gibt es nicht.", file=sys.stderr)
        return 1

    speicher, fehler = lies_hex(pfad)

    if not speicher:
        print("Die Datei enthält keine Daten.", file=sys.stderr)
        return 1

    tiefste, hoechste = min(speicher), max(speicher)
    groesse = len(speicher)

    print(f"Datei      : {pfad.name}")
    print(f"Adressen   : {tiefste:#06x} bis {hoechste:#06x}")
    print(f"Programm   : {groesse} Byte ({groesse / BOOTLOADER_AB * 100:.1f} % "
          f"des nutzbaren Flash)")

    if hoechste >= BOOTLOADER_AB:
        fehler.append(
            f"Die Datei reicht bis {hoechste:#06x} und damit in den "
            f"Bootloader-Bereich ab {BOOTLOADER_AB:#06x}. Das ist die Variante "
            f"MIT Bootloader — für ein Update über den Bootloader ist sie "
            f"unbrauchbar. Gebraucht wird die Datei OHNE 'with_bootloader' "
            f"im Namen.")
    if hoechste >= FLASH:
        fehler.append(f"Die Datei passt nicht in 32 KiB Flash.")
    # Der Sniffer ist rund 20 KB gross. Deutlich weniger deutet auf einen
    # abgebrochenen Download hin — syntaktisch tadellos, aber unbrauchbar.
    if groesse < 4096:
        fehler.append(
            f"Nur {groesse} Byte Programm — das ist auffällig wenig. "
            f"Download vollständig?")

    if fehler:
        print()
        print(f"{len(fehler)} Beanstandung(en):", file=sys.stderr)
        for f in fehler[:15]:
            print(f"  - {f}", file=sys.stderr)
        if len(fehler) > 15:
            print(f"  … und {len(fehler) - 15} weitere", file=sys.stderr)
        return 1

    print()
    print("In Ordnung — diese Datei lässt sich über den Bootloader aufspielen.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
