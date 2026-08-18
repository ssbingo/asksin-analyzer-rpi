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

/**
 * Ein Gerät, dessen IEEE-Adresse noch nicht gelernt wurde.
 *
 * Eigene Hilfsfunktion statt `geraet({ ieee: undefined })`: Mit
 * `exactOptionalPropertyTypes` ist eine fehlende Eigenschaft etwas anderes
 * als eine auf `undefined` gesetzte — und der Unterschied ist hier genau der
 * Punkt, denn der Matrixschlüssel prüft auf Vorhandensein.
 */
function ohneIeee(t: Partial<StandortGeraet> = {}): StandortGeraet {
  const { ieee: _weg, ...rest } = geraet(t);
  return rest;
}

/** Ein Gerät, für das dieser Standort keinen Namen kennt. */
function ohneNamen(t: Partial<StandortGeraet> = {}): StandortGeraet {
  const { name: _weg, ...rest } = geraet(t);
  return rest;
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
    ort('Dachboden', [ohneIeee({ addr: '1111' })]),
    ort('Keller', [ohneIeee({ addr: '2222' })]),
  ]);
  assert.equal(m.geraete.length, 2, 'ohne IEEE lässt sich nichts zusammenführen');
  for (const g of m.geraete) assert.equal(g.ieee, null, 'daran ist es erkennbar');
});

test('dieselbe Kurzadresse in zwei Netzen bleibt getrennt', () => {
  const m = baueZigbeeMatrix([
    ort('Dachboden', [
      ohneIeee({ pan: 0xE9FD, addr: '1234' }),
      ohneIeee({ pan: 0xF078, addr: '1234' }),
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
    ort('Dachboden', [ohneNamen()]),
    ort('Keller', [geraet({ name: 'LED Garten' })]),
  ]);
  assert.equal(m.geraete[0]!.name, 'LED Garten');
});

test('ohne Standorte kommt eine leere Matrix, kein Absturz', () => {
  const m = baueZigbeeMatrix([]);
  assert.deepEqual(m.geraete, []);
  assert.equal(m.zusammenfassung.gesamt, 0);
});

test('ein Standort ohne Mithörer ist nicht dasselbe wie einer ohne Empfang', () => {
  // Der Fall, um den es geht: Analyzer 04 hat einen Stick, Analyzer 01 nicht.
  // Die Matrix darf daraus nicht "01 hört nichts" machen — das waere eine
  // Aussage ueber den Funk, wo es eine ueber die Ausstattung ist.
  const m = baueZigbeeMatrix(
    [
      ort('Dachboden', [geraet()]),
      { standort: 'Keller Büro', erreichbar: false, geraete: [] },
    ],
    [{ ieee: '00005EEF10000001', name: 'LED Garten' }],
  );
  assert.deepEqual(m.nichtErreichbar, ['Keller Büro']);
  const g = m.geraete[0]!;
  assert.equal(g.nirgends, false);
  assert.equal(g.beste, 'Dachboden');
  assert.equal('Keller Büro' in g.empfang, false,
    'kein Eintrag — nicht null, nicht 0');
});

test('mit zwei Standorten wird aus "vermisst" entweder still oder unerreichbar', () => {
  // Genau der Ertrag des zweiten Sticks, an einem Beispiel festgehalten.
  const nurDachboden = baueZigbeeMatrix(
    [ort('Dachboden', [])],
    [{ ieee: 'AAAA000000000001', name: 'LED Terrasse' }],
  );
  assert.equal(nurDachboden.geraete[0]!.nirgends, true,
    'ein Standort: Gerät gilt als nirgends gehört');

  const mitKeller = baueZigbeeMatrix(
    [
      ort('Dachboden', []),
      ort('Keller', [geraet({ ieee: 'AAAA000000000001', name: 'LED Terrasse' })]),
    ],
    [{ ieee: 'AAAA000000000001', name: 'LED Terrasse' }],
  );
  const g = mitKeller.geraete[0]!;
  assert.equal(g.nirgends, false, 'zweiter Standort hört es — also lebt es');
  assert.equal(g.beste, 'Keller');
  assert.equal(mitKeller.zusammenfassung.nurEinStandort, 1,
    'und die Kopfzeile weist es als Einzelfund aus');
});

test('derselbe Standort zweimal ergibt EINE Spalte', () => {
  // Der Master fuehrt sich ueblicherweise selbst als Gegenstelle (127.0.0.1).
  // Steuert er zusaetzlich seine eigenen Geraete bei, kaeme der Standort
  // doppelt an — und die Tabelle haette zwei gleichnamige Spalten, die
  // niemand auseinanderhalten kann.
  const m = baueZigbeeMatrix([
    ort('Keller Büro', [geraet({ ieee: 'AAAA000000000001', name: 'A' })]),
    ort('Keller Büro', [geraet({ ieee: 'AAAA000000000002', name: 'B' })]),
    ort('Dachboden', [geraet({ ieee: 'AAAA000000000001', name: 'A' })]),
  ]);
  assert.deepEqual(m.standorte, ['Keller Büro', 'Dachboden']);
  assert.equal(m.geraete.length, 2, 'beide Geräte, keine Dopplung');
  const a = m.geraete.find((g) => g.name === 'A')!;
  assert.equal(Object.keys(a.empfang).length, 2, 'an beiden Standorten gehört');
});

test('erreichbar schlägt unerreichbar, wenn ein Standort doppelt kommt', () => {
  // Sonst entschiede die Reihenfolge darueber, ob eine Spalte Werte zeigt.
  const m = baueZigbeeMatrix([
    { standort: 'Keller Büro', erreichbar: false, geraete: [] },
    ort('Keller Büro', [geraet()]),
  ]);
  assert.deepEqual(m.nichtErreichbar, [], 'nicht als unerreichbar geführt');
  assert.equal(m.geraete[0]!.beste, 'Keller Büro');
});
