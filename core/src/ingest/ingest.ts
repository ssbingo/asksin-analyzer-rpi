/**
 * Serial-Ingest: liest den Zeilenstrom des Sniffers, robust im Dauerbetrieb.
 *
 * Aufbau je Verbindung („Session"):
 *
 *   Port ──Bytes──▶ LineSplitter ──Zeilen──▶ BoundedQueue ──▶ Dispatcher
 *                                                              (parseLine,
 *                                                               Zähler,
 *                                                               onLine)
 *
 * Drei Schleifen laufen nebeneinander: der **Leser** (füllt die Queue, wirft
 * bei Überlauf die ältesten Zeilen weg), der **Dispatcher** (parst und ruft
 * den Verbraucher) und der **Watchdog**. Letzterer nutzt aus, dass der
 * Sniffer alle 750 ms eine Rauschzeile sendet: bleibt der Strom länger als
 * `silenceTimeoutMs` still, ist die Strecke tot — Port zu, neu verbinden.
 * Das ist der wichtigste Fehlerdetektor überhaupt, denn eine fest verdrahtete
 * Pi-UART „trennt" sich nie sichtbar; sie verstummt nur.
 *
 * Reconnect mit exponentiellem Backoff. Wichtig: zurückgesetzt wird das
 * Backoff erst bei der ersten **gültigen** Zeile, nicht beim erfolgreichen
 * Öffnen — ein immer vorhandenes /dev/ttyAMA0 lässt sich auch dann öffnen,
 * wenn am anderen Ende gar nichts lebt.
 *
 * `connected` wird ebenfalls erst mit der ersten gültigen Zeile wahr — das
 * ist die Semantik von `info.connection` im Designdokument („Core/Sniffer
 * verbunden", nicht „Port offen").
 */

import { parseLine } from '../decode/parseLine.ts';
import { emptyIgnoreCounters } from '../decode/types.ts';
import type { IgnoreCounters, ParsedLine } from '../decode/types.ts';
import { LineSplitter } from './lineSplitter.ts';
import { BoundedQueue } from './queue.ts';
import { ExponentialBackoff, systemTime } from './time.ts';
import type { TimeSource } from './time.ts';

/** Ein geöffneter Port — bewusst minimal, damit Tests ihn leicht nachbauen. */
export interface IngestStream {
  readable: AsyncIterable<Uint8Array>;
  close(): void | Promise<void>;
}

export type PortOpener = (signal: AbortSignal) => Promise<IngestStream>;

export type DisconnectReason = 'eof' | 'error' | 'silence' | 'stopped';

export type StateChange =
  | { connected: true }
  | {
      connected: false;
      reason: DisconnectReason;
      error?: unknown;
      /** Wartezeit bis zum nächsten Versuch (fehlt bei `stopped`). */
      retryInMs?: number;
    };

export interface SerialIngestOptions {
  openPort: PortOpener;
  /** Wird für jede geparste Zeile gerufen — auch für verworfene. */
  onLine?: (line: ParsedLine) => void | Promise<void>;
  onStateChange?: (change: StateChange) => void;
  time?: TimeSource;
  /** Stille auf der Leitung, ab der die Verbindung als tot gilt. */
  silenceTimeoutMs?: number;
  queueCapacity?: number;
  maxLineLength?: number;
  backoff?: { baseMs?: number; capMs?: number; factor?: number };
}

export interface IngestStats {
  connected: boolean;
  /** Zeitstempel der ersten gültigen Zeile der laufenden Verbindung. */
  connectedSince: number | null;
  lines: number;
  telegrams: number;
  noise: number;
  ignored: IgnoreCounters;
  /** durch Queue-Überlauf verlorene Zeilen (Drop-Oldest) */
  droppedLines: number;
  overlongLines: number;
  partialLines: number;
  /** Ausnahmen aus dem onLine-Verbraucher (gefangen, gezählt, weiter) */
  consumerErrors: number;
  reconnects: number;
  lastLineAt: number | null;
}

export class SerialIngest {
  readonly #opts: Required<Pick<SerialIngestOptions, 'openPort'>> &
    SerialIngestOptions;
  readonly #time: TimeSource;
  readonly #silenceMs: number;
  readonly #backoff: ExponentialBackoff;
  #stop: AbortController | null = null;
  #laufend: Promise<void> | null = null;

  #connected = false;
  #connectedSince: number | null = null;
  #lines = 0;
  #telegrams = 0;
  #noise = 0;
  #ignored = emptyIgnoreCounters();
  #dropped = 0;
  #overlong = 0;
  #partial = 0;
  #consumerErrors = 0;
  #reconnects = 0;
  #lastLineAt: number | null = null;

  constructor(options: SerialIngestOptions) {
    this.#opts = options;
    this.#time = options.time ?? systemTime;
    this.#silenceMs = options.silenceTimeoutMs ?? 5000;
    this.#backoff = new ExponentialBackoff(options.backoff ?? {});
  }

  get stats(): IngestStats {
    return {
      connected: this.#connected,
      connectedSince: this.#connectedSince,
      lines: this.#lines,
      telegrams: this.#telegrams,
      noise: this.#noise,
      ignored: { ...this.#ignored },
      droppedLines: this.#dropped,
      overlongLines: this.#overlong,
      partialLines: this.#partial,
      consumerErrors: this.#consumerErrors,
      reconnects: this.#reconnects,
      lastLineAt: this.#lastLineAt,
    };
  }

  /** Startet die Dauer-Schleife. Läuft bis `stop()`. */
  start(): void {
    if (this.#laufend !== null) throw new Error('Ingest läuft bereits');
    this.#stop = new AbortController();
    this.#laufend = this.#run(this.#stop.signal);
  }

  async stop(): Promise<void> {
    if (this.#stop === null) return;
    this.#stop.abort(new Error('gestoppt'));
    try {
      await this.#laufend;
    } finally {
      this.#stop = null;
      this.#laufend = null;
    }
  }

  async #run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      let reason: DisconnectReason = 'eof';
      let fehler: unknown;

      try {
        const stream = await this.#opts.openPort(signal);
        try {
          reason = await this.#session(stream, signal);
        } finally {
          try {
            await stream.close();
          } catch {
            /* Schließen eines toten Ports darf nie zusätzlich knallen */
          }
        }
      } catch (err) {
        if (signal.aborted) break;
        reason = 'error';
        fehler = err;
      }

      if (signal.aborted) {
        this.#setDisconnected('stopped');
        return;
      }

      const wartezeit = this.#backoff.next();
      this.#reconnects++;
      this.#setDisconnected(reason, fehler, wartezeit);
      try {
        await this.#time.delay(wartezeit, signal);
      } catch {
        break;
      }
    }
    this.#setDisconnected('stopped');
  }

  /** Eine Verbindung von Datenbeginn bis Ende/Störung. */
  async #session(
    stream: IngestStream,
    signal: AbortSignal,
  ): Promise<DisconnectReason> {
    const splitter = new LineSplitter(this.#opts.maxLineLength ?? 1024);
    const queue = new BoundedQueue<string>(this.#opts.queueCapacity ?? 10_000);
    const sessionEnde = new AbortController();
    let lastDataAt = this.#time.now();
    let watchdogAusloesung = false;

    const onStop = () => {
      sessionEnde.abort(new Error('gestoppt'));
      // Ohne dieses close() hinge stop() für immer: ein for-await auf einem
      // Dateistrom endet erst, wenn der Strom zerstört wird.
      void stream.close();
    };
    if (signal.aborted) {
      // Ein bereits abgebrochenes Signal ruft nachträglich registrierte
      // Listener nie — wer stop() unmittelbar nach start() aufruft, würde
      // sonst für immer auf den nie geschlossenen Port warten.
      onStop();
    } else {
      signal.addEventListener('abort', onStop, { once: true });
    }

    // --- Watchdog: Stille erkennen, Port schließen -----------------------
    const pruefIntervall = Math.max(50, Math.min(this.#silenceMs / 2, 1000));
    const watchdog = (async () => {
      for (;;) {
        await this.#time.delay(pruefIntervall, sessionEnde.signal);
        if (this.#time.now() - lastDataAt > this.#silenceMs) {
          watchdogAusloesung = true;
          await stream.close();
          return;
        }
      }
    })().catch(() => {});

    // --- Dispatcher: Zeilen parsen und ausliefern ------------------------
    const dispatcher = (async () => {
      for (;;) {
        const zeile = await queue.take(sessionEnde.signal);
        await this.#verarbeiten(zeile);
      }
    })().catch(() => {});

    // --- Leser: Bytes → Splitter → Queue ---------------------------------
    let leseFehler: unknown;
    try {
      for await (const chunk of stream.readable) {
        lastDataAt = this.#time.now();
        for (const zeile of splitter.push(chunk)) {
          this.#dropped += queue.put(zeile);
        }
      }
    } catch (err) {
      leseFehler = err;
    }
    splitter.end();
    this.#overlong += splitter.overlongDropped;
    this.#partial += splitter.partialDropped;

    // Erst Dispatcher und Watchdog beenden, DANN den Rest der Queue
    // ausliefern. Andersherum entstünde ein Wettlauf: der Dispatcher schnappt
    // sich zwischen Größenprüfung und take() das letzte Element, und der
    // Drain wartete ohne Abbruchsignal für immer.
    sessionEnde.abort(new Error('Session beendet'));
    signal.removeEventListener('abort', onStop);
    await Promise.allSettled([watchdog, dispatcher]);

    while (queue.size > 0) {
      const zeile = await queue.take();
      await this.#verarbeiten(zeile);
    }

    if (signal.aborted) return 'stopped';
    if (watchdogAusloesung) return 'silence';
    if (leseFehler !== undefined) throw leseFehler;
    return 'eof';
  }

  async #verarbeiten(zeile: string): Promise<void> {
    this.#lines++;
    this.#lastLineAt = this.#time.now();
    const parsed = parseLine(zeile, () => this.#time.now());

    if (parsed.kind === 'telegram') this.#telegrams++;
    else if (parsed.kind === 'noise') this.#noise++;
    else this.#ignored[parsed.reason]++;

    if (parsed.kind !== 'ignored' && !this.#connected) {
      this.#connected = true;
      this.#connectedSince = this.#time.now();
      this.#backoff.reset();
      this.#opts.onStateChange?.({ connected: true });
    }

    try {
      await this.#opts.onLine?.(parsed);
    } catch {
      this.#consumerErrors++;
    }
  }

  #setDisconnected(
    reason: DisconnectReason,
    error?: unknown,
    retryInMs?: number,
  ): void {
    const war = this.#connected;
    this.#connected = false;
    this.#connectedSince = null;
    if (war || reason !== 'stopped') {
      const change: StateChange = { connected: false, reason };
      if (error !== undefined) change.error = error;
      if (retryInMs !== undefined) change.retryInMs = retryInMs;
      this.#opts.onStateChange?.(change);
    }
  }
}
