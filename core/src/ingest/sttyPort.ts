/**
 * Produktions-Portöffner — ohne native Abhängigkeit.
 *
 * Gelesen wird über einen Dateistrom auf das Gerät; konfiguriert wird der Port
 * vorher einmalig mit `stty`.
 *
 * Seit der erweiterten Firmware wird auch **geschrieben** — zwei kurze Befehle
 * beim Verbindungsaufbau (`:?;`, `:E1;`). Dafür wird die Datei zusätzlich
 * schreibend geöffnet. Der Analyzer sendet nichts über die Funkstrecke; die
 * Befehle gehen an den Mikrocontroller, nicht ins 868-MHz-Band. Das erspart die native `serialport`-Abhängigkeit
 * samt Prebuilds für jede Pi-Architektur, und `stty` beherrscht auf Linux
 * auch die krumme Rate **58824** (über die BOTHER-Schnittstelle des Kernels;
 * Begründung der Rate: hardware/README.md, Abschnitt 2.5).
 *
 * Nur Linux. Auf dem Zielsystem zeigt die udev-Regel
 * `99-asksin-analyzer.rules` mit `/dev/asksin-hat` fest auf den Port.
 */

import { execFile } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import type { IngestStream, PortOpener } from './ingest.ts';

const execFileAsync = promisify(execFile);

export const DEFAULT_DEVICE = '/dev/asksin-hat';
/** Nicht 57600 — der 8-MHz-Sniffer sendet real mit 58823,5 Baud. */
export const DEFAULT_BAUD = 58_824;

/**
 * Genormte Baudraten, die `stty` kennt.
 *
 * `stty` beherrscht **ausschliesslich** diese Werte. Unsere 58 824 sind
 * keiner davon, und stty lehnt sie rundheraus ab:
 *
 *     stty: ungültiges Argument ‘58824’
 *
 * Deshalb bekommt stty die nächstliegende genormte Rate für die Rahmen- und
 * Flusseinstellungen, und die exakte Rate setzt anschliessend
 * `deploy/baudrate.py` über termios2/BOTHER — das kann der Kern, nur stty
 * reicht es nicht durch.
 */
const GENORMTE_RATEN = [
  1200, 1800, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800,
] as const;

/** Die genormte Rate, die der gewünschten am nächsten kommt. */
export function naechsteGenormteRate(baud: number): number {
  let beste = GENORMTE_RATEN[0] as number;
  for (const r of GENORMTE_RATEN) {
    if (Math.abs(r - baud) < Math.abs(beste - baud)) beste = r;
  }
  return beste;
}

/**
 * Pfad des Helfers, der die krumme Rate setzt.
 *
 * Liegt neben dem Core im ausgecheckten Baum: core/src/ingest → ../../../deploy
 */
export const BAUDRATE_HELFER = fileURLToPath(
  new URL('../../../deploy/baudrate.py', import.meta.url),
);

/**
 * stty-Argumente als reine Funktion — der einzige Teil, der sich ohne
 * Hardware testen lässt, also herausgezogen.
 *
 * ACHTUNG: Hier steht die **genormte** Rate. Die exakte kommt danach über
 * den Helfer. Wer hier die krumme einträgt, bekommt von stty eine Absage
 * und damit gar keine Verbindung.
 */
export function buildSttyArgs(device: string, baud: number): string[] {
  return [
    '-F', device,
    String(naechsteGenormteRate(baud)),
    'raw',        // keine Zeilenpufferung/Umwandlung durch den Treiber
    '-echo',      // nichts zurückspiegeln
    'cs8', '-cstopb', '-parenb',   // 8N1
    '-crtscts', '-ixon', '-ixoff', // keinerlei Flusskontrolle
    'cread', 'clocal',             // lesen, Modemleitungen ignorieren
  ];
}

/**
 * Wie lange auf das `close`-Ereignis gewartet wird, bevor aufgegeben wird.
 *
 * Zwei Sekunden sind gegenüber einem regulären Schließen (Millisekunden) um
 * Größenordnungen großzügig und kurz genug, dass kein Firmware-Flash daran
 * hängenbleibt.
 */
export const SCHLIESS_GRENZE_MS = 2000;

/** Das Nötigste eines Streams, das hier gebraucht wird — hält den Test klein. */
export interface Schliessbar {
  once(ereignis: 'close', hoerer: () => void): unknown;
  destroy(): unknown;
}

/**
 * Schließt Lese- und Schreibstrom und **gibt spätestens nach `grenzeMs` auf**.
 *
 * Die Zeitgrenze ist der eigentliche Inhalt dieser Funktion.
 *
 * `destroy()` beendet einen Lesestrom nicht, solange im Thread-Pool noch ein
 * blockierendes `read()` auf dem Gerät hängt — und das ist an einer seriellen
 * Schnittstelle der Normalfall, sobald gerade nichts gesendet wird. Das
 * `close`-Ereignis kommt dann nie. Wer darauf wartet, wartet für immer.
 *
 * Am 10.08.2026 an zwei Analyzern beobachtet: Der Firmware-Flash legte den
 * Dienst lahm. Im Journal stand „Ingest wird angehalten", danach nichts mehr —
 * weder Erfolg noch Fehlschlag. Die Oberfläche zeigte stundenlang „Flashe …",
 * weil der HTTP-Aufruf nie zurückkam. Zum Flashen selbst kam es nie.
 *
 * Der Dateideskriptor wird vom Betriebssystem freigegeben, sobald der hängende
 * `read()` zurückkehrt; das Aufgeben hier hinterlässt also nichts Offenes.
 */
export function schliesseStrom(
  lesend: Schliessbar,
  schreibend: Schliessbar | null,
  grenzeMs: number = SCHLIESS_GRENZE_MS,
): Promise<void> {
  return new Promise<void>((resolve) => {
    let fertig = false;
    const einmal = (): void => {
      if (fertig) return;
      fertig = true;
      clearTimeout(uhr);
      resolve();
    };
    const uhr = setTimeout(einmal, grenzeMs);
    uhr.unref?.();
    schreibend?.destroy();
    lesend.once('close', einmal);
    lesend.destroy();
  });
}

/** Öffnet den seriellen Port lesend; als `openPort` in den Ingest stecken. */
export function sttyPortOpener(
  device: string = DEFAULT_DEVICE,
  baud: number = DEFAULT_BAUD,
  onWarnung?: (text: string) => void,
): PortOpener {
  return async (signal): Promise<IngestStream> => {
    await execFileAsync('stty', buildSttyArgs(device, baud), { signal });

    // Jetzt die exakte Rate — NACH stty, sonst überschreibt stty sie wieder.
    //
    // Scheitert der Helfer, bleibt es bei der genormten Rate von oben. Das
    // sind 2,1 % daneben und damit hart an der Toleranzgrenze einer UART:
    // Es läuft oft, aber nicht verlässlich. Deshalb eine deutliche Meldung
    // statt stillen Weitermachens — sonst sucht man später Funkstörungen,
    // wo eine Zeile Einrichtung fehlt.
    if (naechsteGenormteRate(baud) !== baud) {
      try {
        await execFileAsync('python3', [BAUDRATE_HELFER, device, String(baud)], {
          signal,
        });
      } catch (fehler) {
        onWarnung?.(
          `Baudrate ${baud} liess sich nicht exakt einstellen (${String(fehler)}). ` +
            `Es bleibt bei ${naechsteGenormteRate(baud)} — das sind ` +
            `${(Math.abs(baud - naechsteGenormteRate(baud)) / baud * 100).toFixed(1)} % ` +
            'Abweichung, und damit sind Zeichenfehler wahrscheinlich.',
        );
      }
    }

    const stream = createReadStream(device, { highWaterMark: 4096 });

    // Getrennter Schreibstrom auf dasselbe Gerät. Scheitert das Öffnen —
    // etwa weil die Rechte nur zum Lesen reichen —, bleibt es beim Lesen:
    // Der Empfang ist die Hauptsache, die Freischaltung nur eine Zugabe.
    let schreiber: ReturnType<typeof createWriteStream> | null = null;
    try {
      schreiber = createWriteStream(device);
      // Ein Fehler auf einem Stream ohne Zuhörer beendet den Prozess.
      schreiber.on('error', () => {});
    } catch {
      schreiber = null;
    }

    const strom: IngestStream = {
      readable: stream,
      close: () => schliesseStrom(stream, schreiber),
    };
    if (schreiber !== null) {
      const s = schreiber;
      strom.schreibe = (text: string) =>
        new Promise<void>((resolve) => {
          // Fehler werden verschluckt: Die alte Firmware nimmt nichts
          // entgegen, und daraus darf kein Störungsbild werden.
          s.write(`${text}\r\n`, () => resolve());
        });
    }
    return strom;
  };
}
