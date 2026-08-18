import { LineSplitter } from '../ingest/lineSplitter.ts';
import { BoundedQueue } from '../ingest/queue.ts';
import type { IngestStream, PortOpener } from '../ingest/ingest.ts';
import { parseZigbeeZeile } from './parse.ts';
import { leereIgnoreZaehler } from './types.ts';
import type { ZigbeeIgnoreZaehler, ZigbeePaket } from './types.ts';

/**
 * Der Zigbee-Mithörer am seriellen Anschluss.
 *
 * Bewusst ein eigener Leser und nicht `SerialIngest`. Der ist auf BidCoS
 * zugeschnitten — Freischaltung mit `:?;`, Folgenummern, Rausch- und
 * Telegrammzähler, Firmwareauskunft. Ihn für ein zweites Protokoll
 * umzubauen hieße, den Pfad anzufassen, der nie ausfallen darf. Geteilt
 * werden nur die wirklich protokollneutralen Teile: `LineSplitter`,
 * `BoundedQueue` und der Portöffner.
 *
 * Was dieser Leser garantiert
 * ---------------------------
 *   * Er wirft nie in die Ereignisschleife: Jede Ausnahme aus dem
 *     Verbraucher wird gefangen und gezählt.
 *   * Er wächst nicht: Die Warteschlange ist begrenzt; läuft sie über,
 *     fallen die **ältesten** Pakete weg und werden **gezählt**. Eine
 *     stille Kürzung sähe aus wie Funkstille — genau die Verwechslung, vor
 *     der `folge.ts` im BidCoS-Pfad warnt.
 *   * Er hält an, wenn der Stick abgezogen wird, und kommt von selbst
 *     wieder, wenn er zurückkehrt.
 */

/** 1 MBaud — die Sniffer-Firmware redet nicht langsamer. */
export const ZIGBEE_BAUD = 1_000_000;

export const ZIGBEE_DEVICE = '/dev/asksin-zigbee';

/** Voreingestellter Kanal. Zigbee kennt 11 bis 26. */
export const ZIGBEE_KANAL = 11;

/**
 * Wie viele Pakete zwischengehalten werden.
 *
 * Gemessen wurden rund 16 Pakete je Sekunde. 2000 Plätze sind damit gut zwei
 * Minuten Vorrat — genug, um eine kurze Verzögerung beim Schreiben in die
 * Datenbank zu überbrücken, und klein genug, dass ein hängender Verbraucher
 * nicht den Speicher frisst.
 */
const QUEUE_KAPAZITAET = 2000;

/**
 * Längste Zeile. Ein Rahmen hat höchstens 127 Byte, als Hex 254 Zeichen,
 * dazu der JSON-Rahmen. 1024 ist reichlich und begrenzt zugleich den
 * Schaden, wenn die Baudrate einmal nicht stimmt und nie ein `\n` kommt.
 */
const MAX_ZEILE = 1024;

export interface ZigbeeLeserOptionen {
  openPort: PortOpener;
  kanal?: number;
  onPaket?: (paket: ZigbeePaket) => void | Promise<void>;
  /** Die rohe Zeile, vor dem Auswerten — für Mitschnitte. */
  onRohzeile?: (zeile: string, ts: number) => void;
  time?: () => number;
  queueKapazitaet?: number;
  backoffMs?: number;
  backoffMaxMs?: number;
}

export interface ZigbeeStats {
  verbunden: boolean;
  verbundenSeit: number | null;
  kanal: number;
  zeilen: number;
  pakete: number;
  /** Nach Grund aufgeschlüsselt — jede verworfene Zeile ist auffindbar. */
  verworfen: ZigbeeIgnoreZaehler;
  /** Durch Überlauf der Warteschlange verlorene Pakete. */
  ueberlauf: number;
  /** Zeilen, die zu lang waren, um eine Zeile zu sein. */
  ueberlangeZeilen: number;
  /** Ausnahmen aus dem Verbraucher — gefangen, gezählt, weiter. */
  verbraucherFehler: number;
  neuverbindungen: number;
  letzteZeileAm: number | null;
}

export class ZigbeeLeser {
  readonly #o: Required<Pick<ZigbeeLeserOptionen, 'openPort'>> & ZigbeeLeserOptionen;
  readonly #jetzt: () => number;
  readonly #queue: BoundedQueue<ZigbeePaket>;
  readonly #splitter = new LineSplitter(MAX_ZEILE);

  #kanal: number;
  #abbruch: AbortController | null = null;
  #laeuft = false;
  #strom: IngestStream | null = null;

  #stats: ZigbeeStats;

  constructor(o: ZigbeeLeserOptionen) {
    this.#o = o;
    this.#jetzt = o.time ?? Date.now;
    this.#kanal = o.kanal ?? ZIGBEE_KANAL;
    this.#queue = new BoundedQueue<ZigbeePaket>(o.queueKapazitaet ?? QUEUE_KAPAZITAET);
    this.#stats = {
      verbunden: false,
      verbundenSeit: null,
      kanal: this.#kanal,
      zeilen: 0,
      pakete: 0,
      verworfen: leereIgnoreZaehler(),
      ueberlauf: 0,
      ueberlangeZeilen: 0,
      verbraucherFehler: 0,
      neuverbindungen: 0,
      letzteZeileAm: null,
    };
  }

  get stats(): ZigbeeStats {
    return {
      ...this.#stats,
      verworfen: { ...this.#stats.verworfen },
      ueberlangeZeilen: this.#splitter.overlongDropped,
    };
  }

  get kanal(): number {
    return this.#kanal;
  }

  /**
   * Kanal wechseln. Bewusst ein eigener Vorgang und kein Hin- und
   * Herspringen: Ein hüpfender Mithörer verpasst auf jedem Kanal das meiste.
   */
  async kanalSetzen(kanal: number): Promise<void> {
    if (!Number.isInteger(kanal) || kanal < 11 || kanal > 26) {
      throw new Error(`Zigbee-Kanal muss zwischen 11 und 26 liegen, nicht ${kanal}`);
    }
    this.#kanal = kanal;
    this.#stats.kanal = kanal;
    await this.#kanalSenden();
  }

  async #kanalSenden(): Promise<void> {
    const strom = this.#strom;
    if (strom?.schreibe === undefined) return;
    try {
      await strom.schreibe(`{"C":${this.#kanal}}\n`);
    } catch {
      // Der Empfang ist die Hauptsache. Kommt der Befehl nicht durch, bleibt
      // der Stick auf seinem bisherigen Kanal — sichtbar am Feld C jedes
      // Pakets, das ist die ehrlichere Auskunft als eine Ausnahme hier.
    }
  }

  start(): void {
    if (this.#laeuft) return;
    this.#laeuft = true;
    void this.#schleife();
  }

  async stop(): Promise<void> {
    this.#laeuft = false;
    this.#abbruch?.abort();
    const strom = this.#strom;
    this.#strom = null;
    this.#stats.verbunden = false;
    if (strom !== null) {
      try {
        await strom.close();
      } catch {
        // Schon zu, oder nie richtig auf. Beides kein Grund für Lärm.
      }
    }
  }

  async #schleife(): Promise<void> {
    let wartezeit = this.#o.backoffMs ?? 500;
    const max = this.#o.backoffMaxMs ?? 30_000;

    while (this.#laeuft) {
      const abbruch = new AbortController();
      this.#abbruch = abbruch;
      try {
        const strom = await this.#o.openPort(abbruch.signal);
        this.#strom = strom;
        this.#stats.verbunden = true;
        this.#stats.verbundenSeit = this.#jetzt();
        await this.#kanalSenden();
        wartezeit = this.#o.backoffMs ?? 500;

        for await (const brocken of strom.readable) {
          if (!this.#laeuft) break;
          for (const zeile of this.#splitter.push(brocken)) {
            this.#zeileVerarbeiten(zeile);
          }
        }
      } catch {
        // Abgezogen, Rechte weg, Gerät noch nicht da — alles derselbe Fall:
        // warten und erneut versuchen.
      } finally {
        this.#stats.verbunden = false;
        const strom = this.#strom;
        this.#strom = null;
        if (strom !== null) {
          try {
            await strom.close();
          } catch { /* siehe stop() */ }
        }
      }

      if (!this.#laeuft) break;
      this.#stats.neuverbindungen++;
      await new Promise((r) => setTimeout(r, wartezeit));
      wartezeit = Math.min(wartezeit * 2, max);
    }
  }

  #zeileVerarbeiten(zeile: string): void {
    const ts = this.#jetzt();
    this.#stats.zeilen++;
    this.#stats.letzteZeileAm = ts;

    try {
      this.#o.onRohzeile?.(zeile, ts);
    } catch {
      this.#stats.verbraucherFehler++;
    }

    const ergebnis = parseZigbeeZeile(zeile, this.#jetzt);
    if (ergebnis.kind === 'ignoriert') {
      this.#stats.verworfen[ergebnis.grund]++;
      return;
    }

    this.#stats.pakete++;
    this.#stats.ueberlauf += this.#queue.put(ergebnis.paket);

    const verbraucher = this.#o.onPaket;
    if (verbraucher === undefined) return;
    try {
      const p = verbraucher(ergebnis.paket);
      if (p instanceof Promise) p.catch(() => { this.#stats.verbraucherFehler++; });
    } catch {
      this.#stats.verbraucherFehler++;
    }
  }
}
