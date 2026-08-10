#!/usr/bin/env python3
"""Beide Seiten einer Austauschdatei müssen denselben Ort meinen.

    python3 tools/pruefe-austauschdateien.py

Warum es diese Prüfung gibt
---------------------------
Die Dienste reichen sich Werte über Dateien weiter: der Core schreibt, ein
Python-Helfer liest. Der Core wählt sein Laufzeitverzeichnis beim Start —
bevorzugt `/run/asksin-analyzer` (tmpfs, schont die SSD), und nur wenn er dort
nicht schreiben darf, das Datenverzeichnis `/var/lib/asksin-analyzer`.

Kennt ein Helfer nur den Ausweichpfad, sieht er im Normalbetrieb eine Datei,
die es nie gibt. Beide Seiten arbeiten fehlerfrei, keine meldet etwas, und
das Ergebnis ist tote Hardware.

Am 10.08.2026 zweimal am selben Tag passiert:

  * `led-pwm.py` las `/var/lib/asksin-analyzer/led-farbe`, der Core schrieb
    nach `/run/asksin-analyzer/led-farbe`. Status-LED dunkel auf dem Pi 3.
  * `asksin-analyzer-led.service` deklarierte `RuntimeDirectory=`, lief aber
    als root — systemd setzte das gemeinsame Verzeichnis bei jedem Start auf
    root:root, und der unprivilegierte Core bekam EACCES.

Diese Prüfung findet beides, ohne dass jemand einen Pi anfassen muss.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

WURZEL = Path(__file__).resolve().parent.parent
CORE = WURZEL / "core/bin/analyzerd.ts"
DEPLOY = WURZEL / "deploy"
LAUFZEIT = "/run/asksin-analyzer"

# Dienste, die als root laufen (kein User= in der Unit) und deshalb kein
# RuntimeDirectory= fuer das gemeinsame Verzeichnis deklarieren duerfen.
GEMEINSAM = "asksin-analyzer"


def austauschdateien() -> list[str]:
    """Namen, die der Core in sein Laufzeitverzeichnis legt."""
    text = CORE.read_text(encoding="utf-8")
    return sorted(set(re.findall(r"join\(laufzeitDir,\s*'([^']+)'\)", text)))


def pruefe_pfade() -> list[str]:
    fehler: list[str] = []
    namen = austauschdateien()
    if not namen:
        return [f"{CORE.name}: keine join(laufzeitDir, ...) gefunden — hat "
                "sich der Name des Laufzeitverzeichnisses geaendert?"]

    for helfer in sorted(DEPLOY.glob("*.py")):
        text = helfer.read_text(encoding="utf-8")
        # Nur Code betrachten: In Kommentaren darf der alte Pfad als
        # Begruendung stehen bleiben, ohne die Pruefung auszuloesen.
        code = "\n".join(
            z for z in text.splitlines() if not z.lstrip().startswith("#")
        )
        for name in namen:
            if name not in code:
                continue                      # dieser Helfer nutzt sie nicht
            if f"{LAUFZEIT}/{name}" in code:
                continue                      # kennt den bevorzugten Ort
            # Auch in Ordnung: Der Helfer setzt den Ort aus einer Liste von
            # Verzeichnissen zusammen, in der /run vorkommt.
            if LAUFZEIT in code:
                continue
            fehler.append(
                f"deploy/{helfer.name} verwendet {name}, kennt aber "
                f"{LAUFZEIT}/ nicht — der Core schreibt im Normalbetrieb "
                "genau dorthin, und der Helfer wartet auf eine Datei, die "
                "es nie gibt"
            )
    return fehler


def pruefe_runtimedirectory() -> list[str]:
    fehler: list[str] = []
    for unit in sorted(DEPLOY.glob("*.service")):
        text = unit.read_text(encoding="utf-8")
        code = "\n".join(
            z for z in text.splitlines() if not z.lstrip().startswith("#")
        )
        if f"RuntimeDirectory={GEMEINSAM}" not in code:
            continue
        if re.search(r"^User=", code, re.MULTILINE):
            continue                          # laeuft unprivilegiert, passt
        fehler.append(
            f"deploy/{unit.name} deklariert RuntimeDirectory={GEMEINSAM}, "
            "laeuft aber als root (kein User=). systemd setzt Eigentuemer "
            "und Rechte bei JEDEM Start neu — das Verzeichnis wird damit "
            "root:root, und die Dienste des Benutzers asksin bekommen "
            "EACCES. Zeile entfernen: angelegt wird es von "
            "asksin-analyzer.service"
        )
    return fehler


def main() -> int:
    fehler = pruefe_pfade() + pruefe_runtimedirectory()
    if fehler:
        print("Austauschdateien passen nicht zusammen:")
        for f in fehler:
            print(f"  - {f}")
        return 1
    namen = austauschdateien()
    print(
        f"Austauschdateien in Ordnung — {len(namen)} Datei(en) "
        f"({', '.join(namen)}), jeder Helfer kennt {LAUFZEIT}/, "
        "kein Root-Dienst nimmt das gemeinsame Verzeichnis in Besitz."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
