#!/usr/bin/env python3
"""
Erzeugt den J1-Rettungsadapter für die AskSin-Analyzer-Chargen 1 und 2.

Hintergrund
-----------
Auf den 2026 gefertigten Platinen (Hardware v0.0.1) ist die 2×20-Buchse J1
gespiegelt: Die ungerade Pin-Reihe sitzt exakt an der Position der offiziellen
HAT-Vorlage, die gerade Reihe liegt aber 2,54 mm auf der **falschen Seite**
davon (7,31 mm statt 2,23 mm von der Platinenkante). Direkt aufgesteckt
verrutscht die Platine um eine Rasterposition und jedes Pad landet auf dem
falschen Pi-Pin — 5 V auf 3,3 V, Masse auf GPIOs. **Niemals direkt aufstecken
und einschalten.**

Der Adapter korrigiert das rein mechanisch/elektrisch:

  * Unten eine 2×20-**Stapelbuchse** (lange Stifte) in der korrekten
    HAT-Position — sie wird normal auf den durchgeschleiften Header des
    PoE-HAT gesteckt. Die Buchse wird **kopfüber** montiert: Buchsenkörper
    unter der Platine, die langen Stifte ragen oben heraus.
  * Die **ungeraden** Stifte (1–39) reichen dadurch unverändert nach oben —
    genau dort erwartet die Analyzer-Platine ihre ungerade Reihe.
  * Die **geraden** Signale (2–40) werden über kurze Leiterbahnen auf eine
    zusätzliche 1×20-**Stiftleiste** geführt, die 2,54 mm weiter innen sitzt —
    exakt dort, wo die gespiegelte gerade Reihe der Analyzer-Platine liegt.

Die Analyzer-Platine steckt anschließend ganz normal (Bestückungsseite oben)
auf dem Adapter, jedes Pad liegt auf seinem richtigen Pi-Pin, und die
Montagelöcher MH1/MH2 fluchten wieder mit den Abstandsbolzen des Pi.
Mehrhöhe des Stapels: rund 10 mm.

Alle Maße stammen aus der offiziellen KiCad-Vorlage `RaspberryPi-HAT`
(Pin 1 bei (8,37, 4,77), gerade Reihe bei 2,23 mm, Bohrungen (3,5, 3,5) und
(61,5, 3,5)) — dieselbe Quelle, gegen die auch die Hauptplatine seit dem
Fehler automatisch geprüft wird.

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

# Geometrie aus der HAT-Vorlage (bezogen auf die linke obere Platinenecke;
# die Kante y=0 zeigt zur Außenkante des Pi).
COL0 = 8.37          # Spalte von Pin 1/2
PITCH = 2.54
ROW_EVEN = 4.77 - PITCH   # 2,23 — gerade Reihe des Pi (außen)
ROW_ODD = 4.77            # ungerade Reihe (innen), Stapelstifte
ROW_SHIFTED = 4.77 + PITCH  # 7,31 — gespiegelte gerade Reihe der Analyzer-Platine
HOLES = [(3.5, 3.5), (61.5, 3.5)]
HOLE_FP = "MountingHole:MountingHole_2.7mm_M2.5"

SOCKET_FP = "Connector_PinSocket_2.54mm:PinSocket_2x20_P2.54mm_Vertical"
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
        path = base / f"{lib}.pretty"
        fp = pcbnew.FootprintLoad(str(path), name)
        if fp is not None:
            return fp
    raise FileNotFoundError(fp_id)


def pad_pos(fp: pcbnew.FOOTPRINT, number: str) -> tuple[float, float]:
    p = fp.FindPadByNumber(number).GetPosition()
    return (pcbnew.ToMM(p.x) - ORIGIN_X, pcbnew.ToMM(p.y) - ORIGIN_Y)


def place_socket(board: pcbnew.BOARD, nets: dict) -> pcbnew.FOOTPRINT:
    """2×20 in der Geometrie der HAT-Vorlage: geflippt, −90°, Pin 1 bei
    (8,37, 4,77). Wird nach dem Platzieren gegen die Sollpositionen geprüft."""
    fp = load_footprint(SOCKET_FP)
    fp.SetReference("J1")
    fp.SetValue("Stapelbuchse 2x20 (kopfueber)")
    board.Add(fp)
    fp.Flip(at(COL0, ROW_ODD), False)
    fp.SetPosition(at(COL0, ROW_ODD))
    fp.SetOrientationDegrees(-90)
    for n, want in (("1", (COL0, ROW_ODD)), ("2", (COL0, ROW_EVEN)),
                    ("39", (COL0 + 19 * PITCH, ROW_ODD)),
                    ("40", (COL0 + 19 * PITCH, ROW_EVEN))):
        got = pad_pos(fp, n)
        if abs(got[0] - want[0]) > 0.01 or abs(got[1] - want[1]) > 0.01:
            raise SystemExit(f"J1-Pad {n}: {got} statt {want} — Flip/Drehung prüfen")
    for pad in fp.Pads():
        pad.SetNet(nets[f"P{pad.GetNumber()}"])
    return fp


def place_header(board: pcbnew.BOARD, nets: dict) -> pcbnew.FOOTPRINT:
    """1×20 auf der Oberseite, Reihe bei y=7,31; Pad k führt Signal P(2k)."""
    fp = load_footprint(HEADER_FP)
    fp.SetReference("J2")
    fp.SetValue("Stiftleiste 1x20 (gerade Pins)")
    board.Add(fp)
    fp.SetPosition(at(COL0, ROW_SHIFTED))
    fp.SetOrientationDegrees(-90)
    got = pad_pos(fp, "2")
    if abs(got[0] - (COL0 + PITCH)) > 0.01 or abs(got[1] - ROW_SHIFTED) > 0.01:
        fp.SetOrientationDegrees(90)
        got = pad_pos(fp, "2")
        if abs(got[0] - (COL0 + PITCH)) > 0.01 or abs(got[1] - ROW_SHIFTED) > 0.01:
            raise SystemExit(f"J2-Pad 2: {got} — Drehung prüfen")
    for pad in fp.Pads():
        k = int(pad.GetNumber())
        pad.SetNet(nets[f"P{2 * k}"])
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

    place_socket(board, nets)
    place_header(board, nets)

    # Je gerader Position eine kurze Bahn von der Pi-Reihe (2,23) zur
    # versetzten Reihe (7,31). Der Korridor bei Spalte+1,27 läuft mittig
    # zwischen zwei ungeraden Pads hindurch (Restabstand ≥ 0,29 mm bei 0,3er
    # Bahn, ≥ 0,22 mm bei 0,4er Versorgungsbahn).
    for k in range(20):
        n = 2 * (k + 1)
        c = COL0 + k * PITCH
        lane = c + 1.27
        width = W_POWER if n in POWER_EVEN else W_SIGNAL
        add_track(board, nets, f"P{n}", width,
                  [(c, ROW_EVEN), (lane, ROW_EVEN + 1.27),
                   (lane, ROW_ODD + 1.27), (c, ROW_SHIFTED)])

    def silk(text, x, y, size=1.0, layer=pcbnew.F_SilkS):
        t = pcbnew.PCB_TEXT(board)
        t.SetText(text)
        t.SetPosition(at(x, y))
        t.SetTextSize(pcbnew.VECTOR2I(mm(size), mm(size)))
        t.SetTextThickness(mm(0.15 * size))
        t.SetLayer(layer)
        if layer in (pcbnew.B_SilkS,):
            t.SetMirrored(True)
        board.Add(t)

    silk("AskSin J1-Adapter v1.0 — Analyzer oben aufstecken", 32.5, 10.4, 0.9)
    silk("Pi-Header unten", 32.5, 10.4, 1.0, pcbnew.B_SilkS)

    # Die Standard-Referenztexte der Footprints landen außerhalb des schmalen
    # Umrisses — ausblenden, die Bestückung ist mit zwei Bauteilen eindeutig.
    for fp in board.GetFootprints():
        fp.Reference().SetVisible(False)
        fp.Value().SetVisible(False)

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
    print("  J1-Pads gegen die HAT-Vorlagen-Geometrie geprüft: OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
