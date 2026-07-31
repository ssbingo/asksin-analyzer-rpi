#!/usr/bin/env python3
"""
Fängt die Kernel-Meldungen eines Analyzers auf, der per netconsole sendet.

Warum das nötig ist: Bei einem harten Ausfall schafft es der Pi nicht mehr,
seine letzten Zeilen auf die Platte zu schreiben. Das Journal bricht mitten im
Satz ab oder ist beschädigt — genau die interessanten Sekunden fehlen. Über
netconsole schickt der Kernel jede Meldung zusätzlich als UDP-Paket ins Netz,
noch bevor irgendein Dateisystem beteiligt ist. Was hier ankommt, ist deshalb
der letzte Stand vor dem Ausfall.

Jede Zeile bekommt einen Zeitstempel des **empfangenden** Rechners. Der ist
entscheidend: Steht die letzte Meldung eine Minute vor dem Ausfall, war es
still — dann fiel Strom oder Hardware aus. Kommt bis zur letzten Millisekunde
etwas an, hat der Kernel noch geredet, und es steht dort, worüber.

Aufruf:
    python3 netconsole-empfaenger.py [--port 6666] [--datei kernel.log]

Beenden mit Strg-C. Die Datei wird fortgeschrieben, nie überschrieben — ein
Neustart des Empfängers verliert also nichts.
"""

from __future__ import annotations

import argparse
import signal
import socket
import sys
from datetime import datetime
from pathlib import Path

laeuft = True


def halt(_signum: int, _rahmen: object) -> None:
    global laeuft
    laeuft = False


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--port", type=int, default=6666)
    ap.add_argument("--datei", default="kernel.log")
    ap.add_argument("--adresse", default="0.0.0.0",
                    help="Lauschadresse; Vorgabe: alle Schnittstellen")
    args = ap.parse_args()

    signal.signal(signal.SIGINT, halt)
    signal.signal(signal.SIGTERM, halt)

    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind((args.adresse, args.port))
    # Kurzer Zeitablauf, damit Strg-C nicht erst beim nächsten Paket wirkt.
    s.settimeout(1.0)

    ziel = Path(args.datei)
    with ziel.open("a", encoding="utf8", errors="replace") as f:
        start = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        kopf = f"===== Empfänger gestartet {start}, Port {args.port} =====\n"
        f.write(kopf)
        f.flush()
        print(kopf.strip(), flush=True)

        letzter = ""
        while laeuft:
            try:
                daten, absender = s.recvfrom(65535)
            except socket.timeout:
                continue
            except OSError as e:
                print(f"Fehler beim Empfang: {e}", file=sys.stderr, flush=True)
                break

            jetzt = datetime.now().strftime("%H:%M:%S.%f")[:-3]
            if absender[0] != letzter:
                # Woher es kommt, nur beim Wechsel — sonst steht es hundertmal
                # in derselben Datei und verdeckt den Inhalt.
                letzter = absender[0]
                f.write(f"--- Sender: {absender[0]} ---\n")

            for zeile in daten.decode("utf8", "replace").splitlines():
                if zeile.strip():
                    f.write(f"{jetzt}  {zeile}\n")
            # Sofort auf die Platte: Der Sinn der Übung ist, dass nichts
            # verlorengeht, wenn es unerwartet endet — hier wie dort.
            f.flush()

        ende = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        f.write(f"===== Empfänger beendet {ende} =====\n")

    s.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
