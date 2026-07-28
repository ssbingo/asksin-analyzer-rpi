# Serielles Protokoll AskSinSniffer328P

Verifiziert am 27.07.2026 gegen die Originalquellen:

- Firmware: `reference/AskSinAnalyzer/AskSinSniffer328P/AskSinSniffer328P.ino` (jp112sdl)
- Referenz-Parser: `reference/AskSinAnalyzerXS/app/src/SnifferParser.ts` (psi-4ward)
- Radio-Layer: `reference/AskSinPP/Radio-CC1101.h` (pa-pa)

Beide Implementierungen stimmen exakt überein. Damit ist das Zeilenformat belastbar.

## 1. Schnittstellenparameter

| Parameter | Wert | Quelle |
| --- | --- | --- |
| Baudrate | nominal **57600**, real **58823,5** | `DINIT(57600, ...)` im Sketch, `monitor_speed` in `platformio.ini` |
| Datenformat | 8N1 | Arduino-Default |
| Zeilenende | `\n` (ggf. `\r\n`) | XS nutzt `Readline({delimiter: '\n'})` + `trim()` |
| Flusskontrolle | keine | – |

## 2. Zeilenformat

Jede gültige Zeile beginnt mit `:` und endet mit `;`. Alle Felder sind
Großbuchstaben-Hex ohne Trennzeichen, feste Breite.

### 2.1 Telegramm-Zeile

```text
:RRLLCCFFTTAAAAAABBBBBBP...P;
```

| Offset | Länge | Feld | Bedeutung |
| --- | --- | --- | --- |
| 0 | 1 | `:` | Startzeichen |
| 1 | 2 | `RR` | RSSI-Betrag → **dBm = −RR** |
| 3 | 2 | `LL` | BidCoS-Längenbyte |
| 5 | 2 | `CC` | Message-Counter |
| 7 | 2 | `FF` | Flags |
| 9 | 2 | `TT` | Message-Type |
| 11 | 6 | `AAAAAA` | Absender-Adresse (3 Byte) |
| 17 | 6 | `BBBBBB` | Empfänger-Adresse (3 Byte) |
| 23 | 2·(LL−9) | `P...P` | Payload |
| – | 1 | `;` | Endzeichen |

Zeilenlänge = `23 + 2·(LL − 9) + 1`. Das Längenbyte zählt sich selbst nicht mit;
der Header nach ihm belegt 9 Byte (cnt, flags, type, from[3], to[3]), daher
Payload = `LL − 9` Byte.

`MaxDataLen` ist im Sketch auf 60 gesetzt — ausdrücklich, um auch HmIP-Telegramme
mit größerer Payload aufnehmen zu können.

### 2.2 RSSI-Noise-Zeile

```text
:RR;
```

Genau 4 Zeichen. Wird alle **750 ms** ausgegeben (`RSSI_POLL_INTERVAL`) und liefert
das Grundrauschen des Kanals. XS erkennt sie ausschließlich über `line.length === 4`.

### 2.3 Sonstige Zeilen

Alles, was nicht mit `:` beginnt **und** mit `;` endet, ist Fremdausgabe
(Boot-Meldungen der AskSinPP-Debugausgabe) und wird verworfen. Der Parser muss das
tolerieren, nicht als Fehler werten.

## 3. RSSI-Umrechnung

Die Umrechnung passiert bereits auf dem 328P in `Radio-CC1101.h:468`:

```c
rss = -1 * ((((int16_t)rsshex-((int16_t)rsshex >= 128 ? 256 : 0))/2)-74);
```

Der übertragene Wert ist also der **Betrag** des dBm-Werts (CC1101-Offset 74 bereits
eingerechnet). Der Consumer muss nur negieren:

```ts
const rssi = -1 * parseInt(hex, 16);   // z.B. "5A" → 90 → -90 dBm
```

`rss` ist `uint8_t`. Theoretisch positive dBm-Werte (extrem starkes Signal) würden
überlaufen — praktisch irrelevant, aber der Parser sollte Werte plausibilisieren.

## 4. Flags (Bitmaske)

| Bit | Name |
| --- | --- |
| 0x01 | `WKUP` |
| 0x02 | `WKMEUP` |
| 0x04 | `BCAST` |
| 0x10 | `BURST` |
| 0x20 | `BIDI` |
| 0x40 | `RPTED` |
| 0x80 | `RPTEN` |
| 0x00 | `HMIP_UNKNOWN` (XS-Konvention, keine echte HM-Flagge) |

XS wertet Flags **nicht** aus, wenn der Type als HmIP erkannt wurde — die
Flag-Semantik von HmIP ist nicht bekannt.

## 5. Message-Types

| Hex | Name | | Hex | Name |
| --- | --- | --- | --- | --- |
| 0x00 | `DEVINFO` | | 0x40 | `REMOTE_EVENT` |
| 0x01 | `CONFIG` | | 0x41 | `SENSOR_EVENT` |
| 0x02 | `RESPONSE` | | 0x53 | `SENSOR_DATA` |
| 0x03 | `RESPONSE_AES` | | 0x58 | `CLIMATE_EVENT` |
| 0x04 | `KEY_EXCHANGE` | | 0x5A | `CLIMATECTRL_EVENT` |
| 0x10 | `INFO` | | 0x5E | `POWER_EVENT` |
| 0x11 | `ACTION` | | 0x5F | `POWER_EVENT_CYCLIC` |
| 0x12 | `HAVE_DATA` | | 0x70 | `WEATHER` |
| 0x3E | `SWITCH_EVENT` | | ≥ 0x80 | `HMIP_TYPE` |
| 0x3F | `TIMESTAMP` | | sonst | unbekannt |

## 6. Duty-Cycle-Berechnung

Aus `DutyCyclePerTelegram.ts`. Gerechnet wird über den **Absender** (`fromAddr`),
gleitendes 1-h-Fenster:

```ts
// Sendezeit in ms, BidCoS ≈ 10 kbit/s → 0.81 ms/Byte
sendTime = flags.includes('BURST')
  ? 360 + (len + 7) * 0.81     // 360 ms Burst statt 4 Byte Präambel
  : (len + 11) * 0.81;

dc = sendTime / 360;           // 1 % von 1 h = 36 000 ms; 1 Prozentpunkt = 360 ms
```

Aufsummiert über alle Telegramme der letzten Stunde, Einträge älter als
`tstamp − 3 600 000` fallen heraus. Ausgabe auf eine Nachkommastelle gerundet.

> Das ist eine **Schätzung** aus Länge und Datenrate, kein Messwert. Für Trend und
> Alarm belastbar, nicht als Absolutwert. Gegen die CCU-Anzeige kalibrieren.

## 7. Namensauflösung (CCU/RaspberryMatic)

Abweichend von der Annahme im Designdoc läuft das **nicht** über XML-API/ReGaHSS,
sondern über eine **CCU-Systemvariable**, die ein CCU-Script befüllt:

- Script: `reference/AskSinAnalyzer/additional/ccu_create_devlist.txt`
- Legt an: `AskSinAnalyzerDevList` (String) und `AskSinAnalyzerAlarm` (Alarm-DP)
- Abruf: `http://<ccu>:8181/a.exe?ret=dom.GetObject(ID_SYSTEM_VARIABLES).Get("AskSinAnalyzerDevList").Value()`
- Antwort ist XML mit `<ret>…</ret>`, Inhalt HTML-escaped JSON, Encoding **latin1**
- Nutzlast: `{"created_at":<unix>,"devices":[{"address":<int>,"serial":"…","name":"…"}]}`

Das Script trägt zusätzlich feste Einträge für HmIP-Multicast-Adressen und den
HMRF-Broadcast (Adresse 0) ein. `serial === "HmIP-RF"` bzw. Seriennummernlänge 14
markiert in XS ein HmIP-Gerät.

Konsequenz: Das Script muss **einmalig auf der CCU** ausgeführt werden und danach
periodisch (bei Gerätewechseln) erneut. XS pollt die Variable stündlich und cached
sie lokal als `deviceList.json`.

## 8. HmIP — Präzisierung

Beide Planungsdokumente sagen „HmIP wird nicht ausgewertet". Genauer:

- Der Sketch ist bewusst auf HmIP-Payload-Größen ausgelegt (`MaxDataLen 60`).
- XS erkennt HmIP an `type ≥ 0x80` und mappt es auf `HMIP_TYPE`.
- Adresse, Länge, RSSI und Zeitstempel sind damit auch für HmIP verfügbar.
- **Nicht** verfügbar: Flag- und Payload-Semantik.

HmIP-Telegramme sind also teilweise sichtbar (brauchbar für Duty-Cycle und
RSSI-Statistik), aber nicht inhaltlich dekodiert. Wie vollständig der Empfang ist,
muss am realen Netz gemessen werden — die CC1101-Registerkonfiguration in AskSinPP
ist auf BidCoS ausgelegt.

## 9. Konsequenzen für den eigenen Core

1. Parser als reine Funktion `string → Telegram | RssiNoise | null`, Fixtures aus
   echten Mitschnitten. Deterministisch testbar ohne Funk.
2. Zeilen mit `length === 4` **vor** dem Feld-Parsing abfangen.
3. Unbekannte/abgeschnittene Zeilen verwerfen, zählen, aber nicht werfen.
4. Duty-Cycle-Formel 1:1 von XS übernehmen — sie ist die etablierte Referenz,
   Abweichungen wären nicht vergleichbar.
5. Ringpuffer fester Kapazität statt der unbegrenzten `counts`-Liste von XS
   (Designdoc, Abschnitt 7 „Speicherbegrenzung").
