# Verbund — mehrere Analyzer als Gesamtsystem (Phase M9)

Entschieden am 29.07.2026. Zielbild: **fünf Analyzer** verteilt im Gebäude
(Datenschränke, PoE), die als ein System gesehen und bedient werden.

## Entscheidungen

| Frage | Entscheidung |
| --- | --- |
| Grundarchitektur | **A — Föderation**: jeder Analyzer bleibt autark (eigene SQLite, eigene UI); einer übernimmt zusätzlich die **Verbund-Rolle** und rechnet die Gesamtsichten aus den `/api/*` der anderen. D (ioBroker) kommt mit M6 ohnehin — der Adapter wird von Anfang an mehrinstanzfähig entworfen. C (MQTT) bleibt optionaler Zusatzausgang. B (zentrale Sammel-Datenbank) wird **nicht** gebaut. |
| Ort der Verbund-Rolle | Auf **einem der fünf Pis**, per Konfiguration bestimmt und jederzeit auf einen anderen Pi umziehbar. Keine zusätzliche Hardware. |
| Tiefe der Zusammenführung | **Voll**: Verbund-Dashboard + Empfangsmatrix Gerät × Standort + deduplizierte Telegrammliste. |
| MQTT | Später als eigener, optionaler Meilenstein — erst wenn sich Bedarf zeigt. |

Warum Föderation: Fällt die Verbund-Zentrale aus, **zeichnen alle weiter
auf** — es fehlt nur vorübergehend die Gesamtsicht. Es gibt keinen neuen
Serverdienst, keine Spooling-Logik, und die vorhandene API ist bereits
alles, was gebraucht wird.

## Der Mehrwert von fünf Empfängern

Jedes Funktelegramm wird meist von mehreren Analyzern gleichzeitig gehört —
mit unterschiedlichem RSSI. Daraus entstehen Sichten, die ein einzelner
Analyzer nicht liefern kann:

- **Empfangsmatrix Gerät × Standort**: Wo sind Funklöcher? Wohin gehört die
  nächste Antenne? Warum verliert Gerät X Telegramme?
- **Deduplizierte Telegrammliste**: gleicher Absender + Zähler in engem
  Zeitfenster = ein Telegramm, angezeigt mit „gehört von: Keller (−62),
  DG (−88)".
- **Störerdiagnose je Etage**: Grundrauschen im Standortvergleich.
- **Flotten-Betrieb**: ein Klick aktualisiert alle (Basis: M7.5),
  ein Alarmkanal, ein Grafana mit `standort`-Tag.

## Architektur

```text
 Pi „Keller"        Pi „EG"         Pi „OG"         Pi „DG"      Pi „Garage"
 ┌───────────┐   ┌───────────┐   ┌───────────┐   ┌───────────┐   ┌───────────┐
 │ Analyzer  │   │ Analyzer  │   │ Analyzer  │   │ Analyzer  │   │ Analyzer  │
 │ + SQLite  │   │ + SQLite  │   │ + SQLite  │   │ + SQLite  │   │ + SQLite  │
 │ + Web-UI  │   │ + Web-UI  │   │ + Web-UI  │   │ + Web-UI  │   │ + Web-UI  │
 │ + VERBUND │◀──┴─────/api/*────┴───────────┴───────┴───────────┘
 └─────▲─────┘        (Abruf, kurz gecacht; Peers aus der Konfiguration)
       │
   Verbund-Ansichten im Web-UI: Dashboard, Matrix, Dedup-Liste
   (und später: ioBroker-Adapter, Influx/Grafana, optional MQTT)
```

Die Verbund-Rolle ist reine Zusatzfunktion im Core — dieselbe Software auf
allen fünf Pis, nur die Konfiguration unterscheidet sich
(`verbund.peers: [...]`).

## Meilensteine

### M9.1 — Standort-Identität *(klein, Voraussetzung für alles)*

- Konfigurationsfeld `standort` (z. B. „Keller", „DG-Ost"); der
  Installer-Assistent fragt danach
- Sichtbar in UI-Kopfzeile (Badge), `/api/health`, `/api/snapshot`,
  `/getConfig`; später Tag in Influx und Instanzname im Adapter
- **Zeitbasis**: Verbund braucht synchrone Uhren (NTP/chrony); `/api/health`
  meldet die eigene Zeit, der Verbund prüft Drift der Peers (Warnung > 1 s)

Akzeptanz: Zwei Instanzen nebeneinander sind in UI und API eindeutig
unterscheidbar.

### M9.2 — Verbund-Rolle und Status-Dashboard

- Konfiguration `verbund.peers` (URLs + Tokens) auf genau einem Pi
- Fan-out-Abruf der Peer-APIs mit kurzem Cache und sauberem
  Fehlerbild je Peer (offline ≠ Fehler des Dashboards)
- Neue UI-Ansicht **„Verbund"**: Kachel je Standort (Verbindung, Rauschen,
  Telegramme/min, Duty-Cycle-Spitze, Version), Drilldown zur Einzel-UI

Akzeptanz: Ein ausgefallener Peer erscheint als „nicht erreichbar",
alles andere bleibt live.

### M9.3 — Empfangsmatrix und Dedup-Telegrammliste

- Verbund zieht `/api/telegrams` inkrementell je Peer und führt im Speicher
  zusammen; Dedup-Schlüssel: Absender + Zähler + Typ + Länge in ±1,5 s
- **Matrix Gerät × Standort** aus den RSSI-Werten der Peer-Snapshots,
  farbcodiert; Export als CSV
- Dedup-Liste mit „gehört von …"-Spalte in der Verbund-Ansicht

Akzeptanz: Ein von drei Analyzern gehörtes Telegramm erscheint einmal,
mit drei RSSI-Werten.

### M9.4 — Flotten-Update *(setzt M7.5 voraus)*

- Verbund-Ansicht zeigt Version je Peer; „alle aktualisieren" rollt
  nacheinander aus: Peer aktualisieren → Health-Check → nächster
- Abbruch bei fehlschlagendem Health-Check (kein Domino-Ausfall)

### M9.5 — Verbund-Langzeitdaten *(= M8, verbundfähig gedacht)* ✅

Umgesetzt am 29.07.2026: **Jeder Analyzer schreibt selbst** (dezentral —
kein zusätzlicher Sammelpfad über den Master, die lokale SQLite bleibt die
primäre Wahrheit) per Line Protocol in eine zentrale **InfluxDB v2**
(`/api/v2/write`, Token-Auth, ohne Client-Bibliothek):

- Measurement `analyzer` (Tag `standort`): connected, telegrammeProMinute,
  grundrauschen, geraete
- Measurement `geraet` (Tags `standort`, `adresse`, `name`): rssi,
  dutyCycle, telegramme
- Konfiguration über **Einstellungen → Langzeitdaten** (URL, Org, Bucket,
  Token — wird nie wieder angezeigt, Intervall ≥ 5 s), sofort wirksam,
  dienst-schreibbar persistiert; Influx-Ausfälle stören den Analyzer nicht

Grafana-Beispielabfragen (Flux): Standortvergleich Rauschen
`filter(fn: (r) => r._measurement == "analyzer" and r._field == "grundrauschen")`
gruppiert nach `standort`; Duty-Cycle-Trends je Gerät über Measurement
`geraet`. Die Dashboards selbst baut man sich in Grafana nach Geschmack.

### M9.6 — MQTT-Ausgang *(optional, nur bei Bedarf)*

- Publisher im Core: Telegramme + Health je Standort auf einen Broker

## Auswirkungen auf bestehende Meilensteine

| MS | Anpassung |
| --- | --- |
| **M6 (ioBroker-Adapter)** | Von Anfang an **mehrinstanzfähig**: eine Instanz je Analyzer; Standortname aus `/api/health` wird Instanz-Beschriftung |
| **M7 (Alerting)** | Alarmquellen um Verbund-Zustände erweitern (Peer offline, Zeitdrift) |
| **M7.5 (Update-Pfade)** | Unverändert **nächster Schritt** — Endpunkt-Design so, dass M9.4 es fernsteuern kann (ein Update-Endpunkt, kein UI-Zwang) |
| **M8 (Influx/Grafana)** | Geht in M9.5 auf |

## Reihenfolge

1. **M7.5** — Update-Pfade ✅ (v0.0.4; Basis für M9.4)
2. **M9.1** — Standort-Identität ✅
3. **M9.2 + M7.6** ✅ — Verbund-Dashboard **und** Netzwerkeinstellungen über
   die Web-UI ([`netzwerkeinstellungen.md`](netzwerkeinstellungen.md)) —
   gemeinsam umgesetzt, gleiche Mechanik (Auftragsdatei/Path-Unit/Status)
4. **M9.3** ✅ Empfangsmatrix + Dedup-Telegrammliste; **M9.4** ✅ Flotten-Update
5. **M6** — Adapter (profitiert von fertiger Standort-Identität)
6. **M9.5** — Langzeitdaten; M9.6 nur bei Bedarf
