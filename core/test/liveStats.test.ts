import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LiveStats } from '../src/analytics/liveStats.ts';
import { parseLine } from '../src/decode/parseLine.ts';

const T0 = 1_785_300_000_000;

function zeile(raw: string, ts: number) {
  return parseLine(raw, () => ts);
}

const TELEGRAMM = ':5A0E0100701A2B3C0000000102030405;';   // von 1A2B3C, −90 dBm

test('Grundrauschen: letzter Wert plus träge Glättung', () => {
  const s = new LiveStats();
  assert.deepEqual(s.noiseFloor, { last: null, ewma: null, samples: 0 });

  s.record(zeile(':5B;', T0));            // −91
  assert.equal(s.noiseFloor.last, -91);
  assert.equal(s.noiseFloor.ewma, -91, 'erster Wert setzt die Glättung');

  s.record(zeile(':50;', T0 + 750));      // −80
  assert.equal(s.noiseFloor.last, -80);
  // EWMA α=0,1: −91 + 0,1·(−80 − (−91)) = −89,9
  assert.equal(s.noiseFloor.ewma, -89.9);
  assert.equal(s.noiseFloor.samples, 2);
});

test('telegramsPerMinute: gleitendes 60-Sekunden-Fenster', () => {
  const s = new LiveStats();
  for (let i = 0; i < 5; i++) {
    s.record(zeile(TELEGRAMM, T0 + i * 10_000));   // t=0,10,20,30,40 s
  }
  assert.equal(s.telegramsPerMinute(T0 + 40_000), 5);
  // 61 s nach dem ersten: das erste fällt heraus
  assert.equal(s.telegramsPerMinute(T0 + 61_000), 4);
  // 100 s später: nur noch das letzte von t=40 s? Nein — auch weg:
  assert.equal(s.telegramsPerMinute(T0 + 101_000), 0);
});

test('telegramsPerMinute: alte Ring-Einträge zählen nach Ringumlauf nicht doppelt', () => {
  const s = new LiveStats();
  s.record(zeile(TELEGRAMM, T0));
  // exakt 60 s später landet der Zähler im selben Eimer:
  s.record(zeile(TELEGRAMM, T0 + 60_000));
  assert.equal(s.telegramsPerMinute(T0 + 60_000), 1, 'alter Eintrag überschrieben');
});

test('Geräte-RSSI: last/min/max/ewma/lastSeen je Absender', () => {
  const s = new LiveStats();
  s.record(zeile(':5A0E0100701A2B3C0000000102030405;', T0));        // −90
  s.record(zeile(':460E0200701A2B3C0000000102030405;', T0 + 1000)); // −70
  s.record(zeile(':640E0300701A2B3C0000000102030405;', T0 + 2000)); // −100

  const g = s.device(0x1a2b3c);
  assert.ok(g !== undefined);
  assert.equal(g.last, -100);
  assert.equal(g.min, -100);
  assert.equal(g.max, -70);
  assert.equal(g.lastSeen, T0 + 2000);
  assert.equal(g.telegrams, 3);
  // EWMA: −90 → −90+0,1·20=−88 → −88+0,1·(−12)=−89,2
  assert.equal(g.ewma, -89.2);
});

test('devices() sortiert nach zuletzt gesehen, unbekannte Adresse ist undefined', () => {
  const s = new LiveStats();
  s.record(zeile(':5A0E0100701A2B3C0000000102030405;', T0));
  s.record(zeile(':5A0E010070ABCDEF0000000102030405;', T0 + 5000));
  assert.deepEqual(
    s.devices().map((g) => g.addr),
    [0xabcdef, 0x1a2b3c],
  );
  assert.equal(s.device(0x999999), undefined);
  assert.equal(s.deviceCount, 2);
});

test('Rauschen und Müll verändern die Gerätestatistik nicht', () => {
  const s = new LiveStats();
  s.record(zeile(':5B;', T0));
  s.record(zeile('Bootmeldung', T0));
  assert.equal(s.deviceCount, 0);
  assert.equal(s.telegramsPerMinute(T0), 0);
});
