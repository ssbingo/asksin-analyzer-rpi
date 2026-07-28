/**
 * Produktions-Portöffner — ohne native Abhängigkeit.
 *
 * Der Sniffer sendet nur; der Core schreibt nie auf die Schnittstelle. Ein
 * lesender Dateistrom auf das Gerät genügt also — konfiguriert wird der Port
 * vorher einmalig mit `stty`. Das erspart die native `serialport`-Abhängigkeit
 * samt Prebuilds für jede Pi-Architektur, und `stty` beherrscht auf Linux
 * auch die krumme Rate **58824** (über die BOTHER-Schnittstelle des Kernels;
 * Begründung der Rate: hardware/README.md, Abschnitt 2.5).
 *
 * Nur Linux. Auf dem Zielsystem zeigt die udev-Regel
 * `99-asksin-analyzer.rules` mit `/dev/asksin-hat` fest auf den Port.
 */

import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { promisify } from 'node:util';

import type { IngestStream, PortOpener } from './ingest.ts';

const execFileAsync = promisify(execFile);

export const DEFAULT_DEVICE = '/dev/asksin-hat';
/** Nicht 57600 — der 8-MHz-Sniffer sendet real mit 58823,5 Baud. */
export const DEFAULT_BAUD = 58_824;

/**
 * stty-Argumente als reine Funktion — der einzige Teil, der sich ohne
 * Hardware testen lässt, also herausgezogen.
 */
export function buildSttyArgs(device: string, baud: number): string[] {
  return [
    '-F', device,
    String(baud),
    'raw',        // keine Zeilenpufferung/Umwandlung durch den Treiber
    '-echo',      // nichts zurückspiegeln
    'cs8', '-cstopb', '-parenb',   // 8N1
    '-crtscts', '-ixon', '-ixoff', // keinerlei Flusskontrolle
    'cread', 'clocal',             // lesen, Modemleitungen ignorieren
  ];
}

/** Öffnet den seriellen Port lesend; als `openPort` in den Ingest stecken. */
export function sttyPortOpener(
  device: string = DEFAULT_DEVICE,
  baud: number = DEFAULT_BAUD,
): PortOpener {
  return async (signal): Promise<IngestStream> => {
    await execFileAsync('stty', buildSttyArgs(device, baud), { signal });
    const stream = createReadStream(device, { highWaterMark: 4096 });
    return {
      readable: stream,
      close: () =>
        new Promise<void>((resolve) => {
          stream.once('close', () => resolve());
          stream.destroy();
        }),
    };
  };
}
