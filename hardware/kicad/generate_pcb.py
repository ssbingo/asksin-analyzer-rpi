#!/usr/bin/env python3
"""
Erzeugt das Platinenlayout des AskSin-Analyzer, Hardware v0.2.0.

Bauform
-------
T-förmig, liegend: Der **Körper** liegt **parallel neben dem Raspberry Pi**
auf der Seite des 40-poligen Headers — nicht mehr über dessen Buchsen. Ein
schmaler **Arm** ragt nur so weit über den Pi, wie die 2×20-Buchse und die
beiden HAT-Bohrungen brauchen. Nach hinten (SD-Karten-Seite) steht der Körper
20 mm über den Pi hinaus; dort sitzt das Funkmodul mit der IPEX-Buchse — im
19-Zoll-Einbau direkt am rückwärtigen Antennen-Keystone und maximal weit weg
vom Störnebel aus Schaltreglern, HDMI und USB3.

Position der 2×20-Buchse und die beiden Bohrungen im Arm stammen aus der
offiziellen KiCad-Vorlage `RaspberryPi-HAT` und sind damit nicht geraten;
J1 wird wie in der Vorlage **auf die Unterseite geflippt** (−90°) — genau der
Schritt, der bei v0.0.1 fehlte und die gerade Pin-Reihe spiegelte. Die
erzeugten Pad-Positionen werden nach dem Platzieren gegen die Sollwerte
geprüft, zusätzlich prüft `verify_j1.py` gegen die installierte Vorlage.

Geroutet wird in `autoroute.py` (Fallback: `route_pcb.py`).

Aufruf:
    python3 generate_pcb.py
    kicad-cli pcb drc --output drc.rpt AskSin-Analyzer-V3.kicad_pcb
"""

from __future__ import annotations

import json
import pathlib
import sys

import pcbnew

from generate_schematic import COMPONENTS, NETS, PROJECT

HERE = pathlib.Path(__file__).resolve().parent
FP_DIRS = [pathlib.Path("/usr/share/kicad/footprints"), HERE / "lib"]
OUT = HERE / f"{PROJECT}.kicad_pcb"

# Arbeitsursprung in der Zeichnung; die Platine beginnt bei (0,0) links oben.
ORIGIN_X, ORIGIN_Y = 100.0, 60.0

# --- Umriss -----------------------------------------------------------------
# L-Form, liegend neben dem Raspberry Pi. Maße des Pi aus den amtlichen
# Zeichnungen (rpi3-b-plus / rpi4 / rpi5, alle gleich): 85 × 56 mm,
# Befestigungslöcher ø2,7 im Raster 58 × 49 mm, je 3,5 mm von den Kanten.
#
#   Streifen  neben der Header-Kante, höchstens 20 mm breit
#   Arm       nur so tief über den Pi, wie Buchse und HAT-Bohrungen brauchen
#   Schenkel  neben der SD-Kante, außerhalb des Pi
#   Nasen     zwei kleine Vorsprünge über den Pi, ausschließlich an dessen
#             hinteren Befestigungslöchern — dadurch liegt über dem PoE-HAT
#             fast nichts, und der Lüfter bleibt unabhängig vom HAT-Modell frei
#             (Waveshare (F) für Pi 5, (C) für Pi 3B/4).
# Der Schenkel liegt HINTER dem Pi (SD-Seite). Jede Verlängerung der Platine
# geht ausschließlich hierhin — nach vorn (Buchsenseite) darf sie den Pi
# **nicht** überragen, dort sitzen im 19-Zoll-Einbau die Keystone-Module.
LEG_W = 32.0        # Tiefe des Schenkels hinter der SD-Kante
STRIP_H = 20.0      # Breite des Streifens neben dem Pi — Obergrenze!
ARM_D = 8.0         # Tiefe des Arms über dem Pi (Buchse + Bohrungen)
NASE_D = 7.0        # Tiefe der Nasen über dem Pi
NASE_H = 9.0        # Höhe der Nasen
BOARD_L = 100.0     # Gesamtlänge — Obergrenze laut Vorgabe

PI_X0 = LEG_W       # SD-Kante des Pi in Platinenkoordinaten
PI_Y0 = STRIP_H     # Header-Kante des Pi
PI_W, PI_H = 85.0, 56.0
ARM_X0 = PI_X0
ARM_X1 = PI_X0 + 65.0            # Armlänge = HAT-Breite
LEG_Y1 = PI_Y0 + PI_H            # Schenkel bis zur hinteren Pi-Kante

# Befestigungslöcher des Pi, in Platinenkoordinaten
PI_LOCH = [(PI_X0 + 3.5, PI_Y0 + 3.5), (PI_X0 + 61.5, PI_Y0 + 3.5),
           (PI_X0 + 3.5, PI_Y0 + 52.5)]

# Umriss gegen den Uhrzeigersinn ab der linken oberen Ecke. Die zweite Nase
# sitzt am unteren Ende des Schenkels, die erste liegt bereits im Arm.
# Die Nase schließt bündig mit der Schenkelunterkante ab — das spart eine
# Innenecke und legt das Loch (y = PI_Y0 + 52,5) mittig hinein.
NASE_Y0 = LEG_Y1 - NASE_H
OUTLINE = [
    (0.0, 0.0), (BOARD_L, 0.0), (BOARD_L, PI_Y0),
    (ARM_X1, PI_Y0), (ARM_X1, PI_Y0 + ARM_D),
    (ARM_X0, PI_Y0 + ARM_D),
    (ARM_X0, NASE_Y0), (ARM_X0 + NASE_D, NASE_Y0),
    (ARM_X0 + NASE_D, LEG_Y1), (0.0, LEG_Y1),
]


def inset_ring(inset: float) -> list[tuple[float, float]]:
    """Der Umriss, um `inset` nach innen versetzt — für Kupferflächen und den
    Specctra-Export. Die Innenecken sind konkav; die Vorzeichen sind deshalb je
    Ecke von Hand gesetzt (eine Pauschalregel kippt dort und erzeugt ein sich
    selbst schneidendes Polygon)."""
    i = inset
    # An den beiden **einspringenden** Ecken (Armunterkante/Schenkelkante und
    # Schenkelkante/Nasenoberkante) liegt das Platinenmaterial jeweils LINKS
    # der Kante x = ARM_X0. Der Versatz muss dort also nach links gehen
    # (ARM_X0 − i). Ging er nach rechts, lag die Kontur außerhalb der Platine
    # und Freerouting legte Bahnen über die Kante hinaus.
    return [
        (i, i), (BOARD_L - i, i), (BOARD_L - i, PI_Y0 - i),
        (ARM_X1 - i, PI_Y0 - i), (ARM_X1 - i, PI_Y0 + ARM_D - i),
        (ARM_X0 - i, PI_Y0 + ARM_D - i),
        (ARM_X0 - i, NASE_Y0 + i), (ARM_X0 + NASE_D - i, NASE_Y0 + i),
        (ARM_X0 + NASE_D - i, LEG_Y1 - i), (i, LEG_Y1 - i),
    ]


# MH1/MH2 greifen in die vorderen Abstandsbolzen des Pi (im Arm), MH3 in das
# hintere Loch derselben Seite (in der unteren Nase). MH4 hält den Streifen im
# 19-Zoll-Tray und liegt neben dem Pi.
HOLES = [PI_LOCH[0], PI_LOCH[1], PI_LOCH[2], (28.0, 71.0), (97.0, 16.5)]
HOLE_FP = "MountingHole:MountingHole_2.7mm_M2.5"

# Zugentlastung für das Antennenkabel: zwei Löcher für einen Kabelbinder,
# direkt neben der IPEX-Buchse des Moduls. Der U.FL-Stecker ist auf rund
# 30 Steckzyklen ausgelegt und springt unter Zug ab — bei fest verbauten
# Geräten ist die Entlastung billiger als ein Serviceeinsatz.
TIE_HOLES = [(10.0, 47.0), (15.5, 47.0)]
TIE_FP = "MountingHole:MountingHole_2.1mm"

# Position der 2×20-Buchse aus der offiziellen HAT-Vorlage: Pin 1 liegt
# 8,37 mm hinter der SD-Kante und 4,77 mm unter der Header-Kante des Pi.
# Drehung −90° und Flip auf die Unterseite wie in der Vorlage.
J1_POS = (PI_X0 + 8.37, PI_Y0 + 4.77, -90.0)

EDGE_MARGIN = 0.4


def mm(value: float) -> int:
    return pcbnew.FromMM(value)


def at(x: float, y: float) -> pcbnew.VECTOR2I:
    return pcbnew.VECTOR2I(mm(ORIGIN_X + x), mm(ORIGIN_Y + y))


# ---------------------------------------------------------------- Platzierung
#
# Leitgedanken:
#   * Im Arm liegt nur die Buchse. Alles andere dort säße über dem PoE-HAT.
#   * Das Funkmodul sitzt ganz links im hinteren Überstand — im Rack direkt
#     am rückwärtigen Antennen-Keystone, maximal weit weg vom Pi.
#   * Die drei Peripheriestecker liegen an der rechten (vorderen) Kante —
#     kurze Wege zum OLED/LED/Taster-Einsatz an der Rack-Front.
#   * Abblockkondensatoren jeweils am Versorgungspin, nicht in einer Reihe.
PLACEMENT: dict[str, tuple[float, float, float]] = {
    "J1":  J1_POS,

    # --- Funk-Frontend in den Schenkel HINTER den Pi ------------------------
    # Dort ist mit 32 mm Breite Platz fuer das 17,5 x 21 mm grosse Modul; im
    # 20 mm schmalen Streifen ginge es nur quer und wuerde ihn blockieren.
    # Die IPEX-Buchse zeigt nach hinten zum Antennen-Keystone, die Zugentlastung
    # sitzt direkt darunter.
    "U3":  (16.0, 33.0, 0),
    "C5":  (28.0, 24.0, 90),
    "R3":  (28.0, 29.0, 90),

    # --- ISP und Pruefpunkte im unteren Schenkel ---------------------------
    "J2":  (25.0, 56.0, 0),
    "TP2": (5.0, 52.0, 0),
    "TP3": (5.0, 55.5, 0),
    "TP4": (5.0, 59.0, 0),
    "TP5": (5.0, 62.5, 0),
    "TP6": (5.0, 66.0, 0),
    "TP7": (5.0, 69.5, 0),
    "TP8": (5.0, 73.0, 0),

    # --- Mikrocontroller im hinteren Streifen, dicht am Funkmodul ----------
    "U2":  (12.0, 10.0, 0),
    # Anker des Resonators liegt auf Pin 1, nicht in der Mitte:
    "Y1":  (20.0, 4.0, 0),
    "C3":  (22.0, 9.0, 0),
    "C4":  (22.0, 13.0, 0),
    "C9":  (29.5, 4.0, 0),
    "R2":  (28.0, 9.0, 0),
    "C8":  (28.0, 13.0, 0),
    "TP1": (33.0, 4.0, 0),

    # --- Versorgung entlang der Aussenkante --------------------------------
    "U1":  (40.0, 4.0, 0),
    "C1":  (45.0, 4.0, 0),
    "L1":  (50.0, 4.0, 0),
    "C2":  (55.0, 4.0, 0),

    # --- Status-LED und Reset ----------------------------------------------
    "R1":  (40.0, 11.0, 0),
    "D1":  (45.0, 11.0, 0),
    "S1":  (52.0, 11.0, 0),

    # --- LED-Weg: Schiebeschalter an der Aussenkante ------------------------
    "SW1": (64.0, 5.0, 180),
    "R4":  (64.0, 12.0, 0),

    # --- Peripheriestecker am vorderen Ende (Rack-Front) --------------------
    "J5":  (86.5, 3.5, 0),        # OLED, I2C
    "J6":  (88.0, 10.0, 0),       # Taster
    "J7":  (87.0, 16.0, 0),       # WS2812
}


def load_footprint(fp_id: str) -> pcbnew.FOOTPRINT:
    lib, name = fp_id.split(":", 1)
    for base in FP_DIRS:
        path = base / f"{lib}.pretty"
        if path.is_dir():
            fp = pcbnew.FootprintLoad(str(path), name)
            if fp is not None:
                return fp
    raise FileNotFoundError(f"Footprint {fp_id} nicht gefunden")


def inside_board(x0: float, y0: float, x1: float, y1: float) -> bool:
    """Liegt das Rechteck vollständig im L-Umriss, mit Randabstand?

    Geprüft wird gegen die vier **größtmöglichen** Rechtecke, die die Form
    überdecken. Ein Bauteil ist zulässig, wenn es in mindestens eines davon
    ganz hineinpasst — konservativ, aber niemals falsch positiv.
    """
    m = EDGE_MARGIN
    bereiche = [
        (0.0, 0.0, LEG_W, LEG_Y1),                       # Schenkel + Streifen
        (0.0, 0.0, BOARD_L, PI_Y0),                      # Streifen
        (ARM_X0, 0.0, ARM_X1, PI_Y0 + ARM_D),            # Arm + Streifen
        (ARM_X0, NASE_Y0, ARM_X0 + NASE_D, LEG_Y1),       # untere Nase
    ]
    return any(
        x0 >= bx0 + m and y0 >= by0 + m and x1 <= bx1 - m and y1 <= by1 - m
        for bx0, by0, bx1, by1 in bereiche
    )


def build_board():
    board = pcbnew.BOARD()
    board.SetCopperLayerCount(4)
    stack = board.GetEnabledLayers().CuStack()

    pts = OUTLINE + [OUTLINE[0]]
    for i in range(len(OUTLINE)):
        seg = pcbnew.PCB_SHAPE(board)
        seg.SetShape(pcbnew.SHAPE_T_SEGMENT)
        seg.SetStart(at(*pts[i]))
        seg.SetEnd(at(*pts[i + 1]))
        seg.SetLayer(pcbnew.Edge_Cuts)
        seg.SetWidth(mm(0.1))
        board.Add(seg)

    for idx, (hx, hy) in enumerate(HOLES, start=1):
        fp = load_footprint(HOLE_FP)
        fp.SetReference(f"MH{idx}")
        fp.SetPosition(at(hx, hy))
        board.Add(fp)
    for idx, (hx, hy) in enumerate(TIE_HOLES, start=1):
        fp = load_footprint(TIE_FP)
        fp.SetReference(f"KB{idx}")
        fp.SetPosition(at(hx, hy))
        board.Add(fp)

    nets = {}
    for name in NETS:
        item = pcbnew.NETINFO_ITEM(board, name)
        board.Add(item)
        nets[name] = item
    pad_net = {}
    for net_name, pins in NETS.items():
        for ref, pin in pins:
            pad_net[(ref, pin)] = net_name

    placed = {}
    for ref, (_lib_id, value, fp_id, _x, _y) in COMPONENTS.items():
        if ref not in PLACEMENT:
            raise KeyError(f"Für {ref} fehlt eine Platzierung")
        fp = load_footprint(fp_id)
        fp.SetReference(ref)
        fp.SetValue(value)
        px, py, rot = PLACEMENT[ref]
        board.Add(fp)
        if ref == "J1":
            # Wie in der offiziellen HAT-Vorlage: Buchse auf der Unterseite.
            # Genau dieser Flip fehlte bei v0.0.1 — deshalb wird das Ergebnis
            # unten hart gegen die Sollpositionen geprüft.
            fp.Flip(at(px, py), False)
        fp.SetPosition(at(px, py))
        fp.SetOrientationDegrees(rot)
        placed[ref] = fp

    check_j1_geometry(placed["J1"])
    beschrifte_schalter(board, placed["SW1"])
    beschrifte_stecker(board, placed)

    unassigned = []
    for ref, fp in placed.items():
        for pad in fp.Pads():
            name = pad_net.get((ref, pad.GetNumber()))
            if name is None:
                unassigned.append(f"{ref}.{pad.GetNumber()}")
            else:
                pad.SetNet(nets[name])

    # Erst jetzt, mit zugewiesenen Netzen: Stützvias an die SMD-Massepads.
    masse_vias = place_ground_vias(board, placed, nets)

    return board, placed, nets, unassigned, stack, masse_vias


def place_ground_vias(board, placed, nets) -> int:
    """Jedem SMD-Massepad **vor** dem Routen sein Stützvia danebensetzen.

    Sonst belegt der Autorouter genau diese Fläche mit Bahnen, und die
    Massepins der eng bepinnten Bauteile (ATmega, Funkmodul) bekommen
    hinterher keine Verbindung zu den Masseflächen der Innenlagen mehr.
    Umgekehrt weicht Freerouting vorhandenen Vias sauber aus.

    Jede Position wird vorher geometrisch gegen alle fremden Pads geprüft —
    inklusive der kurzen Bahn vom Pad zum Via. Findet sich kein sauberer
    Platz, bleibt der Pad offen; das Stützen übernimmt dann der Routing-
    Schritt (`route_pcb.stitch_plane_net`).
    """
    VIA_D, VIA_DRILL, BAHN_W = 0.6, 0.3, 0.3
    ABSTAND = 0.22            # etwas über der Netzklasse „Default" (0,20)

    fremde: list[tuple[float, float, float, float]] = []
    for fp in placed.values():
        for pad in fp.Pads():
            if pad.GetNetname() == "GND":
                continue
            bb = pad.GetBoundingBox()
            fremde.append((pcbnew.ToMM(bb.GetLeft()) - ORIGIN_X,
                           pcbnew.ToMM(bb.GetTop()) - ORIGIN_Y,
                           pcbnew.ToMM(bb.GetRight()) - ORIGIN_X,
                           pcbnew.ToMM(bb.GetBottom()) - ORIGIN_Y))

    def abstand_zu_fremd(x: float, y: float) -> float:
        d = 1e9
        for x0, y0, x1, y1 in fremde:
            dx = max(x0 - x, 0.0, x - x1)
            dy = max(y0 - y, 0.0, y - y1)
            d = min(d, (dx * dx + dy * dy) ** 0.5)
        return d

    def strecke_frei(x0, y0, x1, y1, halbbreite) -> bool:
        schritte = max(2, int(((x1 - x0) ** 2 + (y1 - y0) ** 2) ** 0.5 / 0.1))
        for i in range(schritte + 1):
            f = i / schritte
            if abstand_zu_fremd(x0 + (x1 - x0) * f,
                                y0 + (y1 - y0) * f) < halbbreite + ABSTAND:
                return False
        return True

    gnd = nets["GND"]
    stack = board.GetEnabledLayers().CuStack()
    gesetzt: list[tuple[float, float]] = []

    for ref, fp in sorted(placed.items()):
        mitte = fp.GetPosition()
        for pad in fp.Pads():
            if pad.GetNetname() != "GND" or pad.GetAttribute() != pcbnew.PAD_ATTRIB_SMD:
                continue
            pp = pad.GetPosition()
            px = pcbnew.ToMM(pp.x) - ORIGIN_X
            py = pcbnew.ToMM(pp.y) - ORIGIN_Y
            gr = pad.GetSize()
            dx = pcbnew.ToMM(pp.x - mitte.x)
            dy = pcbnew.ToMM(pp.y - mitte.y)
            laenge = max((dx * dx + dy * dy) ** 0.5, 0.001)
            basis = max(pcbnew.ToMM(gr.x), pcbnew.ToMM(gr.y)) / 2 + 0.75
            for faktor in (1.0, 1.3, 1.6, 2.0, 2.5):
                vx = px + dx / laenge * basis * faktor
                vy = py + dy / laenge * basis * faktor
                if not inside_board(vx - VIA_D / 2, vy - VIA_D / 2,
                                    vx + VIA_D / 2, vy + VIA_D / 2):
                    continue
                if any((vx - ax) ** 2 + (vy - ay) ** 2 < 1.1 ** 2
                       for ax, ay in gesetzt):
                    continue
                if abstand_zu_fremd(vx, vy) < VIA_D / 2 + ABSTAND:
                    continue
                if not strecke_frei(px, py, vx, vy, BAHN_W / 2):
                    continue
                via = pcbnew.PCB_VIA(board)
                via.SetPosition(at(vx, vy))
                via.SetWidth(mm(VIA_D))
                via.SetDrill(mm(VIA_DRILL))
                via.SetViaType(pcbnew.VIATYPE_THROUGH)
                via.SetLayerPair(stack[0], stack[-1])
                via.SetNet(gnd)
                board.Add(via)
                tr = pcbnew.PCB_TRACK(board)
                tr.SetStart(pp)
                tr.SetEnd(at(vx, vy))
                tr.SetWidth(mm(BAHN_W))
                tr.SetLayer(stack[0])
                tr.SetNet(gnd)
                board.Add(tr)
                gesetzt.append((vx, vy))
                break
    return len(gesetzt)


def beschrifte_schalter(board: pcbnew.BOARD, sw: pcbnew.FOOTPRINT) -> None:
    """„PWM" und „SPI" neben die zugehörigen Anschlüsse von SW1 drucken.

    Beschriftet werden bewusst die **Anschlüsse** (Pin 1 = GPIO18/PWM,
    Pin 3 = GPIO10/SPI), nicht die Schieberstellungen: Welche Stellung welchen
    Anschluss durchschaltet, gibt das Datenblatt von C&K nicht frei zugänglich
    her, die Pinbelegung dagegen steht fest. Am fertigen Gerät ist die Zuordnung
    mit einem Durchgangsprüfer in Sekunden bestätigt.

    Die Positionen kommen aus den tatsächlichen Pads, damit die Beschriftung
    einer Umplatzierung von SW1 automatisch folgt.
    """
    koerper_oben = sw.GetOrientationDegrees() % 360 == 180
    for nr, text in (("1", "PWM"), ("3", "SPI")):
        pad = sw.FindPadByNumber(nr)
        pos = pad.GetPosition()
        item = pcbnew.PCB_TEXT(board)
        item.SetText(text)
        item.SetLayer(pcbnew.F_SilkS)
        # Auf der pad-abgewandten Seite, damit nichts über Kupfer liegt.
        # 2,4 mm: halbe Padhöhe (1,25) + halbe Texthöhe (0,4) + Reserve
        versatz = 2.4 if koerper_oben else -2.4
        item.SetPosition(pcbnew.VECTOR2I(pos.x, pos.y + mm(versatz)))
        item.SetTextSize(pcbnew.VECTOR2I(mm(0.8), mm(0.8)))
        item.SetTextThickness(mm(0.13))
        board.Add(item)


# Peripheriestecker, die im Bestückungsdruck ihre Funktion tragen müssen.
# Der Text kommt aus dem Schaltplanwert, damit Aufdruck und Schaltplan nicht
# auseinanderlaufen können — eine zweite, handgepflegte Liste hat sich bei den
# unbestückten Plätzen schon einmal gerächt.
BESCHRIFTETE_STECKER = ("J5", "J6", "J7")


def beschrifte_stecker(board: pcbnew.BOARD,
                       placed: dict[str, pcbnew.FOOTPRINT]) -> None:
    """Funktion der drei Peripheriestecker auf die Platine drucken.

    J5, J6 und J7 sind baugleiche JST-PH-Buchsen und unterscheiden sich nur in
    der Polzahl — am fertigen Gerät ist ohne Aufdruck nicht zu erkennen, welche
    das OLED, welche den Taster und welche die WS2812 aufnimmt. Der Bezeichner
    allein hilft nicht: Wer die Kiste in Jahren öffnet, hat den Schaltplan nicht
    daneben liegen.

    Der Platz wird gesucht, nicht festgelegt: vier Kandidaten rund um die
    Buchse, der erste freie gewinnt. So folgt die Beschriftung einer
    Umplatzierung, statt bei der nächsten Änderung im Kupfer zu landen.
    """
    hoehe, dicke, luft = 0.8, 0.13, 0.6

    def box(fp: pcbnew.FOOTPRINT) -> tuple[float, float, float, float]:
        bb = fp.GetBoundingBox(False, False)
        return (pcbnew.ToMM(bb.GetLeft()), pcbnew.ToMM(bb.GetTop()),
                pcbnew.ToMM(bb.GetRight()), pcbnew.ToMM(bb.GetBottom()))

    def stoert(a, b) -> bool:
        return not (a[2] <= b[0] or b[2] <= a[0] or a[3] <= b[1] or b[3] <= a[1])

    # Alle Bauteile sind tabu, mit 0,3 mm Zuschlag wie im Aufräumlauf.
    hindernisse = [(x0 - 0.3, y0 - 0.3, x1 + 0.3, y1 + 0.3)
                   for x0, y0, x1, y1 in (box(fp) for fp in board.GetFootprints())]
    # Bereits gesetzte Texte (PWM/SPI am Schalter) ebenfalls.
    for item in board.GetDrawings():
        if item.GetClass() == "PCB_TEXT":
            p = item.GetPosition()
            w = len(item.GetText()) * hoehe * 0.72
            px, py = pcbnew.ToMM(p.x), pcbnew.ToMM(p.y)
            hindernisse.append((px - w / 2 - 0.3, py - hoehe / 2 - 0.3,
                                px + w / 2 + 0.3, py + hoehe / 2 + 0.3))

    for ref in BESCHRIFTETE_STECKER:
        fp = placed[ref]
        text = COMPONENTS[ref][1].upper()
        breite = len(text) * hoehe * 0.72
        x0, y0, x1, y1 = box(fp)
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        kandidaten = [
            (x0 - luft - breite / 2, cy),          # links
            (x1 + luft + breite / 2, cy),          # rechts
            (cx, y0 - luft - hoehe / 2),           # oben
            (cx, y1 + luft + hoehe / 2),           # unten
        ]
        for tx, ty in kandidaten:
            kasten = (tx - breite / 2, ty - hoehe / 2,
                      tx + breite / 2, ty + hoehe / 2)
            pruef = (kasten[0] - 0.25, kasten[1] - 0.25,
                     kasten[2] + 0.25, kasten[3] + 0.25)
            if any(stoert(pruef, h) for h in hindernisse):
                continue
            if not inside_board(kasten[0] - ORIGIN_X, kasten[1] - ORIGIN_Y,
                                kasten[2] - ORIGIN_X, kasten[3] - ORIGIN_Y):
                continue
            item = pcbnew.PCB_TEXT(board)
            item.SetText(text)
            item.SetLayer(pcbnew.F_SilkS)
            item.SetPosition(pcbnew.VECTOR2I(mm(tx), mm(ty)))
            item.SetTextSize(pcbnew.VECTOR2I(mm(hoehe), mm(hoehe)))
            item.SetTextThickness(mm(dicke))
            board.Add(item)
            hindernisse.append(pruef)
            break
        else:
            # Lieber laut abbrechen als still eine unbeschriftete Buchse
            # ausliefern — die Beschriftung ist eine ausdrückliche Vorgabe.
            raise SystemExit(
                f"Kein freier Platz fuer die Beschriftung von {ref} ({text})")


def check_j1_geometry(fp: pcbnew.FOOTPRINT) -> None:
    """Pad-Positionen von J1 gegen das Pi-Raster prüfen.

    Sollwerte relativ zur Header-Kante des Pi (y = BODY_H) und seiner SD-Kante
    (x = PI_X0), wie in der offiziellen HAT-Vorlage: Pin-1-Reihe 4,77 mm,
    gerade Reihe 2,23 mm unter der Kante, Spalten ab 8,37 mm im 2,54-Raster.
    """
    if not fp.IsFlipped():
        raise SystemExit("J1 liegt nicht auf der Unterseite — Flip fehlt!")
    soll = {
        "1":  (PI_X0 + 8.37, PI_Y0 + 4.77),
        "2":  (PI_X0 + 8.37, PI_Y0 + 2.23),
        "39": (PI_X0 + 8.37 + 19 * 2.54, PI_Y0 + 4.77),
        "40": (PI_X0 + 8.37 + 19 * 2.54, PI_Y0 + 2.23),
    }
    for nr, (sx, sy) in soll.items():
        p = fp.FindPadByNumber(nr).GetPosition()
        gx = pcbnew.ToMM(p.x) - ORIGIN_X
        gy = pcbnew.ToMM(p.y) - ORIGIN_Y
        if abs(gx - sx) > 0.01 or abs(gy - sy) > 0.01:
            raise SystemExit(f"J1-Pad {nr} bei ({gx:.2f}, {gy:.2f}), "
                             f"erwartet ({sx:.2f}, {sy:.2f}) — Buchse gespiegelt?")


def check_placement(placed: dict) -> list[str]:
    """Abstandsflächen gegeneinander, gegen die Bohrungen und gegen den Umriss.

    Bewusst vor dem Speichern: eine sich selbst überlappende Platzierung
    erzeugt im DRC einen Schwall von Folgefehlern, die alle dieselbe Ursache
    haben und den Blick auf echte Fehler verstellen.
    """
    boxes = {}
    for ref, fp in placed.items():
        shape = fp.GetCourtyard(pcbnew.F_CrtYd)
        bb = shape.BBox() if not shape.IsEmpty() else fp.GetBoundingBox(False, False)
        boxes[ref] = (pcbnew.ToMM(bb.GetLeft()) - ORIGIN_X,
                      pcbnew.ToMM(bb.GetTop()) - ORIGIN_Y,
                      pcbnew.ToMM(bb.GetRight()) - ORIGIN_X,
                      pcbnew.ToMM(bb.GetBottom()) - ORIGIN_Y)

    def overlap(a, b):
        return not (a[2] <= b[0] or b[2] <= a[0] or a[3] <= b[1] or b[3] <= a[1])

    problems = []
    refs = sorted(boxes)
    for i, ra in enumerate(refs):
        a = boxes[ra]
        if not inside_board(*a):
            problems.append(f"{ra} liegt nicht im Umriss: "
                            f"x {a[0]:6.1f}..{a[2]:6.1f}  y {a[1]:5.1f}..{a[3]:5.1f}")
        for hx, hy in HOLES + TIE_HOLES:
            if overlap(a, (hx - 2.4, hy - 2.4, hx + 2.4, hy + 2.4)):
                problems.append(f"{ra} liegt auf Bohrung ({hx}, {hy})")
        for rb in refs[i + 1:]:
            if overlap(a, boxes[rb]):
                problems.append(f"{ra} überlappt {rb}")
    return problems


def add_zones(board, nets, stack) -> None:
    # Der Versatz nach innen kommt aus inset_ring(): die Innenecken am
    # Armansatz sind konkav, eine Pauschalregel über die Mitte erzeugt dort
    # ein sich selbst schneidendes Polygon — KiCad stürzt daran beim Füllen ab.
    ring = inset_ring(0.3)

    def make_zone(layer, net_name):
        zone = pcbnew.ZONE(board)
        zone.SetLayer(layer)
        zone.SetNet(nets[net_name])
        zone.SetIsFilled(False)
        zone.SetLocalClearance(mm(0.3))
        zone.SetMinThickness(mm(0.2))
        # Thermische Entlastung **nur für Durchsteckpads**. Die Platine wird von
        # Hand bestückt, und dort sind die Durchsteckpins das Problem: ihr Pin
        # berührt die Massefläche auf allen vier Lagen und zieht die Wärme so
        # schnell ab, dass die Lötstelle nicht durchwärmt — bei den acht
        # Massepins der 40-poligen Buchse der Unterschied zwischen lötbar und
        # nicht lötbar. Ein SMD-Pad hängt dagegen nur an einer Lage; dort wäre
        # die Entlastung unnötig und würde bei feinem Raster (TQFP-32, 0,8 mm)
        # nicht einmal genug Speichen unterbringen.
        zone.SetPadConnection(pcbnew.ZONE_CONNECTION_THT_THERMAL)
        zone.SetThermalReliefGap(mm(0.25))
        zone.SetThermalReliefSpokeWidth(mm(0.4))
        # Teilflächen, die die Leiterbahnen abschneiden und die an keiner
        # Durchkontaktierung hängen, entfernen. Unverbundenes Kupfer bringt
        # nichts, meldet sich im DRC als offene Verbindung und wirkt im
        # 868-MHz-Bereich im schlechtesten Fall als Resonator.
        # ISLAND_REMOVAL_MODE_ALWAYS wird über die Python-Schnittstelle nicht
        # ausgewertet; über eine Mindestfläche greift die Entfernung dagegen.
        zone.SetIslandRemovalMode(pcbnew.ISLAND_REMOVAL_MODE_AREA)
        # Großzügig: Auf dem kleineren T-Umriss lassen sich nicht alle
        # Teilflächen mit einem Stützvia verankern — unverankertes Kupfer
        # fliegt komplett raus, statt als „isolierte Fläche" liegenzubleiben.
        # Masse führen die beiden durchgehenden Innenlagen.
        zone.SetMinIslandArea(pcbnew.FromMM(150.0) * pcbnew.FromMM(1.0))
        outline = zone.Outline()
        outline.NewOutline()
        for x, y in ring:
            outline.Append(mm(ORIGIN_X + x), mm(ORIGIN_Y + y))
        # Ohne dieses Schließen bleibt der Polygonzug offen. KiCad meldet das
        # nur als Warnung, der Füllalgorithmus stürzt aber daran ab, und im
        # Specctra-Export fehlt eine saubere Umrandung.
        outline.Outline(0).SetClosed(True)
        board.Add(zone)

    # Beide Innenlagen tragen Masse. Ein Versuch, In2.Cu als dritte
    # Signallage freizugeben, ging nach hinten los: Die Stützvias sind
    # durchgehend und schlagen dann quer durch die Signale — 120 Verstöße,
    # darunter echte Kurzschlüsse. Zwei durchgehende Masseflächen bleiben.
    for layer in list(stack)[1:-1]:
        make_zone(layer, "GND")


def write_project_settings() -> None:
    path = HERE / f"{PROJECT}.kicad_pro"
    data = json.loads(path.read_text()) if path.exists() else {}
    data.setdefault("meta", {"filename": f"{PROJECT}.kicad_pro", "version": 3})
    data["board"] = {
        "design_settings": {
            "rules": {
                "min_clearance": 0.13,
                "min_track_width": 0.15,
                "min_via_annular_width": 0.13,
                "min_via_diameter": 0.45,
                "min_through_hole_diameter": 0.3,
                # 0,15 statt 0,25: bindend ist die Herstellergeometrie von S1,
                # dessen Befestigungsstift nah an seinen eigenen Pads liegt.
                "min_hole_clearance": 0.15,
                "min_silk_clearance": 0.0,
            },
            "track_widths": [0.0, 0.25, 0.4, 0.8],
            "via_dimensions": [{"diameter": 0.0, "drill": 0.0},
                               {"diameter": 0.6, "drill": 0.3},
                               {"diameter": 0.8, "drill": 0.4}],
        }
    }
    data["net_settings"] = {
        "classes": [
            {"name": "Default", "clearance": 0.15, "track_width": 0.25,
             "via_diameter": 0.6, "via_drill": 0.3,
             "microvia_diameter": 0.3, "microvia_drill": 0.1},
            {"name": "Power", "clearance": 0.2, "track_width": 0.6,
             "via_diameter": 0.8, "via_drill": 0.4,
             "microvia_diameter": 0.3, "microvia_drill": 0.1},
        ],
        "netclass_assignments": {},
        "netclass_patterns": [
            {"pattern": "+3V3", "netclass": "Power"},
            {"pattern": "+5V", "netclass": "Power"},
            {"pattern": "PI_3V3", "netclass": "Power"},
            {"pattern": "VREG_OUT", "netclass": "Power"},
            {"pattern": "GND", "netclass": "Power"},
        ],
    }
    path.write_text(json.dumps(data, indent=2) + "\n")


def main() -> int:
    board, placed, nets, unassigned, stack, masse_vias = build_board()

    problems = check_placement(placed)
    if problems:
        print(f"Platzierung: {len(problems)} Konflikt(e)\n")
        for line in problems:
            print("  " + line)
        print("\nNichts geschrieben.")
        return 1

    add_zones(board, nets, stack)
    # Hier **nicht** füllen. Der Füllalgorithmus stürzt auf einer mit
    # pcbnew.BOARD() frisch erzeugten Platine ab — auf einer aus einer Datei
    # geladenen läuft er einwandfrei. Gefüllt wird deshalb im Routing-Schritt,
    # der die gespeicherte Datei ohnehin lädt; KiCad füllt beim Öffnen selbst.
    board.Save(str(OUT))
    write_project_settings()

    area = (BOARD_L * PI_Y0 + LEG_W * (LEG_Y1 - PI_Y0)
            + (ARM_X1 - ARM_X0) * ARM_D + NASE_D * NASE_H)
    print(f"geschrieben: {OUT.name}")
    print(f"  Umriss    : L-Form {BOARD_L:.0f} × {LEG_Y1:.0f} mm — Streifen "
          f"{BOARD_L:.0f} × {PI_Y0:.0f} neben dem Pi, Schenkel {LEG_W:.0f} mm "
          f"breit, {area:.0f} mm²")
    print(f"  ueber dem Pi: Arm {ARM_X1 - ARM_X0:.0f} × {ARM_D:.0f} mm (Buchse), "
          f"Nase {NASE_D:.0f} × {NASE_H:.0f} mm (hinteres Loch) — Luefter frei")
    print("  J1        : Unterseite, −90° — Pads gegen das Pi-Raster geprüft")
    print(f"  Footprints: {len(placed)} + {len(HOLES)} Bohrungen + "
          f"{len(TIE_HOLES)} Zugentlastung")
    print(f"  Netze     : {len(nets)}  ·  2 Innenlagen-Masseflächen (Füllung beim Routen)")
    print(f"  Masse     : {masse_vias} Stützvias an SMD-Massepads vorplatziert")
    print(f"  ohne Netz : {len(unassigned)} Pads (No-Connect laut Schaltplan)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
