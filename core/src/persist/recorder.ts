/**
 * Recorder — schreibt den Telegrammstrom gebündelt in die Datenbank.
 *
 * Nicht jede Zeile einzeln committen: Bei ~40 Telegrammen/s plus Rauschen
 * würde jeder Commit ein fsync auf die SD-Karte bedeuten. Stattdessen sammelt
 * der Recorder und schreibt **eine Transaktion pro Flush** (nach `batchSize`
 * Telegrammen automatisch, sonst per `flush()` vom Dienst-Takt).
 *
 * Aggregat-Schreiben ist **delta-basiert**: Im Speicher stehen nur die
 * Zuwächse seit dem letzten Flush, geschrieben wird mit additivem Upsert
 * (`ON CONFLICT … DO UPDATE SET x = x + excluded.x`). Dadurch ist ein Absturz
 * verlustarm (höchstens ein Batch) und ein Neustart mitten in der Stunde
 * addiert korrekt weiter, statt vorhandene Teilsummen zu überschreiben.
 */

import type { DatabaseSync, StatementSync } from 'node:sqlite';

import { estimateAirtimeMs, isBurst } from '../analytics/dutyCycle.ts';
import type { ParsedLine, Telegram } from '../decode/types.ts';

export interface RecorderOptions {
  /** Automatischer Flush nach so vielen gepufferten Telegrammen. */
  batchSize?: number;
}

export interface RetentionOptions {
  /** Einzeltelegramme aufbewahren (Tage). */
  telegramsDays?: number;
  /** Rausch-Minutenaggregate aufbewahren (Tage). */
  noiseDays?: number;
  /** Geräte-Stundensummen aufbewahren (Tage). */
  deviceHoursDays?: number;
}

export interface RecorderStats {
  bufferedTelegrams: number;
  writtenTelegrams: number;
  flushes: number;
}

interface NoiseDelta {
  samples: number;
  min: number;
  max: number;
  sum: number;
}

interface HourDelta {
  telegrams: number;
  airtimeMs: number;
  min: number;
  max: number;
  sum: number;
}

const MINUTE_MS = 60_000;
const STUNDE_MS = 3_600_000;
const TAG_MS = 86_400_000;

export class Recorder {
  readonly #db: DatabaseSync;
  readonly #batchSize: number;

  readonly #insertTelegram: StatementSync;
  readonly #upsertNoise: StatementSync;
  readonly #upsertHour: StatementSync;

  #telegramme: Telegram[] = [];
  #noise = new Map<number, NoiseDelta>();
  #stunden = new Map<string, HourDelta>();
  #written = 0;
  #flushes = 0;

  constructor(db: DatabaseSync, options: RecorderOptions = {}) {
    this.#db = db;
    this.#batchSize = options.batchSize ?? 200;

    this.#insertTelegram = db.prepare(
      `INSERT INTO telegrams (ts, rssi, len, cnt, flags, type, from_addr, to_addr, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.#upsertNoise = db.prepare(
      `INSERT INTO noise_minutes (minute, samples, min_rssi, max_rssi, sum_rssi)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(minute) DO UPDATE SET
         samples  = samples + excluded.samples,
         min_rssi = MIN(min_rssi, excluded.min_rssi),
         max_rssi = MAX(max_rssi, excluded.max_rssi),
         sum_rssi = sum_rssi + excluded.sum_rssi`,
    );
    this.#upsertHour = db.prepare(
      `INSERT INTO device_hours (hour, addr, telegrams, airtime_ms, min_rssi, max_rssi, sum_rssi)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(hour, addr) DO UPDATE SET
         telegrams  = telegrams + excluded.telegrams,
         airtime_ms = airtime_ms + excluded.airtime_ms,
         min_rssi   = MIN(min_rssi, excluded.min_rssi),
         max_rssi   = MAX(max_rssi, excluded.max_rssi),
         sum_rssi   = sum_rssi + excluded.sum_rssi`,
    );
  }

  get stats(): RecorderStats {
    return {
      bufferedTelegrams: this.#telegramme.length,
      writtenTelegrams: this.#written,
      flushes: this.#flushes,
    };
  }

  /** Direkt als `onLine` des Ingest verwendbar. */
  record(line: ParsedLine): void {
    if (line.kind === 'noise') {
      const minute = Math.floor(line.noise.ts / MINUTE_MS);
      const delta = this.#noise.get(minute);
      const rssi = line.noise.rssi;
      if (delta === undefined) {
        this.#noise.set(minute, { samples: 1, min: rssi, max: rssi, sum: rssi });
      } else {
        delta.samples++;
        delta.sum += rssi;
        if (rssi < delta.min) delta.min = rssi;
        if (rssi > delta.max) delta.max = rssi;
      }
      return;
    }
    if (line.kind !== 'telegram') return;

    const t = line.telegram;
    this.#telegramme.push(t);

    const stunde = Math.floor(t.ts / STUNDE_MS);
    const key = `${stunde}:${t.fromAddr}`;
    const airtime = estimateAirtimeMs(t.length, isBurst(t));
    const delta = this.#stunden.get(key);
    if (delta === undefined) {
      this.#stunden.set(key, {
        telegrams: 1,
        airtimeMs: airtime,
        min: t.rssi,
        max: t.rssi,
        sum: t.rssi,
      });
    } else {
      delta.telegrams++;
      delta.airtimeMs += airtime;
      delta.sum += t.rssi;
      if (t.rssi < delta.min) delta.min = t.rssi;
      if (t.rssi > delta.max) delta.max = t.rssi;
    }

    if (this.#telegramme.length >= this.#batchSize) this.flush();
  }

  /** Alles Gepufferte in einer Transaktion schreiben. */
  flush(): void {
    if (
      this.#telegramme.length === 0 &&
      this.#noise.size === 0 &&
      this.#stunden.size === 0
    ) {
      return;
    }
    this.#db.exec('BEGIN');
    try {
      for (const t of this.#telegramme) {
        this.#insertTelegram.run(
          t.ts, t.rssi, t.length, t.msgCounter, t.flags, t.msgType,
          t.fromAddr, t.toAddr, t.payloadHex,
        );
      }
      for (const [minute, d] of this.#noise) {
        this.#upsertNoise.run(minute, d.samples, d.min, d.max, d.sum);
      }
      for (const [key, d] of this.#stunden) {
        const [stunde, addr] = key.split(':');
        this.#upsertHour.run(
          Number(stunde), Number(addr),
          d.telegrams, d.airtimeMs, d.min, d.max, d.sum,
        );
      }
      this.#db.exec('COMMIT');
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    }
    this.#written += this.#telegramme.length;
    this.#flushes++;
    this.#telegramme = [];
    this.#noise.clear();
    this.#stunden.clear();
  }

  /**
   * Alte Daten entfernen und das WAL eindampfen. Vom Dienst z. B. täglich
   * aufzurufen; `now` injizierbar für Tests.
   */
  cleanup(
    retention: RetentionOptions = {},
    now: number = Date.now(),
  ): { telegrams: number; noiseMinutes: number; deviceHours: number } {
    this.flush();
    const tage = {
      telegrams: retention.telegramsDays ?? 30,
      noise: retention.noiseDays ?? 90,
      hours: retention.deviceHoursDays ?? 365,
    };
    const t = this.#db
      .prepare('DELETE FROM telegrams WHERE ts < ?')
      .run(now - tage.telegrams * TAG_MS);
    const n = this.#db
      .prepare('DELETE FROM noise_minutes WHERE minute < ?')
      .run(Math.floor((now - tage.noise * TAG_MS) / MINUTE_MS));
    const h = this.#db
      .prepare('DELETE FROM device_hours WHERE hour < ?')
      .run(Math.floor((now - tage.hours * TAG_MS) / STUNDE_MS));
    this.#db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    return {
      telegrams: Number(t.changes),
      noiseMinutes: Number(n.changes),
      deviceHours: Number(h.changes),
    };
  }
}
