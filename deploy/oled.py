#!/usr/bin/env python3
"""
OLED-Anzeige des AskSin-Analyzers — Portierung aus dem Projekt
**Status-LED-OLED** (ssbingo), mit dessen Bibliotheken, Schriften und Maßen.

Warum als eigener Python-Dienst statt im Core
---------------------------------------------
Der erste Anlauf hat das Display in TypeScript nachgebaut: eigener
SSD1306-Treiber, eigene 5×7-Pixelschrift, eigenes Seitenraster. Das Ergebnis
war auf dem Gerät deutlich schlechter lesbar als das Vorbild — die 5×7-Schrift
ist rund 1,7 mm hoch, während das Original eine **echte TrueType-Schrift in
Fettschnitt** bis 28 px verwendet und ihre Größe je Wert automatisch sucht.

Deshalb kommt hier derselbe Stapel zum Einsatz wie dort:

    board / busio          Blinka — I²C-Bus des Pi
    adafruit_ssd1306       Treiber für das Display
    PIL (Pillow)           Zeichnen, Schriften
    DejaVuSans-Bold.ttf    die große Schrift (Paket fonts-dejavu-core)

Übernommen sind Seitenaufbau, Schriftwahl, `_fit_font`, die Feldliste und die
Übersichtsseite. Ergänzt sind nur die Felder, die es beim Analyzer zusätzlich
gibt (Telegramme, Rauschen, Geräte, Duty-Cycle) — in derselben Form.

Arbeitsteilung
--------------
Der Analyzer-Dienst schreibt seine Werte nach
`/var/lib/asksin-analyzer/oled-state.json` (Zustand, Telegrammrate, Standort,
aktuelle Seite). Die Systemwerte — IP, MAC, Hostname, CPU, RAM, Laufzeit,
Lüfter — liest dieser Dienst selbst, genau wie das Original.

Nach jedem Bild wird der Framebuffer zusätzlich als Base64 nach
`oled-bild.b64` geschrieben. Die Weboberfläche zeigt damit **exakt** das Bild
vom Gerät und nicht einen Nachbau davon.

Aufruf (normalerweise durch asksin-analyzer-oled.service):
    ./oled.py [--zustand PFAD] [--bild PFAD] [--breite 128] [--hoehe 32]
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import signal
import socket
import sys
import time
from pathlib import Path

TAKT_S = 0.5            # Abtastung der Zustandsdatei; 2 Hz wie im Vorbild
VORGABE_ZUSTAND = "/var/lib/asksin-analyzer/oled-state.json"
VORGABE_BILD = "/var/lib/asksin-analyzer/oled-bild.b64"

# Aus dem Original übernommen.
TTF_KANDIDATEN = (
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
)


# --------------------------------------------------------------- Systemwerte
# Alle Funktionen dieses Abschnitts stammen aus Status-LED-OLED und sind
# unverändert übernommen, damit Format und Verhalten identisch bleiben.

def get_ip() -> str:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))   # sendet nichts, wählt nur die Route
        return s.getsockname()[0]
    except OSError:
        return "n/a"
    finally:
        s.close()


def get_hostname() -> str:
    try:
        return socket.gethostname()
    except OSError:
        return "n/a"


def get_active_iface() -> str:
    try:
        with open("/proc/net/route", encoding="ascii") as f:
            next(f)
            for zeile in f:
                teile = zeile.split()
                if len(teile) > 2 and teile[1] == "00000000":
                    return teile[0]
    except (OSError, StopIteration):
        pass
    return ""


def get_mac() -> str:
    iface = get_active_iface()
    if not iface:
        return "n/a"
    try:
        mac = Path(f"/sys/class/net/{iface}/address").read_text().strip()
        return mac.upper() if mac else "n/a"
    except OSError:
        return "n/a"


def get_mem_mb() -> tuple[int, int]:
    try:
        info = {}
        with open("/proc/meminfo", encoding="ascii") as f:
            for zeile in f:
                key, _, val = zeile.partition(":")
                info[key] = int(val.strip().split()[0])          # kB
        total = info["MemTotal"] // 1024
        avail = info.get("MemAvailable", info.get("MemFree", 0)) // 1024
        return max(total - avail, 0), total
    except (OSError, KeyError, ValueError, IndexError):
        return 0, 0


def get_uptime_s() -> float:
    try:
        with open("/proc/uptime", encoding="ascii") as f:
            return float(f.read().split()[0])
    except (OSError, ValueError, IndexError):
        return 0.0


def get_temp_c() -> float:
    try:
        with open("/sys/class/thermal/thermal_zone0/temp", encoding="ascii") as f:
            return int(f.read().strip()) / 1000.0
    except (OSError, ValueError):
        return 0.0


def get_load() -> float:
    try:
        return os.getloadavg()[0]
    except OSError:
        return 0.0


def get_fan_rpm() -> int | None:
    """Lüfterdrehzahl aus hwmon — Pi 5 und geregelte PoE-HATs melden sie dort."""
    try:
        for eintrag in os.listdir("/sys/class/hwmon"):
            pfad = Path(f"/sys/class/hwmon/{eintrag}/fan1_input")
            if pfad.exists():
                return int(pfad.read_text().strip())
    except (OSError, ValueError):
        pass
    return None


def get_disk_frei_prozent(pfad: str = "/") -> float | None:
    try:
        s = os.statvfs(pfad)
        return s.f_bavail / s.f_blocks * 100 if s.f_blocks else None
    except OSError:
        return None


def fmt_uptime(seconds: float) -> str:
    s = int(seconds)
    d, h, m = s // 86400, (s % 86400) // 3600, (s % 3600) // 60
    if d:
        return f"{d}d{h}h"
    if h:
        return f"{h}h{m}m"
    return f"{m}m"


# ------------------------------------------------------------------- Felder

def lies_zustand(pfad: str) -> dict:
    """Werte des Analyzers; fehlt die Datei, bleibt alles leer."""
    try:
        with open(pfad, encoding="utf8") as f:
            wert = json.load(f)
        return wert if isinstance(wert, dict) else {}
    except (OSError, ValueError):
        return {}


def oled_fields(z: dict) -> list[tuple[str, str]]:
    """
    Geordnete (Label, Wert)-Paare — die großen Einzelseiten.

    Reihenfolge und Format wie im Original; die vier analyzer-eigenen Felder
    hängen hinten an. Optionale Felder entfallen, wenn es sie nicht gibt.
    """
    benutzt, gesamt = get_mem_mb()
    felder: list[tuple[str, str]] = [
        ("Ver", str(z.get("version", "?"))),
        ("IP", get_ip()),
        ("MAC", get_mac()),
        ("Host", get_hostname()),
        ("CPU", f"{get_temp_c():.0f}C L{get_load():.2f}"),
        ("RAM", f"{benutzt}/{gesamt}MB"),
        ("Status", str(z.get("status", "n/a"))),
        ("Up", fmt_uptime(get_uptime_s())),
    ]
    frei = get_disk_frei_prozent()
    if frei is not None:
        felder.append(("Disk", f"{frei:.0f}% frei"))
    upm = get_fan_rpm()
    if upm is not None:
        felder.append(("Fan", f"{upm}rpm"))

    # --- Werte des Analyzers ------------------------------------------------
    felder.append(("Ort", str(z.get("standort", "n/a"))))
    felder.append(("Tgm", f"{z.get('telegramsPerMinute', 0)}/min"))
    rauschen = z.get("noiseFloor")
    felder.append(("Noise", "n/a" if rauschen is None else f"{rauschen}dBm"))
    felder.append(("Devs", str(z.get("deviceCount", 0))))
    duty = z.get("maxDutyCycle")
    if isinstance(duty, dict):
        felder.append(("Duty", f"{float(duty.get('percent', 0)):.1f}%"))
    return felder


def oled_lines(z: dict) -> list[str]:
    """Die vier Textzeilen der Übersicht (Seite 0) — Aufbau wie im Original."""
    f = dict(oled_fields(z))
    return [
        f"IP {f.get('IP', '')}",
        f"CPU {f.get('CPU', '')}",
        f"RAM {f.get('RAM', '')}",
        f.get("Status", ""),
    ]


def seiten_anzahl(z: dict) -> int:
    """Übersicht (0) plus die großen Einzelseiten."""
    return 1 + len(oled_fields(z))


# ------------------------------------------------------------------ Anzeige

class OledAnzeige:
    """Portierung von `OledStatus` aus Status-LED-OLED."""

    def __init__(self, breite: int, hoehe: int, adresse: int) -> None:
        from board import SCL, SDA
        import busio
        import adafruit_ssd1306
        from PIL import Image, ImageDraw, ImageFont

        i2c = busio.I2C(SCL, SDA)
        self._disp = adafruit_ssd1306.SSD1306_I2C(breite, hoehe, i2c, addr=adresse)
        self._w, self._h = breite, hoehe
        self._img = Image.new("1", (breite, hoehe))
        self._draw = ImageDraw.Draw(self._img)
        self._font = ImageFont.load_default()
        self._ttf = next((p for p in TTF_KANDIDATEN if os.path.exists(p)), None)
        if self._ttf is None:
            print("oled: DejaVu-Schrift fehlt — Paket fonts-dejavu-core "
                  "installieren; bis dahin nur die kleine Schrift",
                  file=sys.stderr, flush=True)
        self._gross: dict[int, object] = {}
        self._disp.fill(0)
        self._disp.show()

    def _fit_font(self, text: str, max_w: int, max_h: int = 24,
                  lo: int = 10, hi: int = 28):
        """Größte TTF-Größe, bei der `text` in max_w × max_h passt (gecacht)."""
        if not self._ttf:
            return self._font
        from PIL import ImageFont
        size = hi
        while size >= lo:
            f = self._gross.get(size)
            if f is None:
                f = ImageFont.truetype(self._ttf, size)
                self._gross[size] = f
            w = self._draw.textlength(text, font=f)
            kasten = f.getbbox(text)
            h = kasten[3] - kasten[1]
            if w <= max_w and h <= max_h:
                return f
            size -= 1
        return self._gross.get(lo, self._font)

    def zeichne(self, z: dict, seite: int) -> None:
        d = self._draw
        d.rectangle((0, 0, self._w, self._h), outline=0, fill=0)
        if seite <= 0:
            for i, text in enumerate(oled_lines(z)):
                d.text((0, -2 + i * 8), text, font=self._font, fill=255)
        else:
            felder = oled_fields(z)
            label, wert = felder[(seite - 1) % len(felder)]
            d.text((0, -2), label, font=self._font, fill=255)
            gross = self._fit_font(wert, self._w - 2, max_h=22)
            d.text((self._w // 2, 20), wert, font=gross, fill=255, anchor="mm")
        self._disp.image(self._img)
        self._disp.show()

    def puffer(self) -> bytes:
        """Framebuffer im SSD1306-Format — für die Vorschau im WebUI."""
        roh = self._img.tobytes()          # 1 Bit je Pixel, zeilenweise
        seiten = self._h // 8
        out = bytearray(self._w * seiten)
        for s in range(seiten):
            for x in range(self._w):
                byte = 0
                for bit in range(8):
                    y = s * 8 + bit
                    index = y * ((self._w + 7) // 8) + (x >> 3)
                    if (roh[index] >> (7 - (x & 7))) & 1:
                        byte |= 1 << bit
                out[s * self._w + x] = byte
        return bytes(out)

    def aus(self) -> None:
        try:
            self._disp.fill(0)
            self._disp.show()
        except Exception:                                     # noqa: BLE001
            pass


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--zustand", default=VORGABE_ZUSTAND)
    ap.add_argument("--bild", default=VORGABE_BILD)
    ap.add_argument("--breite", type=int, default=128)
    ap.add_argument("--hoehe", type=int, default=32)
    ap.add_argument("--adresse", default="0x3c")
    args = ap.parse_args()

    try:
        anzeige = OledAnzeige(args.breite, args.hoehe, int(args.adresse, 16))
    except ImportError as err:
        print(f"oled: Bibliothek fehlt ({err}) — Einrichtung siehe install.sh",
              file=sys.stderr)
        return 1
    except Exception as err:                                  # noqa: BLE001
        print(f"oled: Display nicht erreichbar: {err}", file=sys.stderr)
        if "lgd-nfy" in str(err) or "lgd-nfy" in repr(err):
            # Wiedererkennbarer Fall: lgpio konnte seine Pipes nicht anlegen.
            print("oled: lgpio braucht ein beschreibbares Arbeitsverzeichnis. "
                  "In der Unit muessen WorkingDirectory, HOME und LG_WD auf "
                  "/var/lib/asksin-analyzer zeigen.", file=sys.stderr)
        return 1

    laeuft = True

    def beenden(_sig, _frm) -> None:                          # noqa: ANN001
        nonlocal laeuft
        laeuft = False

    signal.signal(signal.SIGTERM, beenden)
    signal.signal(signal.SIGINT, beenden)

    print(f"oled: {args.breite}x{args.hoehe} an {args.adresse}, "
          f"Zustand {args.zustand}", flush=True)

    letzte = None
    while laeuft:
        z = lies_zustand(args.zustand)
        seite = int(z.get("seite", 0) or 0)
        # Seitenzahl bekanntgeben, damit der Core beim Blättern weiß, wie weit.
        z_seiten = seiten_anzahl(z)
        schluessel = (json.dumps(z, sort_keys=True), seite)
        if schluessel != letzte:
            letzte = schluessel
            try:
                anzeige.zeichne(z, seite)
                Path(args.bild).write_text(
                    json.dumps({
                        "seiten": z_seiten,
                        "hoehe": args.hoehe,
                        "bild": base64.b64encode(anzeige.puffer()).decode("ascii"),
                    }),
                    encoding="ascii",
                )
            except Exception as err:                          # noqa: BLE001
                print(f"oled: {err}", file=sys.stderr, flush=True)
        time.sleep(TAKT_S)

    anzeige.aus()
    return 0


if __name__ == "__main__":
    sys.exit(main())
