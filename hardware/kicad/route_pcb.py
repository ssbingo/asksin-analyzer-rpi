#!/usr/bin/env python3
"""
Routet die Signalverbindungen des AskSin-Analyzer V3.

Warum ein eigener Router und nicht Freerouting: KiCad exportiert zwar Specctra,
aber Freerouting braucht eine Java-Laufzeitumgebung, die sich hier nicht ohne
Administratorrechte installieren lässt. Ein eigener Router hat außerdem zwei
Vorteile, die hier zählen — er liegt reproduzierbar im Repo neben den anderen
Generatoren, und er lässt sich exakt auf die Lagen und Abstände festnageln, die
dieses Layout braucht.

Verfahren
---------
Rasterbasierte A*-Suche, 0,1 mm Gitter, zwei Routinglagen (F.Cu und B.Cu).
Die beiden Innenlagen bleiben unangetastet: In1.Cu ist durchgehende Masse,
In2.Cu die 3,3-V-Fläche. Ein Router, der da hineinschneidet, zerstört genau die
Eigenschaft, für die die Lagen da sind.

Daraus folgt die Behandlung der Versorgung:
  * **GND** ist bereits über die Flächen auf F.Cu und B.Cu verbunden, es wird
    nichts geroutet. Zusätzlich bekommt jeder Massepin eine Durchkontaktierung,
    damit die Masse auch auf In1 durchgreift.
  * **+3V3** wird nicht flächig geroutet, sondern jeder Pad bekommt eine
    Durchkontaktierung auf die Fläche in In2.
  * Alle übrigen Netze werden Punkt zu Punkt geroutet.

Netze werden nach Länge sortiert, **lange zuerst**. Kurze Verbindungen finden
auch in einer vollen Platine noch einen Weg; lange nicht, und viele kurze Bahnen
blockieren genau die Korridore, auf die sie angewiesen sind.

Aufruf:
    python3 generate_pcb.py && python3 route_pcb.py
    kicad-cli pcb drc --output drc.rpt --severity-error AskSin-Analyzer-V3.kicad_pcb
"""

from __future__ import annotations

import heapq
import math
import pathlib
import sys

import pcbnew

import generate_pcb as G
from generate_schematic import NETS, PROJECT

HERE = pathlib.Path(__file__).resolve().parent
BOARD_FILE = HERE / f"{PROJECT}.kicad_pcb"

ORIGIN_X, ORIGIN_Y = G.ORIGIN_X, G.ORIGIN_Y
BOARD_W, BOARD_H = G.BODY_W, G.TOTAL_H   # umschließendes Rechteck des T

GRID = 0.1                    # mm je Rasterschritt
NX = int(BOARD_W / GRID) + 1
NY = int(BOARD_H / GRID) + 1

TRACK_W = 0.25
CLEARANCE = 0.20          # muss zur Netzklasse "Default" im DRC passen
VIA_D = 0.6
VIA_DRILL = 0.3
MARGIN = 0.02             # Sicherheitszuschlag gegen Rasterrundung

# Wie weit ein Hindernis die Bahn**mitte** von sich fernhalten muss.
# Entscheidend ist, wie das Hindernis gespeichert ist:
#   * Pads liegen als Umgrenzung ihres Kupfers vor  → Abstand + halbe Bahn
#   * Bahnen liegen als Mittellinie vor             → zusätzlich ihre halbe Breite
#   * Vias liegen als Punkt vor                     → zusätzlich ihr halber Durchmesser
# Genau das war der Fehler des ersten Durchlaufs: Bahnen und Vias wurden wie
# Pads behandelt, wodurch bei Vias 0,3 mm fehlten — mehr als der geforderte
# Abstand selbst.
INFLATE_PAD = CLEARANCE + TRACK_W / 2 + MARGIN           # 0,345 mm
INFLATE_TRACK = TRACK_W / 2 + CLEARANCE + TRACK_W / 2 + MARGIN   # 0,470 mm
INFLATE_VIA = VIA_D / 2 + CLEARANCE + TRACK_W / 2 + MARGIN       # 0,645 mm

# Kupfer-zu-Kante: KiCad fordert 0,5 mm ab Kupferrand, also 0,625 ab Mitte.
EDGE_KEEPOUT = 0.75

VIA_COST = 32.0               # in Rasterschritten; Lagenwechsel soll wehtun
DIAG = math.sqrt(2)

# Die fehlenden Quadranten des T sind keine Platine: unterhalb des Körpers
# existiert nur der Arm (x zwischen ARM_X0 und ARM_X1). Ohne diese Sperren
# würde der Router seelenruhig durch die Luft routen — die Randprüfung in
# collect_geometry() kennt nur das umschließende Rechteck.
KEEPOUTS = [
    (-5.0, G.BODY_H - 0.5, G.ARM_X0 + 0.5, BOARD_H + 5.0),
    (G.ARM_X1 - 0.5, G.BODY_H - 0.5, BOARD_W + 5.0, BOARD_H + 5.0),
]

# Netze, die über die Flächen versorgt werden statt über Bahnen.
PLANE_NETS = {"GND": None, "+3V3": None}

# Diese kommen vor allen anderen dran, unabhängig von ihrer Länge.
#   * Takt: muss kurz und ohne Umwege bleiben, sonst leidet die Oszillatorgüte
#   * USB: Differenzpaar, will symmetrisch und auf einer Lage bleiben
PRIORITY = ["XTAL1", "XTAL2", "USB_D_P", "USB_D_N", "USB_CC1", "USB_CC2"]


def to_cell(x: float, y: float) -> tuple[int, int]:
    return (int(round(x / GRID)), int(round(y / GRID)))


def to_mm(cx: int, cy: int) -> tuple[float, float]:
    return (cx * GRID, cy * GRID)


def board_pt(x: float, y: float) -> pcbnew.VECTOR2I:
    return pcbnew.VECTOR2I(pcbnew.FromMM(ORIGIN_X + x), pcbnew.FromMM(ORIGIN_Y + y))


class Obstacles:
    """Belegtes Kupfer je Lage, als Rasterzellen mit Netzzugehörigkeit."""

    def __init__(self, layers: list[int]) -> None:
        self.layers = layers
        # (layer, cx, cy) -> Menge der Netze, die diese Zelle sperren
        self.cells: dict[tuple[int, int, int], set[str]] = {}
        self.static: set[tuple[int, int]] = set()   # Rand und Sperrflächen
        # Bohrungen (x, y, Radius) — netzunabhängig, für Loch-zu-Loch-Abstand
        self.holes: list[tuple[float, float, float]] = []

    def add_rect(self, layer: int, x0: float, y0: float, x1: float, y1: float,
                 net: str, inflate: float) -> None:
        # Nur Zellen sperren, deren **Mittelpunkt** im aufgeweiteten Rechteck
        # liegt. Mit to_cell() würde gerundet und der gesperrte Bereich um eine
        # halbe Rasterweite zu groß — bei 0,5-mm-Pinabstand reicht das, um die
        # Pad-Mitte des Nachbarn mitzusperren und das Bauteil unerreichbar zu
        # machen.
        cx0 = math.ceil((x0 - inflate) / GRID - 1e-9)
        cy0 = math.ceil((y0 - inflate) / GRID - 1e-9)
        cx1 = math.floor((x1 + inflate) / GRID + 1e-9)
        cy1 = math.floor((y1 + inflate) / GRID + 1e-9)
        for cx in range(cx0, cx1 + 1):
            for cy in range(cy0, cy1 + 1):
                self.cells.setdefault((layer, cx, cy), set()).add(net)

    def add_static_rect(self, x0: float, y0: float, x1: float, y1: float) -> None:
        cx0, cy0 = to_cell(x0, y0)
        cx1, cy1 = to_cell(x1, y1)
        for cx in range(cx0, cx1 + 1):
            for cy in range(cy0, cy1 + 1):
                self.static.add((cx, cy))

    def blocked(self, layer: int, cx: int, cy: int, net: str) -> bool:
        if (cx, cy) in self.static:
            return True
        owners = self.cells.get((layer, cx, cy))
        return owners is not None and (len(owners) > 1 or net not in owners)

    # Zusätzlich zu prüfender Umkreis: die Hinderniskarte ist für eine
    # Bahnmitte gerechnet, eine Durchkontaktierung ist aber breiter.
    VIA_CHECK_CELLS = int(round((VIA_D / 2 - TRACK_W / 2) / GRID))

    def add_hole(self, x: float, y: float, drill: float) -> None:
        self.holes.append((x, y, drill / 2))

    def via_blocked(self, cx: int, cy: int, net: str, diameter=None) -> bool:
        # Bohrloch-zu-Bohrloch ist netzunabhängig: auch ein Via im eigenen
        # Netz darf einem Durchsteckpad nicht näher kommen, als es die
        # Fertigung erlaubt (0,25 mm Steg + Reserve auf den Via-Bohrer).
        vx, vy = to_mm(cx, cy)
        for hx, hy, hr in self.holes:
            if (vx - hx) ** 2 + (vy - hy) ** 2 < (hr + 0.45) ** 2:
                return True
        r = (self.VIA_CHECK_CELLS if diameter is None
             else max(0, int(round((diameter / 2 - TRACK_W / 2) / GRID))))
        for dx in range(-r, r + 1):
            for dy in range(-r, r + 1):
                if dx * dx + dy * dy > r * r:
                    continue
                for layer in self.layers:
                    if self.blocked(layer, cx + dx, cy + dy, net):
                        return True
        return False


def collect_geometry(board: pcbnew.BOARD, layers: list[int]) -> Obstacles:
    obs = Obstacles(layers)

    # Rand
    obs.add_static_rect(-5.0, -5.0, BOARD_W + 5.0, EDGE_KEEPOUT)
    obs.add_static_rect(-5.0, BOARD_H - EDGE_KEEPOUT, BOARD_W + 5.0, BOARD_H + 5.0)
    obs.add_static_rect(-5.0, -5.0, EDGE_KEEPOUT, BOARD_H + 5.0)
    obs.add_static_rect(BOARD_W - EDGE_KEEPOUT, -5.0, BOARD_W + 5.0, BOARD_H + 5.0)
    for x0, y0, x1, y1 in KEEPOUTS:
        obs.add_static_rect(x0, y0, x1, y1)

    for item in board.GetTracks():
        if item.Type() == pcbnew.PCB_VIA_T:
            pos = item.GetPosition()
            obs.add_hole(pcbnew.ToMM(pos.x) - ORIGIN_X,
                         pcbnew.ToMM(pos.y) - ORIGIN_Y,
                         pcbnew.ToMM(item.GetDrillValue()))

    for fp in board.GetFootprints():
        for pad in fp.Pads():
            d = pad.GetDrillSize().x
            if d:
                pp = pad.GetPosition()
                obs.add_hole(pcbnew.ToMM(pp.x) - ORIGIN_X,
                             pcbnew.ToMM(pp.y) - ORIGIN_Y, pcbnew.ToMM(d))
            net = pad.GetNetname() or f"__{fp.GetReference()}_{pad.GetNumber()}"
            bb = pad.GetBoundingBox()
            x0 = pcbnew.ToMM(bb.GetLeft()) - ORIGIN_X
            y0 = pcbnew.ToMM(bb.GetTop()) - ORIGIN_Y
            x1 = pcbnew.ToMM(bb.GetRight()) - ORIGIN_X
            y1 = pcbnew.ToMM(bb.GetBottom()) - ORIGIN_Y
            through = pad.GetAttribute() in (pcbnew.PAD_ATTRIB_PTH,
                                             pcbnew.PAD_ATTRIB_NPTH)
            targets = layers if through else [layers[0]]
            for layer in targets:
                obs.add_rect(layer, x0, y0, x1, y1, net, INFLATE_PAD)
    return obs


def astar(obs: Obstacles, net: str, starts: set[tuple[int, int, int]],
          goals: set[tuple[int, int, int]], layers: list[int]):
    """Kürzester Weg von einer Startzelle zu einer der Zielzellen."""
    if not starts or not goals:
        return None
    gx0 = min(c[1] for c in goals); gx1 = max(c[1] for c in goals)
    gy0 = min(c[2] for c in goals); gy1 = max(c[2] for c in goals)

    def h(cx: int, cy: int) -> float:
        dx = max(gx0 - cx, 0, cx - gx1)
        dy = max(gy0 - cy, 0, cy - gy1)
        return max(dx, dy) + (DIAG - 1) * min(dx, dy)

    open_heap = []
    came: dict[tuple[int, int, int], tuple[int, int, int]] = {}
    gscore: dict[tuple[int, int, int], float] = {}
    for s in starts:
        gscore[s] = 0.0
        heapq.heappush(open_heap, (h(s[1], s[2]), 0.0, s))

    steps = [(1, 0, 1.0), (-1, 0, 1.0), (0, 1, 1.0), (0, -1, 1.0),
             (1, 1, DIAG), (1, -1, DIAG), (-1, 1, DIAG), (-1, -1, DIAG)]
    limit = 900_000
    expanded = 0

    while open_heap:
        _, g, cur = heapq.heappop(open_heap)
        if g > gscore.get(cur, float("inf")):
            continue
        if cur in goals:
            path = [cur]
            while path[-1] in came:
                path.append(came[path[-1]])
            return list(reversed(path))
        expanded += 1
        if expanded > limit:
            return None
        layer, cx, cy = cur

        for dx, dy, cost in steps:
            nx_, ny_ = cx + dx, cy + dy
            if not (0 <= nx_ < NX and 0 <= ny_ < NY):
                continue
            nxt = (layer, nx_, ny_)
            if nxt not in goals and obs.blocked(layer, nx_, ny_, net):
                continue
            if dx and dy:  # Diagonalen dürfen nicht durch eine Ecke schneiden
                if obs.blocked(layer, cx + dx, cy, net) and \
                   obs.blocked(layer, cx, cy + dy, net):
                    continue
            ng = g + cost
            if ng < gscore.get(nxt, float("inf")):
                gscore[nxt] = ng
                came[nxt] = cur
                heapq.heappush(open_heap, (ng + h(nx_, ny_), ng, nxt))

        for other in layers:
            if other == layer:
                continue
            nxt = (other, cx, cy)
            if nxt not in goals and obs.via_blocked(cx, cy, net):
                continue
            ng = g + VIA_COST
            if ng < gscore.get(nxt, float("inf")):
                gscore[nxt] = ng
                came[nxt] = cur
                heapq.heappush(open_heap, (ng + h(cx, cy), ng, nxt))

    return None


# ---------------------------------------------------------------- Anbindung

def pad_cells(pad: pcbnew.PAD, layers: list[int]) -> set[tuple[int, int, int]]:
    """Rasterzellen, die auf dem Pad liegen — gültige Start- und Zielpunkte."""
    bb = pad.GetBoundingBox()
    x0 = pcbnew.ToMM(bb.GetLeft()) - ORIGIN_X
    y0 = pcbnew.ToMM(bb.GetTop()) - ORIGIN_Y
    x1 = pcbnew.ToMM(bb.GetRight()) - ORIGIN_X
    y1 = pcbnew.ToMM(bb.GetBottom()) - ORIGIN_Y
    # Etwas einrücken, damit die Bahn sicher im Pad endet und nicht am Rand.
    ix = min(0.08, (x1 - x0) / 3)
    iy = min(0.08, (y1 - y0) / 3)
    cx0, cy0 = to_cell(x0 + ix, y0 + iy)
    cx1, cy1 = to_cell(x1 - ix, y1 - iy)
    through = pad.GetAttribute() in (pcbnew.PAD_ATTRIB_PTH, pcbnew.PAD_ATTRIB_NPTH)
    targets = layers if through else [layers[0]]
    return {(layer, cx, cy)
            for layer in targets
            for cx in range(cx0, cx1 + 1)
            for cy in range(cy0, cy1 + 1)}


def add_track(board, net_obj, layer, a, b) -> None:
    trk = pcbnew.PCB_TRACK(board)
    trk.SetStart(board_pt(*a))
    trk.SetEnd(board_pt(*b))
    trk.SetWidth(pcbnew.FromMM(TRACK_W))
    trk.SetLayer(layer)
    trk.SetNet(net_obj)
    board.Add(trk)


# Stützvias für die Versorgungsflächen. Kleiner als das Signalmaß geht nicht:
# 0,3 mm Bohrung ist die Untergrenze der Entwurfsregeln, und mit 0,13 mm
# Restring ergibt das mindestens 0,56 mm Durchmesser. Ein erster Versuch mit
# 0,45/0,25 sparte zwar Platz, verletzte aber genau diese beiden Regeln.
STITCH_VIA_D = 0.6
STITCH_VIA_DRILL = 0.3


def add_via(board, net_obj, x, y, layers, diameter=None, drill=None) -> None:
    via = pcbnew.PCB_VIA(board)
    via.SetPosition(board_pt(x, y))
    via.SetWidth(pcbnew.FromMM(diameter if diameter else VIA_D))
    via.SetDrill(pcbnew.FromMM(drill if drill else VIA_DRILL))
    via.SetViaType(pcbnew.VIATYPE_THROUGH)
    via.SetLayerPair(layers[0], layers[-1])
    via.SetNet(net_obj)
    board.Add(via)


def emit_path(board, net_obj, net_name, path, obs, layers) -> int:
    """Pfad in Leiterbahnen und Durchkontaktierungen umsetzen, Hindernis merken."""
    vias = 0
    run_start = path[0]
    prev = path[0]
    for node in path[1:] + [None]:
        if node is not None and node[0] == prev[0]:
            # gleiche Lage: prüfen ob die Richtung gleich bleibt
            if node[0] == run_start[0]:
                d1 = (prev[1] - run_start[1], prev[2] - run_start[2])
                d2 = (node[1] - prev[1], node[2] - prev[2])
                same_dir = (d1 == (0, 0)) or (
                    d1[0] * d2[1] == d1[1] * d2[0]
                    and d1[0] * d2[0] >= 0 and d1[1] * d2[1] >= 0)
                if same_dir:
                    prev = node
                    continue
        # Lauf abschließen
        if run_start[1:] != prev[1:]:
            a = to_mm(run_start[1], run_start[2])
            b = to_mm(prev[1], prev[2])
            add_track(board, net_obj, run_start[0], a, b)
            x0, x1 = sorted((a[0], b[0]))
            y0, y1 = sorted((a[1], b[1]))
            obs.add_rect(run_start[0], x0, y0, x1, y1, net_name, INFLATE_TRACK)
        if node is None:
            break
        if node[0] != prev[0]:
            x, y = to_mm(prev[1], prev[2])
            add_via(board, net_obj, x, y, layers)
            obs.add_hole(x, y, VIA_DRILL)
            for layer in layers:
                obs.add_rect(layer, x, y, x, y, net_name, INFLATE_VIA)
            vias += 1
        run_start = node
        prev = node
    return vias


def find_via_spot(obs, net_name, cx, cy, layers, radius_cells=26):
    """Freie Stelle für eine Durchkontaktierung, spiralförmig vom Pad aus."""
    for r in range(0, radius_cells):
        for dx in range(-r, r + 1):
            for dy in (-r, r) if r else (0,):
                for px, py in ((cx + dx, cy + dy), (cx + dy, cy + dx)):
                    if not (0 <= px < NX and 0 <= py < NY):
                        continue
                    if obs.via_blocked(px, py, net_name):
                        continue
                    return px, py
    return None


def line_clear(obs, net_name, layer, c0, c1) -> bool:
    """Prüft die gerade Verbindung Pad → Durchkontaktierung zellenweise."""
    x0, y0 = c0
    x1, y1 = c1
    n = max(abs(x1 - x0), abs(y1 - y0))
    for i in range(n + 1):
        cx = x0 + round((x1 - x0) * i / n) if n else x0
        cy = y0 + round((y1 - y0) * i / n) if n else y0
        if obs.blocked(layer, cx, cy, net_name):
            return False
    return True


def via_in_pad_ok(board, pad, px, py, obs) -> bool:
    """Passt ein Stützvia mitten in diesen Pad? Geprüft werden echte
    Abstände zu Fremdkupfer (Pads, Bahnen, Vias) und zu Bohrungen."""
    eigenes = pad.GetNetname()
    via_r = STITCH_VIA_D / 2
    brauch_kupfer = via_r + 0.16          # 0,15 Abstand + Rundungsreserve
    for hx, hy, hr in obs.holes:
        if (px - hx) ** 2 + (py - hy) ** 2 < (hr + 0.45) ** 2:
            return False
    for fp in board.GetFootprints():
        for p2 in fp.Pads():
            if p2.GetNetname() == eigenes:
                continue
            bb = p2.GetBoundingBox()
            x0, y0 = pcbnew.ToMM(bb.GetLeft()) - ORIGIN_X, pcbnew.ToMM(bb.GetTop()) - ORIGIN_Y
            x1, y1 = pcbnew.ToMM(bb.GetRight()) - ORIGIN_X, pcbnew.ToMM(bb.GetBottom()) - ORIGIN_Y
            dx = max(x0 - px, 0.0, px - x1)
            dy = max(y0 - py, 0.0, py - y1)
            if dx * dx + dy * dy < brauch_kupfer ** 2:
                return False
    for item in board.GetTracks():
        if (item.GetNetname() or "__anon") == eigenes:
            continue
        s, e = item.GetStart(), item.GetEnd()
        x0, x1 = sorted((pcbnew.ToMM(s.x) - ORIGIN_X, pcbnew.ToMM(e.x) - ORIGIN_X))
        y0, y1 = sorted((pcbnew.ToMM(s.y) - ORIGIN_Y, pcbnew.ToMM(e.y) - ORIGIN_Y))
        breite = pcbnew.ToMM(item.GetWidth()) / 2
        dx = max(x0 - px, 0.0, px - x1)
        dy = max(y0 - py, 0.0, py - y1)
        if dx * dx + dy * dy < (brauch_kupfer + breite) ** 2:
            return False
    return True


def stitch_plane_net(board, obs, net_name, pads, layers,
                     anker_zellen=frozenset()) -> tuple[int, int]:
    """Jeden Pad des Netzes über eine Durchkontaktierung an seine Fläche binden.

    Findet sich kein Platz für ein eigenes Stützvia, darf der Pad ersatzweise
    mit einer kurzen Bahn an ein bereits vorhandenes Via desselben Netzes
    anschließen (`anker_zellen`, z. B. das Masseraster).
    """
    net_obj = board.FindNet(net_name)
    done = failed = 0

    # Pads, die in generate_pcb.py schon ihr Stützvia samt Stichleitung
    # bekommen haben, erkennt man an einer Bahn, die exakt im Padmittelpunkt
    # beginnt oder endet. Ohne diese Prüfung suchte der Stitcher hier
    # vergeblich weiter — der Platz ist ja durch das eigene Via belegt.
    versorgt = set()
    for item in board.GetTracks():
        if item.Type() == pcbnew.PCB_VIA_T or item.GetNetname() != net_name:
            continue
        for punkt in (item.GetStart(), item.GetEnd()):
            versorgt.add((punkt.x, punkt.y))

    for pad in pads:
        pos = pad.GetPosition()
        if (pos.x, pos.y) in versorgt:
            done += 1
            continue
        px = pcbnew.ToMM(pos.x) - ORIGIN_X
        py = pcbnew.ToMM(pos.y) - ORIGIN_Y
        pc = to_cell(px, py)
        if pad.GetAttribute() in (pcbnew.PAD_ATTRIB_PTH, pcbnew.PAD_ATTRIB_NPTH):
            done += 1          # Durchsteckpad greift ohnehin auf alle Lagen durch
            continue
        # Mehrere Kandidaten für das Stützvia sammeln, nächstgelegene zuerst,
        # und den ersten nehmen, zu dem auch ein Weg führt. Nur den nächsten
        # freien Platz zu suchen reicht nicht: in einer fertig gerouteten
        # Platine ist der oft von Bahnen eingeschlossen.
        candidates = []
        for r in range(0, 90):
            for dx in range(-r, r + 1):
                for dy in ((-r, r) if r else (0,)):
                    for cand in ((pc[0] + dx, pc[1] + dy), (pc[0] + dy, pc[1] + dx)):
                        if not (0 <= cand[0] < NX and 0 <= cand[1] < NY):
                            continue
                        if cand in candidates:
                            continue
                        if obs.via_blocked(cand[0], cand[1], net_name,
                                           STITCH_VIA_D):
                            continue
                        candidates.append(cand)
            if len(candidates) >= 14:
                break

        spot = None
        route = None
        for cand in candidates:
            if cand == pc:
                spot = cand
                break
            path = astar(obs, net_name, pad_cells(pad, layers),
                         {(layers[0], cand[0], cand[1])}, layers)
            if path is not None:
                spot, route = cand, path
                break
        if spot is None:
            # Letzte Rettung: Stützvia direkt in den Pad (getentet, 0,3-mm-
            # Bohrer — bei Hand- und Economic-Bestückung unkritisch, üblich
            # bei TQFP-Massepins). Die Zellkarte taugt hier nicht als
            # Prüfer: ihre aufgeblähten Fremdkupferzonen reichen bis in den
            # eigenen Pad hinein. Stattdessen echte Geometrieabstände.
            if via_in_pad_ok(board, pad, px, py, obs):
                add_via(board, net_obj, px, py, layers,
                        STITCH_VIA_D, STITCH_VIA_DRILL)
                obs.add_hole(px, py, STITCH_VIA_DRILL)
                inflate = STITCH_VIA_D / 2 + CLEARANCE + TRACK_W / 2 + MARGIN
                for layer in layers:
                    obs.add_rect(layer, px, py, px, py, net_name, inflate)
                done += 1
                continue

        if spot is None and anker_zellen:
            path = astar(obs, net_name, pad_cells(pad, layers),
                         anker_zellen, layers)
            if path is not None:
                emit_path(board, net_obj, net_name, path, obs, layers)
                done += 1
                continue
        if spot is None:
            fp = pad.GetParentFootprint()
            print(f"    kein Anschluss: {fp.GetReference()}-{pad.GetNumber()}")
            failed += 1
            continue
        vx, vy = to_mm(*spot)
        if route is not None:
            emit_path(board, net_obj, net_name, route, obs, layers)
        add_via(board, net_obj, vx, vy, layers, STITCH_VIA_D, STITCH_VIA_DRILL)
        obs.add_hole(vx, vy, STITCH_VIA_DRILL)
        stitch_inflate = STITCH_VIA_D / 2 + CLEARANCE + TRACK_W / 2 + MARGIN
        for layer in layers:
            obs.add_rect(layer, vx, vy, vx, vy, net_name, stitch_inflate)
        done += 1
    return done, failed


def route_once(pristine: pathlib.Path, forced: list[str]):
    """Eine vollständige Routingrunde. `forced` kommt nach PRIORITY zuerst dran."""
    board = pcbnew.LoadBoard(str(pristine))
    stack = board.GetEnabledLayers().CuStack()
    layers = [stack[0], stack[-1]]            # nur F.Cu und B.Cu routen

    obs = collect_geometry(board, layers)

    pads_by_net: dict[str, list] = {}
    for fp in board.GetFootprints():
        for pad in fp.Pads():
            name = pad.GetNetname()
            if name:
                pads_by_net.setdefault(name, []).append(pad)

    todo = []
    for net_name in NETS:
        if net_name in PLANE_NETS:
            continue
        pads = pads_by_net.get(net_name, [])
        if len(pads) < 2:
            continue
        xs = [pcbnew.ToMM(p.GetPosition().x) for p in pads]
        ys = [pcbnew.ToMM(p.GetPosition().y) for p in pads]
        span = (max(xs) - min(xs)) + (max(ys) - min(ys))
        todo.append((span, net_name, pads))
    todo.sort(reverse=True)

    def rank(entry):
        name = entry[1]
        if name in PRIORITY:
            return (0, PRIORITY.index(name))
        if name in forced:
            return (1, forced.index(name))
        return (2, 0)
    todo.sort(key=rank)

    routed = total_vias = 0
    failures: list[str] = []
    detail: list[str] = []
    for span, net_name, pads in todo:
        net_obj = board.FindNet(net_name)
        groups = [pad_cells(p, layers) for p in pads]
        connected = set(groups[0])
        ok = 0
        for group in groups[1:]:
            path = astar(obs, net_name, connected, group, layers)
            if path is None:
                failures.append(net_name)
                continue
            total_vias += emit_path(board, net_obj, net_name, path, obs, layers)
            connected |= set(path) | group
            ok += 1
            routed += 1
        detail.append(f"  {net_name:<14} {ok}/{len(groups) - 1}  (Spanne {span:5.1f} mm)")

    return board, obs, pads_by_net, layers, routed, failures, total_vias, detail


def main() -> int:
    pristine = BOARD_FILE.with_suffix(".pristine.kicad_pcb")
    if not pristine.exists() or pristine.stat().st_mtime < BOARD_FILE.stat().st_mtime:
        pristine.write_bytes(BOARD_FILE.read_bytes())

    print(f"Raster {GRID} mm ({NX}×{NY}), Lagen F.Cu und B.Cu, "
          f"Bahn {TRACK_W} mm, Abstand {CLEARANCE} mm\n")

    forced: list[str] = []
    best = None
    for attempt in range(1, 7):
        result = route_once(pristine, forced)
        board, obs, pads_by_net, layers, routed, failures, vias, detail = result
        uniq = sorted(set(failures))
        print(f"Runde {attempt}: {routed} Verbindungen geroutet, "
              f"{len(failures)} offen{'' if not uniq else '  → ' + ', '.join(uniq)}")
        if best is None or len(failures) < best[0]:
            best = (len(failures), result, detail)
        if not failures:
            break
        # Gescheiterte Netze in der nächsten Runde nach vorn holen.
        for name in uniq:
            if name in forced:
                forced.remove(name)
        forced = uniq + forced

    _, result, detail = best
    board, obs, pads_by_net, layers, routed, failures, vias, detail_ = result

    print()
    for line in detail_:
        print(line)

    print()
    for net_name in ("+3V3", "GND"):
        pads = pads_by_net.get(net_name, [])
        done, failed = stitch_plane_net(board, obs, net_name, pads, layers)
        state = "alle" if not failed else f"{failed} ohne Platz"
        print(f"  Fläche {net_name:<6} {done:3d} Pads angebunden   ({state})")

    filler = pcbnew.ZONE_FILLER(board)
    filler.Fill(board.Zones())
    board.Save(str(BOARD_FILE))

    print(f"\n  geroutet {routed}, offen {len(failures)}, "
          f"Durchkontaktierungen {vias}")
    print(f"gespeichert: {BOARD_FILE.name}")
    return 0 if not failures else 1


if __name__ == "__main__":
    sys.exit(main())


def stitch_ground_grid(board, obs, layers, pitch: float = 3.0) -> int:
    """Masse-Durchkontaktierungen im groben Raster über die ganze Platine.

    Die Auffüllung auf F.Cu und B.Cu wird durch die Leiterbahnen in Teilflächen
    zerlegt. Inseln, die keinen Pad und keine Durchkontaktierung enthalten,
    hängen an nichts — der DRC meldet sie als unverbundene Massefläche. Ein
    Via-Raster bindet jede Insel an die beiden Innenlagen und verbessert
    nebenbei die Masseführung unter dem Funkmodul.
    """
    net_obj = board.FindNet("GND")
    if net_obj is None:
        return 0
    step = max(1, int(round(pitch / GRID)))
    placed = 0
    for cx in range(step, NX, step):
        for cy in range(step, NY, step):
            if obs.via_blocked(cx, cy, "GND", STITCH_VIA_D):
                continue
            vx, vy = to_mm(cx, cy)
            add_via(board, net_obj, vx, vy, layers, STITCH_VIA_D, STITCH_VIA_DRILL)
            obs.add_hole(vx, vy, STITCH_VIA_DRILL)
            inflate = STITCH_VIA_D / 2 + CLEARANCE + TRACK_W / 2 + MARGIN
            for layer in layers:
                obs.add_rect(layer, vx, vy, vx, vy, "GND", inflate)
            placed += 1
    return placed
