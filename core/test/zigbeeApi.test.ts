import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { ApiServer } from '../src/api/server.ts';
import type { ZigbeeHooks } from '../src/api/server.ts';
import { Analyzer } from '../src/service/analyzer.ts';
import { openDatabase } from '../src/persist/db.ts';
import type { IngestStream, PortOpener } from '../src/ingest/ingest.ts';

/** Ein Port, der nichts liefert — der Analyzer wird hier nicht gebraucht. */
const stillerPort: PortOpener = async (): Promise<IngestStream> => ({
  readable: (async function* () { /* nichts */ })(),
  close: () => {},
});

async function mitServer(
  zigbee: ZigbeeHooks | undefined,
  pruefung: (basis: string, db: DatabaseSync) => Promise<void>,
): Promise<void> {
  const db = openDatabase(':memory:');
  const analyzer = new Analyzer({ openPort: stillerPort, db });
  const api = new ApiServer({
    analyzer, db,
    ...(zigbee === undefined ? {} : { zigbee }),
  });
  const { port } = await api.listen(0);
  try {
    await pruefung(`http://127.0.0.1:${port}`, db);
  } finally {
    await api.close();
    await analyzer.stop();
    db.close();
  }
}

/** Hooks, die mitschreiben, womit sie gerufen wurden. */
function pruefHooks(): ZigbeeHooks & { gesehen: Record<string, unknown> } {
  const gesehen: Record<string, unknown> = {};
  return {
    gesehen,
    aktiv: () => true,
    firmwareStand: async () => ({ sticks: 1, hoert: true, laeuft: false }),
    firmwareAufspielen: () => { gesehen['aufspielen'] = true; },
    zustand: () => ({ aktiv: true, verbunden: false, kanal: 11, pakete: 0 }),
    geraete: (stunden) => { gesehen['stunden'] = stunden; return []; },
    nieGehoert: (stunden) => {
      gesehen['nieGehoertStunden'] = stunden;
      return [{ ieee: '00005EEF10000009', name: 'LED - Keller' }];
    },
    pakete: (minuten, grenze) => {
      gesehen['minuten'] = minuten; gesehen['grenze'] = grenze;
      return { pakete: [], gekuerzt: false };
    },
    setzen: async (auftrag) => {
      gesehen['auftrag'] = auftrag;
      if (auftrag['kanal'] === 99) throw new Error('kanal: 11 bis 26 erwartet');
      return { ...auftrag, neustartNoetig: false };
    },
    schluesselAnfordern: async (host) => {
      gesehen['host'] = host;
      return { ok: true, meldung: 'Neuer Schlüssel von deCONZ erhalten.' };
    },
  };
}

test('ohne Hooks antworten die Zigbee-Zweige mit 501', async () => {
  await mitServer(undefined, async (basis) => {
    for (const pfad of ['/api/zigbee', '/api/zigbee/geraete', '/api/zigbee/pakete']) {
      const r = await fetch(basis + pfad);
      assert.equal(r.status, 501, pfad);
      await r.text();
    }
  });
});

test('ohne Mithoerer ist die Geraeteliste 501 — nicht 200 mit leerer Liste',
  async () => {
    // Der Unterschied entscheidet die Verbund-Matrix: 501 heisst „hier hoert
    // niemand mit" (dagegen hilft ein Stick), eine leere Liste mit 200 hiesse
    // „ich hoere mit und habe nichts gehoert" (dagegen hilft Nachsehen).
    //
    // Am 18.08.2026 im Betrieb gefunden: Zwei Analyzer ohne Stick antworteten
    // mit 200 und leerer Liste, weil die Hooks immer haengen — sie muessen ja
    // haengen, sonst gaebe es keine Seite zum Einschalten.
    const hooks = { ...pruefHooks(), aktiv: () => false };
    await mitServer(hooks, async (basis) => {
      for (const pfad of ['/api/zigbee/geraete', '/api/zigbee/pakete']) {
        const r = await fetch(basis + pfad);
        assert.equal(r.status, 501, pfad);
        await r.text();
      }

      // Der Zustand bleibt abrufbar — sonst koennte die Einstellungsseite
      // nicht zeigen, dass Zigbee aus ist, und man haette nichts zum
      // Einschalten.
      const z = await fetch(`${basis}/api/zigbee`);
      assert.equal(z.status, 200);
      await z.text();
    });
  });

test('Firmware-Stand ist auch ohne laufenden Mithoerer abrufbar', async () => {
  // Der Sinn dieser Auskunft ist gerade der Analyzer, auf dem Zigbee NICHT
  // laeuft, weil auf dem Stick noch die Koordinator-Firmware sitzt. Haenge
  // man sie an `aktiv()`, koennte man sie genau dann nicht abrufen, wenn man
  // sie braucht.
  const hooks = { ...pruefHooks(), aktiv: () => false };
  await mitServer(hooks, async (basis) => {
    const r = await fetch(`${basis}/api/zigbee/firmware`);
    assert.equal(r.status, 200);
    const j = await r.json() as Record<string, unknown>;
    assert.equal(j['sticks'], 1);

    // Die Geraeteliste bleibt derweil bei 501 — beides gilt gleichzeitig.
    const g = await fetch(`${basis}/api/zigbee/geraete`);
    assert.equal(g.status, 501);
    await g.text();
  });
});

test('Aufspielen laesst sich anstossen und nicht doppelt anstossen', async () => {
  let laeuft = false;
  const hooks: ZigbeeHooks = {
    ...pruefHooks(),
    firmwareAufspielen: () => {
      if (laeuft) throw new Error('Es läuft bereits ein Aufspielvorgang');
      laeuft = true;
    },
  };
  await mitServer(hooks, async (basis) => {
    const erste = await fetch(`${basis}/api/zigbee/firmware`, { method: 'POST' });
    assert.equal(erste.status, 202, 'angenommen, aber noch nicht fertig');
    await erste.text();

    // 409 statt 400: Der Auftrag ist in Ordnung, nur der Zeitpunkt nicht.
    const zweite = await fetch(`${basis}/api/zigbee/firmware`, { method: 'POST' });
    assert.equal(zweite.status, 409);
    assert.match(await zweite.text(), /bereits/);
  });
});

test('/api/health trennt "eingeschaltet" von "der Stick antwortet"',
  async () => {
    // Die Kopfzeile zeigt zwei Punkte. Eingeschaltet UND stumm ist genau der
    // Fall, den man dort sehen will — mit einer einzigen Angabe waere er
    // nicht darstellbar.
    const hooks: ZigbeeHooks = {
      ...pruefHooks(),
      zustand: () => ({ aktiv: true, verbunden: false, kanal: 11, pakete: 0 }),
    };
    await mitServer(hooks, async (basis) => {
      const h = await (await fetch(`${basis}/api/health`)).json() as Record<string, unknown>;
      assert.equal(h['zigbee'], true, 'eingeschaltet');
      assert.equal(h['zigbeeVerbunden'], false, 'aber stumm');
    });
  });

test('Zustand kommt als JSON heraus', async () => {
  await mitServer(pruefHooks(), async (basis) => {
    const r = await fetch(`${basis}/api/zigbee`);
    assert.equal(r.status, 200);
    const j = await r.json() as Record<string, unknown>;
    assert.equal(j['aktiv'], true);
    assert.equal(j['verbunden'], false);
  });
});

test('Zeitraeume werden begrenzt statt abgewiesen', async () => {
  const hooks = pruefHooks();
  await mitServer(hooks, async (basis) => {
    // Unsinnig gross: Die Ansicht soll trotzdem etwas zeigen.
    await (await fetch(`${basis}/api/zigbee/geraete?stunden=999999`)).json();
    assert.equal(hooks.gesehen['stunden'], 24 * 90, 'auf 90 Tage begrenzt');

    await (await fetch(`${basis}/api/zigbee/pakete?minuten=0&max=99999`)).json();
    assert.equal(hooks.gesehen['minuten'], 1, 'mindestens eine Minute');
    assert.equal(hooks.gesehen['grenze'], 5000, 'auf 5000 Pakete begrenzt');

    // Unsinn im Text: Vorgabe statt Fehler.
    await (await fetch(`${basis}/api/zigbee/geraete?stunden=viele`)).json();
    assert.equal(hooks.gesehen['stunden'], 24, 'Vorgabe 24 Stunden');
  });
});

test('Einstellen geht nur mit Token, wenn einer gesetzt ist', async () => {
  const db = openDatabase(':memory:');
  const analyzer = new Analyzer({ openPort: stillerPort, db });
  const api = new ApiServer({
    analyzer, db, authToken: 'geheim',
    zigbee: pruefHooks(),
  });
  const { port } = await api.listen(0);
  try {
    const ohne = await fetch(`http://127.0.0.1:${port}/api/zigbee`, {
      method: 'POST', body: JSON.stringify({ kanal: 15 }),
    });
    assert.equal(ohne.status, 401);
    await ohne.text();

    const mit = await fetch(`http://127.0.0.1:${port}/api/zigbee`, {
      method: 'POST',
      headers: { authorization: 'Bearer geheim' },
      body: JSON.stringify({ kanal: 15 }),
    });
    assert.equal(mit.status, 200);
    const j = await mit.json() as Record<string, unknown>;
    assert.equal(j['kanal'], 15);
  } finally {
    await api.close();
    await analyzer.stop();
    db.close();
  }
});

test('ein abgelehnter Auftrag wird als 400 mit Begruendung beantwortet', async () => {
  await mitServer(pruefHooks(), async (basis) => {
    const r = await fetch(`${basis}/api/zigbee`, {
      method: 'POST', body: JSON.stringify({ kanal: 99 }),
    });
    assert.equal(r.status, 400);
    assert.match(await r.text(), /11 bis 26/);
  });
});

test('kaputtes JSON bringt den Server nicht durcheinander', async () => {
  await mitServer(pruefHooks(), async (basis) => {
    const r = await fetch(`${basis}/api/zigbee`, { method: 'POST', body: '{kaputt' });
    assert.equal(r.status, 400);
    await r.text();
    // Danach muss der Server weiter antworten.
    const danach = await fetch(`${basis}/api/zigbee`);
    assert.equal(danach.status, 200);
    await danach.json();
  });
});

test('der Schlüssel wird angefordert, nicht übertragen', async () => {
  const hooks = pruefHooks();
  await mitServer(hooks, async (basis) => {
    const r = await fetch(`${basis}/api/zigbee/schluessel`, {
      method: 'POST', body: JSON.stringify({ host: '192.0.2.9' }),
    });
    assert.equal(r.status, 200);
    const j = await r.json() as Record<string, unknown>;
    assert.equal(hooks.gesehen['host'], '192.0.2.9');
    assert.equal(j['ok'], true);
    // In der Antwort darf kein Schluessel stehen — sonst laege er wieder im
    // Browser, in der Zwischenablage und im Bildschirmfoto.
    assert.ok(!('schluessel' in j), 'kein Schlüssel in der Antwort');
    assert.ok(!('deconzSchluessel' in j), 'kein Schlüssel in der Antwort');
  });
});

test('ein leerer Rumpf ist erlaubt — dann gilt der eingetragene Rechner', async () => {
  const hooks = pruefHooks();
  await mitServer(hooks, async (basis) => {
    const r = await fetch(`${basis}/api/zigbee/schluessel`, { method: 'POST' });
    assert.equal(r.status, 200);
    await r.json();
    assert.equal(hooks.gesehen['host'], '');
  });
});

test('die Geräteliste nennt auch, was NICHT gehört wurde', async () => {
  const hooks = pruefHooks();
  await mitServer(hooks, async (basis) => {
    const r = await fetch(`${basis}/api/zigbee/geraete?stunden=6`);
    const j = await r.json() as { nieGehoert: Array<{ name: string }> };
    assert.equal(hooks.gesehen['nieGehoertStunden'], 6, 'derselbe Zeitraum');
    assert.equal(j.nieGehoert.length, 1);
    assert.equal(j.nieGehoert[0]!.name, 'LED - Keller');
  });
});

test('ohne Zigbee-Matrix antwortet der Verbund-Zweig mit 501', async () => {
  await mitServer(undefined, async (basis) => {
    const r = await fetch(`${basis}/api/verbund/zigbee`);
    assert.equal(r.status, 501);
    await r.text();
  });
});
