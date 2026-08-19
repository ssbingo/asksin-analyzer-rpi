import { test } from 'node:test';
import assert from 'node:assert/strict';

import { balkenAusLqi, balkenAusStoerabstand, median } from '../src/analytics/balken.ts';

test('die drei laufenden Analyzer landen dort, wo sie hingehören', () => {
  // Gemessen am 19.08.2026. Wenn eine Änderung an den Schwellen diese Zeilen
  // umwirft, ist das die Frage, die dann zu beantworten ist: Empfängt der
  // Keller wirklich schlechter als fünf Balken?
  assert.equal(balkenAusStoerabstand(41), 5, 'Keller Büro');
  assert.equal(balkenAusStoerabstand(33), 4, 'Dachboden');
  assert.equal(balkenAusStoerabstand(30), 4, 'Gartenhaus');
});

test('ohne Messung null Balken, mit schlechter Messung einer', () => {
  // Der Unterschied ist der ganze Zweck: "Ich weiss es nicht" ist etwas
  // anderes als "es ist schlecht".
  assert.equal(balkenAusStoerabstand(null), 0);
  assert.equal(balkenAusStoerabstand(Number.NaN), 0);
  assert.equal(balkenAusStoerabstand(3), 1);
  assert.equal(balkenAusStoerabstand(0), 1);
  assert.equal(balkenAusStoerabstand(-5), 1, 'unter dem Rauschen ist auch eine Aussage');
});

test('die Balken steigen mit dem Störabstand und springen nirgends', () => {
  let vorher = balkenAusStoerabstand(-10);
  for (let db = -10; db <= 60; db++) {
    const jetzt = balkenAusStoerabstand(db);
    assert.ok(jetzt >= vorher, `bei ${db} dB fiel der Balken von ${vorher} auf ${jetzt}`);
    assert.ok(jetzt - vorher <= 1, `bei ${db} dB sprang der Balken um ${jetzt - vorher}`);
    vorher = jetzt;
  }
  assert.equal(vorher, 5);
});

test('die LQI-Schwellen liegen an der gemessenen Kante', () => {
  // 18.08.2026, 38 Geräte über 24 h: Bei −86 dBm stand LQI 149, bei −87 dBm
  // nur noch 108, bei −89 dBm 8 bis 60. Genau dort liegen die Stufen.
  assert.equal(balkenAusLqi(255), 5, 'im selben Raum');
  assert.equal(balkenAusLqi(254), 5);
  assert.equal(balkenAusLqi(237), 4, '−79 dBm');
  assert.equal(balkenAusLqi(149), 3, '−86 dBm, noch tragfähig');
  assert.equal(balkenAusLqi(108), 2, '−87 dBm, die Kante');
  assert.equal(balkenAusLqi(45), 1, '−88 dBm, Grenzbereich');
  assert.equal(balkenAusLqi(0), 0, 'nichts gehört ist keine Messung');
  assert.equal(balkenAusLqi(null), 0);
});

test('Median statt Mittelwert — ein nahes Gerät soll die Anzeige nicht heben', () => {
  // Der Zigbee-Koordinator sitzt oft im selben Raum und liefert LQI 255. Der
  // Mittelwert dieser Reihe wäre 111, der Median 60 — und 60 beschreibt, was
  // dieser Standort tatsächlich hört.
  const werte = [40, 50, 60, 70, 255, 255, 30];
  assert.equal(median(werte), 60);
  assert.equal(median([]), null);
  assert.equal(median([10, 20]), 15, 'gerade Anzahl: Mitte zwischen beiden');
  assert.equal(median([Number.NaN, 5]), 5, 'unbrauchbare Werte fliegen raus');
});
