import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SYSTEMVARIABLE, testeCcu } from '../src/resolve/ccuTest.ts';
import type { FetchBytes } from '../src/resolve/fetcher.ts';

/** Baut eine CCU-Antwort so, wie sie wirklich vom Draht kommt. */
function ccuAntwort(wert: string): Uint8Array {
  const escaped = wert
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  const xml = `<xml><exec>/a.exe</exec><ret>${escaped}</ret></xml>`;
  // latin1, nicht UTF-8 — genau darin lag beim Original die Umlaut-Falle.
  const bytes = new Uint8Array(xml.length);
  for (let i = 0; i < xml.length; i++) bytes[i] = xml.charCodeAt(i) & 0xff;
  return bytes;
}

const liefert = (wert: string): FetchBytes => async () => ccuAntwort(wert);
const wirft = (fehler: unknown): FetchBytes => async () => {
  throw fehler;
};

function netzfehler(code: string): Error {
  const e = new Error(`fetch failed`);
  (e as unknown as { cause: { code: string } }).cause = { code };
  return e;
}

/** Geräteliste, wie das CCU-Skript sie schreibt (created_at in SEKUNDEN). */
function devList(anzahl: number, alterSekunden = 0): string {
  const jetzt = Math.floor(1_700_000_000);
  const devices = Array.from({ length: anzahl }, (_, i) => ({
    address: 0xabc000 + i,
    serial: `SER${String(i).padStart(7, '0')}`,
    name: `Gerät ${i + 1}`,
  }));
  return JSON.stringify({ created_at: jetzt - alterSekunden, devices });
}

const JETZT = () => 1_700_000_000_000;

describe('CCU-Test: die Stufen', () => {
  it('ohne Adresse gibt es nichts zu prüfen — und keinen Alarm', async () => {
    // Keine CCU ist ein zulaessiger Zustand: Der Analyzer laeuft dann mit
    // Hex-Adressen weiter. Das darf sich nicht wie ein Defekt anfuehlen.
    const r = await testeCcu('', liefert(devList(3)), JETZT);
    assert.equal(r.stufe, 'keine-adresse');
    assert.equal(r.ok, false);
    assert.match(r.text, /1A2B3C|Funkadresse/);
    assert.match(r.tunSie, /eintragen|Tragen Sie/);
  });

  it('nennt bei unbekanntem Namen die Loesung, nicht den Fehlercode', async () => {
    const r = await testeCcu('ccu-tippfehler', wirft(netzfehler('ENOTFOUND')), JETZT);
    assert.equal(r.stufe, 'erreichbar');
    assert.match(r.text, /nicht auflösen/);
    assert.match(r.tunSie, /IP-Adresse/);
    // Der rohe Fehler bleibt erhalten, aber klein und unten.
    assert.match(r.technisch, /fetch failed/);
  });

  it('unterscheidet abgewiesen von Zeitueberschreitung', async () => {
    const abgewiesen = await testeCcu('192.0.2.9', wirft(netzfehler('ECONNREFUSED')), JETZT);
    assert.match(abgewiesen.text, /weist die Verbindung/);
    assert.match(abgewiesen.tunSie, /keine CCU|RaspberryMatic/);

    const zeit = await testeCcu('192.0.2.9', wirft(netzfehler('ETIMEDOUT')), JETZT);
    assert.match(zeit.text, /antwortet nicht/);
    assert.match(zeit.tunSie, /Firewall|8181/);
  });

  it('erkennt eine Antwort, die nicht von einer CCU stammt', async () => {
    const r = await testeCcu('192.0.2.9', async () => new TextEncoder().encode('<html>Hallo</html>'), JETZT);
    assert.equal(r.stufe, 'antwort');
    assert.match(r.titel, /nicht von einer CCU/);
  });

  it('DER HAEUFIGSTE FALL: CCU antwortet, Systemvariable fehlt', async () => {
    // Von aussen sieht das aus wie "CCU kaputt". Sie antwortet aber tadellos
    // und hat nur nichts zu sagen. Genau hier fuehrte die Suche bisher an die
    // falsche Stelle.
    for (const leer of ['', 'null', '<null>']) {
      const r = await testeCcu('192.0.2.9', liefert(leer), JETZT);
      assert.equal(r.stufe, 'variable', `bei ${JSON.stringify(leer)}`);
      assert.match(r.text, /Verbindung .* steht/);
      assert.ok(r.text.includes(SYSTEMVARIABLE));
      assert.equal(r.anleitungZeigen, true, 'die Anleitung muss erscheinen');
      // Beruhigung: Die Anlage ist nicht betroffen.
      assert.match(r.text, /nicht berührt/);
    }
  });

  it('meldet unlesbaren Inhalt getrennt von fehlender Variable', async () => {
    const r = await testeCcu('192.0.2.9', liefert('das ist kein JSON'), JETZT);
    assert.equal(r.stufe, 'inhalt');
    assert.equal(r.anleitungZeigen, true);
    // Ein Ausschnitt hilft beim Erkennen, was da steht.
    assert.match(r.technisch, /das ist kein JSON/);
  });

  it('meldet eine leere Liste als eigenen Fall', async () => {
    const r = await testeCcu('192.0.2.9', liefert(devList(0)), JETZT);
    assert.equal(r.stufe, 'inhalt');
    assert.match(r.titel, /leer/);
    assert.match(r.text, /keine Geräte angelernt|kein einziges Gerät/);
  });
});

describe('CCU-Test: der gute Fall', () => {
  it('nennt die ANZAHL der Geraete — genau das will der Anwender wissen', async () => {
    const r = await testeCcu('192.0.2.9', liefert(devList(17)), JETZT);
    assert.equal(r.ok, true);
    assert.equal(r.stufe, 'ok');
    assert.equal(r.geraete, 17);
    assert.match(r.titel, /17 Geräte/);
  });

  it('zeigt Beispielnamen — sie belegen, dass es die richtige Anlage ist', async () => {
    const r = await testeCcu('192.0.2.9', liefert(devList(5)), JETZT);
    assert.equal(r.beispiele.length, 3);
    assert.match(r.text, /Gerät 1/);
  });

  it('laesst die Multicast-Platzhalter aus den Beispielen heraus', async () => {
    // Das CCU-Skript stellt der Liste neun Platzhalter voran (HmIP Multicast,
    // HMRF Broadcast). Als "Beispiel fuer Ihre Geraete" waeren sie irrefuehrend.
    const mitPlatzhaltern = JSON.stringify({
      created_at: 1_700_000_000,
      devices: [
        { address: 15728641, serial: '00000000000000', name: 'HmIP Multicast All Devices' },
        { address: 0, serial: '0000000000', name: 'HMRF Broadcast' },
        { address: 0xabc123, serial: 'SER0000001', name: 'Wohnzimmer Fenster' },
      ],
    });
    const r = await testeCcu('192.0.2.9', liefert(mitPlatzhaltern), JETZT);
    assert.deepEqual(r.beispiele, ['Wohnzimmer Fenster']);
    assert.equal(r.geraete, 3, 'gezaehlt werden trotzdem alle');
  });

  it('warnt bei einer veralteten Liste', async () => {
    // Zweithaeufigster Stolperstein: Das Skript lief einmal und nie wieder.
    // Neue Geraete fehlen dann, und niemand weiss warum.
    const r = await testeCcu('192.0.2.9', liefert(devList(4, 5 * 86400)), JETZT);
    assert.equal(r.ok, true, 'trotzdem in Ordnung — nur eben alt');
    assert.match(r.text, /5 Tage alt/);
    assert.match(r.tunSie, /erneut|täglich/);
  });

  it('rechnet created_at als SEKUNDEN, nicht als Millisekunden', async () => {
    // Ein Vertauschen ergaebe ein Alter von rund 50 Jahren — und eine
    // Warnung, die immer erscheint.
    const r = await testeCcu('192.0.2.9', liefert(devList(4, 0)), JETZT);
    assert.ok(r.alterStunden !== null && r.alterStunden < 1, `Alter: ${r.alterStunden}`);
    assert.match(r.text, /aktuell/);
  });

  it('bricht nach der Wartezeit ab, statt haengen zu bleiben', async () => {
    const haengt: FetchBytes = (_url, signal) =>
      new Promise((_ok, fehl) => {
        signal.addEventListener('abort', () => fehl(new Error('aborted')));
      });
    const r = await testeCcu('192.0.2.9', haengt, JETZT, 50);
    assert.equal(r.stufe, 'erreichbar');
    assert.match(r.text, /antwortet nicht/);
  });
});
