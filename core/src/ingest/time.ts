/**
 * Injizierbare Zeitquelle.
 *
 * Aller zeitabhängige Code (Watchdog, Backoff-Wartezeiten) läuft gegen dieses
 * Interface statt gegen `Date.now`/`setTimeout` direkt — die Tests schieben
 * die Uhr von Hand und laufen dadurch in Millisekunden statt in Echtzeit
 * durch Reconnect-Szenarien.
 */

export interface TimeSource {
  /** Aktuelle Zeit in Millisekunden (Epoch — Telegramme tragen sie als `ts`). */
  now(): number;
  /** Wartet `ms`; bricht mit dem Grund des Signals ab. */
  delay(ms: number, signal?: AbortSignal): Promise<void>;
}

export const systemTime: TimeSource = {
  now: () => Date.now(),
  delay: (ms, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason ?? new Error('abgebrochen'));
        return;
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal?.reason ?? new Error('abgebrochen'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    }),
};

/** Exponentielles Backoff mit Obergrenze — bewusst ohne Zufallsanteil,
 *  damit Verhalten und Tests deterministisch bleiben (ein einzelner Client,
 *  kein Herdenproblem). */
export class ExponentialBackoff {
  readonly #baseMs: number;
  readonly #capMs: number;
  readonly #factor: number;
  #attempt = 0;

  constructor(opts: { baseMs?: number; capMs?: number; factor?: number } = {}) {
    this.#baseMs = opts.baseMs ?? 1000;
    this.#capMs = opts.capMs ?? 30_000;
    this.#factor = opts.factor ?? 2;
  }

  get attempt(): number {
    return this.#attempt;
  }

  /** Wartezeit für den nächsten Versuch; zählt den Versuch mit. */
  next(): number {
    this.#attempt++;
    const roh = this.#baseMs * this.#factor ** (this.#attempt - 1);
    return Math.min(this.#capMs, roh);
  }

  /** Nach erfolgreichem Datenempfang: von vorn zählen. */
  reset(): void {
    this.#attempt = 0;
  }
}
