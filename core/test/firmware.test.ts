import { test } from 'node:test';
import assert from 'node:assert/strict';

import { flashFirmware, siehtNachIntelHexAus } from '../src/update/firmware.ts';
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

test('HAT-Flash: GPIO4-Reset (v2-Syntax), dann avrdude mit 58824 Baud', async () => {
  const r = runner([
    { code: 124, output: '' },              // timeout beendet gpioset → Erfolg
    { code: 0, output: 'avrdude done' },
  ]);
  const erg = await flashFirmware('/tmp/fw.hex', {
    device: '/dev/asksin-hat',
    runCommand: r.run,
  });
  assert.equal(erg.ok, true);
  assert.equal(r.aufrufe.length, 2);
  assert.deepEqual(r.aufrufe[0], {
    cmd: 'timeout',
    args: ['0.3', 'gpioset', '-c', 'gpiochip0', '4=0'],
  });
  const avr = r.aufrufe[1]!;
  assert.equal(avr.cmd, 'avrdude');
  assert.ok(avr.args.includes('-b') && avr.args.includes('58824'), 'krumme Baudrate');
  assert.ok(avr.args.includes('/dev/asksin-hat'));
  assert.ok(avr.args.includes('flash:w:/tmp/fw.hex:i'));
});

test('HAT-Flash: fällt auf gpioset-v1-Syntax zurück', async () => {
  const r = runner([
    { code: 1, output: 'unbekannte Option -c' },   // v2 scheitert
    { code: 0, output: '' },                        // v1 klappt
    { code: 0, output: 'avrdude done' },
  ]);
  const erg = await flashFirmware('/tmp/fw.hex', {
    device: '/dev/asksin-hat',
    runCommand: r.run,
  });
  assert.equal(erg.ok, true);
  assert.deepEqual(r.aufrufe[1], {
    cmd: 'gpioset',
    args: ['--mode=time', '--usec=300000', 'gpiochip0', '4=0'],
  });
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
    { code: 124, output: '' },
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
