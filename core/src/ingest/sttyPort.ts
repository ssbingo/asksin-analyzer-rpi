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

import { execFile, spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
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
  // Die hohen Raten kamen mit dem Zigbee-Mithörer dazu (1 MBaud). Sie sind
  // Kernkonstanten (B500000 … B1152000 in <asm-generic/termbits.h>), stty
  // nimmt sie also entgegen — damit braucht dieser Pfad den Umweg über
  // deploy/baudrate.py nicht. Nachgerechnet: Für die 58 824 des Sniffers
  // bleibt die nächstliegende Rate unverändert 57 600.
  500_000, 576_000, 921_600, 1_000_000, 1_152_000,
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
 * Wie lange nach SIGTERM auf das Ende des Lesers gewartet wird, bevor
 * SIGKILL nachgeschoben wird.
 */
const HARTES_ENDE_MS = 500;

/** Das Noetigste eines Streams, das hier gebraucht wird — haelt den Test klein. */
export interface Schliessbar {
  once(ereignis: 'close', hoerer: () => void): unknown;
  destroy(): unknown;
}

/**
 * Liest das Geraet ueber einen **Kindprozess**, nicht ueber einen Dateistrom.
 *
 * Das ist der Kern der Sache, und er hat drei Anlaeufe gebraucht.
 *
 * `fs.createReadStream` auf einer seriellen Schnittstelle laesst sich nicht
 * unterbrechen: Der `read()` haengt im Thread-Pool von libuv, `destroy()`
 * weckt ihn nicht, und kein Abbruchsignal erreicht ihn. Solange keine Zeichen
 * kommen — an einer stillen Leitung der Normalfall — bleibt er dort liegen.
 * Daraus folgte am 10.08.2026 alles auf einmal:
 *
 *   - Der Firmware-Flash blieb nach "Ingest wird angehalten" stehen, weil
 *     close() auf ein `close`-Ereignis wartete, das nie kam.
 *   - Nach der Zeitgrenze dort lief die Leseschleife trotzdem weiter, weil
 *     ein `for await` ueber den Strom erst mit dem Strom endet.
 *   - Nach der Zeitgrenze auch dort blieb der Lesestrom als Leiche liegen und
 *     hielt den Dateideskriptor. Der Dienst liess sich nicht mehr neu starten,
 *     und avrdude bekam "resp=0xa0" — die Leiche schnappte ihm die Antwort
 *     des Bootloaders weg.
 *
 * Jedes Mal habe ich ein Symptom behoben und das naechste freigelegt. Der
 * Fehler war, den blockierenden read() ueberhaupt in den eigenen Prozess zu
 * holen.
 *
 * Ein Kindprozess loest das an der Wurzel: Seine Standardausgabe ist eine
 * **Pipe**, und Pipes sind vollstaendig asynchron. Beendet man den Prozess,
 * raeumt das Betriebssystem den haengenden read() und den Dateideskriptor auf
 * — nicht wir. Es gibt nichts, worauf man vergeblich warten koennte.
 *
 * `cat` ist dafuer das richtige Werkzeug: kein Zwischenpuffer, es schreibt
 * jeden gelesenen Block sofort weiter. Genau so sind an diesen Geraeten alle
 * erfolgreichen Handmessungen gelaufen.
 */
export function leserProzess(device: string): {
  readable: AsyncIterable<Uint8Array>;
  close: () => Promise<void>;
} {
  const kind = spawn('cat', [device], { stdio: ['ignore', 'pipe', 'ignore'] });
  // Ohne Zuhoerer beendet ein Fehler auf dem Strom den ganzen Prozess.
  kind.stdout.on('error', () => {});
  kind.on('error', () => {});

  return {
    // stdout ohne Kodierung liefert Buffer, und Buffer IST ein Uint8Array.
    // Die Zusicherung haelt den Vertrag des IngestStream eng: Bytes, keine
    // Zeichenketten — sonst zerlegte der LineSplitter Mehrbytezeichen falsch.
    readable: kind.stdout as AsyncIterable<Uint8Array>,
    close: () =>
      new Promise<void>((auf) => {
        if (kind.exitCode !== null || kind.signalCode !== null) {
          auf();
          return;
        }
        const hart = setTimeout(() => kind.kill('SIGKILL'), HARTES_ENDE_MS);
        hart.unref?.();
        kind.once('close', () => {
          clearTimeout(hart);
          auf();
        });
        kind.kill('SIGTERM');
      }),
  };
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

    const leser = leserProzess(device);

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
      readable: leser.readable,
      close: async () => {
        schreiber?.destroy();
        await leser.close();
      },
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
