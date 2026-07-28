#!/usr/bin/env python3
"""
Prüft die von KiCad exportierte Netzliste gegen die Soll-Netzliste aus
`generate_schematic.py`.

Das ist die eigentliche Absicherung: der Generator kann eine formal gültige
Datei schreiben, die trotzdem falsch verdrahtet ist. Erst der Rückweg über
KiCads eigenen Netzlisten-Export beweist, dass die Stiche und Labels wirklich
die gemeinte Verbindung ergeben.

Aufruf:
    kicad-cli sch export netlist --output netlist.net AskSin-Analyzer-V3.kicad_sch
    python3 verify_netlist.py netlist.net
"""

from __future__ import annotations

import pathlib
import re
import sys

from generate_schematic import COMPONENTS, NETS, NO_CONNECT, PROJECT, parse_sexp

HERE = pathlib.Path(__file__).resolve().parent


def load_export(path: pathlib.Path) -> dict[str, list[tuple[str, str]]]:
    root = parse_sexp(path.read_text())[0]
    nets: dict[str, list[tuple[str, str]]] = {}
    for section in root:
        if not (isinstance(section, list) and section[0] == "nets"):
            continue
        for net in section[1:]:
            name, nodes = None, []
            for field in net:
                if isinstance(field, list) and field[0] == "name":
                    name = field[1].strip('"')
                if isinstance(field, list) and field[0] == "node":
                    ref = pin = None
                    for sub in field:
                        if isinstance(sub, list) and sub[0] == "ref":
                            ref = sub[1].strip('"')
                        if isinstance(sub, list) and sub[0] == "pin":
                            pin = sub[1].strip('"')
                    nodes.append((ref, pin))
            # KiCad stellt lokalen Labels den Sheet-Pfad voran; globale
            # Versorgungsnetze bleiben ohne Präfix.
            nets[name.lstrip("/")] = sorted(nodes)
    return nets


def load_footprints(path: pathlib.Path) -> dict[str, str]:
    """Bauteil → Footprint aus dem Netzlisten-Export."""
    root = parse_sexp(path.read_text())[0]
    out = {}
    for section in root:
        if not (isinstance(section, list) and section[0] == "components"):
            continue
        for comp in section[1:]:
            ref = fp = None
            for field in comp:
                if isinstance(field, list) and field[0] == "ref":
                    ref = field[1].strip('"')
                if isinstance(field, list) and field[0] == "footprint":
                    fp = field[1].strip('"')
            if ref:
                out[ref] = fp or ""
    return out


def board_footprints(path: pathlib.Path) -> dict[str, str]:
    """Bauteil → Footprint aus der Platinendatei, ohne pcbnew zu laden."""
    text = path.read_text()
    out = {}
    for match in re.finditer(
            r'\(footprint "([^"]+)".*?\(property "Reference" "([^"]+)"',
            text, re.S):
        out[match.group(2)] = match.group(1)
    return out


def check_footprints() -> int:
    """Schaltplan und Platine müssen dieselben Footprints führen.

    Der Netzlistenvergleich fängt das nicht: Footprints sind nicht Teil der
    Netzliste. Genau dadurch blieb unbemerkt, dass die Schaltplandatei noch
    JST-XH führte, während die Platine längst auf JST-PH stand — und die
    Stückliste damit falsche Steckverbinder auswies.
    """
    board = HERE / f"{PROJECT}.kicad_pcb"
    net = HERE / "netlist.net"
    if not board.exists() or not net.exists():
        return 0
    sch = load_footprints(net)
    pcb = board_footprints(board)
    problems = 0
    for ref, fp in sorted(sch.items()):
        on_board = pcb.get(ref)
        if on_board is None:
            continue                      # Prüfpunkte o. ä. ohne Platinenpendant
        if fp.split(":")[-1] != on_board.split(":")[-1]:
            print(f"FOOTPRINT    {ref}: Schaltplan {fp} · Platine {on_board}")
            problems += 1
    return problems


def main() -> int:
    path = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "netlist.net")
    if not path.exists():
        print(f"Netzliste {path} fehlt — erst kicad-cli sch export netlist laufen lassen.")
        return 2

    exported = load_export(path)
    unconnected = {n: v for n, v in exported.items() if n.startswith("unconnected-")}
    named = {n: v for n, v in exported.items() if not n.startswith("unconnected-")}

    problems = 0
    for net, pins in NETS.items():
        expected, got = sorted(pins), named.get(net)
        if got is None:
            print(f"FEHLT        {net}")
            problems += 1
        elif got != expected:
            missing = sorted(set(expected) - set(got))
            extra = sorted(set(got) - set(expected))
            print(f"ABWEICHUNG   {net}")
            if missing:
                print(f"               fehlt : {missing}")
            if extra:
                print(f"               zuviel: {extra}")
            problems += 1

    for net in sorted(set(named) - set(NETS)):
        print(f"UNERWARTET   {net}: {named[net]}")
        problems += 1

    problems += check_footprints()

    if len(unconnected) != len(NO_CONNECT):
        print(f"NO-CONNECT   erwartet {len(NO_CONNECT)}, exportiert {len(unconnected)}")
        problems += 1

    print()
    print(f"Bauteile   : {len(COMPONENTS)}")
    print(f"Netze      : {len(named)} benannt, {len(unconnected)} bewusst offen")
    print(f"Anschlüsse : {sum(len(p) for p in NETS.values())}")
    print()
    if problems:
        print(f"{problems} Abweichung(en) gegenüber der Spezifikation.")
        return 1
    print("Netzliste stimmt exakt mit der Spezifikation überein.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
