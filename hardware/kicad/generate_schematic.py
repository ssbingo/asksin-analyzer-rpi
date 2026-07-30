#!/usr/bin/env python3
"""
Erzeugt den KiCad-9-Schaltplan des AskSin-Analyzer V3.

Warum generiert und nicht von Hand gezeichnet: die Netzliste ist damit die
einzige Quelle der Wahrheit und lässt sich gegen die Spezifikation in
`../README.md` Abschnitt 3 diffen. Ein Handschaltplan driftet von der Doku weg,
ein generierter nicht.

Der Stil ist bewusst „Netzlisten-Schaltplan": jeder Pin bekommt einen kurzen
Stich mit einem lokalen Label. Das ist nicht die schönste Darstellung, aber eine
vollständig überprüfbare — und in KiCad jederzeit von Hand umzuräumen.

Aufruf:
    python3 generate_schematic.py
    kicad-cli sch erc AskSin-Analyzer-V3.kicad_sch
"""

from __future__ import annotations

import hashlib
import math
import pathlib
import re
import uuid as uuidlib

HERE = pathlib.Path(__file__).resolve().parent
STOCK_SYMBOLS = pathlib.Path("/usr/share/kicad/symbols")
PROJECT = "AskSin-Analyzer-V3"
SHEET_FILE = HERE / f"{PROJECT}.kicad_sch"

# ---------------------------------------------------------------- S-Expression

TOKEN_RE = re.compile(r'\(|\)|"(?:[^"\\]|\\.)*"|[^\s()]+')


def parse_sexp(text: str):
    tokens = TOKEN_RE.findall(text)

    def walk(i):
        out = []
        while i < len(tokens):
            tok = tokens[i]
            if tok == "(":
                sub, i = walk(i + 1)
                out.append(sub)
            elif tok == ")":
                return out, i + 1
            else:
                out.append(tok)
                i += 1
        return out, i

    return walk(0)[0]


def dump_sexp(node, indent=0) -> str:
    pad = "\t" * indent
    if not isinstance(node, list):
        return node
    if not any(isinstance(c, list) for c in node):
        return pad + "(" + " ".join(node) + ")"
    head = [c for c in node if not isinstance(c, list)]
    parts = [pad + "(" + " ".join(head)]
    for child in node:
        if isinstance(child, list):
            parts.append(dump_sexp(child, indent + 1))
    parts.append(pad + ")")
    return "\n".join(parts)


def q(value: str) -> str:
    return '"' + str(value).replace("\\", "\\\\").replace('"', '\\"') + '"'


def det_uuid(key: str) -> str:
    """Deterministische UUID — gleicher Lauf, gleiche Datei, saubere Diffs."""
    return str(uuidlib.UUID(hashlib.md5(key.encode()).hexdigest()))


# ---------------------------------------------------------------- Symbolquellen

_lib_cache: dict[pathlib.Path, list] = {}


def load_lib(path: pathlib.Path) -> list:
    if path not in _lib_cache:
        _lib_cache[path] = parse_sexp(path.read_text())[0]
    return _lib_cache[path]


def lib_path(libname: str) -> pathlib.Path:
    local = HERE / "lib" / f"{libname}.kicad_sym"
    return local if local.exists() else STOCK_SYMBOLS / f"{libname}.kicad_sym"


def raw_symbol(libname: str, name: str):
    for node in load_lib(lib_path(libname))[1:]:
        if isinstance(node, list) and node[0] == "symbol" and node[1] == q(name):
            return node
    raise KeyError(f"Symbol {libname}:{name} nicht gefunden")


def resolve_symbol(libname: str, name: str):
    """Löst `extends` auf: Grafik und Pins von der Basis, Properties vom Derivat."""
    derived = raw_symbol(libname, name)
    base_name = None
    for item in derived:
        if isinstance(item, list) and item[0] == "extends":
            base_name = item[1].strip('"')
    if base_name is None:
        return derived, name
    base, _ = resolve_symbol(libname, base_name)
    merged = [c for c in base if not (isinstance(c, list) and c[0] == "property")]
    props = [c for c in derived if isinstance(c, list) and c[0] == "property"]
    # Untereinheiten müssen auf den Zielnamen umbenannt werden, sonst findet
    # KiCad die Grafik der Instanz nicht.
    out = []
    for c in merged:
        if isinstance(c, list) and c[0] == "symbol":
            c = list(c)
            suffix = c[1].strip('"')[len(base_name):]
            c[1] = q(name + suffix)
        out.append(c)
    return [out[0], out[1]] + props + out[2:], name


def symbol_pins(sym) -> dict[str, tuple[float, float, float]]:
    """Pin-Nummer → (x, y, Winkel) in Symbolkoordinaten."""
    pins = {}
    for unit in sym:
        if isinstance(unit, list) and unit[0] == "symbol":
            for item in unit:
                if isinstance(item, list) and item[0] == "pin":
                    at = num = None
                    for f in item:
                        if isinstance(f, list) and f[0] == "at":
                            at = (float(f[1]), float(f[2]), float(f[3]))
                        if isinstance(f, list) and f[0] == "number":
                            num = f[1].strip('"')
                    pins[num] = at
    return pins


# ---------------------------------------------------------------- Bestückung

# ref: (lib_id, Wert, Footprint, x, y)
#
# V4: reiner Aufsatz für den Raspberry Pi. Der USB-Zweig ist entfallen — damit
# auch die Brücke, der ESD-Schutz, die Diodenverknüpfung und beide Jumper.
# Von 41 Bauteilen bleiben 25.
COMPONENTS = {
    # --- Anbindung an den Pi ---------------------------------------------
    # Nur die Header-Pins 1–10 werden gebraucht: 5 V auf 2/4, Masse auf 6/9,
    # GPIO14 auf 8, GPIO15 auf 10, GPIO4 auf 7. Ein 2×5-Wannenstecker reicht,
    # angebunden über ein 10-poliges Flachbandkabel.
    "J1":  ("Connector_Generic:Conn_02x20_Odd_Even", "Pi GPIO",
            "Connector_PinSocket_2.54mm:PinSocket_2x20_P2.54mm_Vertical", 40, 150),
    "J2":  ("Connector_Generic:Conn_02x03_Odd_Even", "AVR-ISP-6",
            "Connector_PinHeader_2.54mm:PinHeader_2x03_P2.54mm_Vertical", 45, 215),

    # --- Peripherie des Status-LED-OLED-Projekts --------------------------
    # Diese drei Stecker gehören auf die dem Pi zugewandte Kante. Verriegelnde
    # JST-XH statt Stiftleisten: die Kisten sitzen fest im Schrank, da soll
    # sich nichts durch Erschütterung lösen.
    "J5":  ("Connector_Generic:Conn_01x04", "OLED I2C",
            "Connector_JST:JST_PH_B4B-PH-K_1x04_P2.00mm_Vertical", 40, 265),
    "J6":  ("Connector_Generic:Conn_01x02", "Taster",
            "Connector_JST:JST_PH_B2B-PH-K_1x02_P2.00mm_Vertical", 65, 265),
    "J7":  ("Connector_Generic:Conn_01x03", "WS2812",
            "Connector_JST:JST_PH_B3B-PH-K_1x03_P2.00mm_Vertical", 90, 265),

    # Datenleitung der WS2812. Bestückt wird genau einer der beiden:
    #   R5 → SPI/GPIO10  (Vorgabe auf dem Pi 5, dort scheidet PWM aus)
    #   R4 → PWM/GPIO18  (Vorgabe auf Pi 3/4, dort ist der SPI-Takt instabil)
    # **Beide 330 Ω**: Das Vorbild (Status-LED-OLED) führt die Datenleitung für
    # beide Methoden über 330–470 Ω. R5 war anfangs eine 0-Ω-Brücke — damit
    # fehlte auf dem SPI-Weg genau dieser Widerstand.
    "R4":  ("Device:R", "390 DNP", "Resistor_SMD:R_0805_2012Metric_Pad1.20x1.40mm_HandSolder", 120, 240),
    "R5":  ("Device:R", "330", "Resistor_SMD:R_0805_2012Metric_Pad1.20x1.40mm_HandSolder", 145, 240),

    # --- Versorgung -------------------------------------------------------
    "U1":  ("Regulator_Linear:MCP1754S-3302xCB", "MCP1754S-3302xCB",
            "Package_TO_SOT_SMD:SOT-23", 152, 45),
    "C1":  ("Device:C", "10u", "Capacitor_SMD:C_0805_2012Metric_Pad1.18x1.45mm_HandSolder", 170, 57),
    "L1":  ("Device:FerriteBead", "BLM21PG300",
            "Inductor_SMD:L_0805_2012Metric_Pad1.15x1.40mm_HandSolder", 186, 45),
    "C2":  ("Device:C", "10u", "Capacitor_SMD:C_0805_2012Metric_Pad1.18x1.45mm_HandSolder", 202, 57),

    # --- Mikrocontroller --------------------------------------------------
    "U2":  ("MCU_Microchip_ATmega:ATmega328P-A", "ATmega328P-AU",
            "Package_QFP:TQFP-32_7x7mm_P0.8mm", 250, 130),
    "Y1":  ("Device:Resonator", "8MHz",
            "Crystal:Resonator_Murata_CSTLSxxxX-3Pin_W5.5mm_H3.0mm", 200, 95),
    "C3":  ("Device:C", "100n", "Capacitor_SMD:C_0805_2012Metric_Pad1.18x1.45mm_HandSolder", 288, 45),
    "C4":  ("Device:C", "100n", "Capacitor_SMD:C_0805_2012Metric_Pad1.18x1.45mm_HandSolder", 300, 45),
    "C9":  ("Device:C", "100n", "Capacitor_SMD:C_0805_2012Metric_Pad1.18x1.45mm_HandSolder", 312, 45),

    # --- Reset-Strecke ----------------------------------------------------
    # C8 koppelt die Flanke von GPIO4 auf RESET. **Nicht GPIO2** — der ist
    # I²C-SDA und wird vom OLED des Status-LED-Projekts belegt. Ein 100-nF-
    # Kondensator auf SDA würde den Bus unbrauchbar machen.
    "C8":  ("Device:C", "100n", "Capacitor_SMD:C_0805_2012Metric_Pad1.18x1.45mm_HandSolder", 140, 148),
    "R2":  ("Device:R", "10k", "Resistor_SMD:R_0805_2012Metric_Pad1.20x1.40mm_HandSolder", 208, 125),
    "TP1": ("Connector:TestPoint", "RESET", "TestPoint:TestPoint_Pad_1.0x1.0mm", 186, 112),
    "S1":  ("Switch:SW_Push", "RESET",
            "Button_Switch_SMD:SW_SPST_B3U-1000P-B", 208, 158),

    # --- Status-LED -------------------------------------------------------
    "R1":  ("Device:R", "330", "Resistor_SMD:R_0805_2012Metric_Pad1.20x1.40mm_HandSolder", 292, 190),
    "D1":  ("Device:LED", "LED",
            "LED_SMD:LED_0805_2012Metric_Pad1.15x1.40mm_HandSolder", 312, 190),

    # --- Funk-Frontend ----------------------------------------------------
    "U3":  ("AskSin-Analyzer-HAT:CC1101_Module_E07", "E07-900M10S",
            "AskSin-Analyzer-HAT:E07-900M10S", 372, 120),
    "C5":  ("Device:C", "100n", "Capacitor_SMD:C_0805_2012Metric_Pad1.18x1.45mm_HandSolder", 338, 55),
    "R3":  ("Device:R", "10k", "Resistor_SMD:R_0805_2012Metric_Pad1.20x1.40mm_HandSolder", 338, 160),

    # --- Prüfpunkte für den Fertigungstest --------------------------------
    "TP2": ("Connector:TestPoint", "+3V3", "TestPoint:TestPoint_Pad_1.0x1.0mm", 196, 272),
    "TP3": ("Connector:TestPoint", "+5V", "TestPoint:TestPoint_Pad_1.0x1.0mm", 209, 272),
    "TP4": ("Connector:TestPoint", "GND", "TestPoint:TestPoint_Pad_1.0x1.0mm", 222, 272),
    "TP5": ("Connector:TestPoint", "TXD", "TestPoint:TestPoint_Pad_1.0x1.0mm", 235, 272),
    "TP6": ("Connector:TestPoint", "RXD", "TestPoint:TestPoint_Pad_1.0x1.0mm", 248, 272),
    "TP7": ("Connector:TestPoint", "GDO0", "TestPoint:TestPoint_Pad_1.0x1.0mm", 261, 272),
    "TP8": ("Connector:TestPoint", "CS", "TestPoint:TestPoint_Pad_1.0x1.0mm", 274, 272),
}

# Versorgungssymbole: ref -> (lib_id, Netzname, x, y)
#
# +3V3 liegt hinter der Ferritperle L1, +5V hinter dem Steckverbinder — beide
# sind damit von jedem power_out-Pin getrennt und brauchen ein PWR_FLAG. Das
# ist kein Trick, sondern der korrekte Befund: weder eine Ferritperle noch ein
# Stecker ist eine Quelle.
POWER_SYMBOLS = {
    "#PWR01": ("power:+3V3", "+3V3", 236, 205),
    "#FLG03": ("power:PWR_FLAG", "+3V3", 236, 228),
    "#PWR02": ("power:+5V", "+5V", 262, 205),
    "#FLG01": ("power:PWR_FLAG", "+5V", 262, 228),
    "#PWR03": ("power:GND", "GND", 288, 212),
    "#FLG02": ("power:PWR_FLAG", "GND", 288, 232),
}

# ---------------------------------------------------------------- Netzliste
#
# Einzige Quelle der Wahrheit. Gegenprobe: hardware/README.md Abschnitt 3.
# Pin-Zuordnung des ATmega verifiziert gegen die V1.1-Verdrahtung.

NETS: dict[str, list[tuple[str, str]]] = {
    "+5V": [("J1", "2"), ("J1", "4"), ("U1", "3"), ("TP3", "1")],

    # 3,3 V des Pi wird zu Display und LED **durchgereicht**, nicht aus unserem
    # Regler erzeugt. Zwei Gründe: das Status-LED-Projekt nutzt sie bewusst so,
    # damit der Datenpegel der WS2812 ohne Pegelwandler passt — und unsere
    # Reglerschiene bleibt frei von Displaystörungen, was dem Empfänger zugute
    # kommt.
    "PI_3V3": [("J1", "1"), ("J5", "2"), ("J7", "1")],

    # I²C liegt unberührt durch: GPIO2/3 gehören dem OLED. Genau deshalb sitzt
    # unser Reset auf GPIO4 und nicht, wie ursprünglich geplant, auf GPIO2.
    "I2C_SDA": [("J1", "3"), ("J5", "4")],
    "I2C_SCL": [("J1", "5"), ("J5", "3")],

    "BTN": [("J1", "11"), ("J6", "1")],
    "LED_PWM": [("J1", "12"), ("R4", "1")],
    "LED_SPI": [("J1", "19"), ("R5", "1")],
    "WS_DATA": [("R4", "2"), ("R5", "2"), ("J7", "2")],
    "VREG_OUT": [("U1", "2"), ("C1", "1"), ("L1", "1")],
    "+3V3": [
        ("L1", "2"), ("C2", "1"),
        ("U2", "4"), ("U2", "6"), ("U2", "18"),
        ("C3", "1"), ("C4", "1"),
        ("U3", "9"), ("C5", "1"),
        ("R2", "1"), ("R3", "1"),
        ("J2", "2"), ("TP2", "1"),
    ],
    "GND": [
        ("J1", "6"), ("J1", "9"), ("J1", "14"), ("J1", "20"),
        ("J1", "25"), ("J1", "30"), ("J1", "34"), ("J1", "39"),
        ("J5", "1"), ("J6", "2"), ("J7", "3"),
        ("U1", "1"),
        ("C1", "2"), ("C2", "2"), ("C3", "2"), ("C4", "2"), ("C5", "2"),
        ("C9", "2"),
        ("U2", "3"), ("U2", "5"), ("U2", "21"),
        ("U3", "1"), ("U3", "2"), ("U3", "3"), ("U3", "4"), ("U3", "5"),
        ("U3", "11"), ("U3", "12"), ("U3", "20"), ("U3", "22"),
        ("Y1", "2"), ("D1", "1"), ("S1", "2"),
        ("J2", "6"), ("TP4", "1"),
    ],

    # --- Serielle Strecke, gekreuzt ---------------------------------------
    "UART_PI_TX": [("J1", "8"), ("U2", "30"), ("TP6", "1")],   # GPIO14 → PD0/RXD
    "UART_328_TX": [("U2", "31"), ("J1", "10"), ("TP5", "1")],  # PD1/TXD → GPIO15

    # --- Reset über GPIO4, nicht GPIO2 ------------------------------------
    "PI_RESET_DRV": [("J1", "7"), ("C8", "1")],
    "RESET": [
        ("C8", "2"), ("U2", "29"), ("R2", "2"),
        ("TP1", "1"), ("S1", "1"), ("J2", "5"),
    ],

    # --- SPI, geteilt zwischen Funkmodul und ISP-Header -------------------
    "MOSI": [("U2", "15"), ("U3", "17"), ("J2", "4")],
    "MISO": [("U2", "16"), ("U3", "16"), ("J2", "1")],
    "SCK":  [("U2", "17"), ("U3", "18"), ("J2", "3")],
    "CS":   [("U2", "14"), ("U3", "19"), ("R3", "2"), ("TP8", "1")],
    "GDO0": [("U2", "32"), ("U3", "15"), ("TP7", "1")],

    # --- Takt und Referenz ------------------------------------------------
    "XTAL1": [("U2", "7"), ("Y1", "1")],
    "XTAL2": [("U2", "8"), ("Y1", "3")],
    "AREF": [("U2", "20"), ("C9", "1")],

    # --- Status-LED an PD4 ------------------------------------------------
    # Achtung Polung: Im KiCad-Symbol Device:LED ist **Pin 1 = K (Kathode)**
    # und Pin 2 = A (Anode). Die Firmware schaltet den Treiberpin auf HIGH
    # (AskSinPP, Led::ledOn -> setHigh; invert() wird nie gesetzt), der Strom
    # fließt also aus dem Mikrocontroller über R1 in die **Anode** und von der
    # Kathode nach Masse. Bis Hardware v0.0.1 war genau das vertauscht — die
    # LED konnte nie leuchten.
    "LED_TREIBER": [("U2", "2"), ("R1", "1")],
    "LED_ANODE": [("R1", "2"), ("D1", "2")],
}

# Pins, die absichtlich offen bleiben.
NO_CONNECT: list[tuple[str, str]] = (
    [("U2", p) for p in ["1", "9", "10", "11", "12", "13", "19", "22",
                         "23", "24", "25", "26", "27", "28"]]
    + [("U3", p) for p in ["6", "7", "8", "10", "13", "14", "21"]]
    + [("J1", str(n)) for n in range(1, 41)
       if str(n) not in {"1", "2", "3", "4", "5", "6", "7", "8", "9", "10",
                         "11", "12", "14", "19", "20", "25", "30", "34", "39"}]
)


# ---------------------------------------------------------------- Generierung

GRID = 1.27


def snap(value: float) -> float:
    """Auf das KiCad-Standardraster ziehen.

    Ohne das meldet ERC jeden Pin als `endpoint_off_grid` — die Bauteilursprünge
    müssen selbst auf dem Raster liegen, damit es die rasterkonformen
    Pin-Offsets der Bibliothekssymbole auch bleiben.
    """
    return round(round(value / GRID) * GRID, 4)


def origin(ref: str) -> tuple[str, float, float]:
    if ref in COMPONENTS:
        lib_id, _, _, px, py = COMPONENTS[ref]
    else:
        lib_id, _, px, py = POWER_SYMBOLS[ref]
    return lib_id, snap(px), snap(py)


def pin_geometry(ref: str, pin: str):
    """Anschlusspunkt und Stichende eines Pins in Schaltplankoordinaten."""
    lib_id, px, py = origin(ref)
    libname, symname = lib_id.split(":", 1)
    sym, _ = resolve_symbol(libname, symname)
    at = symbol_pins(sym).get(pin)
    if at is None:
        raise KeyError(f"{ref}: Pin {pin} existiert in {lib_id} nicht")
    sx, sy, ang = at
    conn = (round(px + sx, 4), round(py - sy, 4))
    # Der Stich läuft entgegen der Pinrichtung, also vom Bauteil weg.
    stub = 3.81
    dx = -math.cos(math.radians(ang)) * stub
    dy = -math.sin(math.radians(ang)) * stub
    end = (round(conn[0] + dx, 4), round(conn[1] - dy, 4))
    return conn, end


def build() -> str:
    root_uuid = det_uuid("root")
    used_lib_ids = {c[0] for c in COMPONENTS.values()} | {p[0] for p in POWER_SYMBOLS.values()}

    body: list[str] = []

    # --- lib_symbols ------------------------------------------------------
    lib_entries = []
    for lib_id in sorted(used_lib_ids):
        libname, symname = lib_id.split(":", 1)
        sym, _ = resolve_symbol(libname, symname)
        entry = list(sym)
        entry[1] = q(lib_id)
        lib_entries.append(dump_sexp(entry, 2))
    body.append("\t(lib_symbols\n" + "\n".join(lib_entries) + "\n\t)")

    # --- Bauteilinstanzen -------------------------------------------------
    def emit_symbol(ref, lib_id, value, footprint, x, y, is_power):
        libname, symname = lib_id.split(":", 1)
        sym, _ = resolve_symbol(libname, symname)
        pins = symbol_pins(sym)
        u = det_uuid(f"sym:{ref}")
        hide_ref = " (hide yes)" if is_power else ""
        lines = [
            "\t(symbol",
            f"\t\t(lib_id {q(lib_id)})",
            f"\t\t(at {x} {y} 0)",
            "\t\t(unit 1)",
            "\t\t(exclude_from_sim no)",
            f"\t\t(in_bom {'no' if is_power else 'yes'})",
            f"\t\t(on_board {'no' if is_power else 'yes'})",
            "\t\t(dnp no)",
            f"\t\t(uuid {q(u)})",
            f"\t\t(property \"Reference\" {q(ref)}",
            f"\t\t\t(at {x + 2.54} {y - 5.08} 0)",
            f"\t\t\t(effects (font (size 1.27 1.27)) (justify left){hide_ref})",
            "\t\t)",
            f"\t\t(property \"Value\" {q(value)}",
            f"\t\t\t(at {x + 2.54} {y - 2.54} 0)",
            "\t\t\t(effects (font (size 1.27 1.27)) (justify left))",
            "\t\t)",
            f"\t\t(property \"Footprint\" {q(footprint)}",
            f"\t\t\t(at {x} {y} 0)",
            "\t\t\t(effects (font (size 1.27 1.27)) (hide yes))",
            "\t\t)",
            f"\t\t(property \"Datasheet\" \"~\"",
            f"\t\t\t(at {x} {y} 0)",
            "\t\t\t(effects (font (size 1.27 1.27)) (hide yes))",
            "\t\t)",
            f"\t\t(property \"Description\" \"\"",
            f"\t\t\t(at {x} {y} 0)",
            "\t\t\t(effects (font (size 1.27 1.27)) (hide yes))",
            "\t\t)",
        ]
        for num in sorted(pins, key=lambda n: int(n) if n.isdigit() else 0):
            lines.append(f"\t\t(pin {q(num)} (uuid {q(det_uuid(f'pin:{ref}:{num}'))}))")
        lines += [
            "\t\t(instances",
            f"\t\t\t(project {q(PROJECT)}",
            f"\t\t\t\t(path {q('/' + root_uuid)}",
            f"\t\t\t\t\t(reference {q(ref)}) (unit 1)",
            "\t\t\t\t)",
            "\t\t\t)",
            "\t\t)",
            "\t)",
        ]
        body.append("\n".join(lines))

    for ref, (lib_id, value, footprint, _x, _y) in COMPONENTS.items():
        _, x, y = origin(ref)
        emit_symbol(ref, lib_id, value, footprint, x, y, False)
    for ref, (lib_id, netname, _x, _y) in POWER_SYMBOLS.items():
        _, x, y = origin(ref)
        emit_symbol(ref, lib_id, netname, "", x, y, True)

    # --- Stiche und Labels -------------------------------------------------
    for net, pins in NETS.items():
        for ref, pin in pins:
            conn, end = pin_geometry(ref, pin)
            body.append(
                f"\t(wire (pts (xy {conn[0]} {conn[1]}) (xy {end[0]} {end[1]}))\n"
                f"\t\t(stroke (width 0) (type default))\n"
                f"\t\t(uuid {q(det_uuid(f'wire:{net}:{ref}:{pin}'))})\n\t)"
            )
            body.append(
                f"\t(label {q(net)}\n"
                f"\t\t(at {end[0]} {end[1]} 0)\n"
                "\t\t(fields_autoplaced yes)\n"
                "\t\t(effects (font (size 1.27 1.27)) (justify left bottom))\n"
                f"\t\t(uuid {q(det_uuid(f'label:{net}:{ref}:{pin}'))})\n\t)"
            )

    # Versorgungssymbole an ihr jeweiliges Netz labeln
    for ref, (_lib_id, netname, _x, _y) in POWER_SYMBOLS.items():
        conn, end = pin_geometry(ref, "1")
        body.append(
            f"\t(wire (pts (xy {conn[0]} {conn[1]}) (xy {end[0]} {end[1]}))\n"
            f"\t\t(stroke (width 0) (type default))\n"
            f"\t\t(uuid {q(det_uuid(f'wire:pwr:{ref}'))})\n\t)"
        )
        body.append(
            f"\t(label {q(netname)}\n"
            f"\t\t(at {end[0]} {end[1]} 0)\n"
            "\t\t(fields_autoplaced yes)\n"
            "\t\t(effects (font (size 1.27 1.27)) (justify left bottom))\n"
            f"\t\t(uuid {q(det_uuid(f'label:pwr:{ref}'))})\n\t)"
        )

    # --- No-Connect --------------------------------------------------------
    for ref, pin in NO_CONNECT:
        conn, _ = pin_geometry(ref, pin)
        body.append(
            f"\t(no_connect (at {conn[0]} {conn[1]})"
            f" (uuid {q(det_uuid(f'nc:{ref}:{pin}'))}))"
        )

    header = [
        "(kicad_sch",
        "\t(version 20250114)",
        "\t(generator \"asksin-analyzer-hat-generator\")",
        "\t(generator_version \"9.0\")",
        f"\t(uuid {q(root_uuid)})",
        "\t(paper \"A3\")",
        "\t(title_block",
        "\t\t(title \"AskSin-Analyzer V3\")",
        "\t\t(rev \"3.0\")",
        "\t\t(comment 1 \"Abgeleitet von AskSin-Analyzer-XS-RPi V1.1 (der-pw), CC BY-NC-SA 4.0\")",
        "\t\t(comment 2 \"Generiert aus generate_schematic.py - Netzliste dort aendern, nicht hier\")",
        "\t)",
    ]
    footer = [
        "\t(sheet_instances",
        "\t\t(path \"/\" (page \"1\"))",
        "\t)",
        "\t(embedded_fonts no)",
        ")",
    ]
    return "\n".join(header + body + footer) + "\n"


def write_project() -> None:
    # Nur beim allerersten Lauf anlegen: die vorhandene .kicad_pro enthält
    # inzwischen die Board-Designregeln des Produktionsstands (DRC,
    # Netzklassen) — die darf ein Schaltplan-Neubau nicht plattmachen.
    pro = HERE / f"{PROJECT}.kicad_pro"
    if not pro.exists():
        pro.write_text(
            '{\n  "board": {},\n  "libraries": {"pinned_footprint_libs": [], '
            '"pinned_symbol_libs": []},\n  "meta": {"filename": '
            f'"{PROJECT}.kicad_pro", "version": 3}},\n  "schematic": {{}},\n'
            '  "sheets": [],\n  "text_variables": {}\n}\n'
        )
    stock = sorted(({c[0].split(":", 1)[0] for c in COMPONENTS.values()}
                    | {p[0].split(":", 1)[0] for p in POWER_SYMBOLS.values()})
                   - {"AskSin-Analyzer-HAT"})
    rows = ['  (lib (name "AskSin-Analyzer-HAT")(type "KiCad")'
            '(uri "${KIPRJMOD}/lib/AskSin-Analyzer-HAT.kicad_sym")(options "")(descr ""))']
    for lib in stock:
        rows.append(f'  (lib (name "{lib}")(type "KiCad")'
                    f'(uri "${{KICAD9_SYMBOL_DIR}}/{lib}.kicad_sym")(options "")(descr ""))')
    (HERE / "sym-lib-table").write_text(
        "(sym_lib_table\n  (version 7)\n" + "\n".join(rows) + "\n)\n"
    )
    (HERE / "fp-lib-table").write_text(
        "(fp_lib_table\n"
        "  (version 7)\n"
        '  (lib (name "AskSin-Analyzer-HAT")(type "KiCad")'
        '(uri "${KIPRJMOD}/lib/AskSin-Analyzer-HAT.pretty")(options "")(descr ""))\n'
        ")\n"
    )


def write_netlist_report() -> None:
    """Menschenlesbare Netzliste zur Gegenprobe mit der Spezifikation."""
    lines = [f"# Netzliste {PROJECT}", "",
             "Generiert aus `generate_schematic.py`. Gegenprobe: `../README.md` Abschnitt 3.",
             "", "| Netz | Anschlüsse |", "| --- | --- |"]
    for net, pins in NETS.items():
        joined = ", ".join(f"{r}.{p}" for r, p in pins)
        lines.append(f"| `{net}` | {joined} |")
    lines += ["", f"Netze: {len(NETS)} · Bauteile: {len(COMPONENTS)} · "
                  f"No-Connect-Marker: {len(NO_CONNECT)}", ""]
    (HERE / "netlist.md").write_text("\n".join(lines))


def main() -> None:
    seen: set[tuple[str, str]] = set()
    for net, pins in NETS.items():
        for entry in pins:
            if entry in seen:
                raise SystemExit(f"Pin {entry[0]}.{entry[1]} ist mehrfach vernetzt")
            seen.add(entry)
    for entry in NO_CONNECT:
        if entry in seen:
            raise SystemExit(f"Pin {entry[0]}.{entry[1]} ist vernetzt und zugleich No-Connect")

    SHEET_FILE.write_text(build())
    write_project()
    write_netlist_report()
    print(f"geschrieben: {SHEET_FILE.name}")
    print(f"  Bauteile        : {len(COMPONENTS)}")
    print(f"  Versorgungssymb.: {len(POWER_SYMBOLS)}")
    print(f"  Netze           : {len(NETS)}")
    print(f"  Anschlüsse      : {sum(len(p) for p in NETS.values())}")
    print(f"  No-Connect      : {len(NO_CONNECT)}")


if __name__ == "__main__":
    main()
