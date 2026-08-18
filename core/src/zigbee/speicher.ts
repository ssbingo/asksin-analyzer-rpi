import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { ZigbeePaket } from './types.ts';

/**
 * Zigbee-Pakete in die Datenbank schreiben.
 *
 * Aufgebaut wie `persist/recorder.ts`, aber getrennt davon (E1): gepuffert,
 * in einer Transaktion, Stundensummen additiv über `ON CONFLICT … DO UPDATE`.
 * Dadurch ist ein Absturz zwischen zwei Schüben harmlos — es fehlen Zeilen,
 * aber nichts wird doppelt gezählt.
 *
 * Warum überhaupt gepuffert: Auf einer SD-Karte ist jeder einzelne Schreib-
 * vorgang teuer. Bei 13 Paketen je Sekunde wären das 13 Transaktionen je
 * Sekunde — gebündelt sind es zwei je Minute.
 */

/** Rahmenart als Zahl, wie im FCF. Spart Platz gegenüber Text. */
const TYP_ZU_ZAHL: Record<ZigbeePaket['typ'], number> = {
  beacon: 0,
  daten: 1,
  bestaetigung: 2,
  kommando: 3,
};

/**
 * Ab dieser Verbindungsgüte gilt ein Paket als schwach empfangen.
 *
 * Gemessen, nicht geschätzt: In 47 827 Paketen einer Stunde (18.08.2026)
 * bricht LQI unterhalb von etwa −87 dBm als Kante ein — oberhalb 77 bis 255,
 * unterhalb 0 bis 20. Dazwischen liegt fast nichts.
 */
export const LQI_SCHWACH = 50;

const STUNDE_MS = 3_600_000;

interface AdressDelta {
  pan: number;
  addr: string;
  ieee: string;
  gesehen: number;
  /** Getrennt gefuehrt: Ein Zeitstempel fuer beides waere immer der neueste. */
  zuerst: number;
  zuletzt: number;
}

interface StundenDelta {
  hour: number;
  pan: number;
  addr: string;
  pakete: number;
  schwach: number;
  minRssi: number;
  maxRssi: number;
  sumRssi: number;
  minLqi: number;
  maxLqi: number;
  sumLqi: number;
}

export interface ZigbeeSpeicherOptionen {
  /** Ab so vielen gepufferten Paketen wird geschrieben. */
  schub?: number;
  /**
   * Was mit Bestätigungen geschieht. Vorgabe: `zaehlen`.
   *
   * Eine Bestätigung trägt **weder Absender noch Empfänger noch Netz** —
   * nur Rahmenkopf, Folgenummer und Prüfsumme. Einer Geräteauswertung ist
   * sie damit nicht zuzuordnen; gespeichert wäre sie eine Zeile, die keine
   * Frage beantwortet.
   *
   * Gemessen am 18.08.2026 über eine Stunde echten Verkehr:
   *
   *   47 827 Pakete gesamt  ->  3,56 MB  ->  85 MB am Tag
   *   davon 19 804 Bestätigungen = **41 % der Zeilen**
   *
   * Die gesamte BidCoS-Datenbank desselben Analyzers ist 4,5 MB gross. Auf
   * einer SD-Karte ist der Unterschied kein Schönheitsfehler, sondern
   * Schreiblast. Deshalb werden Bestätigungen gezählt statt gespeichert.
   *
   * Wer sie doch braucht — etwa um über die Folgenummer zuzuordnen, welches
   * Gerät bestätigt hat — stellt auf `speichern`.
   */
  bestaetigungen?: 'speichern' | 'zaehlen';
}

export interface ZigbeeAufbewahrung {
  /** Einzelpakete — die wachsen am schnellsten. */
  paketeTage?: number;
  /** Stundensummen — klein, deshalb lange. */
  stundenTage?: number;
}

export interface ZigbeeSpeicherStats {
  gepuffert: number;
  geschrieben: number;
  schuebe: number;
  fehler: number;
  /** Bestätigungen, die gezählt statt gespeichert wurden. */
  bestaetigungen: number;
}

export class ZigbeeSpeicher {
  readonly #db: DatabaseSync;
  readonly #schub: number;
  readonly #ackSpeichern: boolean;
  readonly #einPaket: StatementSync;
  readonly #eineStunde: StatementSync;
  readonly #eineAdresse: StatementSync;

  #puffer: ZigbeePaket[] = [];
  #stunden = new Map<string, StundenDelta>();
  #adressen = new Map<string, AdressDelta>();
  #geschrieben = 0;
  #bestaetigungen = 0;
  #schuebe = 0;
  #fehler = 0;

  constructor(db: DatabaseSync, o: ZigbeeSpeicherOptionen = {}) {
    this.#db = db;
    this.#schub = o.schub ?? 200;
    this.#ackSpeichern = (o.bestaetigungen ?? 'zaehlen') === 'speichern';
    this.#einPaket = db.prepare(
      `INSERT INTO zigbee_packets
         (ts, kanal, rssi, lqi, laenge, typ, seq, pan, von, an, rundruf)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.#eineStunde = db.prepare(
      `INSERT INTO zigbee_device_hours
         (hour, pan, addr, pakete, schwach,
          min_rssi, max_rssi, sum_rssi, min_lqi, max_lqi, sum_lqi)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(hour, pan, addr) DO UPDATE SET
         pakete   = pakete   + excluded.pakete,
         schwach  = schwach  + excluded.schwach,
         min_rssi = MIN(min_rssi, excluded.min_rssi),
         max_rssi = MAX(max_rssi, excluded.max_rssi),
         sum_rssi = sum_rssi + excluded.sum_rssi,
         min_lqi  = MIN(min_lqi,  excluded.min_lqi),
         max_lqi  = MAX(max_lqi,  excluded.max_lqi),
         sum_lqi  = sum_lqi  + excluded.sum_lqi`,
    );
    this.#eineAdresse = db.prepare(
      `INSERT INTO zigbee_adressen (pan, addr, ieee, gesehen, zuerst, zuletzt)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(pan, addr, ieee) DO UPDATE SET
         gesehen = gesehen + excluded.gesehen,
         zuerst  = MIN(zuerst,  excluded.zuerst),
         zuletzt = MAX(zuletzt, excluded.zuletzt)`,
    );
  }

  get stats(): ZigbeeSpeicherStats {
    return {
      gepuffert: this.#puffer.length,
      geschrieben: this.#geschrieben,
      schuebe: this.#schuebe,
      fehler: this.#fehler,
      bestaetigungen: this.#bestaetigungen,
    };
  }

  /** Ein Paket vormerken. Geschrieben wird erst beim Schub. */
  aufnehmen(p: ZigbeePaket): void {
    if (p.typ === 'bestaetigung') {
      this.#bestaetigungen++;
      if (!this.#ackSpeichern) return;
    }
    this.#puffer.push(p);

    // Stundensumme nur für Pakete mit Absender und Netz — Bestätigungen
    // tragen beides nicht und gehören zu keinem Gerät.
    if (p.pan !== undefined && p.von !== undefined) {
      const hour = Math.floor(p.ts / STUNDE_MS);
      const pan = Number.parseInt(p.pan, 16);
      const schluessel = `${hour}|${pan}|${p.von}`;
      const vorhanden = this.#stunden.get(schluessel);
      if (vorhanden === undefined) {
        this.#stunden.set(schluessel, {
          hour, pan, addr: p.von,
          pakete: 1,
          schwach: p.lqi < LQI_SCHWACH ? 1 : 0,
          minRssi: p.rssi, maxRssi: p.rssi, sumRssi: p.rssi,
          minLqi: p.lqi, maxLqi: p.lqi, sumLqi: p.lqi,
        });
      } else {
        vorhanden.pakete++;
        if (p.lqi < LQI_SCHWACH) vorhanden.schwach++;
        if (p.rssi < vorhanden.minRssi) vorhanden.minRssi = p.rssi;
        if (p.rssi > vorhanden.maxRssi) vorhanden.maxRssi = p.rssi;
        vorhanden.sumRssi += p.rssi;
        if (p.lqi < vorhanden.minLqi) vorhanden.minLqi = p.lqi;
        if (p.lqi > vorhanden.maxLqi) vorhanden.maxLqi = p.lqi;
        vorhanden.sumLqi += p.lqi;
      }
    }

    // Zuordnung Kurzadresse -> IEEE, wenn das Paket sie mitträgt.
    // Bewusst der NWK-Absender und nicht der MAC-Absender: Bei einem
    // weitergereichten Paket ist der MAC-Absender der Weiterleiter, die
    // IEEE-Adresse im NWK-Kopf gehört aber zum Urheber.
    if (p.pan !== undefined && p.ieee !== undefined && p.nwkVon !== undefined) {
      const pan = Number.parseInt(p.pan, 16);
      const schluessel = `${pan}|${p.nwkVon}|${p.ieee}`;
      const vorhanden = this.#adressen.get(schluessel);
      if (vorhanden === undefined) {
        this.#adressen.set(schluessel, {
          pan, addr: p.nwkVon, ieee: p.ieee, gesehen: 1,
          zuerst: p.ts, zuletzt: p.ts,
        });
      } else {
        vorhanden.gesehen++;
        if (p.ts < vorhanden.zuerst) vorhanden.zuerst = p.ts;
        if (p.ts > vorhanden.zuletzt) vorhanden.zuletzt = p.ts;
      }
    }

    if (this.#puffer.length >= this.#schub) this.schreiben();
  }

  /**
   * Alles Vorgemerkte schreiben. Eine Transaktion für Pakete und Summen —
   * ein Absturz mittendrin lässt beides zusammen weg statt halb.
   */
  schreiben(): void {
    if (this.#puffer.length === 0 && this.#stunden.size === 0
        && this.#adressen.size === 0) return;
    const pakete = this.#puffer;
    const stunden = [...this.#stunden.values()];
    const adressen = [...this.#adressen.values()];
    this.#puffer = [];
    this.#stunden = new Map();
    this.#adressen = new Map();

    this.#db.exec('BEGIN');
    try {
      for (const p of pakete) {
        this.#einPaket.run(
          p.ts, p.kanal, p.rssi, p.lqi, p.laenge, TYP_ZU_ZAHL[p.typ], p.seq,
          p.pan === undefined ? null : Number.parseInt(p.pan, 16),
          p.von ?? null, p.an ?? null, p.rundruf ? 1 : 0,
        );
      }
      for (const s of stunden) {
        this.#eineStunde.run(
          s.hour, s.pan, s.addr, s.pakete, s.schwach,
          s.minRssi, s.maxRssi, s.sumRssi, s.minLqi, s.maxLqi, s.sumLqi,
        );
      }
      for (const a of adressen) {
        this.#eineAdresse.run(a.pan, a.addr, a.ieee, a.gesehen, a.zuerst, a.zuletzt);
      }
      this.#db.exec('COMMIT');
      this.#geschrieben += pakete.length;
      this.#schuebe++;
    } catch (err) {
      this.#db.exec('ROLLBACK');
      this.#fehler++;
      // Nicht erneut versuchen: Wer eine kaputte Zeile endlos wiederholt,
      // schreibt nie wieder etwas. Der Zähler macht es sichtbar.
      throw err;
    }
  }

  /** Alte Daten wegräumen. Liefert, wie viele Zeilen gelöscht wurden. */
  aufraeumen(
    aufbewahrung: ZigbeeAufbewahrung = {},
    jetzt: number = Date.now(),
  ): { pakete: number; stunden: number } {
    const tage = {
      pakete: aufbewahrung.paketeTage ?? 14,
      stunden: aufbewahrung.stundenTage ?? 365,
    };
    const paketeGrenze = jetzt - tage.pakete * 86_400_000;
    const stundenGrenze = Math.floor((jetzt - tage.stunden * 86_400_000) / STUNDE_MS);

    const p = this.#db
      .prepare('DELETE FROM zigbee_packets WHERE ts < ?')
      .run(paketeGrenze);
    const s = this.#db
      .prepare('DELETE FROM zigbee_device_hours WHERE hour < ?')
      .run(stundenGrenze);
    return { pakete: Number(p.changes), stunden: Number(s.changes) };
  }
}
