import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  ALARMREGELN, mitSchaltern, vollstaendig,
} from '../src/langzeit/alarmschalter.ts';

const ECHT = resolve(
  import.meta.dirname,
  '../../deploy/grafana/provisioning/alerting/asksin-alarme.yaml',
);

test('jede Regel der Provisionierung hat einen Schalter', () => {
  // Sonst gibt es einen Alarm, den man nur noch in Grafana abstellen kann —
  // und der Betreiber sucht ihn in der Oberflaeche, wo er nicht steht.
  const yaml = readFileSync(ECHT, 'utf8');
  const uids = [...yaml.matchAll(/^\s*- uid:\s*(\S+)\s*$/gm)].map((m) => m[1]);
  assert.ok(uids.length >= 4, `Regeln gefunden: ${uids.length}`);
  for (const uid of uids) {
    assert.ok(ALARMREGELN.some((r) => r.uid === uid),
      `Regel ${uid} hat keinen Schalter in ALARMREGELN`);
  }
  for (const r of ALARMREGELN) {
    assert.ok(uids.includes(r.uid), `Schalter ${r.uid} gehoert zu keiner Regel`);
  }
});

test('aus heisst pausiert, an heisst nicht pausiert', () => {
  const yaml = readFileSync(ECHT, 'utf8');
  const raus = mitSchaltern(yaml, vollstaendig({ 'asksin-alarm-stumm': false }));

  // Die Umkehrung ist die Stelle, an der man sich vertut: Der Schalter sagt
  // „aktiv", die Datei sagt „pausiert".
  const zeilen = raus.split('\n');
  const paused = (uid: string): string => {
    const i = zeilen.findIndex((z) => z.trim() === `- uid: ${uid}`);
    assert.notEqual(i, -1, `${uid} nicht gefunden`);
    return zeilen[i + 1]!.trim();
  };
  assert.equal(paused('asksin-alarm-stumm'), 'isPaused: true', 'ausgeschaltet');
  assert.equal(paused('asksin-alarm-offline'), 'isPaused: false', 'eingeschaltet');
});

test('zweimal angewandt ergibt dasselbe wie einmal', () => {
  // Der Helfer laeuft bei jedem Update erneut ueber die Datei. Ohne diese
  // Eigenschaft stuende das isPaused nach dem dritten Update dreimal da.
  const yaml = readFileSync(ECHT, 'utf8');
  const s = vollstaendig({ 'asksin-alarm-rauschen': false });
  const einmal = mitSchaltern(yaml, s);
  const zweimal = mitSchaltern(einmal, s);
  assert.equal(zweimal, einmal);
  assert.equal((einmal.match(/isPaused:/g) ?? []).length, ALARMREGELN.length);
});

test('ein Schalter laesst sich umlegen, ohne die Datei sonst zu veraendern', () => {
  const yaml = readFileSync(ECHT, 'utf8');
  const an = mitSchaltern(yaml, vollstaendig({}));
  const aus = mitSchaltern(an, vollstaendig({ 'asksin-alarm-dutycycle': false }));
  const unterschiede = an.split('\n')
    .map((z, i) => (z === aus.split('\n')[i] ? null : i))
    .filter((i): i is number => i !== null);
  assert.equal(unterschiede.length, 1, 'genau eine Zeile aendert sich');
});

test('die Kommentare der Regeldatei bleiben erhalten', () => {
  // Sie sind teuer erarbeitet — jede erklaert einen Fehler, der einmal Zeit
  // gekostet hat. Ein YAML-Umlauf haette sie alle verworfen.
  const yaml = readFileSync(ECHT, 'utf8');
  const raus = mitSchaltern(yaml, vollstaendig({}));
  const vorher = (yaml.match(/^\s*#/gm) ?? []).length;
  const nachher = (raus.match(/^\s*#/gm) ?? []).length;
  assert.equal(nachher, vorher, `${vorher} Kommentarzeilen erwartet`);
  assert.ok(vorher > 20, 'die Datei ist ausfuehrlich kommentiert');
});

test('fehlende Angaben fallen auf die Vorgabe zurueck', () => {
  const v = vollstaendig(undefined);
  assert.equal(Object.keys(v).length, ALARMREGELN.length);
  for (const r of ALARMREGELN) assert.equal(v[r.uid], r.vorgabe);
  // Eine unbekannte uid wird nicht durchgereicht — sonst stuende sie
  // irgendwann in der Datei und Grafana beschwerte sich.
  assert.equal(vollstaendig({ 'fremde-regel': true })['fremde-regel'], undefined);
});
