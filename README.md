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
| Firmware | ✅ abgewandelte Fassung des `AskSinSniffer328P` (jp112sdl) — läuft auch ohne Funkmodul und meldet dessen Fehlen, [eigenes Repo](https://github.com/ssbingo/asksin-sniffer-firmware); Prüfwerkzeuge in [`firmware/`](firmware/README.md) |
| Firmware, erweiterte Fassung | 🔨 gebaut, wartet auf die Platine — eigenes Repo [`asksin-sniffer-firmware`](https://github.com/ssbingo/asksin-sniffer-firmware): Versionsauskunft, Folgenummer, Prüfsumme, CC1101-Selbsttest. Im Auslieferungszustand Zeichen für Zeichen wie das Original |
| Mitschnitt der Funkstrecke | ✅ Grundlinie vor Firmware-Änderungen, Schalter unter *Wartung* (F1) |
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
| Bootmedium | SSD ab Pi 4; **der Pi 3 läuft von SD-Karte** (Netzwerk am USB-Bus, nur USB 2.0) |
| CCU-Verbindungstest mit Diagnose | ✅ nennt die Geräteanzahl, unterscheidet sechs Fehlerursachen und blendet bei fehlender Systemvariable die Einrichtung ein ([`ccu/`](ccu/README.md)) |
| Alarmziele: ioBroker, E-Mail, Telegram | ✅ in der WebUI einstellbar, mit Testversand und deutlichen Fehlermeldungen (M14.2) |
| Versionsabhängigkeit Analyzer ↔ Adapter | ✅ beide Seiten weisen sie aus **und prüfen sie** (M15) |
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
  `stty -F /dev/ttyAMA0 57600 raw -echo` — dann die exakte Rate:
  `sudo python3 deploy/baudrate.py /dev/ttyAMA0 58824 && cat -v /dev/ttyAMA0`
  (`stty` kennt nur genormte Raten und lehnt 58824 ab)
- **Core-Tests:** `cd core && npm install && npm run check`

## Versionierung

Ein Repository, drei unabhängige Zählungen über Tag-Präfixe:

| Tag | versioniert | aktuell |
| --- | --- | --- |
| `hardware-vX.Y.Z` | die Platine (Schaltplan, Layout, Fertigungsdaten) | **0.2.0** — steht auch im Bestückungsdruck |
| `core-vX.Y.Z` | die Pi-Software (`core/` + `webui/`, deren `package.json` führen dieselbe Nummer) | **0.18.0** |
| `vX.Y.Z` | den Gesamtstand des Projekts (Doku, Handbuch, Zusammenspiel) | **0.18.0** |

Die **Firmware hat ein eigenes Repository** mit eigener Versionierung:
[ssbingo/asksin-sniffer-firmware](https://github.com/ssbingo/asksin-sniffer-firmware).
Sie war ursprünglich die unveränderte `AskSinSniffer328P` von jp112sdl; seit
den Erweiterungen um Folgenummer, Prüfsumme, Versionsauskunft und
Funkmodul-Selbsttest ist sie eine abgewandelte Fassung und wird als solche
gepflegt — Lizenz unverändert CC BY-NC-SA 3.0. Der ioBroker-Adapter bekommt
ebenfalls ein eigenes Repository mit eigenständiger Versionierung.

## Changelog

### v0.18.0 — 14.08.2026

**Die Selbstheilung aus Firmware 2 hat nicht ausgelöst — und genau das ist
die Auskunft.** Analyzer 01 blieb am 14.08.2026 volle 24 Minuten ohne
Telegramm, während die Rauschzeilen im 750-ms-Takt ungestört weiterliefen.
`empfangErholungen` stand dabei auf **0**: Der Chip war die ganze Zeit auf
Empfang (`MARCSTATE 0x0D`) und lieferte trotzdem nichts.

MARCSTATE allein ist damit zu grob. Es sagt „der Empfänger läuft", nicht „er
hört etwas". Der Registerzugriff war korrekt — AskSinPP liest MARCSTATE an
zwei Stellen genauso —, er misst nur die falsche Sache.

**Firmware 3 meldet deshalb bei Funkstille ihre Lebenszeichen**
(Firmware-Repo `v1.2.0`): `:!RF,…;` nach 60 Sekunden ohne Telegramm, danach
höchstens einmal je Minute, mit vier weiteren Registern des CC1101. Sie
**greift nicht ein** — erst muss feststehen, was der Chip in diesen Minuten
tut. Ein Eingriff auf Verdacht hat in Firmware 2 schon einmal am falschen
Zustand gemessen.

Die Register trennen die möglichen Ursachen:

| Befund | Deutung |
| --- | --- |
| `RXBYTES` > 0 und stehend | Pakete kommen an, niemand holt sie ab — Verdacht auf GDO0 |
| `RXBYTES` 0, `FREQEST` groß | Empfänger steht neben dem Kanal — Verdacht auf Temperaturdrift |
| `RXBYTES` 0, `FREQEST` klein | kein Träger in Reichweite |

Der Analyzer schreibt die Deutung **im Klartext ins Protokoll**, damit sie
niemand im Kopf haben muss:

```
Funkstille seit einer Minute: MARCSTATE 0x0D, Empfangspuffer 0 Byte,
Frequenzablage 3, PKTSTATUS 0x10, LQI 0x7F — kein Traeger in Reichweite.
```

### v0.17.2 — 14.08.2026

**Das Funkmodul lässt sich jetzt bei JLCPCB mitbestücken** — und damit fällt
die anspruchsvollste Lötstelle der Platine weg.

`E07-900M10S`, JLCPCB-Nummer **C9900007000**, Katalogangabe LCC-22,
20,0 × 14,0 mm, Raster 1,27 mm: Maße und Halbloch-Raster stimmen mit unserem
Datenblatt überein, freigegeben für *Economic* und *Standard*. Bisher stand im
Erzeuger der Fertigungsdaten ausdrücklich „nicht im JLCPCB-Katalog"; das gilt
nicht mehr.

- `hardware/kicad/fab/jlcpcb_bom.csv` und `jlcpcb_cpl.csv` enthalten U3.
  JLCPCB übernimmt damit **19 der 24 Bauteile**; von Hand bleiben nur die
  fünf bedrahteten Steckverbinder.
- Fertigungsarchiv neu erzeugt, alle Prüfungen von `pruefe_fertigung.py`
  bestanden. Der Begleittext im Archiv nennt die Position und mahnt die
  Drehlage von U3 an — ein um 180° verdreht bestücktes Modul fällt erst beim
  Flashen auf.
- Zu beachten und dokumentiert: Es ist eine **„JLCPCB Assembly"-Position**
  (nur für PCBA, kein Einzelversand), sie zählt als **Extended**, und
  **Bestand wie Preis sind erst im Bestellportal verbindlich** — die
  Produktseite nennt beides nicht.

**Der Anlass war ein Ausfall.** Am 14.08.2026 ließ sich eine von fünf frisch
gefertigten Platinen nicht programmieren: `target does not answer (0x01)`, bei
jeder Taktrate bis hinunter zu 16 kHz. Ursache war eine Lötbrücke zwischen
Pad 16 (MISO) und Pad 17 (MOSI) des handgelöteten Funkmoduls — benachbarte
Halblöcher im 1,27-mm-Raster. Der Programmierer las dadurch seine eigenen Bits
zurück statt der Antwort des Chips.

Eine Durchgangsprüfung *entlang* der Leitungen findet das nicht; gemessen
werden muss *zwischen* ihnen. **Handbuch 6.2** hat dafür jetzt eine eigene
Prüfung — J2 Pin 1 gegen Pin 4, dort darf kein Durchgang sein — samt der
Erklärung, warum der Fehler so aussieht, wie er aussieht.

### v0.17.1 — 14.08.2026

**Der Firmware-Flash gelang mal beim ersten, mal erst beim zweiten Anlauf.**
Auf Analyzer 01 am 14.08.2026: erster Versuch fehlgeschlagen, zweiter
erfolgreich — gleiche Datei, gleiches Gerät, Bootloader nachweislich
vorhanden. Ein Update, das beim zweiten Mal klappt, ist nicht ausgeliefert.

Die Ursache steht in der Zeitrechnung. urboot lauscht nach dem Reset **genau
eine Sekunde**. Zwischen der fallenden Flanke und dem ersten Sync-Byte lagen
bisher: ein 50-ms-Puls auf HIGH samt Prozessstart, dann der Start von avrdude,
das Öffnen des Ports und das Setzen der Baudrate. Auf einem beschäftigten Pi 5
— inzwischen mit InfluxDB, Verbund und Statusanzeige — reicht das an die
Sekunde heran. Danach redet avrdude mit der laufenden Anwendung statt mit dem
Bootloader.

- **Zwischen Reset und avrdude liegt jetzt nichts mehr.** Der HIGH-Puls, der
  die Flanke für den nächsten Reset vorbereitet, steht davor statt danach; ein
  Test hält fest, dass dort kein Schritt dazwischenrutscht.
- **Drei Anläufe je Protokoll, jeder mit frischem Reset.** Wer das Fenster
  verpasst, dem hilft kein Zuwarten, sondern nur eine neue Flanke.
- Die Leitung wird am Ende wieder auf HIGH gelegt — nach avrdude, wo es
  nichts mehr kostet.

**Und der Befundtext, der uns in die Irre geführt hat, ist korrigiert.** Er
behauptete bei `uP_table does not know mcuid` rundheraus „Auf dem 328P ist
kein Bootloader" und schickte damit zum USBasp. Tatsächlich gibt es zwei
Ursachen, und sie führen an verschiedene Stellen. Der Text nennt jetzt beide
und sagt, woran man sie unterscheidet: sporadisch → verpasstes Zeitfenster,
immer → wirklich kein Bootloader.

### v0.17.0 — 14.08.2026

**Der Empfänger hing, und niemand konnte es sehen.** Analyzer 01 lieferte am
14.08.2026 stundenlang kein einziges Telegramm, während die Rauschzeilen im
750-ms-Takt ungestört weiterliefen. Die Messung war eindeutig: keine
verworfene Zeile, keine verlorene Folgenummer, kein Neustart — die serielle
Strecke war makellos. Nur Pakete kamen keine mehr. Ein Reset des 328P holte
sie sofort zurück.

Das ist die Handschrift eines hängenden CC1101: Das RSSI-Register bleibt
lesbar — daher das ungestörte Rauschen —, aber die Ablaufsteuerung steht nicht
mehr auf Empfang. Ein übergelaufener Empfangspuffer löst sich laut Datenblatt
**nie** von selbst; der Chip bleibt dort, bis jemand `SFRX` schickt. Von
außen war das nicht von einer ruhigen Funkstrecke zu unterscheiden.

**Firmware 2 heilt das selbst** (eigenes Repo, `v1.1.0`): Der ohnehin
laufende 750-ms-Alarm liest zusätzlich `MARCSTATE`. Steht der Chip vier
Abfragen in Folge außerhalb von RX — oder auch nur einmal in
`RXFIFO_OVERFLOW`, das sich nie auflöst —, setzt sie den Empfang neu auf und
meldet den angetroffenen Zustand als `:!RX,…;`. Statt Stunden dauert die
Störung damit unter einer Sekunde, ohne Reset des Mikrocontrollers.

- Der Analyzer versteht die neue Meldung, zählt sie (`empfangErholungen`,
  `letzterEmpfangszustand`) und **schreibt jeden Eingriff ins Protokoll** —
  im Klartext, mit dem angetroffenen Zustand. Ein Gerät, das sich
  stillschweigend selbst heilt, verbirgt einen Hardwarefehler.
- Ebenso im Protokoll: der Neustart der Firmware samt Auskunft des
  Funkmoduls.

**Aufspielen:** *Info → Sniffer-Firmware*, Datei
`asksin-sniffer-firmware/hex/asksin-sniffer.ino.hex`. Das Protokoll bleibt
bei 1 — ältere Analyzer verwerfen die neue Zeile wie jede andere Antwort und
verlieren nichts.

### v0.16.2 — 14.08.2026

**Nach einem Neustart der Firmware lief sie in der einfachen Betriebsart
weiter — und niemand merkte es.**

Der 328P kann neu starten, ohne dass die serielle Verbindung abreißt: beim
Zurücksetzen über GPIO4, nach einem Watchdog, nach einem Spannungseinbruch.
Die Befehle `:?;` und `:E1;` schickte der Core aber nur **einmal je
Verbindung**. Danach kamen keine Folgenummern und keine Prüfsummen mehr —
die Verlusterkennung war still gestorben.

Am 14.08.2026 an Analyzer 01 gemessen: Nach einem Reset stand `Folge: gesehen`
fest auf 76, während `Zeilen` weiterlief.

- Die Startmeldung `:!CC,…;` kommt ungefragt nach jedem Hochlaufen der
  Firmware. Der Core wertet sie jetzt als das aus, was sie ist — „ich bin neu
  gestartet" — und schaltet die Erweiterung erneut frei.
- Neu in den Kennzahlen: **`firmwareNeustarts`**. Steht die Zahl still, lief
  der 328P durch; wächst sie, ist er neu hochgelaufen. Vorher war ein
  Neustart der Firmware von außen überhaupt nicht zu sehen.

### v0.16.1 — 14.08.2026

**Die Übersicht zeigte eine halbe Stunde Telegramme und behauptete drei
Stunden.** Im Diagramm laufen zwei Reihen nebeneinander, und sie waren
unterschiedlich begrenzt: das Grundrauschen nach **Zeit**
(`/api/noise?minutes=180`), die Telegramme nach **Anzahl** — die neuesten 500,
ohne jeden Zeitbezug.

Bei 16 Telegrammen je Minute sind 500 Stück genau 31 Minuten. Das sah aus wie
eine Funkstille bis kurz vor der Gegenwart, war aber nur ein zu kurz geholtes
Fenster: Die Telegramme lagen längst in der Datenbank.

- `/api/telegrams` kennt jetzt **`minutes`** und grenzt damit nach Zeit ein.
  Ohne die Angabe bleibt es beim bisherigen Verhalten — für die
  Telegrammliste ist „die neuesten n" das Richtige.
- Die Übersicht holt beide Reihen über **dieselbe Konstante**, damit sie beim
  nächsten Ändern nicht wieder auseinanderlaufen. Beschnitten wird im Browser
  nach Zeit statt nach Anzahl; sonst schrumpft das Fenster, je mehr gefunkt
  wird.
- Greift die Obergrenze (5000), sagt die Antwort es (`gekuerzt`), und die
  Unterschrift schreibt es dazu. Ein gekürztes Fenster darf nicht aussehen
  wie ein leeres Funkband — genau diese Verwechslung war der Anlass.

### v0.16.0 — 13.08.2026

**Das Speicherleck: sechs vergessene HTTP-Antworten, eine davon im
30-Sekunden-Takt.**

Der Speicher des Dienstes wuchs im Dauerbetrieb gleichmäßig um rund 9 MB je
Stunde — auf Analyzer 01 von 118 auf 379 MB in 70 Stunden, ohne Zusammenhang
mit Last oder Telegrammaufkommen. Gleichmäßig über die Zeit und unabhängig von
der Arbeit: Das passt zu einem Zeittakt und zu nichts sonst.

Die Ursache: Wer eine Antwort holt und ihren Körper nicht liest, gibt sie
nicht frei. Undici hält die Verbindung samt gepuffertem Körper fest, bis er
gelesen oder verworfen wurde. Dem Aufrufer sieht man das nicht an — der Code
wirkt vollständig, es fehlt nur der Satz, der nicht dasteht. Besonders gern
fehlte er im **Fehlerpfad**, wo vor dem Lesen geworfen wurde.

- **`core/src/net/holen.ts`** ist jetzt der einzige Weg nach draußen. Er liest
  den Körper immer zu Ende, auch bei Fehlerstatus, auch wenn der Aufrufer ihn
  nicht braucht. Alle sechs Stellen gehen darüber: InfluxDB (Schreiben und
  Standort-Abfrage), Verbund (Abruf und Kommando), CCU-Geräteliste,
  Adapter-Versionsprüfung, Alarmzustellung.
- **`tools/pruefe-fetch.py`** sorgt dafür, dass daneben kein zweiter entsteht.

**Und der Speicher lässt sich künftig zuordnen, statt ihn zu suchen.** Die
Systemzeile im Protokoll nennt alle 15 Minuten nicht mehr nur den Gesamtwert,
sondern auch Heap, externen Speicher, Puffer und die Zahl offener
Deskriptoren. Damit ist beim Überfliegen zu sehen, *was* wächst — JS-Objekte,
native Puffer oder etwas ausserhalb von Node. Das entscheidet, ob ein
Heap-Schnappschuss überhaupt weiterhilft.

```
Temperatur 47.4 °C · Speicher frei 1255 MB · Last 0.00 · Laufzeit 8.2 h ·
Prozess 186 MB (Heap 61, extern 4, Puffer 2) · 47 Deskriptoren
```

### v0.15.12 — 13.08.2026

**Zwei Fehler aus dem Dauerbetrieb, gefunden im Protokoll von Analyzer 01.**

**Ein Stromausfall machte das Systemprotokoll dauerhaft unlesbar.** Der
Journal-Cursor wird über Dienst-Neustarts hinweg in einer Datei gehalten.
Bricht während des Schreibens der Strom weg, steht dort anschließend die
richtige Länge — aber lauter **Nullbytes**; ext4 hatte die Daten noch nicht
hinausgeschrieben. `String.trim()` entfernt Nullbytes nicht, der Wert kam also
durch bis in die Befehlszeile:

```
The argument 'args[9]' must be a string without null bytes
```

Das stand danach **minütlich** im Protokoll und heilte nie von selbst, weil
derselbe kaputte Wert immer wieder gelesen wurde.

- Der Cursor wird beim Setzen geprüft — druckbares ASCII, sonst verworfen.
- Geschrieben wird jetzt daneben und dann umbenannt. Ein Umbenennen ist
  unteilbar, und ext4 schiebt die Daten dabei vorher hinaus.

**Jedes Herunterfahren endete mit einem Absturzbericht.** systemd schickt
SIGTERM an die ganze Kontrollgruppe, also auch an den WS2812-Helfer. Der Core
schrieb danach noch einen letzten schwarzen Rahmen — in eine Leitung, die
niemand mehr liest. Ein `error`-Ereignis auf einem Strom ohne Zuhörer wird zur
unbehandelten Ausnahme: `Error: write EPIPE`.

- Fehler-Zuhörer ergänzt, und zwar an **allen** Strömen von Kindprozessen.
- **`tools/pruefe-stroeme.py`** hält das künftig fest. Die Prüfung fand
  dabei drei weitere Lücken, die noch niemandem aufgefallen waren — darunter
  die Ströme von `avrdude`: Wäre der mitten im Aufspielen gestorben, hätte er
  den Analyzer mitgerissen und die Platine mit halber Firmware zurückgelassen.

Vor diesem Fehlertyp warnt ein Kommentar in `sttyPort.ts` seit dem 10.08.2026
ausdrücklich. Er hat es nicht verhindert; die Prüfung tut es.

### v0.15.11 — 10.08.2026

**Der Analyzer verwarf jede einzelne Zeile — wegen eines Pluszeichens.** Die
erweiterte Firmware hängt an jede Zeile `+NNNNKK` an: Folgenummer und
Prüfsumme. Die Vorgabe (`docs/protokoll.md` der Firmware) deckt damit „alle
Zeichen von `:` bis einschließlich der letzten Ziffer der Folgenummer" ab —
und das `+` liegt in diesem Bereich. Die Firmware summiert schlicht ihren
Ausgabepuffer, in dem es natürlich steht.

Der Analyzer summierte `:72;` und `02AF` und ließ das `+` aus. Er lag damit
bei **jeder** Zeile um genau 43 daneben, den ASCII-Wert von `+`, und verwarf
ausnahmslos alles mit dem Grund `checksum`.

Sichtbar wurde das erst, als Analyzer 01 sein Funkmodul bekam: Auf der
Leitung lagen Telegramme, in der Weboberfläche kam keines an, und die
Firmware-Kachel zählte `Zeilen geprüft 0`. Vorher gab es schlicht nichts zu
verwerfen.

- Die Summe schließt das `+` jetzt ein.
- **Der Test hatte denselben Irrtum.** Er baute seine Zeilen mit genau der
  Formel, gegen die er prüfte, und war deshalb grün, während am Gerät alles
  durchfiel. Dagegen hilft nur eine Quelle von außen: Sieben **echte,
  am Gerät mitgeschnittene Zeilen** sind jetzt Prüfstein — Rauschen wie
  Telegramme, dazu eine absichtlich verfälschte, damit die Prüfung nicht
  bloß abgeschaltet ist.

### v0.15.10 — 10.08.2026

**„LED gestört" bei einwandfrei leuchtender LED.** Der Zustand für die
Weboberfläche wurde als `led === 'ws2812-spi' && keine Fehler` berechnet — der
SPI-Weg stand dort als einzige gültige Betriebsart. Jede PWM-Anlage (Pi 3 und
Pi 4) meldete damit dauerhaft eine Störung, gleichgültig ob die LED leuchtet.

Aufgefallen auf dem Pi 3 in dem Moment, in dem die LED dort zum ersten Mal
lief — vorher gab es keine Gelegenheit, den Widerspruch zu sehen.

- Die Bedingung lautet jetzt `led !== 'aus' && keine Fehler`.
- Zwei Tests halten beide Richtungen fest: PWM und SPI gelten als aktiv,
  `aus` nicht — und nach Fehlversuchen wird die Störung auch wirklich
  gemeldet. Eine Anzeige, die nie anschlägt, ist so wertlos wie eine, die
  immer anschlägt.

### v0.15.9 — 10.08.2026

**Derselbe Fehlertyp noch zweimal, diesmal auf dem PWM-Weg.** Der Core
schreibt die Farbe nach `/run/asksin-analyzer/led-farbe` — er wählt sein
Laufzeitverzeichnis beim Start und nimmt `/var/lib` nur, wenn er in `/run`
nicht schreiben darf. `led-pwm.py` kannte allein diesen Ausweichpfad und
wartete im Normalbetrieb auf eine Datei, die es nie gab. Beide Seiten für
sich fehlerfrei, keine Meldung, dunkle LED.

Dazu: `asksin-analyzer-led.service` deklarierte `RuntimeDirectory=`, läuft
aber als **root** (DMA braucht `/dev/mem`), während die beiden anderen Dienste
als `asksin` laufen. systemd setzt Eigentümer und Rechte eines
`RuntimeDirectory` bei **jedem** Start neu — der Root-Dienst machte das
gemeinsame Austauschverzeichnis damit zu `root:root` und sperrte den Core aus.
Das war der `EACCES` auf `oled-state.json`.

- `led-pwm.py` sucht beide Orte ab, bei jedem Takt neu — `/run` wird beim
  Booten geleert, und die Datei entsteht erst mit der Betriebsart PWM. Findet
  er keine, sagt er es einmal, mit beiden gesuchten Pfaden im Klartext.
- `RuntimeDirectory=` aus dem Root-Dienst entfernt. Angelegt wird das
  Verzeichnis von `asksin-analyzer.service`, auf den er ohnehin wartet.
- **`tools/pruefe-austauschdateien.py`** findet beides künftig ohne Hardware:
  Jeder Helfer, der eine Austauschdatei nutzt, muss `/run` kennen, und kein
  Root-Dienst darf das gemeinsame Verzeichnis in Besitz nehmen. Läuft im
  Prüflauf mit; beide Fälle sind gegengeprüft.

### v0.15.8 — 10.08.2026

**Die Status-LED lief mit 125 MHz statt 2,4 MHz — und blieb deshalb dunkel.**
Der SPI-Takt gehört im Linux-Kern nicht dem Gerät, sondern dem geöffneten
Dateideskriptor: Beim Schließen des letzten Benutzers setzt der Treiber
`speed_hz` auf den Höchstwert des Reglers zurück. Der Core rief `spi-config`
als eigenen Prozess auf — der setzte den Takt und nahm ihn beim Beenden wieder
mit. Geschrieben wurde anschließend mit 125 MHz, also 52-fach zu schnell. Der
komplette Rahmen war nach 0,6 µs durch, die WS2812 sah davon nur einen
Störimpuls.

Von außen war das nicht zu erkennen: Auf der Datenleitung lag ein Signal, die
Verdrahtung war fehlerfrei, `spi-config` meldete keinen Fehler. Gefunden wurde
es erst durch `spi-config -q` bei laufendem Dienst — dort stand
`speed=125000000`.

- **`deploy/ws2812-spi.py`** setzt Takt, Modus und Bitreihenfolge und
  **bleibt offen**, solange die Anzeige läuft. Er liest die Rahmen als Hex je
  Zeile und liest den Takt zurück, statt ihn zu glauben: Weicht er um mehr als
  10 % ab, bricht er mit einer Meldung ab, statt still Falsches zu schreiben.
- **Latch von 213 µs auf 427 µs.** Die alten 64 Nullbytes beriefen sich auf
  die „> 50 µs" der ursprünglichen WS2812B. Die Revision V5 — alles seit etwa
  2020 — verlangt über 280 µs. Der Test rechnet jetzt die Dauer nach, statt
  eine Zahl zu vergleichen.
- **Der Pi 5 kann nicht mehr auf PWM stehen bleiben.** Die Betriebsart kommt
  aus `statusanzeige.json` (Weboberfläche) und **überstimmt** die
  `config.json` — der Installer korrigierte bisher nur letztere. Jetzt fasst
  er beide an, und der Dienst korrigiert es zusätzlich beim Start selbst.

### v0.15.7 — 10.08.2026

**Eine Einstellung, die aussah, als wirke sie, und nichts tat.** Die
Betriebsart der Status-LED lässt sich in der Weboberfläche zwischen SPI und
PWM umstellen. Geschrieben wurde dabei nur die Einstellung — die
Voraussetzungen für PWM schafft bisher ausschließlich der Installer:
`rpi_ws281x`, der Root-Hilfsdienst `asksin-analyzer-led` und abgeschaltetes
Onboard-Audio.

Wer nachträglich umstellte, bekam eine dunkle LED und keine Fehlermeldung: Der
Core schrieb die Farbe korrekt nach `/run/asksin-analyzer/led-farbe`, und es
las sie niemand.

- Der Analyzer prüft jetzt einmal je Minute, ob der Hilfsdienst läuft, und
  meldet ihn — einmal, nicht dauernd — mit dem Befehl zum Nachholen.
- **`deploy/led-pwm-einrichten.sh`** holt die Einrichtung nach: Onboard-Audio
  abschalten, `rpi_ws281x` installieren, Hilfsdienst aktivieren. Es sagt am
  Ende, ob ein Neustart nötig ist und dass SW1 auf PWM stehen muss.
- Handbuch 18 beschreibt den Fall.

### v0.15.6 — 10.08.2026

**Der Taster war nach jedem Neustart tot — bauartbedingt.** Er wird nur
abonniert, wenn der Anzeigedienst wirklich zeichnet; das ist richtig, denn
GPIO17 hat ohne angeschlossenen Taster keinen Ruhepegel und liefert aus
Einstreuung fortlaufend Flanken.

Falsch war, diese Bedingung **einmalig beim Start** zu prüfen. Die Bilddatei
liegt in `/run/asksin-analyzer` — einem tmpfs, das nach jedem Systemstart leer
ist — und der Anzeigedienst startet laut seiner Unit `After=asksin-analyzer`.
Beim Start des Analyzers *kann* die Datei also gar nicht da sein. Geholfen hat
nur ein Neustart des Analyzers von Hand, nachdem der Anzeigedienst gezeichnet
hatte.

Der OLED-Takt zieht die Prüfung jetzt alle 500 ms nach: Sobald das Bild da
ist, kommt der Taster; verstummt der Dienst, wird das Abonnement wieder
gelöst. Der Grund steht weiterhin im Journal, aber nur einmal statt zweimal
pro Sekunde.

### v0.15.5 — 10.08.2026

**Der Befund stand nur im Rückgabewert, nicht im angezeigten Verlauf.** Der
Analyzer erkennt `not in sync: resp=0x3a` und weiß, dass das kein
Übertragungsproblem ist, sondern ein fehlender Bootloader — die Erklärung
erreichte den Anwender aber nicht. Die Oberfläche zeigt den mitlaufenden
Verlauf, und dorthin wurde die Deutung nie geschrieben. Man sah die rohe
avrdude-Meldung und musste selbst wissen, was `0x3a` bedeutet.

Zusätzlich erkannt: `uP_table does not know mcuid …`. Auch das heißt „kein
Bootloader" — avrdude deutet die laufende Ausgabe des Sniffers als Antwort und
errechnet daraus eine Kennung, die es nicht gibt.

Beide Befunde verweisen jetzt auf Handbuch 7.7 und auf
`deploy/bootloader-brennen.sh`.

### v0.15.4 — 10.08.2026

Der Weg zum Bootloader ist jetzt dokumentiert und wiederholbar — er war die
eigentliche Erkenntnis des Tages und stand bisher nirgends.

- **Handbuch 7.7** *Die richtige Reihenfolge*: Bootloader **einmal** über den
  USBasp, Firmware **danach immer** über die Weboberfläche. Mit der
  Begründung, warum ein Programmer-Upload den Bootloader gleich zweifach
  unbrauchbar macht — er löscht ihn (avrdude ohne `-D`) **und** lässt den
  Reset-Vektor ungebogen, den nur `urclock` umbiegt.
- **`deploy/bootloader-brennen.sh`**: brennt urboot vom Pi aus, ohne PC.
  Prüft vorher, ob die Datei überhaupt in den Bootbereich gehört — eine
  verwechselte Firmware würde den Chip sonst leeren und nichts Brauchbares
  hinterlassen. Liest die Fuses mit und sagt am Ende, wie es weitergeht.

urboot selbst wird **nicht** mitgeliefert: Es steht unter der GPL und gehört
seinem Urheber (Stefan Rueger). Das Skript nimmt die Datei aus der
Arduino-Installation als Argument entgegen.

### v0.15.3 — 10.08.2026

**Der Firmware-Flash über die Weboberfläche funktioniert.** Es brauchte zwei
Bedingungen, nicht eine — und beide wurden an echter Hardware durchgemessen,
mit verifiziertem urboot im Flash:

| Baudrate | Reset zuerst, dann avrdude |
| --- | --- |
| 115200 | kein Sync |
| **57600** | **Sync** |
| **19200** | **Sync** |

**Erstens: erst zurücksetzen, dann `avrdude` starten.** urboot betritt seine
Programmierschleife ausschließlich nach einem **externen** Reset (`sbrs r2, 1`
auf `MCUSR`, Bit 1 = `EXTRF`) und löscht `MCUSR` dabei — danach lauscht er
genau eine Sekunde und ist ohne neuen Reset nie wieder erreichbar. In dieser
Sekunde misst er die Baudrate an der **ersten LOW-Phase** auf der Leitung.
Läuft `avrdude` schon und sendet, fällt der Reset mitten in ein Byte, die
Messung geht daneben, und es bleibt bei „not in sync".

Das war der Fehler in v0.14.6: Dort hatte ich die Reihenfolge umgedreht, weil
ich Optiboot vor mir sah — das kennt kein Autobaud und ist gegen einen
laufenden `avrdude` gleichgültig. Gegen urboot ist es der Unterschied zwischen
„geht" und „geht nie".

**Zweitens: 57600 Baud statt der krummen 58 824.** urboot misst selbst, die
Rate muss also nicht zur Firmware passen — bei 8 MHz ist 115200 aber zu
schnell für seine Zählschleife. 57600 ist genormt, passt zusätzlich zu einem
alten Optiboot (2,1 % Abweichung, innerhalb der Toleranz) und braucht keinen
Umweg über `termios2`.

Der Reset-Impuls ist außerdem von 300 auf 50 ms verkürzt: Er entsteht an der
Flanke, die Haltezeit geht nur vom Ein-Sekunden-Fenster ab.

### v0.15.2 — 10.08.2026

**MiniCore schreibt seit Fassung 3 kein Optiboot mehr, sondern urboot** — und
das spricht `urclock` statt STK500v1. In `boards.txt` steht es ausdrücklich:

```text
328.menu.bootloader.uart0.upload.protocol=urclock
...bootloader.file=urboot/…/autobaud/…/urboot_atmega328p_pr_ee_ce.hex
```

Unser `avrdude` lief mit `-c arduino`. Die beiden redeten aneinander vorbei,
und zwar völlig gleichmäßig: An **beiden** Analyzern zehnmal hintereinander
`not in sync: resp=0xa0`. Ein Übertragungsproblem sieht anders aus — dort
wären die Antworten unterschiedlich. Genau diese Gleichmäßigkeit war der
Hinweis.

Der Flash versucht jetzt `urclock` zuerst und `arduino` danach, damit auch
ältere Platinen mit Optiboot bedient werden. Der Analyzer deutet `resp=0xa0`
außerdem selbst und nennt Ursache und Ausweg.

Handbuch 7.5 berichtigt: Dort stand Optiboot; 7.6 kennt das Fehlerbild.

### v0.15.1 — 10.08.2026

Zwei Sperren, aus denen nur der Erfolgsfall herausführte.

**Eine hängengebliebene Update-Sperre ließ sich nur von Hand lösen.**
`update.sh` schreibt `running: true` in die Statusdatei. Wird das Update hart
abgebrochen — abgeschossener Dienst, Stromausfall, Neustart mitten im Lauf —
bleibt der Eintrag stehen, und die Weboberfläche antwortet von da an dauerhaft
mit `HTTP 409`. Herausgeholfen hat nur das Löschen der Datei über die Konsole.

Ein Update, das seit einer halben Stunde keinen Schritt gemeldet hat, gilt
jetzt als steckengeblieben; die Sperre wird dann aufgehoben und der Vorgang
protokolliert. `update.sh` frischt seine Zeitmarke bei jedem Schritt auf, die
Grenze ist also großzügig.

**`systemctl restart` sah aus, als reagiere nichts.** Die Unit hatte kein
`TimeoutStopSec`, also galt die Voreinstellung von **90 Sekunden**: So lange
wartet systemd nach `SIGTERM`, bevor es `SIGKILL` nachschiebt.

Der Anlass war der blockierende `read()` aus v0.15.0. Die Grenze bleibt
trotzdem: Ein Dienst, der sich verhakt, darf niemanden anderthalb Minuten
warten lassen. Zwanzig Sekunden sind für ein geordnetes Herunterfahren um
Größenordnungen mehr als nötig.

Wer noch auf einer älteren Fassung festhängt, kommt so heraus:

```bash
sudo systemctl kill -s KILL asksin-analyzer
sudo systemctl start asksin-analyzer
```

### v0.15.0 — 10.08.2026

**Der serielle Port wird jetzt über einen Kindprozess gelesen, nicht über
einen Dateistrom.** Das ist die Wurzel von allem, was seit v0.14.1 geflickt
wurde — und der Grund, warum jede Reparatur nur das nächste Symptom freilegte.

`fs.createReadStream` auf einer seriellen Schnittstelle lässt sich **nicht
unterbrechen**: Der `read()` hängt im Thread-Pool von libuv, `destroy()` weckt
ihn nicht, kein Abbruchsignal erreicht ihn. An einer stillen Leitung — der
Normalfall — bleibt er dort liegen. Daraus folgte alles auf einmal:

| Symptom | Fassung |
| --- | --- |
| Flash blieb bei „Ingest wird angehalten" stehen | v0.14.1 gab `close()` eine Frist |
| `stop()` hing trotzdem | v0.14.5 gab der Leseschleife ein Abbruchsignal |
| Dienst ließ sich nicht neu starten | der verwaiste `read()` hielt den Prozess |
| `not in sync: resp=0xa0` | der verwaiste Leser nahm avrdude die Antwort des Bootloaders weg |

Die letzten beiden traten auf **beiden** Geräten identisch auf — ein Wettlauf
sähe erratisch aus, gleiches Verhalten heißt gleiche Ursache.

Ein Kindprozess löst es an der Wurzel: Seine Standardausgabe ist eine Pipe,
und Pipes sind vollständig asynchron. Beim Beenden räumt das Betriebssystem
den hängenden `read()` und den Dateideskriptor auf — es gibt nichts mehr,
worauf man vergeblich warten könnte. Es kommt keine Abhängigkeit dazu; `cat`
ist ein Bordwerkzeug, und genau so liefen alle erfolgreichen Handmessungen.

Tests laufen gegen eine echte benannte Pipe und ein echtes `cat`. Die
Gegenprobe zeigt den Unterschied: Der Dateistrom meldet nach `destroy()` kein
`close`, der Kindprozess ist in rund 100 ms weg.

### v0.14.6 — 10.08.2026

**Der Reset kam zu früh — Optiboot lauscht nur eine Sekunde.** Die alte Folge
setzte erst zurück und startete dann `avrdude`. Bis der den Port geöffnet und
die krumme Baudrate über `termios2` gesetzt hatte, war das Fenster zu:
`not in sync: resp=0x00`, niemand antwortet mehr.

Jetzt läuft `avrdude` **zuerst** und der Reset fällt hinein. Damit gibt es
keinen Wettlauf mehr: `avrdude` wiederholt den Sync zehnmal über mehrere
Sekunden, und einer dieser Versuche trifft das Fenster. Das ist der übliche
Weg für Platinen ohne DTR-Leitung.

Nebenwirkung, die richtiggestellt wurde: Der Ausgang hängt jetzt an `avrdude`,
nicht am Zustand der GPIO-Leitung. Lässt sich die Leitung nach dem Impuls
nicht zurückziehen, ist das ein **Hinweis** — die Firmware kann längst
geschrieben sein, und „fehlgeschlagen" wäre schlicht falsch.

### v0.14.5 — 10.08.2026

**Der Flash blieb weiterhin hängen — meine Reparatur aus v0.14.1 saß an der
falschen Stelle.** Dort hat `close()` eine Zeitgrenze bekommen. Die eigentliche
Blockade lag eine Zeile tiefer: `for await (const chunk of stream.readable)`
endet erst, wenn der Strom endet. Gibt `close()` auf, ohne dass der hängende
`read()` zurückkehrt, läuft die Schleife weiter und `stop()` wartet trotzdem
für immer.

Die Leseschleife hört jetzt auf ein eigenes Abbruchsignal, unabhängig davon,
ob der Strom sich schließen lässt. Zusätzlich wartet auch der Verbindungs-
Aufbau nicht mehr unbegrenzt auf ein fremdes `close()` — der Ingest verlässt
sich nicht mehr darauf, dass eine Port-Umsetzung zurückkehrt.

Beides mit Test: ein Strom, der nie etwas liefert und sich nicht schließen
lässt. Gegenprobe ohne Abbruchsignal — der Test hängt bis zur Schranke.

### v0.14.4 — 10.08.2026

**Berichtigung:** Das Handbuch behauptete, *Hochladen mit Programmer* lasse
den Bootloader unversehrt. Das ist falsch. Die Arduino IDE ruft `avrdude`
ohne `-D` auf — und `-D` schaltet das automatische Löschen *ab*, ist also die
Voreinstellung. Der Chip wird vollständig gelöscht, Bootloader eingeschlossen.
Ein ausgeschriebenes `-e` steht nirgends; wer danach sucht, findet nichts und
schließt das Falsche. Genau das war passiert.

Folge: Nach einem Programmer-Upload lässt sich die Firmware **nicht mehr über
die Weboberfläche** aufspielen. Das Fehlerbild ist `not in sync: resp=0x3a` —
und `0x3a` ist das Zeichen `:`, also die laufende Ausgabe des Sniffers statt
einer Antwort des Bootloaders.

Der Analyzer deutet diese Meldung jetzt selbst und nennt Ursache und Ausweg,
statt die rohe avrdude-Ausgabe stehenzulassen. Handbuch 8.2 ist berichtigt und
nennt die richtige Reihenfolge; 7.6 kennt das Fehlerbild.

### v0.14.3 — 10.08.2026

**Die Versionsfrage ging nie hinaus, wenn keine Zeile deutbar war.** Ein
Henne-Ei-Fehler: Die Frage hing an der ersten *gültigen* Zeile. Fehlt das
Funkmodul, liest der SPI-Bus 0x00 oder 0xFF, der Pegel jeder Rauschzeile wird
unplausibel, und der Parser verwirft sie zu Recht — restlos alle. Also wurde
nie gefragt, und ausgerechnet die Auskunft `:!CC,--;`, die das fehlende
Funkmodul benennt, kam nie zustande.

Der Analyzer konnte genau dann nicht fragen, wenn die Antwort am wichtigsten
gewesen wäre.

Das erklärt auch, warum zwei baugleiche Geräte Unterschiedliches meldeten: Das
eine hatte genau **eine** Rauschzeile, die durchkam, und zeigte prompt die
richtige Fassung; das andere hatte null. An diesem Zufall hing die ganze
Anzeige — ein Unterschied in der Firmware bestand nie.

Die Frage hängt jetzt an der ersten Zeile überhaupt, einmal je Sitzung.

### v0.14.2 — 10.08.2026

**Der Analyzer behauptete „Originalfassung", bevor er es wissen konnte.**
Nach einem Dienst-Neustart stand sofort da, es laufe die Originalfirmware;
nach einem Kaltstart stimmte die Anzeige wieder. An der Firmware hatte sich
nichts geändert — nur die vergangene Zeit war eine andere.

`baueFirmwarebefund(null, …)` lieferte unbesehen `original`. Damit war „noch
keine Antwort da" nicht von „es kommt keine" zu unterscheiden. Der Ingest
merkt sich jetzt, wann die Versionsfrage hinausging; der Befund kennt eine
dritte Lage `unbekannt` und wird erst nach drei Sekunden ohne Antwort zur
Auskunft. Die Firmware antwortet in Millisekunden — die Frist ist um
Größenordnungen großzügig.

Damit lässt sich erstmals unterscheiden, ob die Firmware wirklich schweigt
oder die Anzeige nur zu früh urteilt.

### v0.14.1 — 10.08.2026

Zwei Fehler, die erst der erste Firmware-Flash über die Weboberfläche
sichtbar gemacht hat — an zwei Geräten gleichzeitig.

- **Der Flash legte den Dienst lahm.** Im Journal stand „Ingest wird
  angehalten", danach über Stunden nichts. `close()` wartete auf das
  `close`-Ereignis des Lesestroms; `destroy()` beendet den aber nicht, solange
  im Thread-Pool ein blockierendes `read()` auf der seriellen Schnittstelle
  hängt — ohne eingehende Zeichen der Normalfall. Zum Flashen kam es nie.
  `schliesseStrom()` gibt jetzt nach zwei Sekunden auf.
- **Der Flash zeigte keinen Fortschritt.** Er lief in einem einzigen
  HTTP-Aufruf; die Oberfläche schrieb „Flashe …" und wartete bis zum Schluss.
  Jetzt startet `POST /api/update/firmware` nur noch und kehrt sofort zurück,
  `GET /api/update/firmware/stand` liefert den Verlauf — mit dem
  Fortschrittsbalken von `avrdude`.

Nebenbei berichtigt: Die Oberfläche nannte als Beispieldatei noch
`AskSinSniffer328P.hex` und behauptete, im Demo-Modus sei der Flash nicht
verfügbar. Der Code sagt ausdrücklich das Gegenteil.

### v0.14.0 — 09.08.2026

**Die erste Platine läuft.** Analyzer 05 empfängt seit heute echte Zeilen —
davor lief jedes Gerät im Demo-Modus. Dabei kamen vier Fehler ans Licht, die
alle nur an echter Hardware sichtbar werden konnten.

- **Die Firmware war stumm gebaut.** MiniCore setzt `-DNDEBUG`, AskSinPP leert
  daraufhin `DPRINT`, `DPRINTLN` und `DINIT` — und der Sniffer schreibt alles
  darüber. Nicht einmal `Serial.begin()` kam zustande. Behoben in der
  [Firmware](https://github.com/ssbingo/asksin-sniffer-firmware) (v1.0.0);
  gemessen: 8 540 Byte mit Ausgabe, 7 630 ohne.
- **`stty` kann 58824 nicht.** Der Befehl stand an sechs Stellen in der
  Dokumentation, unter anderem im Fehlersuche-Kapitel als *Lösung*. Ersetzt
  durch `deploy/baudrate.py` (`termios2`/`BOTHER`).
- **Der Reset-Impuls auf GPIO4 hatte kein Ende.** `flashFirmware()` ließ die
  Leitung auf LOW liegen; ab dem zweiten Aufruf fand der Reset keine fallende
  Flanke mehr, und `avrdude` lief in `not in sync`.
- **`install.sh` löschte das eigene Arbeitsverzeichnis**, bevor es hinausging.

**Aufgeräumt.** Entfernt wurden die stumme HEX-Datei samt Nachbau-Skript, zwei
PDF-Dubletten, eine byte-gleiche Platinen-Sicherungskopie und zwei
Planungs-PDFs vom 26.07., die noch Arduino Pro Mini, MQTT und microSD
beschrieben. Bei der Platine liegt jetzt ausschließlich der Fertigungsstand
vom 31.07. im Repo.

**Neue harte Prüfungen**, jede mit Gegenprobe: `firmware/pruefe-hex.py` weist
stumm gebaute Firmware zurück, `tools/pruefe-erzeugnisse.py` verbietet
Erzeugnisse, die älter sind als ihre Quelle, Zeichnungen außerhalb von `fab/`
und tote Verweise in der Dokumentation.

**Handbuch** auf 121 Seiten: Kapitel 8 neu (eigene Firmware, drei
Sketch-Dateien, `NDEBUG`), 11.6 *Platine ohne Funkmodul* erstmals
tatsächlich geschrieben, 7.2 und 7.6 um die USBasp-Fallen unter Windows
ergänzt.

### v0.13.0 — 03.08.2026

- Ablage für die Sniffer-Firmware mit maschineller Prüfung; die mitgelieferte
  HEX-Datei ließ sich zunächst nicht reproduzieren — Ursache war die Menüzeile
  *Compiler LTO*, und der FQBN im Handbuch war falsch geschrieben
- **Mitschnitt** des rohen Zeilenstroms: über die Weboberfläche schaltbar,
  herunterladbar, mit Herkunftsvermerk in der Datei, damit Demo-Aufzeichnungen
  nicht mit echten verwechselt werden
- Analyzer-Seite der erweiterten Firmware: Anhang lesen, Lücken rechnen,
  Firmware-Befund erheben
- Demo-Modus gibt keine echte Netzidentität mehr preis; Screenshots neu

### v0.12.2 — 01.08.2026

- Handbuchsatz auf WeasyPrint umgestellt; der Fußsteg verdeckte auf mehreren
  Seiten Text

### v0.12.1 — 01.08.2026

- Der Versionsbefund zum Adapter wird auch im guten Fall ausgesprochen —
  Schweigen war nicht von „nicht geprüft" zu unterscheiden

### v0.12.0 — 01.08.2026

- Versionsabhängigkeit zwischen Core und ioBroker-Adapter
- Rahmen um die Übersichtsblöcke

### v0.11.0 — 01.08.2026

- **Langzeitdaten vor Ort**: InfluxDB und Grafana auf dem Analyzer, Rolle
  Master/Client mit Hardware-Schranke, acht Vorlagen und vier Alarme aus einem
  Generator statt von Hand gepflegt
- **Alarmziele** ioBroker, E-Mail und Telegram als prüfbares Modul, mit
  Testknopf für alle drei Wege
- **Absturzursache gefunden**: Der Pi 5 deckelt USB auf 600 mA, die SSD meldet
  sich daraufhin vom Bus ab. Die zunächst verdächtigte Stromversorgung wurde
  durch Messung entlastet und die Doku berichtigt
- `asksin-analyzer token` zeigt den Auth-Token

### v0.10.0 — 31.07.2026

- **Netz-Mitschnitt für die Absturzsuche**: Kernel-Meldungen übers Netz
  mitschneiden, mit Pulsschlag — damit Stille etwas bedeutet
- Absturzbericht um Datenträger-Anbindung, SMART und ausgehandelte
  USB-Geschwindigkeit erweitert
- Handbuch: feste Grundregel für Seitenumbrüche, Fußzeile mit Weg zum Inhalt,
  Inhaltsverzeichnis springt direkt zum Kapitel

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

**Wohin die Alarme melden**, wird ebenfalls in der WebUI eingestellt — drei
Wege stehen zur Wahl:

1. **ioBroker-Adapter** (empfohlen, wenn ioBroker läuft): Grafana ruft den
   Adapter auf, der über die dort schon eingerichteten Messaging-Adapter
   verteilt. Man richtet Telegram, Signal oder Pushover damit **einmal im
   ioBroker** ein statt ein zweites Mal in Grafana. *(Endpunkt im Adapter
   folgt in einer eigenen Phase.)*
2. **E-Mail** — mit **Testknopf**: Der Analyzer verschickt selbst über SMTP
   und gibt die Antwort des Servers im Klartext zurück, samt Hinweis, was zu
   tun ist. Kein Umweg über Grafana, kein Speichern nötig.
3. **Telegram** — Bot-Token und Chat-Kennung.

Gespeichert wird immer **Kontaktpunkt und Benachrichtigungsrichtlinie
zusammen**. Genau deren Trennung ist der häufigste Grund, warum selbst
eingerichtete Grafana-Alarme nie ankommen.

Für Einsteiger ist das alles im Handbuch Schritt für Schritt beschrieben —
Kapitel 19.3 bis 19.11, mit Abbildungen aller acht Ansichten.

### Versionsabhängigkeit zum ioBroker-Adapter

Analyzer und Adapter werden getrennt gepflegt. Damit ein Gespann aus zwei
unpassenden Fassungen nicht als diffuses „geht nicht" auffällt, weist **jede
Seite aus, welche Fassung der anderen sie braucht — und prüft es**:

| Analyzer | Adapter | wodurch |
| --- | --- | --- |
| 0.12.0 | 0.0.2 | erste Fassung mit Alarm-Zustellung |

### Die Clients an die Datenbank anschließen

Nur der Master speichert. Die übrigen Analyzer schicken ihre Kennzahlen
dorthin — einzustellen auf **jedem Client** unter *Einstellungen →
Langzeitdaten (InfluxDB)*:

| Feld | Wert |
| --- | --- |
| InfluxDB-URL | `http://<IP-des-Masters>:8086` |
| Organisation | `asksin` |
| Bucket | `asksin` |
| API-Token | **derselbe wie auf dem Master** |

Den Token gibt es nur einmal, für alle. Zu finden auf dem Master in der
Weboberfläche (Augensymbol) oder in `/etc/asksin-analyzer/influx-zugang.txt`.

Ob es geklappt hat, steht unter den Feldern („12 Schreibvorgänge, 0 Fehler")
und auf der Übersichtsseite des Masters als **Zahl der Standorte** — die kommt
aus der Datenbank selbst und steht erst dann auf 5, wenn wirklich alle fünf
schreiben.

Schritt für Schritt samt der drei üblichen Stolpersteine: Handbuch 19.6.

Der Testknopf im Analyzer fragt den Adapter vorher nach seiner Fassung; der
Adapter prüft bei jeder Abfrage die des Analyzers. **Jede Änderung an dieser
Abhängigkeit gehört auf beide Seiten** — sonst behauptet jede etwas anderes.

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
| Sniffer-Firmware ([eigenes Repo](https://github.com/ssbingo/asksin-sniffer-firmware)) | **CC BY-NC-SA 3.0** | © jp112sdl — abgewandelt, ShareAlike, [Quelle](https://github.com/jp112sdl/AskSinAnalyzer) |
| Web-UI (`webui/`, eigener Nachbau ohne Fremdcode) | **MIT** | © 2026 S. Sternitzke |
| Apache ECharts (Diagramme der Web-UI) | Apache-2.0 | Apache Software Foundation |
| Firmware `AskSinSniffer328P` (Vorlage unserer Fassung) | CC BY-NC-SA 3.0 | jp112sdl |
| AskSinPP (Bibliothek der Firmware) | CC BY-NC-SA 3.0 | pa-pa |
| AskSinAnalyzerXS (Referenz für Parser/Formeln) | CC BY-NC-SA 4.0 | psi-4ward |
| AskSinAnalyzerXS-RPi (Platinen-Vorlage V1.1) | CC BY-NC-SA 4.0 | der-pw |
| ioBroker-Adapter (eigenes Repo, geplant) | MIT | — |

Details und Begründung der Lizenzwahl: [`LICENSE`](LICENSE) und
[`docs/webui-und-updates.md`](docs/webui-und-updates.md), Abschnitt 4.
