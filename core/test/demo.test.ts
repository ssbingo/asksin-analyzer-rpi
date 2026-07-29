import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEMO_GERAETE,
  DEMO_ZENTRALE,
  baueNoiseZeile,
  baueTelegrammZeile,
  demoDevListFetch,
  demoPortOpener,
} from '../src/demo/index.ts';
import { parseLine } from '../src/decode/parseLine.ts';
import { SerialIngest } from '../src/ingest/ingest.ts';
import { decodeCcuResponse } from '../src/resolve/ccuResponse.ts';
import { DeviceResolver, parseDevList } from '../src/resolve/devlist.ts';
import type { ParsedLine } from '../src/decode/types.ts';
import { FakeTime, tick } from './helpers/fakes.ts';

test('baueTelegrammZeile: Rundreise durch den eigenen Parser, feldgenau', () => {
  const zeile = baueTelegrammZeile({
    rssi: -72, cnt: 42, flags: 0x10, msgType: 0x41,
    from: 0x320001, to: DEMO_ZENTRALE, payloadHex: 'A1B2C3',
  });
  const res = parseLine(zeile.trim(), () => 0);
  assert.equal(res.kind, 'telegram');
  assert.ok(res.kind === 'telegram');
  assert.equal(res.telegram.rssi, -72);
  assert.equal(res.telegram.msgCounter, 42);
  assert.equal(res.telegram.flags, 0x10);
  assert.equal(res.telegram.msgType, 0x41);
  assert.equal(res.telegram.fromAddr, 0x320001);
  assert.equal(res.telegram.toAddr, DEMO_ZENTRALE);
  assert.equal(res.telegram.payloadHex, 'A1B2C3');
  assert.equal(res.telegram.length, 12);

  const rauschen = parseLine(baueNoiseZeile(-91).trim(), () => 0);
  assert.equal(rauschen.kind, 'noise');
  assert.ok(rauschen.kind === 'noise' && rauschen.noise.rssi === -91);
});

test('Demo-Port: zehn Minuten Verkehr, alles parserkonform', async () => {
  const time = new FakeTime();
  const lines: ParsedLine[] = [];
  const ingest = new SerialIngest({
    openPort: demoPortOpener(time),
    onLine: (l) => {
      lines.push(l);
    },
    time,
    silenceTimeoutMs: 60_000,
  });
  ingest.start();
  await tick();
  await time.advance(10 * 60_000);
  await ingest.stop();

  const s = ingest.stats;
  assert.ok(s.noise >= 700, `Rauschzeilen alle 750 ms (${s.noise})`);
  assert.ok(s.telegrams >= 30, `lebendiger Funkverkehr (${s.telegrams})`);
  // Nur Bootmeldung und der absichtliche Störimpuls dürfen verworfen sein:
  const verworfen = Object.values(s.ignored).reduce((a, b) => a + b, 0);
  assert.ok(verworfen <= 2, `kaum Verworfenes (${verworfen})`);
  assert.equal(s.reconnects, 0, 'die Simulation reißt nie ab');

  const absender = new Set(
    lines.filter((l) => l.kind === 'telegram').map((l) =>
      l.kind === 'telegram' ? l.telegram.fromAddr : 0,
    ),
  );
  assert.ok(absender.size >= 8, `viele verschiedene Geräte (${absender.size})`);
  // Das „defekte" Gerät sendet mit Abstand am häufigsten:
  const defekt = lines.filter(
    (l) => l.kind === 'telegram' && l.telegram.fromAddr === 0x350001,
  ).length;
  assert.ok(defekt >= 10, `Dauersender ist aktiv (${defekt})`);
});

test('Demo-DevList: Drahtformat-Rundreise, Namen passen zum Funkverkehr', async () => {
  const time = new FakeTime();
  const bytes = await demoDevListFetch(time)('egal', new AbortController().signal);
  const resolver = new DeviceResolver(parseDevList(decodeCcuResponse(bytes)));

  assert.equal(resolver.size, DEMO_GERAETE.length + 2, 'Zentrale doppelt');
  assert.equal(resolver.entries(DEMO_ZENTRALE).length, 2);
  assert.equal(resolver.resolve(DEMO_ZENTRALE)?.kind, 'central');
  assert.equal(resolver.nameOf(0x300003), 'Temperatur_Wäschekeller', 'Umlaut überlebt');
  assert.equal(resolver.resolve(0x340001)?.isHmIp, true);
  assert.equal(resolver.nameOf(0x350001), 'Defekt_BWM Carport (klemmt)');
});
