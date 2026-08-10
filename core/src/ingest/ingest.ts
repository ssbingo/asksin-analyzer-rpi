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
import type { Firmwareantwort, IgnoreCounters, ParsedLine } from '../decode/types.ts';
import { Folgezaehler } from './folge.ts';
import type { Folgestatistik } from './folge.ts';
import { LineSplitter } from './lineSplitter.ts';
import { BoundedQueue } from './queue.ts';
import { ExponentialBackoff, systemTime } from './time.ts';
import type { TimeSource } from './time.ts';

/** Ein geöffneter Port — bewusst minimal, damit Tests ihn leicht nachbauen. */
export interface IngestStream {
  readable: AsyncIterable<Uint8Array>;
  close(): void | Promise<void>;
  /**
   * Auf die Schnittstelle schreiben — für Befehle an die Firmware.
   *
   * Optional, weil der Analyzer jahrelang ausschließlich gelesen hat und die
   * alte Firmware nichts entgegennimmt. Fehlt die Methode, unterbleibt die
   * Freischaltung und alles läuft wie bisher.
   */
  schreibe?(text: string): void | Promise<void>;
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
  /**
   * Die **rohe** Zeile, bevor sie geparst wird — für den Mitschnitt.
   *
   * Getrennt von `onLine`, weil der Zweck ein anderer ist: `onLine` liefert
   * Ausgewertetes, hier soll genau das ankommen, was auf der Leitung stand.
   * Für einen Vorher-Nachher-Vergleich zweier Firmware-Fassungen ist gerade
   * das Unausgewertete interessant — auch und besonders die Zeilen, die der
   * Parser später verwirft.
   *
   * Absichtlich synchron und ohne Fehlerbehandlung: Der Mitschnitt darf den
   * Datenstrom weder bremsen noch stören. Wer hier eine Ausnahme wirft, legt
   * die Ingest-Schleife lahm — der Schreiber puffert deshalb und fängt selbst.
   */
  onRawLine?: (zeile: string, ts: number) => void;
  onStateChange?: (change: StateChange) => void;
  time?: TimeSource;
  /** Stille auf der Leitung, ab der die Verbindung als tot gilt. */
  silenceTimeoutMs?: number;
  /**
   * Nach dem Verbindungsaufbau die erweiterte Firmware freischalten
   * (`:?;` und `:E1;`). Vorgabe: an.
   *
   * Antwortet nichts, läuft die alte Firmware — dann bleibt alles beim
   * Alten, ohne Fehlermeldung. Das Ausbleiben der Antwort IST die Auskunft.
   */
  erweiterungAnfordern?: boolean;
  /** Wird gerufen, wenn die Firmware ihre Auskunft gibt. */
  onFirmware?: (antwort: Firmwareantwort) => void;
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
  /**
   * Auswertung der Folgenummern — nur mit erweiterter Firmware.
   * `gesehen === 0` heißt: Die Firmware liefert keine Nummern.
   */
  folge: Folgestatistik;
  /** Läuft die Gegenstelle im erweiterten Betrieb? */
  erweitert: boolean;
  /** Letzte Auskunft der Firmware, oder null bei der Originalfassung. */
  firmware: Firmwareantwort | null;
  /** Zeitpunkt der letzten Versionsfrage; null = noch nie gefragt. */
  firmwareGefragtAm: number | null;
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
  readonly #folge = new Folgezaehler();
  #erweitert = false;
  #firmware: Firmwareantwort | null = null;
  /**
   * Wann die Versionsfrage zuletzt hinausging — oder null, wenn noch nie.
   *
   * Ohne diesen Zeitpunkt liesse sich "noch keine Antwort da" nicht von
   * "es kommt keine" unterscheiden, und der Analyzer behauptete unmittelbar
   * nach dem Start, es laufe die Originalfassung. Genau das ist am
   * 10.08.2026 an zwei Geraeten passiert: Nach einem Dienst-Neustart stand
   * die falsche Auskunft da, nach einem Kaltstart die richtige.
   */
  #firmwareGefragtAm: number | null = null;
  /** Der offene Port der laufenden Sitzung — für Befehle an die Firmware. */
  #strom: IngestStream | null = null;

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
      folge: this.#folge.stats(),
      erweitert: this.#erweitert,
      firmware: this.#firmware,
      firmwareGefragtAm: this.#firmwareGefragtAm,
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
    this.#strom = stream;
    // Bei jedem Neuaufbau von vorn: Die Firmware faengt nach einem Neustart
    // wieder bei 0 an, und eine ueber die Trennung hinweg fortgefuehrte
    // Rechnung ergaebe einen Scheinverlust in Groessenordnung des ganzen
    // Zahlenraums.
    this.#folge.zuruecksetzen();
    this.#erweitert = false;
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
    const jetzt = this.#time.now();
    this.#lastLineAt = jetzt;

    // Vor dem Parsen: Der Mitschnitt soll die Leitung sehen, nicht unsere
    // Deutung davon. Ein Fehler hier darf den Empfang nicht anhalten.
    if (this.#opts.onRawLine) {
      try {
        this.#opts.onRawLine(zeile, jetzt);
      } catch {
        this.#consumerErrors++;
      }
    }

    const parsed = parseLine(zeile, () => this.#time.now());

    if (parsed.kind === 'telegram') this.#telegrams++;
    else if (parsed.kind === 'noise') this.#noise++;
    // Antworten der Firmware zählen weder als Nutzdaten noch als Fehler —
    // sie sind das, wonach gefragt wurde.
    else if (parsed.kind === 'ignored') this.#ignored[parsed.reason]++;

    if (parsed.kind === 'antwort') {
      this.#verbucheAntwort(parsed.antwort);
    } else if (parsed.kind !== 'ignored' && parsed.folge !== undefined) {
      this.#folge.melde(parsed.folge);
    }

    if (parsed.kind !== 'ignored' && !this.#connected) {
      this.#connected = true;
      this.#connectedSince = this.#time.now();
      this.#backoff.reset();
      this.#opts.onStateChange?.({ connected: true });
      // Erst jetzt fragen, nicht schon beim Öffnen des Ports: Ein
      // /dev/ttyAMA0 lässt sich auch dann öffnen, wenn am anderen Ende
      // nichts lebt. Die erste gültige Zeile ist der Beleg, dass jemand da
      // ist und zuhören kann.
      void this.#freischalten();
    }

    try {
      await this.#opts.onLine?.(parsed);
    } catch {
      this.#consumerErrors++;
    }
  }

  #verbucheAntwort(antwort: Firmwareantwort): void {
    if (antwort.art === 'version') {
      this.#firmware = antwort;
    } else if (antwort.art === 'erweitert') {
      this.#erweitert = antwort.an;
    }
    this.#opts.onFirmware?.(antwort);
  }

  /**
   * Fragt die Firmware und schaltet die Erweiterungen frei.
   *
   * Schlägt fehl oder bleibt unbeantwortet, passiert nichts weiter — dann
   * läuft die Originalfassung, und alles bleibt wie seit Jahren. Das
   * Ausbleiben der Antwort ist selbst die Auskunft und kein Fehler.
   */
  async #freischalten(): Promise<void> {
    if (this.#opts.erweiterungAnfordern === false) return;
    const strom = this.#strom;
    if (strom?.schreibe === undefined) return;
    try {
      this.#firmwareGefragtAm = this.#time.now();
      await strom.schreibe(':?;');
      await strom.schreibe(':E1;');
    } catch {
      // Der Empfang ist wichtiger als die Freischaltung. Ein Schreibfehler
      // darf die Verbindung nicht kosten.
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
