import { hasFlag } from '../decode/flags.ts';
import type { Telegram } from '../decode/types.ts';

/**
 * Duty-Cycle-Schätzung je Absender über ein gleitendes Stundenfenster.
 *
 * Die Formel ist 1:1 aus `reference/AskSinAnalyzerXS/app/src/DutyCyclePerTelegram.ts`
 * übernommen — bewusst, damit Werte mit der etablierten Referenz vergleichbar
 * bleiben. Abweichungen wären nicht mehr gegeneinander prüfbar.
 *
 * Zwei Dinge sind gegenüber der Referenz absichtlich anders:
 *
 * 1. **Ringpuffer fester Kapazität** statt einer unbegrenzt wachsenden Liste
 *    (Designdokument, Abschnitt 7 „Speicherbegrenzung").
 * 2. **`prune()` nach Wanduhr.** Die Referenz rechnet ausschließlich beim
 *    Eintreffen eines Telegramms neu. Ein Gerät, das verstummt, behält dort
 *    seinen letzten Duty-Cycle für immer. Hier fällt er über das Zeitfenster
 *    ab, auch ohne neuen Empfang.
 */

/** BidCoS sendet mit etwa 10 kbit/s → rund 0,81 ms je Byte. */
export const BIDCOS_MS_PER_BYTE = 0.81;

/** Ein Burst ersetzt die 4 Byte Präambel durch 360 ms Dauerträger. */
export const BURST_PREAMBLE_MS = 360;

/**
 * Erlaubt ist 1 % Sendezeit pro Stunde, also 36 000 ms. Ein Prozentpunkt
 * dieses Kontingents entspricht damit 360 ms Sendezeit.
 */
export const MS_PER_PERCENT = 360;

export const DUTY_CYCLE_WINDOW_MS = 3_600_000;

/**
 * Geschätzte Sendezeit eines Telegramms in Millisekunden.
 *
 * Das ist eine Rechnung aus Längenbyte und Datenrate, **kein Messwert**. Für
 * Trend und Alarm belastbar, als Absolutwert gegen die CCU-Anzeige zu
 * kalibrieren.
 */
export function estimateAirtimeMs(length: number, burst: boolean): number {
  return burst
    ? BURST_PREAMBLE_MS + (length + 7) * BIDCOS_MS_PER_BYTE
    : (length + 11) * BIDCOS_MS_PER_BYTE;
}

/** Anteil eines Telegramms am 1-%-Kontingent, in Prozentpunkten. */
export function airtimeToPercent(airtimeMs: number): number {
  return airtimeMs / MS_PER_PERCENT;
}

/**
 * Burst-Erkennung wie in der Referenz: bei HmIP-Telegrammen wertet
 * AskSinAnalyzerXS die Flags gar nicht aus, BURST greift dort also nie.
 */
export function isBurst(telegram: Telegram): boolean {
  return !telegram.isHmIp && hasFlag(telegram.flags, 'BURST');
}

export function telegramDutyCyclePercent(telegram: Telegram): number {
  return airtimeToPercent(estimateAirtimeMs(telegram.length, isBurst(telegram)));
}

export interface DutyCycleOptions {
  /** Fensterbreite in ms. Vorgabe: 1 Stunde. */
  windowMs?: number;
  /**
   * Obergrenze der Einträge je Gerät. Ein regelkonformes Gerät schafft in einer
   * Stunde höchstens rund 2 200 Telegramme (36 s Sendezeit / 16 ms Minimum).
   * 4 096 lässt Luft für Fehlverhalten und deckelt den Speicher trotzdem hart.
   */
  maxEntriesPerDevice?: number;
  /**
   * Nach so vielen Einfügungen wird die Summe exakt neu berechnet. Das
   * laufende Addieren und Subtrahieren von Gleitkommazahlen driftet im
   * Dauerbetrieb sonst langsam weg.
   */
  recomputeInterval?: number;
}

export interface DeviceDutyCycle {
  /** Absenderadresse numerisch. */
  addr: number;
  /** Absenderadresse als 6-stelliger Hex-String in Großbuchstaben. */
  address: string;
  /** Duty-Cycle in Prozent des 1-%-Kontingents, auf eine Stelle gerundet. */
  percent: number;
  /** Telegramme im aktuellen Fenster. */
  telegrams: number;
  /** Zeitstempel des letzten Telegramms. */
  lastSeen: number;
  /** Wie viele Einträge die Kapazitätsgrenze verworfen hat. */
  dropped: number;
}

interface DeviceRing {
  ts: Float64Array;
  dc: Float64Array;
  /** Index des ältesten Eintrags. */
  head: number;
  size: number;
  sum: number;
  sinceRecompute: number;
  dropped: number;
  lastSeen: number;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function toAddressHex(addr: number): string {
  return addr.toString(16).toUpperCase().padStart(6, '0');
}

export class DutyCycleTracker {
  readonly #windowMs: number;
  readonly #capacity: number;
  readonly #recomputeInterval: number;
  readonly #devices = new Map<number, DeviceRing>();

  constructor(options: DutyCycleOptions = {}) {
    this.#windowMs = options.windowMs ?? DUTY_CYCLE_WINDOW_MS;
    this.#capacity = options.maxEntriesPerDevice ?? 4096;
    this.#recomputeInterval = options.recomputeInterval ?? 512;
  }

  /**
   * Verbucht ein Telegramm und liefert den Duty-Cycle seines Absenders nach
   * dieser Buchung, in Prozent des 1-%-Kontingents.
   */
  addTelegram(telegram: Telegram): number {
    return this.add(telegram.fromAddr, telegram.ts, telegramDutyCyclePercent(telegram));
  }

  add(addr: number, ts: number, percent: number): number {
    let ring = this.#devices.get(addr);
    if (ring === undefined) {
      ring = {
        ts: new Float64Array(this.#capacity),
        dc: new Float64Array(this.#capacity),
        head: 0,
        size: 0,
        sum: 0,
        sinceRecompute: 0,
        dropped: 0,
        lastSeen: ts,
      };
      this.#devices.set(addr, ring);
    }

    this.#evictExpired(ring, ts);

    // Kapazität erschöpft: ältesten Eintrag verwerfen statt Speicher wachsen zu lassen.
    if (ring.size === this.#capacity) {
      this.#dropOldest(ring);
      ring.dropped++;
    }

    const slot = (ring.head + ring.size) % this.#capacity;
    ring.ts[slot] = ts;
    ring.dc[slot] = percent;
    ring.size++;
    ring.sum += percent;
    if (ts > ring.lastSeen) ring.lastSeen = ts;

    if (++ring.sinceRecompute >= this.#recomputeInterval) this.#recompute(ring);

    return round1(ring.sum);
  }

  /** Duty-Cycle eines Geräts, bezogen auf `now`. */
  get(addr: number, now: number): number {
    const ring = this.#devices.get(addr);
    if (ring === undefined) return 0;
    this.#evictExpired(ring, now);
    return round1(ring.sum);
  }

  /** Alle bekannten Geräte, bezogen auf `now`. Verstummte Geräte fallen heraus. */
  snapshot(now: number): DeviceDutyCycle[] {
    this.prune(now);
    const out: DeviceDutyCycle[] = [];
    for (const [addr, ring] of this.#devices) {
      out.push({
        addr,
        address: toAddressHex(addr),
        percent: round1(ring.sum),
        telegrams: ring.size,
        lastSeen: ring.lastSeen,
        dropped: ring.dropped,
      });
    }
    return out.sort((a, b) => b.percent - a.percent);
  }

  /**
   * Wirft abgelaufene Einträge weg und vergisst Geräte, von denen im Fenster
   * nichts mehr übrig ist. Regelmäßig aufrufen, sonst wächst die Map über die
   * Laufzeit mit jedem je gesehenen Gerät.
   */
  prune(now: number): void {
    for (const [addr, ring] of this.#devices) {
      this.#evictExpired(ring, now);
      if (ring.size === 0) this.#devices.delete(addr);
    }
  }

  /** Anzahl der aktuell geführten Geräte. */
  get deviceCount(): number {
    return this.#devices.size;
  }

  reset(): void {
    this.#devices.clear();
  }

  #evictExpired(ring: DeviceRing, now: number): void {
    // Grenze wie in der Referenz: `< now - windowMs`, exakt auf der Kante bleibt drin.
    const cutoff = now - this.#windowMs;
    let evicted = 0;
    while (ring.size > 0 && (ring.ts[ring.head] as number) < cutoff) {
      this.#dropOldest(ring);
      evicted++;
    }
    if (evicted > 0) {
      ring.sinceRecompute += evicted;
      if (ring.sinceRecompute >= this.#recomputeInterval) this.#recompute(ring);
    }
  }

  #dropOldest(ring: DeviceRing): void {
    ring.sum -= ring.dc[ring.head] as number;
    ring.head = (ring.head + 1) % this.#capacity;
    ring.size--;
    if (ring.size === 0) ring.sum = 0;
  }

  /** Summe exakt neu bilden — gegen die Drift der laufenden Gleitkommasumme. */
  #recompute(ring: DeviceRing): void {
    let sum = 0;
    for (let i = 0; i < ring.size; i++) {
      sum += ring.dc[(ring.head + i) % this.#capacity] as number;
    }
    ring.sum = sum;
    ring.sinceRecompute = 0;
  }
}
