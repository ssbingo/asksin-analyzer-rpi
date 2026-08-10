import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LineSplitter } from '../src/ingest/lineSplitter.ts';
import { BoundedQueue } from '../src/ingest/queue.ts';
import { ExponentialBackoff } from '../src/ingest/time.ts';
import {
  BAUDRATE_HELFER,
  buildSttyArgs,
  DEFAULT_BAUD,
  naechsteGenormteRate,
  schliesseStrom,
} from '../src/ingest/sttyPort.ts';
import type { Schliessbar } from '../src/ingest/sttyPort.ts';

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

test('stty-Argumente: genormte Rate, 8N1, roh, ohne Flusskontrolle', () => {
  const args = buildSttyArgs('/dev/asksin-hat', DEFAULT_BAUD);
  assert.equal(args[0], '-F');
  assert.equal(args[1], '/dev/asksin-hat');
  // Hier steht die GENORMTE Rate. stty kennt nur diese; die krumme 58824
  // lehnt es ab ("ungültiges Argument"). Die exakte Rate setzt danach
  // deploy/baudrate.py.
  assert.ok(args.includes('57600'), 'stty bekommt die genormte Rate');
  assert.ok(!args.includes('58824'), 'die krumme darf hier NICHT stehen');
  for (const nötig of ['raw', '-echo', 'cs8', '-cstopb', '-parenb', '-crtscts']) {
    assert.ok(args.includes(nötig), `fehlt: ${nötig}`);
  }
});

test('naechsteGenormteRate trifft die richtige', () => {
  assert.equal(naechsteGenormteRate(58824), 57600);
  assert.equal(naechsteGenormteRate(57600), 57600);
  assert.equal(naechsteGenormteRate(9600), 9600);
  assert.equal(naechsteGenormteRate(115200), 115200);
});

test('stty NIMMT diese Argumente auch an — gegen ein echtes Terminal', async () => {
  // Der alte Test verglich nur die Zeichenkette, die wir bauen. Er bestaetigte
  // damit meine Absicht, nicht die Wirklichkeit: stty lehnt 58824 rundheraus
  // ab, und das fiel erst an der ersten echten Platine auf (07.08.2026). Bis
  // dahin liefen alle Analyzer im Demo-Modus, der gar keine Schnittstelle
  // oeffnet — der Fehler konnte also unbemerkt bleiben.
  //
  // Deshalb ruft dieser Test stty WIRKLICH auf. Pseudoterminal und stty
  // laufen in einem Python-Aufruf, damit nichts blockiert.
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const lauf = promisify(execFile);

  const args = buildSttyArgs('PLATZHALTER', DEFAULT_BAUD).slice(2);
  const skript = [
    'import os, pty, subprocess, sys',
    'm, s = pty.openpty()',
    'name = os.ttyname(s)',
    'r = subprocess.run(["stty", "-F", name] + sys.argv[1:], capture_output=True, text=True)',
    'sys.stderr.write(r.stderr)',
    'sys.exit(r.returncode)',
  ].join('\n');

  // Wirft, wenn stty die Argumente ablehnt — genau der Fall von damals.
  await lauf('python3', ['-c', skript, ...args]);
});

test('der Baudraten-Helfer setzt die krumme Rate wirklich', async () => {
  // stty kann es nicht, der Kern schon — ueber termios2/BOTHER. Dieser Test
  // belegt, dass unser Helfer diesen Weg richtig geht: setzen und zuruecklesen.
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const lauf = promisify(execFile);

  const skript = [
    'import os, pty, struct, fcntl, subprocess, sys',
    'm, s = pty.openpty()',
    'name = os.ttyname(s)',
    'r = subprocess.run(["python3", sys.argv[1], name, sys.argv[2]])',
    'assert r.returncode == 0, "Helfer fehlgeschlagen"',
    'F = "4IB19B2I"',
    'f = open(name, "rb+", buffering=0)',
    'felder = struct.unpack(F, fcntl.ioctl(f, 0x802C542A, b"\\x00" * struct.calcsize(F)))',
    'print(felder[-1])',
  ].join('\n');

  const { stdout } = await lauf('python3', [
    '-c',
    skript,
    BAUDRATE_HELFER,
    String(DEFAULT_BAUD),
  ]);
  assert.equal(Number(stdout.trim()), DEFAULT_BAUD, 'zurueckgelesene Rate');
});
// --- schliesseStrom: der Flash-Aufhänger vom 10.08.2026 -------------------

/**
 * Ein Strom, der auf `destroy()` NICHT mit `close` antwortet.
 *
 * Genau so verhält sich ein Lesestrom auf einer seriellen Schnittstelle, an
 * der gerade nichts gesendet wird: Der blockierende `read()` hängt im
 * Thread-Pool, und `destroy()` weckt ihn nicht.
 */
function stummerStrom(): Schliessbar & { zerstoert: boolean } {
  return {
    zerstoert: false,
    once(_e: 'close', _h: () => void) { return this; },
    destroy() { this.zerstoert = true; return this; },
  };
}

/** Ein Strom, der sich normal verhält. */
function braverStrom(): Schliessbar {
  let hoerer: (() => void) | null = null;
  return {
    once(_e: 'close', h: () => void) { hoerer = h; return this; },
    destroy() { queueMicrotask(() => hoerer?.()); return this; },
  };
}

test('schliesseStrom: gibt auf, wenn close nie kommt', async () => {
  const s = stummerStrom();
  const start = Date.now();
  await schliesseStrom(s, null, 40);
  const gedauert = Date.now() - start;

  // Der eigentliche Prüfpunkt: Es kehrt überhaupt zurück. Ohne die Zeitgrenze
  // wartet dieses Versprechen für immer — und genau daran hing am 10.08.2026
  // der Firmware-Flash beider Analyzer, mitsamt dem HTTP-Aufruf dahinter.
  assert.ok(gedauert >= 35, `zu früh aufgegeben (${gedauert} ms)`);
  assert.ok(gedauert < 2000, `viel zu spät (${gedauert} ms)`);
  assert.equal(s.zerstoert, true, 'destroy() wird trotzdem versucht');
});

test('schliesseStrom: wartet nicht die volle Zeit, wenn close kommt', async () => {
  const start = Date.now();
  await schliesseStrom(braverStrom(), null, 5000);
  const gedauert = Date.now() - start;
  assert.ok(gedauert < 200, `hat auf die Zeitgrenze gewartet (${gedauert} ms)`);
});

test('schliesseStrom: schliesst auch den Schreibstrom', async () => {
  const schreib = stummerStrom();
  await schliesseStrom(braverStrom(), schreib, 5000);
  assert.equal(schreib.zerstoert, true);
});
