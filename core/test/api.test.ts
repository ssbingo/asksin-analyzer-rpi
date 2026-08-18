import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';

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
    // Steht in der CCU, funkt aber nie — genau der Fall, den der Abgleich
    // sichtbar machen soll.
    { address: 0x9f9f9f, serial: 'NEQ7654321', name: 'Dachboden Rauchmelder' },
    // Gruppe und Zentrale zaehlen NICHT als Funkgeraete: Eine Gruppe hat
    // keinen Sender, die Zentrale sendet unter eigener Adresse.
    { address: 0xabcdef, serial: '*Rauchmelder-Team', name: 'Team' },
    { address: 0x275000, serial: 'BidCoS-RF', name: 'Zentrale' },
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
  handbuecher?: Record<string, { datei: string; name: string }>;
  update?: import('../src/api/server.ts').UpdateHooks;
  verbund?: import('../src/api/server.ts').ApiServerOptions['verbund'];
  netzwerk?: import('../src/api/server.ts').NetzwerkHooks;
  statusAnzeige?: import('../src/api/server.ts').ApiServerOptions['statusAnzeige'];
  langzeit?: import('../src/api/server.ts').ApiServerOptions['langzeit'];
  mitschnitt?: import('../src/api/server.ts').ApiServerOptions['mitschnitt'];
  demo?: boolean;
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
    config: { ccuip: 'ccu.local', standort: 'Testkeller', demo: extra.demo === true },
    ...(extra.authToken === undefined ? {} : { authToken: extra.authToken }),
    ...(extra.maxLogBatch === undefined ? {} : { maxLogBatch: extra.maxLogBatch }),
    ...(extra.onReboot === undefined ? {} : { onReboot: extra.onReboot }),
    ...(extra.uiDir === undefined ? {} : { uiDir: extra.uiDir }),
    ...(extra.handbuecher === undefined ? {} : { handbuecher: extra.handbuecher }),
    ...(extra.update === undefined ? {} : { update: extra.update }),
    ...(extra.verbund === undefined ? {} : { verbund: extra.verbund }),
    ...(extra.netzwerk === undefined ? {} : { netzwerk: extra.netzwerk }),
    ...(extra.mitschnitt === undefined ? {} : { mitschnitt: extra.mitschnitt }),
    ...(extra.statusAnzeige === undefined ? {} : { statusAnzeige: extra.statusAnzeige }),
    ...(extra.langzeit === undefined ? {} : { langzeit: extra.langzeit }),
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
  assert.equal(c['standort'], 'Testkeller');
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
    body: 'ccuip=10.0.0.2&hostname=analyzer-keller&standort=Flur+OG&unbekannt=weg',
  });
  assert.equal(res.status, 200);
  assert.deepEqual(a.gesetzt, [
    { ccuip: '10.0.0.2', hostname: 'analyzer-keller', standort: 'Flur OG' },
  ]);
  const c = (await (await fetch(`${a.base}/getConfig`)).json()) as Record<string, unknown>;
  assert.equal(c['standort'], 'Flur OG', 'Standort sofort wirksam');
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

test('/api/telegrams: minutes grenzt nach Zeit ein, nicht nach Anzahl', async (t) => {
  // Anlass: In der Übersicht liefen zwei Reihen nebeneinander, das
  // Grundrauschen nach ZEIT und die Telegramme nach ANZAHL. Bei 16
  // Telegrammen je Minute waren die „neuesten 500" genau 31 Minuten, während
  // die Unterschrift drei Stunden versprach. Am 14.08.2026 gefragt: „wieso
  // haben beide Analyzer nur ab ca 8:00 Uhr Telegramme?"
  const a = await aufbau(t, { mitDevList: true });
  await a.einspeisen(TELEGRAMM, BURST, HMIP);

  const drin = (await (
    await fetch(`${a.base}/api/telegrams?minutes=180&limit=100`)
  ).json()) as { telegrams: unknown[]; gekuerzt: boolean };
  assert.equal(drin.telegrams.length, 3, 'alles im Fenster kommt mit');
  assert.equal(drin.gekuerzt, false, 'nichts abgeschnitten');

  // Ein Fenster, das eben erst begonnen hat, darf nichts Älteres liefern.
  // 1 Minute ist die kleinste zulässige Angabe; die Testtelegramme liegen
  // auf der Uhr des Aufbaus und damit darin — deshalb hier über die Grenze
  // pruefen, die wirklich beisst: die Anzahl.
  const knapp = (await (
    await fetch(`${a.base}/api/telegrams?minutes=180&limit=2`)
  ).json()) as { telegrams: Array<Record<string, unknown>>; gekuerzt: boolean };
  assert.equal(knapp.telegrams.length, 2);
  assert.deepEqual(
    knapp.telegrams.map((x) => x['id']),
    [2, 3],
    'gekuerzt wird am ALTEN Ende — das Neue ist das Interessante',
  );
  assert.equal(knapp.gekuerzt, true, 'und die Kuerzung wird gemeldet');

  // Ohne `minutes` bleibt es beim alten Verhalten (Telegrammliste).
  const ohne = (await (
    await fetch(`${a.base}/api/telegrams?limit=100`)
  ).json()) as { telegrams: unknown[] };
  assert.equal(ohne.telegrams.length, 3, 'ohne Zeitangabe wie bisher');
});

test('Snapshot: CCU-Abgleich zeigt, welche Geraete NIE gehoert wurden', async (t) => {
  // Der Wunsch dahinter: "Damit liesse sich gut ableiten, wieviel Geraete gar
  // nicht gehoert werden, obwohl sie in der CCU-Liste stehen." Genau das ist
  // beim Ausleuchten einer Anlage die Fundstelle — die Uebersicht zeigte
  // bisher nur, was sie hoert, nie was fehlt.
  const a = await aufbau(t, { mitDevList: true });
  await a.einspeisen(TELEGRAMM, BURST);   // 1A2B3C (in der Liste) und 111111

  const s = (await (await fetch(`${a.base}/api/snapshot`)).json()) as {
    ccuAbgleich: { inListe: number; jeGehoert: number; nieGehoert: number; fremde: number };
  };

  // Vier Listeneintraege, aber nur ZWEI reale Funkgeraete: Gruppe und
  // Zentrale zaehlen nicht mit.
  assert.equal(s.ccuAbgleich.inListe, 2, 'nur reale Geraete');
  assert.equal(s.ccuAbgleich.jeGehoert, 1, '1A2B3C hat gefunkt');
  assert.equal(s.ccuAbgleich.nieGehoert, 1, '9F9F9F steht in der CCU und schweigt');
  assert.equal(s.ccuAbgleich.fremde, 1, '111111 funkt, steht aber nicht in der Liste');
});

test('Snapshot ohne Geraeteliste: kein Abgleich statt falscher Nullen', async (t) => {
  // Ohne Liste ist "nie gehoert = 0" keine Aussage, sondern eine Luege.
  const a = await aufbau(t);
  await a.einspeisen(TELEGRAMM);
  const s = (await (await fetch(`${a.base}/api/snapshot`)).json()) as {
    ccuAbgleich: unknown;
  };
  assert.equal(s.ccuAbgleich, null);
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
        return Promise.resolve({ ok: true, log: 'Flash gestartet.' });
      },
      flashStand: () => ({ laeuft: false, log: 'avrdude done', ok: true }),
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
  // 202 statt 200: Der Aufruf STARTET nur. Frueher lief der ganze Flash in
  // dieser einen Anfrage — und als der Dienst am 10.08.2026 beim Anhalten des
  // Ingest haengte, blieb sie stundenlang offen, ohne dass irgendwo sichtbar
  // wurde, woran es lag.
  assert.equal(antwort.status, 202);
  assert.equal(((await antwort.json()) as { ok: boolean }).ok, true);
  assert.equal(geflasht!.toString('latin1'), hex, 'Bytes kommen unverändert an');

  // Der Verlauf kommt ueber den zweiten Endpunkt.
  const stand = (await (
    await fetch(`${mit.base}/api/update/firmware/stand`)
  ).json()) as { laeuft: boolean; log: string; ok: boolean | null };
  assert.equal(stand.laeuft, false);
  assert.equal(stand.ok, true);
  assert.match(stand.log, /avrdude/);
});

test('/api/update/firmware: ohne flashStand-Hook sagt der Stand-Endpunkt 501', async (t) => {
  const a = await aufbau(t, {
    update: {
      versions: () => Promise.resolve({}),
      startCoreUpdate: () => true,
      updateStatus: () => null,
      flashFirmware: () => Promise.resolve({ ok: true, log: '' }),
      // flashStand fehlt absichtlich
    },
  });
  assert.equal((await fetch(`${a.base}/api/update/firmware/stand`)).status, 501);
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

// ---------------------------------------------------------------- Verbund + Netzwerk

test('/api/verbund und /api/netzwerk: 501 ohne Rolle, mit Hooks voller Ablauf', async (t) => {
  const ohne = await aufbau(t);
  assert.equal((await fetch(`${ohne.base}/api/verbund`)).status, 501);
  assert.equal((await fetch(`${ohne.base}/api/netzwerk`)).status, 501);

  const auftraege: Array<Record<string, unknown>> = [];
  let bestaetigt = 0;
  const mit = await aufbau(t, {
    verbund: {
      uebersicht: () => Promise.resolve({ ts: 1, driftWarnMs: 1000, peers: [] }),
    },
    netzwerk: {
      zustand: () =>
        Promise.resolve({ hostname: 'pi', methode: 'dhcp', aenderbar: true }),
      anwenden: (a) => {
        auftraege.push(a);
        return auftraege.length === 1;         // zweiter Auftrag: läuft bereits
      },
      bestaetigen: () => {
        bestaetigt++;
        return true;
      },
      status: () => (auftraege.length === 0 ? null : { running: true, step: 'probe' }),
    },
  });

  const v = (await (await fetch(`${mit.base}/api/verbund`)).json()) as Record<string, unknown>;
  assert.equal(v['driftWarnMs'], 1000);

  const z = (await (await fetch(`${mit.base}/api/netzwerk`)).json()) as Record<string, unknown>;
  assert.equal(z['methode'], 'dhcp');

  const kaputt = await fetch(`${mit.base}/api/netzwerk`, { method: 'POST', body: 'kein json' });
  assert.equal(kaputt.status, 400);

  const ok = await fetch(`${mit.base}/api/netzwerk`, {
    method: 'POST',
    body: JSON.stringify({ method: 'statisch', address: '192.168.1.80' }),
  });
  assert.equal(ok.status, 202);
  assert.equal(auftraege[0]!['address'], '192.168.1.80');

  assert.equal(
    (await fetch(`${mit.base}/api/netzwerk`, { method: 'POST', body: '{}' })).status,
    409,
    'zweiter Auftrag während der Probezeit wird abgewiesen',
  );

  const s = (await (await fetch(`${mit.base}/api/netzwerk/status`)).json()) as Record<string, unknown>;
  assert.equal(s['step'], 'probe');

  assert.equal(
    (await fetch(`${mit.base}/api/netzwerk/bestaetigen`, { method: 'POST' })).status,
    200,
  );
  assert.equal(bestaetigt, 1);
});

test('/api/verbund/peers: Liste ohne Tokens, Ändern mit Auth und Validierung', async (t) => {
  const auftraege: Array<Record<string, unknown>> = [];
  const a = await aufbau(t, {
    authToken: 'geheim',
    verbund: {
      uebersicht: () => Promise.resolve({}),
      peers: () => ({
        peers: [{ url: 'http://og:8080', name: 'OG', hatToken: true, quelle: 'ui' }],
      }),
      peersAendern: (auftrag: Record<string, unknown>) => {
        if (auftrag['url'] === 'kaputt') throw new Error('url: http(s):// erwartet');
        auftraege.push(auftrag);
      },
    },
  });

  const liste = (await (await fetch(`${a.base}/api/verbund/peers`)).json()) as {
    peers: Array<Record<string, unknown>>;
  };
  assert.equal(liste.peers[0]!['hatToken'], true, 'Token selbst wird NIE geliefert');
  assert.equal(liste.peers[0]!['token'], undefined);

  assert.equal(
    (
      await fetch(`${a.base}/api/verbund/peers`, {
        method: 'POST',
        body: JSON.stringify({ aktion: 'hinzufuegen', url: 'http://dg:8080' }),
      })
    ).status,
    401,
    'Ändern nur mit Token',
  );
  const ok = await fetch(`${a.base}/api/verbund/peers`, {
    method: 'POST',
    headers: { authorization: 'Bearer geheim' },
    body: JSON.stringify({ aktion: 'hinzufuegen', url: 'http://dg:8080' }),
  });
  assert.equal(ok.status, 200);
  assert.equal(auftraege[0]!['url'], 'http://dg:8080');

  const schlecht = await fetch(`${a.base}/api/verbund/peers`, {
    method: 'POST',
    headers: { authorization: 'Bearer geheim' },
    body: JSON.stringify({ aktion: 'hinzufuegen', url: 'kaputt' }),
  });
  assert.equal(schlecht.status, 500, 'Validierungsfehler kommt lesbar zurück');
});

test('/api/statusanzeige: Zustand offen, Einstellen mit Auth, Blättern frei', async (t) => {
  const auftraege: Array<Record<string, unknown>> = [];
  let geblaettert = 0;
  const a = await aufbau(t, {
    authToken: 'geheim',
    statusAnzeige: {
      zustand: () => ({ konfig: { led: 'aus', oled: false, helligkeit: 40 }, seite: 0 }),
      einstellen: (auftrag: Record<string, unknown>) => {
        auftraege.push(auftrag);
      },
      seiteWeiter: () => {
        geblaettert++;
      },
    },
  });

  const z = (await (await fetch(`${a.base}/api/statusanzeige`)).json()) as Record<string, any>;
  assert.equal(z['konfig']['led'], 'aus');

  assert.equal(
    (
      await fetch(`${a.base}/api/statusanzeige`, {
        method: 'POST',
        body: JSON.stringify({ led: 'ws2812-spi', oled: true, helligkeit: 60 }),
      })
    ).status,
    401,
    'Umkonfigurieren nur mit Token',
  );
  const ok = await fetch(`${a.base}/api/statusanzeige`, {
    method: 'POST',
    headers: { authorization: 'Bearer geheim' },
    body: JSON.stringify({ led: 'ws2812-spi', oled: true, helligkeit: 60 }),
  });
  assert.equal(ok.status, 200);
  assert.equal(auftraege[0]!['helligkeit'], 60);

  assert.equal(
    (await fetch(`${a.base}/api/statusanzeige/seite`, { method: 'POST' })).status,
    200,
    'Blättern ist harmlos und bleibt offen',
  );
  assert.equal(geblaettert, 1);

  const ohne = await aufbau(t);
  assert.equal((await fetch(`${ohne.base}/api/statusanzeige`)).status, 501);
});

test('/api/netzwerk: verändernde Aufrufe sind mit Token auth-pflichtig', async (t) => {
  const a = await aufbau(t, {
    authToken: 'geheim',
    netzwerk: {
      zustand: () => Promise.resolve({}),
      anwenden: () => true,
      bestaetigen: () => true,
      status: () => null,
    },
  });
  assert.equal((await fetch(`${a.base}/api/netzwerk`)).status, 200, 'Lesen bleibt offen');
  assert.equal(
    (await fetch(`${a.base}/api/netzwerk`, { method: 'POST', body: '{}' })).status,
    401,
  );
  assert.equal(
    (await fetch(`${a.base}/api/netzwerk/bestaetigen`, { method: 'POST' })).status,
    401,
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
  assert.equal(s['standort'], 'Testkeller', 'Standort-Identität im Snapshot');
  assert.equal(s['ingest']['telegrams'], 1);
  assert.equal(s['noiseFloor']['last'], -91);
  assert.equal(s['devices'][0]['name'], 'Wäschekeller Fenster');
  assert.equal(s['devList']['source'], 'ccu');

  const h = (await (await fetch(`${a.base}/api/health`)).json()) as Record<string, unknown>;
  assert.equal(h['ok'], true);
  assert.equal(h['connected'], true);
  assert.equal(h['telegrams'], 1);
  assert.equal(h['standort'], 'Testkeller', 'Standort-Identität im Health');
});

test('Langzeitdaten: der Client wird serverseitig abgewiesen', async (t) => {
  // Die Weboberflaeche blendet den Abschnitt beim Client aus. Das ist
  // Bequemlichkeit, keine Zusicherung — die API ist im Heimnetz erreichbar,
  // also muss der Server selbst ablehnen.
  let rolle: 'master' | 'client' = 'client';
  const versuche: string[] = [];
  const { base } = await aufbau(t, {
    authToken: 'geheim',
    langzeit: {
      zustand: () => ({ rolle }),
      einstellen: (auftrag) => {
        if (auftrag['aktion'] === 'installieren') {
          if (rolle !== 'master') throw new Error('Nur auf dem Master verfügbar.');
          versuche.push('installiert');
        }
        if (auftrag['rolle'] === 'master') rolle = 'master';
      },
    },
  });

  const senden = (body: unknown): Promise<Response> =>
    fetch(`${base}/api/langzeitdaten`, {
      method: 'POST',
      headers: { authorization: 'Bearer geheim', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  const abgelehnt = await senden({ aktion: 'installieren' });
  assert.equal(abgelehnt.ok, false, 'Client darf nicht installieren');
  assert.equal(versuche.length, 0);

  // Rolle wechseln, dann geht es.
  const wechsel = await senden({ rolle: 'master' });
  assert.ok(wechsel.ok, `Rollenwechsel: ${wechsel.status} ${await wechsel.text()}`);
  assert.ok((await senden({ aktion: 'installieren' })).ok);
  assert.deepEqual(versuche, ['installiert']);

  const zustand = (await (await fetch(`${base}/api/langzeitdaten`)).json()) as {
    rolle: string;
  };
  assert.equal(zustand.rolle, 'master');
});

test('Langzeitdaten: ohne Token kein Zugriff auf das Setzen', async (t) => {
  const { base } = await aufbau(t, {
    authToken: 'geheim',
    langzeit: { zustand: () => ({ rolle: 'master' }), einstellen: () => undefined },
  });
  const ohne = await fetch(`${base}/api/langzeitdaten`, {
    method: 'POST',
    body: JSON.stringify({ aktion: 'installieren' }),
  });
  assert.equal(ohne.status, 401);
});

test('Mitschnitt: ueber die Weboberflaeche schaltbar, ohne Konsole', async (t) => {
  // Projektregel: Alles, was der Anwender braucht, muss ueber die
  // Weboberflaeche gehen. Der Mitschnitt war zuerst nur ueber config.json
  // erreichbar — also nur ueber die Konsole. Das ist der Test dagegen.
  let aktiv = false;
  const auftraege: Array<Record<string, unknown>> = [];
  const { base } = await aufbau(t, {
    mitschnitt: {
      zustand: () => ({ aktiv, demo: true, pfad: '/tmp/m.txt', vorhanden: aktiv }),
      einstellen: (a) => {
        auftraege.push(a);
        if (typeof a['aktiv'] !== 'boolean') throw new Error('aktiv erwartet');
        aktiv = a['aktiv'];
      },
      datei: () => Buffer.from('# asksin-mitschnitt 1\n# demo ja\n1\t:5A;\n'),
    },
  });

  const vorher = (await (await fetch(`${base}/api/mitschnitt`)).json()) as {
    aktiv: boolean;
  };
  assert.equal(vorher.aktiv, false);

  const ein = await fetch(`${base}/api/mitschnitt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ aktiv: true }),
  });
  assert.equal(ein.status, 200);
  // Die Antwort ist der neue Zustand — die Oberflaeche muss nicht nachfragen.
  assert.equal(((await ein.json()) as { aktiv: boolean }).aktiv, true);
  assert.deepEqual(auftraege, [{ aktiv: true }]);

  const aus = await fetch(`${base}/api/mitschnitt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ aktiv: false }),
  });
  assert.equal(((await aus.json()) as { aktiv: boolean }).aktiv, false);
});

test('Mitschnitt: unsinnige Werte sind ein Eingabefehler, kein Serverfehler', async (t) => {
  const { base } = await aufbau(t, {
    mitschnitt: {
      zustand: () => ({ aktiv: false }),
      einstellen: (a) => {
        if (typeof a['aktiv'] !== 'boolean') throw new Error('aktiv: true oder false erwartet');
      },
      datei: () => null,
    },
  });
  const res = await fetch(`${base}/api/mitschnitt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ aktiv: 'vielleicht' }),
  });
  assert.equal(res.status, 400);
  assert.match(await res.text(), /true oder false/);
});

test('Mitschnitt: ohne Token kein Schalten', async (t) => {
  // Ein fremder Zugriff koennte sonst die Grundlinie beenden oder das
  // Bootmedium mit Schreibvorgaengen belegen.
  const { base } = await aufbau(t, {
    authToken: 'geheim',
    mitschnitt: {
      zustand: () => ({ aktiv: false }),
      einstellen: () => undefined,
      datei: () => null,
    },
  });
  const ohne = await fetch(`${base}/api/mitschnitt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ aktiv: true }),
  });
  assert.equal(ohne.status, 401);
});

test('Mitschnitt: aeltere Fassung ohne Hooks meldet 501 statt zu stuerzen', async (t) => {
  const { base } = await aufbau(t);
  assert.equal((await fetch(`${base}/api/mitschnitt`)).status, 501);
});

test('Mitschnitt: Datei laesst sich herunterladen — ohne scp, ohne Konsole', async (t) => {
  // Die Aufzeichnung entsteht auf dem Geraet, ausgewertet wird sie am PC.
  // Ohne diesen Weg braeuchte man eine Shell, und genau das soll das Projekt
  // niemandem zumuten.
  let aktiv = false;
  const { base } = await aufbau(t, {
    mitschnitt: {
      zustand: () => ({ aktiv, demo: true, pfad: '/tmp/m.txt', vorhanden: aktiv }),
      einstellen: (a) => {
        aktiv = a['aktiv'] === true;
      },
      datei: () => Buffer.from('# asksin-mitschnitt 1\n# demo ja\n1000\t:5A;\n'),
    },
  });

  const res = await fetch(`${base}/api/mitschnitt/datei`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition') ?? '', /attachment/);
  assert.match(res.headers.get('content-type') ?? '', /text\/plain/);
  const text = await res.text();
  assert.match(text, /^# asksin-mitschnitt 1$/m);
  // Die Herkunft muss mitkommen — sonst waere am PC nicht mehr zu sehen,
  // ob die Daten simuliert waren.
  assert.match(text, /^# demo ja$/m);
});

test('Mitschnitt: nichts aufgezeichnet ergibt 404, keinen leeren Download', async (t) => {
  const { base } = await aufbau(t, {
    mitschnitt: {
      zustand: () => ({ aktiv: false }),
      einstellen: () => undefined,
      datei: () => null,
    },
  });
  const res = await fetch(`${base}/api/mitschnitt/datei`);
  assert.equal(res.status, 404);
});

test('Demo-Modus veraendert NICHTS ausser den Funktelegrammen', async (t) => {
  // Grundsatz vom 04.08.2026: Der Demo-Modus simuliert die Funkanlage — und
  // sonst nichts. Er ist dafuer da, wenn keine Platine steckt oder wenn man
  // Funktionen ohne echtes Homematic-Netz ausprobieren will. Alles uebrige
  // muss ganz normal bedien- und administrierbar bleiben.
  //
  // Ich hatte das verletzt: Im Demo-Modus lieferte die Auskunft einen
  // erfundenen Hostnamen samt IP und MAC, und die Netzwerkeinstellungen
  // liessen sich nicht mehr aendern. Dieser Test haelt fest, dass die
  // Auskunft echt bleibt.
  const mitDemo = await aufbau(t, { demo: true });
  const cfg = (await (await fetch(`${mitDemo.base}/getConfig`)).json()) as Record<
    string,
    string
  >;

  assert.equal(cfg['hostname'], hostname(), 'echter Hostname, auch im Demo-Modus');
  assert.notEqual(cfg['hostname'], 'asksin-analyzer-demo');
  // Das Demo-Kennzeichen selbst darf und soll gesetzt sein — es sagt dem
  // Anwender, dass die TELEGRAMME simuliert sind.
  assert.equal(cfg['demo'], 1);
});

test('beide Handbücher liegen unter eigenen Pfaden — und verwechseln sich nicht',
  async (t: TestContext) => {
    // Der eigentliche Anlass: Auf der Zigbee-Seite stand der Hinweis auf das
    // Zigbee-Handbuch, der Verweis darunter öffnete aber das grosse. Zwei
    // Bücher an einer Route kann es deshalb nicht mehr geben.
    const dir = await mkdtemp(join(tmpdir(), 'asksin-handbuch-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    await writeFile(join(dir, 'gross.pdf'), '%PDF-1.7 gross');
    await writeFile(join(dir, 'zigbee.pdf'), '%PDF-1.7 zigbee');

    const a = await aufbau(t, {
      handbuecher: {
        '/handbuch.pdf': { datei: join(dir, 'gross.pdf'), name: 'AskSin-Analyzer-Handbuch.pdf' },
        '/handbuch-zigbee.pdf': { datei: join(dir, 'zigbee.pdf'), name: 'Zigbee-Mithoerer-Handbuch.pdf' },
        '/handbuch-fehlt.pdf': { datei: join(dir, 'gibtsnicht.pdf'), name: 'Fehlt.pdf' },
      },
    });

    const gross = await fetch(`${a.base}/handbuch.pdf`);
    assert.equal(gross.status, 200);
    assert.equal(gross.headers.get('content-type'), 'application/pdf');
    assert.match(await gross.text(), /gross/);

    const zigbee = await fetch(`${a.base}/handbuch-zigbee.pdf`);
    assert.equal(zigbee.status, 200);
    assert.match(await zigbee.text(), /zigbee/, 'nicht das grosse Handbuch');
    assert.match(
      zigbee.headers.get('content-disposition') ?? '', /Zigbee-Mithoerer-Handbuch\.pdf/,
      'der Dateiname beim Speichern gehört zum Buch, nicht zur Route',
    );

    // Fehlt eine Datei, nennt die Antwort den Pfad — sonst sucht man im
    // falschen Verzeichnis.
    const fehlt = await fetch(`${a.base}/handbuch-fehlt.pdf`);
    assert.equal(fehlt.status, 404);
    assert.match(await fehlt.text(), /gibtsnicht\.pdf/);
  });
