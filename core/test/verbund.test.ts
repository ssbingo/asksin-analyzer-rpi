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

function gesunderPeer(basis: string, standort: string, now: number) {
  return {
    [`${basis}/api/health`]: {
      ok: true, version: '0.0.4', now, connected: true, demo: false,
      updateVerfuegbar: false, standort,
    },
    [`${basis}/api/snapshot`]: {
      telegramsPerMinute: 12,
      noiseFloor: { last: -91, ewma: -90.5, samples: 100 },
      devices: [
        { name: 'BWM_Flur', dutyCyclePercent: 3.5 },
        { name: 'Defekt_X', dutyCyclePercent: 91.2 },
      ],
    },
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
