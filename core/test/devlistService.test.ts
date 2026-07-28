import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DevListService, buildDevListUrl } from '../src/resolve/fetcher.ts';
import type { DevListSource } from '../src/resolve/fetcher.ts';
import { DeviceResolver } from '../src/resolve/devlist.ts';
import { FakeTime, alsCcuAntwort, tick } from './helpers/fakes.ts';

const LISTE_1 = JSON.stringify({
  created_at: 1_785_300_000,
  devices: [
    { address: 0x1a2b3c, serial: 'OEQ1234567', name: 'Bad & Wäschekeller' },
    { address: 4677, serial: 'HmIP-RF', name: 'HmIP-RF' },
  ],
});
const LISTE_2 = JSON.stringify({
  created_at: 1_785_303_600,
  devices: [
    { address: 0x1a2b3c, serial: 'OEQ1234567', name: 'Büro Fenster' },
  ],
});

interface Aufbau {
  time: FakeTime;
  dienst: DevListService;
  abrufe: string[];
  updates: DevListSource[];
  fehler: unknown[];
}

/** Ein Dienst, dessen „CCU" die vorbereiteten Antworten der Reihe nach liefert. */
function aufbau(
  antworten: Array<Uint8Array | Error>,
  extra: { cachePath?: string; refreshMs?: number; retryMs?: number } = {},
): Aufbau {
  const time = new FakeTime();
  const abrufe: string[] = [];
  const updates: DevListSource[] = [];
  const fehler: unknown[] = [];
  const dienst = new DevListService({
    host: 'ccu.local',
    refreshMs: extra.refreshMs ?? 1000,
    retryMs: extra.retryMs ?? 100,
    ...(extra.cachePath === undefined ? {} : { cachePath: extra.cachePath }),
    time,
    fetchBytes: (url) => {
      abrufe.push(url);
      const a = antworten.shift();
      if (a === undefined) return Promise.reject(new Error('unerwarteter Abruf'));
      return a instanceof Error ? Promise.reject(a) : Promise.resolve(a);
    },
    onUpdate: (_r, source) => {
      updates.push(source);
    },
    onError: (e) => {
      fehler.push(e);
    },
  });
  return { time, dienst, abrufe, updates, fehler };
}

test('buildDevListUrl: Anführungszeichen als %22, Rest wörtlich', () => {
  assert.equal(
    buildDevListUrl('192.168.1.50'),
    'http://192.168.1.50:8181/a.exe?ret=' +
      'dom.GetObject(ID_SYSTEM_VARIABLES).Get(%22AskSinAnalyzerDevList%22).Value()',
  );
});

test('Erfolgreicher Abruf: Drahtformat wird ausgepackt, Umlaute überleben', async () => {
  const { time, dienst, updates } = aufbau([alsCcuAntwort(LISTE_1)]);
  const vorher = dienst.resolver;
  assert.equal(vorher, null, 'vor start() gibt es nichts');
  assert.equal(dienst.nameOf(0x1a2b3c), '1A2B3C', 'ohne Resolver: Hex');

  dienst.start();
  await tick();

  const r = dienst.resolver;
  assert.ok(r instanceof DeviceResolver);
  assert.equal(r.nameOf(0x1a2b3c), 'Bad & Wäschekeller', 'latin1 + &amp; entpackt');
  assert.equal(r.createdAt.getTime(), 1_785_300_000_000);
  assert.deepEqual(updates, ['ccu']);
  assert.equal(dienst.stats.source, 'ccu');
  assert.equal(dienst.stats.fetches, 1);
  assert.equal(dienst.stats.lastSuccessAt, time.now());
  await dienst.stop();
});

test('Fehlschlag hält den letzten Resolver; retry/refresh takten getrennt', async () => {
  const { time, dienst, abrufe, fehler } = aufbau([
    alsCcuAntwort(LISTE_1),
    new Error('CCU down'),
    alsCcuAntwort(LISTE_2),
  ]);
  dienst.start();
  await tick();
  assert.equal(abrufe.length, 1);

  await time.advance(1000);                    // refreshMs → 2. Abruf, scheitert
  assert.equal(abrufe.length, 2);
  assert.equal(dienst.stats.failures, 1);
  assert.equal(dienst.stats.lastErrorAt, time.now());
  assert.equal(fehler.length, 1);
  assert.equal(
    dienst.resolver?.nameOf(0x1a2b3c),
    'Bad & Wäschekeller',
    'alter Stand bleibt nutzbar',
  );

  await time.advance(100);                     // retryMs → 3. Abruf, Erfolg
  assert.equal(abrufe.length, 3);
  assert.equal(dienst.resolver?.nameOf(0x1a2b3c), 'Büro Fenster');
  assert.equal(dienst.resolver?.createdAt.getTime(), 1_785_303_600_000);
  await dienst.stop();
});

test('Cache: Erfolg schreibt atomar, Neustart lädt sofort daraus', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'asksin-devlist-'));
  const cachePath = join(dir, 'unter', 'devlist.json');
  try {
    const a = aufbau([alsCcuAntwort(LISTE_1)], { cachePath });
    a.dienst.start();
    await tick();
    assert.equal(readFileSync(cachePath, 'utf8'), LISTE_1, 'dekodiertes JSON');
    assert.equal(existsSync(`${cachePath}.tmp`), false, 'rename hat aufgeräumt');
    await a.dienst.stop();

    // Neustart: CCU nicht erreichbar — der Cache trägt trotzdem sofort.
    const b = aufbau([new Error('down'), new Error('down')], { cachePath });
    b.dienst.start();
    assert.equal(
      b.dienst.resolver?.nameOf(0x1a2b3c),
      'Bad & Wäschekeller',
      'synchron aus dem Cache, noch vor dem ersten Abruf',
    );
    assert.equal(b.dienst.stats.source, 'cache');
    await tick();                              // 1. Abruf scheitert
    assert.equal(b.dienst.stats.failures, 1);
    assert.equal(b.dienst.stats.source, 'cache', 'Quelle bleibt ehrlich');
    assert.deepEqual(b.updates, ['cache']);
    await b.dienst.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Kaputte Cache-Datei: gemeldet, aber kein Startabbruch', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'asksin-devlist-'));
  const cachePath = join(dir, 'devlist.json');
  try {
    writeFileSync(cachePath, '{halb geschrieben', 'utf8');
    const { dienst, fehler } = aufbau([alsCcuAntwort(LISTE_1)], { cachePath });
    dienst.start();
    assert.equal(dienst.resolver, null, 'Müll wird nicht zum Resolver');
    assert.equal(fehler.length, 1);
    await tick();                              // Abrufschleife rettet die Lage
    assert.equal(dienst.stats.source, 'ccu');
    assert.equal(readFileSync(cachePath, 'utf8'), LISTE_1, 'Cache repariert');
    await dienst.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Unbrauchbare CCU-Antwort zählt als Fehlschlag, nicht als Absturz', async () => {
  const kaputt = Uint8Array.from([...'<xml><exec>x</exec></xml>'].map((c) =>
    c.codePointAt(0)!,
  ));
  const { dienst, fehler } = aufbau([kaputt]);
  dienst.start();
  await tick();
  assert.equal(dienst.resolver, null);
  assert.equal(dienst.stats.failures, 1);
  assert.match(String(fehler[0]), /ret/);
  await dienst.stop();
});

test('stop() beendet; doppeltes start() wirft', async () => {
  const { time, dienst, abrufe } = aufbau([alsCcuAntwort(LISTE_1)]);
  dienst.start();
  assert.throws(() => dienst.start(), /läuft bereits/);
  await tick();
  await dienst.stop();
  await time.advance(10_000);
  assert.equal(abrufe.length, 1, 'nach stop() keine weiteren Abrufe');
});
