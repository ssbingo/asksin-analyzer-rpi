#!/usr/bin/env python3
"""
Erzeugt den J1-Rettungsadapter für die Platinen der Hardware v0.0.1.

Hintergrund
-----------
Auf den 2026 gefertigten Platinen ist die 2×20-Buchse J1 gespiegelt: Die
**ungerade** Pinreihe (1, 3, 5 …) sitzt exakt an der Position der offiziellen
HAT-Vorlage, die **gerade** Reihe (2, 4, 6 …) liegt aber 2,54 mm auf der
falschen Seite davon — bei 7,31 mm statt bei 2,23 mm von der Kante. Direkt auf
den Pi gesteckt verrutscht die Platine um eine Rasterposition, jedes Pad landet
auf dem falschen Pi-Pin (5 V auf 3,3 V, Masse auf GPIOs). **Niemals direkt
aufstecken und einschalten.**

Aufbau des Adapters
-------------------
Weil nur die gerade Reihe falsch liegt, versetzt der Adapter auch nur diese —
die ungerade wird unverändert durchgereicht. Daraus ergeben sich drei
einreihige Steckverbinder statt eines zweireihigen:

    Reihe 4,77 mm   J1  Stapelbuchse 1×20 (lange Pins)
                        unten: steckt auf der ungeraden Pi-Reihe
                        oben:  dieselben Pins ragen durch — hier greift die
                               ungerade Reihe der Analyzer-Platine
    Reihe 2,23 mm   J2  Buchsenleiste 1×20 (normal, ohne lange Pins)
                        steckt auf der geraden Pi-Reihe, oben bündig
    Reihe 7,31 mm   J3  Stiftleiste 1×20 nach oben
                        führt die geraden Signale von J2 dorthin, wo die
                        Analyzer-Platine ihre gerade Reihe erwartet

Wichtig ist, dass J2 **keine** Stapelbuchse ist: Ragten ihre Pins nach oben,
träfen sie auf der Analyzer-Platine auf blankes Basismaterial — dort ist kein
Loch — und die Platine könnte nicht aufsitzen.

Ergebnis: Die Analyzer-Platine steckt ganz normal (Bestückungsseite oben) auf
dem Adapter, jedes Pad liegt auf seinem richtigen Pi-Pin, und die
Montagelöcher MH1/MH2 fluchten wieder mit den Abstandsbolzen des Pi.
Mehrhöhe des Stapels: rund 10 mm.

Alle Maße stammen aus der offiziellen KiCad-Vorlage `RaspberryPi-HAT`
(Pin 1 bei (8,37, 4,77), gerade Reihe bei 2,23 mm, Bohrungen (3,5, 3,5) und
(61,5, 3,5)) und werden im Skript gegengeprüft.

Aufruf:
    python3 generate_adapter.py
    kicad-cli pcb drc --severity-error --severity-warning \
        --exit-code-violations -o drc.rpt AskSin-Adapter-J1.kicad_pcb
"""

from __future__ import annotations

import json
import pathlib
import sys

import pcbnew

HERE = pathlib.Path(__file__).resolve().parent
PROJECT = "AskSin-Adapter-J1"
OUT = HERE / f"{PROJECT}.kicad_pcb"
FP_DIRS = [pathlib.Path("/usr/share/kicad/footprints")]

ORIGIN_X, ORIGIN_Y = 100.0, 60.0
BOARD_W, BOARD_H = 65.0, 12.0

# Geometrie aus der HAT-Vorlage, bezogen auf die linke obere Platinenecke.
COL0 = 8.37               # Spalte von Pin 1/2
PITCH = 2.54
ROW_ODD = 4.77            # ungerade Pi-Reihe — wird durchgereicht
ROW_EVEN = 2.23           # gerade Pi-Reihe
ROW_SHIFTED = 7.31        # dorthin muss die gerade Reihe für die alte Platine
HOLES = [(3.5, 3.5), (61.5, 3.5)]
HOLE_FP = "MountingHole:MountingHole_2.7mm_M2.5"

SOCKET_FP = "Connector_PinSocket_2.54mm:PinSocket_1x20_P2.54mm_Vertical"
HEADER_FP = "Connector_PinHeader_2.54mm:PinHeader_1x20_P2.54mm_Vertical"

# Leiterbahnbreite je Signal: Versorgung breiter (Pi-Pins 2/4 = 5 V,
# 6/14/20/30/34 = GND), der Rest Standardsignal.
POWER_EVEN = {2, 4, 6, 14, 20, 30, 34}
W_POWER, W_SIGNAL = 0.4, 0.3


def mm(v: float) -> int:
    return pcbnew.FromMM(v)


def at(x: float, y: float) -> pcbnew.VECTOR2I:
    return pcbnew.VECTOR2I(mm(ORIGIN_X + x), mm(ORIGIN_Y + y))


def load_footprint(fp_id: str) -> pcbnew.FOOTPRINT:
    lib, name = fp_id.split(":", 1)
    for base in FP_DIRS:
        fp = pcbnew.FootprintLoad(str(base / f"{lib}.pretty"), name)
        if fp is not None:
            return fp
    raise FileNotFoundError(fp_id)


def pad_pos(fp: pcbnew.FOOTPRINT, number: str) -> tuple[float, float]:
    p = fp.FindPadByNumber(number).GetPosition()
    return (pcbnew.ToMM(p.x) - ORIGIN_X, pcbnew.ToMM(p.y) - ORIGIN_Y)


def place_row(board, nets, fp_id, ref, value, reihe, erstes_signal, schritt):
    """Einreihigen Steckverbinder setzen; Pad k trägt Pi-Signal
    `erstes_signal + (k-1) * schritt`. Position wird gegengeprüft."""
    fp = load_footprint(fp_id)
    fp.SetReference(ref)
    fp.SetValue(value)
    board.Add(fp)
    fp.SetPosition(at(COL0, reihe))
    for winkel in (-90.0, 90.0):
        fp.SetOrientationDegrees(winkel)
        x2, y2 = pad_pos(fp, "2")
        if abs(x2 - (COL0 + PITCH)) < 0.01 and abs(y2 - reihe) < 0.01:
            break
    else:
        raise SystemExit(f"{ref}: Pad 2 landet nicht bei "
                         f"({COL0 + PITCH:.2f}, {reihe:.2f})")
    x1, y1 = pad_pos(fp, "1")
    if abs(x1 - COL0) > 0.01 or abs(y1 - reihe) > 0.01:
        raise SystemExit(f"{ref}: Pad 1 bei ({x1:.2f}, {y1:.2f})")
    for pad in fp.Pads():
        k = int(pad.GetNumber())
        pad.SetNet(nets[f"P{erstes_signal + (k - 1) * schritt}"])
    return fp


def add_track(board, nets, net_name, width, points):
    for a, b in zip(points, points[1:]):
        t = pcbnew.PCB_TRACK(board)
        t.SetStart(at(*a))
        t.SetEnd(at(*b))
        t.SetWidth(mm(width))
        t.SetLayer(pcbnew.F_Cu)
        t.SetNet(nets[net_name])
        board.Add(t)


def main() -> int:
    board = pcbnew.BOARD()
    board.SetCopperLayerCount(2)

    corners = [(0, 0), (BOARD_W, 0), (BOARD_W, BOARD_H), (0, BOARD_H)]
    for i in range(4):
        seg = pcbnew.PCB_SHAPE(board)
        seg.SetShape(pcbnew.SHAPE_T_SEGMENT)
        seg.SetStart(at(*corners[i]))
        seg.SetEnd(at(*corners[(i + 1) % 4]))
        seg.SetLayer(pcbnew.Edge_Cuts)
        seg.SetWidth(mm(0.1))
        board.Add(seg)

    for idx, (hx, hy) in enumerate(HOLES, start=1):
        fp = load_footprint(HOLE_FP)
        fp.SetReference(f"MH{idx}")
        fp.SetPosition(at(hx, hy))
        board.Add(fp)

    nets = {}
    for n in range(1, 41):
        item = pcbnew.NETINFO_ITEM(board, f"P{n}")
        board.Add(item)
        nets[f"P{n}"] = item

    # Ungerade Reihe: Stapelbuchse, Pins ragen nach oben durch — von hier
    # gibt es nichts zu verdrahten, der Pin ist die Verbindung.
    place_row(board, nets, SOCKET_FP, "J1",
              "Stapelbuchse 1x20 (Pins ragen oben durch)",
              ROW_ODD, erstes_signal=1, schritt=2)
    # Gerade Reihe: normale Buchse, oben bündig.
    place_row(board, nets, SOCKET_FP, "J2", "Buchsenleiste 1x20 (nicht stapelbar)",
              ROW_EVEN, erstes_signal=2, schritt=2)
    # Zielreihe für die geraden Signale: Stiftleiste nach oben.
    place_row(board, nets, HEADER_FP, "J3", "Stiftleiste 1x20 nach oben",
              ROW_SHIFTED, erstes_signal=2, schritt=2)

    # Je gerader Position eine Bahn von J2 (2,23) nach J3 (7,31). Der Korridor
    # bei Spalte + 1,27 läuft mittig zwischen zwei Pads der durchgereichten
    # Reihe hindurch.
    for k in range(20):
        n = 2 * (k + 1)
        c = COL0 + k * PITCH
        lane = c + 1.27
        width = W_POWER if n in POWER_EVEN else W_SIGNAL
        add_track(board, nets, f"P{n}", width,
                  [(c, ROW_EVEN), (lane, ROW_EVEN + 1.27),
                   (lane, ROW_ODD + 1.27), (c, ROW_SHIFTED)])

    def silk(text, x, y, size=0.9, layer=pcbnew.F_SilkS):
        t = pcbnew.PCB_TEXT(board)
        t.SetText(text)
        t.SetPosition(at(x, y))
        t.SetTextSize(pcbnew.VECTOR2I(mm(size), mm(size)))
        t.SetTextThickness(mm(0.15 * size))
        t.SetLayer(layer)
        if layer == pcbnew.B_SilkS:
            t.SetMirrored(True)
        board.Add(t)

    silk("AskSin J1-Adapter v1.1 — Analyzer oben aufstecken", 32.5, 10.4)
    silk("Pi-Header unten", 32.5, 10.4, 1.0, pcbnew.B_SilkS)

    # Die drei Leisten stehen im 2,54-Raster unmittelbar nebeneinander: Ihre
    # Kunststoffkörper stoßen aneinander, genau wie bei einer zweireihigen
    # Leiste. Die Standard-Footprints bringen aber je 0,25 mm Luft im
    # Courtyard und einen eigenen Siebdruckrahmen mit — beides überlappt
    # zwangsläufig. Courtyard auf den Körper zurückschneiden, Siebdruck der
    # Leisten entfernen; die Beschriftung steht am Platinenrand.
    for fp in board.GetFootprints():
        fp.Reference().SetVisible(False)
        fp.Value().SetVisible(False)
        if fp.GetReference() not in ("J1", "J2", "J3"):
            continue
        for item in list(fp.GraphicalItems()):
            lage = board.GetLayerName(item.GetLayer())
            if lage in ("F.Silkscreen", "F.Courtyard"):
                fp.Delete(item)
        # Der Bezugspunkt der Leiste liegt auf Pad 1, nicht in ihrer Mitte —
        # das Rechteck läuft deshalb von dort nach rechts über alle 20 Pads.
        pos = fp.GetPosition()
        x0, x1 = -PITCH / 2, 19 * PITCH + PITCH / 2
        ecken = [(x0, -PITCH / 2), (x1, -PITCH / 2),
                 (x1, PITCH / 2), (x0, PITCH / 2)]
        for i in range(4):
            ax, ay = ecken[i]
            bx, by = ecken[(i + 1) % 4]
            seg = pcbnew.PCB_SHAPE(fp)
            seg.SetShape(pcbnew.SHAPE_T_SEGMENT)
            seg.SetStart(pcbnew.VECTOR2I(pos.x + mm(ax), pos.y + mm(ay)))
            seg.SetEnd(pcbnew.VECTOR2I(pos.x + mm(bx), pos.y + mm(by)))
            seg.SetLayer(pcbnew.F_CrtYd)
            seg.SetWidth(mm(0.05))
            fp.Add(seg)

    board.Save(str(OUT))

    pro = {
        "meta": {"filename": f"{PROJECT}.kicad_pro", "version": 3},
        "board": {"design_settings": {"rules": {
            "min_clearance": 0.15, "min_track_width": 0.25,
            "min_via_diameter": 0.6, "min_through_hole_diameter": 0.3,
            "min_hole_clearance": 0.25, "min_silk_clearance": 0.0,
        }}},
        "net_settings": {"classes": [
            {"name": "Default", "clearance": 0.15, "track_width": 0.3,
             "via_diameter": 0.6, "via_drill": 0.3},
        ]},
        "schematic": {}, "sheets": [], "text_variables": {},
    }
    (HERE / f"{PROJECT}.kicad_pro").write_text(json.dumps(pro, indent=2) + "\n")

    print(f"geschrieben: {OUT.name}")
    print(f"  Umriss : {BOARD_W:.0f} × {BOARD_H:.0f} mm, 2 Lagen")
    print("  Reihen : 4,77 durchgereicht · 2,23 gerade Pi-Reihe · "
          "7,31 versetzte Zielreihe")
    print("  Pad-Positionen gegen die HAT-Vorlagengeometrie geprüft: OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
