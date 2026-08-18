import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDatabase, SCHEMA_VERSION } from '../src/persist/db.ts';
import { Recorder } from '../src/persist/recorder.ts';
import { parseLine } from '../src/decode/parseLine.ts';
import { estimateAirtimeMs } from '../src/analytics/dutyCycle.ts';

const T0 = 1_785_300_000_000;

const TELEGRAMM = ':5A0E0100701A2B3C0000000102030405;';   // len 14, kein Burst
const BURST = ':641005100111111122222201020304050607;';    // len 16, BURST
const NOISE = ':5B;';                                       // −91 dBm

function zeile(raw: string, ts: number) {
  return parseLine(raw, () => ts);
}

// ---------------------------------------------------------------- Schema

test('openDatabase: WAL, synchronous=NORMAL, Migration auf Version 1', () => {
  const dir = mkdtempSync(join(tmpdir(), 'asksin-db-'));
  const pfad = join(dir, 'test.db');
  try {
    const db = openDatabase(pfad);
    const modus = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    assert.equal(modus.journal_mode, 'wal');
    const sync = db.prepare('PRAGMA synchronous').get() as { synchronous: number };
    assert.equal(sync.synchronous, 1, 'NORMAL');
    const version = db.prepare('PRAGMA user_version').get() as { user_version: number };
    assert.equal(version.user_version, SCHEMA_VERSION);

    // Zweites Öffnen migriert nicht erneut und zerstört nichts:
    db.close();
    const db2 = openDatabase(pfad);
    const tabellen = db2
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
      .all() as Array<{ name: string }>;
    // Vollstaendig verglichen, nicht nur "enthaelt": Eine Tabelle, die
    // unbemerkt dazukommt, ist ein Schemawechsel — und der gehoert in eine
    // Migration und in diese Zeile, nicht in einen Zufallsfund im Betrieb.
    assert.deepEqual(
      tabellen.map((t) => t.name),
      [
        'device_hours', 'noise_minutes', 'telegrams',
        // Schema 2 (M16): Zigbee, bewusst getrennt von den BidCoS-Tabellen.
        'zigbee_device_hours', 'zigbee_packets',
      ],
    );
    db2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- Recorder

test('Telegramme landen feldgenau in der Datenbank', () => {
  const db = openDatabase(':memory:');
  const rec = new Recorder(db);
  rec.record(zeile(TELEGRAMM, T0));
  rec.flush();

  const row = db.prepare('SELECT * FROM telegrams').get() as Record<string, unknown>;
  assert.equal(row['ts'], T0);
  assert.equal(row['rssi'], -90);
  assert.equal(row['len'], 14);
  assert.equal(row['cnt'], 1);
  assert.equal(row['type'], 0x70);
  assert.equal(row['from_addr'], 0x1a2b3c);
  assert.equal(row['to_addr'], 0);
  assert.equal(row['payload'], '0102030405');
  db.close();
});

test('Rauschen wird je Minute aggregiert, nicht je Zeile gespeichert', () => {
  const db = openDatabase(':memory:');
  const rec = new Recorder(db);
  // drei Proben in Minute A, eine in Minute B
  rec.record(zeile(':5B;', T0));            // −91
  rec.record(zeile(':50;', T0 + 10_000));   // −80
  rec.record(zeile(':64;', T0 + 20_000));   // −100
  rec.record(zeile(':5B;', T0 + 60_000));
  rec.flush();

  const rows = db
    .prepare('SELECT * FROM noise_minutes ORDER BY minute')
    .all() as Array<Record<string, number>>;
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!['samples'], 3);
  assert.equal(rows[0]!['min_rssi'], -100);
  assert.equal(rows[0]!['max_rssi'], -80);
  assert.equal(rows[0]!['sum_rssi'], -271);
  assert.equal(rows[1]!['samples'], 1);
  db.close();
});

test('Stundensummen: Deltas addieren über Flushes hinweg korrekt', () => {
  const db = openDatabase(':memory:');
  const rec = new Recorder(db);

  rec.record(zeile(TELEGRAMM, T0));
  rec.record(zeile(TELEGRAMM, T0 + 1000));
  rec.flush();
  // Neustart mitten in der Stunde simulieren: neuer Recorder, gleiche DB.
  const rec2 = new Recorder(db);
  rec2.record(zeile(TELEGRAMM, T0 + 2000));
  rec2.flush();

  const row = db
    .prepare('SELECT * FROM device_hours WHERE addr = ?')
    .get(0x1a2b3c) as Record<string, number>;
  assert.equal(row['telegrams'], 3, 'additiver Upsert, kein Überschreiben');
  const airtime1 = estimateAirtimeMs(14, false);
  assert.ok(Math.abs(row['airtime_ms']! - 3 * airtime1) < 1e-9);
  assert.equal(row['min_rssi'], -90);
  assert.equal(row['sum_rssi'], -270);
  db.close();
});

test('Burst-Telegramme gehen mit Burst-Airtime in die Stundensumme ein', () => {
  const db = openDatabase(':memory:');
  const rec = new Recorder(db);
  rec.record(zeile(BURST, T0));
  rec.flush();
  const row = db
    .prepare('SELECT airtime_ms FROM device_hours WHERE addr = ?')
    .get(0x111111) as { airtime_ms: number };
  assert.ok(Math.abs(row.airtime_ms - estimateAirtimeMs(16, true)) < 1e-9);
  assert.ok(row.airtime_ms > 360, 'Burst-Präambel enthalten');
  db.close();
});

test('batchSize löst den Flush automatisch aus', () => {
  const db = openDatabase(':memory:');
  const rec = new Recorder(db, { batchSize: 3 });
  rec.record(zeile(TELEGRAMM, T0));
  rec.record(zeile(TELEGRAMM, T0 + 1));
  assert.equal(rec.stats.writtenTelegrams, 0, 'noch gepuffert');
  rec.record(zeile(TELEGRAMM, T0 + 2));
  assert.equal(rec.stats.writtenTelegrams, 3, 'Batch voll → geschrieben');
  assert.equal(rec.stats.flushes, 1);
  assert.equal(rec.stats.bufferedTelegrams, 0);
  db.close();
});

test('leerer flush() schreibt nichts und zählt keinen Flush', () => {
  const db = openDatabase(':memory:');
  const rec = new Recorder(db);
  rec.flush();
  assert.equal(rec.stats.flushes, 0);
  db.close();
});

test('verworfene Zeilen erzeugen keine Datenbankzeilen', () => {
  const db = openDatabase(':memory:');
  const rec = new Recorder(db);
  rec.record(zeile('AskSin++ Bootmeldung', T0));
  rec.record(zeile(':kaputt;', T0));
  rec.flush();
  const n = db.prepare('SELECT COUNT(*) c FROM telegrams').get() as { c: number };
  assert.equal(n.c, 0);
  db.close();
});

test('cleanup: Retention je Tabelle, Neues bleibt stehen', () => {
  const db = openDatabase(':memory:');
  const rec = new Recorder(db);
  const alt = T0 - 40 * 86_400_000;      // 40 Tage alt
  rec.record(zeile(TELEGRAMM, alt));
  rec.record(zeile(NOISE, alt));
  rec.record(zeile(TELEGRAMM, T0));
  rec.record(zeile(NOISE, T0));

  const geloescht = rec.cleanup(
    { telegramsDays: 30, noiseDays: 30, deviceHoursDays: 30 },
    T0,
  );
  assert.deepEqual(geloescht, { telegrams: 1, noiseMinutes: 1, deviceHours: 1 });

  const t = db.prepare('SELECT COUNT(*) c FROM telegrams').get() as { c: number };
  const n = db.prepare('SELECT COUNT(*) c FROM noise_minutes').get() as { c: number };
  assert.equal(t.c, 1);
  assert.equal(n.c, 1);
  db.close();
});
