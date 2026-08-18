import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DeconzNamen } from '../src/zigbee/namen.ts';

const IEEE = '00158d00046f77cd';

/** Ein kleiner deCONZ-Ersatz — antwortet wie das Original. */
function deconzErsatz(geraete: Record<string, unknown>): Promise<{
  server: Server; port: number; abrufe: string[];
}> {
  const abrufe: string[] = [];
  const server = createServer((req, res) => {
    abrufe.push(req.url ?? '');
    const teile = (req.url ?? '').split('/').filter((s) => s !== '');
    // /api/<key>/devices  bzw.  /api/<key>/devices/<ieee>
    if (teile.at(-1) === 'devices') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(Object.keys(geraete)));
      return;
    }
    const kennung = teile.at(-1) ?? '';
    if (kennung in geraete) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(geraete[kennung]));
      return;
    }
    res.statusCode = 404;
    res.end('[]');
  });
  return new Promise((auf) => {
    server.listen(0, '127.0.0.1', () => {
      const adresse = server.address();
      const port = typeof adresse === 'object' && adresse !== null ? adresse.port : 0;
      auf({ server, port, abrufe });
    });
  });
}

/**
 * Temporaeres Verzeichnis fuer die Dauer der Pruefung.
 *
 * Ausdruecklich `async` und mit `await fn(...)`. Die erste Fassung war
 * synchron: Sie rief die (asynchrone) Pruefung auf und loeschte das
 * Verzeichnis im `finally` sofort danach — also mitten im Lauf. Der
 * Zwischenspeicher liess sich dann nicht schreiben, und der Test beschuldigte
 * den Dienst eines Fehlers, den die Testhilfe verursacht hatte.
 */
async function mitVerzeichnis(fn: (pfad: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'zigbee-namen-'));
  try {
    await fn(join(dir, 'deconz.json'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('Namen werden geholt und zwischengespeichert', async () => {
  const { server, port } = await deconzErsatz({
    [IEEE]: { name: 'LED - Garten Weg 06', manufacturername: 'LUMI', modelid: 'TS011F' },
  });
  try {
    await mitVerzeichnis(async (cache) => {
      const n = new DeconzNamen({
        host: `127.0.0.1:${port}`, schluessel: 'geheim', cachePfad: cache,
      });
      assert.equal(await n.aktualisieren(), true);
      assert.equal(n.anzahl, 1);

      // Gross- und Kleinschreibung sowie Doppelpunkte duerfen egal sein:
      // deCONZ liefert 'a4:c1:38:…', der Funk liefert 'A4C138…'.
      assert.equal(n.name('00158D00046F77CD'), 'LED - Garten Weg 06');
      assert.equal(n.name('00:15:8d:00:04:6f:77:cd'), 'LED - Garten Weg 06');
      assert.equal(n.geraet(IEEE)?.hersteller, 'LUMI');

      const roh = JSON.parse(readFileSync(cache, 'utf8')) as { geraete: unknown[] };
      assert.equal(roh.geraete.length, 1, 'Zwischenspeicher geschrieben');
      // Der Schluessel steckt in der URL — die Datei darf nur dem Dienst gehoeren.
      assert.equal(statSync(cache).mode & 0o777, 0o600);
    });
  } finally {
    server.close();
  }
});

test('faellt deCONZ aus, gelten die Namen aus dem Zwischenspeicher', async () => {
  await mitVerzeichnis(async (cache) => {
    writeFileSync(cache, JSON.stringify({
      geholtAm: 1_700_000_000_000,
      geraete: [{ ieee: IEEE.toUpperCase(), name: 'LED - Terrasse' }],
    }));
    // Port, auf dem sicher niemand horcht.
    const n = new DeconzNamen({
      host: '127.0.0.1:1', schluessel: 'geheim', cachePfad: cache, timeoutMs: 300,
    });
    assert.equal(n.name(IEEE), 'LED - Terrasse', 'aus dem Zwischenspeicher');
    assert.equal(await n.aktualisieren(), false, 'Abruf scheitert, wirft aber nicht');
    assert.equal(n.name(IEEE), 'LED - Terrasse', 'Namen bleiben stehen');
    assert.equal(n.zustand['quelle'], 'cache');
  });
});

test('der Schlüssel taucht weder im Zustand noch in Fehlermeldungen auf', async () => {
  await mitVerzeichnis(async (cache) => {
    const n = new DeconzNamen({
      host: '127.0.0.1:1', schluessel: 'SUPERGEHEIM', cachePfad: cache, timeoutMs: 300,
    });
    await n.aktualisieren();
    const alsText = JSON.stringify(n.zustand);
    assert.ok(!alsText.includes('SUPERGEHEIM'), `Schlüssel steht im Zustand: ${alsText}`);
  });
});

test('ohne Host oder Schlüssel wird gar nicht erst gefragt', async () => {
  await mitVerzeichnis(async (cache) => {
    const ohne = new DeconzNamen({ host: '', schluessel: 'x', cachePfad: cache });
    assert.equal(await ohne.aktualisieren(), false);
    assert.equal(ohne.zustand['aktiv'], false);
  });
});

test('ein kaputter Zwischenspeicher verhindert den Start nicht', async () => {
  await mitVerzeichnis(async (cache) => {
    writeFileSync(cache, 'das ist kein JSON');
    const n = new DeconzNamen({ host: '', schluessel: '', cachePfad: cache });
    assert.equal(n.anzahl, 0);
    assert.equal(n.name(IEEE), undefined);
  });
});

test('eine leere Antwort ersetzt vorhandene Namen nicht', async () => {
  // Sonst reicht ein deCONZ-Neustart, um alle Namen zu verlieren.
  const { server, port } = await deconzErsatz({});
  try {
    await mitVerzeichnis(async (cache) => {
      writeFileSync(cache, JSON.stringify({
        geholtAm: 1, geraete: [{ ieee: IEEE.toUpperCase(), name: 'LED - Flur' }],
      }));
      const n = new DeconzNamen({
        host: `127.0.0.1:${port}`, schluessel: 'geheim', cachePfad: cache,
      });
      assert.equal(await n.aktualisieren(), false);
      assert.equal(n.name(IEEE), 'LED - Flur', 'alter Bestand bleibt');
    });
  } finally {
    server.close();
  }
});
