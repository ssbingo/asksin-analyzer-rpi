# AskSin-Analyzer

Ein dauerhaft laufender **Funkanalyzer für Homematic (BidCoS, 868 MHz)** auf
Raspberry-Pi-Basis: eine eigene Empfängerplatine hört den Funkverkehr passiv
mit, ein Node.js-Dienst auf dem Pi wertet aus (Duty-Cycle, RSSI,
Telegrammraten), eine Web-UI zeigt an, und ein ioBroker-Adapter spiegelt die
Ergebnisse in die Hausautomation. Mehrere Geräte an verschiedenen Standorten
im Haus sind ausdrücklich vorgesehen.

📖 **[Handbuch (PDF)](docs/handbuch/AskSin-Analyzer-Handbuch.pdf)** — die
anfängertaugliche Schritt-für-Schritt-Anleitung vom Platinenbestellen bis zum
laufenden Gerät.

## Projektstand

| Baustein | Stand |
| --- | --- |
| **Hardware V4** (L-Platine, Pi-Aufsatz) | ✅ fertig entworfen, DRC 0 Verstöße, **in Produktion** |
| Fertigungsdaten (Gerber, BOM, CPL, JLCPCB) | ✅ [`hardware/kicad/fab/`](hardware/kicad/fab/) + Archiv |
| Firmware | ✅ unveränderter `AskSinSniffer328P` (jp112sdl) |
| Core: Parser + Duty-Cycle | ✅ fertig ([`core/`](core/)) |
| Core: Serial-Ingest, SQLite, CCU-Namen, Analyzer | ✅ fertig verdrahtet (M2–M4) |
| Core: REST-API inkl. XS-Kompat-Endpunkten | ✅ fertig, 108 Unit-Tests gesamt (M5) |
| Web-UI (Nachbau, eigener Code, MIT) | ✅ fertig: Vue 3 + ECharts, vom Core ausgeliefert (M5.5) |
| Demo-Modus (simulierte Anlage) | ✅ fertig, Schalter in den Einstellungen (v0.0.3) |
| Update-Pfade (Core-Self-Update, 328P-Flash) | 🔨 als Nächstes (M7.5) |
| Verbund: 5 Analyzer als Gesamtsystem | 📋 geplant (M9, [`docs/verbund.md`](docs/verbund.md)) |
| ioBroker-Adapter | 📋 geplant (M6, mehrinstanzfähig) |

## Installation auf dem Raspberry Pi

Ein Aufruf installiert und konfiguriert alles (Details: [`deploy/README.md`](deploy/README.md)):

```bash
curl -fsSL https://raw.githubusercontent.com/ssbingo/asksin-analyzer-rpi/main/install.sh | sudo bash
```

## Aufbau des Repositories

```
hardware/                 Platine, Bestelllisten, Setup-Skripte
├── README.md             vollständige Hardware-Spezifikation V4
├── bestellliste-reichelt.md
├── setup-uart.sh         richtet den Pi-UART ein (Pi 3/4/5)
├── 99-asksin-analyzer.rules   udev: fester Gerätename
├── datasheets/           Ebyte-E07-Serienspezifikation
└── kicad/                KiCad-9-Projekt, generiert & maschinell geprüft
    ├── generate_*.py     Schaltplan, Layout, Symbole, Footprints, BOM/CPL
    ├── autoroute.py      Freerouting-Anbindung
    ├── fab/              Gerber, Bohrdaten, BOM, CPL, PDFs
    └── AskSin-Analyzer-V3-fertigung.zip   Upload-Paket
core/                     Node.js/TypeScript-Analysedienst
webui/                    Web-UI-Nachbau (Vue 3 + ECharts, MIT)
deploy/                   systemd-Unit, Beispielkonfig, CLI-Wrapper
install.sh / update.sh    Ein-Befehl-Installation und -Update auf dem Pi
docs/
├── serial-protocol.md    das serielle Telegrammformat, verifiziert
├── raspberry-pi-uart.md  UART-Konfiguration Pi 3/4/5
├── webui-und-updates.md  API-Vertrag der Web-UI, Update-Pfade, Lizenzlage
├── verbund.md            Phase M9: fünf Analyzer als Gesamtsystem (Föderation)
└── handbuch/             das Handbuch (HTML-Quelle, Bilder, PDF)
reference/                Originalprojekte (nicht eingecheckt — siehe unten)
```

## Die Kernentscheidungen in einem Absatz

Die Funkseite bleibt beim bewährten Gespann **ATmega328P + CC1101** mit der
unveränderten `AskSinSniffer328P`-Firmware — kein Fork, wer will flasht die
Original-HEX. Die Platine V4 ist ein L-förmiger Aufsatz, der auf den
durchgeschleiften Header des PoE-HAT gesteckt wird; der Körper liegt neben dem
Pi, damit Lüfter und Funkmodul freie Bahn haben. Die Antenne verlässt das
Ebyte-Modul per IPEX — auf der Platine existiert **keine einzige HF-Leitung**.
Der bekannte 2,12-%-Baudratenfehler der 8-MHz-Klasse wird nicht in der
Firmware „repariert", sondern auf der Pi-Seite kompensiert: der Port läuft mit
**58824 Baud** (Details: [`hardware/README.md`](hardware/README.md),
Abschnitt 2.5 — das ist Absicht, nicht Tippfehler). Analyse-Software und
ioBroker-Adapter sind getrennt geschnitten, damit der Adapter frei lizenzierbar
und veröffentlichbar bleibt ([`docs/webui-und-updates.md`](docs/webui-und-updates.md),
Abschnitt 4).

## Schnellzugriffe

- **Platine nachbestellen:** `hardware/kicad/AskSin-Analyzer-V3-fertigung.zip`
  hochladen (4 Lagen, 1,6 mm); SMD-Bestückung mit
  `fab/jlcpcb_bom.csv` + `fab/jlcpcb_cpl.csv`
- **Bauteile kaufen:** [`hardware/bestellliste-reichelt.md`](hardware/bestellliste-reichelt.md)
- **Pi einrichten:** `sudo hardware/setup-uart.sh` → Neustart →
  `stty -F /dev/ttyAMA0 58824 raw -echo && cat -v /dev/ttyAMA0`
- **Core-Tests:** `cd core && npm install && npm run check`

## Versionierung

Ein Repository, drei unabhängige Zählungen über Tag-Präfixe:

| Tag | versioniert | aktuell |
| --- | --- | --- |
| `hardware-vX.Y.Z` | die Platine (Schaltplan, Layout, Fertigungsdaten) | **0.0.1** — steht auch im Bestückungsdruck |
| `core-vX.Y.Z` | die Pi-Software (`core/` + `webui/`, deren `package.json` führen dieselbe Nummer) | **0.0.3** |
| `vX.Y.Z` | den Gesamtstand des Projekts (Doku, Handbuch, Zusammenspiel) | **0.0.3** |

Die **Firmware wird bewusst nicht eigenständig versioniert**: Sie ist
byte-identisch der `AskSinSniffer328P` von jp112sdl (Stand des
AskSinAnalyzer-Repos, Sketch unverändert übernommen). Eine eigene Nummer auf
fremden, unveränderten Code wäre irreführend — sollte je eine Änderung nötig
werden, beginnt ab dann `firmware-v0.0.1`. Der ioBroker-Adapter bekommt ein
eigenes Repository mit eigenständiger Versionierung.

## Changelog

### v0.0.3 — 29.07.2026

Demo-Modus und die Tortengrafik der Startseite. Hardware unverändert (0.0.1).

**Core 0.0.3**
- **Demo-Modus**: simulierte Anlage (~15 Geräte inkl. HmIP, Thermostaten,
  Bewegungsmeldern und einem absichtlich dauersendenden Defekt-Gerät) als
  Port-Generator ganz unten in der Kette — Parser, Statistik, Datenbank,
  API und UI laufen unverändert mit; Geräteliste im originalen
  CCU-Drahtformat; eigene Demo-Datenbank mit kurzer Retention
- Umschalten im laufenden Betrieb über die Weboberfläche
  (Flag-Datei + kontrollierter Dienst-Neustart); `demo`-Feld in
  `/getConfig` und `/api/health`
- 111 Unit-Tests

**Web-UI 0.0.3**
- Übersicht: Tortengrafik **„Telegramme pro Gerät"** wie im Original —
  alle Geräte einzeln, blätterbare Legende, Tooltip mit Name, Anteil,
  Adresse, RSSI und Duty-Cycle
- Schalter **Einstellungen → Demo-Modus** und DEMO-Badge in der Kopfzeile

### v0.0.2 — 29.07.2026

Die Pi-Software ist komplett: vom seriellen Port bis zur Weboberfläche,
installierbar mit einem Befehl. Hardware unverändert (bleibt 0.0.1).

**Core 0.0.2**
- Serial-Ingest: Zeilenstrom-Leser mit Stille-Watchdog (750-ms-Rauschzeilen),
  exponentiellem Reconnect-Backoff und Drop-Oldest-Puffer (M2)
- Persistenz: eingebautes node:sqlite (WAL), Recorder mit Batch-Transaktionen
  und additiven Upserts, Retention + WAL-Checkpoint; LiveStats (M3)
- Namensauflösung: DevListService mit CCU-Polling (stündlich, Fehler-Retry
  5 min) und atomarem Datei-Cache; latin1/XML/HTML-Dekodierung (M4)
- Analyzer-Komposition mit einer Leseschnittstelle `snapshot()` (M4)
- REST-API auf node:http: Kompatibilitäts-Endpunktsatz der originalen
  Web-UI (CSV-Polling, RSSI-Log, Config, DevList, Tages-CSV) plus eigene
  JSON-API `/api/*`; optionaler Bearer-Token, Bind an 127.0.0.1 (M5)
- Dienst-Einstiegspunkt `analyzerd` (JSON-Konfig, journald, sauberes
  Herunterfahren), läuft ohne Buildschritt und ohne Laufzeitabhängigkeiten
- 108 Unit-Tests, alle ohne Hardware

**Web-UI 0.0.2** (neu, MIT)
- Funktionaler Nachbau mit eigenem Code: Vue 3 + Apache ECharts statt
  Vue 2 + Highcharts; Routen wie im Original (/home, /list, /settings, /info)
- Übersicht mit Zeitchart und Duty-Cycle-Top-10, Live-Telegrammliste mit
  Filter, Einstellungen inkl. Token, Info mit Herkunftsnennung
- Wird vom Core selbst ausgeliefert (SPA-Fallback, Asset-Caching)

**Installation**
- `install.sh`: Ein-Befehl-Installation mit Konfigurations-Assistent,
  Node 24, systemd-Dienst (gehärtet), udev-Regel, optionaler
  UART-Einrichtung; Verwaltungsbefehl `asksin-analyzer`, `update.sh`

**Projekt**
- Repository öffentlich; Testdaten durch eine strukturgleiche synthetische
  Beispielanlage ersetzt, Git-Historie bereinigt

### v0.0.1 — 28.07.2026

Erster versionierter Stand.

**Hardware 0.0.1**
- Platine V4: L-förmiger Pi-Aufsatz (118 × 46 mm, 4 Lagen), Arm auf dem
  durchgeschleiften Header des PoE-HAT, Körper seitlich neben Pi und Lüfter
- Funkmodul Ebyte E07-900M10S mit IPEX-Antennenabgang — keine HF-Leitung auf
  der Platine; Zugentlastung für das Antennenkabel (KB1/KB2)
- Reset über GPIO4 (I²C bleibt frei für das OLED des Status-LED-Projekts);
  Anschlüsse für OLED, Taster und WS2812 samt Vorwiderstand an Bord
- vollständig autogeroutet (Freerouting), ERC 0/0, DRC 0 Verstöße
- Fertigungspaket mit Gerber, Bohrdaten, BOM/CPL (auch JLCPCB-Format) und
  Beschriftung (Name, Version, Datum, Copyright, Lizenz) auf beiden Seiten
- Hinweis: die allererste Fertigungscharge entstand vor Einführung der
  Versions-Beschriftung und trägt nur Name + Lizenz

**Core 0.0.1**
- Telegramm-Parser (Format verifiziert gegen Firmware und Referenz-Parser),
  fehlertolerant mit Verwurfszählern
- Duty-Cycle-Berechnung je Absender, gleitendes Stundenfenster, Ringpuffer
- 29 Unit-Tests, `tsc --strict` sauber, keine Laufzeitabhängigkeiten

**Projekt**
- Handbuch (34 Seiten PDF, deutsch, bebildert) inkl. Fuses/Bootloader/Firmware
- Doku: Hardware-Spezifikation, serielles Protokoll, UART-Einrichtung Pi 3/4/5,
  Web-UI-API-Vertrag, Bestelllisten (Reichelt + JLCPCB)

## Referenzprojekte (nicht im Repo)

Die Originalprojekte liegen aus Lizenz- und Größengründen nicht in diesem
Repository. Für die lokale Arbeit (`reference/` wird von `.gitignore`
ausgenommen):

```bash
mkdir -p reference && cd reference
git clone https://github.com/jp112sdl/AskSinAnalyzer.git
git clone https://github.com/jp112sdl/AskSinAnalyzer.wiki.git
git clone https://github.com/psi-4ward/AskSinAnalyzerXS.git
git clone https://github.com/pa-pa/AskSinPP.git
# Platinen-Vorlage V1.1 (der-pw):
cd .. && git clone https://github.com/der-pw/AskSinAnalyzerXS-RPi.git AskSinAnalyzerXS-RPi-main
```

## Verwendete Lizenzen

| Komponente | Lizenz | Urheber |
| --- | --- | --- |
| Hardware, Doku, Core (dieses Repo) | **CC BY-NC-SA 4.0** | © 2026 S. Sternitzke |
| Web-UI (`webui/`, eigener Nachbau ohne Fremdcode) | **MIT** | © 2026 S. Sternitzke |
| Apache ECharts (Diagramme der Web-UI) | Apache-2.0 | Apache Software Foundation |
| Firmware `AskSinSniffer328P` (unverändert übernommen) | CC BY-NC-SA 3.0 | jp112sdl |
| AskSinPP (Bibliothek der Firmware) | CC BY-NC-SA 3.0 | pa-pa |
| AskSinAnalyzerXS (Referenz für Parser/Formeln) | CC BY-NC-SA 4.0 | psi-4ward |
| AskSinAnalyzerXS-RPi (Platinen-Vorlage V1.1) | CC BY-NC-SA 4.0 | der-pw |
| ioBroker-Adapter (eigenes Repo, geplant) | MIT | — |

Details und Begründung der Lizenzwahl: [`LICENSE`](LICENSE) und
[`docs/webui-und-updates.md`](docs/webui-und-updates.md), Abschnitt 4.
