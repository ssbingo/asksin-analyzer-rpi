import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';

import { ApiServer } from '../src/api/server.ts';
import { dayOf, dayRange, toVersionParts } from '../src/api/compat.ts';
import { openDatabase } from '../src/persist/db.ts';
import { Analyzer } from '../src/service/analyzer.ts';
import { DevListService } from '../src/resolve/fetcher.ts';
import { FakePort, FakeTime, alsCcuAntwort, tick } from './helpers/fakes.ts';

const T0 = 1_000_000;                                         // FakeTime-Start

const TELEGRAMM = ':5A0E0100701A2B3C0000000102030405;\n';     // WEATHER, Flags 0x00
const BURST = ':641005100111111122222201020304050607;\n';     // CONFIG, BURST
const HMIP = ':500E018096ABCDEF123456AABBCCDDEE;\n';          // Typ 0x96 ≥ 0x80

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
  api: ApiServer;
  base: string;
  gesetzt: Array<Record<string, string>>;
  einspeisen: (...zeilen: string[]) => Promise<void>;
}

/** Baut die volle Kette und hängt den Abbau an den Test — läuft auch bei
 *  Fehlschlägen, sonst hielte der offene Server den Prozess fest. */
async function aufbau(t: TestContext, extra: {
  mitDevList?: boolean;
  authToken?: string;
  maxLogBatch?: number;
  onReboot?: () => void;
  uiDir?: string;
  update?: import('../src/api/server.ts').UpdateHooks;
} = {}): Promise<Aufbau> {
  const time = new FakeTime();
  const ports: FakePort[] = [];
  const gesetzt: Array<Record<string, string>> = [];
  const db = openDatabase(':memory:');
  const devList =
    extra.mitDevList === true
      ? new DevListService({
          host: 'ccu.local',
          time,
          fetchBytes: () => Promise.resolve(alsCcuAntwort(LISTE)),
        })
      : undefined;
  const analyzer = new Analyzer({
    openPort: () => {
      const port = new FakePort();
      ports.push(port);
      return Promise.resolve(port);
    },
    db,
    time,
    flushIntervalMs: 50,
    ingest: { silenceTimeoutMs: 600_000 },
    ...(devList === undefined ? {} : { devList }),
  });
  const api = new ApiServer({
    analyzer,
    db,
    ...(devList === undefined ? {} : { devList }),
    version: '0.0.1',
    config: { ccuip: 'ccu.local' },
    ...(extra.authToken === undefined ? {} : { authToken: extra.authToken }),
    ...(extra.maxLogBatch === undefined ? {} : { maxLogBatch: extra.maxLogBatch }),
    ...(extra.onReboot === undefined ? {} : { onReboot: extra.onReboot }),
    ...(extra.uiDir === undefined ? {} : { uiDir: extra.uiDir }),
    ...(extra.update === undefined ? {} : { update: extra.update }),
    time,
    onSetConfig: (c) => {
      gesetzt.push(c);
    },
  });

  analyzer.start();
  await tick();
  const { port } = await api.listen(0);
  t.after(async () => {
    await api.close();
    await analyzer.stop();
    db.close();
  });

  return {
    time,
    ports,
    analyzer,
    db,
    api,
    base: `http://127.0.0.1:${port}`,
    gesetzt,
    einspeisen: async (...zeilen) => {
      for (const z of zeilen) ports[0]!.feed(z);
      await time.advance(0);
      await time.advance(50);                 // Flush-Takt → Datenbank
    },
  };
}

// ---------------------------------------------------------------- reine Helfer

test('toVersionParts: Semver → version_upper/version_lower der App', () => {
  assert.deepEqual(toVersionParts('0.0.1'), { upper: 0, lower: 0.1 });
  assert.deepEqual(toVersionParts('1.4.2'), { upper: 1, lower: 4.2 });
  assert.deepEqual(toVersionParts('3.6'), { upper: 3, lower: 6 });
});

test('dayRange: verwirft Nicht-Daten und unmögliche Kalendertage', () => {
  assert.throws(() => dayRange('gestern'), /yyyymmdd/);
  assert.throws(() => dayRange('20260230'), /Kalendertag/);
  const { fromTs, toTs } = dayRange(dayOf(T0));
  assert.ok(fromTs <= T0 && T0 < toTs, 'T0 liegt in seinem eigenen Tag');
});

// ---------------------------------------------------------------- Datenabruf

test('getLogByLogNumber: CSV im XS-Format, Polling über lognum', async (t) => {
  const a = await aufbau(t);
  await a.einspeisen(TELEGRAMM, BURST, HMIP);

  const alle = await (await fetch(`${a.base}/getLogByLogNumber?format=csv&lognum=0`)).text();
  const zeilen = alle.split('\n');
  assert.equal(zeilen.length, 3);
  assert.equal(zeilen[0], `1;${T0};-90;1A2B3C;000000;14;1;WEATHER;HMIP_UNKNOWN`);
  assert.equal(zeilen[1], `2;${T0};-100;111111;222222;16;5;CONFIG;BURST`);
  assert.equal(zeilen[2], `3;${T0};-80;ABCDEF;123456;14;1;HMIP_TYPE;`);

  const rest = await (await fetch(`${a.base}/getLogByLogNumber?format=csv&lognum=1`)).text();
  assert.equal(rest.split('\n').length, 2);
  assert.ok(rest.startsWith('2;'), 'nur Telegramme NEUER als lognum');
});

test('getLogByLogNumber: Batchgrenze wie das Original (Vorgabe 50)', async (t) => {
  const a = await aufbau(t, { maxLogBatch: 2 });
  await a.einspeisen(TELEGRAMM, TELEGRAMM, TELEGRAMM);
  const text = await (await fetch(`${a.base}/getLogByLogNumber?format=csv&lognum=0`)).text();
  assert.equal(text.split('\n').length, 2, 'App pollt bei voller Antwort sofort weiter');
});

test('getRSSILog: Minutenmittel, tstamp in Sekunden, fromTstamp exakt', async (t) => {
  const a = await aufbau(t);
  await a.einspeisen(':5B;\n', ':50;\n');     // −91 und −80 in derselben Minute

  const minute = Math.floor(T0 / 60_000);
  const res = await fetch(`${a.base}/getRSSILog?fromTstamp=0`);
  const log = (await res.json()) as Array<{ type: number; tstamp: number; rssi: number }>;
  assert.deepEqual(log, [{ type: 0, tstamp: minute * 60, rssi: -85 }]);

  const danach = await (
    await fetch(`${a.base}/getRSSILog?fromTstamp=${minute * 60 + 1}`)
  ).json();
  assert.deepEqual(danach, [], 'Einträge vor fromTstamp kommen nicht doppelt');
});

test('getConfig: alle Felder der Info-Ansicht, sinnvoll umgedeutet', async (t) => {
  const a = await aufbau(t, { mitDevList: true });
  const c = (await (await fetch(`${a.base}/getConfig`)).json()) as Record<string, unknown>;
  assert.equal(c['version_upper'], 0);
  assert.equal(c['version_lower'], 0.1);
  assert.equal(c['ccuip'], 'ccu.local');
  assert.equal(c['resolve'], 1);
  assert.equal(c['boottime'], Math.floor(T0 / 1000));
  assert.equal(c['sdcardavailable'], 0, 'keine SD-Karte auf dem Pi');
  assert.ok((c['spiffssizekb'] as number) >= 1, 'SPIFFS ≙ SQLite-Größe');
  assert.equal(typeof c['hostname'], 'string');
  for (const feld of ['ntp', 'ip', 'netmask', 'gw', 'macaddress', 'backendurl']) {
    assert.ok(feld in c, `Feld ${feld} muss existieren, sonst bricht die App`);
  }
});

test('getAskSinAnalyzerDevListJSON: JSON mit charset; ohne Dienst 503', async (t) => {
  const mit = await aufbau(t, { mitDevList: true });
  const res = await fetch(`${mit.base}/getAskSinAnalyzerDevListJSON`);
  assert.equal(res.status, 200);
  assert.match(
    res.headers.get('content-type') ?? '',
    /charset=/,
    'ohne charset= rät die App utf-8 — hier stimmt es dann sogar',
  );
  assert.equal(await res.text(), LISTE);

  const ohne = await aufbau(t);
  assert.equal((await fetch(`${ohne.base}/getAskSinAnalyzerDevListJSON`)).status, 503);
});

// ---------------------------------------------------------------- Tages-CSV

test('downloadcsv/download: Tages-CSV aus der Datenbank; deletecsv leert den Tag', async (t) => {
  const a = await aufbau(t);
  await a.einspeisen(TELEGRAMM, BURST);
  const tag = dayOf(T0);

  const heute = await fetch(`${a.base}/downloadcsv`);
  assert.match(heute.headers.get('content-disposition') ?? '', new RegExp(tag));
  assert.equal((await heute.text()).split('\n').length, 2);

  const gezielt = await (await fetch(`${a.base}/download?filename=${tag}.csv`)).text();
  assert.equal(gezielt.split('\n').length, 2);
  assert.equal((await fetch(`${a.base}/download?filename=kaputt.csv`)).status, 400);
  const leer = await (await fetch(`${a.base}/download?filename=20200101.csv`)).text();
  assert.equal(leer, '', 'fremder Tag ist leer');

  assert.equal((await fetch(`${a.base}/deletecsv?backup=1`, { method: 'POST' })).status, 200);
  assert.equal(await (await fetch(`${a.base}/downloadcsv`)).text(), '');
});

// ---------------------------------------------------------------- Kommandos

test('ESP-Spezifika: SD-Routen antworten OK, Config-Portal 501, Unbekanntes 404', async (t) => {
  const a = await aufbau(t);
  assert.equal(await (await fetch(`${a.base}/insertSD`)).text(), 'OK');
  assert.equal((await fetch(`${a.base}/listSD`)).status, 200);
  assert.equal(
    (await fetch(`${a.base}/rebootInConfigMode`, { method: 'POST' })).status,
    501,
  );
  assert.equal(
    (await fetch(`${a.base}/reboot`, { method: 'POST' })).status,
    501,
    'ohne onReboot-Callback ehrlich nicht implementiert',
  );
  assert.equal((await fetch(`${a.base}/gibtsnicht`)).status, 404);
});

test('reboot: mit Callback OK und ausgelöst', async (t) => {
  let neustarts = 0;
  const a = await aufbau(t, {
    onReboot: () => {
      neustarts++;
    },
  });
  assert.equal((await fetch(`${a.base}/reboot`, { method: 'POST' })).status, 200);
  await tick();
  assert.equal(neustarts, 1);
});

test('formatspiffs leert die Datenbank („Datenbank leeren")', async (t) => {
  const a = await aufbau(t);
  await a.einspeisen(TELEGRAMM, ':5B;\n');
  assert.equal((await fetch(`${a.base}/formatspiffs`, { method: 'POST' })).status, 200);
  for (const tabelle of ['telegrams', 'noise_minutes', 'device_hours']) {
    const n = a.db.prepare(`SELECT COUNT(*) c FROM ${tabelle}`).get() as { c: number };
    assert.equal(n.c, 0, tabelle);
  }
});

test('setConfig: Auth-Pflicht bei gesetztem Token; ccuip wird wirksam', async (t) => {
  const a = await aufbau(t, { authToken: 'geheim' });

  const ohne = await fetch(`${a.base}/setConfig?ccuip=192.168.1.99`, { method: 'POST' });
  assert.equal(ohne.status, 401);
  assert.equal(a.gesetzt.length, 0, 'nichts angenommen');

  const mit = await fetch(`${a.base}/setConfig?ccuip=192.168.1.99`, {
    method: 'POST',
    headers: { authorization: 'Bearer geheim' },
  });
  assert.equal(mit.status, 200);
  assert.deepEqual(a.gesetzt, [{ ccuip: '192.168.1.99' }]);

  const c = (await (await fetch(`${a.base}/getConfig`)).json()) as Record<string, unknown>;
  assert.equal(c['ccuip'], '192.168.1.99');
});

test('setConfig: Felder auch aus dem POST-Body (urlencoded)', async (t) => {
  const a = await aufbau(t);
  const res = await fetch(`${a.base}/setConfig`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'ccuip=10.0.0.2&hostname=analyzer-keller&unbekannt=weg',
  });
  assert.equal(res.status, 200);
  assert.deepEqual(a.gesetzt, [{ ccuip: '10.0.0.2', hostname: 'analyzer-keller' }]);
});

// ---------------------------------------------------------------- eigene API

test('/api/telegrams: neueste zuerst laden, dann inkrementell über afterId', async (t) => {
  const a = await aufbau(t, { mitDevList: true });
  await a.einspeisen(TELEGRAMM, BURST, HMIP);

  const erste = (await (
    await fetch(`${a.base}/api/telegrams?limit=2`)
  ).json()) as { telegrams: Array<Record<string, unknown>>; lastId: number };
  assert.equal(erste.telegrams.length, 2, 'limit greift');
  assert.deepEqual(
    erste.telegrams.map((x) => x['id']),
    [2, 3],
    'die NEUESTEN, in aufsteigender Reihenfolge',
  );
  assert.equal(erste.lastId, 3);

  const nach = (await (
    await fetch(`${a.base}/api/telegrams?afterId=1`)
  ).json()) as { telegrams: Array<Record<string, unknown>> };
  assert.equal(nach.telegrams.length, 2);
  const b = nach.telegrams[0]!;
  assert.equal(b['typeName'], 'CONFIG');
  assert.deepEqual(b['flagNames'], ['BURST']);
  assert.equal(b['fromHex'], '111111');
  assert.equal(b['fromName'], '111111', 'unbekannte Adresse bleibt Hex');
  assert.equal(nach.telegrams[1]!['isHmIp'], true);

  const t1 = (await (
    await fetch(`${a.base}/api/telegrams?afterId=0&limit=1`)
  ).json()) as { telegrams: Array<Record<string, unknown>> };
  assert.equal(
    t1.telegrams[0]!['fromName'],
    'Wäschekeller Fenster',
    'Namen kommen aufgelöst an',
  );
});

test('/api/noise: Minutenaggregat mit Mittelwert und ms-Zeitstempel', async (t) => {
  const a = await aufbau(t);
  await a.einspeisen(':5B;\n', ':50;\n');     // −91, −80

  const { noise } = (await (
    await fetch(`${a.base}/api/noise?minutes=100`)
  ).json()) as { noise: Array<Record<string, number>> };
  assert.equal(noise.length, 1);
  const m = noise[0]!;
  assert.equal(m['ts'], Math.floor(T0 / 60_000) * 60_000);
  assert.equal(m['samples'], 2);
  assert.equal(m['min'], -91);
  assert.equal(m['max'], -80);
  assert.equal(m['avg'], -85.5);
});

// ---------------------------------------------------------------- Update-API

test('/api/update/*: ohne Hooks 501, mit Hooks voller Ablauf', async (t) => {
  const ohne = await aufbau(t);
  assert.equal((await fetch(`${ohne.base}/api/update/versions`)).status, 501);

  let starts = 0;
  let geflasht: Buffer | null = null;
  const mit = await aufbau(t, {
    update: {
      versions: () => Promise.resolve({ version: '0.0.3', commit: 'abc1234' }),
      startCoreUpdate: () => {
        starts++;
        return starts === 1;                  // zweiter Start: läuft bereits
      },
      updateStatus: () => (starts === 0 ? null : { running: true, step: 'hole' }),
      flashFirmware: (hex) => {
        geflasht = hex;
        return Promise.resolve({ ok: true, log: 'avrdude done' });
      },
    },
  });

  const v = (await (await fetch(`${mit.base}/api/update/versions`)).json()) as Record<string, unknown>;
  assert.equal(v['commit'], 'abc1234');

  const leer = (await (await fetch(`${mit.base}/api/update/status`)).json()) as Record<string, unknown>;
  assert.equal(leer['running'], false, 'ohne Statusdatei: nicht laufend');

  assert.equal((await fetch(`${mit.base}/api/update/core`, { method: 'POST' })).status, 202);
  assert.equal(
    (await fetch(`${mit.base}/api/update/core`, { method: 'POST' })).status,
    409,
    'Doppelstart wird abgewiesen',
  );
  const s = (await (await fetch(`${mit.base}/api/update/status`)).json()) as Record<string, unknown>;
  assert.equal(s['step'], 'hole');

  const hex = ':100000000C9435000C945D000C945D000C945D0024\n:00000001FF\n';
  const antwort = await fetch(`${mit.base}/api/update/firmware`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: hex,
  });
  assert.equal(antwort.status, 200);
  assert.equal(((await antwort.json()) as { ok: boolean }).ok, true);
  assert.equal(geflasht!.toString('latin1'), hex, 'Bytes kommen unverändert an');
});

test('/api/update/*: mit gesetztem Token ist ALLES auth-pflichtig', async (t) => {
  const a = await aufbau(t, {
    authToken: 'geheim',
    update: {
      versions: () => Promise.resolve({}),
      startCoreUpdate: () => true,
      updateStatus: () => null,
      flashFirmware: () => Promise.resolve({ ok: true, log: '' }),
      updateVerfuegbar: () => true,
    },
  });
  assert.equal((await fetch(`${a.base}/api/update/versions`)).status, 401);
  assert.equal((await fetch(`${a.base}/api/update/status`)).status, 401);
  // health bleibt offen und trägt das Badge-Signal des Selbstchecks:
  const h = (await (await fetch(`${a.base}/api/health`)).json()) as Record<string, unknown>;
  assert.equal(h['updateVerfuegbar'], true, 'Selbstcheck-Ergebnis im Health');
  assert.equal((await fetch(`${a.base}/api/update/core`, { method: 'POST' })).status, 401);
  assert.equal(
    (
      await fetch(`${a.base}/api/update/versions`, {
        headers: { authorization: 'Bearer geheim' },
      })
    ).status,
    200,
  );
});

// ---------------------------------------------------------------- statisches UI

test('uiDir: Dateien, Asset-Caching, SPA-Fallback und Traversal-Schutz', async (t) => {
  const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'asksin-ui-'));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  writeFileSync(join(dir, 'index.html'), '<h1>AskSin-Analyzer</h1>');
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'assets', 'app-abc123.js'), 'console.log(1)');

  const a = await aufbau(t, { uiDir: dir });

  const start = await fetch(`${a.base}/`);
  assert.equal(start.status, 200);
  assert.match(await start.text(), /AskSin-Analyzer/);
  assert.match(start.headers.get('content-type') ?? '', /text\/html/);

  const asset = await fetch(`${a.base}/assets/app-abc123.js`);
  assert.match(asset.headers.get('content-type') ?? '', /javascript/);
  assert.match(asset.headers.get('cache-control') ?? '', /immutable/);

  const spa = await fetch(`${a.base}/liste`);
  assert.equal(spa.status, 200);
  assert.match(await spa.text(), /AskSin-Analyzer/, 'SPA-Fallback auf index.html');

  assert.equal((await fetch(`${a.base}/fehlt.js`)).status, 404, 'mit Endung kein Fallback');
  assert.equal(
    (await fetch(`${a.base}/..%2F..%2Fetc%2Fpasswd`)).status,
    404,
    'kein Ausbruch aus der Wurzel',
  );
  assert.equal(
    (await fetch(`${a.base}/api/gibtsnicht`)).status,
    404,
    '/api/* fällt nie auf die SPA zurück',
  );
});

test('/api/snapshot und /api/health: die Sicht des Analyzers über HTTP', async (t) => {
  const a = await aufbau(t, { mitDevList: true });
  await a.einspeisen(TELEGRAMM, ':5B;\n');

  const s = (await (await fetch(`${a.base}/api/snapshot`)).json()) as Record<string, any>;
  assert.equal(s['ingest']['telegrams'], 1);
  assert.equal(s['noiseFloor']['last'], -91);
  assert.equal(s['devices'][0]['name'], 'Wäschekeller Fenster');
  assert.equal(s['devList']['source'], 'ccu');

  const h = (await (await fetch(`${a.base}/api/health`)).json()) as Record<string, unknown>;
  assert.equal(h['ok'], true);
  assert.equal(h['connected'], true);
  assert.equal(h['telegrams'], 1);
});
