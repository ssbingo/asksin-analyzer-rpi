#!/usr/bin/env python3
"""
Macht die geroutete Platine fertigungsfertig.

Zwei Schritte, die bewusst **nach** dem Routen laufen und die Verdrahtung nicht
anfassen:

1. **Bestückungsdruck ordnen.** Die Bezeichner stehen nach dem Erzeugen an den
   Vorgabepositionen der Footprints und überlappen sich dort teils. Für die
   Fertigung ist das unkritisch, für die Bestückungskontrolle und jede spätere
   Reparatur nicht.
2. **Flächenanbindung auf Handlötung umstellen** — Durchsteckpads bekommen
   eine thermische Entlastung, SMD-Pads bleiben voll angebunden.
3. **Fertigungsunterlagen erzeugen** — Gerber, Bohrdaten, Bestückungsdatei,
   Stückliste, PDF.

Warum nicht im Generator: `generate_pcb.py` baut die Platine von Grund auf neu.
Jeder Lauf verwürfe die Verdrahtung, und Freerouting liefert wegen seiner
Zufallselemente nicht zweimal dasselbe Ergebnis. Dieses Skript arbeitet
ausschließlich auf der bereits gerouteten Datei.

Aufruf:
    python3 finish_board.py
"""

from __future__ import annotations

import json
import pathlib
import subprocess
import sys

import pcbnew

import generate_pcb as G
from generate_schematic import PROJECT

HERE = pathlib.Path(__file__).resolve().parent
BOARD_FILE = HERE / f"{PROJECT}.kicad_pcb"
FAB_DIR = HERE / "fab"

TEXT_SIZE = 0.8         # mm
TEXT_THICK = 0.12
GAP = 0.35              # Abstand zwischen Text und Bauteilumriss


def mm(v: float) -> int:
    return pcbnew.FromMM(v)


def box_of(fp) -> tuple[float, float, float, float]:
    shape = fp.GetCourtyard(pcbnew.F_CrtYd)
    bb = shape.BBox() if not shape.IsEmpty() else fp.GetBoundingBox(False, False)
    return (pcbnew.ToMM(bb.GetLeft()), pcbnew.ToMM(bb.GetTop()),
            pcbnew.ToMM(bb.GetRight()), pcbnew.ToMM(bb.GetBottom()))


def overlap(a, b) -> bool:
    return not (a[2] <= b[0] or b[2] <= a[0] or a[3] <= b[1] or b[3] <= a[1])


def tidy_silkscreen(board) -> tuple[int, int]:
    """Bezeichner so setzen, dass sie weder Bauteile noch einander überdecken."""
    footprints = list(board.GetFootprints())
    obstacles = [box_of(fp) for fp in footprints]
    placed_texts: list[tuple[float, float, float, float]] = []

    moved = stuck = 0
    for fp in footprints:
        ref = fp.Reference()
        ref.SetLayer(pcbnew.F_SilkS)
        ref.SetTextSize(pcbnew.VECTOR2I(mm(TEXT_SIZE), mm(TEXT_SIZE)))
        ref.SetTextThickness(mm(TEXT_THICK))
        ref.SetVisible(True)
        # Werte gehören auf die Fertigungslage, nicht in den Bestückungsdruck —
        # sonst wird es auf einer Platine dieser Größe unleserlich.
        val = fp.Value()
        val.SetLayer(pcbnew.F_Fab)
        val.SetVisible(True)

        x0, y0, x1, y1 = box_of(fp)
        w = len(ref.GetText()) * TEXT_SIZE * 0.72
        h = TEXT_SIZE
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2

        candidates = [
            (cx, y0 - GAP - h / 2),          # oben
            (cx, y1 + GAP + h / 2),          # unten
            (x1 + GAP + w / 2, cy),          # rechts
            (x0 - GAP - w / 2, cy),          # links
            (cx, y0 - GAP - h * 1.8),        # weiter oben
            (cx, y1 + GAP + h * 1.8),        # weiter unten
        ]

        own = box_of(fp)
        for tx, ty in candidates:
            tbox = (tx - w / 2, ty - h / 2, tx + w / 2, ty + h / 2)
            clash = any(overlap(tbox, o) for o in obstacles if o is not own)
            clash = clash or any(overlap(tbox, t) for t in placed_texts)
            # Der Text muss im Umriss liegen. Ohne diese Prüfung rutschen die
            # Bezeichner von Bauteilen an der Unterkante unter die Platine.
            rel = (tbox[0] - G.ORIGIN_X, tbox[1] - G.ORIGIN_Y,
                   tbox[2] - G.ORIGIN_X, tbox[3] - G.ORIGIN_Y)
            if clash or not G.inside_board(*rel):
                continue
            ref.SetPosition(pcbnew.VECTOR2I(mm(tx), mm(ty)))
            ref.SetTextAngleDegrees(0)
            placed_texts.append(tbox)
            moved += 1
            break
        else:
            stuck += 1
    return moved, stuck


def set_thermal_relief(board) -> int:
    """Masseflächen auf thermische Entlastung umstellen.

    Wird hier und nicht im Generator angewandt, damit die vorhandene
    Verdrahtung erhalten bleibt — die Anbindungsart ist eine Eigenschaft der
    Füllung, kein Routing. Der Generator führt dieselbe Einstellung, damit ein
    Neuaufbau dasselbe Ergebnis liefert.
    """
    n = 0
    for zone in board.Zones():
        zone.SetPadConnection(pcbnew.ZONE_CONNECTION_THT_THERMAL)
        zone.SetThermalReliefGap(mm(0.3))
        zone.SetThermalReliefSpokeWidth(mm(0.5))
        n += 1
    pcbnew.ZONE_FILLER(board).Fill(board.Zones())
    return n


HW_VERSION = "0.0.1"
HW_DATUM = "07/2026"
MARKING_TOP = [
    f"AskSin-Analyzer · HW v{HW_VERSION} · {HW_DATUM}",
    "© 2026 S. Sternitzke · CC BY-NC-SA 4.0",
]


def add_board_marking(board) -> None:
    """Projektname, Version, Datum, Copyright und Lizenz auf beide Seiten.

    Idempotent: vorhandene Markierungstexte werden zuerst entfernt, sonst
    stapeln sich bei jedem Lauf neue Kopien übereinander.
    """
    kennungen = ("AskSin-Analyzer", "CC BY-NC-SA", "S. Sternitzke", "HW v")
    for item in list(board.GetDrawings()):
        if item.GetClass() == "PCB_TEXT" and                 any(k in item.GetText() for k in kennungen):
            board.Remove(item)

    def text(inhalt, x, y, layer, mirrored):
        item = pcbnew.PCB_TEXT(board)
        item.SetText(inhalt)
        item.SetLayer(layer)
        item.SetPosition(pcbnew.VECTOR2I(mm(G.ORIGIN_X + x), mm(G.ORIGIN_Y + y)))
        item.SetTextSize(pcbnew.VECTOR2I(mm(1.0), mm(1.0)))
        item.SetTextThickness(mm(0.15))
        item.SetMirrored(mirrored)
        board.Add(item)

    # Oberseite: im freien Streifen des Arms unter dem Header.
    for i, zeile in enumerate(MARKING_TOP):
        text(zeile, 32.0, 9.6 + i * 2.3, pcbnew.F_SilkS, False)
    # Unterseite: an der Unterkante des Körpers, gespiegelt, damit der Text
    # beim Blick auf die Platinenunterseite lesbar ist.
    for i, zeile in enumerate(MARKING_TOP):
        text(zeile, 91.0, 42.6 + i * 2.3, pcbnew.B_SilkS, True)


def export_fab() -> list[str]:
    FAB_DIR.mkdir(exist_ok=True)
    board = str(BOARD_FILE)
    steps = [
        (["pcb", "export", "gerbers", "--output", str(FAB_DIR),
          "--layers",
          "F.Cu,In1.Cu,In2.Cu,B.Cu,F.Mask,B.Mask,F.SilkS,B.SilkS,F.Paste,Edge.Cuts",
          board], "Gerber"),
        (["pcb", "export", "drill", "--output", str(FAB_DIR) + "/",
          "--format", "excellon", "--excellon-separate-th", board], "Bohrdaten"),
        (["pcb", "export", "pos", "--output", str(FAB_DIR / "positions.csv"),
          "--format", "csv", "--units", "mm", "--side", "both", board],
         "Bestückungsdatei"),
        (["pcb", "export", "pdf", "--output", str(FAB_DIR / "layout.pdf"),
          "--layers", "F.Cu,F.SilkS,Edge.Cuts", board], "Layout-PDF"),
        (["sch", "export", "pdf", "--output", str(FAB_DIR / "schaltplan.pdf"),
          str(HERE / f"{PROJECT}.kicad_sch")], "Schaltplan-PDF"),
        (["sch", "export", "bom", "--output", str(FAB_DIR / "stueckliste.csv"),
          "--fields", "Reference,Value,Footprint,${QUANTITY}",
          "--group-by", "Value,Footprint",
          str(HERE / f"{PROJECT}.kicad_sch")], "Stückliste"),
    ]
    done = []
    for args, label in steps:
        res = subprocess.run(["kicad-cli"] + args, capture_output=True,
                             text=True, timeout=600)
        done.append(f"{label}: {'ok' if res.returncode == 0 else 'FEHLER'}")
    return done


def main() -> int:
    board = pcbnew.LoadBoard(str(BOARD_FILE))
    zones = set_thermal_relief(board)
    print(f"Flächen auf thermische Entlastung umgestellt: {zones}")
    moved, stuck = tidy_silkscreen(board)
    add_board_marking(board)
    board.Save(str(BOARD_FILE))
    print(f"Bestückungsdruck: {moved} Bezeichner platziert"
          + (f", {stuck} ohne freien Platz" if stuck else ", alle frei"))

    for line in export_fab():
        print(f"  {line}")

    fixed = fix_gerber_job(board)
    if fixed:
        print(f"  Jobfile: {fixed} Lagenangabe(n) richtiggestellt")
    print(f"  Archiv: {make_archive()}")
    files = sorted(p.name for p in FAB_DIR.iterdir())
    print(f"\nfab/: {len(files)} Dateien")
    return 0


if __name__ == "__main__":
    sys.exit(main())
