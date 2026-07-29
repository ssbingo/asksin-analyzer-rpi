import { test } from 'node:test';
import assert from 'node:assert/strict';

import { VerbundDienst } from '../src/verbund/verbund.ts';
import { FakeTime } from './helpers/fakes.ts';

/** Peer-Attrappe: health/snapshot je URL, Fehler nach Drehbuch. */
function fakeFetch(antworten: Record<string, unknown>) {
  const aufrufe: string[] = [];
  return {
    aufrufe,
    fetch: (url: string): Promise<unknown> => {
      aufrufe.push(url);
      const a = antworten[url];
      if (a === undefined) return Promise.reject(new Error(`ECONNREFUSED ${url}`));
      return Promise.resolve(a);
    },
  };
}

function gesunderPeer(
  basis: string,
  standort: string,
  now: number,
  extra: { devices?: unknown[]; telegrams?: unknown[] } = {},
) {
  return {
    [`${basis}/api/health`]: {
      ok: true, version: '0.0.4', now, connected: true, demo: false,
      updateVerfuegbar: false, standort,
    },
    [`${basis}/api/snapshot`]: {
      telegramsPerMinute: 12,
      noiseFloor: { last: -91, ewma: -90.5, samples: 100 },
      devices: extra.devices ?? [
        { name: 'BWM_Flur', dutyCyclePercent: 3.5 },
        { name: 'Defekt_X', dutyCyclePercent: 91.2 },
      ],
    },
    [`${basis}/api/telegrams?limit=100`]: { telegrams: extra.telegrams ?? [] },
  };
}

function telegramm(ts: number, cnt: number, rssi: number, name = 'Wetter_Terrasse') {
  return {
    id: cnt, ts, rssi, len: 14, cnt, flags: 0, flagNames: [],
    type: 0x70, typeName: 'WEATHER', isHmIp: false,
    fromAddr: 0x300001, fromHex: '300001', fromName: name,
    toAddr: 0, toHex: '000000', toName: 'Broadcast', payload: '01',
  };
}

test('Verbund: gesunde und tote Peers nebeneinander, Kennzahlen extrahiert', async () => {
  const time = new FakeTime();
  const f = fakeFetch({
    ...gesunderPeer('http://keller:8080', 'Keller', time.now()),
    // http://og:8080 fehlt → nicht erreichbar
  });
  const v = new VerbundDienst({
    peers: [
      { url: 'http://keller:8080/' },              // Slash wird normalisiert
      { name: 'OG', url: 'http://og:8080' },
    ],
    fetchJson: f.fetch,
    time,
  });

  const u = await v.uebersicht();
  assert.equal(u.peers.length, 2);

  const keller = u.peers[0]!;
  assert.equal(keller.erreichbar, true);
  assert.equal(keller.name, 'Keller', 'Name aus health.standort');
  assert.equal(keller.telegramsPerMinute, 12);
  assert.equal(keller.noiseFloor, -90.5);
  assert.equal(keller.deviceCount, 2);
  assert.deepEqual(keller.maxDutyCycle, { name: 'Defekt_X', percent: 91.2 });
  assert.equal(keller.zeitdriftMs, 0, 'gleiche Uhr → keine Drift');

  const og = u.peers[1]!;
  assert.equal(og.erreichbar, false);
  assert.equal(og.name, 'OG', 'konfigurierter Name bleibt');
  assert.match(og.fehler ?? '', /ECONNREFUSED/);
  assert.equal(og.telegramsPerMinute, null);
});

test('Verbund: Zeitdrift wird gegen die eigene Uhr gemessen', async () => {
  const time = new FakeTime();
  const f = fakeFetch(
    gesunderPeer('http://dg:8080', 'DG', time.now() + 2500),  // Peer geht 2,5 s vor
  );
  const v = new VerbundDienst({
    peers: [{ url: 'http://dg:8080' }],
    fetchJson: f.fetch,
    time,
  });
  const u = await v.uebersicht();
  assert.equal(u.peers[0]!.zeitdriftMs, 2500);
  assert.equal(u.driftWarnMs, 1000, 'Schwelle fürs Dedup-Fenster (M9.3)');
});

test('Matrix: Gerät × Standort mit RSSI, bester Standort, CSV', async () => {
  const time = new FakeTime();
  const f = fakeFetch({
    ...gesunderPeer('http://keller:8080', 'Keller', time.now(), {
      devices: [
        { addr: 0x300001, address: '300001', name: 'Wetter_Terrasse',
          rssi: { ewma: -72.5 }, dutyCyclePercent: 1 },
        { addr: 0x310001, address: '310001', name: 'Thermostat_Büro',
          rssi: { ewma: -60 }, dutyCyclePercent: 1 },
      ],
    }),
    ...gesunderPeer('http://og:8080', 'OG', time.now(), {
      devices: [
        // Derselbe Sensor, dort besser zu hören — aber ohne Namensauflösung:
        { addr: 0x300001, address: '300001', name: '300001',
          rssi: { ewma: -55.1 }, dutyCyclePercent: 1 },
      ],
    }),
  });
  const v = new VerbundDienst({
    peers: [{ url: 'http://keller:8080' }, { url: 'http://og:8080' }],
    fetchJson: f.fetch,
    time,
  });

  const m = await v.matrix();
  assert.deepEqual(m.standorte, ['Keller', 'OG']);
  assert.equal(m.geraete.length, 2);

  const wetter = m.geraete.find((g) => g.addr === 0x300001)!;
  assert.equal(wetter.name, 'Wetter_Terrasse', 'aufgelöster Name gewinnt');
  assert.equal(wetter.rssi['Keller'], -72.5);
  assert.equal(wetter.rssi['OG'], -55.1);
  assert.equal(wetter.beste, 'OG', 'bester Empfang markiert');

  const thermo = m.geraete.find((g) => g.addr === 0x310001)!;
  assert.equal(thermo.rssi['OG'], null, 'dort nicht gehört');
  assert.equal(thermo.beste, 'Keller');

  const csv = await v.matrixCsv();
  const zeilen = csv.split('\n');
  assert.equal(zeilen[0], 'Geraet;Adresse;Keller;OG');
  assert.ok(zeilen.some((z) => z === 'Wetter_Terrasse;300001;-72.5;-55.1'));
  assert.ok(zeilen.some((z) => z === 'Thermostat_Büro;310001;-60;'));
});

test('Dedup: ein Telegramm, drei Standorte — EIN Eintrag mit drei RSSI', async () => {
  const time = new FakeTime();
  const t0 = time.now();
  const f = fakeFetch({
    ...gesunderPeer('http://a:1', 'Keller', t0, {
      telegrams: [telegramm(t0, 7, -62)],
    }),
    ...gesunderPeer('http://b:1', 'OG', t0, {
      telegrams: [telegramm(t0 + 900, 7, -81, '300001')],   // 0,9 s später, Hex-Name
    }),
    ...gesunderPeer('http://c:1', 'DG', t0, {
      telegrams: [telegramm(t0 + 1400, 7, -95)],
    }),
  });
  const v = new VerbundDienst({
    peers: [{ url: 'http://a:1' }, { url: 'http://b:1' }, { url: 'http://c:1' }],
    fetchJson: f.fetch,
    time,
  });

  const { telegramme } = await v.telegramme();
  assert.equal(telegramme.length, 1, 'Akzeptanzkriterium aus docs/verbund.md');
  const t = telegramme[0]!;
  assert.equal(t.ts, t0, 'frühester Empfang zählt');
  assert.equal(t.fromName, 'Wetter_Terrasse', 'aufgelöster Name gewinnt');
  assert.deepEqual(
    t.gehoertVon,
    [
      { standort: 'Keller', rssi: -62 },
      { standort: 'OG', rssi: -81 },
      { standort: 'DG', rssi: -95 },
    ],
    'nach RSSI sortiert',
  );
});

test('Dedup: außerhalb des Fensters bzw. anderer Zähler = getrennte Einträge', async () => {
  const time = new FakeTime();
  const t0 = time.now();
  const f = fakeFetch({
    ...gesunderPeer('http://a:1', 'Keller', t0, {
      telegrams: [telegramm(t0, 7, -62), telegramm(t0 + 5000, 8, -63)],
    }),
    ...gesunderPeer('http://b:1', 'OG', t0, {
      telegrams: [telegramm(t0 + 2000, 7, -81)],   // gleicher cnt, aber 2 s später
    }),
  });
  const v = new VerbundDienst({
    peers: [{ url: 'http://a:1' }, { url: 'http://b:1' }],
    fetchJson: f.fetch,
    time,
  });
  const { telegramme } = await v.telegramme();
  assert.equal(telegramme.length, 3, 'Fenster ±1,5 s trennt sauber');
});

test('Dedup: wiederholtes Abrufen derselben Telegramme bleibt idempotent', async () => {
  const time = new FakeTime();
  const t0 = time.now();
  const antworten = {
    ...gesunderPeer('http://a:1', 'Keller', t0, {
      telegrams: [telegramm(t0, 7, -62)],
    }),
  };
  const f = fakeFetch(antworten);
  const v = new VerbundDienst({
    peers: [{ url: 'http://a:1' }],
    fetchJson: f.fetch,
    time,
  });
  await v.telegramme();
  await time.advance(2500);                    // Drossel ablaufen lassen
  const { telegramme } = await v.telegramme(); // holt DIESELBEN 100 erneut
  assert.equal(telegramme.length, 1, 'kein Duplikat trotz erneutem Abruf');
  assert.equal(telegramme[0]!.gehoertVon.length, 1);
});

/** Fetch-Attrappe mit Drehbuch je URL: Antworten werden der Reihe nach
 *  verbraucht, die letzte wiederholt sich. */
function drehbuchFetch(drehbuecher: Record<string, unknown[]>) {
  return (url: string): Promise<unknown> => {
    const d = drehbuecher[url];
    if (d === undefined || d.length === 0) {
      return Promise.reject(new Error(`ECONNREFUSED ${url}`));
    }
    const a = d.length > 1 ? d.shift()! : d[0]!;
    if (a instanceof Error) return Promise.reject(a);
    return Promise.resolve(a);
  };
}

async function flotteDurchlaufen(v: VerbundDienst, time: FakeTime): Promise<void> {
  assert.equal(v.starteFlottenUpdate(), true);
  for (let i = 0; i < 100 && v.flottenStatus()!.running; i++) {
    await time.advance(50);
  }
  await v.flottenLauf;
}

test('Flotten-Update: nacheinander, Health-Gate, eigener Analyzer zuletzt', async () => {
  const time = new FakeTime();
  let selbstUpdates = 0;
  const posts: string[] = [];
  const fetch = drehbuchFetch({
    'http://og:1/api/update/versions': [{ updateVerfuegbar: true }],
    'http://og:1/api/update/status': [
      { running: true, step: 'baue-ui' },
      new Error('Neustart'),                    // Peer startet gerade neu
      { running: false, step: 'fertig', ok: true },
    ],
    'http://og:1/api/health': [
      new Error('noch nicht da'),
      { ok: true, version: '0.0.5' },
    ],
    'http://dg:1/api/update/versions': [{ updateVerfuegbar: false }],
  });
  const v = new VerbundDienst({
    peers: [
      { name: 'Keller', url: 'http://keller:1' },   // Selbst (erster Eintrag)
      { name: 'OG', url: 'http://og:1' },
      { name: 'DG', url: 'http://dg:1' },
    ],
    fetchJson: fetch,
    post: (url) => {
      posts.push(url);
      return Promise.resolve(202);
    },
    time,
    selbstUpdate: () => {
      selbstUpdates++;
      return true;
    },
    flotte: { pollMs: 50, updateTimeoutMs: 10_000, healthTimeoutMs: 5_000 },
  });

  await flotteDurchlaufen(v, time);
  const f = v.flottenStatus()!;
  assert.equal(f.ok, true);
  assert.deepEqual(
    f.schritte.map((s) => [s.name, s.status]),
    [
      ['OG', 'aktualisiert'],
      ['DG', 'aktuell'],
      ['Keller (dieser Analyzer)', 'angestoßen'],
    ],
  );
  assert.match(f.schritte[0]!.detail ?? '', /0\.0\.5/);
  assert.deepEqual(posts, ['http://og:1/api/update/core'], 'nur wo Update nötig war');
  assert.equal(selbstUpdates, 1, 'Selbst-Update kommt zum Schluss');
});

test('Flotten-Update: Fehler bricht ab — kein Domino, kein Selbst-Update', async () => {
  const time = new FakeTime();
  let selbstUpdates = 0;
  const fetch = drehbuchFetch({
    'http://og:1/api/update/versions': [{ updateVerfuegbar: true }],
    'http://og:1/api/update/status': [
      { running: false, step: 'rollback', ok: false },   // Peer rollte zurück
    ],
    'http://dg:1/api/update/versions': [{ updateVerfuegbar: true }],
  });
  const v = new VerbundDienst({
    peers: [
      { name: 'Keller', url: 'http://keller:1' },
      { name: 'OG', url: 'http://og:1' },
      { name: 'DG', url: 'http://dg:1' },
    ],
    fetchJson: fetch,
    post: () => Promise.resolve(202),
    time,
    selbstUpdate: () => {
      selbstUpdates++;
      return true;
    },
    flotte: { pollMs: 50, updateTimeoutMs: 10_000, healthTimeoutMs: 5_000 },
  });

  await flotteDurchlaufen(v, time);
  const f = v.flottenStatus()!;
  assert.equal(f.ok, false);
  assert.deepEqual(
    f.schritte.map((s) => s.status),
    ['fehler', 'übersprungen', 'übersprungen'],
  );
  assert.match(f.schritte[0]!.detail ?? '', /zurückgerollt/);
  assert.equal(selbstUpdates, 0, 'der Master bleibt auf dem alten Stand');

  // Nach dem Ende darf ein neuer Lauf starten:
  assert.equal(v.starteFlottenUpdate(), true);
});

test('Flotten-Update: Doppelstart wird abgewiesen', async () => {
  const time = new FakeTime();
  const v = new VerbundDienst({
    peers: [{ name: 'Keller', url: 'http://keller:1' }],
    fetchJson: drehbuchFetch({}),
    post: () => Promise.resolve(202),
    time,
    selbstUpdate: () => true,
    flotte: { pollMs: 50, updateTimeoutMs: 1000, healthTimeoutMs: 1000 },
  });
  assert.equal(v.starteFlottenUpdate(), true);
  assert.equal(v.starteFlottenUpdate(), false, 'läuft bereits');
  for (let i = 0; i < 20 && v.flottenStatus()!.running; i++) await time.advance(50);
  await v.flottenLauf;
});

test('Verbund: kurzer Cache verhindert Peer-Gehämmer', async () => {
  const time = new FakeTime();
  const f = fakeFetch(gesunderPeer('http://keller:8080', 'Keller', time.now()));
  const v = new VerbundDienst({
    peers: [{ url: 'http://keller:8080' }],
    fetchJson: f.fetch,
    time,
    cacheMs: 3000,
  });
  await v.uebersicht();
  await v.uebersicht();                       // aus dem Cache
  assert.equal(f.aufrufe.length, 2, 'health+snapshot nur EINMAL');
  await time.advance(3001);
  await v.uebersicht();                       // Cache abgelaufen
  assert.equal(f.aufrufe.length, 4);
});
