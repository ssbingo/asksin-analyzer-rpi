#!/usr/bin/env python3
"""
Baut die Platine vollständig neu — und zwar so lange, bis das Ergebnis
sauber ist.

Hintergrund: Freerouting arbeitet mit Zufallselementen und liefert bei
identischer Eingabe nicht zweimal dasselbe Layout. Meist ist das Ergebnis
fehlerfrei, manchmal bleibt eine Verbindung offen oder ein Bahnende hängt in
der Luft. Statt so ein Layout von Hand nachzubessern (und damit die
Reproduzierbarkeit zu verlieren), wird hier einfach neu gewürfelt.

Ablauf je Versuch:
    generate_pcb.py   Umriss, Bauteile, J1-Geometrieprüfung, Masse-Stützvias
    autoroute.py      Freerouting + Nachrouten + Flächenanbindung
    finish_board.py   Bestückungsdruck, Markierung, Fertigungsunterlagen
    kicad-cli drc     Fehler **und** Warnungen, exit 0 verlangt

Der erste Versuch, der komplett durchgeht, wird behalten. Zusätzlich prüft
verify_netlist.py die Netzliste gegen die Spezifikation.

Aufruf:
    python3 rebuild.py [--versuche N]
"""

from __future__ import annotations

import argparse
import pathlib
import shutil
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent
BOARD = HERE / "AskSin-Analyzer-V3.kicad_pcb"
SICHERUNG = HERE / "AskSin-Analyzer-V3.letzter-guter-stand.kicad_pcb"


def lauf(*cmd: str, still: bool = True) -> tuple[int, str]:
    res = subprocess.run(cmd, cwd=HERE, capture_output=True, text=True,
                         timeout=3600)
    text = res.stdout + res.stderr
    if not still:
        print(text.rstrip())
    return res.returncode, text


def versuch(nr: int) -> tuple[bool, str]:
    code, text = lauf(sys.executable, "generate_pcb.py")
    if code != 0:
        return False, f"generate_pcb: {text.strip().splitlines()[-1]}"

    code, text = lauf(sys.executable, "autoroute.py")
    if code != 0:
        return False, f"autoroute: {text.strip().splitlines()[-1]}"
    fehlend = [z.strip() for z in text.splitlines() if "kein Anschluss" in z]

    code, text = lauf(sys.executable, "finish_board.py")
    if code != 0:
        return False, f"finish_board: {text.strip().splitlines()[-1]}"

    code, text = lauf("kicad-cli", "pcb", "drc",
                      "--severity-error", "--severity-warning",
                      "--exit-code-violations", "-o", "drc.rpt", str(BOARD))
    if code != 0:
        zeilen = [z for z in (HERE / "drc.rpt").read_text().splitlines()
                  if z.startswith("[")]
        kurz = "; ".join(sorted({z.split(":")[0].strip("[]") for z in zeilen}))
        return False, f"DRC: {len(zeilen)} Verstoß/Verstöße ({kurz})"

    if fehlend:
        return False, f"{len(fehlend)} Massepad(s) ohne Stützvia"

    # Netzliste **frisch** exportieren, bevor sie geprüft wird. Vorher lief die
    # Prüfung gegen die zuletzt abgelegte netlist.net — nach einer Änderung am
    # Schaltplan verglich sie damit gegen einen veralteten Stand und hätte eine
    # echte Abweichung verschleiern können.
    code, text = lauf("kicad-cli", "sch", "export", "netlist",
                      "--output", str(HERE / "netlist.net"),
                      str(HERE / "AskSin-Analyzer-V3.kicad_sch"))
    if code != 0:
        return False, "Netzlisten-Export fehlgeschlagen"

    code, text = lauf(sys.executable, "verify_netlist.py")
    if code != 0 or "stimmt exakt" not in text:
        return False, "Netzliste weicht von der Spezifikation ab"

    return True, "DRC 0/0, Netzliste exakt, alle Massepads angebunden"


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--versuche", type=int, default=8)
    args = p.parse_args()

    for nr in range(1, args.versuche + 1):
        print(f"Versuch {nr}/{args.versuche} …", flush=True)
        ok, meldung = versuch(nr)
        print(f"  {meldung}")
        if ok:
            shutil.copy(BOARD, SICHERUNG)
            print(f"\nFertig nach {nr} Versuch(en). "
                  f"Sicherungskopie: {SICHERUNG.name}")
            return 0

    print(f"\nNach {args.versuche} Versuchen kein sauberes Ergebnis. "
          "Das deutet auf ein echtes Layoutproblem hin, nicht auf Streuung.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
