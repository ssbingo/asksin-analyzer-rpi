#!/usr/bin/env python3
"""
Erzeugt das Schaltplansymbol des CC1101-Funkmoduls.

Zielmodul: **Ebyte E07-900M10S** — CC1101, 855–925 MHz (deckt 868 ab),
26-MHz-Quarz, 22 Halblöcher im 1,27-mm-Raster, 14 × 20 mm, IPEX-Antennenbuchse.

Belegung verifiziert gegen `../datasheets/Ebyte_E07-M_series_specification.pdf`,
Abschnitt 3.2. Zwei Punkte, die dabei geklärt wurden:

- Nur die 14×20-mm-Varianten (M10S) haben eine IPEX-Buchse. Die 10×10-mm-Module
  (MM10S) tragen ausschließlich Stanzlöcher und scheiden damit aus.
- Die Frequenztabelle des Herstellers weist für den E07-900M10S **855–925 MHz**
  aus. Die im Anwenderhandbuch genannten 904–925 MHz sind die
  FCC-Zulassungsgrenze für die USA, nicht die Hardwaregrenze.

Aufruf:
    python3 generate_module_symbol.py
"""

from __future__ import annotations

import pathlib

HERE = pathlib.Path(__file__).resolve().parent
OUT = HERE / "lib" / "AskSin-Analyzer-HAT.kicad_sym"

# (Nummer, Name, elektrischer Typ, Seite)
#   Seite "L" = links, "R" = rechts
PINS = [
    ("9", "VCC", "power_in", "L"),
    ("17", "MOSI", "input", "L"),
    ("18", "SCK", "input", "L"),
    ("16", "MISO", "output", "L"),
    ("19", "~{CSN}", "input", "L"),
    ("15", "GDO0", "bidirectional", "L"),
    ("14", "GDO2", "bidirectional", "L"),
    ("21", "ANT", "passive", "R"),
    ("6", "NC1", "no_connect", "R"),
    ("7", "NC2", "no_connect", "R"),
    ("8", "NC3", "no_connect", "R"),
    ("10", "NC4", "no_connect", "R"),
    ("13", "NC5", "no_connect", "R"),
    ("1", "GND1", "power_in", "B"),
    ("2", "GND2", "power_in", "B"),
    ("3", "GND3", "power_in", "B"),
    ("4", "GND4", "power_in", "B"),
    ("5", "GND5", "power_in", "B"),
    ("11", "GND6", "power_in", "B"),
    ("12", "GND7", "power_in", "B"),
    ("20", "GND8", "power_in", "B"),
    ("22", "GND9", "power_in", "B"),
]

PITCH = 2.54
PIN_LEN = 5.08
# Der Körper muss breit genug für die Masse-Pins an der Unterkante sein,
# sonst stehen sie außerhalb des Rechtecks.
BODY_HALF_W = 12.7
HALF_W = BODY_HALF_W + PIN_LEN


def build() -> str:
    left = [p for p in PINS if p[3] == "L"]
    right = [p for p in PINS if p[3] == "R"]
    bottom = [p for p in PINS if p[3] == "B"]

    rows = max(len(left), len(right))
    top_y = (rows - 1) * PITCH / 2
    body_top = top_y + PITCH
    body_bottom = -(len(bottom) - 1) * PITCH / 2 - PITCH * 2
    bottom_x0 = -(len(bottom) - 1) * PITCH / 2

    out: list[str] = []
    for i, (num, name, etype, _) in enumerate(left):
        out.append(pin(num, name, etype, -HALF_W, top_y - i * PITCH, 0))
    for i, (num, name, etype, _) in enumerate(right):
        out.append(pin(num, name, etype, HALF_W, top_y - i * PITCH, 180))
    for i, (num, name, etype, _) in enumerate(bottom):
        out.append(pin(num, name, etype, bottom_x0 + i * PITCH,
                       body_bottom - PIN_LEN, 90))

    body = f"""		(symbol "CC1101_Module_E07_0_1"
			(rectangle
				(start {-BODY_HALF_W} {body_top})
				(end {BODY_HALF_W} {body_bottom})
				(stroke (width 0.254) (type default))
				(fill (type background))
			)
		)"""

    return f"""(kicad_symbol_lib
	(version 20241209)
	(generator "asksin-analyzer-hat")
	(generator_version "9.0")
	(symbol "CC1101_Module_E07"
		(pin_names (offset 1.016))
		(exclude_from_sim no)
		(in_bom yes)
		(on_board yes)
		(property "Reference" "U"
			(at {-BODY_HALF_W} {body_top + 2.54} 0)
			(effects (font (size 1.27 1.27)) (justify left bottom))
		)
		(property "Value" "E07-900M10S"
			(at {-BODY_HALF_W} {body_top + 5.08} 0)
			(effects (font (size 1.27 1.27)) (justify left bottom))
		)
		(property "Footprint" ""
			(at 0 0 0)
			(effects (font (size 1.27 1.27)) (hide yes))
		)
		(property "Datasheet" "https://www.cdebyte.com/products/E07-900M10S"
			(at 0 0 0)
			(effects (font (size 1.27 1.27)) (hide yes))
		)
		(property "Description" "CC1101-Funkmodul 855-925 MHz, 22 Halbloecher 1.27 mm, 14x20 mm, IPEX-Antennenbuchse"
			(at 0 0 0)
			(effects (font (size 1.27 1.27)) (hide yes))
		)
{body}
		(symbol "CC1101_Module_E07_1_1"
{chr(10).join(out)}
		)
		(embedded_fonts no)
	)
)
"""


def pin(number: str, name: str, etype: str, x: float, y: float, angle: int) -> str:
    return f"""			(pin {etype} line
				(at {round(x, 3)} {round(y, 3)} {angle})
				(length {PIN_LEN})
				(name "{name}" (effects (font (size 1.27 1.27))))
				(number "{number}" (effects (font (size 1.27 1.27))))
			)"""


if __name__ == "__main__":
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(build())
    print(f"geschrieben: {OUT.relative_to(HERE)}  ({len(PINS)} Pins)")
