import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ZigbeeLeser } from '../src/zigbee/leser.ts';
import type { IngestStream, PortOpener } from '../src/ingest/ingest.ts';
import { ZIGBEE_PAKETE } from './fixtures/zigbee.ts';

/** Ein Port, den der Test füttert — kein Gerät, keine Wanduhr. */
function pruefPort(zeilen: string[], opt: { schreibbar?: boolean } = {}) {
  const geschrieben: string[] = [];
  let geschlossen = 0;
  const opener: PortOpener = async (): Promise<IngestStream> => ({
    readable: (async function* () {
      for (const z of zeilen) yield Buffer.from(`${z}\n`, 'latin1');
    })(),
    close: () => { geschlossen++; },
    ...(opt.schreibbar === false ? {} : {
      schreibe: (text: string) => { geschrieben.push(text); },
    }),
  });
  return { opener, geschrieben, gibGeschlossen: () => geschlossen };
}

/** Warten, bis die Bedingung greift — ohne feste Schlafzeiten. */
async function bis(pruefung: () => boolean, versuche = 200): Promise<void> {
  for (let i = 0; i < versuche; i++) {
    if (pruefung()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('Bedingung wurde nicht erfüllt');
}

test('gültige Zeilen werden zu Paketen, der Kanal wird gesendet', async () => {
  const zeilen = ZIGBEE_PAKETE.map((f) => f.line);
  const port = pruefPort(zeilen);
  const gesehen: string[] = [];
  const leser = new ZigbeeLeser({
    openPort: port.opener,
    kanal: 15,
    onPaket: (p) => { gesehen.push(p.typ); },
  });
  leser.start();
  await bis(() => gesehen.length === zeilen.length);
  await leser.stop();

  assert.equal(leser.stats.pakete, zeilen.length);
  assert.equal(leser.stats.zeilen, zeilen.length);
  assert.deepEqual(port.geschrieben, ['{"C":15}\n'], 'Kanal muss gesetzt werden');
});

test('Müllzeilen werden nach Grund gezählt, nicht geworfen', async () => {
  const port = pruefPort([
    'Sniffer bereit',                                        // kein-json
    '{"L":5,"Q":255,"R":-30,"C":11}',                        // felder-fehlen
    '{"L":5,"Q":255,"R":-30,"C":99,"S":"0200AABBCC"}',       // werte-unplausibel
    '{"L":9,"Q":255,"R":-30,"C":11,"S":"0200AABBCC"}',       // laenge-widerspruch
    ZIGBEE_PAKETE[0]!.line,                                  // eines gültig
  ]);
  const leser = new ZigbeeLeser({ openPort: port.opener });
  leser.start();
  await bis(() => leser.stats.zeilen === 5);
  await leser.stop();

  const s = leser.stats;
  assert.equal(s.pakete, 1);
  assert.equal(s.verworfen['kein-json'], 1);
  assert.equal(s.verworfen['felder-fehlen'], 1);
  assert.equal(s.verworfen['werte-unplausibel'], 1);
  assert.equal(s.verworfen['laenge-widerspruch'], 1);
});

test('eine werfende Verbraucherfunktion legt den Leser nicht lahm', async () => {
  const zeilen = ZIGBEE_PAKETE.map((f) => f.line);
  const port = pruefPort(zeilen);
  const leser = new ZigbeeLeser({
    openPort: port.opener,
    onPaket: () => { throw new Error('Verbraucher kaputt'); },
  });
  leser.start();
  await bis(() => leser.stats.pakete === zeilen.length);
  await leser.stop();

  assert.equal(leser.stats.pakete, zeilen.length, 'trotz Ausnahmen weitergelesen');
  assert.equal(leser.stats.verbraucherFehler, zeilen.length, 'Ausnahmen gezählt');
});

test('läuft die Warteschlange über, wird gezählt statt geschluckt', async () => {
  const eine = ZIGBEE_PAKETE[0]!.line;
  const port = pruefPort(Array.from({ length: 20 }, () => eine));
  // Absichtlich winzig: ohne Verbraucher bleibt alles liegen.
  const leser = new ZigbeeLeser({ openPort: port.opener, queueKapazitaet: 4 });
  leser.start();
  await bis(() => leser.stats.pakete === 20);
  await leser.stop();

  assert.equal(leser.stats.ueberlauf, 16, '20 Pakete, 4 Plätze → 16 verdrängt');
});

test('ein Kanal außerhalb 11..26 wird abgewiesen', async () => {
  const port = pruefPort([]);
  const leser = new ZigbeeLeser({ openPort: port.opener });
  await assert.rejects(() => leser.kanalSetzen(27), /zwischen 11 und 26/);
  await assert.rejects(() => leser.kanalSetzen(10), /zwischen 11 und 26/);
  await leser.stop();
});

test('ein Port ohne Schreibmöglichkeit ist kein Fehler', async () => {
  const port = pruefPort([ZIGBEE_PAKETE[0]!.line], { schreibbar: false });
  const leser = new ZigbeeLeser({ openPort: port.opener });
  leser.start();
  await bis(() => leser.stats.pakete === 1);
  await leser.stop();
  assert.equal(leser.stats.pakete, 1, 'gelesen wird auch ohne Schreibrecht');
});
