#!/usr/bin/env python3
"""Jeder benutzte Strom eines Kindprozesses braucht einen Fehler-Zuhörer.

    python3 tools/pruefe-stroeme.py

Warum es diese Prüfung gibt
---------------------------
Ein `error`-Ereignis auf einem Node-Strom ohne Zuhörer wird zur unbehandelten
Ausnahme und beendet den Prozess. Bei einem Kindprozess ist das kein Randfall,
sondern der Normalfall beim Herunterfahren: systemd schickt SIGTERM an die
ganze Kontrollgruppe, also auch an den Helfer. Wer danach noch einmal in
dessen Standardeingabe schreibt, bekommt EPIPE.

Genau so passiert, zweimal:

  * 10.08.2026 — `sttyPort.ts`, Leser und Schreiber auf dem seriellen Port.
    Dort steht seitdem ein Kommentar, der davor warnt.
  * 13.08.2026 — `anzeige.ts`, die Standardeingabe des WS2812-Helfers. Beim
    Stoppen des Dienstes stand fortan jedes Mal im Protokoll:

        FEHLER [absturz] Unbehandelte Ausnahme: Error: write EPIPE

Ein Kommentar hat es nicht verhindert. Diese Prüfung tut es.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

WURZEL = Path(__file__).resolve().parent.parent
QUELLEN = [WURZEL / "core/src", WURZEL / "core/bin"]

# Benutzung eines Stroms: geschrieben, gelesen oder abonniert.
BENUTZT = re.compile(r"\.(stdin|stdout|stderr)\s*\.\s*(write|on|setEncoding|pipe)\b")
# Der Zuhörer, auf den es ankommt.
ZUHOERER = re.compile(r"\.(stdin|stdout|stderr)\s*\.\s*on\(\s*['\"]error['\"]")
# Wird der Strom nur weitergereicht (as AsyncIterable), gilt er als benutzt.
DURCHGEREICHT = re.compile(r"\.(stdin|stdout|stderr)\s+as\b")


def pruefe(datei: Path) -> list[str]:
    text = datei.read_text(encoding="utf-8")
    if "spawn(" not in text:
        return []

    code = "\n".join(
        z for z in text.splitlines()
        if not z.lstrip().startswith(("//", "*", "/*"))
    )
    benutzt = {m.group(1) for m in BENUTZT.finditer(code)}
    benutzt |= {m.group(1) for m in DURCHGEREICHT.finditer(code)}
    behuetet = {m.group(1) for m in ZUHOERER.finditer(code)}

    rel = datei.relative_to(WURZEL)
    return [
        f"{rel}: {strom} wird benutzt, hat aber kein .on('error', …). "
        "Ein Fehler darauf beendet den ganzen Dienst — beim Stoppen ist "
        "EPIPE der Normalfall, nicht die Ausnahme"
        for strom in sorted(benutzt - behuetet)
    ]


def main() -> int:
    fehler: list[str] = []
    geprueft = 0
    for wurzel in QUELLEN:
        for datei in sorted(wurzel.rglob("*.ts")):
            treffer = pruefe(datei)
            if "spawn(" in datei.read_text(encoding="utf-8"):
                geprueft += 1
            fehler.extend(treffer)

    if fehler:
        print("Stroeme ohne Fehler-Zuhoerer:")
        for f in fehler:
            print(f"  - {f}")
        return 1
    print(
        f"Stroeme in Ordnung — {geprueft} Datei(en) mit spawn(), "
        "jeder benutzte Strom hat einen Fehler-Zuhoerer."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
