# AskSin-Analyzer Core

Der dauerlaufende Analysedienst: liest die serielle Schnittstelle des
AskSinSniffer328P, decodiert die Telegramme, rechnet Duty-Cycle und Statistik,
persistiert und stellt API und Web-UI bereit.

Stand: **M5.5 (Web-UI) abgeschlossen.** Die Kette Port → Decoder → Statistik →
SQLite ist komplett verdrahtet (`Analyzer`), darauf liegt die REST-Schicht mit
dem Kompatibilitäts-Endpunktsatz der originalen Web-UI plus eigener JSON-API —
und der Core liefert den UI-Nachbau ([`../webui/`](../webui/)) gleich selbst
aus. Es folgen der ioBroker-Adapter und die Update-Pfade.

## Bauen und Prüfen

```bash
npm install
npm test          # node:test, ohne Netz und ohne Hardware
npm run typecheck # tsc --noEmit
npm run check     # beides
npm run build     # nach dist/
```

Voraussetzung ist Node ≥ 22.6 — die Tests laufen die TypeScript-Quellen direkt,
ohne Buildschritt und ohne Test-Framework als Abhängigkeit. Das ist Absicht: der
Decoder ist reine Logik, jede zusätzliche Abhängigkeit wäre eine Fehlerquelle im
Dauerbetrieb ohne Gegenwert.

## Aufbau

```text
src/decode/     Zeile → Telegram | RssiNoise | verworfen   (fertig)
src/analytics/  Duty-Cycle über gleitendes Stundenfenster  (fertig)
src/resolve/    Gerätenamen von der CCU + Abrufdienst      (fertig)
src/ingest/     serieller Port, Reconnect, Watchdog        (fertig)
src/persist/    SQLite im WAL-Modus (node:sqlite)          (fertig)
src/service/    Analyzer: alles verdrahtet + snapshot()    (fertig)
src/api/        REST: XS-Kompat-Endpunkte + /api/*         (fertig)
```

## Decoder

`parseLine` ist eine reine Funktion und wirft nie. Jede Zeile wird zu genau
einem von drei Ergebnissen:

```ts
import { parseLine } from './src/decode/index.ts';

const res = parseLine(':5A0E0100701A2B3C0000000102030405;');
// { kind: 'telegram', telegram: { rssi: -90, msgTypeName: 'WEATHER', … } }

parseLine(':5B;');                    // { kind: 'noise',   noise: { rssi: -91 } }
parseLine('AskSin++ V4.1.4');         // { kind: 'ignored', reason: 'no-frame' }
```

Verworfene Zeilen tragen einen auswertbaren Grund (`no-frame`, `not-hex`,
`length-mismatch`, `implausible-rssi`, …). Die gehören als Selbstmetrik in den
Health-Endpoint — ein plötzlich steigender `not-hex`-Zähler ist das erste
Anzeichen einer driftenden Baudrate.

Gegenüber der Referenzimplementierung in AskSinAnalyzerXS validiert der Decoder
zusätzlich Hex-Alphabet, Bytegrenze, Längenbyte gegen tatsächliche Zeilenlänge
und RSSI-Plausibilität. XS parst blind und erzeugt bei verstümmelten Zeilen
`NaN`-Felder.

Format und Herleitung: [`../docs/serial-protocol.md`](../docs/serial-protocol.md).

## Duty-Cycle

Die Formel ist bewusst 1:1 aus AskSinAnalyzerXS übernommen, damit Werte
vergleichbar bleiben. Zwei Dinge sind anders:

- **Ringpuffer fester Kapazität** statt einer wachsenden Liste.
- **`prune()` nach Wanduhr.** In XS behält ein verstummtes Gerät seinen letzten
  Duty-Cycle für immer, weil dort nur beim Empfang gerechnet wird.

```ts
const tracker = new DutyCycleTracker();
tracker.addTelegram(telegram);        // → Duty-Cycle des Absenders in %
tracker.snapshot(Date.now());         // alle Geräte, absteigend sortiert
```

Der Wert ist ein Prozentsatz des 1-%-Kontingents: 100 bedeutet, dass das Gerät
seine erlaubte Stundensendezeit von 36 s ausgeschöpft hat. Es ist eine
**Schätzung** aus Längenbyte und Datenrate, kein Messwert — gegen die
CCU-Anzeige kalibrieren.

## Namensauflösung

`src/resolve/` verarbeitet die Geräteliste der CCU (`AskSinAnalyzerDevList`):
Strukturvalidierung, Klassifizierung (Gerät / Rauchmelder-Gruppe / Zentrale /
Pseudo-Multicast), HmIP-Erkennung nach XS-Konvention und ein `DeviceResolver`,
der **doppelte Adressen** korrekt behandelt — reale Geräte haben Vorrang vor
ihren Gruppen. Dazu die Dekodierung der rohen CCU-Antwort (latin1, XML-Hülle,
HTML-Escapes) als reine Funktionen.

Den Abruf übernimmt der **DevListService**: zyklisch (Vorgabe stündlich,
nach Fehlern alle 5 Minuten) von `http://<ccu>:8181/a.exe`, mit atomarem
Datei-Cache (tmp + rename). Nach einem Neustart zeigt der Analyzer sofort
Namen aus dem Cache, auch wenn die CCU gerade nicht erreichbar ist; bei
Abruf-Fehlern bleibt der letzte Stand nutzbar. HTTP und Uhr sind injizierbar —
die Tests speisen die echte Drahtform ein und schieben die Zeit von Hand.

Die Test-Fixture `test/fixtures/devlist-beispielanlage.json` ist eine
**synthetische Beispielanlage**, deren Struktur exakt dem Export einer echten
RaspberryMatic entspricht (verifiziert 28.07.2026): 241 Einträge, 237
Adressen, doppelte Zentrale, Rauchmelder-Teams, Umlaute, HmIP-Seriennummern,
Pseudo-Multicasts. Namen und Seriennummern sind erfunden.

## Serial-Ingest

`src/ingest/` liest den Zeilenstrom des Sniffers dauerbetriebsfest:

- **LineSplitter** arbeitet auf Bytes (latin1, wirft nie) und kappt Zeilen
  ohne Ende — eine falsche Baudrate füllt sonst den Speicher statt Zeilen.
- **BoundedQueue** entkoppelt Leser und Verbraucher; bei Überlauf fallen die
  ältesten Zeilen weg und werden gezählt (Drop-Oldest, Designdok §7).
- **Watchdog** nutzt die 750-ms-Rauschzeilen des Sniffers: Stille über der
  Schwelle heißt tote Strecke → Port schließen, neu verbinden. Für eine fest
  verdrahtete Pi-UART ist das der einzige brauchbare Fehlerdetektor — sie
  „trennt" sich nie, sie verstummt nur.
- **Reconnect** mit exponentiellem Backoff; zurückgesetzt erst bei der ersten
  gültigen Zeile, nicht beim Öffnen — ein totes /dev/ttyAMA0 lässt sich
  prächtig öffnen. `connected` folgt derselben Regel (Semantik von
  `info.connection`).
- **Produktionsport ohne native Abhängigkeit:** der Sniffer sendet nur, also
  reicht `stty`-Konfiguration (kann die krummen 58 824 Baud) plus lesender
  Dateistrom. Port und Uhr sind injizierbar — sämtliche Reconnect-, Stille-
  und Überlaufszenarien laufen im Test in Millisekunden statt Echtzeit.

```ts
const ingest = new SerialIngest({
  openPort: sttyPortOpener('/dev/asksin-hat'),
  onLine: (l) => { if (l.kind === 'telegram') tracker.addTelegram(l.telegram); },
  onStateChange: (s) => states.set('info.connection', s.connected),
});
ingest.start();
```

## Persistenz

`src/persist/` nutzt das **eingebaute `node:sqlite`** (Node ≥ 22) — der Core
bleibt damit komplett ohne Laufzeitabhängigkeiten. WAL-Modus,
`synchronous=NORMAL`, Schema-Migration über `user_version`.

Drei Tabellen: `telegrams` (jedes Telegramm einzeln), `noise_minutes`
(Grundrauschen als Minutenaggregat — Einzelproben wären 115 000 Zeilen/Tag)
und `device_hours` (Stundensummen je Absender inkl. geschätzter Sendezeit für
Langzeit-Duty-Cycle).

Der **Recorder** schreibt gebündelt: eine Transaktion je Batch statt ein
fsync je Zeile — das schont die SD-Karte. Aggregat-Schreiben ist
delta-basiert mit additivem Upsert; ein Neustart mitten in der Stunde addiert
korrekt weiter, statt Teilsummen zu überschreiben. `cleanup()` setzt die
Retention je Tabelle durch und dampft das WAL ein.

`LiveStats` (in `src/analytics/`) liefert die restlichen Kennzahlen des
State-Baums: Grundrauschen (letzter Wert + EWMA), Telegramme der letzten
60 Sekunden und RSSI je Gerät (last/min/max/EWMA/lastSeen) — rein aus den
Zeilen-Zeitstempeln gerechnet, ohne eigene Uhr.

## Dienst-Komposition

`src/service/analyzer.ts` verdrahtet alles zur laufenden Kette:

```ts
const db = openDatabase('/var/lib/asksin/analyzer.db');
const analyzer = new Analyzer({
  openPort: sttyPortOpener(),               // /dev/asksin-hat, 58 824 Baud
  db,
  devList: new DevListService({
    host: 'ccu.local',
    cachePath: '/var/lib/asksin/devlist.json',
  }),
});
analyzer.start();
// …
const s = analyzer.snapshot();              // die eine Leseschnittstelle (→ M5)
await analyzer.stop();                      // stoppt alles, flusht den Rest
```

`start()` fährt Ingest, DevList-Abruf, Flush-Takt (5 s) und Aufräumtakt
(täglich: Retention + WAL-Checkpoint) hoch; `stop()` alles wieder herunter,
mit abschließendem Flush. `snapshot()` führt je Gerät RSSI-Statistik,
Duty-Cycle und aufgelösten Namen zusammen — darauf setzt die API von M5 auf.

## API

`ApiServer` (`src/api/`) liegt auf `node:http` — weiterhin ohne
Laufzeitabhängigkeit — und bindet standardmäßig an `127.0.0.1`. Zwei
Endpunktfamilien:

**Kompatibilitätssatz der originalen Web-UI**
([`../docs/webui-und-updates.md`](../docs/webui-und-updates.md), Abschnitt 2):
`/getLogByLogNumber` (CSV-Polling über die SQLite-rowid als `lognumber`,
max. 50 je Antwort wie das Original), `/getRSSILog` (Minutenmittel des
Grundrauschens, `tstamp` in Sekunden), `/getConfig` (alle Felder der
Info-Ansicht; SD-Karte → 0, SPIFFS → tatsächliche SQLite-Größe),
`/getAskSinAnalyzerDevListJSON` (mit `charset=` im Content-Type) sowie die
Kommando-Routen: `/setConfig`, `/reboot` (Callback), `/formatspiffs`
(Datenbank leeren), `/deletecsv`, `/downloadcsv`, `/download?filename=`
(Tages-CSV direkt aus der Datenbank), SD-Routen als kompatible Attrappen,
`/rebootInConfigMode` ehrlich als `501`. Die unveränderte Original-App
funktioniert damit gegen den Core, sobald ihre Basis-URL hierher zeigt.

**Eigene API** unter `/api/*` (für den UI-Nachbau und den Adapter):
`snapshot` (die volle Analyzer-Sicht), `health`, `telegrams` (JSON mit
aufgelösten Namen und Klarnamen für Flags/Typen, inkrementell über `afterId`)
und `noise` (Minutenaggregat fürs Zeitchart). Mit gesetzter Option `uiDir`
liefert der Server zusätzlich das gebaute Web-UI aus — mit SPA-Fallback,
Immutable-Caching für gehashte Assets und Traversal-Schutz; ein zweiter
Webserver ist nicht nötig.

Sicherheit (Designdok §5): mit gesetztem `authToken` verlangen alle
verändernden Routen `Authorization: Bearer …`; `httpupdate` mit freier URL
wird bewusst **nicht** nachgebaut.

```ts
const api = new ApiServer({
  analyzer, db, devList,
  uiDir: '../webui/dist',
  authToken: '…',
});
await api.listen(8080);                     // bindet an 127.0.0.1
```

## Update-Pfade (M7.5)

Alles reine API — damit das Flotten-Update des Verbunds (M9.4) sie später
fernsteuern kann. Bei gesetztem Token sind **alle** `/api/update/*`-Routen
auth-pflichtig; ein `httpupdate` mit freier URL wird bewusst nicht angeboten.

- `GET /api/update/versions` — installierte Version/Commit + verfügbarer
  Commit (`git ls-remote`)
- `POST /api/update/core` — stößt das Update an: analyzerd legt eine
  Trigger-Datei ins Datenverzeichnis, die **systemd-Path-Unit** startet
  `update.sh` als root (der Dienst selbst braucht kein sudo, die
  `NoNewPrivileges`-Härtung bleibt intakt)
- `GET /api/update/status` — Fortschritt aus der Statusdatei, übersteht den
  Dienst-Neustart
- `POST /api/update/firmware` — Intel-HEX im Body: Ingest pausiert, Port
  wird frei, Reset (HAT → GPIO4 über libgpiod v2/v1, USB → DTR durch
  avrdude), `avrdude` mit **58 824 Baud**, danach Ingest weiter
  (`src/update/firmware.ts`, Kommandos injizierbar und damit ohne
  Hardware getestet)

`update.sh` ist atomar und rückrollbar: neues UI wird nach `dist-neu`
gebaut und erst bei Erfolg getauscht; nach dem Neustart läuft ein
Health-Check — scheitert er, stellt das Skript Git-Stand **und** UI
wieder her.

## Demo-Modus

`src/demo/` simuliert einen kompletten Haushalt am untersten Ende der Kette:
ein `demoPortOpener` erzeugt exakt die Zeilen des echten Sniffers
(Telegramme, 750-ms-Rauschzeilen, Bootmeldung, seltene Störimpulse), ein
`demoDevListFetch` liefert die passende Geräteliste im originalen
CCU-Drahtformat. Parser, Statistik, SQLite, API und Web-UI laufen dabei
unverändert — die Simulation testet also die echte Kette. Ein absichtlich
„defektes" Gerät sendet Dauerburst und führt die Duty-Cycle-Liste mit
Warnfarbe an.

Eingeschaltet wird der Modus über den Schalter **Einstellungen → Demo-Modus**
der Weboberfläche (Flag-Datei im Datenverzeichnis, Dienst startet neu) oder
`"demo": true` in der Konfiguration. Die Simulation schreibt in eine eigene
Datenbank `analyzer-demo.db` mit kurzer Retention — echte Aufzeichnungen
bleiben unberührt.

## Tests

111 Tests, alle ohne Hardware. Die Fixtures in `test/fixtures/lines.ts` sind
derzeit **konstruiert**, nicht mitgeschnitten. Sobald M0 vorliegt (Sniffer läuft,
ein paar Stunden Rohdaten), gehören echte Zeilen dazu — erst die decken die
Fälle ab, die man sich nicht ausdenkt: Teilzeilen nach einem Reconnect,
Boot-Ausgaben mitten im Strom, Kollisionsartefakte.

## Lizenz

CC BY-NC-SA 4.0 — abgeleitet von
[AskSinAnalyzer](https://github.com/jp112sdl/AskSinAnalyzer) (jp112sdl) und
[AskSinAnalyzerXS](https://github.com/psi-4ward/AskSinAnalyzerXS) (psi-4ward),
beide unter CC BY-NC-SA. Siehe
[`../docs/webui-und-updates.md`](../docs/webui-und-updates.md), Abschnitt 4 —
der ioBroker-Adapter bleibt davon getrennt und kann MIT sein.
