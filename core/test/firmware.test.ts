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
      const erreichbar = flankeSeitFlash;
      flankeSeitFlash = false;
      return Promise.resolve(
        erreichbar
          ? { code: 0, output: 'avrdude done' }
          : { code: 1, output: 'stk500_getsync(): not in sync: resp=0x00' },
      );
    }
    return Promise.resolve({ code: 0, output: '' });
  };
  return { leitung, aufrufe, run };
}

test('HAT-Flash: zweimal hintereinander — jeder Reset braucht eine eigene Flanke', async () => {
  const g = gpioModell();
  const opts = { device: '/dev/asksin-hat', runCommand: g.run };

  const erste = await flashFirmware('/tmp/fw.hex', opts);
  assert.equal(erste.ok, true, erste.log);

  // Hier faellt der alte Stand: Er liess GPIO4 auf LOW liegen, also gab es
  // beim zweiten Aufruf keinen Pegelwechsel mehr — kein Reset, kein
  // Bootloader, "not in sync". Beim ersten Ausprobieren faellt das nie auf.
  const zweite = await flashFirmware('/tmp/fw.hex', opts);
  assert.equal(zweite.ok, true, zweite.log);
  assert.equal(g.leitung.pegel, 1, 'GPIO4 muss am Ende wieder HIGH sein');

  const namen = g.aufrufe.map((a) => `${a.cmd} ${a.args.join(' ')}`);
  const tief = namen.findIndex((z) => z.includes('4=0'));
  const hoch = namen.findIndex((z) => z.includes('4=1'));
  const avr = namen.findIndex((z) => z.startsWith('avrdude'));
  assert.ok(tief >= 0 && hoch > tief, 'erst LOW, dann HIGH');
  assert.ok(avr > hoch, 'avrdude erst nach dem vollständigen Impuls');

  const avrArgs = g.aufrufe[avr]!.args;
  assert.ok(avrArgs.includes('-b') && avrArgs.includes('58824'), 'krumme Baudrate');
  assert.ok(avrArgs.includes('/dev/asksin-hat'));
  assert.ok(avrArgs.includes('flash:w:/tmp/fw.hex:i'));
});

test('HAT-Flash: fällt auf gpioset-v1-Syntax zurück, auch beim Freigeben', async () => {
  const g = gpioModell('v1');
  const opts = { device: '/dev/asksin-hat', runCommand: g.run };
  assert.equal((await flashFirmware('/tmp/fw.hex', opts)).ok, true);
  assert.equal((await flashFirmware('/tmp/fw.hex', opts)).ok, true, 'auch v1 gibt frei');
  assert.equal(g.leitung.pegel, 1);
  assert.ok(
    g.aufrufe.some(
      (a) => a.cmd === 'gpioset' && a.args.join(' ') === '--mode=time --usec=300000 gpiochip0 4=0',
    ),
    'v1-Impuls mit 300 ms',
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
  });
  assert.equal(erg.ok, false);
  assert.equal(n, 2, 'v2 und v1 versucht');
  assert.match(erg.log, /pinctrl set 4 ip pu/, 'Ausweg steht im Log');
  assert.match(erg.log, /keine fallende Flanke/, 'nennt die Folge, nicht einen Dauerreset');
  assert.ok(
    !g.aufrufe.some((a) => a.cmd === 'avrdude'),
    'kein avrdude, wenn die Leitung nicht in einen sauberen Zustand kam',
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

test('avrdude-Fehler wird als ok:false mit Log gemeldet, wirft nie', async () => {
  const r = runner([
    { code: 124, output: '' },   // Reset-Impuls LOW
    { code: 124, output: '' },   // Leitung wieder HIGH
    { code: 1, output: 'stk500_getsync(): not in sync' },
  ]);
  const erg = await flashFirmware('/tmp/fw.hex', {
    device: '/dev/asksin-hat',
    runCommand: r.run,
  });
  assert.equal(erg.ok, false);
  assert.match(erg.log, /not in sync/);
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
