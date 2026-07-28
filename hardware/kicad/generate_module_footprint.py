#!/usr/bin/env python3
"""
Erzeugt den Footprint des Funkmoduls **Ebyte E07-900M10S**.

Quelle: `../datasheets/Ebyte_E07-M_series_specification.pdf`, Abschnitt 3.2
(„E07-400M10S & E07-900M10S Mechanical Dimensions and Pin Definitions").
Alle Maße unten stammen aus dieser Zeichnung, nichts ist geschätzt — mit einer
begründeten Ausnahme, siehe „Landepads".

Geometrie laut Datenblatt
-------------------------
- Modul 14,0 × 20,0 mm, Höhe 3,00 mm, 22 Halblöcher, Raster 1,27 mm
- Je Seite 11 Pads in zwei Gruppen: acht oben, drei unten, dazwischen 5,57 mm
- Erster Pad-Mittelpunkt 2,00 mm unter der Oberkante
- Letzter Pad-Mittelpunkt 1,00 mm über der Unterkante
- Zählrichtung: Pin 1 unten rechts, aufwärts bis Pin 11 oben rechts,
  weiter bei Pin 12 oben links, abwärts bis Pin 22 unten links
- IPEX-Buchse sitzt unten links, Antenne verlässt das Modul dort

Landepads
---------
Die Maßangaben des Datenblatts beschreiben die Pads **des Moduls**, nicht das
Landemuster der Trägerplatine. Für Halblöcher ist es gängige und empfohlene
Praxis, das Landepad länger zu machen, damit sich außen eine sichtbare
Lötkehle bildet und die Bestückung optisch prüfbar bleibt. Verwendet werden
0,8 mm Breite (im Raster von 1,27 mm bleiben damit 0,47 mm Luft) und 1,8 mm
Länge, davon 0,6 mm unter dem Modul und 1,2 mm nach außen.

Aufruf:
    python3 generate_module_footprint.py
"""

from __future__ import annotations

import hashlib
import pathlib
import uuid as uuidlib

HERE = pathlib.Path(__file__).resolve().parent
OUT = HERE / "lib" / "AskSin-Analyzer-HAT.pretty" / "E07-900M10S.kicad_mod"

# --- Maße aus dem Datenblatt, Abschnitt 3.2 ---------------------------------
BODY_W = 14.0
BODY_H = 20.0
PITCH = 1.27
FIRST_OFFSET = 2.00          # Oberkante → Mittelpunkt des ersten Pads
GROUP_A = 8                  # Pads in der oberen Gruppe je Seite
GROUP_B = 3                  # Pads in der unteren Gruppe je Seite
GAP = 5.57                   # letzter Pad Gruppe A → erster Pad Gruppe B
LAST_OFFSET = 1.00           # letzter Pad → Unterkante (Kontrollmaß)

# --- Landemuster ------------------------------------------------------------
PAD_W = 1.8                  # Länge quer zur Modulkante
PAD_H = 0.8                  # Breite in Rasterrichtung
PAD_INSIDE = 0.6             # davon unter dem Modul
COURTYARD = 0.5


def det_uuid(key: str) -> str:
    return str(uuidlib.UUID(hashlib.md5(f"e07fp:{key}".encode()).hexdigest()))


def pad_y_positions() -> list[float]:
    """Pad-Mittelpunkte in Modulkoordinaten, Ursprung in der Mitte."""
    ys = [FIRST_OFFSET + i * PITCH for i in range(GROUP_A)]
    start_b = ys[-1] + GAP
    ys += [start_b + i * PITCH for i in range(GROUP_B)]
    # Kontrolle gegen das zweite Maß der Zeichnung
    assert abs((BODY_H - ys[-1]) - LAST_OFFSET) < 0.01, (
        f"Maßkette inkonsistent: letzter Pad bei {ys[-1]}, "
        f"Unterkante {BODY_H}, erwartet {LAST_OFFSET} Abstand"
    )
    return [y - BODY_H / 2 for y in ys]


def build() -> str:
    ys = pad_y_positions()
    half_w = BODY_W / 2
    # Mittelpunkt des Landepads: PAD_INSIDE unter dem Modul, Rest nach außen
    pad_cx = half_w - PAD_INSIDE + PAD_W / 2

    parts: list[str] = []

    def pad(number: int, x: float, y: float) -> None:
        parts.append(
            f'\t(pad "{number}" smd rect\n'
            f"\t\t(at {round(x, 4)} {round(y, 4)})\n"
            f"\t\t(size {PAD_W} {PAD_H})\n"
            f'\t\t(layers "F.Cu" "F.Paste" "F.Mask")\n'
            f'\t\t(uuid "{det_uuid(f"pad{number}")}")\n'
            f"\t)"
        )

    # Rechte Seite: Pin 1 unten, aufwärts bis Pin 11 oben.
    right = list(range(1, 12))                 # 1 … 11
    for pin, y in zip(right, reversed(ys)):
        pad(pin, pad_cx, y)
    # Linke Seite: Pin 12 oben, abwärts bis Pin 22 unten.
    left = list(range(12, 23))                 # 12 … 22
    for pin, y in zip(left, ys):
        pad(pin, -pad_cx, y)

    def line(x1: float, y1: float, x2: float, y2: float, layer: str,
             width: float, key: str) -> None:
        parts.append(
            f"\t(fp_line\n"
            f"\t\t(start {round(x1, 4)} {round(y1, 4)})\n"
            f"\t\t(end {round(x2, 4)} {round(y2, 4)})\n"
            f"\t\t(stroke (width {width}) (type solid))\n"
            f'\t\t(layer "{layer}")\n'
            f'\t\t(uuid "{det_uuid(key)}")\n'
            f"\t)"
        )

    # Modulumriss auf F.Fab
    hh = BODY_H / 2
    for i, (a, b) in enumerate([((-half_w, -hh), (half_w, -hh)),
                                ((half_w, -hh), (half_w, hh)),
                                ((half_w, hh), (-half_w, hh)),
                                ((-half_w, hh), (-half_w, -hh))]):
        line(a[0], a[1], b[0], b[1], "F.Fab", 0.1, f"fab{i}")

    # Siebdruck nur an Ober- und Unterkante — an den Seiten liegen die Pads.
    silk_y = hh + 0.2
    line(-half_w, -silk_y, half_w, -silk_y, "F.SilkS", 0.12, "silk_top")
    line(-half_w, silk_y, half_w, silk_y, "F.SilkS", 0.12, "silk_bottom")
    # Pin-1-Markierung unten rechts
    line(half_w + 0.4, silk_y, half_w + 0.4, silk_y - 1.0, "F.SilkS", 0.12, "silk_pin1")

    # Sperrfläche/Courtyard
    cx = pad_cx + PAD_W / 2 + COURTYARD
    cy = hh + COURTYARD
    for i, (a, b) in enumerate([((-cx, -cy), (cx, -cy)), ((cx, -cy), (cx, cy)),
                                ((cx, cy), (-cx, cy)), ((-cx, cy), (-cx, -cy))]):
        line(a[0], a[1], b[0], b[1], "F.CrtYd", 0.05, f"crtyd{i}")

    body = "\n".join(parts)
    return f'''(footprint "E07-900M10S"
	(version 20240108)
	(generator "asksin-analyzer-hat")
	(generator_version "9.0")
	(layer "F.Cu")
	(descr "Ebyte E07-900M10S, CC1101 855-925 MHz, 14x20 mm, 22 Halbloecher 1.27 mm, IPEX-Antennenbuchse. Masse aus der Herstellerspezifikation Abschnitt 3.2.")
	(tags "RF CC1101 868MHz Ebyte E07 castellated IPEX")
	(attr smd)
	(property "Reference" "REF**"
		(at 0 {-hh - 1.5} 0)
		(layer "F.SilkS")
		(uuid "{det_uuid('ref')}")
		(effects (font (size 1 1) (thickness 0.15)))
	)
	(property "Value" "E07-900M10S"
		(at 0 {hh + 1.5} 0)
		(layer "F.Fab")
		(uuid "{det_uuid('val')}")
		(effects (font (size 1 1) (thickness 0.15)))
	)
	(property "Datasheet" "https://www.cdebyte.com/products/E07-900M10S"
		(at 0 0 0)
		(layer "F.Fab")
		(hide yes)
		(uuid "{det_uuid('ds')}")
		(effects (font (size 1 1) (thickness 0.15)))
	)
	(property "Description" "CC1101-Funkmodul 855-925 MHz mit IPEX-Antennenbuchse"
		(at 0 0 0)
		(layer "F.Fab")
		(hide yes)
		(uuid "{det_uuid('desc')}")
		(effects (font (size 1 1) (thickness 0.15)))
	)
{body}
	(embedded_fonts no)
)
'''


if __name__ == "__main__":
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(build())
    ys = pad_y_positions()
    print(f"geschrieben: {OUT.relative_to(HERE)}")
    print(f"  Modul      : {BODY_W} x {BODY_H} mm, 22 Pads, Raster {PITCH} mm")
    print(f"  Pad-Reihen : Gruppe A {GROUP_A}, Lücke {GAP} mm, Gruppe B {GROUP_B}")
    print(f"  Y-Bereich  : {ys[0]:+.2f} … {ys[-1]:+.2f} mm (Modulmitte = 0)")
    print("  Maßkette gegen die Zeichnung geprüft: ok")
