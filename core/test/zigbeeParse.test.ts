import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseZigbeeZeile } from '../src/zigbee/parse.ts';
import { leereIgnoreZaehler } from '../src/zigbee/types.ts';
import type { ZigbeeIgnoreGrund } from '../src/zigbee/types.ts';
import { ZIGBEE_PAKETE } from './fixtures/zigbee.ts';

/** Feste Zeitquelle, damit die Tests keine Wanduhr brauchen. */
const FIXED_TS = 1_700_000_000_000;
const now = () => FIXED_TS;

test('echte Rahmen werden feldgenau decodiert', () => {
  for (const fx of ZIGBEE_PAKETE) {
    const res = parseZigbeeZeile(fx.line, now);
    assert.equal(res.kind, 'paket', `${fx.name}: erwartet kind=paket`);
    if (res.kind !== 'paket') continue;
    const p = res.paket;
    assert.equal(p.typ, fx.typ, `${fx.name}: Rahmenart`);
    assert.equal(p.seq, fx.seq, `${fx.name}: Folgenummer`);
    assert.equal(p.kanal, fx.kanal, `${fx.name}: Kanal`);
    assert.equal(p.rssi, fx.rssi, `${fx.name}: RSSI`);
    assert.equal(p.lqi, fx.lqi, `${fx.name}: LQI`);
    assert.equal(p.laenge, fx.laenge, `${fx.name}: Länge`);
    assert.equal(p.pan, fx.pan, `${fx.name}: PAN`);
    assert.equal(p.von, fx.von, `${fx.name}: Absender`);
    assert.equal(p.an, fx.an, `${fx.name}: Empfänger`);
    assert.equal(p.rundruf, fx.rundruf, `${fx.name}: Rundruf`);
    assert.equal(p.ackErbeten, fx.ackErbeten, `${fx.name}: Bestätigung erbeten`);
    assert.equal(p.ts, FIXED_TS, `${fx.name}: Zeitstempel`);
  }
});

test('Bestätigungen tragen weder PAN noch Adressen', () => {
  const acks = ZIGBEE_PAKETE.filter((f) => f.typ === 'bestaetigung');
  assert.ok(acks.length > 0, 'Fixtures enthalten keine Bestätigung');
  for (const fx of acks) {
    const res = parseZigbeeZeile(fx.line, now);
    assert.equal(res.kind, 'paket');
    if (res.kind !== 'paket') continue;
    assert.equal(res.paket.pan, undefined, `${fx.name}: PAN muss fehlen`);
    assert.equal(res.paket.von, undefined, `${fx.name}: Absender muss fehlen`);
    assert.equal(res.paket.an, undefined, `${fx.name}: Empfänger muss fehlen`);
  }
});

/**
 * Ablehnungen. Diese Zeilen sind von Hand gebaut — das ist hier zulässig,
 * weil nicht der Aufbau eines echten Rahmens geprüft wird, sondern ob der
 * Parser Müll erkennt.
 */
const MUELL: ReadonlyArray<{ name: string; line: string; grund: ZigbeeIgnoreGrund }> = [
  { name: 'leer', line: '', grund: 'kein-json' },
  { name: 'kein JSON', line: 'Sniffer bereit', grund: 'kein-json' },
  { name: 'abgeschnitten', line: '{"L":5,"Q":255,"R":-30,"C":11,"S":"0200', grund: 'kein-json' },
  { name: 'Feld fehlt', line: '{"L":5,"Q":255,"R":-30,"C":11}', grund: 'felder-fehlen' },
  { name: 'S ist Zahl', line: '{"L":5,"Q":255,"R":-30,"C":11,"S":200}', grund: 'felder-fehlen' },
  { name: 'Kanal 10', line: '{"L":5,"Q":255,"R":-30,"C":10,"S":"0200AABBCC"}', grund: 'werte-unplausibel' },
  { name: 'Kanal 27', line: '{"L":5,"Q":255,"R":-30,"C":27,"S":"0200AABBCC"}', grund: 'werte-unplausibel' },
  { name: 'LQI 256', line: '{"L":5,"Q":256,"R":-30,"C":11,"S":"0200AABBCC"}', grund: 'werte-unplausibel' },
  { name: 'RSSI positiv', line: '{"L":5,"Q":255,"R":7,"C":11,"S":"0200AABBCC"}', grund: 'werte-unplausibel' },
  { name: 'ungerade Hexlänge', line: '{"L":5,"Q":255,"R":-30,"C":11,"S":"0200AABBC"}', grund: 'hex-ungueltig' },
  { name: 'kein Hex', line: '{"L":5,"Q":255,"R":-30,"C":11,"S":"0200AABBZZ"}', grund: 'hex-ungueltig' },
  { name: 'L passt nicht zu S', line: '{"L":9,"Q":255,"R":-30,"C":11,"S":"0200AABBCC"}', grund: 'laenge-widerspruch' },
  { name: 'zu kurz für einen Rahmen', line: '{"L":4,"Q":255,"R":-30,"C":11,"S":"0200AABB"}', grund: 'mac-unlesbar' },
  { name: 'Adressfeld ragt über das Ende', line: '{"L":6,"Q":255,"R":-30,"C":11,"S":"618801AABBCC"}', grund: 'mac-unlesbar' },
  { name: 'reservierter Adressmodus', line: '{"L":8,"Q":255,"R":-30,"C":11,"S":"0184010203040506"}', grund: 'mac-unlesbar' },
];

test('unbrauchbare Zeilen werden mit Grund verworfen, nie geworfen', () => {
  for (const fall of MUELL) {
    const res = parseZigbeeZeile(fall.line, now);
    assert.equal(res.kind, 'ignoriert', `${fall.name}: hätte verworfen werden müssen`);
    if (res.kind !== 'ignoriert') continue;
    assert.equal(res.grund, fall.grund, `${fall.name}: falscher Grund`);
  }
});

test('willkürliche Bytefolgen bringen den Parser nicht zum Absturz', () => {
  // Fester Startwert: der Lauf muss wiederholbar sein.
  let zustand = 42;
  const zufall = () => (zustand = (zustand * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < 2000; i++) {
    const n = 1 + Math.floor(zufall() * 60);
    let hex = '';
    for (let k = 0; k < n; k++) {
      hex += Math.floor(zufall() * 256).toString(16).padStart(2, '0');
    }
    const zeile = `{"L":${n},"Q":${Math.floor(zufall() * 256)},`
      + `"R":${-Math.floor(zufall() * 100)},"C":11,"S":"${hex}"}`;
    const res = parseZigbeeZeile(zeile, now);
    assert.ok(res.kind === 'paket' || res.kind === 'ignoriert');
  }
});

test('alle Ignoriergründe sind im Zähler vorgesehen', () => {
  const zaehler = leereIgnoreZaehler();
  for (const fall of MUELL) {
    assert.ok(fall.grund in zaehler, `${fall.grund} fehlt im Zähler`);
  }
});
