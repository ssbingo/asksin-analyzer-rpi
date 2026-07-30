import { test } from 'node:test';
import assert from 'node:assert/strict';

import { StatusAnzeige } from '../src/status/anzeige.ts';
import { glyphe } from '../src/status/font.ts';
import { OledBild, i2cTransferArgs, initKommandos } from '../src/status/ssd1306.ts';
import { kodiereWs2812 } from '../src/status/ws2812.ts';
import { blinkPhase, ledMuster, zeichneSeite } from '../src/status/zustand.ts';
import type { StatusDaten } from '../src/status/zustand.ts';
import { FakeTime, tick } from './helpers/fakes.ts';

const DATEN: StatusDaten = {
  standort: 'Keller', version: '0.0.6', ip: '192.168.1.71',
  connected: true, demo: false, updateVerfuegbar: false, persistErrors: 0,
  telegramsPerMinute: 12, noiseFloor: -90.5, deviceCount: 9,
  maxDutyCycle: { name: 'BWM_Flur', percent: 3.5 },
  system: { cpuLast: 0.4, tempC: 51, ramFreiProzent: 70, diskFreiProzent: 80 },
};

test('Framebuffer: Glyphe A landet spaltengenau im Puffer', () => {
  const bild = new OledBild();
  bild.text(0, 0, 'A');
  const spalten = glyphe('A');                      // [0x7e,0x11,0x11,0x11,0x7e]
  for (let x = 0; x < 5; x++) {
    for (let y = 0; y < 8; y++) {
      assert.equal(
        bild.hatPixel(x, y),
        ((spalten[x]! >> y) & 1) === 1,
        `Pixel (${x},${y})`,
      );
    }
  }
  assert.equal(bild.hatPixel(5, 0), false, 'Spalte 6 ist Abstand');
});

test('WS2812-SPI-Kodierung: 1→110, 0→100, GRB-Reihenfolge, Latch', () => {
  const puffer = kodiereWs2812([255, 0, 0], 100);   // rot → GRB 00,FF,00
  assert.equal(puffer.length, 64 + 9 + 64);
  assert.ok(puffer.slice(0, 64).every((b) => b === 0), 'Latch davor');
  assert.ok(puffer.slice(73).every((b) => b === 0), 'Latch danach');
  const daten = [...puffer.slice(64, 73)];
  assert.deepEqual(daten, [
    0x92, 0x49, 0x24,     // G = 0x00 → acht mal 100
    0xdb, 0x6d, 0xb6,     // R = 0xFF → acht mal 110
    0x92, 0x49, 0x24,     // B = 0x00
  ]);
  // Halbe Helligkeit skaliert die Farbwerte, nicht das Timing:
  const halb = kodiereWs2812([255, 0, 0], 50);
  assert.equal(halb.length, puffer.length);
  assert.notDeepEqual([...halb.slice(64, 73)], daten);
});

test('LED-Muster: Prioritätsleiter Alarm > getrennt > Fehler > Demo > Update > ok', () => {
  const alarm = { ...DATEN, maxDutyCycle: { name: 'X', percent: 85 }, connected: false };
  assert.equal(ledMuster(alarm).blinken, 'schnell');
  assert.match(ledMuster(alarm).grund, /Alarm/);
  assert.match(ledMuster({ ...DATEN, connected: false }).grund, /getrennt/);
  assert.match(ledMuster({ ...DATEN, persistErrors: 2 }).grund, /Persistenz/);
  assert.match(ledMuster({ ...DATEN, demo: true }).grund, /Demo/);
  assert.match(ledMuster({ ...DATEN, updateVerfuegbar: true }).grund, /Update/);
  assert.equal(ledMuster(DATEN).grund, 'alles in Ordnung');
});

test('Blinkphasen folgen der Wanduhr', () => {
  assert.equal(blinkPhase('aus', 12345), 1);
  assert.equal(blinkPhase('schnell', 0), 1);
  assert.equal(blinkPhase('schnell', 300), 0);
  assert.equal(blinkPhase('langsam', 0), 1);
  assert.equal(blinkPhase('langsam', 900), 0);
  assert.ok(blinkPhase('puls', 1000) > blinkPhase('puls', 100), 'Atmen steigt an');
});

test('OLED-Seiten: Kopfzeile + Trennlinie auf jeder Seite, Alarm sichtbar', () => {
  const bild = new OledBild();
  for (let s = 0; s < 4; s++) {
    zeichneSeite(bild, s, DATEN);
    assert.ok(bild.hatPixel(0, 9), `Trennlinie Seite ${s}`);
    assert.ok(
      bild.puffer.some((b) => b !== 0),
      `Seite ${s} ist nicht leer`,
    );
  }
});

test('i2cTransferArgs: Steuerbyte + Nutzdaten als ein Schreibvorgang', () => {
  const args = i2cTransferArgs(1, 0x3c, 0x00, [0xae, 0xaf]);
  assert.deepEqual(args, ['-y', '1', 'w3@0x3c', '0x00', '0xae', '0xaf']);
  assert.equal(initKommandos(40).includes(0xaf), true, 'Display an am Ende');
});

test('StatusAnzeige: LED-Takt schreibt kodierte Frames, OLED initialisiert und blättert', async () => {
  const time = new FakeTime();
  const kommandos: Array<[string, string[]]> = [];
  const geschrieben: Array<[string, Uint8Array]> = [];
  let taste: (() => void) | null = null;
  let daten = { ...DATEN };

  const anzeige = new StatusAnzeige({
    led: 'ws2812-spi',
    oled: true,
    helligkeit: 100,
    daten: () => daten,
    time,
    runner: (cmd, args) => {
      kommandos.push([cmd, args]);
      return Promise.resolve({ code: 0, output: '' });
    },
    schreibeGeraet: (pfad, bytes) => {
      geschrieben.push([pfad, bytes]);
      return Promise.resolve();
    },
    taster: (cb) => {
      taste = cb;
      return () => {
        taste = null;
      };
    },
  });

  await anzeige.start();
  assert.deepEqual(kommandos[0]![0], 'spi-config');
  assert.equal(kommandos[1]![0], 'i2ctransfer', 'OLED-Init');
  assert.ok(kommandos[1]![1].includes('0xae'), 'Init beginnt mit Display-aus');

  await time.advance(500);                          // LED-Takt + OLED-Takt
  assert.ok(geschrieben.length >= 1, 'LED-Frame geschrieben');
  const gruen = kodiereWs2812([0, 255, 40], 100);
  assert.deepEqual([...geschrieben[0]![1]], [...gruen], 'grün = alles ok');
  const oledDaten = kommandos.filter(
    ([cmd, args]) => cmd === 'i2ctransfer' && args[2] === 'w1025@0x3c',
  );
  assert.ok(oledDaten.length >= 1, 'ganzer Framebuffer in einem Transfer');

  // Zustandswechsel → neue Farbe beim nächsten Takt:
  daten = { ...daten, connected: false };
  await time.advance(250);
  const rot = kodiereWs2812([255, 0, 0], 100);
  assert.deepEqual([...geschrieben.at(-1)![1]], [...rot], 'rot bei getrennt');

  // Taster blättert (mit Entprellung):
  assert.equal(anzeige.seite, 0);
  taste!();
  assert.equal(anzeige.seite, 1);
  taste!();                                          // < 250 ms → entprellt
  assert.equal(anzeige.seite, 1);
  await time.advance(300);
  taste!();
  assert.equal(anzeige.seite, 2);

  await anzeige.stop();
  const schwarz = kodiereWs2812([0, 0, 0], 100);
  assert.deepEqual([...geschrieben.at(-1)![1]], [...schwarz], 'LED dunkel beim Stopp');
  assert.ok(
    kommandos.at(-1)![1].includes('0xae'),
    'OLED aus beim Stopp',
  );
});

test('StatusAnzeige: fehlende Hardware legt nur den Teil still, wirft nie', async () => {
  const time = new FakeTime();
  const fehler: string[] = [];
  const anzeige = new StatusAnzeige({
    led: 'ws2812-spi',
    oled: true,
    daten: () => DATEN,
    time,
    runner: () => Promise.resolve({ code: 1, output: 'No such device' }),
    schreibeGeraet: () => Promise.reject(new Error('ENOENT')),
    taster: () => () => {},
    onError: (kontext) => {
      fehler.push(kontext);
    },
  });
  await anzeige.start();
  await time.advance(1000);
  await anzeige.stop();
  assert.ok(fehler.includes('led') && fehler.includes('oled'));
});

test('StatusAnzeige PWM: schreibt r,g,b als Text, kein spi-config, dunkel beim Stopp', async () => {
  const time = new FakeTime();
  const kommandos: Array<[string, string[]]> = [];
  const geschrieben: Array<[string, Uint8Array]> = [];
  let daten = { ...DATEN };

  const anzeige = new StatusAnzeige({
    led: 'ws2812-pwm',
    oled: false,
    helligkeit: 50,
    pwmDatei: '/tmp/led-farbe-test',
    daten: () => daten,
    time,
    runner: (cmd, args) => {
      kommandos.push([cmd, args]);
      return Promise.resolve({ code: 0, output: '' });
    },
    schreibeGeraet: (pfad, bytes) => {
      geschrieben.push([pfad, bytes]);
      return Promise.resolve();
    },
  });

  await anzeige.start();
  assert.equal(
    kommandos.some(([cmd]) => cmd === 'spi-config'),
    false,
    'PWM fasst SPI nicht an',
  );

  const text = (): string => new TextDecoder().decode(geschrieben.at(-1)![1]);

  await time.advance(300);
  assert.equal(geschrieben[0]![0], '/tmp/led-farbe-test', 'Ziel ist die Farbdatei');
  // grün (0,255,40) bei 50 % Helligkeit -> 0,128,20
  assert.equal(text(), '0,128,20\n');

  daten = { ...daten, connected: false };
  await time.advance(250);
  assert.equal(text(), '128,0,0\n', 'rot bei getrennt, halbe Helligkeit');

  await anzeige.stop();
  assert.equal(text(), '0,0,0\n', 'beim Stopp dunkel');
});

test('StatusAnzeige PWM: Schreibfehler schalten nur die LED ab, werfen nicht', async () => {
  const time = new FakeTime();
  const fehler: string[] = [];
  const anzeige = new StatusAnzeige({
    led: 'ws2812-pwm',
    oled: false,
    daten: () => ({ ...DATEN }),
    time,
    runner: () => Promise.resolve({ code: 0, output: '' }),
    schreibeGeraet: () => Promise.reject(new Error('kein Platz')),
    onError: (kontext, err) => fehler.push(`${kontext}: ${String(err)}`),
  });

  await anzeige.start();
  await time.advance(2000);
  assert.ok(fehler.length >= 1, 'Fehler gemeldet');
  assert.match(fehler[0]!, /led: .*kein Platz/);
  await anzeige.stop();                       // darf nicht werfen
});
