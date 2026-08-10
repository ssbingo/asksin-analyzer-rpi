import { test } from 'node:test';
import assert from 'node:assert/strict';

import { istPi5Modell, spiHelferOeffnen, StatusAnzeige } from '../src/status/anzeige.ts';
import { glyphe } from '../src/status/font.ts';
import { OledBild, i2cTransferArgs, initKommandos } from '../src/status/ssd1306.ts';
import {
  LATCH_BYTES, LATCH_MINDEST_US, SPI_HZ, kodiereWs2812,
} from '../src/status/ws2812.ts';
import {
  SEITEN_ANZAHL,
  blinkPhase,
  ledMuster,
  passeWertAn,
  zeichneSeite,
} from '../src/status/zustand.ts';
import type { StatusDaten } from '../src/status/zustand.ts';
import { FakeTime, tick } from './helpers/fakes.ts';

const DATEN: StatusDaten = {
  standort: 'Keller', version: '0.0.6', ip: '192.168.1.71',
  connected: true, demo: false, updateVerfuegbar: false, persistErrors: 0,
  telegramsPerMinute: 12, noiseFloor: -90.5, deviceCount: 9,
  maxDutyCycle: { name: 'BWM_Flur', percent: 3.5 },
  dutyAlarme: [{ name: 'Defekt_BWM Carport (klemmt)', percent: 96.4 }],
  system: { cpuLast: 0.4, tempC: 51, ramFreiProzent: 70, diskFreiProzent: 80, luefterUpm: 3120 },
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
  const L = LATCH_BYTES;
  const puffer = kodiereWs2812([255, 0, 0], 100);   // rot → GRB 00,FF,00
  assert.equal(puffer.length, L + 9 + L);
  assert.ok(puffer.slice(0, L).every((b) => b === 0), 'Latch davor');
  assert.ok(puffer.slice(L + 9).every((b) => b === 0), 'Latch danach');

  // Nicht die Zahl pruefen, sondern die Bedingung: Die Revision V5 der
  // WS2812B verlangt ueber 280 us Ruhe, die alte Fassung nur 50. Wer den
  // Latch spaeter kuerzt, faellt hier auf — und nicht erst an einer dunklen
  // LED, an der alles andere richtig aussieht.
  const latchUs = (L * 8) / (SPI_HZ / 1e6);
  assert.ok(
    latchUs > LATCH_MINDEST_US,
    `Latch ${latchUs.toFixed(0)} us, verlangt sind > ${LATCH_MINDEST_US} us`,
  );

  const daten = [...puffer.slice(L, L + 9)];
  assert.deepEqual(daten, [
    0x92, 0x49, 0x24,     // G = 0x00 → acht mal 100
    0xdb, 0x6d, 0xb6,     // R = 0xFF → acht mal 110
    0x92, 0x49, 0x24,     // B = 0x00
  ]);
  // Halbe Helligkeit skaliert die Farbwerte, nicht das Timing:
  const halb = kodiereWs2812([255, 0, 0], 50);
  assert.equal(halb.length, puffer.length);
  assert.notDeepEqual([...halb.slice(L, L + 9)], daten);
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

test('OLED-Seiten: jede Seite ist gefüllt und nichts wird abgeschnitten', () => {
  // Der Aufbau folgt dem Vorbild: kein Kopf, keine Fußzeile, ein grosser Wert.
  // Geprueft wird deshalb nicht mehr auf eine Trennlinie, sondern darauf, dass
  // jede Seite etwas zeigt und in der untersten Pixelzeile nichts angeschnitten
  // stehen bleibt — genau dieser Fall trat beim 128x32 mit zweizeiligen Werten
  // auf (Standortname, IP-Adresse).
  for (const hoehe of [32, 64] as const) {
    const bild = new OledBild(hoehe);
    for (let s = 0; s < SEITEN_ANZAHL; s++) {
      zeichneSeite(bild, s, DATEN);
      assert.ok(
        bild.puffer.some((b) => b !== 0),
        `Seite ${s} (128x${hoehe}) ist nicht leer`,
      );
      let unten = 0;
      for (let x = 0; x < 128; x++) if (bild.hatPixel(x, hoehe - 1)) unten++;
      // Die Punktreihe auf dem 64er endet bei y = 62, Text nie in der letzten
      // Zeile: Was hier steht, ist abgeschnitten.
      assert.equal(unten, 0, `Seite ${s} (128x${hoehe}) stoesst unten an`);
    }
  }
});

test('Grosse Werte: Stufe so gross wie moeglich, Umbruch statt Winzschrift', () => {
  assert.deepEqual(passeWertAn('137'), { zeilen: ['137'], skala: 3 });
  assert.deepEqual(passeWertAn('GETRENNT'), { zeilen: ['GETRENNT'], skala: 2 });
  // Zu lang fuer eine Zeile: am Trenner umbrechen, aber gross bleiben.
  assert.deepEqual(passeWertAn('192.168.1.71'), {
    zeilen: ['192.168.1.', '71'],
    skala: 2,
  });
  assert.deepEqual(passeWertAn('Büro Keller'), {
    zeilen: ['Büro ', 'Keller'],
    skala: 2,
  });
});

test('Init-Sequenz: Multiplex und COM-Pins haengen an der Bauhoehe', () => {
  // Falsche Werte machen aus einem 128x32 ein verdoppeltes, unleserliches Bild.
  const k32 = initKommandos(40, 32);
  assert.equal(k32[k32.indexOf(0xa8) + 1], 31, 'Multiplex 32 Zeilen');
  assert.equal(k32[k32.indexOf(0xda) + 1], 0x02, 'COM-Pins sequenziell');
  const k64 = initKommandos(40, 64);
  assert.equal(k64[k64.indexOf(0xa8) + 1], 63, 'Multiplex 64 Zeilen');
  assert.equal(k64[k64.indexOf(0xda) + 1], 0x12, 'COM-Pins alternierend');
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
  // Der SPI-Schreiber bleibt offen — genau das ist der Punkt. Wird er je
  // Rahmen neu geoeffnet, faellt der Takt auf den Geraetehoechstwert zurueck.
  const spiFrames: Uint8Array[] = [];
  const spiOeffnungen: Array<[string, number]> = [];
  let spiOffen = 0;

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
    spiOeffnen: (geraet, hz) => {
      spiOeffnungen.push([geraet, hz]);
      spiOffen++;
      return Promise.resolve({
        schreibe: (bytes) => {
          spiFrames.push(bytes);
          return Promise.resolve();
        },
        schliesse: () => {
          spiOffen--;
          return Promise.resolve();
        },
      });
    },
    bildVorhanden: () => true,
    // Beim Loslassen abgefragt: kurzer Druck, also blättern.
    tasteGedrueckt: () => Promise.resolve(false),
    taster: (cb) => {
      taste = cb;
      return () => {
        taste = null;
      };
    },
  });

  await anzeige.start();
  // Genau einmal geoeffnet, mit dem Takt aus der Kodierung — und NICHT ueber
  // spi-config: Dessen Einstellung stirbt mit seinem Prozess (10.08.2026,
  // Analyzer 01: gemessen 125 MHz statt 2,4 MHz, LED dunkel).
  assert.deepEqual(spiOeffnungen, [['/dev/spidev0.0', SPI_HZ]]);
  assert.equal(
    kommandos.filter(([cmd]) => cmd === 'spi-config').length, 0,
    'spi-config darf nicht mehr vorkommen',
  );
  // Das OLED zeichnet der eigene Anzeigedienst; der Core schreibt nur Werte.
  const zustand = (): Record<string, unknown> => {
    const eintrag = geschrieben.filter(([p]) => p.endsWith('oled-state.json')).at(-1);
    return JSON.parse(new TextDecoder().decode(eintrag![1])) as Record<string, unknown>;
  };
  assert.equal(zustand()['status'], 'BEREIT', 'Zustand geschrieben');

  await time.advance(500);                          // LED-Takt + OLED-Takt
  const ledFrames = (): Uint8Array[] => spiFrames;
  assert.ok(ledFrames().length >= 1, 'LED-Frame geschrieben');
  const gruen = kodiereWs2812([0, 255, 40], 100);
  assert.deepEqual([...ledFrames()[0]!], [...gruen], 'grün = alles ok');

  // Zustandswechsel → neue Farbe beim nächsten Takt:
  daten = { ...daten, connected: false };
  await time.advance(500);
  assert.equal(zustand()['status'], 'GETRENNT', 'Zustandswechsel weitergereicht');
  const rot = kodiereWs2812([255, 0, 0], 100);
  assert.deepEqual([...ledFrames().at(-1)!], [...rot], 'rot bei getrennt');

  // Taster blättert. Der Druck wird jetzt nicht mehr sofort gewertet: Erst
  // beim Loslassen steht fest, ob es kurz oder lang war.
  assert.equal(anzeige.seite, 0);
  taste!();
  await time.advance(300);
  assert.equal(anzeige.seite, 1);
  taste!();
  await time.advance(300);
  assert.equal(anzeige.seite, 2);

  await anzeige.stop();
  const schwarz = kodiereWs2812([0, 0, 0], 100);
  assert.deepEqual([...ledFrames().at(-1)!], [...schwarz], 'LED dunkel beim Stopp');
  assert.equal(spiOffen, 0, 'SPI wird beim Stopp geschlossen');
  assert.equal(spiOeffnungen.length, 1, 'einmal geoeffnet, nicht je Rahmen');
  // Beim Stopp bekommt der Anzeigedienst „aus" — er räumt das Display selbst.
  assert.equal(zustand()['aus'], true, 'Anzeigedienst wird abgeräumt');
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
    spiOeffnen: () => Promise.reject(new Error('No such device')),
    taster: () => () => {},
    onError: (kontext) => {
      fehler.push(kontext);
    },
  });
  await anzeige.start();
  await time.advance(1000);
  // Nach Fehlversuchen muss die Weboberflaeche die Stoerung auch zeigen —
  // sonst ist die Meldung in der Gegenrichtung genauso wertlos.
  assert.equal(anzeige.zustandFuerApi().aktiv.led, false, 'Stoerung wird gemeldet');
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

test('Anzeigedienst zeichnet nicht: der Taster wird gar nicht erst abonniert', async () => {
  // Hintergrund: GPIO17 hat weder auf der Platine noch im System einen
  // Ruhepegel. Ohne angeschlossenes Zubehör schwebt der Eingang, und ein
  // Lauscher darauf erzeugt aus Einstreuung fortlaufend Flanken. Früher
  // startete der Lauscher bedingungslos, sobald das OLED eingeschaltet war —
  // auch bei erkennbar leerem I2C-Bus.
  const time = new FakeTime();
  const fehler: string[] = [];
  let abonniert = 0;
  const anzeige = new StatusAnzeige({
    led: 'aus',
    oled: true,
    daten: () => ({ ...DATEN }),
    time,
    runner: () => Promise.resolve({ code: 0, output: '' }),
    schreibeGeraet: () => Promise.resolve(),
    // Der Anzeigedienst hat noch kein Bild geschrieben — also zeichnet er
    // nicht, also haengt vermutlich gar nichts am Bus.
    bildVorhanden: () => false,
    taster: (_cb) => {
      abonniert++;
      return () => {};
    },
    onError: (kontext, err) => fehler.push(`${kontext}: ${String(err)}`),
  });

  await anzeige.start();
  await time.advance(2000);
  assert.equal(abonniert, 0, 'ohne Anzeigegerät kein Lauscher auf dem Taster');
  assert.ok(
    fehler.some((f) => /Anzeigedienst meldet kein Bild/.test(f)),
    `Grund wird genannt, war: ${JSON.stringify(fehler)}`,
  );
  await anzeige.stop();
});

test('Zeichnet der Anzeigedienst, wird der Taster abonniert', async () => {
  const time = new FakeTime();
  let abonniert = 0;
  const anzeige = new StatusAnzeige({
    led: 'aus',
    oled: true,
    daten: () => ({ ...DATEN }),
    time,
    runner: () => Promise.resolve({ code: 0, output: '' }),
    schreibeGeraet: () => Promise.resolve(),
    bildVorhanden: () => true,
    taster: (_cb) => {
      abonniert++;
      return () => {};
    },
  });

  await anzeige.start();
  assert.equal(abonniert, 1);
  await anzeige.stop();
});

test('Taster: kurz blättert, lang loest den Neustart aus', async () => {
  // Zeiten wie im Vorbild: ab 50 ms kurz, ab 5 s lang, dann 3 s Meldung.
  const time = new FakeTime();
  const geschrieben: Array<[string, Uint8Array]> = [];
  let gedrueckt = false;
  let taste: (() => void) | null = null;

  const anzeige = new StatusAnzeige({
    led: 'aus',
    oled: true,
    daten: () => ({ ...DATEN }),
    time,
    runner: () => Promise.resolve({ code: 0, output: '' }),
    schreibeGeraet: (pfad, bytes) => {
      geschrieben.push([pfad, bytes]);
      return Promise.resolve();
    },
    bildVorhanden: () => true,
    tasteGedrueckt: () => Promise.resolve(gedrueckt),
    neustartDatei: '/tmp/neustart-anstoss',
    taster: (cb) => {
      taste = cb;
      return () => {};
    },
  });
  await anzeige.start();

  // --- kurz: losgelassen, bevor die fünf Sekunden voll sind ----------------
  assert.equal(anzeige.seite, 0);
  gedrueckt = false;
  taste!();
  await time.advance(300);
  assert.equal(anzeige.seite, 1, 'kurzer Druck blättert eine Seite weiter');

  // --- lang: gehalten bis über die Grenze ----------------------------------
  gedrueckt = true;
  taste!();
  await time.advance(5200);
  assert.equal(anzeige.seite, 1, 'langer Druck blättert NICHT');
  const meldung = geschrieben
    .filter(([p]) => p.endsWith('oled-state.json'))
    .map(([, b]) => JSON.parse(new TextDecoder().decode(b)) as Record<string, unknown>)
    .filter((z) => typeof z['meldung'] === 'string');
  assert.ok(meldung.length >= 1, 'Display bekommt die Neustart-Meldung');

  await time.advance(3200);
  assert.ok(
    geschrieben.some(([p]) => p === '/tmp/neustart-anstoss'),
    'Auslöserdatei für den Root-Helfer geschrieben',
  );
  await anzeige.stop();
});

test('Dauersender landen in den Anzeigedaten', async () => {
  // Ein defektes Gerät kann das Funknetz zustopfen — am Gerät soll man beim
  // Durchblättern sehen, WELCHES es ist, nicht nur dass etwas hoch ist.
  const time = new FakeTime();
  const geschrieben: Array<[string, Uint8Array]> = [];
  const anzeige = new StatusAnzeige({
    led: 'aus',
    oled: true,
    daten: () => ({ ...DATEN }),
    time,
    runner: () => Promise.resolve({ code: 0, output: '' }),
    schreibeGeraet: (pfad, bytes) => {
      geschrieben.push([pfad, bytes]);
      return Promise.resolve();
    },
    bildVorhanden: () => true,
  });
  await anzeige.start();
  await time.advance(600);
  const zustand = JSON.parse(
    new TextDecoder().decode(
      geschrieben.filter(([p]) => p.endsWith('oled-state.json')).at(-1)![1],
    ),
  ) as { dutyAlarme?: Array<{ name: string; percent: number }> };
  assert.deepEqual(zustand.dutyAlarme, [
    { name: 'Defekt_BWM Carport (klemmt)', percent: 96.4 },
  ]);
  await anzeige.stop();
});

test('Anzeige springt nach 60 s ohne Tastendruck auf Seite 1 zurück', async () => {
  // Wer im Vorbeigehen blättert, soll nicht dauerhaft eine Systemseite stehen
  // lassen. Das Vorbild macht das nach 30 s; hier sind es 60 (Vorgabe).
  const time = new FakeTime();
  const anzeige = new StatusAnzeige({
    led: 'aus',
    oled: true,
    daten: () => ({ ...DATEN }),
    time,
    runner: () => Promise.resolve({ code: 0, output: '' }),
    schreibeGeraet: () => Promise.resolve(),
    bildVorhanden: () => true,
    leseDatei: () => JSON.stringify({ seiten: 9 }),
  });
  await anzeige.start();

  anzeige.naechsteSeite();
  assert.equal(anzeige.seite, 1, 'geblättert');

  await time.advance(50_000);
  assert.equal(anzeige.seite, 1, 'vor Ablauf der Frist bleibt die Seite stehen');

  await time.advance(11_000);
  assert.equal(anzeige.seite, 0, 'nach 60 s zurück auf Seite 1');

  await anzeige.stop();
});

test('Seitenzahl wird auch gefunden, wenn der Anzeigedienst im anderen Verzeichnis liegt', async () => {
  // Der Anzeigedienst kann starten, bevor der Core /run/asksin-analyzer
  // angelegt hat, und schreibt dann nach /var/lib. Frueher las der Core nur
  // den einen konfigurierten Ort, fand nichts und blaetterte wortlos durch
  // die Notfallzahl von 9 Seiten — obwohl der Dienst 17 meldete.
  const gelesen: string[] = [];
  const time = new FakeTime();
  const anzeige = new StatusAnzeige({
    led: 'aus',
    oled: true,
    daten: () => ({ ...DATEN }),
    time,
    runner: () => Promise.resolve({ code: 0, output: '' }),
    schreibeGeraet: () => Promise.resolve(),
    bildVorhanden: () => true,
    oledBildDatei: '/run/asksin-analyzer/oled-bild.b64',
    leseDatei: (pfad: string) => {
      gelesen.push(pfad);
      if (pfad.startsWith('/run/')) throw new Error('ENOENT');
      return JSON.stringify({ seiten: 17 });
    },
  });

  // 16-mal blaettern: Bei nur 9 bekannten Seiten waere man laengst wieder
  // bei 0 — mit den gemeldeten 17 steht man auf der letzten Seite.
  // Zwischen den Druecken muss die Uhr laufen, sonst greift die Entprellung.
  for (let i = 0; i < 16; i++) {
    anzeige.naechsteSeite();
    await time.advance(300);
  }
  assert.equal(anzeige.seite, 16);
  assert.ok(gelesen.some((p) => p.startsWith('/var/lib/')),
    'der zweite Ort muss geprueft werden');
});

test('Taster wird nachgezogen, wenn der Anzeigedienst erst spaeter zeichnet', async () => {
  // Der Fehler vom 10.08.2026 an Analyzer 01.
  //
  // Die Bilddatei liegt in /run/asksin-analyzer — einem tmpfs, das nach jedem
  // Systemstart leer ist. Der Anzeigedienst startet laut seiner Unit
  // `After=asksin-analyzer`. Beim Start des Analyzers kann die Datei also gar
  // nicht da sein. Wurde nur dort geprueft, blieb der Taster nach JEDEM
  // Neustart tot — und half nur ein Neustart des Analyzers von Hand.
  const time = new FakeTime();
  let abonniert = 0;
  let zeichnet = false;                       // wie nach einem frischen Boot

  const anzeige = new StatusAnzeige({
    led: 'aus',
    oled: true,
    daten: () => ({ ...DATEN }),
    time,
    runner: () => Promise.resolve({ code: 0, output: '' }),
    schreibeGeraet: () => Promise.resolve(),
    bildVorhanden: () => zeichnet,
    taster: (_cb) => { abonniert++; return () => {}; },
  });

  await anzeige.start();
  await time.advance(2000);
  assert.equal(abonniert, 0, 'solange kein Bild da ist, kein Lauscher');

  zeichnet = true;                            // Anzeigedienst laeuft an
  await time.advance(2000);
  assert.equal(abonniert, 1, 'sobald gezeichnet wird, muss der Taster kommen');

  await time.advance(2000);
  assert.equal(abonniert, 1, 'und danach nicht doppelt abonnieren');

  await anzeige.stop();
});

test('PWM ohne laufenden Hilfsdienst wird gemeldet — einmal, nicht dauernd', async () => {
  // Der Fall vom 10.08.2026 an Analyzer 01: Betriebsart in der Weboberflaeche
  // auf PWM gestellt, aber die Voraussetzungen schafft bisher nur der
  // Installer. Der Core schrieb die Farbe korrekt — es las sie nur niemand.
  // Von aussen: dunkle LED, keine Fehlermeldung.
  const time = new FakeTime();
  const fehler: string[] = [];
  let abfragen = 0;

  const anzeige = new StatusAnzeige({
    led: 'ws2812-pwm',
    oled: false,
    daten: () => ({ ...DATEN }),
    time,
    runner: (cmd, args) => {
      if (cmd === 'systemctl' && args.includes('asksin-analyzer-led')) {
        abfragen++;
        return Promise.resolve({ code: 3, output: 'inactive' });
      }
      return Promise.resolve({ code: 0, output: '' });
    },
    schreibeGeraet: () => Promise.resolve(),
    onError: (kontext, err) => fehler.push(`${kontext}: ${String(err)}`),
  });

  await anzeige.start();
  await time.advance(70_000);

  const treffer = fehler.filter((f) => /Hilfsdienst asksin-analyzer-led/.test(f));
  assert.equal(treffer.length, 1, `genau einmal melden, war: ${treffer.length}`);
  assert.match(treffer[0]!, /led-pwm-einrichten\.sh/, 'nennt den Ausweg');
  assert.ok(abfragen >= 1, 'der Dienst wird ueberhaupt abgefragt');

  await anzeige.stop();
});

test('Laeuft der PWM-Hilfsdienst, wird nichts gemeldet', async () => {
  const time = new FakeTime();
  const fehler: string[] = [];
  const anzeige = new StatusAnzeige({
    led: 'ws2812-pwm',
    oled: false,
    daten: () => ({ ...DATEN }),
    time,
    runner: () => Promise.resolve({ code: 0, output: 'active' }),
    schreibeGeraet: () => Promise.resolve(),
    onError: (kontext, err) => fehler.push(`${kontext}: ${String(err)}`),
  });
  await anzeige.start();
  await time.advance(70_000);
  assert.equal(
    fehler.filter((f) => /Hilfsdienst/.test(f)).length, 0,
    `keine Meldung im guten Fall, war: ${JSON.stringify(fehler)}`,
  );
  await anzeige.stop();
});

test('Pi 5 mit PWM: der Analyzer nennt das Modell, nicht den Hilfsdienst', async () => {
  // Analyzer 01 am 10.08.2026: Das Geraet wurde fuer einen Pi 4 gehalten und
  // auf PWM gestellt. Der Hilfsdienst beendet sich dort mit Absicht — auf dem
  // Pi 5 sitzt die Peripherie hinter dem RP1, waehrend rpi_ws281x auf die
  // alte Speicherlage zielt. "Hilfsdienst laeuft nicht" waere zwar wahr, aber
  // irrefuehrend: Er SOLL dort nicht laufen.
  const time = new FakeTime();
  const fehler: string[] = [];
  let systemctlGefragt = 0;

  const anzeige = new StatusAnzeige({
    led: 'ws2812-pwm',
    oled: false,
    daten: () => ({ ...DATEN }),
    time,
    istPi5: () => true,
    runner: (cmd) => {
      if (cmd === 'systemctl') systemctlGefragt++;
      return Promise.resolve({ code: 3, output: 'inactive' });
    },
    schreibeGeraet: () => Promise.resolve(),
    onError: (kontext, err) => fehler.push(`${kontext}: ${String(err)}`),
  });

  await anzeige.start();
  await time.advance(70_000);

  const treffer = fehler.filter((f) => /Raspberry Pi 5/.test(f));
  assert.equal(treffer.length, 1, `genau einmal melden, war: ${treffer.length}`);
  assert.match(treffer[0]!, /SPI/, 'nennt die richtige Betriebsart');
  assert.match(treffer[0]!, /SW1/, 'und den Schalter auf der Platine');
  assert.equal(
    fehler.filter((f) => /Hilfsdienst asksin-analyzer-led läuft nicht/.test(f)).length, 0,
    'nicht zusaetzlich sein Fehlen beklagen — er soll dort gar nicht laufen',
  );
  assert.equal(systemctlGefragt, 0, 'auf dem Pi 5 gar nicht erst nachfragen');

  await anzeige.stop();
});

test('Weboberflaeche: „LED gestört" nur, wenn sie es wirklich ist', () => {
  // Hier stand `led === 'ws2812-spi'` als Bedingung — damit meldete jede
  // PWM-Anlage dauerhaft eine Stoerung, auch bei einwandfrei leuchtender
  // LED. Am 10.08.2026 auf dem Pi 3 aufgefallen, genau in dem Moment, in
  // dem die LED dort zum ersten Mal lief.
  const bau = (led: 'ws2812-spi' | 'ws2812-pwm' | 'aus'): StatusAnzeige =>
    new StatusAnzeige({ led, oled: false, daten: () => DATEN, time: new FakeTime() });

  assert.equal(bau('ws2812-pwm').zustandFuerApi().aktiv.led, true, 'PWM ist kein Fehler');
  assert.equal(bau('ws2812-spi').zustandFuerApi().aktiv.led, true, 'SPI ebenso');
  assert.equal(bau('aus').zustandFuerApi().aktiv.led, false, 'abgeschaltet ist nicht aktiv');
});

test('ws2812-spi.py meldet einen Fehlschlag, statt still nichts zu tun', async () => {
  // Der Helfer ist die einzige Stelle, die den SPI-Takt setzen kann (Node
  // kennt kein ioctl). Scheitert er, MUSS er das sagen: Ein stiller
  // Fehlschlag sieht von aussen aus wie eine kaputte LED — genau daran ist
  // am 10.08.2026 ein halber Tag draufgegangen.
  await assert.rejects(
    () => spiHelferOeffnen('/dev/gibtesnicht-spidev', SPI_HZ),
    (err: Error) => /gibtesnicht-spidev|ws2812-spi\.py/.test(err.message),
    'Fehlschlag muss das Geraet oder den Helfer benennen',
  );
});

test('istPi5Modell trifft die RP1-Generation und sonst nichts', () => {
  // Der Modellstring kommt aus dem Geraetebaum und endet auf ein Nullbyte —
  // so, wie er dasteht, wird er geprueft.
  assert.equal(istPi5Modell('Raspberry Pi 5 Model B Rev 1.1\0'), true, 'Analyzer 01');
  assert.equal(istPi5Modell('Raspberry Pi Compute Module 5 Rev 1.0\0'), true, 'CM5');
  // Der Pi 500 steckt denselben Chip in eine Tastatur — RP1 inklusive.
  // Dass "Raspberry Pi 500" die Pruefung besteht, ist Absicht, kein Zufall.
  assert.equal(istPi5Modell('Raspberry Pi 500 Rev 1.0\0'), true, 'Pi 500');

  assert.equal(istPi5Modell('Raspberry Pi 4 Model B Rev 1.5\0'), false, 'Pi 4');
  assert.equal(istPi5Modell('Raspberry Pi 400 Rev 1.0\0'), false, 'Pi 400');
  assert.equal(istPi5Modell('Raspberry Pi 3 Model B Plus Rev 1.3\0'), false, 'Pi 3');
  assert.equal(istPi5Modell('Raspberry Pi Compute Module 4 Rev 1.0\0'), false, 'CM4');
  // Unbekannt heisst nicht "Pi 5": Auf einem fremden Rechner darf die
  // Erkennung nichts behaupten, sonst stellt sie stillschweigend um.
  assert.equal(istPi5Modell(''), false, 'kein Geraetebaum');
});
