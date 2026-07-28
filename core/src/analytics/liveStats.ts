/**
 * Live-Kennzahlen für den State-Baum (Designdok §6.2):
 *
 *   info.noiseFloor            ← Grundrauschen, geglättet + letzter Wert
 *   info.telegramsPerMinute    ← gleitende letzte 60 Sekunden
 *   devices.<x>.rssi/lastSeen  ← je Absender
 *
 * Alles rein aus den Zeitstempeln der Zeilen gerechnet — keine eigene Uhr,
 * dadurch trivial testbar und replayfest. (`msgPerHour` und `dutyCycle`
 * liefert bereits der DutyCycleTracker; hier steht nur, was dort fehlt.)
 */

import type { ParsedLine } from '../decode/types.ts';

export interface DeviceRssi {
  addr: number;
  /** letzter Empfangspegel in dBm */
  last: number;
  min: number;
  max: number;
  /** exponentiell geglättet — träge genug für eine ruhige Anzeige */
  ewma: number;
  lastSeen: number;
  telegrams: number;
}

export interface NoiseFloor {
  last: number | null;
  ewma: number | null;
  samples: number;
}

const SEKUNDE_MS = 1000;
const FENSTER_S = 60;

export class LiveStats {
  readonly #alpha: number;
  #noiseLast: number | null = null;
  #noiseEwma: number | null = null;
  #noiseSamples = 0;

  // 60 Sekunden-Eimer als Ring; `sec` entlarvt veraltete Einträge.
  readonly #eimer: Array<{ sec: number; count: number }> = Array.from(
    { length: FENSTER_S },
    () => ({ sec: -1, count: 0 }),
  );

  readonly #geraete = new Map<number, DeviceRssi>();

  constructor(options: { ewmaAlpha?: number } = {}) {
    this.#alpha = options.ewmaAlpha ?? 0.1;
  }

  record(line: ParsedLine): void {
    if (line.kind === 'noise') {
      this.#noiseLast = line.noise.rssi;
      this.#noiseSamples++;
      this.#noiseEwma =
        this.#noiseEwma === null
          ? line.noise.rssi
          : this.#noiseEwma + this.#alpha * (line.noise.rssi - this.#noiseEwma);
      return;
    }
    if (line.kind !== 'telegram') return;

    const t = line.telegram;
    const sec = Math.floor(t.ts / SEKUNDE_MS);
    const eimer = this.#eimer[sec % FENSTER_S]!;
    if (eimer.sec === sec) {
      eimer.count++;
    } else {
      eimer.sec = sec;
      eimer.count = 1;
    }

    const g = this.#geraete.get(t.fromAddr);
    if (g === undefined) {
      this.#geraete.set(t.fromAddr, {
        addr: t.fromAddr,
        last: t.rssi,
        min: t.rssi,
        max: t.rssi,
        ewma: t.rssi,
        lastSeen: t.ts,
        telegrams: 1,
      });
    } else {
      g.last = t.rssi;
      g.ewma = g.ewma + this.#alpha * (t.rssi - g.ewma);
      if (t.rssi < g.min) g.min = t.rssi;
      if (t.rssi > g.max) g.max = t.rssi;
      if (t.ts > g.lastSeen) g.lastSeen = t.ts;
      g.telegrams++;
    }
  }

  get noiseFloor(): NoiseFloor {
    return {
      last: this.#noiseLast,
      ewma: this.#noiseEwma === null ? null : Math.round(this.#noiseEwma * 10) / 10,
      samples: this.#noiseSamples,
    };
  }

  /** Telegramme der letzten 60 Sekunden, bezogen auf `now` (ms). */
  telegramsPerMinute(now: number): number {
    const aktuelleSec = Math.floor(now / SEKUNDE_MS);
    let summe = 0;
    for (const eimer of this.#eimer) {
      if (eimer.sec > aktuelleSec - FENSTER_S && eimer.sec <= aktuelleSec) {
        summe += eimer.count;
      }
    }
    return summe;
  }

  device(addr: number): DeviceRssi | undefined {
    const g = this.#geraete.get(addr);
    return g === undefined ? undefined : { ...g, ewma: Math.round(g.ewma * 10) / 10 };
  }

  devices(): DeviceRssi[] {
    return [...this.#geraete.values()]
      .map((g) => ({ ...g, ewma: Math.round(g.ewma * 10) / 10 }))
      .sort((a, b) => b.lastSeen - a.lastSeen);
  }

  get deviceCount(): number {
    return this.#geraete.size;
  }
}
