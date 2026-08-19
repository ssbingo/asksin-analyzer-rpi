#!/usr/bin/env python3
"""
Rendert die OLED-Seiten in eine PNG-Datei — für Handbuch und Sichtprüfung.

Nutzt **denselben Zeichencode wie das Gerät** (`oled.py`), nur ohne Display:
Statt `adafruit_ssd1306` bekommt die Klasse einen Ersatz untergeschoben, der
die Bilder einsammelt. Damit kann das Handbuchbild nicht mehr von dem
abweichen, was auf dem Panel steht — genau das war vorher der Fall, weil die
Vorschau aus einem zweiten, eigenen Renderer kam.

Aufruf:
    python3 deploy/oled-vorschau.py ziel.png [zoom] [hoehe]
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import oled                                                    # noqa: E402

BEISPIEL = {
    "standort": "Büro Keller",
    "version": "0.9.0",
    "status": "BEREIT",
    "telegramsPerMinute": 137,
    "noiseFloor": -91,
    "deviceCount": 16,
    "maxDutyCycle": {"name": "Defekt_BWM Carport (klemmt)", "percent": 96.4},
    "dutyAlarme": [{"name": "Defekt_BWM Carport (klemmt)", "percent": 96.4}],
    # Die Funkstatus-Seite. Absichtlich EIN Haken und EIN Kreuz: So zeigt das
    # Handbuchbild beide Sinnbilder in beiden Zustaenden, statt zweimal
    # dasselbe.
    "bidcos": True,
    "zigbee": False,
}


# Feste Beispielwerte statt der echten Systemwerte. Ohne diese Zeilen stünden
# Hostname, IP-Adresse und MAC des erzeugenden Rechners im Handbuch — genau das
# ist am 30.07.2026 passiert und musste nachträglich bereinigt werden.
oled.get_ip = lambda: "192.168.1.71"
oled.get_mac = lambda: "B8:27:EB:1A:2B:3C"
oled.get_hostname = lambda: "asksin-analyzer-01"
oled.get_mem_mb = lambda: (512, 2048)
oled.get_temp_c = lambda: 51.0
oled.get_load = lambda: 0.42
oled.get_uptime_s = lambda: 21 * 86400 + 22 * 3600
oled.get_fan_rpm = lambda: 3120
oled.get_disk_frei_prozent = lambda _pfad="/": 83.0


class ErsatzDisplay:
    """Nimmt die Bilder entgegen, statt sie auf den Bus zu schieben."""

    def __init__(self) -> None:
        self.letztes = None

    def fill(self, _wert: int) -> None:
        pass

    def image(self, bild) -> None:                             # noqa: ANN001
        self.letztes = bild.copy()

    def show(self) -> None:
        pass


class VorschauAnzeige(oled.OledAnzeige):
    """Wie OledAnzeige, aber ohne I²C — der Rest ist identisch."""

    def __init__(self, breite: int, hoehe: int) -> None:
        from PIL import Image, ImageDraw, ImageFont

        self._disp = ErsatzDisplay()
        self._w, self._h = breite, hoehe
        self._img = Image.new("1", (breite, hoehe))
        self._draw = ImageDraw.Draw(self._img)
        self._font = ImageFont.load_default()
        self._ttf = next(
            (p for p in oled.TTF_KANDIDATEN if Path(p).exists()), None
        )
        self._gross: dict[int, object] = {}
        self._klein_cache: dict[int, object] = {}


def main() -> int:
    from PIL import Image

    ziel = sys.argv[1] if len(sys.argv) > 1 else "oled-seiten.png"
    zoom = int(sys.argv[2]) if len(sys.argv) > 2 else 5
    hoehe = int(sys.argv[3]) if len(sys.argv) > 3 else 32
    breite = 128

    anzeige = VorschauAnzeige(breite, hoehe)
    seiten = oled.seiten_anzahl(BEISPIEL)

    bilder = []
    for seite in range(seiten):
        anzeige.zeichne(BEISPIEL, seite)
        bilder.append(anzeige._disp.letztes.convert("L"))

    spalten = 2
    zeilen = (len(bilder) + spalten - 1) // spalten
    rand = 6
    blatt = Image.new(
        "L",
        (spalten * breite * zoom + (spalten + 1) * rand,
         zeilen * hoehe * zoom + (zeilen + 1) * rand),
        210,
    )
    for i, bild in enumerate(bilder):
        gross = bild.resize((breite * zoom, hoehe * zoom), Image.NEAREST)
        # Leuchtpunkte auf dunklem Grund, wie am Gerät.
        gross = gross.point(lambda w: 255 if w > 127 else 20)
        x = rand + (i % spalten) * (breite * zoom + rand)
        y = rand + (i // spalten) * (hoehe * zoom + rand)
        blatt.paste(gross, (x, y))
    blatt.save(ziel)
    print(f"{ziel}: {blatt.width}×{blatt.height} Pixel, {seiten} Seiten "
          f"({breite}×{hoehe}) à {zoom}×")
    return 0


if __name__ == "__main__":
    sys.exit(main())
