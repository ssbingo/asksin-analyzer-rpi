import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  Protokoll,
  formatiere,
  istStufe,
  tagesschluessel,
} from '../src/log/protokoll.ts';
import {
  auffaelligkeiten,
  deuteDrosselung,
  drosselungText,
  erhebeSystemwerte,
  meminfoWert,
} from '../src/log/diagnose.ts';
import { FakeTime } from './helpers/fakes.ts';

function verzeichnis(): string {
  return mkdtempSync(join(tmpdir(), 'asksin-protokoll-'));
}

test('Stufen filtern: nur bis zur eingestellten Höhe wird geschrieben', () => {
  const zeilen: string[] = [];
  const p = new Protokoll({
    verzeichnis: verzeichnis(),
    stufe: 'info',
    anhaengen: (_pfad, text) => zeilen.push(text),
  });
  p.fehler('a', 'Fehler');
  p.info('a', 'Info');
  p.debug('a', 'Debug');
  p.spur('a', 'Alles');
  assert.equal(zeilen.length, 2, 'fehler und info, nicht debug/alles');

  p.einstellen('alles', 14);
  p.spur('a', 'jetzt aber');
  assert.equal(zeilen.length, 3);

  p.einstellen('fehler', 14);
  p.info('a', 'unterdrückt');
  assert.equal(zeilen.length, 3);
  assert.equal(p.schreibt('fehler'), true);
  assert.equal(p.schreibt('info'), false);
});

test('Format: feste Spalten, Zeitstempel, Bereich, Zusatzdaten', () => {
  const zeile = formatiere(
    new Date(2026, 6, 31, 8, 12, 33, 45),
    'fehler',
    'ingest',
    'Port weg',
    { code: 'EIO', versuche: 3 },
  );
  assert.match(zeile, /^2026-07-31 08:12:33\.045 {2}FEHLER {2}\[ingest\]/);
  assert.match(zeile, /Port weg/);
  assert.match(zeile, /\{"code":"EIO","versuche":3\}$/);
  // Zeilenumbrüche dürfen das Spaltenbild nicht zerreißen:
  assert.equal(formatiere(new Date(), 'info', 'x', 'a\nb').includes('\n'), false);
});

test('Tagesrotation: neue Datei nach Mitternacht, alte bleibt erhalten', async () => {
  const dir = verzeichnis();
  const time = new FakeTime(new Date(2026, 6, 30, 23, 59, 50).getTime());
  const p = new Protokoll({ verzeichnis: dir, stufe: 'info', time, tage: 30 });
  p.info('a', 'vor Mitternacht');
  await time.advance(20_000);                        // 00:00:10 des Folgetags
  p.info('a', 'nach Mitternacht');

  const namen = readdirSync(dir).sort();
  assert.deepEqual(namen, ['asksin-2026-07-30.log', 'asksin-2026-07-31.log']);
  assert.match(readFileSync(join(dir, namen[0]!), 'utf8'), /vor Mitternacht/);
  assert.match(readFileSync(join(dir, namen[1]!), 'utf8'), /nach Mitternacht/);
});

test('Aufbewahrung: ältere Dateien verschwinden, jüngere bleiben', () => {
  const dir = verzeichnis();
  for (const tag of ['2026-07-20', '2026-07-28', '2026-07-29', '2026-07-30']) {
    writeFileSync(join(dir, `asksin-${tag}.log`), 'alt\n');
  }
  writeFileSync(join(dir, 'fremd.txt'), 'nicht anfassen\n');
  const time = new FakeTime(new Date(2026, 6, 31, 12, 0, 0).getTime());
  const p = new Protokoll({ verzeichnis: dir, stufe: 'info', tage: 3, time });
  p.info('a', 'heute');

  const namen = readdirSync(dir).sort();
  assert.deepEqual(namen, [
    'asksin-2026-07-29.log',
    'asksin-2026-07-30.log',
    'asksin-2026-07-31.log',
    'fremd.txt',
  ]);
});

test('Download: nur echte Logdateinamen, kein Pfad-Ausbruch', () => {
  const dir = verzeichnis();
  const p = new Protokoll({ verzeichnis: dir, stufe: 'info' });
  p.info('a', 'Inhalt');
  const heute = `asksin-${tagesschluessel(new Date())}.log`;
  assert.match(p.lies(heute) ?? '', /Inhalt/);
  for (const boese of [
    '../../../etc/passwd',
    '/etc/passwd',
    'asksin-2026-07-31.log/../../x',
    'nicht-meins.log',
    '',
  ]) {
    assert.equal(p.lies(boese), null, `abgewiesen: ${boese}`);
  }
});

test('Schreibfehler beenden den Dienst nicht, werden aber gemerkt', () => {
  const p = new Protokoll({
    verzeichnis: verzeichnis(),
    stufe: 'info',
    anhaengen: () => {
      throw new Error('Dateisystem voll');
    },
  });
  p.info('a', 'geht nicht');                          // darf nicht werfen
  assert.match(p.schreibfehler ?? '', /Dateisystem voll/);
});

test('istStufe erkennt gültige Stufen', () => {
  for (const s of ['fehler', 'info', 'debug', 'alles']) assert.ok(istStufe(s));
  for (const s of ['warn', '', 'INFO', 42, null]) assert.equal(istStufe(s), false);
});

// ---- Diagnose ------------------------------------------------------------

test('Drosselungsbits: Unterspannung jetzt und seit dem Start', () => {
  const d = deuteDrosselung(0x50005);
  assert.deepEqual(d, {
    unterspannungJetzt: true,
    drosselungJetzt: true,
    temperaturgrenzeJetzt: false,
    unterspannungSeitStart: true,
    drosselungSeitStart: true,
    temperaturgrenzeSeitStart: false,
  });
  assert.deepEqual(deuteDrosselung(0), {
    unterspannungJetzt: false,
    drosselungJetzt: false,
    temperaturgrenzeJetzt: false,
    unterspannungSeitStart: false,
    drosselungSeitStart: false,
    temperaturgrenzeSeitStart: false,
  });
  assert.equal(drosselungText(deuteDrosselung(0)).length, 0);
  assert.match(drosselungText(deuteDrosselung(0x1))[0]!, /Unterspannung JETZT/);
});

test('meminfoWert liest Kilobyte und rechnet in Megabyte um', () => {
  const text = 'MemTotal:        1998848 kB\nMemAvailable:     123456 kB\n';
  assert.equal(Math.round(meminfoWert(text, 'MemTotal')!), 1952);
  assert.equal(Math.round(meminfoWert(text, 'MemAvailable')!), 121);
  assert.equal(meminfoWert(text, 'GibtEsNicht'), null);
});

test('Systemwerte: Unterspannung und wenig Speicher werden auffällig', async () => {
  const w = await erhebeSystemwerte({
    leseDrosselung: () => Promise.resolve(0x1),
    leseTemperatur: () => 82.5,
    leseMeminfo: () => 'MemAvailable:      40960 kB\nSwapTotal:  0 kB\nSwapFree: 0 kB\n',
  });
  assert.equal(w.temperaturC, 82.5);
  assert.equal(w.drosselung?.unterspannungJetzt, true);
  const auff = auffaelligkeiten(w);
  assert.ok(auff.some((a) => /Unterspannung JETZT/.test(a)));
  assert.ok(auff.some((a) => /Temperatur 82\.5/.test(a)));
  assert.ok(auff.some((a) => /Arbeitsspeicher verfügbar/.test(a)));
});

test('Systemwerte ohne vcgencmd: kein Absturz, nur keine Drosselungsangabe', async () => {
  const w = await erhebeSystemwerte({
    leseDrosselung: () => Promise.resolve(null),
    leseTemperatur: () => null,
    leseMeminfo: () => null,
  });
  assert.equal(w.drosselung, null);
  assert.equal(w.temperaturC, null);
  assert.ok(w.speicherGesamtMb > 0, 'Grundwerte kommen aus node:os');
  assert.deepEqual(auffaelligkeiten(w).filter((a) => /Unterspannung/.test(a)), []);
});
