/**
 * DevListService — holt die Geräteliste zyklisch von der CCU und hält sie
 * als `DeviceResolver` bereit.
 *
 * Ablauf beim Start:
 *
 *   1. **Datei-Cache lesen** (falls konfiguriert): Der Analyzer soll nach
 *      einem Neustart sofort Namen zeigen, auch wenn die CCU gerade nicht
 *      erreichbar ist — Datenschrank-Realität.
 *   2. **Abrufschleife**: CCU fragen, bei Erfolg Resolver tauschen und den
 *      Cache atomar (tmp + rename) neu schreiben, dann `refreshMs` warten.
 *      Bei Fehlern bleibt der letzte Resolver stehen; nächster Versuch nach
 *      `retryMs`.
 *
 * Der HTTP-Abruf ist injizierbar (`fetchBytes`) — Tests speisen die echte
 * Drahtform (latin1 + XML + HTML-Escapes, siehe ccuResponse.ts) direkt ein.
 * Gecacht wird der **dekodierte JSON-String**: beim Lesen läuft er durch
 * dieselbe `parseDevList`-Validierung wie eine frische CCU-Antwort.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { systemTime } from '../ingest/time.ts';
import type { TimeSource } from '../ingest/time.ts';
import { decodeCcuResponse } from './ccuResponse.ts';
import { DeviceResolver, parseDevList } from './devlist.ts';
import { holen } from '../net/holen.ts';

/**
 * URL des ReGa-Abrufs. Die Anführungszeichen MÜSSEN als %22 kodiert sein —
 * alles andere (Punkte, Klammern) bleibt wörtlich stehen, so erwartet es
 * das TCL-CGI der CCU (verifiziert gegen die echte Anlage).
 */
export function buildDevListUrl(host: string): string {
  return (
    `http://${host}:8181/a.exe?ret=` +
    'dom.GetObject(ID_SYSTEM_VARIABLES)' +
    '.Get(%22AskSinAnalyzerDevList%22).Value()'
  );
}

export type FetchBytes = (
  url: string,
  signal: AbortSignal,
) => Promise<Uint8Array>;

/** Standard-Abruf über globales fetch — Bytes, NICHT als Text dekodieren. */
export const httpFetchBytes: FetchBytes = async (url, signal) => {
  // Erst lesen, dann urteilen — sonst bleibt die Antwort bei jedem Fehler
  // der CCU liegen.
  const a = await holen(url, { signal });
  if (!a.ok) {
    throw new Error(`CCU-Abruf: HTTP ${a.status}`);
  }
  return a.bytes;
};

/** Woher der aktuell gehaltene Resolver stammt. */
export type DevListSource = 'ccu' | 'cache';

export interface DevListServiceOptions {
  /** Hostname oder IP der CCU/RaspberryMatic. */
  host: string;
  /** Pfad der Cache-Datei; ohne Angabe wird nicht gecacht. */
  cachePath?: string;
  /** Abstand erfolgreicher Abrufe. Vorgabe: 1 Stunde. */
  refreshMs?: number;
  /** Wartezeit nach einem Fehlschlag. Vorgabe: 5 Minuten. */
  retryMs?: number;
  fetchBytes?: FetchBytes;
  time?: TimeSource;
  /** Nach jedem Resolver-Tausch — auch für den Cache-Treffer beim Start. */
  onUpdate?: (resolver: DeviceResolver, source: DevListSource) => void;
  onError?: (error: unknown) => void;
}

export interface DevListStats {
  /** Quelle des aktuellen Resolvers; null solange keiner geladen ist. */
  source: DevListSource | null;
  fetches: number;
  failures: number;
  lastSuccessAt: number | null;
  lastErrorAt: number | null;
}

export class DevListService {
  readonly #opts: DevListServiceOptions;
  readonly #time: TimeSource;
  readonly #fetch: FetchBytes;
  readonly #refreshMs: number;
  readonly #retryMs: number;

  #resolver: DeviceResolver | null = null;
  #json: string | null = null;
  #source: DevListSource | null = null;
  #fetches = 0;
  #failures = 0;
  #lastSuccessAt: number | null = null;
  #lastErrorAt: number | null = null;

  #stop: AbortController | null = null;
  #laufend: Promise<void> | null = null;

  constructor(options: DevListServiceOptions) {
    this.#opts = options;
    this.#time = options.time ?? systemTime;
    this.#fetch = options.fetchBytes ?? httpFetchBytes;
    this.#refreshMs = options.refreshMs ?? 3_600_000;
    this.#retryMs = options.retryMs ?? 300_000;
  }

  /** Der aktuelle Resolver — null, bis Cache oder CCU geliefert haben. */
  get resolver(): DeviceResolver | null {
    return this.#resolver;
  }

  /** Die Liste als validierter JSON-String (für den Kompat-Endpunkt). */
  get json(): string | null {
    return this.#json;
  }

  /** Anzeigename; ohne Resolver die Hex-Adresse wie im Sniffer-Log. */
  nameOf(address: number): string {
    return (
      this.#resolver?.nameOf(address) ??
      address.toString(16).toUpperCase().padStart(6, '0')
    );
  }

  /**
   * Steht diese Adresse in der Geräteliste der Zentrale?
   *
   * Die Frage hinter der Frage lautet: „Ist das überhaupt eines meiner
   * Geräte?" Im Funk liegen die Anlagen der Nachbarschaft mit auf dem Band,
   * und ihre Telegramme sehen genauso aus wie die eigenen — nur der Name
   * fehlt. Ohne Kennzeichnung sucht man irgendwann nach einem Gerät, das
   * einem gar nicht gehört.
   *
   * `false`, solange gar keine Liste vorliegt: Dann ist nichts als fremd
   * belegbar, und eine Kennzeichnung auf Verdacht wäre schlimmer als keine.
   */
  kennt(address: number): boolean {
    return this.#resolver?.resolve(address) !== undefined;
  }

  get stats(): DevListStats {
    return {
      source: this.#source,
      fetches: this.#fetches,
      failures: this.#failures,
      lastSuccessAt: this.#lastSuccessAt,
      lastErrorAt: this.#lastErrorAt,
    };
  }

  /** Startet Cache-Laden und Abrufschleife. Läuft bis `stop()`. */
  start(): void {
    if (this.#laufend !== null) throw new Error('DevListService läuft bereits');
    this.#ladeCache();
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

  #ladeCache(): void {
    const pfad = this.#opts.cachePath;
    if (pfad === undefined) return;
    let json: string;
    try {
      json = readFileSync(pfad, 'utf8');
    } catch {
      return; // kein Cache — normal beim allerersten Start
    }
    try {
      this.#uebernehmen(json, 'cache');
    } catch (err) {
      // Kaputte Cache-Datei ist ein Fehler, aber kein Startabbruch:
      // die Abrufschleife holt sich frische Daten.
      this.#opts.onError?.(err);
    }
  }

  async #run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      let wartezeit = this.#retryMs;
      try {
        this.#fetches++;
        const raw = await this.#fetch(buildDevListUrl(this.#opts.host), signal);
        if (signal.aborted) return;
        this.#uebernehmen(decodeCcuResponse(raw), 'ccu');
        this.#lastSuccessAt = this.#time.now();
        wartezeit = this.#refreshMs;
      } catch (err) {
        if (signal.aborted) return;
        this.#failures++;
        this.#lastErrorAt = this.#time.now();
        this.#opts.onError?.(err);
      }
      try {
        await this.#time.delay(wartezeit, signal);
      } catch {
        return;
      }
    }
  }

  /** JSON validieren, Resolver tauschen, ggf. Cache schreiben, melden. */
  #uebernehmen(json: string, source: DevListSource): void {
    const resolver = new DeviceResolver(parseDevList(json));
    this.#resolver = resolver;
    this.#json = json;
    this.#source = source;
    if (source === 'ccu') this.#schreibeCache(json);
    this.#opts.onUpdate?.(resolver, source);
  }

  #schreibeCache(json: string): void {
    const pfad = this.#opts.cachePath;
    if (pfad === undefined) return;
    try {
      mkdirSync(dirname(pfad), { recursive: true });
      // Atomar: erst vollständig schreiben, dann umbenennen. Ein Stromausfall
      // mittendrin hinterlässt so nie eine halbe Cache-Datei.
      const tmp = `${pfad}.tmp`;
      writeFileSync(tmp, json, 'utf8');
      renameSync(tmp, pfad);
    } catch (err) {
      // Cache ist Komfort, kein Muss — Fehler melden, aber weiterlaufen.
      this.#opts.onError?.(err);
    }
  }
}
