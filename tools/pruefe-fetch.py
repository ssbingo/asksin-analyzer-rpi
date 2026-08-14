#!/usr/bin/env python3
"""`fetch` nur an einer Stelle — sonst bleiben Antworten liegen.

    python3 tools/pruefe-fetch.py

Warum es diese Prüfung gibt
---------------------------
Wer eine Antwort holt und ihren Körper nicht liest, gibt sie nicht frei.
Undici hält die Verbindung samt gepuffertem Körper fest, bis er gelesen oder
verworfen wurde. Dem Aufrufer sieht man das nicht an: Der Code wirkt
vollständig, es fehlt nur der Satz, der nicht dasteht — und besonders gern
fehlt er im **Fehlerpfad**, wo vor dem Lesen geworfen wird.

Am 13.08.2026 lagen im Core sechs solche Stellen, davon eine im 30-Sekunden-
Takt (InfluxDB). Der Speicher des Dienstes wuchs dadurch auf Analyzer 01 um
rund 9 MB je Stunde — gleichmäßig, unabhängig von Last und Telegrammen.

Statt an sechs Stellen daran zu denken, gibt es jetzt einen Weg nach draußen:
`core/src/net/holen.ts`. Der liest den Körper immer zu Ende. Diese Prüfung
sorgt dafür, dass daneben kein zweiter entsteht.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

WURZEL = Path(__file__).resolve().parent.parent
QUELLEN = [WURZEL / "core/src", WURZEL / "core/bin"]
ERLAUBT = WURZEL / "core/src/net/holen.ts"

# `fetch(` als Aufruf — nicht als Teil eines längeren Namens (httpFetchJson,
# this.#fetch(, fetchBytes) und nicht in einer Typangabe.
AUFRUF = re.compile(r"(?<![\w.#$])fetch\s*\(")


def main() -> int:
    fehler: list[str] = []
    for wurzel in QUELLEN:
        for datei in sorted(wurzel.rglob("*.ts")):
            if datei == ERLAUBT:
                continue
            for nr, zeile in enumerate(datei.read_text(encoding="utf-8").splitlines(), 1):
                nackt = zeile.strip()
                if nackt.startswith(("//", "*", "/*")):
                    continue
                if AUFRUF.search(zeile):
                    fehler.append(
                        f"{datei.relative_to(WURZEL)}:{nr} ruft fetch() direkt auf — "
                        "über holen() aus core/src/net/holen.ts gehen, sonst bleibt "
                        "die Antwort liegen (besonders im Fehlerpfad)"
                    )

    if fehler:
        print("Direkte fetch-Aufrufe:")
        for f in fehler:
            print(f"  - {f}")
        return 1

    if not ERLAUBT.exists():
        print(f"{ERLAUBT.relative_to(WURZEL)} fehlt — der einzige erlaubte Weg.")
        return 1
    print(
        "fetch in Ordnung — der einzige Aufruf steht in "
        f"{ERLAUBT.relative_to(WURZEL)} und liest den Körper immer zu Ende."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
