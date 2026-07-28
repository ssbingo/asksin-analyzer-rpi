import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SerialIngest } from '../src/ingest/ingest.ts';
import type { StateChange } from '../src/ingest/ingest.ts';
import type { ParsedLine } from '../src/decode/types.ts';
import { FakePort, FakeTime, tick } from './helpers/fakes.ts';

const NOISE = ':5B;\n';
const TELEGRAMM = ':5A0E0100701A2B3C0000000102030405;\n';

interface Aufbau {
  time: FakeTime;
  ports: FakePort[];
  ingest: SerialIngest;
  lines: ParsedLine[];
  states: StateChange[];
}

function aufbau(extra: {
  queueCapacity?: number;
  onLine?: (l: ParsedLine) => void | Promise<void>;
} = {}): Aufbau {
  const time = new FakeTime();
  const ports: FakePort[] = [];
  const lines: ParsedLine[] = [];
  const states: StateChange[] = [];
  const optionen: ConstructorParameters<typeof SerialIngest>[0] = {
    openPort: () => {
      const port = new FakePort();
      ports.push(port);
      return Promise.resolve(port);
    },
    onLine: extra.onLine ?? ((l) => {
      lines.push(l);
    }),
    onStateChange: (s) => {
      states.push(s);
    },
    time,
    silenceTimeoutMs: 5000,
    backoff: { baseMs: 1000, capMs: 8000 },
  };
  if (extra.queueCapacity !== undefined) {
    optionen.queueCapacity = extra.queueCapacity;
  }
  const ingest = new SerialIngest(optionen);
  return { time, ports, ingest, lines, states };
}

test('Zeilen fließen durch: Telegramm, Rauschen, Müll — mit Zählern', async () => {
  const { ports, ingest, lines, time } = aufbau();
  ingest.start();
  await tick();

  ports[0]!.feed(NOISE);
  ports[0]!.feed('AskSin++ Bootmeldung\n');
  ports[0]!.feed(TELEGRAMM);
  await time.advance(0);

  assert.equal(ingest.stats.lines, 3);
  assert.equal(ingest.stats.noise, 1);
  assert.equal(ingest.stats.telegrams, 1);
  assert.equal(ingest.stats.ignored['no-frame'], 1);
  assert.deepEqual(
    lines.map((l) => l.kind),
    ['noise', 'ignored', 'telegram'],
  );
  await ingest.stop();
});

test('connected wird erst mit der ersten GÜLTIGEN Zeile wahr', async () => {
  const { ports, ingest, states, time } = aufbau();
  ingest.start();
  await tick();
  assert.equal(ingest.stats.connected, false, 'offener Port allein reicht nicht');

  ports[0]!.feed('nur Müll\n');
  await time.advance(0);
  assert.equal(ingest.stats.connected, false, 'Müll reicht auch nicht');

  ports[0]!.feed(NOISE);
  await time.advance(0);
  assert.equal(ingest.stats.connected, true);
  assert.deepEqual(states, [{ connected: true }]);
  await ingest.stop();
});

test('Stromende → Backoff-Reconnect; gültige Daten setzen das Backoff zurück', async () => {
  const { ports, ingest, states, time } = aufbau();
  ingest.start();
  await tick();
  ports[0]!.feed(NOISE);
  await time.advance(0);

  // Verbindung stirbt zweimal hintereinander, ohne dass Daten kommen:
  ports[0]!.end();
  await time.advance(0);
  assert.equal(ports.length, 1, 'wartet erst das Backoff ab');
  await time.advance(1000);                    // 1. Versuch nach 1 s
  assert.equal(ports.length, 2);

  ports[1]!.end();                             // sofort wieder tot
  await time.advance(2000);                    // 2. Versuch nach 2 s
  assert.equal(ports.length, 3);

  // Jetzt kommen Daten → Backoff zurück auf Anfang:
  ports[2]!.feed(NOISE);
  await time.advance(0);
  ports[2]!.end();
  await time.advance(1000);                    // wieder nur 1 s
  assert.equal(ports.length, 4);

  const abbrüche = states.filter((s) => !s.connected);
  assert.deepEqual(
    abbrüche.map((s) => !s.connected && s.retryInMs),
    [1000, 2000, 1000],
  );
  assert.ok(abbrüche.every((s) => !s.connected && s.reason === 'eof'));
  assert.equal(ingest.stats.reconnects, 3);
  await ingest.stop();
});

test('Watchdog: Stille auf der Leitung erzwingt den Neuaufbau', async () => {
  const { ports, ingest, states, time } = aufbau();
  ingest.start();
  await tick();
  ports[0]!.feed(NOISE);
  await time.advance(0);
  assert.equal(ingest.stats.connected, true);

  // Rauschen kommt normalerweise alle 750 ms — hier: nichts mehr.
  await time.advance(6000);
  assert.equal(ports[0]!.geschlossen, true, 'Watchdog hat den Port geschlossen');
  const letzter = states.at(-1);
  assert.ok(letzter !== undefined && !letzter.connected);
  assert.equal(!letzter.connected && letzter.reason, 'silence');
  assert.equal(ingest.stats.connected, false);

  // und die Schleife versucht es erneut:
  await time.advance(1000);
  assert.equal(ports.length, 2);
  await ingest.stop();
});

test('Lesefehler → reason error, Schleife lebt weiter', async () => {
  const { ports, ingest, states, time } = aufbau();
  ingest.start();
  await tick();
  ports[0]!.fail(new Error('Kabelbrand'));
  await time.advance(0);

  const letzter = states.at(-1);
  assert.ok(letzter !== undefined && !letzter.connected);
  assert.equal(!letzter.connected && letzter.reason, 'error');
  await time.advance(1000);
  assert.equal(ports.length, 2);
  await ingest.stop();
});

test('voller Puffer wirft die ÄLTESTEN Zeilen weg', async () => {
  let freigeben!: () => void;
  const blockade = new Promise<void>((r) => {
    freigeben = r;
  });
  const gesehen: string[] = [];
  let erste = true;

  const { ports, ingest, time } = aufbau({
    queueCapacity: 3,
    onLine: async (l) => {
      gesehen.push(l.kind === 'ignored' ? l.raw : l.kind);
      if (erste) {
        erste = false;
        await blockade;                       // Verbraucher hängt …
      }
    },
  });
  ingest.start();
  await tick();

  for (const n of [1, 2, 3, 4, 5, 6]) {
    ports[0]!.feed(`zeile-${n}\n`);
  }
  await time.advance(0);
  // zeile-1 hängt im Verbraucher, 2–4 stehen in der Queue,
  // 5 und 6 haben die ältesten (2, 3) verdrängt.
  freigeben();
  await time.advance(0);

  assert.deepEqual(gesehen, ['zeile-1', 'zeile-4', 'zeile-5', 'zeile-6']);
  assert.equal(ingest.stats.droppedLines, 2);
  await ingest.stop();
});

test('stop() beendet sauber — auch mitten in einer Verbindung', async () => {
  const { ports, ingest, time } = aufbau();
  ingest.start();
  await tick();
  ports[0]!.feed(NOISE);
  await time.advance(0);

  await ingest.stop();
  assert.equal(ingest.stats.connected, false);
  const vorher = ports.length;
  await time.advance(60_000);
  assert.equal(ports.length, vorher, 'nach stop() keine neuen Verbindungen');
});

test('doppeltes start() ist ein Programmierfehler und wirft', async () => {
  const { ingest } = aufbau();
  ingest.start();
  assert.throws(() => ingest.start(), /läuft bereits/);
  await ingest.stop();
});
