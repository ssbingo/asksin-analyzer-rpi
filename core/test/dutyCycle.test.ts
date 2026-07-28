import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseLine } from '../src/decode/parseLine.ts';
import type { Telegram } from '../src/decode/types.ts';
import {
  DUTY_CYCLE_WINDOW_MS,
  DutyCycleTracker,
  airtimeToPercent,
  estimateAirtimeMs,
  isBurst,
  telegramDutyCyclePercent,
} from '../src/analytics/dutyCycle.ts';

const T0 = 1_700_000_000_000;

function telegramFrom(line: string, ts: number): Telegram {
  const res = parseLine(line, () => ts);
  if (res.kind !== 'telegram') throw new Error(`Fixture ist kein Telegramm: ${line}`);
  return res.telegram;
}

function closeTo(actual: number, expected: number, eps = 1e-9, msg?: string): void {
  assert.ok(
    Math.abs(actual - expected) < eps,
    msg ?? `erwartet ${expected}, war ${actual}`,
  );
}

test('Sendezeit folgt der Formel aus AskSinAnalyzerXS', () => {
  // (len + 11) * 0.81
  closeTo(estimateAirtimeMs(10, false), 21 * 0.81);
  closeTo(estimateAirtimeMs(9, false), 20 * 0.81);
  closeTo(estimateAirtimeMs(60, false), 71 * 0.81);
  // 360 + (len + 7) * 0.81
  closeTo(estimateAirtimeMs(10, true), 360 + 17 * 0.81);
  closeTo(estimateAirtimeMs(9, true), 360 + 16 * 0.81);
});

test('ein Burst kostet rund das Zwanzigfache eines normalen Telegramms', () => {
  const normal = airtimeToPercent(estimateAirtimeMs(10, false));
  const burst = airtimeToPercent(estimateAirtimeMs(10, true));
  assert.ok(burst / normal > 20, `Verhältnis war ${burst / normal}`);
  closeTo(normal, (21 * 0.81) / 360);
  closeTo(burst, (360 + 17 * 0.81) / 360);
});

test('100 Prozentpunkte entsprechen genau 36 Sekunden Sendezeit', () => {
  // 1 % Sendezeit pro Stunde = 36 000 ms, ein Prozentpunkt = 360 ms.
  closeTo(airtimeToPercent(36_000), 100);
  closeTo(airtimeToPercent(360), 1);
});

test('BURST wird bei HmIP-Telegrammen nicht ausgewertet', () => {
  // Referenzverhalten: XS decodiert bei type >= 0x80 die Flags gar nicht,
  // BURST kann dort also nie greifen. Beide Telegramme haben Flags 0x10.
  const bidcos = telegramFrom(':641005100111111122222201020304050607;', T0);
  assert.equal(bidcos.isHmIp, false);
  assert.equal(isBurst(bidcos), true);

  const hmip = telegramFrom(':551A110084F11223F445560102030405060708090A0B0C0D0E0F1011;', T0);
  assert.equal(hmip.isHmIp, true);
  assert.equal(isBurst(hmip), false);
  closeTo(telegramDutyCyclePercent(hmip), airtimeToPercent(estimateAirtimeMs(26, false)));
});

test('Telegramme desselben Absenders summieren sich auf', () => {
  const tracker = new DutyCycleTracker();
  const t = telegramFrom(':4B09000202AAAAAABBBBBB;', T0);
  const single = telegramDutyCyclePercent(t);

  let last = 0;
  for (let i = 0; i < 10; i++) {
    last = tracker.addTelegram({ ...t, ts: T0 + i * 1000 });
  }
  closeTo(last, Math.round(single * 10 * 10) / 10, 1e-9);
  assert.equal(tracker.deviceCount, 1);
});

test('Absender werden getrennt geführt', () => {
  const tracker = new DutyCycleTracker();
  const a = telegramFrom(':4B09000202AAAAAABBBBBB;', T0);
  const b = telegramFrom(':4B09000202CCCCCCBBBBBB;', T0);

  tracker.add(a.fromAddr, T0, 5);
  tracker.add(a.fromAddr, T0, 5);
  tracker.add(b.fromAddr, T0, 3);

  assert.equal(tracker.get(a.fromAddr, T0), 10);
  assert.equal(tracker.get(b.fromAddr, T0), 3);
  assert.equal(tracker.deviceCount, 2);
});

test('unbekannte Adressen liefern 0 statt zu werfen', () => {
  const tracker = new DutyCycleTracker();
  assert.equal(tracker.get(0x123456, T0), 0);
  assert.equal(tracker.deviceCount, 0);
});

test('das Stundenfenster gleitet — Grenze wie in der Referenz', () => {
  const tracker = new DutyCycleTracker();
  tracker.add(0xaaaaaa, T0, 10);

  // Genau auf der Kante bleibt der Eintrag erhalten (Referenz vergleicht mit `<`).
  assert.equal(tracker.get(0xaaaaaa, T0 + DUTY_CYCLE_WINDOW_MS), 10);
  // Eine Millisekunde später fällt er heraus.
  assert.equal(tracker.get(0xaaaaaa, T0 + DUTY_CYCLE_WINDOW_MS + 1), 0);
});

test('ein verstummtes Gerät fällt über die Wanduhr auf 0 zurück', () => {
  // Genau das kann die Referenzimplementierung nicht: sie rechnet nur beim
  // Eintreffen eines Telegramms neu und friert den letzten Wert ein.
  const tracker = new DutyCycleTracker();
  tracker.add(0xaaaaaa, T0, 42);
  assert.equal(tracker.get(0xaaaaaa, T0 + 60_000), 42);

  tracker.prune(T0 + DUTY_CYCLE_WINDOW_MS + 1);
  assert.equal(tracker.get(0xaaaaaa, T0 + DUTY_CYCLE_WINDOW_MS + 1), 0);
  assert.equal(tracker.deviceCount, 0, 'das Gerät wird vollständig vergessen');
});

test('die Summe wird nach vollständiger Räumung exakt 0, nicht ein Fließkommarest', () => {
  const tracker = new DutyCycleTracker();
  for (let i = 0; i < 100; i++) {
    tracker.add(0xaaaaaa, T0 + i, 0.1);
  }
  const emptied = tracker.get(0xaaaaaa, T0 + DUTY_CYCLE_WINDOW_MS + 1000);
  assert.equal(emptied, 0);
  assert.equal(Object.is(emptied, -0), false, 'kein negatives Null als Restwert');
});

test('der Ringpuffer deckelt den Speicher und zählt Verluste', () => {
  const tracker = new DutyCycleTracker({ maxEntriesPerDevice: 4 });
  for (let i = 0; i < 10; i++) {
    tracker.add(0xaaaaaa, T0 + i, 1);
  }
  const [dev] = tracker.snapshot(T0 + 10);
  assert.ok(dev !== undefined);
  assert.equal(dev.telegrams, 4, 'nie mehr Einträge als die Kapazität');
  assert.equal(dev.dropped, 6, 'die sechs ältesten wurden verworfen');
  assert.equal(dev.percent, 4);
});

test('die laufende Summe bleibt über viele Ein- und Ausfügungen exakt', () => {
  // Gegen eine naive Referenzimplementierung prüfen: bei jedem Schritt muss der
  // gerundete Wert übereinstimmen. Deckt die Drift der fortgeschriebenen
  // Gleitkommasumme ab.
  const tracker = new DutyCycleTracker({ windowMs: 10_000, recomputeInterval: 7 });
  const reference: { ts: number; dc: number }[] = [];

  for (let i = 0; i < 5_000; i++) {
    const ts = T0 + i * 3;
    const dc = 0.047_25 + (i % 13) * 0.001;

    const got = tracker.add(0xaaaaaa, ts, dc);

    reference.push({ ts, dc });
    const cutoff = ts - 10_000;
    while (reference.length > 0 && (reference[0] as { ts: number }).ts < cutoff) {
      reference.shift();
    }
    const expected = Math.round(reference.reduce((s, e) => s + e.dc, 0) * 10) / 10;

    assert.equal(got, expected, `Abweichung bei Schritt ${i}`);
  }
});

test('snapshot sortiert absteigend und liefert die Adresse als Hex', () => {
  const tracker = new DutyCycleTracker();
  tracker.add(0x0000aa, T0, 1);
  tracker.add(0xabcdef, T0, 50);
  tracker.add(0x112233, T0, 10);

  const snap = tracker.snapshot(T0);
  assert.deepEqual(
    snap.map((d) => d.address),
    ['ABCDEF', '112233', '0000AA'],
  );
  assert.deepEqual(
    snap.map((d) => d.percent),
    [50, 10, 1],
  );
  assert.equal(snap[0]?.lastSeen, T0);
});

test('reset leert den Tracker vollständig', () => {
  const tracker = new DutyCycleTracker();
  tracker.add(0xaaaaaa, T0, 10);
  tracker.reset();
  assert.equal(tracker.deviceCount, 0);
  assert.equal(tracker.get(0xaaaaaa, T0), 0);
});

test('ein dauerfunkendes Gerät überschreitet 100 % und bleibt auswertbar', () => {
  const tracker = new DutyCycleTracker();
  const burst = telegramFrom(':641005100111111122222201020304050607;', T0);
  // Alle 30 s ein Burst über gut 1,6 Stunden — mehr als ins Fenster passt.
  const step = 30_000;
  const count = 200;
  let last = 0;
  for (let i = 0; i < count; i++) {
    last = tracker.addTelegram({ ...burst, ts: T0 + i * step });
  }

  // Ein Burst von 16 Byte kostet (360 + 23·0,81) / 360 ≈ 1,0518 Prozentpunkte.
  assert.ok(last > 100, `erwartet > 100 %, war ${last}`);

  const [dev] = tracker.snapshot(T0 + (count - 1) * step);
  assert.ok(dev !== undefined);
  assert.equal(
    dev.telegrams,
    DUTY_CYCLE_WINDOW_MS / step + 1,
    'nur das Stundenfenster zählt, ältere Telegramme sind herausgefallen',
  );
  assert.equal(dev.dropped, 0, 'die Kapazitätsgrenze wurde dabei nicht erreicht');
});
