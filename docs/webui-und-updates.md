# Web-UI und Update-Pfade

Anforderung: die im AskSinAnalyzer-Projekt vorhandene Website bleibt erhalten,
und über sie muss ein Software-Update möglich sein (OTA / Webupdate).

Verifiziert am 27.07.2026 gegen:

- `reference/AskSinAnalyzer/ui/` (Vue 2 + Quasar, jp112sdl)
- `reference/AskSinAnalyzer/ui/src/EspService.js` — der einzige API-Client der App
- `reference/AskSinAnalyzer/AskSinAnalyzerESP32/Web.h` — die Route-Registrierung
- `reference/AskSinAnalyzer.wiki/HTTP_Befehle.md`, `WebUI.md`

---

## 1. Was „die Website" konkret ist

Eine Single-Page-App, Vue 2.6 + Quasar 1.x, gebaut mit vue-cli. Fünf Ansichten:

| Route | Datei | Inhalt |
| --- | --- | --- |
| `/home` | `views/Home.vue` (in `WithTimeChart.vue`) | Zeitchart RSSI/Telegramme |
| `/list` | `views/TelegramList.vue` | Telegrammliste, filterbar |
| `/settings` | `views/Einstellungen.vue` | CCU-IP, Hostname, NTP, Netzwerk, Alarmschwellen |
| `/info` | `views/Info.vue` | Version, Changelog, Update-Button |
| `*` | `views/404.vue` | |

Die App ist **rein clientseitig** und spricht ausschließlich über die unten
aufgeführten HTTP-Endpunkte mit dem Gerät. Sie lässt sich per
`Einstellungen > Analyzer IP überschreiben` gegen eine beliebige Basis-URL
richten — das heißt: **sie funktioniert unverändert gegen unseren Core, sobald
der Core dieselben Endpunkte liefert.** Das ist der entscheidende Hebel.

---

## 2. API-Vertrag, den der Core erfüllen muss

Abgeleitet aus `EspService.js`. Alles, was die App tatsächlich aufruft:

### 2.1 Datenabruf (zwingend)

| Endpunkt | Methode | Antwort | Bemerkung |
| --- | --- | --- | --- |
| `/getLogByLogNumber?format=csv&lognum=<n>` | GET | CSV, `\n`-getrennt | Kernendpunkt. Liefert Telegramme **neuer als** `lognum`, maximal 50 pro Aufruf. Die App pollt und erhöht `lognum`; kommen genau 50 zurück, pollt sie sofort erneut |
| `/getRSSILog?fromTstamp=<unix>` | GET | JSON-Array | `[{ type, tstamp, rssi }]`, die App filtert auf `type === 0`. `tstamp` in **Sekunden** (die App multipliziert mit 1000) |
| `/getConfig` | GET | JSON | siehe 2.3 |
| `/getAskSinAnalyzerDevListJSON` | GET | JSON | Geräteliste von der CCU. Content-Type **muss** `charset=` enthalten, sonst nimmt die App utf-8 an (Original liefert latin1) |

CSV-Format je Zeile — Reihenfolge ist fix, `;` als Trenner:

```
lognumber;tstamp;rssi;from;to;len;cnt;typ;flags
```

`from`/`to` sind Hex-Strings (die App macht `parseInt(val, 16)`), `flags` ist
eine **leerzeichengetrennte** Liste (die App macht `t.flags.split(' ')`),
`typ` der Klarname des Message-Typs. `tstamp` in Millisekunden.

### 2.2 Kommandos

| Endpunkt | Methode | Im Core |
| --- | --- | --- |
| `/setConfig` | POST | Parameter `ccuip`, `hostname`, `ntp`, `ip`, `netmask`, `gw` |
| `/reboot` | POST | Neustart des Core-Dienstes (nicht des Pi) |
| `/rebootInConfigMode` | POST | entfällt — WLAN-Config-Portal des ESP, auf dem Pi sinnlos. `501` |
| `/formatspiffs` | POST | Abbildung auf „Datenbank leeren" |
| `/deletecsv?backup=1` | POST | Tages-CSV löschen |
| `/downloadcsv` | GET | Tages-CSV |
| `/download?filename=yyyymmdd.csv` | GET | CSV eines Tages |
| `/insertSD`, `/ejectSD`, `/listSD` | GET | entfallen — Antwort `OK` mit `sdcardavailable: 0` |

### 2.3 `/getConfig` — Felder, die die App auswertet

Aktiv genutzt: `version_upper`, `version_lower` (die App baut daraus
`currentVersion = "<upper>.<lower>"`), `display` (entscheidet in `execUpdate()`
über den Dateinamen), `ccuip`, `hostname`, `ntp`, `ip`, `netmask`, `gw`,
`macaddress`, `resolve`, `boottime`, `rssi_hbw`, `rssi_alarmcount`,
`rssi_alarmthreshold`, `sdcardavailable`, `sdcardsizemb`,
`sdcardtotalspacemb`, `sdcardusedspacemb`, `spiffssizekb`, `spiffsusedkb`,
`staticipconfig`, `ccuhttps`, `backend`, `backendurl`.

Die Speicher-Felder müssen vorhanden sein, damit die Info-Ansicht nicht bricht —
Inhalt darf auf dem Pi sinnvoll umgedeutet werden (SD-Karte → Datenpartition,
SPIFFS → SQLite-Datei).

---

## 3. Update-Pfade

Das Original kennt zwei, beide in `EspService.execUpdate()`:

```js
if (bU >= 3 && bL >= 6) {
  document.location.href = `${baseUrl}/update`;               // Upload im Browser
} else {
  document.location.href = `${baseUrl}/httpupdate?url=...`;   // Pull von GitHub
}
```

`/update` ist die Upload-Seite von **AsyncElegantOTA** (`Web.h:503`), also ein
Formular „Datei wählen → hochladen → flashen". `/httpupdate` zieht ein `.bin`
von einer URL. Die Versionsprüfung holt
`https://raw.githubusercontent.com/jp112sdl/AskSinAnalyzer/gh-pages/dev/esp-version.txt`
und vergleicht `upper.lower` numerisch.

Auf unserer Architektur gibt es **zwei getrennte Artefakte**, nicht eines:

| Artefakt | Was aktualisiert wird | Mechanismus |
| --- | --- | --- |
| **Core-Dienst** | Node.js/TypeScript auf dem Pi | signiertes Release-Tarball entpacken, `systemctl restart`, Rollback auf die vorherige Version bei Fehlstart |
| **328P-Firmware** | `AskSinSniffer328P.hex` | Ingest anhalten → `avrdude -c arduino` → Ingest fortsetzen. Am USB-Port löst avrdude den Reset über die echte DTR-Leitung des CP2102N selbst aus; nur im HAT-Betrieb muss der Core zusätzlich GPIO2 takten (Details: `../hardware/README.md` Abschnitt 4.2) |

Vorgeschlagene Endpunkte — `/update` bleibt als Einstieg erhalten, dahinter
liegt eine Auswahl:

| Endpunkt | Methode | Zweck |
| --- | --- | --- |
| `/update` | GET | Upload-/Auswahlseite (Kompatibilität zum Original) |
| `/api/update/versions` | GET | installierte + verfügbare Version je Artefakt |
| `/api/update/core` | POST | Core-Update, Body: Tarball oder `{ url }` |
| `/api/update/firmware` | POST | 328P-Update, Body: `.hex` oder `{ url }` |
| `/api/update/status` | GET / WS | Fortschritt, Log, Ergebnis |

Anforderungen, die von Anfang an in die Implementierung gehören:

- **Atomar und rückrollbar.** Core-Releases in `releases/<version>/`, ein
  Symlink `current` zeigt darauf. Startet die neue Version nicht innerhalb von
  N Sekunden sauber, zeigt der Symlink zurück auf die alte.
- **Integrität.** Prüfsumme (SHA-256) und Signatur vor dem Entpacken/Flashen
  prüfen. Ein `/httpupdate?url=<beliebig>` wie im Original ist eine offene
  Remote-Code-Execution — der Nachbau muss die Quelle auf eine konfigurierte
  Release-URL beschränken oder die Signatur erzwingen.
- **Firmware-Update ist exklusiv.** Der Ingest muss den Port sicher freigeben
  und darf ihn erst nach Abschluss zurücknehmen. Watchdog währenddessen
  pausieren, sonst rebootet der Dienst mitten im Flashen.
- **Beide Anbindungswege abdecken.** Ab Hardware V3 kann der Sniffer über USB
  oder über den GPIO-Header hängen. Am USB-Port genügt ein avrdude-Aufruf, am
  GPIO-Header muss der Core zusätzlich den Reset über libgpiod takten. Der
  Update-Pfad muss erkennen, welcher Fall vorliegt — am einfachsten am
  konfigurierten Gerätepfad.
- **Version des 328P auslesbar machen.** Das Original hat das nicht. Der Sketch
  gibt beim Start `ASKSIN_PLUS_PLUS_IDENTIFIER` aus; für einen belastbaren
  Versionsvergleich sollte die eigene Firmware-Variante eine Zeile
  `:FW<version>;` ergänzen. Das ist die einzige sinnvolle Erweiterung am
  Sketch neben der Baudrate.
- **Kein Update ohne Authentifizierung.** Siehe Abschnitt 5.

---

## 4. Lizenzlage — das muss vor dem ersten Commit entschieden werden

Hier kollidieren zwei deiner Vorgaben, und zwar hart:

| Werk | Lizenz | Folge |
| --- | --- | --- |
| **AskSinAnalyzer** (jp112sdl) — die Website | **CC BY-NC-SA 3.0**, ausdrücklich „NOT free for commercial and governmental use" | ShareAlike: jede Ableitung muss wieder CC BY-NC-SA sein |
| **AskSinAnalyzerXS** (psi-4ward) — Parser-Referenz | CC BY-NC-SA 4.0 | dito |
| **AskSinAnalyzerXS-RPi** (der-pw) — Platine | CC BY-NC-SA 4.0 | dito |
| **Highcharts 7.x** — im UI als Abhängigkeit | kommerzielles Produkt, kostenlos nur für nicht-kommerzielle Nutzung | eigene Lizenz nötig, sobald kommerziell |

Das steht gegen „der Adapter soll eventuell veröffentlicht werden, alle Regeln
peinlichst genau". Eine NC-Lizenz ist keine Open-Source-Lizenz; im offiziellen
ioBroker-Repository ist sie praktisch nicht durchsetzbar, und Highcharts
mitzuliefern wäre zusätzlich lizenzpflichtig.

Die Architektur löst das aber von selbst, wenn man sie sauber schneidet:

```
Core-Dienst + Web-UI        →  Ableitung von AskSinAnalyzer  →  CC BY-NC-SA 3.0
ioBroker.asksinanalyzer     →  eigener Code, keine UI        →  MIT, publizierbar
```

Die Bridge enthält laut Designdokument ohnehin **keine** Analyse-Logik und
**keine** UI — sie spiegelt nur States. Damit ist sie kein abgeleitetes Werk und
kann MIT bleiben. Die Website bleibt im Core, wo sie hingehört.

Zwei Empfehlungen dazu:

1. **Highcharts ersetzen.** Apache ECharts oder Chart.js liefern dieselben
   Zeitreihen-Charts unter Apache-2.0 bzw. MIT. Das nimmt die einzige
   Abhängigkeit heraus, die auch bei rein privater Nutzung Ärger machen kann.
2. **Ableitungstiefe bewusst wählen.** Die App 1:1 zu übernehmen ist die
   schnellste Variante und bindet dich an CC BY-NC-SA. Sie funktional
   nachzubauen — gleiche Routen, gleicher API-Vertrag, gleiche Ansichten, aber
   eigener Code und aktuelles Vue 3 statt des EOL-Vue-2 — kostet mehr Zeit, gibt
   dir dafür die Lizenzhoheit über das Gesamtprojekt zurück. Der API-Vertrag in
   Abschnitt 2 ist dafür die vollständige Vorlage.

Unabhängig davon: **Namensnennung ist in beiden Fällen Pflicht**, und die
Herkunft (jp112sdl, psi-4ward, der-pw, pa-pa) gehört sichtbar ins README und in
die Info-Ansicht.

---

## 5. Sicherheitsanforderungen, die das Original nicht hat

Der ESP32 hing im LAN ohne jede Authentifizierung. Sobald der Core ein
Firmware-Flash und ein Core-Update über HTTP anbietet, ist das nicht mehr
vertretbar:

- Auth-Token oder Basic-Auth vor allen `/api/update/*`- und `/setConfig`-Routen.
  Der Token liegt im ioBroker-Adapter unter `encryptedNative`.
- Standardmäßig nur an `127.0.0.1` und das LAN-Interface binden, nicht `0.0.0.0`.
- `/httpupdate?url=<beliebig>` **nicht** nachbauen.
- Upload-Größe begrenzen, Dateityp prüfen (`.hex` bzw. `.tar.gz`), Signatur
  erzwingen.

---

## 6. Auswirkung auf die Roadmap

M9 („optionales Web-UI") war im Designdokument der letzte Meilenstein. Mit
dieser Anforderung wandert er nach vorn und wird verbindlich:

| MS | neu | Inhalt |
| --- | --- | --- |
| M5 | erweitert | API-Layer liefert zusätzlich den **Kompatibilitäts-Endpunktsatz** aus Abschnitt 2 |
| M5.5 | **neu** | Web-UI ausliefern und gegen echte Daten prüfen |
| M6 | unverändert | ioBroker-Bridge |
| M7.5 | **neu** | Update-Pfade: Core-Self-Update + 328P-Flash über die UI |

Der Kompatibilitäts-Endpunktsatz ist billig, wenn der Datenpfad steht — die
CSV-Zeile in Abschnitt 2.1 ist eine Projektion des Telegram-Objekts. Er sollte
deshalb direkt mit M5 entstehen und nicht nachgerüstet werden.
