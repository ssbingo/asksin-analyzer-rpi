/**
 * ApiServer — REST-Schicht auf `node:http`, ohne Laufzeitabhängigkeit.
 *
 * Zwei Endpunktfamilien:
 *
 *  - **Kompatibilitätssatz** der originalen Web-UI (docs/webui-und-updates.md
 *    §2): `/getLogByLogNumber`, `/getRSSILog`, `/getConfig`,
 *    `/getAskSinAnalyzerDevListJSON` plus die Kommando-Routen. Die
 *    unveränderte App funktioniert damit gegen den Core, sobald man ihre
 *    Basis-URL hierher richtet.
 *  - **Eigene API** unter `/api/*` für den UI-Nachbau (M5.5) und den
 *    ioBroker-Adapter: `snapshot` und `health`. Ein WebSocket-Live-Feed
 *    folgt mit dem UI-Nachbau — die Original-App pollt ohnehin nur.
 *
 * Sicherheit (§5): bindet standardmäßig an 127.0.0.1. Ist `authToken`
 * gesetzt, verlangen alle **verändernden** Routen `Authorization: Bearer`.
 * `/rebootInConfigMode` (ESP-WLAN-Portal) antwortet 501; die SD-Routen
 * antworten kompatibel mit `OK`, gemeldet wird `sdcardavailable: 0`.
 */

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { hostname, networkInterfaces } from 'node:os';
import type { DatabaseSync } from 'node:sqlite';

import { systemTime } from '../ingest/time.ts';
import type { TimeSource } from '../ingest/time.ts';
import type { DevListService } from '../resolve/fetcher.ts';
import type { Analyzer } from '../service/analyzer.ts';
import {
  dayOf,
  dayRange,
  toCsvLine,
  toRssiLogEntry,
  toVersionParts,
} from './compat.ts';
import type { NoiseMinuteRow, TelegramRow } from './compat.ts';

export interface ApiConfig {
  /** Hostname/IP der CCU — landet in `/getConfig` (Feld `ccuip`). */
  ccuip?: string;
  ntp?: string;
  rssiAlarmThreshold?: number;
  rssiAlarmCount?: number;
}

export interface ApiServerOptions {
  analyzer: Analyzer;
  db: DatabaseSync;
  devList?: DevListService;
  /** Semver des Core — wird zu `version_upper`/`version_lower`. */
  version?: string;
  config?: ApiConfig;
  /** Wenn gesetzt: Pflicht-Bearer-Token für alle verändernden Endpunkte. */
  authToken?: string;
  time?: TimeSource;
  /** Neustart des Core-Diensts (nicht des Pi). Ohne Callback: 501. */
  onReboot?: () => void;
  /** Erhält alle per `/setConfig` übergebenen bekannten Felder. */
  onSetConfig?: (changes: Record<string, string>) => void;
  /** Max. Telegramme je `/getLogByLogNumber`-Antwort. Vorgabe 50 (Original). */
  maxLogBatch?: number;
}

const SET_CONFIG_FELDER = ['ccuip', 'hostname', 'ntp', 'ip', 'netmask', 'gw'];
const MAX_BODY_BYTES = 65_536;

/** Erste externe IPv4-Schnittstelle — für die Info-Ansicht der App. */
function ersteSchnittstelle(): { ip: string; netmask: string; mac: string } {
  for (const eintraege of Object.values(networkInterfaces())) {
    for (const e of eintraege ?? []) {
      if (!e.internal && e.family === 'IPv4') {
        return { ip: e.address, netmask: e.netmask, mac: e.mac };
      }
    }
  }
  return { ip: '', netmask: '', mac: '' };
}

export class ApiServer {
  readonly #opts: ApiServerOptions;
  readonly #time: TimeSource;
  readonly #config: ApiConfig;
  readonly #server: Server;
  readonly #maxBatch: number;
  #boottime = 0;

  constructor(options: ApiServerOptions) {
    this.#opts = options;
    this.#time = options.time ?? systemTime;
    this.#config = { ...options.config };
    this.#maxBatch = options.maxLogBatch ?? 50;
    this.#server = createServer((req, res) => {
      void this.#verteilen(req, res);
    });
  }

  /** Startet auf `host:port`; `port 0` wählt einen freien (Tests). */
  listen(port: number, host = '127.0.0.1'): Promise<{ host: string; port: number }> {
    this.#boottime = this.#time.now();
    return new Promise((resolve, reject) => {
      this.#server.once('error', reject);
      this.#server.listen(port, host, () => {
        const adr = this.#server.address() as AddressInfo;
        resolve({ host: adr.address, port: adr.port });
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.#server.close((err) => {
        if (err === undefined) resolve();
        else reject(err);
      });
      this.#server.closeAllConnections();
    });
  }

  async #verteilen(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      await this.#route(req, res);
    } catch (err) {
      if (!res.headersSent) {
        this.#text(res, 500, `Interner Fehler: ${String(err)}`);
      } else {
        res.end();
      }
    }
  }

  async #route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://intern');
    const pfad = url.pathname;
    const methode = req.method ?? 'GET';

    // ---- Kompatibilitätssatz: Datenabruf (GET) --------------------------
    if (methode === 'GET') {
      switch (pfad) {
        case '/getLogByLogNumber':
          return this.#getLog(url, res);
        case '/getRSSILog':
          return this.#getRssiLog(url, res);
        case '/getConfig':
          return this.#json(res, 200, this.#configAntwort());
        case '/getAskSinAnalyzerDevListJSON': {
          const json = this.#opts.devList?.json;
          if (json === undefined || json === null) {
            return this.#text(res, 503, 'Geräteliste (noch) nicht verfügbar');
          }
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(json);
          return;
        }
        case '/downloadcsv':
          return this.#tagesCsv(res, dayOf(this.#time.now()));
        case '/download': {
          const datei = url.searchParams.get('filename') ?? '';
          const m = /^(\d{8})\.csv$/.exec(datei);
          if (m === null) {
            return this.#text(res, 400, 'filename muss yyyymmdd.csv sein');
          }
          return this.#tagesCsv(res, m[1]!);
        }
        case '/insertSD':
        case '/ejectSD':
        case '/listSD':
          // SD-Karte gibt es nicht; die App erfährt das über sdcardavailable.
          return this.#text(res, 200, 'OK');
        case '/api/snapshot':
          return this.#json(res, 200, this.#opts.analyzer.snapshot(this.#time.now()));
        case '/api/health':
          return this.#json(res, 200, this.#health());
      }
    }

    // ---- Kompatibilitätssatz: Kommandos (POST, ggf. mit Auth) -----------
    if (methode === 'POST') {
      switch (pfad) {
        case '/setConfig':
          if (!this.#autorisiert(req, res)) return;
          return this.#setConfig(req, url, res);
        case '/reboot':
          if (!this.#autorisiert(req, res)) return;
          if (this.#opts.onReboot === undefined) {
            return this.#text(res, 501, 'Kein Neustart-Mechanismus konfiguriert');
          }
          this.#text(res, 200, 'OK');
          setImmediate(this.#opts.onReboot);
          return;
        case '/rebootInConfigMode':
          // WLAN-Config-Portal des ESP — auf dem Pi sinnlos.
          return this.#text(res, 501, 'Auf dem Raspberry Pi nicht vorhanden');
        case '/formatspiffs': {
          if (!this.#autorisiert(req, res)) return;
          const db = this.#opts.db;
          db.exec('DELETE FROM telegrams');
          db.exec('DELETE FROM noise_minutes');
          db.exec('DELETE FROM device_hours');
          db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
          return this.#text(res, 200, 'OK');
        }
        case '/deletecsv': {
          if (!this.#autorisiert(req, res)) return;
          const { fromTs, toTs } = dayRange(dayOf(this.#time.now()));
          this.#opts.db
            .prepare('DELETE FROM telegrams WHERE ts >= ? AND ts < ?')
            .run(fromTs, toTs);
          return this.#text(res, 200, 'OK');
        }
      }
    }

    this.#text(res, 404, `Unbekannter Endpunkt: ${methode} ${pfad}`);
  }

  // ---- Datenabruf ------------------------------------------------------

  #getLog(url: URL, res: ServerResponse): void {
    const lognum = Number(url.searchParams.get('lognum') ?? 0) || 0;
    const rows = this.#opts.db
      .prepare(
        `SELECT rowid AS lognumber, ts, rssi, len, cnt, flags, type, from_addr, to_addr
         FROM telegrams WHERE rowid > ? ORDER BY rowid LIMIT ?`,
      )
      .all(lognum, this.#maxBatch) as unknown as TelegramRow[];
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8' });
    res.end(rows.map(toCsvLine).join('\n'));
  }

  #getRssiLog(url: URL, res: ServerResponse): void {
    const roh = url.searchParams.get('fromTstamp');
    // Ohne Angabe: letzte 24 h — sonst wären es bei 90 Tagen Retention
    // 130 000 Einträge in einer Antwort.
    const fromSec =
      roh === null || Number.isNaN(Number(roh))
        ? Math.floor(this.#time.now() / 1000) - 86_400
        : Number(roh);
    const rows = this.#opts.db
      .prepare(
        `SELECT minute, samples, sum_rssi FROM noise_minutes
         WHERE minute >= ? ORDER BY minute`,
      )
      .all(Math.ceil(fromSec / 60)) as unknown as NoiseMinuteRow[];
    this.#json(res, 200, rows.map(toRssiLogEntry));
  }

  #tagesCsv(res: ServerResponse, yyyymmdd: string): void {
    const { fromTs, toTs } = dayRange(yyyymmdd);
    const rows = this.#opts.db
      .prepare(
        `SELECT rowid AS lognumber, ts, rssi, len, cnt, flags, type, from_addr, to_addr
         FROM telegrams WHERE ts >= ? AND ts < ? ORDER BY rowid`,
      )
      .all(fromTs, toTs) as unknown as TelegramRow[];
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${yyyymmdd}.csv"`,
    });
    res.end(rows.map(toCsvLine).join('\n'));
  }

  // ---- Konfiguration ---------------------------------------------------

  /** Alle Felder, die die App auswertet (§2.3) — SD/SPIFFS sinnvoll umgedeutet. */
  #configAntwort(): Record<string, unknown> {
    const { upper, lower } = toVersionParts(this.#opts.version ?? '0.0.1');
    const netz = ersteSchnittstelle();
    const seite = this.#opts.db.prepare('PRAGMA page_size').get() as {
      page_size: number;
    };
    const anzahl = this.#opts.db.prepare('PRAGMA page_count').get() as {
      page_count: number;
    };
    const dbKb = Math.ceil((seite.page_size * anzahl.page_count) / 1024);
    return {
      version_upper: upper,
      version_lower: lower,
      display: 0,
      ccuip: this.#config.ccuip ?? '',
      hostname: hostname(),
      ntp: this.#config.ntp ?? '',
      ip: netz.ip,
      netmask: netz.netmask,
      gw: '',
      macaddress: netz.mac,
      resolve: this.#opts.devList === undefined ? 0 : 1,
      boottime: Math.floor(this.#boottime / 1000),
      rssi_hbw: 0,
      rssi_alarmcount: this.#config.rssiAlarmCount ?? 0,
      rssi_alarmthreshold: this.#config.rssiAlarmThreshold ?? 0,
      sdcardavailable: 0,
      sdcardsizemb: 0,
      sdcardtotalspacemb: 0,
      sdcardusedspacemb: 0,
      // SPIFFS des ESP ≙ unserer SQLite-Datei — die Info-Ansicht zeigt damit
      // die tatsächliche Datenbankgröße.
      spiffssizekb: dbKb,
      spiffsusedkb: dbKb,
      staticipconfig: 0,
      ccuhttps: 0,
      backend: 0,
      backendurl: '',
    };
  }

  async #setConfig(
    req: IncomingMessage,
    url: URL,
    res: ServerResponse,
  ): Promise<void> {
    const body = await this.#leseBody(req);
    const bodyParams = new URLSearchParams(body);
    const änderungen: Record<string, string> = {};
    for (const feld of SET_CONFIG_FELDER) {
      const wert = bodyParams.get(feld) ?? url.searchParams.get(feld);
      if (wert !== null) änderungen[feld] = wert;
    }
    // Direkt wirksam wird nur, was der Core selbst verantwortet; Netzwerk
    // und Hostname des Pi setzt — wenn gewünscht — der onSetConfig-Empfänger.
    if (änderungen['ccuip'] !== undefined) this.#config.ccuip = änderungen['ccuip'];
    if (änderungen['ntp'] !== undefined) this.#config.ntp = änderungen['ntp'];
    this.#opts.onSetConfig?.(änderungen);
    this.#text(res, 200, 'OK');
  }

  // ---- Eigene API ------------------------------------------------------

  #health(): Record<string, unknown> {
    const now = this.#time.now();
    const s = this.#opts.analyzer.snapshot(now);
    return {
      ok: true,
      version: this.#opts.version ?? '0.0.1',
      now,
      boottime: this.#boottime,
      connected: s.ingest.connected,
      telegrams: s.ingest.telegrams,
      droppedLines: s.ingest.droppedLines,
      persistErrors: s.persistErrors,
      devListSource: s.devList?.source ?? null,
    };
  }

  // ---- Hilfen ----------------------------------------------------------

  /** true = weitermachen; false = 401 ist bereits gesendet. */
  #autorisiert(req: IncomingMessage, res: ServerResponse): boolean {
    const token = this.#opts.authToken;
    if (token === undefined) return true;
    if (req.headers.authorization === `Bearer ${token}`) return true;
    res.writeHead(401, { 'WWW-Authenticate': 'Bearer' });
    res.end('Auth-Token erforderlich');
    return false;
  }

  #leseBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const teile: Buffer[] = [];
      let bytes = 0;
      req.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_BODY_BYTES) {
          reject(new Error('Body zu groß'));
          req.destroy();
          return;
        }
        teile.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(teile).toString('utf8')));
      req.on('error', reject);
    });
  }

  #text(res: ServerResponse, status: number, body: string): void {
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(body);
  }

  #json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  }
}
