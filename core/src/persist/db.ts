/**
 * Datenbankzugang — eingebautes `node:sqlite`, keine native Abhängigkeit.
 *
 * Bewusst gegen `better-sqlite3` entschieden: Das eingebaute Modul (ab
 * Node 22, hier 24) beherrscht alles, was dieser Dienst braucht — WAL,
 * Prepared Statements, additive Upserts — und erspart Prebuilds je
 * Pi-Architektur. Die API ist nahezu deckungsgleich; ein Wechsel bliebe auf
 * diese Datei begrenzt.
 *
 * Einstellungen für den Dauerbetrieb auf SD-Karte (Designdok §7):
 *  - `journal_mode=WAL`: Leser blockieren Schreiber nicht, crash-sicher.
 *  - `synchronous=NORMAL`: fsync nur am WAL-Checkpoint. Im schlimmsten Fall
 *    (Stromausfall) fehlen die letzten Sekunden — verkraftbar für Messdaten,
 *    schont die Karte massiv.
 */

import { DatabaseSync } from 'node:sqlite';

export const SCHEMA_VERSION = 1;

const MIGRATIONEN: Record<number, string> = {
  1: `
    -- Jedes Telegramm einzeln: Grundlage für Live-Liste, Replays und alle
    -- späteren Auswertungen. 'raw' wird bewusst NICHT gespeichert — die Zeile
    -- ist aus den Feldern verlustfrei rekonstruierbar.
    CREATE TABLE telegrams (
      ts        INTEGER NOT NULL,   -- Empfangszeit, ms seit Epoch
      rssi      INTEGER NOT NULL,   -- dBm, negativ
      len       INTEGER NOT NULL,
      cnt       INTEGER NOT NULL,
      flags     INTEGER NOT NULL,
      type      INTEGER NOT NULL,
      from_addr INTEGER NOT NULL,
      to_addr   INTEGER NOT NULL,
      payload   TEXT    NOT NULL
    ) STRICT;
    CREATE INDEX idx_telegrams_ts ON telegrams (ts);
    CREATE INDEX idx_telegrams_from ON telegrams (from_addr, ts);

    -- Grundrauschen kommt alle 750 ms — als Einzelzeilen wären das 115 000
    -- Zeilen am Tag. Minutenaggregat reicht für Trend und Störerkennung.
    CREATE TABLE noise_minutes (
      minute    INTEGER PRIMARY KEY,  -- Epoch-Minute
      samples   INTEGER NOT NULL,
      min_rssi  INTEGER NOT NULL,
      max_rssi  INTEGER NOT NULL,
      sum_rssi  INTEGER NOT NULL
    ) STRICT;

    -- Stundensummen je Absender: Langzeit-Statistik, ohne Millionen
    -- Telegrammzeilen scannen zu müssen.
    CREATE TABLE device_hours (
      hour       INTEGER NOT NULL,   -- Epoch-Stunde
      addr       INTEGER NOT NULL,
      telegrams  INTEGER NOT NULL,
      airtime_ms REAL    NOT NULL,   -- geschätzte Sendezeit (Duty-Cycle-Basis)
      min_rssi   INTEGER NOT NULL,
      max_rssi   INTEGER NOT NULL,
      sum_rssi   INTEGER NOT NULL,
      PRIMARY KEY (hour, addr)
    ) STRICT;
  `,
};

export function openDatabase(pfad: string): DatabaseSync {
  const db = new DatabaseSync(pfad);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');

  const zeile = db.prepare('PRAGMA user_version').get() as
    | { user_version: number }
    | undefined;
  let version = zeile?.user_version ?? 0;

  while (version < SCHEMA_VERSION) {
    const ziel = version + 1;
    const sql = MIGRATIONEN[ziel];
    if (sql === undefined) {
      throw new Error(`Keine Migration auf Schema-Version ${ziel}`);
    }
    db.exec('BEGIN');
    try {
      db.exec(sql);
      db.exec(`PRAGMA user_version = ${ziel}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    version = ziel;
  }
  return db;
}
