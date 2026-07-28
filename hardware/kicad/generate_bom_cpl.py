#!/usr/bin/env python3
"""
Erzeugt BOM- und Pick-&-Place-Datei (CPL) aus der **gerouteten Platine**.

Arbeitet ausschließlich lesend auf der Platinendatei — die ist in Produktion
und wird von diesem Skript unter keinen Umständen verändert.

Ausgabeformat nach der verbreiteten Bestücker-Konvention (JLCPCB u. a.):

  fab/bom.csv   Comment · Designator · Footprint · Quantity  (+ Bezugsquelle)
  fab/cpl.csv   Designator · Mid X · Mid Y · Layer · Rotation

Koordinaten: Ursprung in der **linken unteren Platinenecke**, X nach rechts,
Y nach oben, Millimeter — so erwarten es die gängigen Bestücker. KiCads
Positionsexport liefert dagegen Blattkoordinaten; die Umrechnung passiert hier.

Ausgelassen werden:
  * R5 — laut Schaltplan unbestückt (0-Ω-Alternative für die SPI-Variante der
    WS2812-Ansteuerung; bestückt wird R4 **oder** R5)
  * TP1–TP8, MH1–MH4, KB1/KB2 — Pads und Bohrungen ohne Bauteil

Hinweis Drehwinkel: Die Werte folgen der KiCad-Konvention (Winkel der
Footprint-Definition). Bestücker haben teils abweichende Nulllagen je Gehäuse
(bekannt bei SOT-23 und gedrehten ICs) und korrigieren das in ihrer
Eingangsprüfung — bei Handbestückung ohnehin belanglos.

Aufruf:
    python3 generate_bom_cpl.py
"""

from __future__ import annotations

import csv
import pathlib
import sys

import pcbnew

from generate_schematic import PROJECT

HERE = pathlib.Path(__file__).resolve().parent
BOARD_FILE = HERE / f"{PROJECT}.kicad_pcb"
FAB_DIR = HERE / "fab"

# Ursprung und Höhe der Platine in Blattkoordinaten (aus generate_pcb.py).
ORIGIN_X, ORIGIN_Y = 100.0, 60.0
BOARD_H = 46.0

DNP = {"R5"}
VIRTUAL_PREFIXES = ("TP", "MH", "KB")

# Bezugsquellen aus der geprüften Bestellliste (../bestellliste-reichelt.md).
SOURCE = {
    "U1": "Reichelt MCP 1754-3302CB",
    "U2": "Reichelt ATMEGA 328P-AU",
    "U3": "Ebyte E07-900M10S — nicht bei Reichelt",
    "Y1": "Reichelt CST 8,00",
    "J1": "Reichelt MPE 094-2-040",
    "J2": "Reichelt ECON SL6G2",
    "J5": "Reichelt JST PH4P ST",
    "J6": "Reichelt JST PH2P ST",
    "J7": "Reichelt JST PH3P ST",
    "L1": "Reichelt BLM21PG300SN1D",
    "D1": "Reichelt EVL 17-21USRC",
    "S1": "Omron B3U-1000P — nicht bei Reichelt",
    "R1": "Reichelt WAL WR08X3300FTL",
    "R4": "Reichelt WAL WR08X3900FTL",
    "R2": "Reichelt WAL WR08X1002FTL",
    "R3": "Reichelt WAL WR08X1002FTL",
    "C1": "Reichelt CL21A106KOQNNNG",
    "C2": "Reichelt CL21A106KOQNNNG",
    "C3": "Reichelt KEM X7R0805 100N",
    "C4": "Reichelt KEM X7R0805 100N",
    "C5": "Reichelt KEM X7R0805 100N",
    "C8": "Reichelt KEM X7R0805 100N",
    "C9": "Reichelt KEM X7R0805 100N",
}


# ---------------------------------------------------------------- JLCPCB
#
# Zuordnung für die Bestückung bei JLCPCB, recherchiert am 28.07.2026.
# Nur SMD — die bedrahteten Teile (J1, J2, J5–J7, Y1) werden von Hand bestückt,
# ebenso das Funkmodul U3: das führt der JLCPCB-Katalog nicht.
#
# „Basic“ nach der Basic-Parts-Momentaufnahme; der verbindliche Status steht
# erst im Bestellportal (Extended kostet je Position Einrichtungsgebühr).
JLC = {
    # ref: (LCSC-Nummer, MPN/Kommentar, Basic laut Momentaufnahme)
    # Kommentare bewusst ohne Kommas — der BOM-Parser des Portals ist bei
    # Sonderzeichen wählerisch. Begründungen stehen in der LIESMICH.
    "U1": ("C5446", "XC6206P332MR-G", True),
    "U2": ("C14877", "ATMEGA328P-AU", False),
    "S1": ("C231330", "B3U-1000P-B", False),
    "L1": ("C16903", "BLM21PG300SN1D", False),
    "D1": ("C84256", "FC-2012HRK-620D rot", True),
    "R1": ("C17630", "330R 1% 0805", True),
    "R2": ("C17414", "10K 1% 0805", True),
    "R3": ("C17414", "10K 1% 0805", True),
    "R4": ("C17655", "390R 1% 0805", True),
    "C1": ("C15850", "CL21A106KAYNNNE 10uF 25V X5R", True),
    "C2": ("C15850", "CL21A106KAYNNNE 10uF 25V X5R", True),
    "C3": ("C49678", "CC0805KRX7R9BB104 100nF 50V X7R", True),
    "C4": ("C49678", "CC0805KRX7R9BB104 100nF 50V X7R", True),
    "C5": ("C49678", "CC0805KRX7R9BB104 100nF 50V X7R", True),
    "C8": ("C49678", "CC0805KRX7R9BB104 100nF 50V X7R", True),
    "C9": ("C49678", "CC0805KRX7R9BB104 100nF 50V X7R", True),
}

# SMD, aber nicht im JLCPCB-Katalog — bleibt Handbestückung.
JLC_HAND = {"U3": "E07-900M10S: nicht im JLCPCB-Katalog, Halbloecher "
                  "von Hand loeten"}


def write_jlc_bom(rows: list[dict]) -> int:
    """BOM im JLCPCB-Format: Comment · Designator · Footprint · JLCPCB Part #"""
    groups: dict[str, list[dict]] = {}
    for row in rows:
        if row["ref"] in DNP or row["tht"] or row["ref"] in JLC_HAND:
            continue
        if row["ref"] not in JLC:
            raise SystemExit(f"{row['ref']}: SMD, aber keine JLCPCB-Zuordnung")
        groups.setdefault(JLC[row["ref"]][0], []).append(row)

    out = FAB_DIR / "jlcpcb_bom.csv"
    with out.open("w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["Comment", "Designator", "Footprint", "JLCPCB Part #"])
        for lcsc, members in sorted(groups.items(),
                                    key=lambda kv: kv[1][0]["ref"]):
            refs = ",".join(m["ref"] for m in members)
            w.writerow([JLC[members[0]["ref"]][1], refs,
                        members[0]["footprint"], lcsc])
    return len(groups)


def write_jlc_cpl(rows: list[dict]) -> int:
    """Pick-&-Place im JLCPCB-Format, nur die dort bestückten Teile."""
    out = FAB_DIR / "jlcpcb_cpl.csv"
    n = 0
    with out.open("w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["Designator", "Mid X", "Mid Y", "Layer", "Rotation"])
        for row in rows:
            if row["ref"] in DNP or row["tht"] or row["ref"] in JLC_HAND:
                continue
            w.writerow([row["ref"], f"{row['x']}mm", f"{row['y']}mm",
                        row["layer"], row["rot"]])
            n += 1
    return n


def is_virtual(ref: str) -> bool:
    return any(ref.startswith(p) and ref[len(p):].isdigit()
               for p in VIRTUAL_PREFIXES)


def collect(board) -> list[dict]:
    rows = []
    for fp in board.GetFootprints():
        ref = fp.GetReference()
        if is_virtual(ref):
            continue
        pos = fp.GetPosition()
        x = pcbnew.ToMM(pos.x) - ORIGIN_X
        y_down = pcbnew.ToMM(pos.y) - ORIGIN_Y
        rows.append({
            "ref": ref,
            "value": fp.GetValue(),
            "footprint": str(fp.GetFPID().GetLibItemName()),
            "x": round(x, 4),
            "y": round(BOARD_H - y_down, 4),      # Ursprung unten links, Y nach oben
            "rot": round(fp.GetOrientationDegrees(), 1) % 360,
            "layer": "top" if fp.GetLayer() == pcbnew.F_Cu else "bottom",
            "smd": fp.GetAttributes() & pcbnew.FP_SMD != 0,
            "tht": any(p.GetAttribute() == pcbnew.PAD_ATTRIB_PTH
                       for p in fp.Pads()),
        })
    return sorted(rows, key=lambda r: (r["ref"][0], int("".join(
        c for c in r["ref"] if c.isdigit()) or 0)))


def write_bom(rows: list[dict]) -> int:
    groups: dict[tuple[str, str], list[dict]] = {}
    for row in rows:
        if row["ref"] in DNP:
            continue
        groups.setdefault((row["value"], row["footprint"]), []).append(row)

    out = FAB_DIR / "bom.csv"
    with out.open("w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["Comment", "Designator", "Footprint", "Quantity",
                    "Mounting", "Source"])
        for (value, footprint), members in sorted(
                groups.items(), key=lambda kv: kv[1][0]["ref"]):
            refs = ",".join(m["ref"] for m in members)
            mount = "THT" if members[0]["tht"] else "SMD"
            src = SOURCE.get(members[0]["ref"], "")
            w.writerow([value, refs, footprint, len(members), mount, src])
        # DNP dokumentieren statt verschweigen — sonst sucht beim Bestücken
        # jemand nach dem fehlenden Bauteil für die R5-Pads.
        for row in rows:
            if row["ref"] in DNP:
                w.writerow([row["value"], row["ref"], row["footprint"], 0,
                            "DNP", "nicht bestücken (Alternative zu R4)"])
    return len(groups)


def write_cpl(rows: list[dict]) -> int:
    out = FAB_DIR / "cpl.csv"
    n = 0
    with out.open("w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["Designator", "Mid X", "Mid Y", "Layer", "Rotation"])
        for row in rows:
            if row["ref"] in DNP:
                continue
            w.writerow([row["ref"], f"{row['x']}mm", f"{row['y']}mm",
                        row["layer"], row["rot"]])
            n += 1
    return n


def main() -> int:
    board = pcbnew.LoadBoard(str(BOARD_FILE))
    FAB_DIR.mkdir(exist_ok=True)
    rows = collect(board)
    groups = write_bom(rows)
    placed = write_cpl(rows)
    jlc_groups = write_jlc_bom(rows)
    jlc_placed = write_jlc_cpl(rows)
    basics = sum(1 for v in set(JLC.values()) if v[2])
    print(f"fab/bom.csv        : {groups} Positionen (+ R5 als DNP dokumentiert)")
    print(f"fab/cpl.csv        : {placed} Bauteile, Ursprung unten links, Y aufwärts")
    print(f"fab/jlcpcb_bom.csv : {jlc_groups} Positionen, davon {basics} Basic")
    print(f"fab/jlcpcb_cpl.csv : {jlc_placed} Bauteile (nur JLCPCB-Bestückung)")
    for ref, why in JLC_HAND.items():
        print(f"  Handbestückung bleibt: {ref} — {why}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
