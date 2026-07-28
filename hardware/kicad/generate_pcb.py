#!/usr/bin/env python3
"""
Erzeugt das Platinenlayout des AskSin-Analyzer V4.

Bauform
-------
L-förmig. Ein schmaler **Arm** trägt die 2×20-Buchse und wird auf den
durchgeschleiften Header des Waveshare-PoE-HAT gesteckt; der **Körper** sitzt
rechts daneben, außerhalb des Stapels. Damit bleibt der Lüfter des PoE-HAT
vollständig frei, und das Funkmodul liegt nicht zwischen zwei Schaltreglern,
HDMI und USB3 — genau der Störnebel, dem die externe Antenne ausweichen soll.

Position der 2×20-Buchse und die beiden Bohrungen im Arm stammen aus der
offiziellen KiCad-Vorlage `RaspberryPi-HAT` und sind damit nicht geraten. Der
Umriss selbst wird hier erzeugt, weil er kein HAT-Rechteck mehr ist.

Geroutet wird in `route_pcb.py`.

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
ARM_H = 14.0        # Tiefe des Arms über dem Pi-Header
BODY_X0 = 64.0      # hier beginnt der Körper, rechts neben dem Pi
BODY_X1 = 118.0
BODY_H = 46.0

OUTLINE = [
    (0.0, 0.0), (BODY_X1, 0.0), (BODY_X1, BODY_H),
    (BODY_X0, BODY_H), (BODY_X0, ARM_H), (0.0, ARM_H),
]

# Die beiden vorderen Bohrungen stammen aus dem HAT-Bohrbild und greifen in die
# Abstandsbolzen des Pi. Die hinteren stützen den auskragenden Körper gegen die
# Schrankplatte.
HOLES = [(3.5, 3.5), (61.5, 3.5), (114.5, 5.0), (114.5, 43.0)]
HOLE_FP = "MountingHole:MountingHole_2.7mm_M2.5"

# Zugentlastung für das Antennenkabel: zwei Löcher für einen Kabelbinder,
# direkt neben der IPEX-Buchse des Moduls. Der U.FL-Stecker ist auf rund
# 30 Steckzyklen ausgelegt und springt unter Zug ab — bei fest verbauten
# Geräten ist die Entlastung billiger als ein Serviceeinsatz.
TIE_HOLES = [(99.5, 39.5), (105.0, 39.5)]
TIE_FP = "MountingHole:MountingHole_2.1mm"

# Position der 2×20-Buchse aus der offiziellen HAT-Vorlage.
J1_POS = (8.37, 4.77, 90.0)

EDGE_MARGIN = 0.4


def mm(value: float) -> int:
    return pcbnew.FromMM(value)


def at(x: float, y: float) -> pcbnew.VECTOR2I:
    return pcbnew.VECTOR2I(mm(ORIGIN_X + x), mm(ORIGIN_Y + y))


# ---------------------------------------------------------------- Platzierung
#
# Leitgedanken:
#   * Im Arm liegt nur die Buchse. Alles andere dort säße über dem PoE-HAT.
#   * Die drei Peripheriestecker liegen an der linken Körperkante, also der dem
#     Pi zugewandten Seite — kurze Wege zu Display, Taster und LED.
#   * Das Funkmodul sitzt ganz rechts, so weit wie möglich vom Pi entfernt.
#   * Abblockkondensatoren jeweils am Versorgungspin, nicht in einer Reihe.
PLACEMENT: dict[str, tuple[float, float, float]] = {
    "J1":  J1_POS,

    # --- Peripherie an der Pi-zugewandten Kante ---------------------------
    "J5":  (69.0, 20.5, 90),      # OLED, I²C
    "J6":  (69.0, 30.0, 90),      # Taster
    "J7":  (69.0, 39.5, 90),      # WS2812
    "R4":  (76.0, 41.5, 0),       # Vorwiderstand LED-Daten (GPIO18)
    "R5":  (82.0, 41.5, 0),       # Alternative GPIO10, unbestückt

    # --- Versorgung im oberen Streifen des Körpers ------------------------
    "U1":  (70.0, 5.0, 0),
    "C1":  (75.5, 5.5, 90),
    "L1":  (81.0, 5.0, 0),
    "C2":  (86.5, 5.5, 90),

    # --- Mikrocontroller ---------------------------------------------------
    "U2":  (87.0, 26.0, 0),
    "Y1":  (78.0, 22.0, 90),
    "C3":  (80.5, 30.5, 90),
    "C4":  (94.0, 21.5, 90),
    "C9":  (94.0, 30.5, 90),

    # --- Reset-Strecke -----------------------------------------------------
    "C8":  (77.0, 13.5, 0),
    "R2":  (94.0, 16.0, 90),
    "TP1": (89.0, 12.5, 0),
    "S1":  (94.0, 41.0, 0),

    # --- Status-LED --------------------------------------------------------
    "R1":  (76.0, 36.0, 0),
    "D1":  (82.0, 36.0, 0),

    # --- Funk-Frontend ganz rechts ----------------------------------------
    "U3":  (105.0, 26.5, 0),
    "C5":  (115.8, 21.0, 90),
    "R3":  (88.0, 41.5, 0),

    # --- ISP und Prüfpunkte -------------------------------------------------
    "J2":  (98.0, 6.0, 0),
    "TP2": (92.0, 44.5, 0),
    "TP3": (95.0, 44.5, 0),
    "TP4": (98.0, 44.5, 0),
    "TP5": (101.0, 44.5, 0),
    "TP6": (104.0, 44.5, 0),
    "TP7": (107.0, 44.5, 0),
    "TP8": (110.0, 44.5, 0),
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
    """Liegt das Rechteck vollständig im L-Umriss, mit Randabstand?"""
    m = EDGE_MARGIN
    if y0 < m or x0 < m or x1 > BODY_X1 - m:
        return False
    if y1 <= ARM_H - m:
        return True                      # oberer Streifen, über die volle Breite
    return x0 >= BODY_X0 + m and y1 <= BODY_H - m


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
        fp.SetPosition(at(px, py))
        fp.SetOrientationDegrees(rot)
        board.Add(fp)
        placed[ref] = fp

    unassigned = []
    for ref, fp in placed.items():
        for pad in fp.Pads():
            name = pad_net.get((ref, pad.GetNumber()))
            if name is None:
                unassigned.append(f"{ref}.{pad.GetNumber()}")
            else:
                pad.SetNet(nets[name])

    return board, placed, nets, unassigned, stack


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
    # Der Versatz nach innen muss für das L von Hand gerechnet werden: eine
    # Vorzeichenregel über die Mitte kippt an der Innenecke und erzeugt ein
    # sich selbst schneidendes Polygon — KiCad stürzt daran beim Füllen ab.
    inset = 0.3
    ring = [
        (inset, inset),
        (BODY_X1 - inset, inset),
        (BODY_X1 - inset, BODY_H - inset),
        (BODY_X0 + inset, BODY_H - inset),
        (BODY_X0 + inset, ARM_H - inset),
        (inset, ARM_H - inset),
    ]

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
        zone.SetThermalReliefGap(mm(0.3))
        zone.SetThermalReliefSpokeWidth(mm(0.5))
        # Teilflächen, die die Leiterbahnen abschneiden und die an keiner
        # Durchkontaktierung hängen, entfernen. Unverbundenes Kupfer bringt
        # nichts, meldet sich im DRC als offene Verbindung und wirkt im
        # 868-MHz-Bereich im schlechtesten Fall als Resonator.
        # ISLAND_REMOVAL_MODE_ALWAYS wird über die Python-Schnittstelle nicht
        # ausgewertet; über eine Mindestfläche greift die Entfernung dagegen.
        zone.SetIslandRemovalMode(pcbnew.ISLAND_REMOVAL_MODE_AREA)
        zone.SetMinIslandArea(pcbnew.FromMM(6.0) * pcbnew.FromMM(1.0))
        outline = zone.Outline()
        outline.NewOutline()
        for x, y in ring:
            outline.Append(mm(ORIGIN_X + x), mm(ORIGIN_Y + y))
        # Ohne dieses Schließen bleibt der Polygonzug offen. KiCad meldet das
        # nur als Warnung, der Füllalgorithmus stürzt aber daran ab, und im
        # Specctra-Export fehlt eine saubere Umrandung.
        outline.Outline(0).SetClosed(True)
        board.Add(zone)

    # Beide Innenlagen tragen Masse. Ursprünglich lag +3V3 auf In2 — das
    # zwang jedem einzelnen Versorgungspad ein eigenes Stützvia auf, wofür in
    # der fertig gerouteten Platine regelmäßig der Platz fehlte. Das Netz zieht
    # rund 25 mA; als Leiterbahn mit 0,6 mm ist es reichlich bemessen. Zwei
    # durchgehende Masseflächen schirmen den Empfänger zudem besser ab.
    for layer in stack:
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
    board, placed, nets, unassigned, stack = build_board()

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

    area = BODY_X1 * ARM_H + (BODY_X1 - BODY_X0) * (BODY_H - ARM_H)
    print(f"geschrieben: {OUT.name}")
    print(f"  Umriss    : L-Form, Arm {BODY_X0:.0f} × {ARM_H:.0f} mm, "
          f"Körper {BODY_X1 - BODY_X0:.0f} × {BODY_H:.0f} mm, {area:.0f} mm²")
    print(f"  Footprints: {len(placed)} + {len(HOLES)} Bohrungen + "
          f"{len(TIE_HOLES)} Zugentlastung")
    print(f"  Netze     : {len(nets)}  ·  4 Flächen angelegt (Füllung beim Routen)")
    print(f"  ohne Netz : {len(unassigned)} Pads (No-Connect laut Schaltplan)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
