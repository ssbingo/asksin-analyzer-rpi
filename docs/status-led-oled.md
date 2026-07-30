# Status-LED und OLED am Analyzer (Phase M11)

Anforderung (29.07.2026): Die Funktionen des eigenen Projekts
**Status-LED-OLED** (`ssbingo/Status-LED-OLED`) werden in den Analyzer
**vollständig integriert** — mit Ausnahme der Backup-Funktion. Das bestehende
Repo dient als **Vorlage** (eigenes Repo, Lizenz unkritisch); die Umsetzung
erfolgt komplett hier, nicht als externer Dienst.

## Warum das perfekt passt

Die Analyzer-Platine V4 wurde dafür bereits vorbereitet:

| Stecker | Zweck | Pins |
| --- | --- | --- |
| **J5** | OLED (I²C, SSD1306) | GPIO2/3 — deshalb wurde der Reset auf GPIO4 gelegt |
| **J6** | Taster | zum Blättern der OLED-Seiten |
| **J7** | WS2812-Status-LED | SPI/GPIO10 (R5) **oder** PWM/GPIO18 (R4) — je nach Pi |

## Umfang

**Übernommen aus Status-LED-OLED** (als Vorlage, portiert nach TypeScript
in `core/src/status/` — kein Python, kein zweiter Dienst, weiterhin ohne
Laufzeitabhängigkeiten):

1. **Status-LED** (WS2812 über SPI bzw. GPIO18, analoge RGB als Option):
   Farben/Muster zeigen jetzt den **Analyzer-Zustand** —
   grün = Sniffer verbunden, rot = getrennt, orange = Demo-Modus,
   blau pulsierend = Update verfügbar/läuft, rot blinkend = Duty-Cycle-Alarm
2. **OLED-Anzeige** (I²C, eigener SSD1306-Treiber): durchblätterbare Seiten
   mit Standort + IP, Telegramme/min + Grundrauschen, Duty-Cycle-Spitze,
   Systemwerten (CPU, Temperatur, Speicher) — Taster an J6 blättert
3. **Helligkeit/Nachtmodus** und Konfiguration wie im Vorlagenprojekt

**Ausdrücklich NICHT übernommen:** die restic-Backup-Funktion — sie bleibt
Sache des eigenständigen Status-LED-OLED-Projekts.

## Installation

- Der **Installer fragt**: „Status-LED/OLED einrichten? (j/N)" — bei Ja:
  I²C aktivieren (`raspi-config nonint do_i2c 0`), SPI bei Bedarf,
  Konfigurationsblock schreiben
- Konfiguration in `config.json`:
  `"statusanzeige": { "led": "ws2812" | "aus", "oled": true, "helligkeit": … }`
- Läuft im selben Dienst (analyzerd), gespeist aus `snapshot()` —
  keine zusätzliche Abfrage-Infrastruktur

## Einordnung

Phase **M11**. **Software umgesetzt am 29.07.2026** (`core/src/status/`):
eigener SSD1306-Treiber mit 5×7-Schrift (visuell gegen gerenderte
Framebuffer verifiziert, inkl. Umlauten), WS2812-SPI-Kodierung
(1→110/0→100 bei 2,4 MHz), Prioritätsleiter der LED
(Duty-Cycle-Alarm > getrennt > Persistenzfehler > Demo > Update > ok),
vier OLED-Seiten mit Taster-Blättern (gpiomon, v2/v1) — alles über
injizierbare Kommandos (`i2ctransfer`, `spi-config`) und damit ohne
Hardware getestet. Installer-Frage aktiviert I²C/SPI und die Konfiguration.

**Ergänzt am 29.07.2026 — die Statuswebsite der Vorlage lebt im WebUI
weiter:** Die Übersicht bekommt bei aktiver Anzeige einen Bereich
„Status-LED & OLED" mit LED-Punkt samt Klartext-Grund, Systemwerten
(CPU/Temperatur/RAM/SSD wie im Original-Dashboard), Störungs-Chips je Teil
und einer **pixelgenauen OLED-Live-Vorschau** (der echte Framebuffer,
im Browser gerendert) inklusive Blättern-Knopf. Aktivierung und
Konfiguration (LED, OLED, Helligkeit) gehen **nachträglich über
Einstellungen → Status-LED & OLED** — sofort wirksam, persistiert
dienst-schreibbar; die Installer-Frage bleibt für die Ersteinrichtung
(I²C/SPI). Nur die Backup-Funktion der Vorlage bleibt außen vor.

**Offen: der Hardware-Test**, sobald Platine + Zubehör vorliegen.
Akzeptanz: (a) LED spiegelt die Analyzer-Zustände live, (b) OLED zeigt die
Seiten und der Taster blättert, (c) Installation rein über die
Installer-Frage, (d) Deaktiviert (Vorgabe) verhält sich alles wie bisher.

## Welche Ansteuerung auf welchem Pi

Die WS2812 lässt sich über zwei Wege bedienen. Der Installer wählt anhand des
erkannten Modells vor; in den Einstellungen ist beides umstellbar.

| | **SPI** (GPIO10) | **PWM** (GPIO18) |
| --- | --- | --- |
| Platine | **R5** bestückt | **R4** bestückt |
| Vorgabe auf | **Pi 5** | **Pi 3 und Pi 4** |
| Rechte | läuft im Analyzer-Dienst, ohne Root | Root — eigener Hilfsdienst `asksin-analyzer-led` |
| Onboard-Audio | egal | muss aus (`dtparam=audio=off`) |
| Bibliothek | keine, eigener Bitstrom | `rpi_ws281x` im venv `/opt/asksin-analyzer/led-venv` |

**Warum diese Aufteilung:** Auf **Pi 3 und Pi 4** leitet sich der SPI-Takt vom
Kerntakt ab und wandert mit dessen Skalierung — das zerreißt das
WS2812-Timing (Flackern, Farbsprünge); dort ist PWM der bewährte Weg, so wie
im Vorbildprojekt. Auf dem **Pi 5** hängen die GPIOs am RP1-Chip, die
PWM/DMA-Bibliotheken sprechen aber die alte BCM-Hardware direkt an und
funktionieren dort nicht; SPI ist dort der vorgesehene Weg und der Takt ist
stabil, weil er nicht mehr am Kerntakt hängt.

**Aufteilung im PWM-Betrieb:** Der Analyzer-Dienst bleibt unprivilegiert und
rechnet Farbe, Blinkphase und Helligkeit wie gehabt aus — er schreibt das
Ergebnis nur als `r,g,b` nach `/var/lib/asksin-analyzer/led-farbe`. Der kleine
Root-Dienst [`deploy/led-pwm.py`](../deploy/led-pwm.py) liest die Datei und
setzt die LED. Dasselbe Muster wie bei Update und Netzwerkeinstellungen.

**Die LED ist immer eine WS2812B**, versorgt mit **3,3 V** vom Pi (J7 Pin 1).
Das ist bewusst so: Bei 5 V Versorgung erwartet die LED rund 3,5 V für „High",
die der Pi mit seinen 3,3 V nicht liefert. Mit 3,3-V-Versorgung passt der
Pegel wieder. Der Serienwiderstand in der Datenleitung beträgt 330 Ω (R4
bzw. R5) — genau wie im Vorbildprojekt.
