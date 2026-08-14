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
  * R4 — seit 30.07.2026 unbestückt: die Analyzer-Software steuert die
    WS2812 auf dem Pi 5 über SPI, bestückt wird deshalb R5 (330 Ω, GPIO10).
    R4 (390 Ω, PWM/GPIO18) bleibt als Alternative für Pi 3/4 auf der Platine —
    bestückt wird immer genau einer von beiden
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
import generate_pcb as G
from generate_schematic import COMPONENTS

ORIGIN_X, ORIGIN_Y = G.ORIGIN_X, G.ORIGIN_Y
BOARD_H = G.LEG_Y1          # Gesamthöhe inkl. Schenkel — Ursprung unten links

# Unbestückte Plätze werden **aus dem Schaltplan abgeleitet**, nicht von Hand
# gepflegt: Ein Wert, der „DNP" enthält, gilt als nicht zu bestücken.
#
# Warum das wichtig ist: Bis zum 31.07.2026 stand hier `DNP = {"R4"}` — ein
# Überbleibsel aus der Zeit, als R4 die unbestückte PWM-Alternative zu R5 war.
# Nach dem Umbau auf den Schiebeschalter wurde R4 zum einzigen
# Serienwiderstand der LED-Datenleitung, die Liste blieb aber stehen. Folge:
# R4 fehlte in BOM und CPL. Eine von Hand gepflegte Liste driftet; eine
# abgeleitete kann es nicht.
DNP = {ref for ref, (_lib, wert, *_rest) in COMPONENTS.items()
       if "DNP" in wert.upper()}

WERT_KORREKTUR: dict[str, str] = {}
VIRTUAL_PREFIXES = ("TP", "MH", "KB")

# Bezugsquellen aus der geprüften Bestellliste (../bestellliste-reichelt.md).
SOURCE = {
    "U1": "Reichelt MCP 1754-3302CB",
    "U2": "Reichelt ATMEGA 328P-AU",
    "U3": "Ebyte E07-900M10S — nicht bei Reichelt",
    "Y1": "JLCPCB C83707 (CSTLS8M00G53-B0)",
    "J1": "Reichelt MPE 094-2-040",
    "J2": "Reichelt ECON SL6G2",
    "J5": "Reichelt JST PH4P ST",
    "J6": "Reichelt JST PH2P ST",
    "J7": "Reichelt JST PH3P ST",
    "L1": "Reichelt BLM21PG300SN1D",
    "D1": "Reichelt EVL 17-21USRC",
    "S1": "JLCPCB C231329 (B3U-1000P)",
    "SW1": "JLCPCB C221660 (C&K JS102011SAQN)",
    "R1": "Reichelt WAL WR08X3300FTL",
    "R4": "Reichelt WAL WR08X3300FTL",
    "R5": "JLCPCB C17630 (330R 0805) — wie R1",
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
# Zuordnung für die Bestückung bei JLCPCB, recherchiert am 28.07.2026,
# ergänzt am 30.07.2026 (R5 statt R4, S1 → C231329, Y1 → C83707).
# Grundsatz weiterhin SMD; einzige THT-Ausnahme ist der Resonator Y1
# (CSTLS8M00G53-B0, Wellenlöten laut JLCPCB-Katalog). Die übrigen
# bedrahteten Teile (J1, J2, J5–J7) werden von Hand bestückt, ebenso das
# Funkmodul U3: seit dem 14.08.2026 als C9900007000 bestueckbar.
#
# „Basic“ nach der Basic-Parts-Momentaufnahme; der verbindliche Status steht
# erst im Bestellportal (Extended kostet je Position Einrichtungsgebühr).
JLC = {
    # ref: (LCSC-Nummer, MPN/Kommentar, Basic laut Momentaufnahme)
    # Kommentare bewusst ohne Kommas — der BOM-Parser des Portals ist bei
    # Sonderzeichen wählerisch. Begründungen stehen in der LIESMICH.
    "U1": ("C5446", "XC6206P332MR-G", True),
    "U2": ("C14877", "ATMEGA328P-AU", False),
    # C231330 (B3U-1000P-B) war nicht lieferbar; C231329 ist die Variante
    # ohne Zentrierstift — gleiche Pads, die Stiftbohrung bleibt leer.
    "S1": ("C231329", "B3U-1000P", False),
    # Umschalter PWM/SPI. Amtlicher KiCad-Footprint, deshalb dieser Typ und
    # nicht der billigere MSK-12C02, fuer den ein Footprint von Hand haette
    # gezeichnet werden muessen.
    "SW1": ("C221660", "JS102011SAQN SPDT-Schiebeschalter", False),
    # THT-Ausnahme: passt exakt auf den CSTLS-Footprint (SIP-3 RM 2.5mm).
    "Y1": ("C83707", "CSTLS8M00G53-B0 8MHz", False),
    "L1": ("C16903", "BLM21PG300SN1D", False),
    "D1": ("C84256", "FC-2012HRK-620D rot", True),
    "R1": ("C17630", "330R 1% 0805", True),
    # Serienwiderstand der WS2812-Datenleitung, hinter dem Schalter SW1.
    "R4": ("C17630", "330R 1% 0805", True),
    "R2": ("C17414", "10K 1% 0805", True),
    "R3": ("C17414", "10K 1% 0805", True),
    "R5": ("C17630", "330R 1% 0805 (Datenleitung WS2812)", True),
    "C1": ("C15850", "CL21A106KAYNNNE 10uF 25V X5R", True),
    "C2": ("C15850", "CL21A106KAYNNNE 10uF 25V X5R", True),
    "C3": ("C49678", "CC0805KRX7R9BB104 100nF 50V X7R", True),
    "C4": ("C49678", "CC0805KRX7R9BB104 100nF 50V X7R", True),
    "C5": ("C49678", "CC0805KRX7R9BB104 100nF 50V X7R", True),
    "C8": ("C49678", "CC0805KRX7R9BB104 100nF 50V X7R", True),
    "C9": ("C49678", "CC0805KRX7R9BB104 100nF 50V X7R", True),
    # Funkmodul, ab 14.08.2026 bei JLCPCB bestueckbar.
    #
    # C9900007000 ist eine "JLCPCB Assembly"-Position: Sie wird in die eigene
    # Teilebibliothek gekauft und ist NUR fuer PCBA-Auftraege verwendbar, ein
    # Einzelversand gibt es nicht. Katalogangabe LCC-22, 20,0 x 14,0 mm,
    # Raster 1,27 mm — das ist unser Modul, Masse und Halbloch-Raster stimmen
    # mit hardware/README.md ueberein. Freigegeben fuer Economic und Standard.
    #
    # Warum das mehr ist als Bequemlichkeit: Am 14.08.2026 fiel eine von fuenf
    # handbestueckten Platinen aus, weil beim Loeten des Moduls eine Bruecke
    # zwischen Pad 16 (MISO) und Pad 17 (MOSI) entstand — benachbarte
    # Halbloecher im 1,27-mm-Raster. Der USBasp las dadurch seine eigenen
    # Bits zurueck und meldete "target does not answer". Genau diese
    # Fehlerklasse faellt mit Maschinenbestueckung weg.
    "U3": ("C9900007000", "E07-900M10S", False),
}

# SMD, aber nicht im JLCPCB-Katalog — bleibt Handbestückung.
#
# Seit dem 14.08.2026 leer: U3 ist als C9900007000 bestueckbar. Der Eintrag
# bleibt als Mechanismus stehen, weil er gebraucht wird, sobald ein Teil
# wieder herausfaellt — und weil er im Protokoll des Erzeugers ausgibt, was
# von Hand zu loeten bleibt.
JLC_HAND: dict[str, str] = {}


def write_jlc_bom(rows: list[dict]) -> int:
    """BOM im JLCPCB-Format: Comment · Designator · Footprint · JLCPCB Part #"""
    groups: dict[str, list[dict]] = {}
    for row in rows:
        if (row["ref"] in DNP or row["ref"] in JLC_HAND
                or (row["tht"] and row["ref"] not in JLC)):
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
            if (row["ref"] in DNP or row["ref"] in JLC_HAND
                or (row["tht"] and row["ref"] not in JLC)):
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
            "value": WERT_KORREKTUR.get(ref, fp.GetValue()),
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
        # Unbestückte Plätze ausweisen statt verschweigen — sonst sucht beim
        # Bestücken jemand nach dem fehlenden Bauteil. Der Grund steht im
        # Schaltplanwert; hier wird er durchgereicht, nicht neu erfunden.
        # (Seit dem Umbau auf den Schiebeschalter SW1 ist diese Liste leer.)
        for row in rows:
            if row["ref"] in DNP:
                w.writerow([row["value"], row["ref"], row["footprint"], 0,
                            "DNP", "laut Schaltplan nicht bestücken"])
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
    dnp_hinweis = (f" (+ {len(DNP)} unbestückt: {', '.join(sorted(DNP))})"
                   if DNP else " — kein Bauteil unbestückt")
    print(f"fab/bom.csv        : {groups} Positionen{dnp_hinweis}")
    print(f"fab/cpl.csv        : {placed} Bauteile, Ursprung unten links, Y aufwärts")
    print(f"fab/jlcpcb_bom.csv : {jlc_groups} Positionen, davon {basics} Basic")
    print(f"fab/jlcpcb_cpl.csv : {jlc_placed} Bauteile (nur JLCPCB-Bestückung)")
    for ref, why in JLC_HAND.items():
        print(f"  Handbestückung bleibt: {ref} — {why}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
