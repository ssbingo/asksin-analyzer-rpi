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
import time
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
    # Beim Laden des Moduls schickt der Kernel seinen gesamten Ringpuffer auf
    # einmal — rund 500 Pakete in wenigen Millisekunden. Einmal ging dabei ein
    # kompletter Bootvorgang verloren, und ausgerechnet der Start NACH einem
    # Ausfall ist das, was man hinterher lesen will. UDP wiederholt nichts;
    # was nicht hineinpasst, ist endgueltig weg.
    #
    # Ein grosser Empfangspuffer allein reicht nicht: net.core.rmem_max kappt
    # den Wunsch stillschweigend (oft bei 208 KiB). Deshalb zusaetzlich —
    # und wichtiger — moeglichst wenig Arbeit pro Paket, siehe Schleife unten.
    try:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 8 << 20)
    except OSError:
        pass
    s.bind((args.adresse, args.port))
    # Kurzer Zeitablauf, damit Strg-C nicht erst beim nächsten Paket wirkt.
    s.settimeout(1.0)

    ziel = Path(args.datei)
    with ziel.open("a", encoding="utf8", errors="replace") as f:
        start = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        puffer = s.getsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF)
        kopf = (f"===== Empfänger gestartet {start}, Port {args.port}, "
                f"Puffer {puffer // 1024} KiB =====\n")
        f.write(kopf)
        f.flush()
        print(kopf.strip(), flush=True)

        letzter = ""
        # In der Empfangsschleife wird NUR empfangen und angehaengt. Jede
        # weitere Arbeit — Zeitstempel formatieren, dekodieren, schreiben —
        # kostete im Schwall beim Modulstart so viel Zeit, dass der
        # Empfangspuffer ueberlief und Pakete verlorengingen. Ein Test mit 800
        # Paketen am Stueck kam so auf 681. Verarbeitet wird jetzt in der
        # Ruhepause, und die kommt nach jedem Schwall.
        eingang: list[tuple[float, bytes, str]] = []

        def verarbeiten() -> None:
            nonlocal letzter
            if not eingang:
                return
            for zeit, daten, quelle in eingang:
                jetzt = datetime.fromtimestamp(zeit).strftime("%H:%M:%S.%f")[:-3]
                if quelle != letzter:
                    letzter = quelle
                    f.write(f"--- Sender: {quelle} ---\n")
                for zeile in daten.decode("utf8", "replace").splitlines():
                    if zeile.strip():
                        f.write(f"{jetzt}  {zeile}\n")
            eingang.clear()
            f.flush()

        while laeuft:
            try:
                daten, absender = s.recvfrom(65535)
            except socket.timeout:
                verarbeiten()          # Ruhe: jetzt ist Zeit zum Speichern
                continue
            except OSError as e:
                verarbeiten()
                print(f"Fehler beim Empfang: {e}", file=sys.stderr, flush=True)
                break
            eingang.append((time.time(), daten, absender[0]))
            # Notbremse gegen unbegrenztes Wachstum, falls nie Ruhe einkehrt.
            if len(eingang) > 20000:
                verarbeiten()

        verarbeiten()
        ende = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        f.write(f"===== Empfänger beendet {ende} =====\n")

    s.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
