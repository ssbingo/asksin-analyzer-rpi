#!/usr/bin/env python3
"""
Erzeugt BOM und CPL des J1-Adapters für die JLCPCB-Bestückung.

Arbeitet lesend auf `AskSin-Adapter-J1.kicad_pcb`.

Zwei Besonderheiten, die hier bewusst anders gelöst sind als bei einem
üblichen SMD-Board:

1. **Position = Mittelpunkt der Pads, nicht Footprint-Ursprung.**
   Der Ursprung der KiCad-Steckerleisten liegt auf Pad 1, also am Rand des
   Bauteils. Gäbe man den weiter, säße die Leiste im Bestückungsprogramm um
   ihre halbe Länge versetzt. JLCPCB erwartet den Bauteilmittelpunkt.

2. **Beide Leisten sind bedrahtet und sitzen auf verschiedenen Seiten** —
   die Buchse unten (zum PoE-HAT), die Stiftleiste oben (zur
   Analyzer-Platine). Das geht nur mit **Standard PCBA** (beidseitige
   Bestückung); die Economic-Variante bestückt nur eine Seite.

Aufruf:
    python3 generate_bom_cpl.py
"""

from __future__ import annotations

import csv
import pathlib
import sys

import pcbnew

HERE = pathlib.Path(__file__).resolve().parent
BOARD = HERE / "AskSin-Adapter-J1.kicad_pcb"
FAB = HERE / "fab"

# Recherchiert am 30.07.2026 im JLCPCB-Teilekatalog. Beide „Extended",
# beide laut Teileseite per Wellenlöten in Economic **und** Standard PCBA
# bestückbar.
#   J1: C50982 (BOOMELE) wäre die naheliegende Wahl, ist bei LCSC aber
#       „not available" — deshalb C2977589 (ZHOURI), rund 47 000 auf Lager.
JLC = {
    "J1": ("C2977589", "Buchsenleiste 2x20 RM 2,54 gerade, Hoehe 8,5 mm (ZHOURI 2.54-2*20)"),
    "J2": ("C50980", "Stiftleiste 2x20 RM 2,54 gerade, Steckstift 6 mm (BOOMELE 2.54mm 2*20P)"),
}


def mitte(fp: pcbnew.FOOTPRINT) -> tuple[float, float]:
    """Mittelpunkt über alle Pads — bei einer symmetrischen Leiste exakt
    deren geometrische Mitte."""
    xs = [pcbnew.ToMM(p.GetPosition().x) for p in fp.Pads()]
    ys = [pcbnew.ToMM(p.GetPosition().y) for p in fp.Pads()]
    return ((min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2)


def main() -> int:
    board = pcbnew.LoadBoard(str(BOARD))
    bb = board.GetBoardEdgesBoundingBox()
    links = pcbnew.ToMM(bb.GetLeft())
    unten = pcbnew.ToMM(bb.GetBottom())
    hoehe = pcbnew.ToMM(bb.GetHeight())
    FAB.mkdir(exist_ok=True)

    zeilen = []
    for ref, (lcsc, text) in sorted(JLC.items()):
        fp = board.FindFootprintByReference(ref)
        if fp is None:
            raise SystemExit(f"{ref} nicht auf der Platine")
        mx, my = mitte(fp)
        zeilen.append({
            "ref": ref,
            "lcsc": lcsc,
            "text": text,
            "footprint": fp.GetFPIDAsString().split(":", 1)[-1],
            # Ursprung linke untere Ecke, Y nach oben — die Konvention, die
            # JLCPCB für CPL-Dateien erwartet.
            "x": round(mx - links, 3),
            "y": round(unten - my, 3),
            "layer": "bottom" if fp.IsFlipped() else "top",
            "rot": round(fp.GetOrientationDegrees() % 360, 1),
        })

    with (FAB / "jlcpcb_bom.csv").open("w", newline="", encoding="utf8") as f:
        w = csv.writer(f)
        w.writerow(["Comment", "Designator", "Footprint", "JLCPCB Part #"])
        for z in zeilen:
            w.writerow([z["text"], z["ref"], z["footprint"], z["lcsc"]])

    with (FAB / "jlcpcb_cpl.csv").open("w", newline="", encoding="utf8") as f:
        w = csv.writer(f)
        w.writerow(["Designator", "Mid X", "Mid Y", "Layer", "Rotation"])
        for z in zeilen:
            w.writerow([z["ref"], f"{z['x']}mm", f"{z['y']}mm", z["layer"], z["rot"]])

    print(f"fab/jlcpcb_bom.csv : {len(zeilen)} Positionen")
    print(f"fab/jlcpcb_cpl.csv : Ursprung unten links, Y aufwärts "
          f"(Platinenhöhe {hoehe:.1f} mm)")
    for z in zeilen:
        print(f"  {z['ref']}  {z['lcsc']:<8} {z['x']:6.2f} / {z['y']:5.2f} mm  "
              f"{z['layer']:<6} {z['rot']:5.1f}°  — {z['text']}")
    print("\n  Beide Leisten sind bedrahtet und liegen auf verschiedenen Seiten:")
    print("  Das verlangt **Standard PCBA** mit beidseitiger Bestückung.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
