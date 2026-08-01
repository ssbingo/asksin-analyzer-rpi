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

> ### ⚠️ Platinen mit „HW v0.0.1" im Bestückungsdruck
>
> Bei diesen ist die 2×20-Buchse J1 gespiegelt — direkt aufgesteckt liegt
> jedes Pad auf dem falschen Pi-Pin (5 V auf 3,3 V, Masse auf GPIOs).
> **Nicht ohne den [J1-Rettungsadapter](hardware/kicad/adapter/README.md)
> aufstecken und einschalten.** Mit ihm sind sie voll funktionsfähig.
> Ab **v0.2.0** ist der Fehler behoben, und die Platine liegt neben dem Pi
> statt über dessen Buchsen.

## Projektstand

| Baustein | Stand |
| --- | --- |
| **Hardware v0.2.0** (L-Platine neben dem Pi) | ✅ **in Produktion** (31.07.2026) — DRC/ERC 0/0, 26 Fertigungsprüfungen bestanden |
| Fertigungsdaten (Gerber, BOM, CPL, JLCPCB) | ✅ [`hardware/kicad/fab/`](hardware/kicad/fab/) + Archiv |
| J1-Rettungsadapter für die Chargen v0.0.1 | ✅ [`hardware/kicad/adapter/`](hardware/kicad/adapter/README.md) |
| Firmware | ✅ unveränderter `AskSinSniffer328P` (jp112sdl) |
| Core: Parser + Duty-Cycle | ✅ fertig ([`core/`](core/)) |
| Core: Serial-Ingest, SQLite, CCU-Namen, Analyzer | ✅ fertig verdrahtet (M2–M4) |
| Core: REST-API inkl. XS-Kompat-Endpunkten | ✅ fertig, 108 Unit-Tests gesamt (M5) |
| Web-UI (Nachbau, eigener Code, MIT) | ✅ fertig: Vue 3 + ECharts, vom Core ausgeliefert (M5.5) |
| Demo-Modus (simulierte Anlage) | ✅ fertig, Schalter in den Einstellungen (v0.0.3) |
| Update-Pfade (Core-Self-Update, 328P-Flash) | ✅ fertig (M7.5, v0.0.4) |
| Netzwerkeinstellungen über die Web-UI | ✅ gebaut (M7.6) — Praxistest auf dem Pi ausstehend |
| Status-LED + OLED integriert | ✅ Software fertig (M11) — Hardware-Test steht aus ([`docs/status-led-oled.md`](docs/status-led-oled.md)) |
| Einkaufsführer Zubehör (README + Handbuch) | 📋 geplant (M12, [`docs/einkaufsfuehrer.md`](docs/einkaufsfuehrer.md)) |
| Verbund: 5 Analyzer als Gesamtsystem | ✅ komplett: Dashboard, Matrix+Dedup, Flotten-Update, Langzeitdaten nach InfluxDB (M9.1–M9.5, [`docs/verbund.md`](docs/verbund.md)) |
| Langzeitdaten vor Ort (InfluxDB + Grafana) | ✅ optional auf dem Master: Ein-Klick-Einrichtung, acht fertige Grafana-Ansichten, vier Alarme (M14) |
| Protokoll und Absturzsuche (Tab „Wartung“) | ✅ fertig (M13): Stufen, Tagesrotation, Download, Systemjournal ([`docs/protokoll.md`](docs/protokoll.md)) |
| ioBroker-Adapter | 🔨 Grundgerüst steht (M6, eigenes Repo [`ioBroker.asksinanalyzer-rpi`](https://github.com/ssbingo/ioBroker.asksinanalyzer-rpi), MIT, mehrinstanzfähig) |

## Installation auf dem Raspberry Pi

Ein Aufruf installiert und konfiguriert alles (Details: [`deploy/README.md`](deploy/README.md)):

```bash
curl -fsSL https://raw.githubusercontent.com/ssbingo/asksin-analyzer-rpi/main/install.sh | sudo bash
```

## Aufbau des Repositories

```
hardware/                 Platine, Bestelllisten, Setup-Skripte
├── README.md             vollständige Hardware-Spezifikation
├── bestellliste-reichelt.md
├── setup-uart.sh         richtet den Pi-UART ein (Pi 3/4/5)
├── 99-asksin-analyzer.rules   udev: fester Gerätename
├── 3d-druck/             Druckvorlagen 19″-Einbaurahmen (folgen nach Testdruck)
├── datasheets/           Ebyte-E07-Serienspezifikation
└── kicad/                KiCad-9-Projekt, generiert & maschinell geprüft
    ├── generate_*.py     Schaltplan, Layout, Symbole, Footprints, BOM/CPL
    ├── autoroute.py      Freerouting-Anbindung
    ├── rebuild.py       baut die Platine neu, bis alle Prüfungen sauber sind
    ├── adapter/         J1-Rettungsadapter für die Chargen v0.0.1
    ├── fab/             Gerber, Bohrdaten, BOM, CPL, PDFs
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
├── protokoll.md          Phase M13: Protokoll, Systemjournal, Absturzsuche
├── status-led-oled.md    Phase M11: Status-LED (PWM/SPI) und OLED
└── handbuch/             das Handbuch (HTML-Quelle, Bilder, PDF)
reference/                Originalprojekte (nicht eingecheckt — siehe unten)
```

## Die Kernentscheidungen in einem Absatz

Die Funkseite bleibt beim bewährten Gespann **ATmega328P + CC1101** mit der
unveränderten `AskSinSniffer328P`-Firmware — kein Fork, wer will flasht die
Original-HEX. Die Platine ist ein **L-förmiger** Aufsatz, der auf den
durchgeschleiften Header des PoE-HAT gesteckt wird; der Streifen liegt
**parallel neben dem Pi** an der Header-Seite, höchstens 20 mm breit, und
deckt keine Buchse ab. Der Schenkel steht 32 mm **hinter** der SD-Kante —
dort sitzt das Funkmodul, weit weg vom Störnebel und direkt am rückwärtigen
Antennen-Keystone. Die Antenne verlässt das
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
| `hardware-vX.Y.Z` | die Platine (Schaltplan, Layout, Fertigungsdaten) | **0.2.0** — steht auch im Bestückungsdruck |
| `core-vX.Y.Z` | die Pi-Software (`core/` + `webui/`, deren `package.json` führen dieselbe Nummer) | **0.9.0** |
| `vX.Y.Z` | den Gesamtstand des Projekts (Doku, Handbuch, Zusammenspiel) | **0.9.0** |

Die **Firmware wird bewusst nicht eigenständig versioniert**: Sie ist
byte-identisch der `AskSinSniffer328P` von jp112sdl (Stand des
AskSinAnalyzer-Repos, Sketch unverändert übernommen). Eine eigene Nummer auf
fremden, unveränderten Code wäre irreführend — sollte je eine Änderung nötig
werden, beginnt ab dann `firmware-v0.0.1`. Der ioBroker-Adapter bekommt ein
eigenes Repository mit eigenständiger Versionierung.

## Changelog

### v0.9.0 — 31.07.2026

Die Anzeige am Gerät ist keine Eigenkonstruktion mehr, sondern die des
Vorbilds — mit dessen Bibliotheken, Schriften und Maßen.

**OLED: übernommen statt nachgebaut**
- Gezeichnet wird im eigenen Dienst `asksin-analyzer-oled` mit
  `adafruit_ssd1306`, Pillow und **DejaVuSans-Bold**; die Schriftgröße sucht
  `_fit_font()` je Wert von 28 px abwärts. Der vorherige TypeScript-Nachbau
  mit 5×7-Pixelschrift war am Gerät deutlich schlechter lesbar
- **Bauhöhe 128×32 (Adafruit PiOLED) als Vorgabe**, 128×64 einstellbar.
  Multiplex, COM-Pin-Lage und Seitenbereich folgen ihr — mit den falschen
  Werten zeigt das Panel ein verdoppeltes, unleserliches Bild
- Init-Sequenz an `Adafruit_CircuitPython_SSD1306` angeglichen, inklusive
  `0xad/0x30` (interne Referenzstromquelle; ohne sie bleiben viele
  SSD1315-Nachbauten dunkel)
- Der Core schreibt nur noch Werte nach `oled-state.json`; der Anzeigedienst
  legt den fertigen Framebuffer daneben. **Die Live-Vorschau im WebUI zeigt
  damit das echte Bild vom Gerät**, keinen Nachbau
- Seitenreihenfolge: Standort zuerst, dann der Analyzer, dann die Systemwerte
  des Originals, zuletzt dessen vierzeilige Übersicht
- **Je Gerät ab 80 % Duty-Cycle eine eigene Seite** mit Namen — ein einzelner
  Dauersender kann das Funknetz zustopfen, und dann ist der Name die
  eigentliche Information

**Taster**
- **Langer Druck (5 s) startet den Pi neu**, nach 3 s Vorwarnung „Neustart…"
  auf dem Display. Zeiten aus der Konfiguration des Vorbilds
- Gemessen wird der Pegel (`gpioget`), nicht die Flanke — die Ausgabe von
  `gpiomon` unterscheidet sich zwischen libgpiod 1 und 2
- `--bias=pull-up`: Ohne definierten Ruhepegel blätterte die Anzeige von
  selbst weiter; ohne angeschlossenes Zubehör erzeugte der offene Eingang
  fortlaufend Flanken. Der Taster wird zudem nur überwacht, wenn der
  Anzeigedienst zeichnet, und schaltet sich bei über 50 Flanken je Sekunde ab

**Einrichtung**
- `deploy/oled-einrichten.sh` — einzeln wiederholbar nach einem Fehlschlag.
  Installiert `python3-lgpio` vorab, damit pip lgpio nicht aus dem Quellcode
  baut (scheiterte an fehlendem `swig` bzw. `-llgpio`), legt das venv **mit**
  `--system-site-packages` an und prüft das auch bei vorhandener Umgebung
- Die Unit setzt `WorkingDirectory`, `HOME` und `LG_WD` — lgpio legt sonst
  seine Pipes unter `//.lgd-nfy0` an und bricht ab. Kein `DeviceAllow`: Eine
  solche Zeile hätte über `DevicePolicy=closed` die gpiochip-Knoten gesperrt

**Absturzsuche**
- Die Statusanzeige protokolliert **jede Hardware-Aktion** mit Zeitstempel
  (Stufe „debug"). Bricht die Aufzeichnung mittendrin ab, ist der
  Zusammenhang belegt statt vermutet
- `tools/absturz-bericht.sh` zeigt unsere Protokollzeilen **unmittelbar vor**
  dem Ausfall, nicht mehr den Betrieb danach
- Lüfterdrehzahl aus `hwmon` in Diagnose und Anzeige

**Sonstiges**
- Versionsanzeige: `install.sh`/`update.sh` holen jetzt `--tags`, sonst blieb
  der Stand auf dem Pi bei einem alten Tag stehen; `git describe` beschreibt
  gezielt die Projektversion statt eines beliebigen Tags auf demselben Commit
- Tortengrafik: Legende rückt am Telefon unter die Torte statt darüber

### v0.8.0 — 31.07.2026

Der Analyzer sagt jetzt selbst, was ihm fehlt. Anlass war ein Raspberry Pi, der
reproduzierbar ausfiel und danach nicht mehr erreichbar war — ohne Aufzeichnung
ist so etwas nicht zu finden. Dazu die neue Platine (Hardware v0.2.0, unten
eigens beschrieben), die 3D-Druckvorlagen für den 19-Zoll-Einbau und eine
Oberfläche, die auch am Telefon bedienbar ist.

**Protokoll und Wartung (M13)**
- Neuer Reiter **Wartung**: Stufe (`Fehler` / `Info` / `Debug` / `alles`),
  Aufbewahrung in Tagen, Liste der Dateien, Download — alles im Browser
- Eine Datei je Tag (`asksin-JJJJ-MM-TT.log`), feste Spalten, umgeschaltet
  beim ersten Eintrag nach Mitternacht; ältere Dateien räumt die
  Aufbewahrungsfrist ab. Ohne Fremdbibliothek, der Core bleibt
  abhängigkeitsfrei
- Schreibfehler beenden den Dienst **nie** — ein volles Dateisystem wird
  gemerkt und angezeigt, nicht zum Absturz erhoben
- **Systemjournal wird mitgelesen**, damit sich „lag es an uns oder am
  System?" beantworten lässt: Unterspannung, OOM-Killer, USB-Neuanmeldungen,
  Dateisystemfehler, Temperaturnotabschaltung, Kernel-Panik. Nach jedem Start
  wird zusätzlich der **vorherige** Systemlauf zusammengefasst — endete er
  unsauber, steht genau das im Protokoll
- Der Installer schaltet das Journal auf **dauerhaft**; ab Werk ist es auf
  Raspberry Pi OS flüchtig und nach jedem Absturz verloren
- Regelmäßige Selbstdiagnose: Temperatur, Drosselung, Speicher, Laufzeit —
  bei Auffälligkeiten sofort, sonst alle 15 Minuten
- Neu: [`tools/absturz-bericht.sh`](tools/absturz-bericht.sh) sammelt nach
  einem Ausfall alles Relevante ein und gibt eine Einschätzung aus

**Status-LED**
- Die Ansteuerung richtet sich nach der Pi-Generation: **PWM (GPIO18)** auf
  Pi 3/4, **SPI (GPIO10)** auf Pi 5. Auf Pi 3/4 leitet sich der SPI-Takt vom
  Kerntakt ab und wandert mit dessen Skalierung — das zerreißt das
  WS2812-Timing
- PWM/DMA braucht Root, der Analyzer läuft unprivilegiert: Der Core rechnet
  die Farbe aus, der kleine Dienst `asksin-analyzer-led` setzt sie
- Auf dem Pi 5 ist der PWM-Weg **dreifach gesperrt**. Hinter dem RP1 liegt die
  Peripherie anderswo, während `rpi_ws281x` die alte Speicherlage anspricht;
  im ungünstigen Fall schreibt ein DMA-Kanal in fremden Speicher

**Betrieb**
- **Der Dienst startete auf Port 80 nicht** (`listen EACCES`). Behoben mit
  `AmbientCapabilities=CAP_NET_BIND_SERVICE`; scheitert der Start dennoch,
  erklärt der Dienst den Grund im Klartext statt mit einem Stapelabzug
- Der Einrichtungsassistent ist in nummerierte Abschnitte gegliedert — die
  Frage nach dem Port las sich vorher, als sei die CCU gemeint

**Weboberfläche**
- **Am Telefon und Tablet nutzbar.** Die Oberfläche enthielt bis dahin keine
  einzige Media Query: Die Kopfzeile lief über, breite Tabellen schoben die
  Seite zur Seite, iOS zoomte beim Antippen eines Feldes hinein. Die
  Navigation bekommt eine eigene, scrollbare Zeile; breite Tabellen scrollen
  im Panel, **ohne** eine Spalte auszublenden; Fingerbedienung hängt an
  `pointer: coarse`, nicht an der Fensterbreite. Die Schriftgröße bleibt
- Token-Felder haben einen Umschalter **anzeigen / verbergen** (Auge), damit
  sich ein Tippfehler prüfen lässt. Liegt die Eingabe offen, ist der Knopf
  farblich hervorgehoben

**Hardware und Fertigung** (Platine selbst siehe *Hardware v0.2.0*)
- Die drei Peripheriestecker tragen ihre Funktion im Bestückungsdruck:
  **OLED I2C**, **TASTER**, **WS2812**
- Neu: `hardware/kicad/pruefe_fertigung.py` — 30 maschinelle Prüfungen von den
  Lagen über die Einbaumaße und die J1-Geometrie bis zum Abgleich von BOM und
  CPL gegen die Platine. Unbestückte Plätze werden aus dem Schaltplan
  abgeleitet statt von Hand gepflegt; genau eine handgepflegte Liste hatte
  zuvor R4 aus der Bestückung geworfen

**Einbau**
- 3D-Druckvorlagen für den 19-Zoll-Rahmen (Front-Einsatz je für Pi 4 und
  Pi 5, SSD-Einsatz), Herkunft und Lizenz der Remixe dokumentiert
- J1-Adapter für die fehlerhafte Charge der Hardware v0.0.1 mit eigenem
  Fertigungspaket

### Hardware v0.2.0 — 30.07.2026

**J1 war gespiegelt.** Der Footprint kam aus der offiziellen Vorlage
`RaspberryPi-HAT`, aber ohne deren Flip auf die Unterseite: Die ungerade
Pinreihe saß richtig, die gerade 2,54 mm daneben. Aufgesteckt landet jedes
Pad einen Pin daneben. Betroffen sind **alle bisher gefertigten Platinen**;
sie laufen mit dem [J1-Adapter](hardware/kicad/adapter/README.md) einwandfrei.
`generate_pcb.py` prüft die Padgeometrie jetzt bei jedem Lauf gegen das
Pi-Raster.

**Status-LED D1 war verpolt.** Kathode an R1, Anode an Masse — die Firmware
treibt ihren Pin aktiv auf HIGH, der Strom hätte gegen die Diodenrichtung
fließen müssen. Die LED konnte nie leuchten. Betrifft ebenfalls alle bisher
gefertigten Platinen; rein kosmetisch, der Funkempfang war nie beeinträchtigt.

**Neue Bauform:** L-förmig, 100 × 76 mm. Der Streifen (100 × 20 mm) liegt
parallel neben dem Pi an der Header-Seite und ist **höchstens 20 mm breit**;
der Schenkel steht **32 mm hinter der SD-Kante**. Über dem Pi liegt nur der
8 mm tiefe Arm für die 2×20-Buchse und eine 7 × 9 mm große Nase am hinteren
Befestigungsloch — der Lüfter des PoE-HAT bleibt frei. Nach vorn endet die
Platine 17 mm **vor** dem Pi, damit sie den Keystone-Modulen im 19-Zoll-Einbau
nicht in die Quere kommt. Das Funkmodul sitzt im Schenkel (Antennen-Keystone),
die Peripheriestecker an der Frontkante (OLED-/LED-/Taster-Einsatz).

**Umschalter statt Bestückungsvariante:** Der SMD-Schiebeschalter **SW1** an
der Außenkante wählt zwischen PWM (GPIO18) und SPI (GPIO10) für die
WS2812-Datenleitung; dahinter liegt ein gemeinsamer 330-Ω-Widerstand. Die
frühere Regel „R4 **oder** R5 bestücken" entfällt — der Bestückungsdruck ist
mit **PWM** und **SPI** beschriftet.

Routing-Kette überarbeitet: Masseflächen nur noch auf den Innenlagen, jedes
SMD-Massepad bekommt sein Stützvia vor dem Routen, alle Vias getentet, und
`rebuild.py` baut so lange neu, bis DRC 0/0 und Netzliste exakt sind.

### v0.0.7 — 29.07.2026

Langzeitdaten (M9.5) — der Verbund ist komplett. Hardware unverändert (0.0.1).

### Langzeitdaten: extern oder vor Ort

Zwei Wege, die sich nicht ausschliessen:

**Extern** (unverändert) — jeder Analyzer schreibt seine Kennzahlen in eine
vorhandene InfluxDB v2, etwa auf einem Server oder NAS. Einzustellen unter
*Einstellungen → Langzeitdaten*.

**Vor Ort** (neu, optional) — InfluxDB und Grafana laufen auf dem Analyzer
selbst. Nur auf dem **Master** und nur ab **Raspberry Pi 4 mit 2 GB**; beides
wird geprüft, auf schwächerer Hardware erscheint die Option gar nicht. Ein
Klick unter *Einstellungen → Langzeitdaten vor Ort*, oder gleich beim
Einrichten — der Installer fragt danach.

Mitgeliefert werden **acht Grafana-Ansichten** (Leitstand, Funkqualität,
Duty-Cycle-Wächter, Gerätedetail, Störungssuche, Batteriewächter,
Verbund-Vergleich, Gerätezustand) und **vier Alarme** (Analyzer offline,
Duty-Cycle über 80 %, Gerät seit 24 h stumm, Grundrauschen erhöht). Die
Dashboards liegen als JSON unter [`deploy/grafana/dashboards/`](deploy/grafana/dashboards/)
und lassen sich auch in ein bestehendes Grafana importieren.

Platzbedarf: rund 5–10 MB je Tag und Analyzer, also etwa 10–15 GB im Jahr bei
fünf Geräten. Aufbewahrt wird zwei Jahre.

**Core/Web-UI 0.0.7**
- **Langzeitdaten nach InfluxDB v2**: jeder Analyzer schreibt dezentral
  mit `standort`-Tag per Line Protocol (ohne Client-Bibliothek);
  Measurements `analyzer` (Verbindung, Telegramme/min, Grundrauschen,
  Geräte) und `geraet` (RSSI, Duty-Cycle je Funkgerät) — Grafana wertet
  zentral über alle Standorte aus
- Konfiguration über Einstellungen → Langzeitdaten (URL, Org, Bucket,
  Token — wird nie angezeigt, Intervall), sofort wirksam; Influx-Ausfälle
  stören den Analyzer nicht, die lokale SQLite bleibt primär
- ioBroker-Adapter neu aufgebaut mit @iobroker/create-adapter
  (Tests, Workflows, ESLint/Prettier, i18n in 11 Sprachen,
  Verbund-States, Icon) — eigenes Repo ioBroker.asksinanalyzer-rpi
- 143 Unit-Tests

### v0.0.6 — 29.07.2026

Status-LED und OLED (M11): die Funktionen des Status-LED-OLED-Projekts,
vollständig integriert. Hardware unverändert (0.0.1).

**Core/Web-UI 0.0.6**
- **Status-LED** (WS2812 an J7; seit v0.2.0 wählt der Schalter SW1 zwischen PWM und SPI):
  Prioritätsleiter Duty-Cycle-Alarm (rot schnell) > getrennt (rot) >
  Persistenzfehler (gelb) > Demo (orange) > Update (blau atmend) > ok
  (grün); eigene SPI-Bit-Kodierung, keine native Bibliothek
- **OLED** (SSD1306 an J5, Vorgabe 128×32): gezeichnet vom eigenen Dienst
  `asksin-analyzer-oled` mit **denselben Bibliotheken wie das Vorbild**
  (`adafruit_ssd1306`, Pillow, DejaVuSans-Bold, Schriftgröße je Wert gesucht).
  Seiten: Standort, Sniffer, Telegramme, Rauschen, Geräte, Duty-Cycle,
  **je Dauersender eine eigene Seite**, Version, IP/MAC/Host, CPU/RAM/Up,
  Disk/Fan, Übersicht. Taster an J6: kurz blättert, **5 s startet den Pi neu**
- **Statusseite im WebUI**: LED-Punkt in Echtfarbe mit Grund,
  Systemwerte, Störungs-Diagnose und pixelgenaue OLED-Live-Vorschau
  mit Blättern-Knopf auf der Übersicht
- **Nachträglich aktivierbar ohne Konsole**: Einstellungen →
  Status-LED & OLED (LED/OLED/Helligkeit), sofort wirksam; die
  Backup-Funktion der Vorlage wird bewusst nicht übernommen
- **NTP aufgeräumt**: Konfiguration nur noch in den
  Netzwerkeinstellungen; Vorgabe de.pool.ntp.org, Anzeige des
  tatsächlich verwendeten Servers samt Sync-Status
- 140 Unit-Tests

### v0.0.5 — 29.07.2026

Der Verbund: fünf Analyzer als Gesamtsystem — plus Netzwerkverwaltung
über die Weboberfläche. Hardware unverändert (0.0.1).

**Core/Web-UI 0.0.5**
- **Verbund (M9.1–M9.4)**: Standort-Identität (Badge, Tab-Titel, APIs);
  neue Ansicht „Verbund" mit Kachel je Standort, Zeitdrift-Warnung und
  Drilldown; **Empfangsmatrix Gerät × Standort** (RSSI-Farbskala,
  ★ bester Empfang, CSV-Export); **deduplizierte Telegrammliste** mit
  „gehört von"-Chips (Schlüssel Absender+Zähler+Typ+Länge, ±1,5 s,
  selbstheilend bei Peer-Neustarts); **Flotten-Update** — alle Analyzer
  nacheinander mit Health-Gate, Abbruch statt Domino, Master zuletzt
- **Peers ohne Konsole**: verknüpfen/entfernen unter Einstellungen →
  Verbund, sofort wirksam; Tokens werden nie herausgegeben; Installer
  fragt die Master-Rolle ab und leitet an
- **Netzwerkeinstellungen (M7.6)**: Einstellungen → Netzwerk zeigt den
  Ist-Zustand (inkl. DHCP-Zuweisungen) und ändert DHCP/Statisch,
  statische Werte, Hostname und NTP — mit 90-s-Probezeit und
  automatischem Rollback gegen Aussperren (nmcli/hostnamectl/timesyncd
  über systemd-Path-Unit)
- Doku: Phasen M11 (Status-LED/OLED) und M12 (Einkaufsführer) geplant,
  Platzhalterbild „Produktbild folgt"
- 131 Unit-Tests

### v0.0.4 — 29.07.2026

Update-Pfade (M7.5): Die Software aktualisiert sich selbst — atomar,
rückrollbar und fernsteuerbar. Hardware unverändert (0.0.1).

**Core 0.0.4**
- **Self-Update über die Weboberfläche/API**: `/api/update/versions`,
  `/api/update/core`, `/api/update/status` — der unprivilegierte Dienst
  legt nur eine Trigger-Datei an, eine systemd-Path-Unit startet
  `update.sh` als root (NoNewPrivileges bleibt intakt)
- `update.sh` atomar und rückrollbar: UI-Build nach `dist-neu` mit
  atomarem Tausch, Statusdatei übersteht den Dienst-Neustart,
  Health-Check nach dem Neustart, bei Fehlschlag automatischer Rollback
  von Git-Stand und UI; installiert fehlende Units selbstheilend nach
- **328P-Firmware-Flash** über die API: Intel-HEX-Upload, Ingest pausiert
  und gibt den Port frei, Reset am HAT über GPIO4 (libgpiod v2/v1), am
  USB über DTR, avrdude mit 58 824 Baud; Kommandosequenz injizierbar und
  ohne Hardware getestet
- **Täglicher Selbstcheck** auf neue Versionen (Start + alle 24 h),
  Ergebnis in `/api/health`
- git `safe.directory` für den Dienstbenutzer automatisch gesetzt;
  Versions-Hook meldet Fehler lesbar statt mit 500
- 118 Unit-Tests

**Web-UI 0.0.4**
- Info-Ansicht: Update suchen/installieren mit Live-Fortschritt über den
  Dienst-Neustart hinweg; Firmware-Upload mit avrdude-Log
- Pulsierendes **🔔-Update-Badge** in der Kopfzeile, sobald der
  Selbstcheck eine neue Version meldet — Klick führt zur Info-Seite

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
