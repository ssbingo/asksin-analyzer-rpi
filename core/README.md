# AskSin-Analyzer Core

Der dauerlaufende Analysedienst: liest die serielle Schnittstelle des
AskSinSniffer328P, decodiert die Telegramme, rechnet Duty-Cycle und Statistik,
persistiert und stellt API und Web-UI bereit.

Stand: **M1 (Parser-MVP)**. Decoder und Duty-Cycle-Rechnung stehen und sind
getestet; Serial-Ingest, Persistenz, API und UI folgen.

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

```
src/decode/     Zeile → Telegram | RssiNoise | verworfen   (fertig)
src/analytics/  Duty-Cycle über gleitendes Stundenfenster  (fertig)
src/resolve/    Gerätenamen von der CCU                    (Auflösung fertig, HTTP-Abruf folgt)
src/ingest/     serieller Port, Reconnect, Watchdog        (M2)
src/persist/    SQLite im WAL-Modus, optional InfluxDB     (M3)
src/api/        REST, WebSocket, MQTT + Web-UI-Kompat      (M5)
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
HTML-Escapes) als reine Funktionen. Der HTTP-Abruf selbst folgt mit M4.

Die Test-Fixture `test/fixtures/devlist-real.json` ist der unveränderte Export
einer echten RaspberryMatic (241 Einträge, 28.07.2026). **Sie enthält reale
Gerätenamen und Seriennummern dieser Anlage** — vor einer Veröffentlichung des
Repos ist sie zu anonymisieren oder durch eine synthetische Liste zu ersetzen.

## Tests

43 Tests, alle ohne Hardware. Die Fixtures in `test/fixtures/lines.ts` sind
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
