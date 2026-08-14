/**
 * Analyzer — die Komposition aller Bausteine zur laufenden Kette:
 *
 *   Port ─▶ SerialIngest ─▶ Recorder (SQLite, Batch-Flush im Takt)
 *                       ├─▶ LiveStats (Grundrauschen, Tel./min, RSSI je Gerät)
 *                       ├─▶ DutyCycleTracker (1-h-Fenster je Absender)
 *                       └─▶ onLine-Durchreiche (später: WebSocket-Live-Feed)
 *
 *   DevListService ─▶ Namen/Seriennummern für snapshot()
 *
 * Der Analyzer besitzt seine Teile: `start()` fährt Ingest, DevList-Abruf,
 * Flush- und Aufräumtakt hoch, `stop()` alles in umgekehrter Reihenfolge
 * wieder herunter — mit abschließendem Flush, damit beim Dienst-Stopp kein
 * gepufferter Batch verloren geht.
 *
 * `snapshot()` ist die eine Leseschnittstelle nach außen (M5 setzt REST/WS
 * darauf): Live-Zahlen, Persistenz-Zähler und je Gerät die Zusammenführung
 * aus RSSI-Statistik, Duty-Cycle und aufgelöstem Namen.
 */

import type { DatabaseSync } from 'node:sqlite';

import { DutyCycleTracker } from '../analytics/dutyCycle.ts';
import { LiveStats } from '../analytics/liveStats.ts';
import type { NoiseFloor } from '../analytics/liveStats.ts';
import type { Firmwareantwort, ParsedLine } from '../decode/types.ts';
import { SerialIngest } from '../ingest/ingest.ts';
import type {
  IngestStats,
  PortOpener,
  SerialIngestOptions,
  StateChange,
} from '../ingest/ingest.ts';
import { systemTime } from '../ingest/time.ts';
import type { TimeSource } from '../ingest/time.ts';
import { Recorder } from '../persist/recorder.ts';
import type { RecorderStats, RetentionOptions } from '../persist/recorder.ts';
import type { DeviceKind } from '../resolve/devlist.ts';
import type { DevListService, DevListStats } from '../resolve/fetcher.ts';

export interface AnalyzerOptions {
  openPort: PortOpener;
  /** Bereits geöffnete Datenbank (openDatabase) — der Analyzer schließt sie nicht. */
  db: DatabaseSync;
  /** Optional: Namensauflösung. Ohne CCU läuft alles mit Hex-Adressen weiter. */
  devList?: DevListService;
  time?: TimeSource;
  /** Takt des Recorder-Flushs. Vorgabe: 5 s. */
  flushIntervalMs?: number;
  /** Takt des Aufräumens (Retention + WAL-Checkpoint). Vorgabe: täglich. */
  cleanupIntervalMs?: number;
  retention?: RetentionOptions;
  /** Automatischer Recorder-Flush nach so vielen Telegrammen. */
  batchSize?: number;
  /** Durchgereichte Ingest-Feinheiten (Watchdog, Queue, Backoff). */
  ingest?: Pick<
    SerialIngestOptions,
    'silenceTimeoutMs' | 'queueCapacity' | 'maxLineLength' | 'backoff'
  >;
  /** Jede geparste Zeile, nach der internen Verbuchung — für Live-Feeds. */
  onLine?: (line: ParsedLine) => void;
  /**
   * Die rohe Zeile vor dem Parsen — für den Mitschnitt (Grundlinie vor
   * Firmware-Änderungen). Läuft im heißen Pfad; siehe SerialIngestOptions.
   */
  onRawLine?: (zeile: string, ts: number) => void;
  onStateChange?: (change: StateChange) => void;
  /**
   * Auskunft der Firmware — Fassung, Funkmodul, wiederhergestellter Empfang.
   *
   * Der Dienst schreibt sie ins Protokoll. Besonders `art: 'empfang'` gehört
   * dorthin: Ein Analyzer, der sich stillschweigend selbst heilt, verbirgt
   * einen Hardwarefehler.
   */
  onFirmware?: (antwort: Firmwareantwort) => void;
  /** Fehler aus Flush/Aufräumtakt (werden gezählt, stoppen nichts). */
  onError?: (error: unknown) => void;
}

/** Ein Gerät im Snapshot: Live-Statistik plus aufgelöste Identität. */
export interface DeviceSnapshot {
  addr: number;
  /** 6-stellige Hex-Adresse, wie der Sniffer sie zeigt. */
  address: string;
  /** Aufgelöster Name; ohne DevList-Treffer die Hex-Adresse. */
  name: string;
  serial: string | null;
  kind: DeviceKind | null;
  isHmIp: boolean | null;
  rssi: { last: number; min: number; max: number; ewma: number };
  lastSeen: number;
  telegrams: number;
  /** Duty-Cycle in Prozent des 1-%-Kontingents (gleitende Stunde). */
  dutyCyclePercent: number;
}

export interface AnalyzerSnapshot {
  ts: number;
  ingest: IngestStats;
  recorder: RecorderStats;
  noiseFloor: NoiseFloor;
  telegramsPerMinute: number;
  /** null, wenn kein DevListService konfiguriert ist. */
  devList:
    | (DevListStats & { createdAt: number | null; entries: number | null })
    | null;
  /** Fehler aus Flush-/Aufräumtakt seit dem Start. */
  persistErrors: number;
  /** Nach zuletzt gesehen sortiert, wie devices() der LiveStats. */
  devices: DeviceSnapshot[];
}

const TAG_MS = 86_400_000;

export class Analyzer {
  readonly #opts: AnalyzerOptions;
  readonly #time: TimeSource;
  readonly #live = new LiveStats();
  readonly #duty = new DutyCycleTracker();
  readonly #recorder: Recorder;
  readonly #ingest: SerialIngest;

  #persistErrors = 0;
  #stop: AbortController | null = null;
  #takte: Promise<void>[] = [];

  constructor(options: AnalyzerOptions) {
    this.#opts = options;
    this.#time = options.time ?? systemTime;
    this.#recorder = new Recorder(
      options.db,
      options.batchSize === undefined ? {} : { batchSize: options.batchSize },
    );

    const ingestOptionen: SerialIngestOptions = {
      ...options.ingest,
      openPort: options.openPort,
      onLine: (line) => {
        this.#verbuchen(line);
      },
      time: this.#time,
    };
    if (options.onStateChange !== undefined) {
      ingestOptionen.onStateChange = options.onStateChange;
    }
    if (options.onFirmware !== undefined) {
      ingestOptionen.onFirmware = options.onFirmware;
    }
    if (options.onRawLine !== undefined) {
      ingestOptionen.onRawLine = options.onRawLine;
    }
    this.#ingest = new SerialIngest(ingestOptionen);
  }

  #verbuchen(line: ParsedLine): void {
    this.#recorder.record(line);
    this.#live.record(line);
    if (line.kind === 'telegram') this.#duty.addTelegram(line.telegram);
    this.#opts.onLine?.(line);
  }

  /** Fährt Ingest, DevList-Abruf und Takte hoch. Läuft bis `stop()`. */
  start(): void {
    if (this.#stop !== null) throw new Error('Analyzer läuft bereits');
    this.#stop = new AbortController();
    const signal = this.#stop.signal;

    this.#ingest.start();
    this.#opts.devList?.start();

    this.#takte = [
      this.#takt(this.#opts.flushIntervalMs ?? 5000, signal, () => {
        this.#recorder.flush();
      }),
      this.#takt(this.#opts.cleanupIntervalMs ?? TAG_MS, signal, () => {
        this.#recorder.cleanup(this.#opts.retention ?? {}, this.#time.now());
      }),
    ];
  }

  async stop(): Promise<void> {
    if (this.#stop === null) return;
    this.#stop.abort(new Error('gestoppt'));
    await Promise.allSettled(this.#takte);
    this.#takte = [];
    this.#stop = null;

    await this.#ingest.stop();
    await this.#opts.devList?.stop();
    // Letzter Flush NACH dem Ingest-Stopp: dessen Queue-Drain kann noch
    // Zeilen verbucht haben, die sonst im Puffer verloren gingen.
    try {
      this.#recorder.flush();
    } catch (err) {
      this.#persistErrors++;
      this.#opts.onError?.(err);
    }
  }

  /** Wiederkehrende Arbeit im festen Takt; Fehler zählen, nie sterben. */
  async #takt(
    intervalMs: number,
    signal: AbortSignal,
    arbeit: () => void,
  ): Promise<void> {
    for (;;) {
      try {
        await this.#time.delay(intervalMs, signal);
      } catch {
        return;
      }
      try {
        arbeit();
      } catch (err) {
        this.#persistErrors++;
        this.#opts.onError?.(err);
      }
    }
  }

  /** Der eine Lese-Einstieg für API und Anzeige. */
  snapshot(now: number = this.#time.now()): AnalyzerSnapshot {
    const devListDienst = this.#opts.devList;
    const resolver = devListDienst?.resolver ?? null;

    const devices: DeviceSnapshot[] = this.#live.devices().map((g) => {
      const eintrag = resolver?.resolve(g.addr);
      return {
        addr: g.addr,
        address: g.addr.toString(16).toUpperCase().padStart(6, '0'),
        name: devListDienst?.nameOf(g.addr) ??
          g.addr.toString(16).toUpperCase().padStart(6, '0'),
        serial: eintrag?.serial ?? null,
        kind: eintrag?.kind ?? null,
        isHmIp: eintrag?.isHmIp ?? null,
        rssi: { last: g.last, min: g.min, max: g.max, ewma: g.ewma },
        lastSeen: g.lastSeen,
        telegrams: g.telegrams,
        dutyCyclePercent: this.#duty.get(g.addr, now),
      };
    });

    return {
      ts: now,
      ingest: this.#ingest.stats,
      recorder: this.#recorder.stats,
      noiseFloor: this.#live.noiseFloor,
      telegramsPerMinute: this.#live.telegramsPerMinute(now),
      devList:
        devListDienst === undefined
          ? null
          : {
              ...devListDienst.stats,
              createdAt: resolver?.createdAt.getTime() ?? null,
              entries: resolver?.size ?? null,
            },
      persistErrors: this.#persistErrors,
      devices,
    };
  }
}
