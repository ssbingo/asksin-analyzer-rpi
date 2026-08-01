import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ADAPTER_MINDESTVERSION,
  adapterZuAlt,
  vergleicheVersion,
  versionGenuegt,
} from '../src/langzeit/kompatibilitaet.ts';

test('Version: wird je Stelle verglichen, nicht als Zeichenkette', () => {
  // Der klassische Fehler: Textlich waere "0.9.0" groesser als "0.12.0".
  assert.ok(vergleicheVersion('0.9.0', '0.12.0') < 0);
  assert.ok(vergleicheVersion('0.12.1', '0.12.0') > 0);
  assert.equal(vergleicheVersion('0.12', '0.12.0'), 0);
  assert.ok(vergleicheVersion('1', '0.99.99') > 0);
});

test('Version: Vorabfassungen zaehlen wie die fertige', () => {
  assert.equal(vergleicheVersion('0.0.2-beta.1', '0.0.2'), 0);
  assert.ok(versionGenuegt('0.0.2-rc.1', '0.0.2'));
});

test('Version: unbekannt gilt als ausreichend', () => {
  // Sonst stuende die Warnung ueberall und waere damit wertlos.
  for (const murks of [null, undefined, '', 'dev', 'unbekannt']) {
    assert.equal(versionGenuegt(murks, '0.0.2'), true, String(murks));
  }
});

test('Version: zu alt wird erkannt', () => {
  assert.equal(versionGenuegt('0.0.1', '0.0.2'), false);
  assert.equal(versionGenuegt('0.0.2', '0.0.2'), true);
  assert.equal(versionGenuegt('0.1.0', '0.0.2'), true);
});

test('Version: die Meldung nennt beide Fassungen und den Ausweg', () => {
  const m = adapterZuAlt('0.0.1');
  assert.match(m, /0\.0\.1/);
  assert.match(m, new RegExp(ADAPTER_MINDESTVERSION.replace(/\./g, '\\.')));
  assert.match(m, /aktualisieren/, 'sagt, was zu tun ist');
});

test('Version: das dokumentierte Paar ist Analyzer 0.12.0 zu Adapter 0.0.2', () => {
  // Aendert sich das, muss die Gegenseite im Adapter nachgezogen werden —
  // sonst behauptet jede Seite etwas anderes.
  assert.equal(ADAPTER_MINDESTVERSION, '0.0.2');
});
