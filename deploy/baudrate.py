#!/usr/bin/env python3
"""Setzt eine beliebige Baudrate auf einer seriellen Schnittstelle.

Warum es dieses Skript gibt
---------------------------
Der Sniffer sendet mit **58 824 Baud** — keine der genormten Raten. Der Grund
steht in hardware/README.md, Abschnitt 2.5: Der 8-MHz-Takt des ATmega kann
57 600 nicht genau erzeugen; er trifft 58 823,5. Stellt der Pi seinerseits
exakt diese Rate ein, ist der Fehler null statt 2,1 %.

`stty` kann das nicht. Es kennt ausschliesslich die genormten Raten und lehnt
alles andere ab:

    $ stty -F /dev/asksin-hat 58824
    stty: ungültiges Argument ‘58824’

Der Linux-Kern kann es sehr wohl — über `termios2` mit `BOTHER`. Nur reicht
`stty` diese Möglichkeit nicht durch. Genau diese Lücke füllt dieses Skript.

(Gefunden am 07.08.2026 an der ersten echten Platine. Vorher lief jeder
Analyzer im Demo-Modus, und der öffnet gar keine serielle Schnittstelle —
der Fehler konnte also jahrelang unbemerkt bleiben. Der Test dazu prüfte die
Argumente, die wir bauen, nicht ob sie angenommen werden.)

Aufruf:
    python3 baudrate.py /dev/asksin-hat 58824

Rückgabewert 0 bei Erfolg. Bei Misserfolg eine Zeile auf stderr und 1.
"""

import fcntl
import struct
import sys
import termios

# ioctl-Nummern aus <asm-generic/ioctls.h>. Sie gelten für alle Architekturen,
# die asm-generic benutzen — darunter arm64 (Raspberry Pi) und x86-64.
TCGETS2 = 0x802C542A
TCSETS2 = 0x402C542B

# Aus <asm-generic/termbits.h>. BOTHER heisst: "die Rate steht in c_ispeed
# und c_ospeed", statt in den Bits von c_cflag.
BOTHER = 0o010000
CBAUD = 0o010017

# struct termios2 — vier Flag-Wörter, c_line, 19 Steuerzeichen, dann die
# beiden Raten. Zusammen 44 Byte; das passt zur Grössenangabe 0x2C in den
# ioctl-Nummern oben.
TERMIOS2 = "4I B 19B 2I".replace(" ", "")


def setze(pfad: str, rate: int) -> None:
    with open(pfad, "rb+", buffering=0) as f:
        roh = fcntl.ioctl(f, TCGETS2, b"\x00" * struct.calcsize(TERMIOS2))
        felder = list(struct.unpack(TERMIOS2, roh))

        # c_cflag ist Feld 2. Die alten Raten-Bits raus, BOTHER rein.
        felder[2] = (felder[2] & ~CBAUD) | BOTHER
        # Die beiden letzten Felder sind c_ispeed und c_ospeed.
        felder[-2] = rate
        felder[-1] = rate

        fcntl.ioctl(f, TCSETS2, struct.pack(TERMIOS2, *felder))


def main() -> int:
    if len(sys.argv) != 3:
        print(f"Aufruf: {sys.argv[0]} <gerät> <baudrate>", file=sys.stderr)
        return 2
    pfad, rate = sys.argv[1], sys.argv[2]
    try:
        setze(pfad, int(rate))
    except (OSError, ValueError) as fehler:
        # Die Meldung nennt das Gerät. Ohne diese Angabe ist "Permission
        # denied" im Journal nicht von einem falschen Pfad zu unterscheiden.
        print(f"Baudrate {rate} auf {pfad} nicht setzbar: {fehler}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
