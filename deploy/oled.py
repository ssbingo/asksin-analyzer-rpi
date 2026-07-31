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

# Abtastung der Zustandsdatei. Bewusst kurz: Gezeichnet wird nur, wenn sich
# etwas geaendert hat, also kostet ein schneller Takt fast nichts — aber der
# Tastendruck und der Knopf im WebUI wirken damit ohne spuerbare Verzoegerung.
TAKT_S = 0.1
# Kurzlebige Austauschdateien gehoeren nach /run (tmpfs, Arbeitsspeicher) und
# nicht auf die Platte: Der Zustand wird bei jeder Wertaenderung neu
# geschrieben. Auf einem Pi, der ueber USB von einer SSD bootet, ist das
# unnoetige Dauerlast auf genau der Verbindung, die als Wackelkandidat gilt.
# Fehlt /run/asksin-analyzer, bleibt es beim Datenverzeichnis.
ORTE = (Path("/run/asksin-analyzer"), Path("/var/lib/asksin-analyzer"))


def finde_zustand(vorgabe: str | None = None) -> Path:
    """Wo liegt die Zustandsdatei — jetzt, nicht beim Programmstart?

    Beim ersten Anlauf wurde der Ort einmalig beim Import bestimmt. Startete
    der Dienst, bevor /run/asksin-analyzer existierte, fiel er auf
    /var/lib zurueck und blieb dort — waehrend der Core nach /run schrieb.
    Ergebnis: Der Anzeigedienst las eine Datei, die niemand mehr fuellte, und
    der Core fand keine Seitenzahl. Deshalb wird bei jedem Takt geschaut.
    """
    if vorgabe:
        return Path(vorgabe)
    for ort in ORTE:
        datei = ort / "oled-state.json"
        if datei.exists():
            return datei
    return ORTE[0] / "oled-state.json"


def waehle_bildort(neben: Path) -> Path:
    """Wohin das gezeichnete Bild geschrieben wird.

    Normalerweise neben die Zustandsdatei. Ist das Verzeichnis fuer diesen
    Dienst gesperrt — auf dem Geraet lieferte /run trotz RuntimeDirectory ein
    "Read-only file system" —, weicht die Datei nach /var/lib aus. Der Core
    sucht ohnehin an beiden Orten, die Anzeige laeuft also weiter, statt im
    Sekundentakt dieselbe Fehlermeldung zu wiederholen.
    """
    ziel = neben.with_name("oled-bild.b64")
    if os.access(ziel.parent, os.W_OK):
        return ziel
    ausweich = ORTE[1] / "oled-bild.b64"
    if ausweich.parent != ziel.parent and os.access(ausweich.parent, os.W_OK):
        global _AUSWEICH_GEMELDET
        if not _AUSWEICH_GEMELDET:
            _AUSWEICH_GEMELDET = True
            print(f"oled: {ziel.parent} ist gesperrt — Bild geht nach "
                  f"{ausweich.parent}", flush=True)
        return ausweich
    return ziel


_AUSWEICH_GEMELDET = False

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

    Reihenfolge nach Vorgabe: **Standort zuerst** (die Startseite), danach
    alles zum Analyzer, erst dann die Systemwerte aus dem Original. Format der
    Systemfelder unverändert übernommen.
    """
    benutzt, gesamt = get_mem_mb()
    duty = z.get("maxDutyCycle")
    rauschen = z.get("noiseFloor")

    felder: list[tuple[str, str]] = [
        # --- Startseite ------------------------------------------------------
        ("Standort", str(z.get("standort", "n/a"))),
        # --- Analyzer --------------------------------------------------------
        ("Sniffer", str(z.get("status", "n/a"))),
        ("Telegramme", f"{z.get('telegramsPerMinute', 0)}/min"),
        ("Rauschen", "n/a" if rauschen is None else f"{rauschen}dBm"),
        ("Geräte", str(z.get("deviceCount", 0))),
    ]
    if isinstance(duty, dict):
        felder.append(("Duty-Cycle", f"{float(duty.get('percent', 0)):.1f}%"))

    # Dauersender bekommen je eine eigene Seite: Ein defektes Geraet kann das
    # ganze Funknetz zustopfen, und dann will man am Geraet WELCHES sehen,
    # nicht nur dass irgendetwas hoch ist. Der Name steht als Beschriftung
    # oben, der Prozentwert gross darunter.
    alarme = z.get("dutyAlarme")
    if isinstance(alarme, list):
        for eintrag in alarme:
            if not isinstance(eintrag, dict):
                continue
            name = str(eintrag.get("name", "?"))
            prozent = float(eintrag.get("percent", 0))
            felder.append((f"! {name}", f"{prozent:.0f}%"))

    felder.append(("Version", str(z.get("version", "?"))))

    # --- System (Reihenfolge und Format aus dem Original) --------------------
    felder += [
        ("IP", get_ip()),
        ("MAC", get_mac()),
        ("Host", get_hostname()),
        ("CPU", f"{get_temp_c():.0f}C L{get_load():.2f}"),
        ("RAM", f"{benutzt}/{gesamt}MB"),
        ("Up", fmt_uptime(get_uptime_s())),
    ]
    frei = get_disk_frei_prozent()
    if frei is not None:
        felder.append(("Disk", f"{frei:.0f}% frei"))
    upm = get_fan_rpm()
    if upm is not None:
        felder.append(("Fan", f"{upm}rpm"))
    return felder


def oled_lines(z: dict) -> list[str]:
    """Die vier Textzeilen der Übersicht — Aufbau wie im Original.

    Die Werte kommen bewusst aus `oled_fields`, damit Übersicht und
    Einzelseiten nie auseinanderlaufen. Der Schlüssel der letzten Zeile heisst
    hier **Sniffer** statt „Status" — nach der Umbenennung des Labels blieb die
    Zeile sonst leer, weil der alte Schlüssel ins Leere griff.
    """
    f = dict(oled_fields(z))
    return [
        f"IP {f.get('IP', '')}",
        f"CPU {f.get('CPU', '')}",
        f"RAM {f.get('RAM', '')}",
        f"Sniffer {f.get('Sniffer', '')}",
    ]


def seiten_anzahl(z: dict) -> int:
    """Die großen Einzelseiten plus die Übersicht, die hinten anhängt."""
    return len(oled_fields(z)) + 1


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
        self._klein_cache: dict[int, object] = {}
        self._disp.fill(0)
        self._disp.show()

    def _klein(self, groesse: int):
        """Kleine Schrift in fester Größe — statt der Standardschrift von PIL.

        `ImageFont.load_default()` liefert je nach Pillow-Fassung
        unterschiedlich hohe Glyphen. Mit festem Zeilenabstand führte das dazu,
        dass sich die Zeilen der Übersicht berührten und die Beschriftung in
        den großen Wert hineinragte. Eine angeforderte Größe ist berechenbar.
        """
        if not self._ttf:
            return self._font
        f = self._klein_cache.get(groesse)
        if f is None:
            from PIL import ImageFont
            f = ImageFont.truetype(self._ttf, groesse)
            self._klein_cache[groesse] = f
        return f

    def _kuerzen(self, text: str, font, max_w: int) -> str:
        """Text auf die Breite kürzen — gemessen, nicht nach Zeichenzahl.

        Gerätenamen wie „Defekt_BWM Carport (klemmt)" sind länger als jede
        feste Grenze; abgeschnitten wird deshalb dort, wo es wirklich nicht
        mehr passt, mit einem Auslassungszeichen als Hinweis.
        """
        if self._draw.textlength(text, font=font) <= max_w:
            return text
        gekuerzt = text
        while gekuerzt and self._draw.textlength(gekuerzt + "…", font=font) > max_w:
            gekuerzt = gekuerzt[:-1]
        return (gekuerzt + "…") if gekuerzt else text[:1]

    def _hoehe(self, font, probe: str = "Ag") -> int:
        kasten = self._draw.textbbox((0, 0), probe, font=font)
        return kasten[3] - kasten[1]

    def _fit_font(self, text: str, max_w: int, max_h: int = 24,
                  lo: int = 10, hi: int = 28):
        """Größte TTF-Größe, bei der `text` in max_w × max_h passt (gecacht).

        Unverändert aus Status-LED-OLED übernommen.
        """
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

    def zeichne(self, z: dict, seite: int, meldung: str = "") -> None:
        d = self._draw
        d.rectangle((0, 0, self._w, self._h), outline=0, fill=0)

        if meldung:
            gross = self._fit_font(meldung, self._w - 2, max_h=self._h - 4)
            d.text((self._w // 2, self._h // 2), meldung, font=gross,
                   fill=255, anchor="mm")
            self._zeigen()
            return

        felder = oled_fields(z)
        if seite >= len(felder):
            # Übersicht — vier Zeilen, Abstand aus der tatsächlichen Höhe der
            # Schrift statt fester 8 Pixel. Genau daran lag die Überlagerung.
            zeilen = oled_lines(z)
            # Schriftgröße so wählen, dass ALLE Zeilen hineinpassen. Vorher
            # stand hier eine geschätzte Größe mit festem Mindestabstand —
            # damit rutschte die vierte Zeile unten aus dem Bild.
            klein = self._klein(7)
            for groesse in range(11, 5, -1):
                versuch = self._klein(groesse)
                if self._hoehe(versuch) * len(zeilen) <= self._h - 2:
                    klein = versuch
                    break
            schritt = self._h // len(zeilen)
            hoch = self._hoehe(klein)
            for i, text in enumerate(zeilen):
                # anchor="lt" setzt die OBERKANTE der Glyphen auf y. Ohne das
                # zaehlt PIL von der Grundlinie, und die Unterlaengen der
                # letzten Zeile ragten aus dem Bild.
                y = i * schritt + max(0, (schritt - hoch) // 2)
                d.text((0, y), self._kuerzen(text, klein, self._w - 1),
                       font=klein, fill=255, anchor="lt")
            self._zeigen()
            return

        label, wert = felder[seite]
        # Beschriftung oben, Wert darunter — die Grenze wird **gemessen**,
        # nicht geraten. Vorher stand das Label auf y = -2 und der Wert fest
        # auf y = 20; je nach Schrifthöhe ragte eines ins andere.
        klein = self._klein(max(8, min(11, self._h // 3)))
        label = self._kuerzen(label, klein, self._w - 1)
        kasten = self._draw.textbbox((0, 0), label, font=klein)
        d.text((0, -kasten[1]), label, font=klein, fill=255)
        oben = (kasten[3] - kasten[1]) + 2
        rest = self._h - oben
        gross = self._fit_font(wert, self._w - 2, max_h=max(8, rest - 1))
        d.text((self._w // 2, oben + rest // 2), wert, font=gross,
               fill=255, anchor="mm")
        self._zeigen()

    def _zeigen(self) -> None:
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
    ap.add_argument("--zustand", default="")
    ap.add_argument("--bild", default="")
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

    print(f"oled: {args.breite}x{args.hoehe} an {args.adresse}", flush=True)

    letzte = None
    while laeuft:
        # Ort bei jedem Takt bestimmen: Der Core legt /run erst an, wenn er
        # startet — der Anzeigedienst kann frueher dran sein.
        zustandsdatei = finde_zustand(args.zustand)
        bilddatei = (Path(args.bild) if args.bild
                     else waehle_bildort(zustandsdatei))
        z = lies_zustand(str(zustandsdatei))
        seite = int(z.get("seite", 0) or 0)
        # Seitenzahl bekanntgeben, damit der Core beim Blättern weiß, wie weit.
        z_seiten = seiten_anzahl(z)
        meldung = str(z.get("meldung", "") or "")
        schluessel = (json.dumps(z, sort_keys=True), seite)
        if schluessel != letzte:
            letzte = schluessel
            try:
                anzeige.zeichne(z, seite, meldung)
                bilddatei.write_text(
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
