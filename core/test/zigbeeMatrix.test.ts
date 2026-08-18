import { test } from 'node:test';
import assert from 'node:assert/strict';

import { baueZigbeeMatrix } from '../src/verbund/zigbeeMatrix.ts';
import type { StandortBericht, StandortGeraet } from '../src/verbund/zigbeeMatrix.ts';

function geraet(t: Partial<StandortGeraet> = {}): StandortGeraet {
  return {
    pan: 0xABCD, addr: '837E', ieee: '00005EEF10000001', name: 'LED Garten',
    pakete: 100, sum_rssi: -7300, sum_lqi: 25400, schwach: 0, ...t,
  };
}

function ort(standort: string, geraete: StandortGeraet[]): StandortBericht {
  return { standort, erreichbar: true, geraete };
}

test('zwei Standorte, ein Gerät: eine Zeile mit beiden Werten', () => {
  const m = baueZigbeeMatrix([
    ort('Dachboden', [geraet({ sum_rssi: -7300 })]),
    ort('Keller', [geraet({ sum_rssi: -8800, sum_lqi: 4000, schwach: 60 })]),
  ]);
  assert.equal(m.geraete.length, 1);
  const g = m.geraete[0]!;
  assert.equal(g.empfang['Dachboden']!.rssi, -73);
  assert.equal(g.empfang['Keller']!.rssi, -88);
  assert.equal(g.empfang['Keller']!.schwachProzent, 60);
  assert.equal(g.beste, 'Dachboden', 'der stärkere Empfang gewinnt');
  assert.equal(g.nirgends, false);
});

test('zusammengeführt wird über die IEEE-Adresse, nicht über die Kurzadresse', () => {
  // Der Kern der Sache: Kurzadressen werden beim Neuanmelden neu vergeben.
  // Zwei Standorte können dasselbe Gerät unter verschiedenen Kurzadressen
  // gesehen haben — das darf nicht zwei Zeilen ergeben.
  const m = baueZigbeeMatrix([
    ort('Dachboden', [geraet({ addr: '837E' })]),
    ort('Keller', [geraet({ addr: 'AA11' })]),
  ]);
  assert.equal(m.geraete.length, 1, 'eine Zeile trotz verschiedener Kurzadressen');
  assert.equal(Object.keys(m.geraete[0]!.empfang).length, 2);
});

test('ohne IEEE trennt PAN + Kurzadresse — und die Zeile sagt es', () => {
  const m = baueZigbeeMatrix([
    ort('Dachboden', [geraet({ ieee: undefined, addr: '1111' })]),
    ort('Keller', [geraet({ ieee: undefined, addr: '2222' })]),
  ]);
  assert.equal(m.geraete.length, 2, 'ohne IEEE lässt sich nichts zusammenführen');
  for (const g of m.geraete) assert.equal(g.ieee, null, 'daran ist es erkennbar');
});

test('dieselbe Kurzadresse in zwei Netzen bleibt getrennt', () => {
  const m = baueZigbeeMatrix([
    ort('Dachboden', [
      geraet({ ieee: undefined, pan: 0xE9FD, addr: '1234' }),
      geraet({ ieee: undefined, pan: 0xF078, addr: '1234' }),
    ]),
  ]);
  assert.equal(m.geraete.length, 2, 'PAN gehört mit in den Schlüssel');
});

test('was niemand hört, steht trotzdem in der Liste — ganz oben', () => {
  const m = baueZigbeeMatrix(
    [ort('Dachboden', [geraet()])],
    [
      { ieee: '00005EEF10000001', name: 'LED Garten' },
      { ieee: '00005EEF10000009', name: 'LED Keller' },
    ],
  );
  assert.equal(m.geraete.length, 2);
  assert.equal(m.geraete[0]!.name, 'LED Keller', 'die Fragezeichen zuerst');
  assert.equal(m.geraete[0]!.nirgends, true);
  assert.equal(m.geraete[0]!.beste, null);
  assert.equal(m.zusammenfassung.nirgends, 1);
});

test('ein nicht erreichbarer Standort macht keine leeren Werte', () => {
  // Sonst saehe "nicht erreichbar" aus wie "nichts gehoert" — und genau die
  // Verwechslung soll die Matrix ja aufloesen.
  const m = baueZigbeeMatrix([
    ort('Dachboden', [geraet()]),
    { standort: 'Keller', erreichbar: false, geraete: [] },
  ]);
  assert.deepEqual(m.standorte, ['Dachboden', 'Keller']);
  assert.deepEqual(m.nichtErreichbar, ['Keller']);
  assert.equal(m.geraete[0]!.empfang['Keller'], undefined,
    'kein Eintrag statt einer Null');
  assert.equal(m.geraete[0]!.nirgends, false, 'gehört wurde es ja');
});

test('nur an einem Standort gehört wird gezählt und einsortiert', () => {
  const m = baueZigbeeMatrix([
    ort('Dachboden', [
      geraet({ ieee: 'AAAA000000000001', name: 'Nur hier' }),
      geraet({ ieee: 'AAAA000000000002', name: 'Überall' }),
    ]),
    ort('Keller', [geraet({ ieee: 'AAAA000000000002', name: 'Überall' })]),
  ]);
  assert.equal(m.zusammenfassung.nurEinStandort, 1);
  assert.equal(m.geraete[0]!.name, 'Nur hier', 'vor den überall gehörten');
});

test('ein Name von irgendeinem Standort genügt', () => {
  const m = baueZigbeeMatrix([
    ort('Dachboden', [geraet({ name: undefined })]),
    ort('Keller', [geraet({ name: 'LED Garten' })]),
  ]);
  assert.equal(m.geraete[0]!.name, 'LED Garten');
});

test('ohne Standorte kommt eine leere Matrix, kein Absturz', () => {
  const m = baueZigbeeMatrix([]);
  assert.deepEqual(m.geraete, []);
  assert.equal(m.zusammenfassung.gesamt, 0);
});
