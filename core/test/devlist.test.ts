import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  DeviceResolver,
  classify,
  isHmIpSerial,
  parseDevList,
} from '../src/resolve/devlist.ts';
import {
  decodeCcuResponse,
  unescapeHtml,
} from '../src/resolve/ccuResponse.ts';

/**
 * Die Fixture ist eine synthetische Beispielanlage, deren STRUKTUR 1:1 dem
 * Export einer echten RaspberryMatic entspricht (verifiziert 28.07.2026):
 * gleiche Eintragszahl, doppelte Adressen, Gruppen-Einträge, die Zentrale
 * zweimal, Umlaute, Eigenbau-Geräte mit winzigen Adressen. Namen und
 * Seriennummern sind erfunden.
 */
const list = parseDevList(
  readFileSync(new URL('./fixtures/devlist-beispielanlage.json', import.meta.url), 'utf8'),
);

test('die Beispielanlage wird vollständig geparst', () => {
  assert.equal(list.devices.length, 241);
  assert.equal(list.created_at, 1785246272);
});

test('parseDevList weist kaputte Strukturen mit klarer Meldung ab', () => {
  assert.throws(() => parseDevList(null), /kein Objekt/);
  assert.throws(() => parseDevList({}), /created_at/);
  assert.throws(() => parseDevList({ created_at: 1 }), /devices/);
  assert.throws(
    () => parseDevList({ created_at: 1, devices: [{ serial: 'x', name: 'y' }] }),
    /Eintrag 0 ohne ganzzahlige address/,
  );
});

test('doppelte Adressen überschreiben einander nicht', () => {
  const resolver = new DeviceResolver(list);
  assert.equal(resolver.size, 241);
  // 4 Adressen sind doppelt belegt → 237 unterschiedliche Adressen.
  assert.equal(resolver.addressCount, 237);

  // Rauchmelder + seine Gruppe unter derselben Adresse:
  const einträge = resolver.entries(2600001);
  assert.equal(einträge.length, 2);
  assert.deepEqual(
    einträge.map((e) => e.serial).sort(),
    ['*LEQ0311847', 'LEQ0311847'],
  );
});

test('der maßgebliche Eintrag ist das reale Gerät, nicht die Gruppe', () => {
  const resolver = new DeviceResolver(list);
  const primär = resolver.resolve(2600001);
  assert.equal(primär?.name, 'RM_Arbeitszimmer');
  assert.equal(primär?.kind, 'device');
  // Die Gruppe bleibt als zweiter Eintrag erreichbar:
  assert.equal(resolver.entries(2600001)[1]?.kind, 'team');
});

test('die Zentrale steht zweimal in der Liste und wird als central erkannt', () => {
  const resolver = new DeviceResolver(list);
  const einträge = resolver.entries(12000001);
  assert.equal(einträge.length, 2);
  assert.ok(einträge.every((e) => e.kind === 'central'));
  assert.ok(einträge.every((e) => e.isHmIp));
  // BidCoS-Zentrale ebenso:
  assert.equal(resolver.resolve(2500001)?.kind, 'central');
});

test('Umlaute überleben die Verarbeitung', () => {
  const resolver = new DeviceResolver(list);
  assert.equal(resolver.nameOf(6600001), 'BWM_Wäschekeller (Licht)');
  assert.equal(resolver.nameOf(6600002), 'FSA_Küche (Theke)');
});

test('HmIP-Erkennung nach XS-Konvention', () => {
  assert.equal(isHmIpSerial('0030DDA9B00001'), true);   // 14 Zeichen
  assert.equal(isHmIpSerial('HmIP-RF'), true);
  assert.equal(isHmIpSerial('LEQ0311847'), false);      // klassisch, 10 Zeichen
  const resolver = new DeviceResolver(list);
  assert.equal(resolver.resolve(11000001)?.isHmIp, true);   // BWM_Zufahrt (HmIP)
  assert.equal(resolver.resolve(2900001)?.isHmIp, false);   // BWM_Bad OG
});

test('Pseudo-Einträge des CCU-Scripts werden erkannt', () => {
  const resolver = new DeviceResolver(list);
  assert.equal(resolver.resolve(0)?.kind, 'pseudo');             // HMRF Broadcast
  assert.equal(resolver.resolve(15728641)?.kind, 'pseudo');      // HmIP Multicast
  const pseudo = list.devices.filter((d) => classify(d) === 'pseudo');
  assert.equal(pseudo.length, 9);
});

test('Eigenbau-Geräte mit kleinen Adressen sind normale Geräte', () => {
  const resolver = new DeviceResolver(list);
  assert.equal(resolver.resolve(257)?.name, 'FSA_Lüftung Büro (KG)');
  assert.equal(resolver.resolve(257)?.kind, 'device');
  assert.equal(resolver.resolve(16131)?.kind, 'device');
});

test('unbekannte Adressen liefern die Hex-Darstellung des Sniffers', () => {
  const resolver = new DeviceResolver(list);
  assert.equal(resolver.nameOf(0x1a2b3c), resolver.resolve(0x1a2b3c)?.name ?? '1A2B3C');
  assert.equal(resolver.nameOf(0xdeadbe), 'DEADBE');
  assert.equal(resolver.nameOf(0x000005), '000005');
});

test('createdAt wird als Datum geführt', () => {
  const resolver = new DeviceResolver(list);
  assert.equal(resolver.createdAt.getTime(), 1785246272000);
});

// ---------------------------------------------------------------- CCU-Hülle

test('decodeCcuResponse packt latin1 + XML + HTML-Escapes aus', () => {
  const json = '{"created_at":1,"devices":[{"address":1,"serial":"X","name":"Wäschekeller"}]}';
  const escaped = json.replaceAll('"', '&quot;');
  const antwort = `<xml><exec>…</exec><ret>${escaped}</ret></xml>`;
  // latin1-Bytes bauen — genau so liefert es die CCU:
  const raw = Uint8Array.from([...antwort].map((c) => {
    const cp = c.codePointAt(0)!;
    return cp <= 0xff ? cp : 0x3f;               // „…" fällt auf '?', egal
  }));
  const dekodiert = decodeCcuResponse(raw);
  const geparst = parseDevList(dekodiert);
  assert.equal(geparst.devices[0]?.name, 'Wäschekeller');
});

test('decodeCcuResponse ohne <ret> wirft verständlich', () => {
  const raw = new TextEncoder().encode('<xml>kaputt</xml>');
  assert.throws(() => decodeCcuResponse(raw), /kein <ret>/);
});

test('unescapeHtml löst benannte und numerische Entities', () => {
  assert.equal(unescapeHtml('&quot;a&quot; &amp; &lt;b&gt;'), '"a" & <b>');
  assert.equal(unescapeHtml('B&#252;ro &#xE4;'), 'Büro ä');
  assert.equal(unescapeHtml('&unbekannt;'), '&unbekannt;');
});
