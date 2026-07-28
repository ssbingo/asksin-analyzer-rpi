import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Analyzer } from '../src/service/analyzer.ts';
import { openDatabase } from '../src/persist/db.ts';
import { DevListService } from '../src/resolve/fetcher.ts';
import type { ParsedLine } from '../src/decode/types.ts';
import { FakePort, FakeTime, alsCcuAntwort, tick } from './helpers/fakes.ts';

const NOISE = ':5B;\n';                                       // −91 dBm
const TELEGRAMM = ':5A0E0100701A2B3C0000000102030405;\n';     // von 1A2B3C, −90

const LISTE = JSON.stringify({
  created_at: 1_785_300_000,
  devices: [
    { address: 0x1a2b3c, serial: 'OEQ1234567', name: 'Wäschekeller Fenster' },
  ],
});

interface Aufbau {
  time: FakeTime;
  ports: FakePort[];
  analyzer: Analyzer;
  db: ReturnType<typeof openDatabase>;
  lines: ParsedLine[];
}

function aufbau(extra: {
  mitDevList?: boolean;
  flushIntervalMs?: number;
  cleanupIntervalMs?: number;
} = {}): Aufbau {
  const time = new FakeTime();
  const ports: FakePort[] = [];
  const lines: ParsedLine[] = [];
  const db = openDatabase(':memory:');
  const analyzer = new Analyzer({
    openPort: () => {
      const port = new FakePort();
      ports.push(port);
      return Promise.resolve(port);
    },
    db,
    time,
    flushIntervalMs: extra.flushIntervalMs ?? 1000,
    cleanupIntervalMs: extra.cleanupIntervalMs ?? 86_400_000,
    // Watchdog weit weg — die Tests schieben die Uhr um Sekunden:
    ingest: { silenceTimeoutMs: 600_000 },
    onLine: (l) => {
      lines.push(l);
    },
    ...(extra.mitDevList === true
      ? {
          devList: new DevListService({
            host: 'ccu.local',
            time,
            fetchBytes: () => Promise.resolve(alsCcuAntwort(LISTE)),
          }),
        }
      : {}),
  });
  return { time, ports, analyzer, db, lines };
}

test('Kette Ende-zu-Ende: Port → Statistik, Duty-Cycle und Datenbank', async () => {
  const { time, ports, analyzer, db, lines } = aufbau();
  analyzer.start();
  await tick();

  ports[0]!.feed(NOISE);
  ports[0]!.feed(TELEGRAMM);
  ports[0]!.feed(TELEGRAMM);
  await time.advance(0);

  let s = analyzer.snapshot();
  assert.equal(s.ingest.telegrams, 2);
  assert.equal(s.ingest.noise, 1);
  assert.equal(s.noiseFloor.last, -91);
  assert.equal(s.telegramsPerMinute, 2);
  assert.equal(s.devList, null, 'ohne DevListService ehrlich null');
  assert.equal(s.devices.length, 1);
  const g = s.devices[0]!;
  assert.equal(g.address, '1A2B3C');
  assert.equal(g.name, '1A2B3C', 'ohne DevList: Hex-Name');
  assert.equal(g.serial, null);
  assert.equal(g.rssi.last, -90);
  assert.equal(g.telegrams, 2);
  assert.ok(g.dutyCyclePercent > 0, 'Duty-Cycle wird mitgeführt');
  assert.equal(s.recorder.writtenTelegrams, 0, 'noch gepuffert');
  assert.equal(lines.length, 3, 'onLine-Durchreiche sieht alles');

  await time.advance(1000);                     // Flush-Takt
  s = analyzer.snapshot();
  assert.equal(s.recorder.writtenTelegrams, 2);
  const n = db.prepare('SELECT COUNT(*) c FROM telegrams').get() as { c: number };
  assert.equal(n.c, 2);

  await analyzer.stop();
  db.close();
});

test('DevList angeschlossen: Namen, Seriennummern und Quelle im Snapshot', async () => {
  const { time, ports, analyzer, db } = aufbau({ mitDevList: true });
  analyzer.start();
  await tick();                                 // DevList-Abruf läuft mit hoch

  ports[0]!.feed(TELEGRAMM);
  await time.advance(0);

  const s = analyzer.snapshot();
  assert.ok(s.devList !== null);
  assert.equal(s.devList.source, 'ccu');
  assert.equal(s.devList.entries, 1);
  assert.equal(s.devList.createdAt, 1_785_300_000_000);
  const g = s.devices[0]!;
  assert.equal(g.name, 'Wäschekeller Fenster');
  assert.equal(g.serial, 'OEQ1234567');
  assert.equal(g.kind, 'device');
  assert.equal(g.isHmIp, false);

  await analyzer.stop();
  db.close();
});

test('stop() flusht den Rest — kein Batch geht verloren', async () => {
  const { time, ports, analyzer, db } = aufbau({ flushIntervalMs: 60_000 });
  analyzer.start();
  await tick();
  ports[0]!.feed(TELEGRAMM);
  ports[0]!.feed(TELEGRAMM);
  ports[0]!.feed(TELEGRAMM);
  await time.advance(0);
  assert.equal(analyzer.snapshot().recorder.writtenTelegrams, 0);

  await analyzer.stop();
  const n = db.prepare('SELECT COUNT(*) c FROM telegrams').get() as { c: number };
  assert.equal(n.c, 3, 'Abschluss-Flush hat geschrieben');
  await analyzer.stop();                        // zweites stop() ist harmlos
  db.close();
});

test('Aufräumtakt läuft im Takt und flusht dabei', async () => {
  const { time, ports, analyzer } = aufbau({
    flushIntervalMs: 60_000,
    cleanupIntervalMs: 50,
  });
  analyzer.start();
  await tick();
  ports[0]!.feed(TELEGRAMM);
  await time.advance(0);

  await time.advance(50);                       // cleanup() beginnt mit flush()
  const s = analyzer.snapshot();
  assert.equal(s.recorder.writtenTelegrams, 1);
  assert.ok(s.recorder.flushes >= 1);
  assert.equal(s.persistErrors, 0);
  await analyzer.stop();
});

test('doppeltes start() ist ein Programmierfehler und wirft', async () => {
  const { analyzer } = aufbau();
  analyzer.start();
  assert.throws(() => analyzer.start(), /läuft bereits/);
  await analyzer.stop();
});
