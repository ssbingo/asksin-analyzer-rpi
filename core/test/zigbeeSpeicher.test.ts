import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { openDatabase, SCHEMA_VERSION } from '../src/persist/db.ts';
import { ZigbeeSpeicher, LQI_SCHWACH } from '../src/zigbee/speicher.ts';
import { parseZigbeeZeile } from '../src/zigbee/parse.ts';
import type { ZigbeePaket } from '../src/zigbee/types.ts';
import { ZIGBEE_PAKETE } from './fixtures/zigbee.ts';

const STUNDE_MS = 3_600_000;

function paket(t: Partial<ZigbeePaket> = {}): ZigbeePaket {
  return {
    ts: 1_700_000_000_000, kanal: 11, rssi: -70, lqi: 255, laenge: 45,
    typ: 'daten', seq: 7, pan: 'ABCD', von: '1111', an: 'FFFF',
    rundruf: true, ackErbeten: false, gesichert: true, ...t,
  };
}

function frischeDb(): DatabaseSync {
  return openDatabase(':memory:');
}

test('Schema wandert auf die neue Version, alte Tabellen bleiben', () => {
  const db = frischeDb();
  const v = db.prepare('PRAGMA user_version').get() as { user_version: number };
  assert.equal(v.user_version, SCHEMA_VERSION);
  const namen = (db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
  ).all() as Array<{ name: string }>).map((r) => r.name);
  for (const n of ['telegrams', 'noise_minutes', 'device_hours',
                   'zigbee_packets', 'zigbee_device_hours']) {
    assert.ok(namen.includes(n), `Tabelle ${n} fehlt`);
  }
  db.close();
});

test('eine bestehende Datenbank der Version 1 wird nachgezogen', () => {
  // Der Fall, der im Betrieb zählt: Der Analyzer läuft seit Monaten, seine
  // Datenbank steht auf Version 1, und das Update darf sie weder verlieren
  // noch anfassen.
  //
  // Ausdrücklich mit einer ECHTEN Datei. Eine erste Fassung dieses Tests legte
  // die Version-1-Datenbank im Speicher an, schloss sie und öffnete danach eine
  // frische — die Migration lief dabei überhaupt nicht. Der Test war grün und
  // bewies nichts.
  const datei = join(mkdtempSync(join(tmpdir(), 'asksin-zigbee-')), 'alt.db');
  const alt = new DatabaseSync(datei);
  alt.exec(`CREATE TABLE telegrams (ts INTEGER NOT NULL, rssi INTEGER NOT NULL,
    len INTEGER NOT NULL, cnt INTEGER NOT NULL, flags INTEGER NOT NULL,
    type INTEGER NOT NULL, from_addr INTEGER NOT NULL, to_addr INTEGER NOT NULL,
    payload TEXT NOT NULL) STRICT`);
  alt.exec("INSERT INTO telegrams VALUES (1, -60, 10, 1, 0, 2, 100, 200, 'AB')");
  alt.exec('PRAGMA user_version = 1');
  alt.close();

  const db = openDatabase(datei);
  const v = db.prepare('PRAGMA user_version').get() as { user_version: number };
  assert.equal(v.user_version, SCHEMA_VERSION, 'Version wurde nachgezogen');

  // Die alten Daten sind unangetastet.
  const bestand = db.prepare('SELECT payload FROM telegrams').all() as Array<{ payload: string }>;
  assert.equal(bestand.length, 1);
  assert.equal(bestand[0]!.payload, 'AB', 'Bestandsdaten unangetastet');

  // Und die neuen Tabellen sind benutzbar.
  const s = new ZigbeeSpeicher(db, { schub: 1 });
  s.aufnehmen(paket());
  const n = db.prepare('SELECT COUNT(*) AS n FROM zigbee_packets').get() as { n: number };
  assert.equal(n.n, 1);

  db.close();
  rmSync(dirname(datei), { recursive: true, force: true });
});

test('Pakete und Stundensummen landen zusammen in der Datenbank', () => {
  const db = frischeDb();
  const s = new ZigbeeSpeicher(db, { schub: 1000 });
  for (let i = 0; i < 5; i++) s.aufnehmen(paket({ rssi: -60 - i, lqi: 200 + i }));
  s.aufnehmen(paket({ von: '2222', rssi: -90, lqi: 3 }));
  s.schreiben();

  const anzahl = db.prepare('SELECT COUNT(*) AS n FROM zigbee_packets').get() as { n: number };
  assert.equal(anzahl.n, 6);

  const zeile = db.prepare(
    `SELECT pakete, schwach, min_rssi, max_rssi, sum_rssi
       FROM zigbee_device_hours WHERE addr = '1111'`,
  ).get() as {
    pakete: number; schwach: number;
    min_rssi: number; max_rssi: number; sum_rssi: number;
  };
  assert.equal(zeile.pakete, 5);
  assert.equal(zeile.max_rssi, -60);
  assert.equal(zeile.min_rssi, -64);
  assert.equal(zeile.sum_rssi, -60 - 61 - 62 - 63 - 64);
  assert.equal(zeile.schwach, 0, 'LQI 200+ ist nicht schwach');

  const schwach = db.prepare(
    "SELECT schwach, pakete FROM zigbee_device_hours WHERE addr = '2222'",
  ).get() as { schwach: number; pakete: number };
  assert.equal(schwach.pakete, 1);
  assert.equal(schwach.schwach, 1, `LQI 3 liegt unter ${LQI_SCHWACH}`);
  db.close();
});

/**
 * Eine echte Bestätigung — aus den Fixtures, nicht von Hand gebaut.
 *
 * Von Hand hiesse: `pan: undefined` setzen. Das verbietet
 * `exactOptionalPropertyTypes` zu Recht, denn eine fehlende Eigenschaft ist
 * etwas anderes als eine auf `undefined` gesetzte. Und der Umweg über den
 * Parser prüft nebenbei mit, dass eine echte Bestätigung wirklich ohne
 * Adressfelder herauskommt.
 */
function echteBestaetigung(): ZigbeePaket {
  const fx = ZIGBEE_PAKETE.find((f) => f.typ === 'bestaetigung');
  assert.ok(fx, 'Fixtures enthalten keine Bestätigung');
  const r = parseZigbeeZeile(fx.line, () => 1_700_000_000_000);
  assert.equal(r.kind, 'paket');
  if (r.kind !== 'paket') throw new Error('unerreichbar');
  return r.paket;
}

test('Bestätigungen werden gezählt statt gespeichert', () => {
  const db = frischeDb();
  const s = new ZigbeeSpeicher(db, { schub: 1000 });
  s.aufnehmen(echteBestaetigung());
  s.schreiben();

  const p = db.prepare('SELECT COUNT(*) AS n FROM zigbee_packets').get() as { n: number };
  const g = db.prepare('SELECT COUNT(*) AS n FROM zigbee_device_hours').get() as { n: number };
  assert.equal(p.n, 0, 'keine Zeile — sie beantwortet keine Frage');
  assert.equal(g.n, 0, 'und keiner Gerätezeile zugerechnet');
  assert.equal(s.stats.bestaetigungen, 1, 'aber gezählt');
  db.close();
});

test('auf Wunsch werden Bestätigungen doch gespeichert', () => {
  const db = frischeDb();
  const s = new ZigbeeSpeicher(db, { schub: 1000, bestaetigungen: 'speichern' });
  s.aufnehmen(echteBestaetigung());
  s.schreiben();
  const p = db.prepare(
    'SELECT COUNT(*) AS n FROM zigbee_packets',
  ).get() as { n: number };
  assert.equal(p.n, 1);
  const g = db.prepare(
    'SELECT COUNT(*) AS n FROM zigbee_device_hours',
  ).get() as { n: number };
  assert.equal(g.n, 0, 'auch dann keiner Gerätezeile zugerechnet');
  db.close();
});

test('mehrere Schübe summieren sich, statt sich zu überschreiben', () => {
  const db = frischeDb();
  const s = new ZigbeeSpeicher(db, { schub: 2 });
  for (let i = 0; i < 6; i++) s.aufnehmen(paket({ rssi: -70 }));
  s.schreiben();
  const z = db.prepare(
    "SELECT pakete, sum_rssi FROM zigbee_device_hours WHERE addr = '1111'",
  ).get() as { pakete: number; sum_rssi: number };
  assert.equal(z.pakete, 6, 'drei Schübe à zwei Paketen');
  assert.equal(z.sum_rssi, -420);
  db.close();
});

test('Pakete verschiedener Stunden bekommen eigene Zeilen', () => {
  const db = frischeDb();
  const s = new ZigbeeSpeicher(db, { schub: 1000 });
  const t0 = 1_700_000_000_000;
  s.aufnehmen(paket({ ts: t0 }));
  s.aufnehmen(paket({ ts: t0 + STUNDE_MS }));
  s.schreiben();
  const n = db.prepare(
    "SELECT COUNT(*) AS n FROM zigbee_device_hours WHERE addr = '1111'",
  ).get() as { n: number };
  assert.equal(n.n, 2);
  db.close();
});

test('Aufräumen löscht Altes und lässt Neues stehen', () => {
  const db = frischeDb();
  const s = new ZigbeeSpeicher(db, { schub: 1000 });
  const jetzt = 1_700_000_000_000;
  const alt = jetzt - 30 * 86_400_000;
  s.aufnehmen(paket({ ts: alt }));
  s.aufnehmen(paket({ ts: jetzt }));
  s.schreiben();

  const weg = s.aufraeumen({ paketeTage: 14, stundenTage: 365 }, jetzt);
  assert.equal(weg.pakete, 1, 'das 30 Tage alte Paket fällt weg');
  const rest = db.prepare('SELECT COUNT(*) AS n FROM zigbee_packets').get() as { n: number };
  assert.equal(rest.n, 1);

  // Die Stundensumme bleibt: kurze Frist für Einzelpakete, lange für Summen.
  const stunden = db.prepare(
    'SELECT COUNT(*) AS n FROM zigbee_device_hours',
  ).get() as { n: number };
  assert.equal(stunden.n, 2, 'Stundensummen überleben die Paketfrist');
  db.close();
});

test('echte Fixtures durchlaufen Parser und Speicher unverändert', () => {
  const db = frischeDb();
  const s = new ZigbeeSpeicher(db, { schub: 1000 });
  const now = () => 1_700_000_000_000;
  let erwartet = 0;
  for (const fx of ZIGBEE_PAKETE) {
    const r = parseZigbeeZeile(fx.line, now);
    assert.equal(r.kind, 'paket', fx.name);
    if (r.kind !== 'paket') continue;
    s.aufnehmen(r.paket);
    if (r.paket.typ !== 'bestaetigung') erwartet++;
  }
  s.schreiben();
  const gespeichert = db.prepare(
    'SELECT COUNT(*) AS n FROM zigbee_packets',
  ).get() as { n: number };
  assert.equal(gespeichert.n, erwartet, 'Bestätigungen zählen nicht mit');
  assert.equal(s.stats.geschrieben, erwartet);
  db.close();
});

test('die Zuordnung Kurzadresse → IEEE wird mitgeführt', () => {
  const db = frischeDb();
  const s = new ZigbeeSpeicher(db, { schub: 1000 });
  const t0 = 1_700_000_000_000;
  for (let i = 0; i < 3; i++) {
    s.aufnehmen(paket({ ts: t0 + i, nwkVon: '837E', ieee: '00005EEF10000001' }));
  }
  s.schreiben();
  const z = db.prepare(
    "SELECT ieee, gesehen, zuerst, zuletzt FROM zigbee_adressen WHERE addr = '837E'",
  ).get() as { ieee: string; gesehen: number; zuerst: number; zuletzt: number };
  assert.equal(z.ieee, '00005EEF10000001');
  assert.equal(z.gesehen, 3);
  assert.equal(z.zuerst, t0);
  assert.equal(z.zuletzt, t0 + 2);
  db.close();
});

test('wandert eine Kurzadresse zu einem anderen Gerät, bleiben beide stehen', () => {
  // Beim Neuanmelden vergibt der Koordinator Kurzadressen neu. Wer hier
  // überschreibt, verliert die Historie und merkt es nie.
  const db = frischeDb();
  const s = new ZigbeeSpeicher(db, { schub: 1000 });
  const t0 = 1_700_000_000_000;
  s.aufnehmen(paket({ ts: t0, nwkVon: '1234', ieee: 'AAAAAAAAAAAAAAAA' }));
  s.aufnehmen(paket({ ts: t0 + 86_400_000, nwkVon: '1234', ieee: 'BBBBBBBBBBBBBBBB' }));
  s.schreiben();
  const zeilen = db.prepare(
    "SELECT ieee, zuletzt FROM zigbee_adressen WHERE addr = '1234' ORDER BY zuletzt DESC",
  ).all() as Array<{ ieee: string; zuletzt: number }>;
  assert.equal(zeilen.length, 2, 'beide Zuordnungen bleiben erhalten');
  assert.equal(zeilen[0]!.ieee, 'BBBBBBBBBBBBBBBB', 'die neuere steht vorn');
  db.close();
});

test('Pakete ohne IEEE erzeugen keine Zuordnung', () => {
  const db = frischeDb();
  const s = new ZigbeeSpeicher(db, { schub: 1000 });
  s.aufnehmen(paket({ nwkVon: '837E' }));   // ohne ieee
  s.schreiben();
  const n = db.prepare('SELECT COUNT(*) AS n FROM zigbee_adressen').get() as { n: number };
  assert.equal(n.n, 0);
  db.close();
});
