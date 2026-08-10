#!/usr/bin/env python3
"""Schreibt WS2812-Rahmen auf ein spidev-Gerät — mit dem richtigen Takt.

    python3 ws2812-spi.py /dev/spidev0.0 2400000 < rahmen.hex

Je Zeile auf der Standardeingabe ein Rahmen als Hexadezimaltext; der Prozess
bleibt offen und schreibt jeden Rahmen sofort weiter.

Warum es diesen Helfer gibt
---------------------------
Der SPI-Takt gehört im Linux-Kern nicht dem Gerät, sondern dem geöffneten
**Dateideskriptor**: `spidev_release()` setzt `speed_hz` beim Schließen des
letzten Benutzers auf `spi->max_speed_hz` zurück. Ein Werkzeug wie
`spi-config`, das den Takt setzt und sich danach beendet, hinterlässt also
nichts — wer anschließend schreibt, schreibt mit dem Höchstwert des Reglers.

Am 10.08.2026 an Analyzer 01 gemessen: `spi-config -q` meldete nach dem Start
des Dienstes `speed=125000000`. Statt 2,4 MHz also 125 MHz, 52-fach zu
schnell. Der komplette Rahmen war nach 0,6 µs durch, die WS2812 sah davon
nur einen Störimpuls und blieb dunkel — bei völlig fehlerfreier Verdrahtung.
Der Fehler war von außen nicht zu sehen: Auf der Datenleitung lag ein Signal,
es hatte nur die falsche Geschwindigkeit.

Node kennt kein ioctl. Deshalb dieser Helfer: Er setzt den Takt und
**bleibt offen**, solange die Anzeige läuft. Damit gilt die Einstellung für
jeden einzelnen Rahmen.
"""

import fcntl
import struct
import sys

# _IOW('k', 1..4, ...) — aus include/uapi/linux/spi/spidev.h
SPI_IOC_WR_MODE = 0x40016B01
SPI_IOC_WR_LSB_FIRST = 0x40016B02
SPI_IOC_WR_BITS_PER_WORD = 0x40016B03
SPI_IOC_WR_MAX_SPEED_HZ = 0x40046B04
SPI_IOC_RD_MAX_SPEED_HZ = 0x80046B04

# Grenze des spidev-Puffers (Vorgabe des Moduls: 4096 Byte je Transfer).
BLOCK = 4096


def main() -> int:
    if len(sys.argv) != 3:
        print(f"Aufruf: {sys.argv[0]} <spidev-Geraet> <Hz>", file=sys.stderr)
        return 2
    geraet, hz = sys.argv[1], int(sys.argv[2])

    try:
        f = open(geraet, "r+b", buffering=0)
    except OSError as fehler:
        print(f"{geraet} liess sich nicht oeffnen: {fehler}", file=sys.stderr)
        return 1

    with f:
        try:
            # Modus 0 (Takt ruht low, Daten mit der steigenden Flanke), 8 Bit,
            # MSB zuerst — die Kodierung setzt genau diese Reihenfolge voraus.
            fcntl.ioctl(f, SPI_IOC_WR_MODE, struct.pack("B", 0))
            fcntl.ioctl(f, SPI_IOC_WR_LSB_FIRST, struct.pack("B", 0))
            fcntl.ioctl(f, SPI_IOC_WR_BITS_PER_WORD, struct.pack("B", 8))
            fcntl.ioctl(f, SPI_IOC_WR_MAX_SPEED_HZ, struct.pack("<I", hz))
            ist = struct.unpack(
                "<I", fcntl.ioctl(f, SPI_IOC_RD_MAX_SPEED_HZ, struct.pack("<I", 0))
            )[0]
        except OSError as fehler:
            print(f"SPI liess sich nicht einstellen: {fehler}", file=sys.stderr)
            return 1

        # Zurueckgelesen statt geglaubt: Genau diese Pruefung hat gefehlt.
        # Der Regler darf abrunden — er teilt einen festen Takt und trifft
        # nicht jeden Wunsch. Ein WS2812-Bit dauert drei SPI-Bits, und die
        # Bauteile nehmen rund 667 bis 1067 kHz Bitrate an (gemessen an
        # Analyzer 01). +-10 % um den Sollwert bleiben bequem darin.
        if abs(ist - hz) > hz // 10:
            print(
                f"SPI laeuft mit {ist} Hz statt {hz} Hz — das WS2812-Timing "
                "traegt das nicht. Die LED bleibt dunkel oder zeigt Falsches.",
                file=sys.stderr,
            )
            return 1
        print(f"SPI bereit: {ist} Hz an {geraet}", file=sys.stderr, flush=True)

        for zeile in sys.stdin:
            zeile = zeile.strip()
            if not zeile:
                continue
            try:
                daten = bytes.fromhex(zeile)
            except ValueError:
                print("unlesbarer Rahmen verworfen", file=sys.stderr, flush=True)
                continue
            try:
                for i in range(0, len(daten), BLOCK):
                    f.write(daten[i : i + BLOCK])
            except OSError as fehler:
                print(f"Schreiben fehlgeschlagen: {fehler}", file=sys.stderr, flush=True)
                return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
