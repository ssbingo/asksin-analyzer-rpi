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

export const SCHEMA_VERSION = 3;

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
  2: `
    -- Zigbee (M16). Eigene Tabellen, nicht in die BidCoS-Tabellen gemischt:
    -- Eine BidCoS-Adresse hat drei Byte, eine Zigbee-Kurzadresse zwei und
    -- eine IEEE-Adresse acht. In einer Spalte saehen sie gleich aus und
    -- waeren es nicht — der Fehler faellt erst auf, wenn eine Auswertung
    -- still das Falsche zaehlt.
    --
    -- Adressen als TEXT (Hex, gross, ohne Praefix): 4 Stellen fuer eine
    -- Kurzadresse, 16 fuer eine IEEE-Adresse. Als INTEGER waere eine
    -- IEEE-Adresse ein Vorzeichenproblem, und die fuehrende Null einer
    -- Kurzadresse ginge verloren.
    CREATE TABLE zigbee_packets (
      ts      INTEGER NOT NULL,   -- Empfangszeit, ms seit Epoch
      kanal   INTEGER NOT NULL,   -- 11..26
      rssi    INTEGER NOT NULL,   -- dBm, negativ
      lqi     INTEGER NOT NULL,   -- 0..255
      laenge  INTEGER NOT NULL,   -- Byte einschliesslich Pruefsumme
      typ     INTEGER NOT NULL,   -- Rahmenart aus dem FCF: 0..3
      seq     INTEGER NOT NULL,
      pan     INTEGER,            -- NULL bei Bestaetigungen (tragen keine)
      von     TEXT,               -- NULL bei Bestaetigungen
      an      TEXT,
      rundruf INTEGER NOT NULL    -- 0/1
    ) STRICT;
    CREATE INDEX idx_zigbee_packets_ts ON zigbee_packets (ts);
    CREATE INDEX idx_zigbee_packets_von ON zigbee_packets (pan, von, ts);

    -- Stundensummen je Geraet.
    --
    -- 'schwach' zaehlt Pakete mit LQI unter 50. Das ist keine willkuerliche
    -- Grenze: Am 18.08.2026 wurden 47 827 Pakete einer Stunde ausgewertet,
    -- und LQI bricht unterhalb von etwa -87 dBm als Kante ein — oberhalb
    -- 77..255, unterhalb 0..20. Ein Mittelwert allein verdeckt genau das.
    --
    -- Warum nicht der Median: Der laesst sich aus Summen nicht bilden. Ueber
    -- eine Stunde ist der Mittelwert unkritisch (anders als Minimum und
    -- Maximum, die jeden Ausreisser zur Bewertung erheben) — und 'schwach'
    -- liefert den Anteil, auf den es ankommt.
    CREATE TABLE zigbee_device_hours (
      hour     INTEGER NOT NULL,  -- Epoch-Stunde
      pan      INTEGER NOT NULL,
      addr     TEXT    NOT NULL,
      pakete   INTEGER NOT NULL,
      schwach  INTEGER NOT NULL,  -- davon mit LQI < 50
      min_rssi INTEGER NOT NULL,
      max_rssi INTEGER NOT NULL,
      sum_rssi INTEGER NOT NULL,
      min_lqi  INTEGER NOT NULL,
      max_lqi  INTEGER NOT NULL,
      sum_lqi  INTEGER NOT NULL,
      PRIMARY KEY (hour, pan, addr)
    ) STRICT;
  `,
  3: `
    -- Kurzadresse -> IEEE-Adresse (M16.7).
    --
    -- Zigbee überträgt die IEEE-Adresse des Absenders im NWK-Kopf, und zwar
    -- **unverschlüsselt**: gemessen in 13 936 von 28 017 Datenrahmen einer
    -- Stunde. Der Mithörer lernt die Zuordnung damit von selbst — er muss
    -- weder den Koordinator fragen noch einen Netzschlüssel kennen.
    --
    -- Erst über die IEEE-Adresse lassen sich Namen anhängen: deCONZ kennt
    -- Kurzadressen gar nicht, nur IEEE-Adressen.
    --
    -- Die IEEE-Adresse gehört in den Primärschlüssel, nicht bloss in eine
    -- Spalte. Eine Kurzadresse wird beim Neuanmelden neu vergeben und kann im
    -- Lauf der Zeit auf verschiedene Geräte zeigen; mit ihr allein als
    -- Schlüssel wäre die Historie stillschweigend überschrieben. So stehen
    -- beide Zuordnungen da, und die Abfrage entscheidet anhand von 'zuletzt',
    -- welche gilt.
    CREATE TABLE zigbee_adressen (
      pan     INTEGER NOT NULL,
      addr    TEXT    NOT NULL,   -- Kurzadresse, vier Hexstellen
      ieee    TEXT    NOT NULL,   -- sechzehn Hexstellen
      gesehen INTEGER NOT NULL,
      zuerst  INTEGER NOT NULL,
      zuletzt INTEGER NOT NULL,
      PRIMARY KEY (pan, addr, ieee)
    ) STRICT;
    CREATE INDEX idx_zigbee_adressen_ieee ON zigbee_adressen (ieee);
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
