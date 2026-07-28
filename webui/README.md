# AskSin-Analyzer Web-UI

Funktionaler **Nachbau** der originalen AskSinAnalyzer-Oberfläche — gleiche
Routen (`/home`, `/list`, `/settings`, `/info`), gleicher Zweck, aber
**eigener Code**: Vue 3 statt des abgekündigten Vue 2, Apache ECharts statt
des lizenzpflichtigen Highcharts, kein UI-Framework. Es wurde bewusst keine
Zeile aus `reference/AskSinAnalyzer/ui/` übernommen; einzige Gemeinsamkeit
ist der dokumentierte API-Vertrag
([`../docs/webui-und-updates.md`](../docs/webui-und-updates.md), Abschnitt 2).
Deshalb steht dieses Verzeichnis unter **MIT** ([`LICENSE`](LICENSE)) —
Herkunft und Dank an jp112sdl, psi-4ward, pa-pa und der-pw stehen sichtbar
in der Info-Ansicht.

## Ansichten

| Route | Inhalt |
| --- | --- |
| `/home` | Verbindungs-/Rausch-/Rate-Kacheln, Zeitchart (Grundrauschen + Telegramm-RSSI), Duty-Cycle-Top-10 |
| `/list` | Live-Telegrammliste: inkrementelles Nachladen, Textfilter, Pause, Flag-/Typ-Chips, aufgelöste Namen |
| `/settings` | CCU-Adresse, NTP, Auth-Token (localStorage), Tages-CSV, Datenbank leeren, Dienst-Neustart |
| `/info` | Version, Laufzeit, Datenbankgröße, Empfangszähler, Herkunft/Lizenzen |

Die UI spricht ausschließlich die eigene JSON-API des Core (`/api/snapshot`,
`/api/telegrams`, `/api/noise`, `/api/health`) plus `/getConfig`/`/setConfig`.
Sie pollt (2–5 s) — ein WebSocket-Feed kann später einziehen, der API-Client
ist die einzige Stelle, die dafür angefasst werden muss.

## Entwickeln und Bauen

```bash
npm install
npm run dev        # Vite-Devserver; API-Aufrufe gehen per Proxy an 127.0.0.1:8080
npm run build      # vue-tsc + vite build → dist/
```

Im Betrieb liefert der Core das gebaute `dist/` selbst aus
(`ApiServer`-Option `uiDir`) — alles same-origin, kein zweiter Webserver,
kein CORS.
