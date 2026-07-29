/**
 * 328P-Firmware-Flash (M7.5) — Ablauf laut docs/webui-und-updates.md §3:
 *
 *   Ingest anhalten (macht der Aufrufer) → Reset auslösen → avrdude → fertig.
 *
 * Zwei Anbindungswege:
 *  - **HAT** (GPIO-Header): der Optiboot-Bootloader wartet nur ~1 s nach dem
 *    Reset — der Core muss GPIO4 selbst takten (300 ms LOW, libgpiod).
 *    gpioset v2 und v1 haben inkompatible Syntax; v2 wird zuerst versucht.
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
    // libgpiod v2: `timeout <s> gpioset -c <chip> <line>=0` hält die Leitung,
    // bis timeout den Prozess beendet. v1: --mode=time --usec=…
    const sekunden = (resetMs / 1000).toFixed(1);
    log.push(`Reset über GPIO${line} (${resetMs} ms LOW)`);
    const v2 = await run('timeout', [
      sekunden, 'gpioset', '-c', chip, `${line}=0`,
    ]);
    // timeout beendet gpioset mit 124 — das ist hier der ERFOLGSFALL.
    if (v2.code !== 0 && v2.code !== 124) {
      log.push('gpioset v2 nicht verfügbar, versuche v1-Syntax');
      const v1 = await run('gpioset', [
        '--mode=time', `--usec=${resetMs * 1000}`, chip, `${line}=0`,
      ]);
      if (v1.code !== 0) {
        log.push(v1.output.trim());
        return { ok: false, log: log.join('\n') + '\nGPIO-Reset fehlgeschlagen' };
      }
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
