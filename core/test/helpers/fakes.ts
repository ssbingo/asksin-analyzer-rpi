/**
 * Geteilte Test-Attrappen: handgesteuerte Uhr und Port-Attrappe.
 * Kein Testfall wartet real — die Uhr wird geschoben.
 */

import { BoundedQueue } from '../../src/ingest/queue.ts';
import type { IngestStream } from '../../src/ingest/ingest.ts';
import type { TimeSource } from '../../src/ingest/time.ts';

export const tick = (): Promise<void> =>
  new Promise<void>((r) => setImmediate(r));

/** Handgesteuerte Uhr: delay() löst erst aus, wenn advance() sie erreicht. */
export class FakeTime implements TimeSource {
  #now = 1_000_000;
  #pending: Array<{ at: number; resolve: () => void }> = [];

  now(): number {
    return this.#now;
  }

  delay(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason ?? new Error('abgebrochen'));
        return;
      }
      const eintrag = { at: this.#now + ms, resolve };
      signal?.addEventListener(
        'abort',
        () => {
          const i = this.#pending.indexOf(eintrag);
          if (i !== -1) this.#pending.splice(i, 1);
          reject(signal.reason ?? new Error('abgebrochen'));
        },
        { once: true },
      );
      this.#pending.push(eintrag);
    });
  }

  /** Uhr vorstellen; fällige delays feuern in Zeitreihenfolge. */
  async advance(ms: number): Promise<void> {
    const ziel = this.#now + ms;
    for (;;) {
      await tick();
      const fällig = this.#pending
        .filter((e) => e.at <= ziel)
        .sort((a, b) => a.at - b.at)[0];
      if (fällig === undefined) break;
      this.#now = Math.max(this.#now, fällig.at);
      this.#pending.splice(this.#pending.indexOf(fällig), 1);
      fällig.resolve();
    }
    this.#now = ziel;
    await tick();
  }
}

/** Port-Attrappe: Bytes von Hand einspeisen, beenden oder scheitern lassen. */
export class FakePort implements IngestStream {
  #q = new BoundedQueue<Uint8Array | Error | null>(100_000);
  geschlossen = false;

  readable: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]: () => this.#lauf(),
  };

  async *#lauf(): AsyncGenerator<Uint8Array> {
    for (;;) {
      const chunk = await this.#q.take();
      if (chunk === null) return;
      if (chunk instanceof Error) throw chunk;
      yield chunk;
    }
  }

  feed(text: string): void {
    this.#q.put(Buffer.from(text, 'latin1'));
  }

  end(): void {
    this.#q.put(null);
  }

  fail(err: Error): void {
    this.#q.put(err);
  }

  close(): void {
    this.geschlossen = true;
    this.#q.put(null);
  }
}

/** CCU-Antwort im Original-Drahtformat bauen: latin1, XML-Hülle, HTML-Escapes. */
export function alsCcuAntwort(json: string): Uint8Array {
  const escaped = json.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
  const xml = `<xml><exec>x</exec><ret>${escaped}</ret></xml>`;
  return Uint8Array.from([...xml].map((c) => {
    const cp = c.codePointAt(0)!;
    return cp <= 0xff ? cp : 0x3f;
  }));
}
