/**
 * 328P-Firmware-Flash (M7.5) — Ablauf laut docs/webui-und-updates.md §3:
 *
 *   Ingest anhalten (macht der Aufrufer) → Reset auslösen → avrdude → fertig.
 *
 * Zwei Anbindungswege:
 *  - **HAT** (GPIO-Header): der Optiboot-Bootloader wartet nur ~1 s nach dem
 *    Reset — der Core muss GPIO4 selbst takten (300 ms LOW, dann wieder HIGH,
 *    libgpiod). gpioset v2 und v1 haben inkompatible Syntax; v2 zuerst.
 *
 *    Das Zurueckziehen auf HIGH ist kein Schoenheitsschritt. libgpiod gibt
 *    beim Beenden zwar die Anforderung frei, laesst Richtung und Pegel der
 *    Leitung aber stehen: Sie bleibt Ausgang und bleibt LOW.
 *
 *    Entscheidend ist dabei, wie der Reset verdrahtet ist: GPIO4 haengt ueber
 *    C8 (100 n) am RESET, dahinter zieht R2 (10 k) nach +3V3 (netlist.md,
 *    Netze `PI_RESET_DRV` und `RESET`). Der Reset entsteht also an der
 *    **fallenden Flanke**, nicht am Pegel — nach rund einer Millisekunde
 *    laeuft der 328P wieder. Eine liegengebliebene LOW-Leitung haelt ihn
 *    deshalb *nicht* im Reset.
 *
 *    Sie nimmt aber dem naechsten Aufruf die Flanke. Der erste Flash nach dem
 *    Systemstart gelingt, jeder weitere nicht: kein Pegelwechsel, kein Reset,
 *    der Bootloader startet nie, avrdude laeuft in `not in sync`. Ein Fehler,
 *    der beim ersten Ausprobieren nicht auffaellt — und danach immer.
 *
 *    (Gefunden am 07.08.2026 beim Nachmessen an Analyzer 05. Der erste Test
 *    hier verglich nur die Argumente, die wir bauen, nicht ihre Wirkung —
 *    derselbe Fehler wie seinerzeit bei stty. Der Test unten flasht deshalb
 *    zweimal hintereinander; genau daran faellt der alte Stand.)
 *  - **USB** (CP2102N): avrdude zieht die DTR-Leitung selbst, kein GPIO nötig.
 *
 * Baudrate 58 824, nicht 57 600 — der 8-MHz-Bootloader spricht real 58 823,5
 * (hardware/README.md, Abschnitt 2.5). Alle Kommandos laufen über einen
 * injizierbaren Runner, damit die Sequenz ohne Hardware testbar ist.
 */

import { execFile } from 'node:child_process';

export interface KommandoErgebnis {
  code: number;
  output: string;
}

export type KommandoRunner = (
  cmd: string,
  args: string[],
) => Promise<KommandoErgebnis>;

export const standardRunner: KommandoRunner = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: 120_000 }, (err, stdout, stderr) => {
      const code =
        err === null ? 0 : typeof err.code === 'number' ? err.code : 1;
      resolve({ code, output: `${stdout}${stderr}` });
    });
  });

export interface FlashOptions {
  /** Serielles Gerät, z. B. /dev/asksin-hat. */
  device: string;
  /** Reset-Weg; `auto` entscheidet am Gerätepfad (usb → dtr, sonst gpio). */
  reset?: 'gpio' | 'dtr' | 'auto';
  baud?: number;
  gpioChip?: string;
  gpioLine?: number;
  resetMs?: number;
  runCommand?: KommandoRunner;
}

export interface FlashErgebnis {
  ok: boolean;
  log: string;
}

/**
 * Wie lange die Leitung nach dem Impuls aktiv auf HIGH gehalten wird. Danach
 * endet `gpioset` und laesst sie auf diesem Pegel stehen — der 328P laeuft.
 * Kurz genug, dass avrdude noch in Optiboots ~1-s-Fenster kommt.
 */
const FREIGABE_MS = 100;

/**
 * Setzt eine GPIO-Leitung auf `wert` und haelt sie `ms` lang. Danach bleibt
 * sie auf diesem Pegel stehen — das ist das Verhalten von libgpiod, und genau
 * darauf bauen beide Aufrufe im Reset auf.
 *
 * `timeout` beendet `gpioset` mit 124; das ist hier der ERFOLGSFALL. Nur ein
 * anderer Code deutet auf eine unbekannte Syntax, dann kommt v1 zum Zug.
 */
async function gpioHalten(
  run: KommandoRunner,
  chip: string,
  line: number,
  wert: 0 | 1,
  ms: number,
  log: string[],
): Promise<boolean> {
  const sekunden = (ms / 1000).toFixed(1);
  log.push(`GPIO${line} → ${wert === 0 ? 'LOW' : 'HIGH'} (${ms} ms)`);
  const v2 = await run('timeout', [
    sekunden, 'gpioset', '-c', chip, `${line}=${wert}`,
  ]);
  if (v2.code === 0 || v2.code === 124) return true;

  log.push('gpioset v2 nicht verfügbar, versuche v1-Syntax');
  const v1 = await run('gpioset', [
    '--mode=time', `--usec=${ms * 1000}`, chip, `${line}=${wert}`,
  ]);
  if (v1.code === 0) return true;
  log.push(v1.output.trim());
  return false;
}

/** Flasht die HEX-Datei; wirft nie — Fehler stehen in `ok`/`log`. */
export async function flashFirmware(
  hexPfad: string,
  options: FlashOptions,
): Promise<FlashErgebnis> {
  const run = options.runCommand ?? standardRunner;
  const baud = options.baud ?? 58_824;
  const chip = options.gpioChip ?? 'gpiochip0';
  const line = options.gpioLine ?? 4;
  const resetMs = options.resetMs ?? 300;
  const reset =
    options.reset === undefined || options.reset === 'auto'
      ? options.device.includes('usb')
        ? 'dtr'
        : 'gpio'
      : options.reset;

  const log: string[] = [];

  if (reset === 'gpio') {
    const tief = await gpioHalten(run, chip, line, 0, resetMs, log);
    if (!tief) {
      return { ok: false, log: log.join('\n') + '\nGPIO-Reset fehlgeschlagen' };
    }
    // Ohne diesen zweiten Schritt endet der Impuls nie — siehe Kopf der Datei.
    const hoch = await gpioHalten(run, chip, line, 1, FREIGABE_MS, log);
    if (!hoch) {
      return {
        ok: false,
        log:
          log.join('\n') +
          `\nGPIO${line} liess sich nicht auf HIGH zuruecksetzen. Der 328P ` +
          `laeuft (der Reset kam an der Flanke), aber der naechste Flash ` +
          `findet keine fallende Flanke mehr und wuerde scheitern. ` +
          `Von Hand loesen: sudo pinctrl set ${line} ip pu`,
      };
    }
  } else {
    log.push('Reset über DTR (übernimmt avrdude am USB-Port)');
  }

  log.push(`avrdude auf ${options.device} mit ${baud} Baud`);
  const avr = await run('avrdude', [
    '-c', 'arduino',
    '-p', 'm328p',
    '-P', options.device,
    '-b', String(baud),
    '-D',
    '-U', `flash:w:${hexPfad}:i`,
  ]);
  log.push(avr.output.trim());
  return { ok: avr.code === 0, log: log.join('\n') };
}

/** Grobe Plausibilität: sieht der Upload nach Intel-HEX aus? */
export function siehtNachIntelHexAus(inhalt: Buffer): boolean {
  const text = inhalt.toString('latin1');
  if (!text.startsWith(':')) return false;
  const zeilen = text.split(/\r?\n/).filter((z) => z.length > 0);
  return (
    zeilen.length > 0 &&
    zeilen.every((z) => /^:[0-9A-Fa-f]{10,}$/.test(z)) &&
    zeilen.at(-1) === ':00000001FF'
  );
}
