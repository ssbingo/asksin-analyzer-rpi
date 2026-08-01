import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  InfluxSchreiber,
  baueZeilen,
  escapeFeldText,
  escapeTag,
  zeile,
} from '../src/influx/schreiber.ts';
import type { InfluxDaten } from '../src/influx/schreiber.ts';
import { FakeTime } from './helpers/fakes.ts';

const DATEN: InfluxDaten = {
  standort: 'Keller (Master)',
  connected: true,
  telegramsPerMinute: 12,
  noiseFloorEwma: -90.5,
  deviceCount: 2,
  maxDutyCycle: 91.2,
  dutyAlarme: 1,
  laufzeitSekunden: 3600,
  system: {
    cpuLast: 0.42,
    tempC: 46.8,
    ramFreiProzent: 71.5,
    diskFreiProzent: 84.2,
    luefterUpm: 3120,
  },
  geraete: [
    {
      address: '350001',
      name: 'Defekt_BWM Carport (klemmt)',
      rssiEwma: -93.2,
      dutyCyclePercent: 91.2,
      telegrams: 88,
      sekundenSeitEmpfang: 4,
    },
    {
      address: '300003',
      name: 'Temperatur_Wäschekeller',
      rssiEwma: -61,
      dutyCyclePercent: 0.4,
      telegrams: 7,
      sekundenSeitEmpfang: 86_400,
    },
  ],
};

test('Line Protocol: Escaping von Leerzeichen, Kommas und Anführungszeichen', () => {
  assert.equal(escapeTag('Keller (Master)'), 'Keller\\ (Master)');
  assert.equal(escapeTag('a,b=c'), 'a\\,b\\=c');
  assert.equal(escapeFeldText('sagt "hallo"\\'), '"sagt \\"hallo\\"\\\\"');
  assert.equal(
    zeile('analyzer', { standort: 'OG Ost' }, { verbunden: true, wert: -90.5 }, 1000),
    'analyzer,standort=OG\\ Ost verbunden=true,wert=-90.5 1000000000',
  );
});

test('baueZeilen: analyzer, system und je eine Zeile pro Gerät', () => {
  const zeilen = baueZeilen(DATEN, 1_000_000);
  assert.equal(zeilen.length, 4);
  assert.match(zeilen[0]!, /^analyzer,standort=Keller\\ \(Master\) /);
  assert.match(zeilen[0]!, /telegrammeProMinute=12/);
  assert.match(zeilen[0]!, /grundrauschen=-90\.5/);
  assert.match(zeilen[0]!, /maxDutyCycle=91\.2/);
  assert.match(zeilen[0]!, /dutyAlarme=1/);
  assert.match(zeilen[0]!, /laufzeitSekunden=3600/);
  assert.match(zeilen[1]!, /^system,standort=Keller\\ \(Master\) /);
  assert.match(zeilen[1]!, /tempC=46\.8/);
  assert.match(zeilen[1]!, /luefterUpm=3120/);
  assert.match(zeilen[2]!, /^geraet,standort=.*,adresse=350001,name=Defekt_BWM\\ Carport\\ \(klemmt\) /);
  assert.match(zeilen[2]!, /dutyCycle=91\.2/);
  assert.ok(zeilen.every((z) => z.endsWith(' 1000000000000')), 'Nanosekunden');
});

test('baueZeilen: fehlende Sensoren erzeugen kein Feld statt einer Null', () => {
  // Ein Pi 3 hat keinen Luefter, ein Entwicklungsrechner keinen
  // Temperatursensor. Wuerde dafuer 0 geschrieben, saehe die Kurve in Grafana
  // nach eiskaltem Geraet mit stehendem Luefter aus — eine Falschaussage.
  const zeilen = baueZeilen(
    {
      ...DATEN,
      noiseFloorEwma: null,
      system: { ...DATEN.system, tempC: null, luefterUpm: null, diskFreiProzent: null },
    },
    1_000_000,
  );
  assert.doesNotMatch(zeilen[0]!, /grundrauschen/);
  assert.doesNotMatch(zeilen[1]!, /tempC/);
  assert.doesNotMatch(zeilen[1]!, /luefterUpm/);
  assert.doesNotMatch(zeilen[1]!, /diskFreiProzent/);
  assert.match(zeilen[1]!, /cpuLast=0\.42/, 'vorhandene Werte bleiben');
});

test('baueZeilen: sekundenSeitEmpfang macht das stumme Gerät auffindbar', () => {
  // Der Batteriewaechter steht und faellt mit diesem Feld: Ein Geraet, das
  // seit einem Tag schweigt, muss sich in Grafana sortieren lassen.
  const zeilen = baueZeilen(DATEN, 1_000_000);
  const stumm = zeilen.find((z) => z.includes('adresse=300003'));
  assert.ok(stumm, 'Zeile des stummen Geraets');
  assert.match(stumm, /sekundenSeitEmpfang=86400/);
});

test('InfluxSchreiber: schreibt im Takt, zählt Erfolge und Fehler, stoppt sauber', async () => {
  const time = new FakeTime();
  const anfragen: Array<{ url: string; token: string; body: string }> = [];
  let antwortStatus = 204;
  const s = new InfluxSchreiber({
    konfig: {
      aktiv: true,
      url: 'http://influx:8086/',
      org: 'haus',
      bucket: 'asksin',
      token: 'geheim',
      intervallSekunden: 30,
    },
    daten: () => DATEN,
    time,
    post: (url, token, body) => {
      anfragen.push({ url, token, body });
      return Promise.resolve({ status: antwortStatus, text: antwortStatus === 204 ? '' : 'kaputt' });
    },
  });

  s.start();
  await time.advance(30_000);
  assert.equal(anfragen.length, 1);
  assert.equal(
    anfragen[0]!.url,
    'http://influx:8086/api/v2/write?org=haus&bucket=asksin&precision=ns',
  );
  assert.equal(anfragen[0]!.token, 'geheim');
  // analyzer + system + zwei Geraete
  assert.equal(anfragen[0]!.body.split('\n').length, 4);
  assert.equal(s.status.schreibvorgaenge, 1);

  antwortStatus = 500;
  await time.advance(30_000);
  assert.equal(s.status.fehler, 1);
  assert.match(s.status.letzterFehlerText ?? '', /HTTP 500/);

  await s.stop();
  const vorher = anfragen.length;
  await time.advance(120_000);
  assert.equal(anfragen.length, vorher, 'nach stop() keine Schreibvorgänge mehr');
});
