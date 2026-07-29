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
| **J7** | WS2812-Status-LED | GPIO18 (R4) oder SPI/GPIO10 (R5, DNP) |

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

Phase **M11**, nach dem Verbund-Kern (M9.3/M9.4) oder parallel dazu, sobald
die Platinen verfügbar sind (J5–J7 sind Hardware-Anschlüsse der V4).
Akzeptanz: (a) LED spiegelt die Analyzer-Zustände live, (b) OLED zeigt die
Seiten und der Taster blättert, (c) Installation rein über die
Installer-Frage, (d) Deaktiviert (Vorgabe) verhält sich alles wie bisher.
