#!/usr/bin/env python3
"""
Hilfsdienst für die WS2812-Status-LED über PWM (GPIO18).

Warum es diesen Dienst gibt
---------------------------
Auf Pi 3 und Pi 4 ist die PWM-Ansteuerung der zuverlässige Weg: Der SPI-Takt
leitet sich dort vom Kerntakt ab und wandert mit dessen Skalierung, was das
WS2812-Timing zerreißt (Flackern, Farbsprünge). Die PWM/DMA-Ansteuerung
braucht aber Zugriff auf /dev/mem, also Root-Rechte — und der Analyzer-Dienst
läuft bewusst unprivilegiert.

Deshalb die Aufteilung: Der Core rechnet weiterhin Farbe, Blinkphase und
Helligkeit aus und schreibt nur das Ergebnis als `r,g,b` in eine Datei. Dieser
kleine Dienst läuft als root, liest die Datei und setzt die LED. Dasselbe
Muster wie bei Update und Netzwerkeinstellungen: der unprivilegierte Dienst
schreibt eine Datei, ein Root-Helfer führt aus.

Auf dem Pi 5 wird dieser Dienst nicht gebraucht — dort scheidet PWM aus (RP1),
und der Core spricht die LED direkt über SPI an.

Aufruf (normalerweise durch asksin-analyzer-led.service):
    sudo ./led-pwm.py [--datei PFAD] [--gpio 18] [--einmal R,G,B]
"""

from __future__ import annotations

import argparse
import os
import signal
import sys
import time

TAKT_S = 0.05          # Datei-Abtastung; 20 Hz reicht für das Blinken
VORGABE_DATEI = "/var/lib/asksin-analyzer/led-farbe"
VORGABE_GPIO = 18


def lies_farbe(pfad: str) -> tuple[int, int, int] | None:
    """`r,g,b` aus der Datei lesen. None, wenn sie fehlt oder Unsinn enthält."""
    try:
        with open(pfad, "r", encoding="ascii") as f:
            teile = f.read().strip().split(",")
    except OSError:
        return None
    if len(teile) != 3:
        return None
    try:
        werte = [int(t) for t in teile]
    except ValueError:
        return None
    if any(w < 0 or w > 255 for w in werte):
        return None
    return (werte[0], werte[1], werte[2])


class Treiber:
    """Kapselt rpi_ws281x, damit der Rest ohne Hardware testbar bleibt."""

    def __init__(self, gpio: int) -> None:
        from rpi_ws281x import PixelStrip, Color  # erst hier: nur auf dem Pi

        self._color = Color
        # 800 kHz, DMA 10, Kanal 0 — die Standardwerte der Bibliothek für
        # GPIO18. Helligkeit fest auf 255: die Skalierung rechnet der Core,
        # damit beide Ansteuerarten exakt dieselben Farben liefern.
        self._strip = PixelStrip(1, gpio, 800_000, 10, False, 255, 0)
        self._strip.begin()

    def setze(self, r: int, g: int, b: int) -> None:
        self._strip.setPixelColor(0, self._color(r, g, b))
        self._strip.show()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--datei", default=VORGABE_DATEI)
    ap.add_argument("--gpio", type=int, default=VORGABE_GPIO)
    ap.add_argument("--einmal", help="Farbe R,G,B einmalig setzen und beenden")
    args = ap.parse_args()

    if os.geteuid() != 0:
        print("led-pwm: PWM/DMA braucht Root-Rechte", file=sys.stderr)
        return 1

    try:
        treiber = Treiber(args.gpio)
    except ImportError:
        print("led-pwm: rpi_ws281x fehlt — Installation siehe install.sh",
              file=sys.stderr)
        return 1
    except Exception as err:                      # noqa: BLE001
        print(f"led-pwm: Start fehlgeschlagen: {err}", file=sys.stderr)
        return 1

    if args.einmal:
        teile = args.einmal.split(",")
        if len(teile) != 3:
            print("led-pwm: --einmal erwartet R,G,B", file=sys.stderr)
            return 1
        try:
            werte = [int(t) for t in teile]
        except ValueError:
            print("led-pwm: --einmal erwartet drei Zahlen", file=sys.stderr)
            return 1
        if any(w < 0 or w > 255 for w in werte):
            print("led-pwm: Werte müssen 0–255 sein", file=sys.stderr)
            return 1
        treiber.setze(*werte)
        return 0

    laeuft = True

    def beenden(_sig, _frm) -> None:               # noqa: ANN001
        nonlocal laeuft
        laeuft = False

    signal.signal(signal.SIGTERM, beenden)
    signal.signal(signal.SIGINT, beenden)

    print(f"led-pwm: GPIO{args.gpio}, Farbdatei {args.datei}", flush=True)
    letzte: tuple[int, int, int] | None = None
    letzte_mtime = -1.0
    treiber.setze(0, 0, 0)

    while laeuft:
        try:
            mtime = os.stat(args.datei).st_mtime
        except OSError:
            mtime = -1.0
        # Nur lesen, wenn sich die Datei geändert hat — spart Aufwecken.
        if mtime != letzte_mtime:
            letzte_mtime = mtime
            farbe = lies_farbe(args.datei)
            if farbe is not None and farbe != letzte:
                letzte = farbe
                try:
                    treiber.setze(*farbe)
                except Exception as err:           # noqa: BLE001
                    print(f"led-pwm: {err}", file=sys.stderr, flush=True)
        time.sleep(TAKT_S)

    # Beim Beenden dunkel hinterlassen, wie es der SPI-Weg auch tut.
    try:
        treiber.setze(0, 0, 0)
    except Exception:                              # noqa: BLE001
        pass
    print("led-pwm: beendet", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
