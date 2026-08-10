import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { closeSync, constants, mkdtempSync, openSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LineSplitter } from '../src/ingest/lineSplitter.ts';
import { BoundedQueue } from '../src/ingest/queue.ts';
import { ExponentialBackoff } from '../src/ingest/time.ts';
import {
  BAUDRATE_HELFER,
  buildSttyArgs,
  DEFAULT_BAUD,
  leserProzess,
  naechsteGenormteRate,
} from '../src/ingest/sttyPort.ts';

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
// --- leserProzess: der Kern der Umstellung vom 10.08.2026 ----------------

/**
 * Diese Tests laufen gegen eine echte benannte Pipe (FIFO) und einen echten
 * `cat`. Attrappen taugen hier nicht: Geprueft wird gerade, dass sich ein
 * blockierender read() beenden laesst — und genau das war mit einem
 * Dateistrom im eigenen Prozess unmoeglich.
 */
function fifoAnlegen(): { pfad: string; offenhalten: number; aufraeumen: () => void } {
  const verz = mkdtempSync(join(tmpdir(), 'asksin-fifo-'));
  const pfad = join(verz, 'port');
  execFileSync('mkfifo', [pfad]);
  // O_RDWR blockiert bei FIFOs nicht und haelt die Pipe offen, damit `cat`
  // sie oeffnen kann und danach auf Daten wartet — der zu pruefende Zustand.
  const offenhalten = openSync(pfad, constants.O_RDWR);
  return {
    pfad,
    offenhalten,
    aufraeumen: () => {
      try { closeSync(offenhalten); } catch { /* egal */ }
      rmSync(verz, { recursive: true, force: true });
    },
  };
}

test('leserProzess: close() kehrt zurück, obwohl der Lesevorgang blockiert', async () => {
  // Der Kern des Problems vom 10.08.2026. Mit fs.createReadStream haengt hier
  // ein read() im Thread-Pool, den nichts unterbricht — close() wartete dann
  // fuer immer, der Firmware-Flash blieb stehen, und der verwaiste Strom
  // schnappte avrdude spaeter die Antwort des Bootloaders weg.
  const f = fifoAnlegen();
  try {
    const leser = leserProzess(f.pfad);
    await new Promise((r) => setTimeout(r, 100));   // cat oeffnet und blockiert

    const start = Date.now();
    await leser.close();
    const gedauert = Date.now() - start;
    assert.ok(gedauert < 2000, `close() brauchte ${gedauert} ms`);
  } finally {
    f.aufraeumen();
  }
});

test('leserProzess: liefert die Zeichen, die hereinkommen', async () => {
  const f = fifoAnlegen();
  try {
    const leser = leserProzess(f.pfad);
    const gelesen: number[] = [];
    const fertig = (async () => {
      for await (const stueck of leser.readable) {
        gelesen.push(...stueck);
        if (gelesen.length >= 5) break;
      }
    })();

    await new Promise((r) => setTimeout(r, 100));
    writeSync(f.offenhalten, ':5B;\n');
    await Promise.race([fertig, new Promise((r) => setTimeout(r, 2000))]);

    assert.equal(Buffer.from(gelesen).toString('latin1'), ':5B;\n');
    await leser.close();
  } finally {
    f.aufraeumen();
  }
});

test('leserProzess: zweites close() stoert nicht', async () => {
  const f = fifoAnlegen();
  try {
    const leser = leserProzess(f.pfad);
    await new Promise((r) => setTimeout(r, 100));
    await leser.close();
    await leser.close();          // darf weder haengen noch werfen
  } finally {
    f.aufraeumen();
  }
});
