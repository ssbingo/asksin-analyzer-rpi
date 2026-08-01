import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  NUR_MASTER,
  ROLLE_VORGABE,
  geltendeRolle,
  istRolle,
  masterFaehig,
  rolleMitHardware,
  verlangeMaster,
} from '../src/langzeit/rolle.ts';

test('Rolle: nur master und client zählen als gültig', () => {
  assert.ok(istRolle('master'));
  assert.ok(istRolle('client'));
  for (const murks of ['Master', 'MASTER', '', 'server', null, undefined, 1, {}]) {
    assert.equal(istRolle(murks), false, `${String(murks)} darf nicht durchgehen`);
  }
});

test('Rolle: Weboberfläche schlägt config.json schlägt Vorgabe', () => {
  assert.equal(geltendeRolle('client', 'master'), 'client', 'UI gewinnt');
  assert.equal(geltendeRolle(undefined, 'client'), 'client', 'sonst config.json');
  assert.equal(geltendeRolle(undefined, undefined), 'master', 'sonst Vorgabe');
});

test('Rolle: unsinnige Werte fallen auf die nächste Quelle zurück', () => {
  // Eine von Hand verhunzte Datei darf nicht dazu führen, dass ein Gerät
  // gar keine Rolle mehr hat — dann liesse sich nichts mehr bedienen.
  assert.equal(geltendeRolle('Häuptling', 'client'), 'client');
  assert.equal(geltendeRolle(null, 'quatsch'), 'master');
});

test('Rolle: ein Alleingerät ist sein eigener Master', () => {
  // Ohne Verbund gibt es keine Peers. Waere die Vorgabe 'client', koennte
  // niemand ohne Verbund je Langzeitdaten einrichten.
  assert.equal(ROLLE_VORGABE, 'master');
  assert.equal(geltendeRolle(undefined, undefined), 'master');
});

test('Rolle: der Client wird serverseitig abgewiesen, nicht nur in der UI', () => {
  // Ein ausgeblendeter Knopf ist keine Zusicherung — die API ist im Heimnetz
  // erreichbar, also muss die Pruefung hier stattfinden.
  assert.doesNotThrow(() => verlangeMaster('master'));
  assert.throws(() => verlangeMaster('client'), { message: NUR_MASTER });
  assert.match(NUR_MASTER, /Einstellungen/, 'die Meldung sagt, wo es zu ändern ist');
});

const GB = 1024 ** 3;

test('Hardware: Pi 3 darf nicht Master werden, egal wie viel RAM', () => {
  // InfluxDB und Grafana brauchen zusammen rund 700 MB, daneben soll der
  // Sniffer laufen. Auf einem Pi 3 waere das genau das Ressourcenproblem,
  // das die Beschraenkung vermeiden soll.
  const pi3 = masterFaehig({ modell: 'Raspberry Pi 3 Model B Rev 1.2', ramBytes: 1 * GB });
  assert.equal(pi3.faehig, false);
  assert.match(pi3.grund, /Pi 3 ist als Master zu schwach/);
  assert.match(pi3.grund, /Client/, 'sagt, was stattdessen geht');
});

test('Hardware: Pi 4 und Pi 5 mit genug Speicher duerfen', () => {
  assert.equal(masterFaehig({ modell: 'Raspberry Pi 4 Model B Rev 1.4', ramBytes: 4 * GB }).faehig, true);
  assert.equal(masterFaehig({ modell: 'Raspberry Pi 5 Model B Rev 1.1', ramBytes: 8 * GB }).faehig, true);
});

test('Hardware: unter 2 GB ist Schluss — auch beim Pi 5', () => {
  const klein = masterFaehig({ modell: 'Raspberry Pi 5 Model B Rev 1.1', ramBytes: 1 * GB });
  assert.equal(klein.faehig, false);
  assert.match(klein.grund, /mindestens 2 GB/);
});

test('Hardware: ein echter 2-GB-Pi meldet nie die vollen 2 GiB', () => {
  // Firmware und Grafikspeicher gehen vorher ab; totalmem() liefert dann
  // etwa 1,9 GiB. Eine strenge 2-GiB-Grenze wuerde genau die Geraete
  // abweisen, die gemeint sind.
  const echt2gb = { modell: 'Raspberry Pi 4 Model B Rev 1.1', ramBytes: 1.91 * GB };
  assert.equal(masterFaehig(echt2gb).faehig, true);
});

test('Hardware: Nicht-Pi wird nach Speicher beurteilt, nicht nach Baureihe', () => {
  // Entwicklungsrechner und virtuelle Maschinen haben kein device-tree-Modell.
  // Ueber eine Baureihe zu urteilen, die nicht dasteht, waere geraten.
  assert.equal(masterFaehig({ modell: '', ramBytes: 16 * GB }).faehig, true);
  assert.equal(masterFaehig({ modell: '', ramBytes: 0.5 * GB }).faehig, false);
});

test('Hardware: zu schwaches Geraet wird zum Client, auch wenn master konfiguriert ist', () => {
  // Sonst haenge die Zusicherung daran, dass niemand die Datei von Hand
  // bearbeitet.
  const pi3 = { modell: 'Raspberry Pi 3 Model B Plus Rev 1.3', ramBytes: 1 * GB };
  const e = rolleMitHardware('master', pi3);
  assert.equal(e.rolle, 'client');
  assert.equal(e.erzwungen, true);
  assert.match(e.grund, /zu schwach/);

  const pi5 = { modell: 'Raspberry Pi 5 Model B Rev 1.1', ramBytes: 8 * GB };
  assert.deepEqual(rolleMitHardware('master', pi5), { rolle: 'master', erzwungen: false, grund: '' });
  assert.deepEqual(rolleMitHardware('client', pi5), { rolle: 'client', erzwungen: false, grund: '' });
});
