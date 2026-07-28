/**
 * Begrenzte Warteschlange mit Drop-Oldest.
 *
 * Entkoppelt den Leser (serieller Port) von den Verbrauchern (Parser,
 * Analytics, später WebSocket). Läuft ein Verbraucher dem Funk hinterher,
 * wächst nicht der Speicher, sondern es fallen die **ältesten** Zeilen weg —
 * die neuesten sind für Live-Anzeige und Watchdog die wertvolleren
 * (Designdok, Abschnitt 7 „Backpressure").
 */

export class BoundedQueue<T> {
  readonly #capacity: number;
  #items: T[] = [];
  #head = 0;
  #takers: Array<{
    resolve: (value: T) => void;
    reject: (reason: unknown) => void;
    cleanup: () => void;
  }> = [];

  constructor(capacity: number) {
    if (capacity < 1) throw new Error('BoundedQueue: capacity muss ≥ 1 sein');
    this.#capacity = capacity;
  }

  get size(): number {
    return this.#items.length - this.#head;
  }

  /**
   * Element einreihen. Liefert die Anzahl dabei verworfener alter Elemente
   * (0 oder 1) — der Aufrufer zählt sie als Selbstmetrik.
   */
  put(item: T): number {
    const taker = this.#takers.shift();
    if (taker !== undefined) {
      taker.cleanup();
      taker.resolve(item);
      return 0;
    }
    let dropped = 0;
    if (this.size >= this.#capacity) {
      this.#head++;
      dropped = 1;
    }
    this.#items.push(item);
    this.#kompaktieren();
    return dropped;
  }

  /** Nächstes Element; wartet, bis eines da ist. Bricht mit dem Signal ab. */
  take(signal?: AbortSignal): Promise<T> {
    if (this.size > 0) {
      const item = this.#items[this.#head]!;
      this.#head++;
      this.#kompaktieren();
      return Promise.resolve(item);
    }
    if (signal?.aborted) {
      return Promise.reject(signal.reason ?? new Error('abgebrochen'));
    }
    return new Promise<T>((resolve, reject) => {
      const eintrag = { resolve, reject, cleanup: () => {} };
      if (signal !== undefined) {
        const onAbort = () => {
          const i = this.#takers.indexOf(eintrag);
          if (i !== -1) this.#takers.splice(i, 1);
          reject(signal.reason ?? new Error('abgebrochen'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        eintrag.cleanup = () => signal.removeEventListener('abort', onAbort);
      }
      this.#takers.push(eintrag);
    });
  }

  clear(): void {
    this.#items = [];
    this.#head = 0;
  }

  #kompaktieren(): void {
    if (this.#head > 1024 && this.#head * 2 > this.#items.length) {
      this.#items = this.#items.slice(this.#head);
      this.#head = 0;
    }
  }
}
