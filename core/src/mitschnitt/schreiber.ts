/**
 * Mitschnitt: schreibt den rohen Zeilenstrom des Sniffers mit Zeitstempeln weg.
 *
 * Wozu
 * ----
 * Bevor an der Firmware etwas geändert wird, muss festgehalten sein, wie sie
 * sich **jetzt** verhält. Sonst lässt sich hinterher nicht belegen, dass eine
 * Änderung die Wirkung hatte, die wir ihr zuschreiben — man vergliche eine
 * Messung mit einer Erinnerung.
 *
 * Aufgezeichnet wird die Zeile **vor** dem Parsen. Gerade das, was der Parser
 * später wegwirft, ist hier interessant: Boot-Meldungen, abgeschnittene
 * Zeilen, Zeichensalat. Genau diese Fälle sollen die Verbesserungen
 * adressieren, und ohne Beleg wüsste niemand, wie häufig sie wirklich sind.
 *
 * Format
 * ------
 * Zeilenweise Text, damit `grep`, `wc` und `tail` funktionieren:
 *
 *     # asksin-mitschnitt 1
 *     # begonnen 2026-08-03T09:12:00.000Z
 *     # geraet /dev/ttyAMA0 baud 58824
 *     1754212320123\t:5A;
 *     1754212320873\t:5A;
 *
 * Zeitstempel in Millisekunden seit Epoch, Tabulator, Rohzeile. Kein JSON,
 * kein Binärformat: Ein Mitschnitt, den man nur mit dem eigenen Werkzeug lesen
 * kann, ist in fünf Jahren wertlos.
 *
 * Warum gepuffert
 * ---------------
 * Der Sniffer liefert dauerhaft mindestens 80 Zeilen je Minute (Rauschen alle
 * 750 ms), bei Funkverkehr deutlich mehr. Ein `write()` je Zeile hieße ebenso
 * viele Systemaufrufe — auf einem Pi mit SD-Karte ist das spürbar. Deshalb
 * sammelt der Schreiber und gibt gebündelt ab.
 *
 * Der Puffer ist begrenzt. Läuft er über, weil die Platte klemmt, werden
 * **die ältesten Zeilen verworfen und gezählt** — nicht die neuesten. Ein
 * Mitschnitt mit einer ehrlich ausgewiesenen Lücke ist brauchbar; einer, der
 * unbemerkt hinter der Wirklichkeit zurückbleibt, ist irreführend.
 */

import { appendFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

export interface MitschnittOptions {
  /** Zieldatei. Verzeichnisse werden angelegt. */
  pfad: string;
  /** Kopfzeilen-Angaben, rein dokumentarisch. */
  geraet?: string;
  baud?: number;
  /** Wie viele Zeilen gesammelt werden, bevor geschrieben wird. Vorgabe 200. */
  bündelGroesse?: number;
  /** Spätestens nach so vielen ms wird geschrieben. Vorgabe 5 s. */
  spuelIntervallMs?: number;
  /** Obergrenze des Puffers in Zeilen. Vorgabe 20 000. */
  pufferGrenze?: number;
  /**
   * Obergrenze der Datei in Byte. Ist sie erreicht, hört der Mitschnitt auf
   * zu wachsen und zählt weiter — er rotiert **nicht**.
   *
   * Rotation wäre hier die falsche Freundlichkeit: Ein Mitschnitt, der still
   * seinen Anfang wegwirft, verliert genau den Teil, der die Grundlinie
   * ausmacht. Lieber ein sauber begrenzter Ausschnitt mit bekannter Kante.
   * Vorgabe: 256 MiB (bei ~30 Byte je Zeile rund zwei Monate Dauerbetrieb).
   */
  maxBytes?: number;
  /** Uhr — für Tests. */
  jetzt?: () => number;
  /** Schreibfehler; wird höchstens einmal je Fehlerart gemeldet. */
  onFehler?: (fehler: unknown) => void;
}

export interface MitschnittStats {
  /** Zeilen, die tatsächlich in der Datei gelandet sind. */
  geschrieben: number;
  /** Zeilen, die der Puffer bei Überlauf verworfen hat. */
  verworfen: number;
  /** Zeilen, die nach Erreichen von maxBytes nicht mehr aufgenommen wurden. */
  abgeschnitten: number;
  /** Schreibfehler seit dem Start. */
  fehler: number;
  bytes: number;
  seit: number;
  offen: boolean;
}

export const MITSCHNITT_FORMAT = 1;
const VORGABE_MAX_BYTES = 256 * 1024 * 1024;

export class MitschnittSchreiber {
  readonly #opts: MitschnittOptions;
  readonly #jetzt: () => number;
  readonly #bündel: number;
  readonly #intervall: number;
  readonly #grenze: number;
  readonly #maxBytes: number;

  #puffer: string[] = [];
  #geschrieben = 0;
  #verworfen = 0;
  #abgeschnitten = 0;
  #fehler = 0;
  #fehlerGemeldet = new Set<string>();
  #bytes = 0;
  #seit: number;
  #offen = true;
  #letztesSpuelen: number;
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: MitschnittOptions) {
    this.#opts = options;
    this.#jetzt = options.jetzt ?? (() => Date.now());
    this.#bündel = options.bündelGroesse ?? 200;
    this.#intervall = options.spuelIntervallMs ?? 5000;
    this.#grenze = options.pufferGrenze ?? 20_000;
    this.#maxBytes = options.maxBytes ?? VORGABE_MAX_BYTES;
    this.#seit = this.#jetzt();
    this.#letztesSpuelen = this.#seit;

    mkdirSync(dirname(options.pfad), { recursive: true });

    // Vorhandene Datei fortschreiben statt überschreiben: Ein Neustart des
    // Dienstes mitten in der Aufzeichnung soll die Grundlinie nicht löschen.
    try {
      this.#bytes = statSync(options.pfad).size;
    } catch {
      this.#bytes = 0;
    }

    if (this.#bytes === 0) {
      const kopf = [
        `# asksin-mitschnitt ${MITSCHNITT_FORMAT}`,
        `# begonnen ${new Date(this.#seit).toISOString()}`,
        `# geraet ${options.geraet ?? 'unbekannt'} baud ${options.baud ?? 0}`,
        '',
      ].join('\n');
      this.#schreibeDirekt(kopf);
    }

    // unref(): Ein laufender Mitschnitt darf den Prozess nicht am Beenden
    // hindern. stop() spült ohnehin.
    this.#timer = setInterval(() => this.spuelen(), this.#intervall);
    this.#timer.unref?.();
  }

  /** Nimmt eine Rohzeile auf. Synchron, schnell, wirft nie. */
  zeile(roh: string, ts: number): void {
    if (!this.#offen) return;
    if (this.#bytes >= this.#maxBytes) {
      this.#abgeschnitten++;
      return;
    }
    if (this.#puffer.length >= this.#grenze) {
      // Ältestes weg — siehe Kopfkommentar. Ein Viertel auf einmal, damit
      // nicht bei jeder weiteren Zeile erneut umkopiert wird.
      const weg = Math.max(1, Math.floor(this.#grenze / 4));
      this.#puffer.splice(0, weg);
      this.#verworfen += weg;
    }
    this.#puffer.push(`${ts}\t${roh}`);
    if (this.#puffer.length >= this.#bündel) this.spuelen();
  }

  /** Schreibt den Puffer weg. Wird auch vom Takt gerufen. */
  spuelen(): void {
    if (this.#puffer.length === 0) {
      this.#letztesSpuelen = this.#jetzt();
      return;
    }
    const text = `${this.#puffer.join('\n')}\n`;
    this.#puffer = [];
    if (this.#schreibeDirekt(text)) this.#geschrieben += zaehleZeilen(text);
    this.#letztesSpuelen = this.#jetzt();
  }

  /** Spült ein letztes Mal und hört auf. Danach nimmt zeile() nichts mehr an. */
  stop(): void {
    if (!this.#offen) return;
    this.spuelen();
    this.#offen = false;
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  stats(): MitschnittStats {
    return {
      geschrieben: this.#geschrieben,
      verworfen: this.#verworfen,
      abgeschnitten: this.#abgeschnitten,
      fehler: this.#fehler,
      bytes: this.#bytes,
      seit: this.#seit,
      offen: this.#offen,
    };
  }

  /** Nur für Tests: wann zuletzt gespült wurde. */
  get letztesSpuelen(): number {
    return this.#letztesSpuelen;
  }

  #schreibeDirekt(text: string): boolean {
    try {
      appendFileSync(this.#opts.pfad, text);
      this.#bytes += Buffer.byteLength(text);
      return true;
    } catch (fehler) {
      this.#fehler++;
      // Nur einmal je Fehlerart melden: Klemmt die Platte, käme sonst alle
      // fünf Sekunden dieselbe Zeile ins Journal — und verdeckte alles andere.
      const art = String((fehler as { code?: string })?.code ?? fehler);
      if (!this.#fehlerGemeldet.has(art)) {
        this.#fehlerGemeldet.add(art);
        this.#opts.onFehler?.(fehler);
      }
      return false;
    }
  }
}

function zaehleZeilen(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}
