#!/usr/bin/env python3
"""
Erzeugt den J1-Rettungsadapter für die Platinen der Hardware v0.0.1.

Das Fehlerbild
--------------
Gemessen an der gefertigten Platine (Koordinaten ab der vorderen
Platinenkante, also der Kante, die beim Pi zur Platinenkante zeigt):

    Raspberry Pi / PoE-HAT      gerade Pins (2,4,…) bei 2,23 mm
                                ungerade Pins (1,3,…) bei 4,77 mm

    Analyzer-Platine v0.0.1     ungerade Pins bei 4,77 mm   (richtig)
                                gerade Pins bei 7,31 mm     (falsche Seite)

Die gerade Reihe liegt also nicht zwischen ungerader Reihe und Kante,
sondern dahinter. Aufgesteckt passt kein einziges Pad — 5 V läge auf 3,3 V,
Masse auf GPIOs. **Diese Platinen niemals ohne Adapter einschalten.**

Wie der Adapter das löst
------------------------
Nicht durch Umsortieren einzelner Reihen, sondern indem das **ganze
Steckbild um 2,54 mm nach hinten versetzt** wird. Dann stimmt die
Reihenfolge wieder:

    Adapter unten (zum PoE-HAT)     Buchsenleiste 2×20
                                    Pin 2 bei 2,23 · Pin 1 bei 4,77
                                    → exakt die Pi-Geometrie

    Adapter oben (zur Platine)      Stiftleiste 2×20
                                    Pin 1 bei 7,31 · Pin 2 bei 9,85
                                    → genau dort erwartet die Platine
                                      ihre ungerade bzw. gerade Reihe

Jeder Pin geht schnurstracks von unten nach oben: Pin n der Buchse auf
Pin n der Stiftleiste. Die ungeraden Bahnen laufen 2,54 mm auf der
Oberseite, die geraden 7,62 mm auf der Unterseite an den Pads vorbei.

Beides sind **gewöhnliche Standardteile** — eine normale Buchsenleiste
2×20 und eine normale Stiftleiste 2×20, RM 2,54. Keine Stapelbuchsen,
keine besonderen Pinlängen, nichts, was in der Höhe zueinander passen
müsste.

    ┌───────────────────────────┐  Analyzer-Platine (v0.0.1)
    │  Buchse 2x20 (unten dran) │
    └──┬───────────────────────┬┘
       │ Stiftleiste 2x20      │     ← Adapter oben, Reihen 7,31 / 9,85
    ┌──┴───────────────────────┴──┐
    │        A D A P T E R        │  65 x 14 mm, 2 Lagen
    └──┬───────────────────────┬──┘
       │ Buchsenleiste 2x20    │     ← Adapter unten, Reihen 2,23 / 4,77
    ┌──┴───────────────────────┴──┐
    │  Stiftleiste des PoE-HAT    │
    └─────────────────────────────┘

Preis dafür: Die Analyzer-Platine sitzt **2,54 mm weiter hinten** als
vorgesehen, ihre Bohrungen MH1/MH2 fluchten also nicht mehr mit den
Abstandsbolzen des Pi. Im 19-Zoll-Rahmen wird sie ohnehin an der
Druckhalterung verschraubt; ansonsten helfen Nylon-Distanzstücke.
Zusätzliche Bauhöhe des Stapels: rund 10 mm.

Die Sollpositionen werden nach dem Platzieren gegen die gemessene
Geometrie geprüft — jede Abweichung bricht den Lauf ab.

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
BOARD_W, BOARD_H = 65.0, 14.0

COL0 = 8.37               # Spalte von Pin 1/2 (aus der HAT-Vorlage)
PITCH = 2.54
SPALTEN = 20

# Unten: Pi-Geometrie. Oben: um 2,54 mm nach hinten versetzt.
UNTEN_UNGERADE, UNTEN_GERADE = 4.77, 2.23
OBEN_UNGERADE, OBEN_GERADE = 7.31, 9.85

HOLES = [(3.5, 3.5), (61.5, 3.5)]
HOLE_FP = "MountingHole:MountingHole_2.7mm_M2.5"
SOCKET_FP = "Connector_PinSocket_2.54mm:PinSocket_2x20_P2.54mm_Vertical"
HEADER_FP = "Connector_PinHeader_2.54mm:PinHeader_2x20_P2.54mm_Vertical"

# Pi-Pins mit Versorgungsfunktion bekommen breitere Bahnen.
POWER_PINS = {1, 2, 4, 6, 9, 14, 17, 20, 25, 30, 34, 39}
W_POWER, W_SIGNAL = 0.5, 0.35
CLEARANCE = 0.15


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


def pad_xy(fp: pcbnew.FOOTPRINT, nummer: int) -> tuple[float, float]:
    p = fp.FindPadByNumber(str(nummer)).GetPosition()
    return (pcbnew.ToMM(p.x) - ORIGIN_X, pcbnew.ToMM(p.y) - ORIGIN_Y)


def soll(nummer: int, reihe_ungerade: float, reihe_gerade: float) -> tuple[float, float]:
    """Sollposition von Pin `nummer`: Spalte aus der Pinnummer, Reihe aus
    gerade/ungerade. Gerundet, damit sie sich mit gemessenen Pad-Positionen
    vergleichen lässt (8,37 + 3·2,54 ergibt sonst 15,989999999999998)."""
    spalte = (nummer - 1) // 2
    reihe = reihe_ungerade if nummer % 2 else reihe_gerade
    return (round(COL0 + spalte * PITCH, 2), round(reihe, 2))


def place(board, nets, fp_id, ref, value, reihe_ungerade, reihe_gerade, flip):
    """Leiste setzen; die Netze werden **nach gemessener Position** vergeben.

    Der Kern der Lehre aus dem Fehler in v0.0.1: Die Pin-Nummerierung eines
    Footprints ist eine Konvention, das Bauteil selbst ist ein symmetrischer
    Block. Verlässt man sich darauf, dass Pad 2 „unterhalb" von Pad 1 liegt,
    kippt bei Drehung oder Flip genau das um — unbemerkt.

    Deshalb hier: Leiste so setzen, dass ihre beiden Reihen auf den beiden
    Sollreihen liegen (welche Reihe welche Padnummern trägt, ist egal), und
    anschließend jedem Pad **aus seiner Lage** das Pi-Signal zuordnen:
    Spalte aus der x-Position, gerade/ungerade aus der Reihe. Zum Schluss
    wird geprüft, dass alle 40 Sollpositionen genau einmal getroffen sind.
    """
    fp = load_footprint(fp_id)
    fp.SetReference(ref)
    fp.SetValue(value)
    board.Add(fp)
    if flip:
        fp.Flip(at(COL0, reihe_ungerade), False)

    # Die KiCad-Footprints laufen senkrecht (Spalten entlang y) und haben
    # ihren Bezugspunkt auf Pad 1. Welches Pad nach Drehung und Flip in der
    # linken oberen Rasterecke landet, hängt von beidem ab — also alle
    # Kombinationen durchprobieren und die nehmen, die das Sollraster deckt.
    ziele = {soll(n, reihe_ungerade, reihe_gerade) for n in range(1, 41)}
    beste = None
    gefunden = False
    for winkel in (0.0, 90.0, 180.0, 270.0):
        for anker_pad in (1, 2, 39, 40):
            for anker_reihe in (reihe_ungerade, reihe_gerade):
                fp.SetOrientationDegrees(winkel)
                fp.SetPosition(at(COL0, anker_reihe))
                ist = pad_xy(fp, anker_pad)
                pos = fp.GetPosition()
                fp.SetPosition(pcbnew.VECTOR2I(pos.x + mm(COL0 - ist[0]),
                                               pos.y + mm(anker_reihe - ist[1])))
                treffer = {(round(x, 2), round(y, 2))
                           for x, y in (pad_xy(fp, n) for n in range(1, 41))}
                fehler = len(ziele - treffer)
                beste = fehler if beste is None else min(beste, fehler)
                if not fehler:
                    gefunden = True
                    break
            if gefunden:
                break
        if gefunden:
            break
    if not gefunden:
        raise SystemExit(f"{ref}: keine Lage deckt das Sollraster "
                         f"({beste} Positionen unbesetzt)")

    for pad in fp.Pads():
        x, y = pad_xy(fp, int(pad.GetNumber()))
        spalte = round((x - COL0) / PITCH)
        if abs(y - reihe_ungerade) < 0.01:
            signal = 2 * spalte + 1
        elif abs(y - reihe_gerade) < 0.01:
            signal = 2 * spalte + 2
        else:
            raise SystemExit(f"{ref}: Pad {pad.GetNumber()} liegt bei y={y:.2f} "
                             "auf keiner der beiden Sollreihen")
        if not 1 <= signal <= 40:
            raise SystemExit(f"{ref}: Pad {pad.GetNumber()} ergibt Signal {signal}")
        pad.SetNet(nets[f"P{signal}"])

    vergeben = sorted(int(p.GetNetname()[1:]) for p in fp.Pads())
    if vergeben != list(range(1, 41)):
        raise SystemExit(f"{ref}: Signalzuordnung unvollständig: {vergeben}")
    return fp


def add_track(board, nets, netz, breite, lage, punkte):
    for a, b in zip(punkte, punkte[1:]):
        t = pcbnew.PCB_TRACK(board)
        t.SetStart(at(*a))
        t.SetEnd(at(*b))
        t.SetWidth(mm(breite))
        t.SetLayer(lage)
        t.SetNet(nets[netz])
        board.Add(t)


def main() -> int:
    board = pcbnew.BOARD()
    board.SetCopperLayerCount(2)

    ecken = [(0, 0), (BOARD_W, 0), (BOARD_W, BOARD_H), (0, BOARD_H)]
    for i in range(4):
        seg = pcbnew.PCB_SHAPE(board)
        seg.SetShape(pcbnew.SHAPE_T_SEGMENT)
        seg.SetStart(at(*ecken[i]))
        seg.SetEnd(at(*ecken[(i + 1) % 4]))
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

    place(board, nets, SOCKET_FP, "J1", "Buchsenleiste 2x20 (unten, zum PoE-HAT)",
          UNTEN_UNGERADE, UNTEN_GERADE, flip=True)
    place(board, nets, HEADER_FP, "J2", "Stiftleiste 2x20 (oben, zur Platine)",
          OBEN_UNGERADE, OBEN_GERADE, flip=False)

    # Ungerade Pins: 2,54 mm gerade nach hinten, nichts liegt dazwischen.
    # Gerade Pins: 7,62 mm — die Bahn weicht dafür auf die Spaltenmitte aus
    # (1,27 mm neben den Pads) und läuft auf der Unterseite.
    for n in range(1, 41):
        x, y_unten = soll(n, UNTEN_UNGERADE, UNTEN_GERADE)
        _, y_oben = soll(n, OBEN_UNGERADE, OBEN_GERADE)
        breite = W_POWER if n in POWER_PINS else W_SIGNAL
        if n % 2:
            add_track(board, nets, f"P{n}", breite, pcbnew.F_Cu,
                      [(x, y_unten), (x, y_oben)])
        else:
            gasse = x + PITCH / 2
            add_track(board, nets, f"P{n}", W_SIGNAL, pcbnew.B_Cu,
                      [(x, y_unten), (gasse, y_unten + PITCH / 2),
                       (gasse, y_oben - PITCH / 2), (x, y_oben)])

    def silk(text, x, y, size=0.9, lage=pcbnew.F_SilkS):
        t = pcbnew.PCB_TEXT(board)
        t.SetText(text)
        t.SetPosition(at(x, y))
        t.SetTextSize(pcbnew.VECTOR2I(mm(size), mm(size)))
        t.SetTextThickness(mm(0.15 * size))
        t.SetLayer(lage)
        if lage == pcbnew.B_SilkS:
            t.SetMirrored(True)
        board.Add(t)

    silk("AskSin J1-Adapter v2 — Analyzer-Platine hier oben aufstecken",
         32.5, 12.8, 0.85)
    silk("Diese Seite auf den PoE-HAT", 32.5, 12.8, 0.9, pcbnew.B_SilkS)
    silk("1", COL0 - 2.2, OBEN_UNGERADE, 0.9)
    silk("1", COL0 - 2.2, UNTEN_UNGERADE, 0.9, pcbnew.B_SilkS)

    for fp in board.GetFootprints():
        fp.Reference().SetVisible(False)
        fp.Value().SetVisible(False)

    board.Save(str(OUT))

    pro = {
        "meta": {"filename": f"{PROJECT}.kicad_pro", "version": 3},
        "board": {"design_settings": {"rules": {
            "min_clearance": CLEARANCE, "min_track_width": 0.25,
            "min_via_diameter": 0.6, "min_through_hole_diameter": 0.3,
            "min_hole_clearance": 0.25, "min_silk_clearance": 0.0,
        }}},
        "net_settings": {"classes": [
            {"name": "Default", "clearance": CLEARANCE, "track_width": 0.35,
             "via_diameter": 0.6, "via_drill": 0.3},
        ]},
        "schematic": {}, "sheets": [], "text_variables": {},
    }
    (HERE / f"{PROJECT}.kicad_pro").write_text(json.dumps(pro, indent=2) + "\n")

    print(f"geschrieben: {OUT.name}   ({BOARD_W:.0f} × {BOARD_H:.0f} mm, 2 Lagen)")
    print(f"  J1 unten (Buchse)   Reihen {UNTEN_GERADE} / {UNTEN_UNGERADE} mm "
          "— Pi-Geometrie")
    print(f"  J2 oben  (Stifte)   Reihen {OBEN_UNGERADE} / {OBEN_GERADE} mm "
          "— Geometrie der Platine v0.0.1")
    print("  alle 40 Pads beider Leisten gegen die Sollgeometrie geprüft: OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
