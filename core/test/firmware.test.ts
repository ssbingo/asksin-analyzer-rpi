import { test } from 'node:test';
import assert from 'node:assert/strict';

import { deuteAvrdude, flashFirmware, siehtNachIntelHexAus } from '../src/update/firmware.ts';
import type { KommandoErgebnis } from '../src/update/firmware.ts';

interface Aufruf {
  cmd: string;
  args: string[];
}

/** Runner-Attrappe: zeichnet Aufrufe auf, antwortet nach Drehbuch. */
function runner(drehbuch: Array<KommandoErgebnis>) {
  const aufrufe: Aufruf[] = [];
  return {
    aufrufe,
    run: (cmd: string, args: string[]): Promise<KommandoErgebnis> => {
      aufrufe.push({ cmd, args });
      return Promise.resolve(drehbuch.shift() ?? { code: 0, output: '' });
    },
  };
}

/**
 * Bildet die Reset-Strecke nach, statt nur Argumente zu vergleichen.
 *
 * Massgeblich ist die Verdrahtung: GPIO4 → C8 (100 n) → RESET, dahinter R2
 * (10 k) nach +3V3. Der 328P wird also von der **fallenden Flanke** an GPIO4
 * zurueckgesetzt, nicht vom Pegel. Daraus folgen die beiden Regeln, die dieses
 * Modell durchsetzt:
 *
 *  1. libgpiod laesst die Leitung stehen, wo das Kommando sie hingesetzt hat.
 *     Ein LOW ohne nachfolgendes HIGH bleibt LOW — ueber den Aufruf hinaus.
 *  2. avrdude erreicht den Bootloader nur, wenn seit dem letzten Flash eine
 *     fallende Flanke kam. Liegt die Leitung schon auf LOW, passiert beim
 *     naechsten `gpioset 4=0` gar nichts.
 *
 * Deshalb faellt der alte Stand erst beim **zweiten** Flash durch — genau so,
 * wie er es in der Wirklichkeit getan haette.
 *
 * `syntax: 'v1'` laesst die v2-Aufrufe scheitern, wie es aeltere libgpiod tut.
 */
function gpioModell(syntax: 'v1' | 'v2' = 'v2') {
  const leitung = { pegel: 1 };          // Ruhezustand: R2 zieht RESET hoch
  let flankeSeitFlash = false;
  const aufrufe: Aufruf[] = [];
  const run = (cmd: string, args: string[]): Promise<KommandoErgebnis> => {
    aufrufe.push({ cmd, args });
    const alle = [cmd, ...args];

    if (alle.includes('gpioset')) {
      const v2 = alle.includes('-c');
      if (v2 && syntax === 'v1') {
        return Promise.resolve({ code: 1, output: "unrecognized option '-c'" });
      }
      if (!v2 && syntax === 'v2') {
        return Promise.resolve({ code: 1, output: "unrecognized option '--mode=time'" });
      }
      const neu = Number(alle.at(-1)!.split('=')[1]);
      if (leitung.pegel === 1 && neu === 0) flankeSeitFlash = true;
      leitung.pegel = neu;
      // timeout beendet das haltende gpioset — Code 124 ist der Erfolgsfall.
      return Promise.resolve({ code: cmd === 'timeout' ? 124 : 0, output: '' });
    }

    if (cmd === 'avrdude') {
      // Der Bootloader antwortet nur, wenn VOR avrdude eine fallende Flanke
      // kam — und die Leitung beim Reset ruhig war.
      //
      // urboot betritt seine Schleife ausschliesslich nach externem Reset und
      // misst dann die Baudrate an der ersten LOW-Phase. Laeuft avrdude schon
      // und sendet, faellt der Reset mitten in ein Byte und die Messung geht
      // daneben. Am 10.08.2026 durchgemessen: Reset zuerst -> Sync, avrdude
      // zuerst -> nie.
      const erreichbar = flankeSeitFlash;
      flankeSeitFlash = false;
      return Promise.resolve(
        erreichbar
          ? { code: 0, output: 'avrdude done' }
          : { code: 1, output: 'urclock_getsync(): not in sync' },
      );
    }
    return Promise.resolve({ code: 0, output: '' });
  };
  return { leitung, aufrufe, run };
}

test('HAT-Flash: zweimal hintereinander — jeder Reset braucht eine eigene Flanke', async () => {
  const g = gpioModell();
  const opts = { device: '/dev/asksin-hat', runCommand: g.run, anlaufMs: 5 };

  const erste = await flashFirmware('/tmp/fw.hex', opts);
  assert.equal(erste.ok, true, erste.log);

  // Hier faellt der alte Stand: Er liess GPIO4 auf LOW liegen, also gab es
  // beim zweiten Aufruf keinen Pegelwechsel mehr — kein Reset, kein
  // Bootloader, "not in sync". Beim ersten Ausprobieren faellt das nie auf.
  const zweite = await flashFirmware('/tmp/fw.hex', opts);
  assert.equal(zweite.ok, true, zweite.log);
  assert.equal(g.leitung.pegel, 1, 'GPIO4 muss am Ende wieder HIGH sein');

  const namen = g.aufrufe.map((a) => `${a.cmd} ${a.args.join(' ')}`);
  const hoch = namen.findIndex((z) => z.includes('4=1'));
  const tief = namen.findIndex((z) => z.includes('4=0'));
  const avr = namen.findIndex((z) => z.startsWith('avrdude'));

  // Reihenfolge: erst HIGH (Ausgangspegel), dann LOW (die Flanke, die
  // zurueckstellt), dann sofort avrdude.
  assert.ok(hoch >= 0 && tief > hoch, 'erst HIGH, dann der Reset-Impuls');
  // Nachgemessen am 10.08.2026: urboot braucht eine ruhige Leitung, wenn er
  // nach dem Reset die Baudrate misst. Also erst der Impuls, dann avrdude.
  assert.ok(avr > tief, 'avrdude startet NACH dem Reset-Impuls');

  // Und das ist die eigentliche Zusicherung, gelernt am 14.08.2026: Zwischen
  // der fallenden Flanke und dem Start von avrdude darf NICHTS mehr liegen.
  // urboot lauscht danach genau eine Sekunde; jeder zusaetzliche
  // Prozessstart geht davon ab. Frueher stand hier noch ein HIGH-Puls von
  // 50 ms samt Prozessstart — auf einem beschaeftigten Pi 5 reichte das, um
  // das Fenster zu verpassen. Der Flash gelang dann beim zweiten Anlauf.
  assert.deepEqual(
    namen.slice(tief + 1, avr),
    [],
    'zwischen Reset und avrdude darf kein Schritt liegen',
  );

  const avrArgs = g.aufrufe[avr]!.args;
  // 57600 statt der krummen Betriebsrate: urboot misst selbst, und bei 8 MHz
  // ist 115200 zu schnell fuer seine Zaehlschleife (durchgemessen).
  assert.ok(avrArgs.includes('-b') && avrArgs.includes('57600'), 'genormte Flash-Rate');
  assert.ok(avrArgs.includes('/dev/asksin-hat'));
  assert.ok(avrArgs.includes('flash:w:/tmp/fw.hex:i'));
});

test('HAT-Flash: fällt auf gpioset-v1-Syntax zurück, auch beim Freigeben', async () => {
  const g = gpioModell('v1');
  const opts = { device: '/dev/asksin-hat', runCommand: g.run, anlaufMs: 5 };
  assert.equal((await flashFirmware('/tmp/fw.hex', opts)).ok, true);
  assert.equal((await flashFirmware('/tmp/fw.hex', opts)).ok, true, 'auch v1 gibt frei');
  assert.equal(g.leitung.pegel, 1);
  assert.ok(
    g.aufrufe.some(
      (a) => a.cmd === 'gpioset' && a.args.join(' ') === '--mode=time --usec=50000 gpiochip0 4=0',
    ),
    'v1-Impuls mit 50 ms — kurz, weil die Haltezeit vom Ein-Sekunden-Fenster abgeht',
  );
});

test('HAT-Flash: scheitert die Freigabe, sagt das Log wie man von Hand löst', async () => {
  const g = gpioModell();
  let n = 0;
  const run = (cmd: string, args: string[]): Promise<KommandoErgebnis> => {
    // Der Impuls klappt, das Zurückziehen auf HIGH nicht (beide Syntaxen).
    if ([cmd, ...args].includes('gpioset') && args.join(' ').includes('4=1')) {
      n += 1;
      return Promise.resolve({ code: 2, output: 'gpioset: permission denied' });
    }
    return g.run(cmd, args);
  };
  const erg = await flashFirmware('/tmp/fw.hex', {
    device: '/dev/asksin-hat',
    runCommand: run,
    anlaufMs: 5,
  });
  // Der Flash selbst ist gelungen — der Reset-Impuls kam ja, nur das
  // Zurueckziehen der Leitung scheiterte. "Fehlgeschlagen" waere hier falsch:
  // Die Firmware ist geschrieben.
  assert.equal(erg.ok, true, 'avrdude war erfolgreich');
  // Nicht die Anzahl der Impulse festschreiben — die haengt an der Zahl der
  // Anlaeufe und aendert sich mit ihr. Festgehalten wird die Aussage: Beide
  // Syntaxen werden versucht, bevor aufgegeben wird.
  assert.ok(n >= 2, `v2 und v1 versucht, war: ${n}`);
  const v2 = g.aufrufe.some((a) => a.cmd === 'timeout' && a.args.includes('gpioset'));
  const v1 = g.aufrufe.some(
    (a) => a.cmd === 'gpioset' && a.args.some((x) => x.startsWith('--mode=')),
  );
  assert.ok(v2 || v1, 'mindestens eine der beiden Syntaxen wurde probiert');
  assert.match(erg.log, /pinctrl set 4 ip pu/, 'Ausweg steht im Log');
  assert.match(erg.log, /naechste Flash keine fallende Flanke/,
    'warnt vor der Folge fuers naechste Mal');
  // avrdude laeuft trotzdem — der Reset-Impuls selbst kam ja (nur das
  // Zurueckziehen der Leitung scheiterte), und der Bootloader ist dadurch
  // erreichbar. Der Hinweis betrifft den NAECHSTEN Flash.
  assert.ok(
    g.aufrufe.some((a) => a.cmd === 'avrdude'),
    'der Impuls kam, also wird auch geflasht',
  );

});

test('USB-Flash: kein GPIO — avrdude übernimmt den Reset über DTR', async () => {
  const r = runner([{ code: 0, output: 'avrdude done' }]);
  const erg = await flashFirmware('/tmp/fw.hex', {
    device: '/dev/asksin-usb',
    runCommand: r.run,
  });
  assert.equal(erg.ok, true);
  assert.equal(r.aufrufe.length, 1, 'nur avrdude');
  assert.equal(r.aufrufe[0]!.cmd, 'avrdude');
});

test('avrdude-Fehler: mehrfach wiederholt, dann ok:false — wirft nie', async () => {
  // Jeder Anlauf bekommt einen frischen Reset. Der Grund steht in der
  // Zeitrechnung: urboot lauscht nach dem Reset genau eine Sekunde; trifft
  // avrdude das Fenster nicht, hilft kein Zuwarten, sondern nur ein neuer
  // Reset. Am 14.08.2026 an Analyzer 01 gesehen — erster Flash
  // fehlgeschlagen, zweiter erfolgreich, gleiche Datei, gleiches Geraet.
  const aufrufe: Array<{ cmd: string; args: string[] }> = [];
  const run = (cmd: string, args: string[]): Promise<KommandoErgebnis> => {
    aufrufe.push({ cmd, args });
    return Promise.resolve(
      cmd === 'avrdude'
        ? { code: 1, output: 'urclock_getsync(): not in sync' }
        : { code: 124, output: '' },   // gpioset ueber timeout: 124 = Erfolg
    );
  };
  const erg = await flashFirmware('/tmp/fw.hex', {
    device: '/dev/asksin-hat',
    runCommand: run,
    anlaufMs: 5,
  });
  assert.equal(erg.ok, false);
  assert.match(erg.log, /not in sync/);

  const avrs = aufrufe.filter((a) => a.cmd === 'avrdude');
  assert.equal(avrs.length, 6, 'drei Anlaeufe je Protokoll, zwei Protokolle');
  assert.ok(
    avrs.slice(0, 3).every((a) => a.args.includes('urclock')),
    'urclock zuerst, und zwar mit allen Anlaeufen',
  );
  assert.ok(
    avrs.slice(3).every((a) => a.args.includes('arduino')),
    'erst danach das alte Protokoll',
  );

  // Und vor JEDEM avrdude muss unmittelbar ein Reset stehen — sonst
  // wiederholt sich nur der Fehlschlag, statt ihn zu beheben.
  for (let i = 0; i < aufrufe.length; i++) {
    if (aufrufe[i]!.cmd !== 'avrdude') continue;
    const davor = aufrufe[i - 1]!;
    assert.ok(
      [davor.cmd, ...davor.args].join(' ').includes('4=0'),
      `vor avrdude Nr. ${i} steht kein Reset, sondern: ${davor.cmd}`,
    );
  }
});

test('siehtNachIntelHexAus: echte Struktur ja, Müll nein', () => {
  const gut = Buffer.from(':100000000C9435000C945D000C945D000C945D0024\n:00000001FF\n');
  assert.equal(siehtNachIntelHexAus(gut), true);
  assert.equal(siehtNachIntelHexAus(Buffer.from('MZ\x90\x00binär')), false);
  assert.equal(siehtNachIntelHexAus(Buffer.from(':abc\n')), false, 'zu kurz');
  assert.equal(
    siehtNachIntelHexAus(Buffer.from(':100000000C9435000C945D000C945D000C945D0024\n')),
    false,
    'ohne EOF-Record',
  );
});

// --- Deutung der avrdude-Meldungen ---------------------------------------

test('deuteAvrdude: 0x3a heisst "kein Bootloader", nicht "Uebertragungsfehler"', () => {
  // Die echte Ausgabe vom 10.08.2026, zehnmal wiederholt.
  const echt = Array.from({ length: 10 }, (_, i) =>
    `avrdude warning: attempt ${i + 1} of 10: not in sync: resp=0x3a`,
  ).join('\n');

  const d = deuteAvrdude(echt);
  assert.ok(d !== null, 'diese Meldung darf nicht unkommentiert bleiben');
  assert.match(d, /kein Bootloader/);
  assert.match(d, /Hochladen mit Programmer/, 'nennt die Ursache');
  assert.match(d, /Bootloader brennen/, 'nennt den Ausweg');
});

test('deuteAvrdude: anderes "not in sync" bekommt den allgemeinen Befund', () => {
  const d = deuteAvrdude('avrdude warning: not in sync: resp=0x00');
  assert.ok(d !== null);
  assert.match(d, /antwortet nicht/);
  assert.doesNotMatch(d, /kein Bootloader/,
    'ohne 0x3a laesst sich der fehlende Bootloader nicht behaupten');
});

test('deuteAvrdude: schweigt, wenn es nichts zu deuten gibt', () => {
  assert.equal(deuteAvrdude('avrdude done.  Thank you.'), null);
});

test('deuteAvrdude: 0xa0 heisst "falsches Protokoll", nicht "Uebertragungsfehler"', () => {
  // Die echte Ausgabe vom 10.08.2026, an beiden Analyzern identisch.
  const echt = Array.from({ length: 10 }, (_, i) =>
    `avrdude warning: attempt ${i + 1} of 10: not in sync: resp=0xa0`,
  ).join('\n');

  const d = deuteAvrdude(echt);
  assert.ok(d !== null);
  assert.match(d, /urboot/, 'nennt den tatsaechlichen Bootloader');
  assert.match(d, /urclock/, 'nennt das Protokoll');
  assert.doesNotMatch(d, /kein Bootloader/,
    '0xa0 ist etwas anderes als 0x3a — hier ist einer da, er spricht nur anders');
});

test('der Befund landet im angezeigten Verlauf, nicht nur im Rueckgabewert', async () => {
  // Am 10.08.2026 an Analyzer 05 gesehen: avrdude meldete resp=0x3a, der
  // Analyzer kannte die Deutung — sie stand aber nur im Rueckgabewert. Die
  // Oberflaeche zeigt den mitlaufenden Verlauf, und dort fehlte sie. Der
  // Anwender sah die rohe Meldung und musste selbst wissen, was 0x3a heisst.
  const verlauf: string[] = [];
  await flashFirmware('/tmp/fw.hex', {
    device: '/dev/asksin-hat',
    anlaufMs: 5,
    onFortschritt: (t) => verlauf.push(t),
    runCommand: (cmd) =>
      Promise.resolve(
        cmd === 'avrdude'
          ? { code: 1, output: 'avrdude warning: not in sync: resp=0x3a' }
          : { code: 124, output: '' },
      ),
  });
  const text = verlauf.join('');
  assert.match(text, /kein Bootloader/, 'die Deutung muss im Verlauf stehen');
  assert.match(text, /7\.7/, 'mit Verweis auf die Anleitung');
});

test('deuteAvrdude: unbekannte mcuid nennt BEIDE moeglichen Ursachen', () => {
  // Der Text sagte frueher nur "kein Bootloader" — und schickte damit am
  // 14.08.2026 an Analyzer 01 in die falsche Richtung. Dort war der
  // Bootloader vorhanden; avrdude hatte nur sein Zeitfenster verpasst, und
  // derselbe Flash gelang beim zweiten Anlauf. Eine Diagnose, die eine von
  // zwei Ursachen als die einzige ausgibt, ist schlimmer als keine.
  const d = deuteAvrdude('avrdude warning: uP_table does not know mcuid 562');
  assert.ok(d !== null);
  assert.match(d, /Zeitfenster|eine Sekunde/, 'nennt das verpasste Fenster');
  assert.match(d, /sporadisch/, 'sagt, woran man die Ursachen unterscheidet');
  assert.match(d, /bootloader-brennen\.sh/, 'und den Weg fuer den anderen Fall');
});
