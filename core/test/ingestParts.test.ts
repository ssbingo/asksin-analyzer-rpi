import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LineSplitter } from '../src/ingest/lineSplitter.ts';
import { BoundedQueue } from '../src/ingest/queue.ts';
import { ExponentialBackoff } from '../src/ingest/time.ts';
import { buildSttyArgs, DEFAULT_BAUD } from '../src/ingest/sttyPort.ts';

const b = (s: string) => Buffer.from(s, 'latin1');

// ---------------------------------------------------------------- Splitter

test('Splitter: Zeilen über Chunk-Grenzen hinweg', () => {
  const s = new LineSplitter();
  assert.deepEqual(s.push(b(':5B;\n:5A0E01')), [':5B;']);
  assert.deepEqual(s.push(b('00701A2B3C00')), []);
  assert.deepEqual(s.push(b('00000102030405;\n')), [':5A0E0100701A2B3C0000000102030405;']);
});

test('Splitter: \\r\\n und nacktes \\n gemischt', () => {
  const s = new LineSplitter();
  assert.deepEqual(s.push(b('eins\r\nzwei\ndrei\r\n')), ['eins', 'zwei', 'drei']);
});

test('Splitter: Chunk-Grenze zwischen \\r und \\n', () => {
  const s = new LineSplitter();
  assert.deepEqual(s.push(b('eins\r')), []);
  assert.deepEqual(s.push(b('\nzwei\n')), ['eins', 'zwei']);
});

test('Splitter: Überlänge wird verworfen, danach geht es normal weiter', () => {
  const s = new LineSplitter(16);
  assert.deepEqual(s.push(b('X'.repeat(40))), []);
  assert.equal(s.overlongDropped, 1);
  // der Rest der Monsterzeile fällt weg …
  assert.deepEqual(s.push(b('YYYY\n:5B;\n')), [':5B;']);
  // … und der Speicher wächst dabei nie über maxLineLength.
});

test('Splitter: end() zählt angefangene Zeilen', () => {
  const s = new LineSplitter();
  s.push(b(':5A0E'));
  s.end();
  assert.equal(s.partialDropped, 1);
  assert.deepEqual(s.push(b(':5B;\n')), [':5B;']);
});

test('Splitter: Fremdbytes zerstören nichts (latin1, wirft nie)', () => {
  const s = new LineSplitter();
  const lines = s.push(Buffer.from([0xff, 0xfe, 0x41, 0x0a]));
  assert.equal(lines.length, 1);
  assert.equal(lines[0]?.length, 3);
});

// ---------------------------------------------------------------- Queue

test('Queue: FIFO und Drop-Oldest mit Zählung', () => {
  const q = new BoundedQueue<string>(3);
  assert.equal(q.put('a'), 0);
  assert.equal(q.put('b'), 0);
  assert.equal(q.put('c'), 0);
  assert.equal(q.put('d'), 1);          // „a" fällt weg
  assert.equal(q.size, 3);
});

test('Queue: take wartet auf put', async () => {
  const q = new BoundedQueue<number>(4);
  const wartend = q.take();
  q.put(42);
  assert.equal(await wartend, 42);
});

test('Queue: direkter Durchreich an wartenden Abnehmer zählt nie als Drop', async () => {
  const q = new BoundedQueue<number>(1);
  const wartend = q.take();
  assert.equal(q.put(1), 0);
  assert.equal(await wartend, 1);
  assert.equal(q.size, 0);
});

test('Queue: take bricht mit AbortSignal ab', async () => {
  const q = new BoundedQueue<number>(1);
  const ac = new AbortController();
  const wartend = q.take(ac.signal);
  ac.abort(new Error('Schluss'));
  await assert.rejects(wartend, /Schluss/);
  // Der abgebrochene Abnehmer darf kein späteres put verschlucken:
  q.put(7);
  assert.equal(q.size, 1);
});

test('Queue: Kompaktierung frisst keine Elemente', () => {
  const q = new BoundedQueue<number>(10_000);
  for (let i = 0; i < 5000; i++) q.put(i);
  for (let i = 0; i < 4000; i++) void q.take();
  for (let i = 5000; i < 5500; i++) q.put(i);
  assert.equal(q.size, 1500);
});

// ---------------------------------------------------------------- Backoff

test('Backoff: 1 s, 2 s, 4 s … Deckel 30 s, Reset beginnt von vorn', () => {
  const bo = new ExponentialBackoff({});
  assert.deepEqual(
    [bo.next(), bo.next(), bo.next(), bo.next(), bo.next(), bo.next()],
    [1000, 2000, 4000, 8000, 16_000, 30_000],
  );
  assert.equal(bo.next(), 30_000);
  bo.reset();
  assert.equal(bo.next(), 1000);
});

// ---------------------------------------------------------------- stty

test('stty-Argumente: 58824, 8N1, roh, ohne Flusskontrolle', () => {
  const args = buildSttyArgs('/dev/asksin-hat', DEFAULT_BAUD);
  assert.equal(args[0], '-F');
  assert.equal(args[1], '/dev/asksin-hat');
  assert.ok(args.includes('58824'), 'die krumme Rate, nicht 57600');
  for (const nötig of ['raw', '-echo', 'cs8', '-cstopb', '-parenb', '-crtscts']) {
    assert.ok(args.includes(nötig), `fehlt: ${nötig}`);
  }
});
