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

TEXT_SIZE = 0.8         # mm — Mindesthöhe des DRC, nicht unterschreiten
TEXT_THICK = 0.12
GAP = 0.30              # Abstand zwischen Text und Bauteilumriss


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
    # 0,3 mm Zuschlag: der Bestückungsdruck mancher Footprints (etwa der
    # Rahmen von S1) reicht über die Abstandsfläche hinaus.
    obstacles = [(b[0] - 0.3, b[1] - 0.3, b[2] + 0.3, b[3] + 0.3)
                 for b in (box_of(fp) for fp in footprints)]
    # Zusätzlich **jedes einzelne Pad**: Die Abstandsfläche eines Bauteils
    # deckt nicht immer alle Pads ab, und Bestückungsdruck über blankem Kupfer
    # meldet der DRC als silk_over_copper.
    for fp in footprints:
        for pad in fp.Pads():
            pb = pad.GetBoundingBox()
            obstacles.append((pcbnew.ToMM(pb.GetLeft()) - 0.25,
                              pcbnew.ToMM(pb.GetTop()) - 0.25,
                              pcbnew.ToMM(pb.GetRight()) + 0.25,
                              pcbnew.ToMM(pb.GetBottom()) + 0.25))
    # Vorhandene Platinen-Texte (Markierung, Lizenz) sind ebenfalls tabu.
    # Box aus Position und Textlänge gerechnet — GetBoundingBox() stürzt in
    # dieser pcbnew-Version auf frisch hinzugefügten Texten ab (Segfault).
    placed_texts: list[tuple[float, float, float, float]] = []
    for item in board.GetDrawings():
        if item.GetClass() == "PCB_TEXT":
            pos = item.GetPosition()
            tw = len(item.GetText()) * 1.0 * 0.72 + 1.0
            px, py = pcbnew.ToMM(pos.x), pcbnew.ToMM(pos.y)
            placed_texts.append((px - tw / 2, py - 0.8, px + tw / 2, py + 0.8))

    moved = stuck = 0
    for fp in footprints:
        ref = fp.Reference()
        ref.SetLayer(pcbnew.B_SilkS if fp.IsFlipped() else pcbnew.F_SilkS)
        ref.SetTextSize(pcbnew.VECTOR2I(mm(TEXT_SIZE), mm(TEXT_SIZE)))
        ref.SetTextThickness(mm(TEXT_THICK))
        ref.SetVisible(True)
        # Werte gehören auf die Fertigungslage, nicht in den Bestückungsdruck —
        # sonst wird es auf einer Platine dieser Größe unleserlich.
        val = fp.Value()
        val.SetLayer(pcbnew.B_Fab if fp.IsFlipped() else pcbnew.F_Fab)
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
            # Diagonalen: auf der engen L-Platine sind die vier Hauptrichtungen
            # oft schon von Nachbarn belegt.
            (x1 + GAP + w / 2, y0 - GAP - h / 2),
            (x0 - GAP - w / 2, y0 - GAP - h / 2),
            (x1 + GAP + w / 2, y1 + GAP + h / 2),
            (x0 - GAP - w / 2, y1 + GAP + h / 2),
        ]

        own = box_of(fp)
        for tx, ty in candidates:
            tbox = (tx - w / 2, ty - h / 2, tx + w / 2, ty + h / 2)
            # Mit Sicherheitsabstand pruefen: Der DRC meldet auch direkt
            # aneinanderstossende Bezeichner als silk_overlap.
            s = 0.25
            pruef = (tbox[0] - s, tbox[1] - s, tbox[2] + s, tbox[3] + s)
            clash = any(overlap(pruef, o) for o in obstacles if o is not own)
            clash = clash or any(overlap(pruef, t) for t in placed_texts)
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
            # Kein freier Platz: Bezeichner **ausblenden** statt ihn
            # überlappend stehen zu lassen. Auf dem engen L-Umriss trifft das
            # ein paar Bauteile; für die Bestückung zählt ohnehin die CPL, und
            # auf der Fertigungslage (F.Fab) bleibt die Kennzeichnung stehen.
            ref.SetVisible(False)
            stuck += 1
    return moved, stuck


def tent_vias(board) -> int:
    """Alle Durchkontaktierungen mit Lötstopplack abdecken.

    Zwei Gründe: Offene Vias sind blankes Kupfer im Datenschrank (Kondensat,
    Kriechströme), und sie zwingen jeden Text auf der Platine zum Ausweichen —
    eine Lötstoppöffnung unter dem Bestückungsdruck meldet der DRC als
    `silk_over_copper`. Auf dieser Platine liegt ein Masse-Via-Raster, dem
    kein Text ausweichen könnte.
    """
    n = 0
    for item in board.GetTracks():
        if item.Type() != pcbnew.PCB_VIA_T:
            continue
        item.SetFrontTentingMode(pcbnew.TENTING_MODE_TENTED)
        item.SetBackTentingMode(pcbnew.TENTING_MODE_TENTED)
        n += 1
    return n


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
        zone.SetThermalReliefGap(mm(0.25))
        zone.SetThermalReliefSpokeWidth(mm(0.4))
        n += 1
    pcbnew.ZONE_FILLER(board).Fill(board.Zones())
    return n


HW_VERSION = "0.2.0"
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
            # board.Remove() hinterlässt hier eine korrupte Liste — der
            # nächste Zugriff auf GetFootprints() stürzt ab. Delete() räumt
            # das Element sauber aus der Platine.
            board.Delete(item)

    def text(inhalt, x, y, layer, mirrored):
        item = pcbnew.PCB_TEXT(board)
        item.SetText(inhalt)
        item.SetLayer(layer)
        item.SetPosition(pcbnew.VECTOR2I(mm(G.ORIGIN_X + x), mm(G.ORIGIN_Y + y)))
        item.SetTextSize(pcbnew.VECTOR2I(mm(1.0), mm(1.0)))
        item.SetTextThickness(mm(0.15))
        item.SetMirrored(mirrored)
        board.Add(item)

    # Beide Zeilen auf die **Unterseite**: Die Oberseite ist mit Bauteilen und
    # deren Bezeichnern voll, unten liegt außer der Buchse nichts. Gespiegelt,
    # damit der Text beim Blick auf die Platinenunterseite lesbar ist.
    #
    # Der Platz wird gesucht, nicht geraten: Nach jedem Routing-Lauf liegen
    # Bahnen und Vias anders, und ein Text über einer Lötstoppöffnung ist ein
    # DRC-Verstoß. Geprüft wird gegen alles, was auf der Unterseite eine
    # Öffnung erzeugt — Durchsteckpads und nicht abgedeckte Vias.
    breite = max(len(z) for z in MARKING_TOP) * 0.72 + 1.0
    hoehe = 2.4 * len(MARKING_TOP) + 1.0

    # Bewusst konservativ: **jedes** Pad und **jedes** Via gilt als Hindernis,
    # unabhängig von Seite und Abdeckung. Eine feinere Unterscheidung hatte
    # Löcher (die Markierung landete trotzdem über einer Maskenöffnung), und
    # Platz ist auf dieser Platine reichlich vorhanden.
    hindernisse = []
    for fp in board.GetFootprints():
        for pad in fp.Pads():
            bb = pad.GetBoundingBox()
            hindernisse.append((pcbnew.ToMM(bb.GetLeft()) - G.ORIGIN_X,
                                pcbnew.ToMM(bb.GetTop()) - G.ORIGIN_Y,
                                pcbnew.ToMM(bb.GetRight()) - G.ORIGIN_X,
                                pcbnew.ToMM(bb.GetBottom()) - G.ORIGIN_Y))
    for item in board.GetTracks():
        if item.Type() == pcbnew.PCB_VIA_T:
            pos = item.GetPosition()
            r = pcbnew.ToMM(item.GetWidth()) / 2 + 0.1
            x = pcbnew.ToMM(pos.x) - G.ORIGIN_X
            y = pcbnew.ToMM(pos.y) - G.ORIGIN_Y
            hindernisse.append((x - r, y - r, x + r, y + r))

    def frei(cx: float, cy: float) -> bool:
        box = (cx - breite / 2, cy - hoehe / 2, cx + breite / 2, cy + hoehe / 2)
        # Zusätzlicher Rand: Bestückungsdruck darf die Platinenkante nicht
        # berühren (DRC silk_edge_clearance), inside_board() prüft nur den
        # Kupferabstand.
        if not G.inside_board(box[0] - 0.6, box[1] - 0.6,
                              box[2] + 0.6, box[3] + 0.6):
            return False
        return not any(overlap(box, h) for h in hindernisse)

    for cy in [y / 2 for y in range(6, int(G.LEG_Y1) * 2 - 5)]:
        for cx in [x / 2 for x in range(int(breite), int(G.BOARD_L) * 2 - int(breite))]:
            if frei(cx, cy):
                for i, zeile in enumerate(MARKING_TOP):
                    text(zeile, cx, cy - 1.2 + i * 2.4, pcbnew.B_SilkS, True)
                return
    raise SystemExit("Kein freier Platz für die Platinenmarkierung gefunden")


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
    print(f"Durchkontaktierungen abgedeckt (getentet): {tent_vias(board)}")
    add_board_marking(board)
    moved, stuck = tidy_silkscreen(board)
    board.Save(str(BOARD_FILE))
    print(f"Bestückungsdruck: {moved} Bezeichner platziert"
          + (f", {stuck} ohne freien Platz" if stuck else ", alle frei"))

    for line in export_fab():
        print(f"  {line}")

    # Das Fertigungsarchiv packt make_fab_archive.py — nach diesem Skript
    # aufrufen (früher stand hier ein Aufruf nie definierter Helfer, der das
    # Skript nach den Exporten abstürzen ließ).
    files = sorted(p.name for p in FAB_DIR.iterdir())
    print(f"\nfab/: {len(files)} Dateien")
    return 0


if __name__ == "__main__":
    sys.exit(main())
