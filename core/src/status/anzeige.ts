/**
 * StatusAnzeige (M11) — der Dienst hinter LED und OLED.
 *
 * Bezieht seine Daten aus einem injizierten Snapshot-Lieferanten und
 * spricht die Hardware ausschließlich über injizierbare Kommandos an
 * (`i2ctransfer`, `spi-config`, Datei-Schreiben, `gpiomon`) — dadurch ist
 * der komplette Ablauf ohne Hardware testbar, und auf dem Pi genügen die
 * Bordmittel i2c-tools/spi-tools/gpiod.
 *
 * Fehlertoleranz: Fehlt ein Gerät (kein OLED gesteckt, SPI nicht
 * aktiviert), wird der jeweilige Teil nach wenigen Fehlversuchen
 * stillgelegt und geloggt — der Analyzer läuft unbeirrt weiter.
 */

import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';

import { systemTime } from '../ingest/time.ts';
import type { TimeSource } from '../ingest/time.ts';
import type { KommandoRunner } from '../update/firmware.ts';
import { standardRunner } from '../update/firmware.ts';
import {
  AUS_KOMMANDO,
  OLED_ADRESSE,
  OledBild,
  i2cTransferArgs,
  initKommandos,
} from './ssd1306.ts';
import { SPI_HZ, kodiereWs2812 } from './ws2812.ts';
import { SEITEN_ANZAHL, blinkPhase, ledMuster, zeichneSeite } from './zustand.ts';
import type { StatusDaten } from './zustand.ts';

export interface StatusAnzeigeOptions {
  led: 'ws2812-spi' | 'aus';
  oled: boolean;
  /** 0–100; wirkt auf LED und OLED-Kontrast. */
  helligkeit?: number;
  spiGeraet?: string;
  i2cBus?: number;
  oledAdresse?: number;
  /** Taster an J6 — GPIO17 laut Platine V4. */
  tasterGpio?: number;
  gpioChip?: string;
  daten: () => StatusDaten;
  time?: TimeSource;
  runner?: KommandoRunner;
  schreibeGeraet?: (pfad: string, daten: Uint8Array) => Promise<void>;
  /** Tastendrücke abonnieren; Rückgabe stoppt das Lauschen. Vorgabe: gpiomon. */
  taster?: (cb: () => void) => () => void;
  onError?: (kontext: string, fehler: unknown) => void;
}

const MAX_FEHLER = 3;

export class StatusAnzeige {
  readonly #o: StatusAnzeigeOptions;
  readonly #time: TimeSource;
  readonly #runner: KommandoRunner;
  readonly #schreibe: (pfad: string, daten: Uint8Array) => Promise<void>;
  readonly #helligkeit: number;
  #stop: AbortController | null = null;
  #takte: Promise<void>[] = [];
  #tasterStop: (() => void) | null = null;
  #seite = 0;
  #letzterTastendruck = 0;
  #ledFehler = 0;
  #oledFehler = 0;
  #letzterLedSchluessel = '';

  constructor(options: StatusAnzeigeOptions) {
    this.#o = options;
    this.#time = options.time ?? systemTime;
    this.#runner = options.runner ?? standardRunner;
    this.#schreibe =
      options.schreibeGeraet ?? ((pfad, daten) => writeFile(pfad, daten));
    this.#helligkeit = options.helligkeit ?? 40;
  }

  async start(): Promise<void> {
    if (this.#stop !== null) throw new Error('StatusAnzeige läuft bereits');
    this.#stop = new AbortController();
    const signal = this.#stop.signal;

    if (this.#o.led === 'ws2812-spi') {
      // SPI-Takt einmalig setzen; die Einstellung bleibt am Gerät bestehen.
      const geraet = this.#o.spiGeraet ?? '/dev/spidev0.0';
      const conf = await this.#runner('spi-config', ['-d', geraet, '-s', String(SPI_HZ)]);
      if (conf.code !== 0) {
        this.#fehler('led', `spi-config: ${conf.output.trim() || 'nicht verfügbar'}`);
        this.#ledFehler = MAX_FEHLER;
      }
      this.#takte.push(this.#ledTakt(signal, geraet));
    }

    if (this.#o.oled) {
      const ok = await this.#oledKommando(initKommandos(this.#helligkeit));
      if (!ok) this.#oledFehler = MAX_FEHLER;
      this.#takte.push(this.#oledTakt(signal));
      this.#tasterAbonnieren();
    }
  }

  async stop(): Promise<void> {
    if (this.#stop === null) return;
    this.#stop.abort(new Error('gestoppt'));
    this.#tasterStop?.();
    this.#tasterStop = null;
    await Promise.allSettled(this.#takte);
    this.#takte = [];
    this.#stop = null;
    // Hardware dunkel hinterlassen:
    if (this.#o.led === 'ws2812-spi' && this.#ledFehler < MAX_FEHLER) {
      await this.#schreibe(
        this.#o.spiGeraet ?? '/dev/spidev0.0',
        kodiereWs2812([0, 0, 0], 100),
      ).catch(() => {});
    }
    if (this.#o.oled && this.#oledFehler < MAX_FEHLER) {
      await this.#oledKommando([AUS_KOMMANDO]);
    }
  }

  /** Für Tests und Anzeige: die aktuell gewählte OLED-Seite. */
  get seite(): number {
    return this.#seite;
  }

  naechsteSeite(): void {
    const jetzt = this.#time.now();
    if (jetzt - this.#letzterTastendruck < 250) return;    // entprellen
    this.#letzterTastendruck = jetzt;
    this.#seite = (this.#seite + 1) % SEITEN_ANZAHL;
  }

  // ---- LED -------------------------------------------------------------

  async #ledTakt(signal: AbortSignal, geraet: string): Promise<void> {
    for (;;) {
      try {
        await this.#time.delay(250, signal);
      } catch {
        return;
      }
      if (this.#ledFehler >= MAX_FEHLER) continue;
      const muster = ledMuster(this.#o.daten());
      const faktor = blinkPhase(muster.blinken, this.#time.now());
      const schluessel = `${muster.farbe.join(',')}:${faktor.toFixed(2)}`;
      if (schluessel === this.#letzterLedSchluessel) continue;
      this.#letzterLedSchluessel = schluessel;
      try {
        await this.#schreibe(
          geraet,
          kodiereWs2812(muster.farbe, this.#helligkeit * faktor),
        );
      } catch (err) {
        this.#ledFehler++;
        this.#fehler('led', err);
      }
    }
  }

  // ---- OLED ------------------------------------------------------------

  async #oledTakt(signal: AbortSignal): Promise<void> {
    const bild = new OledBild();
    let letzteSeite = -1;
    let letzterInhalt = '';
    for (;;) {
      if (this.#oledFehler < MAX_FEHLER) {
        zeichneSeite(bild, this.#seite, this.#o.daten());
        const inhalt = Buffer.from(bild.puffer).toString('base64');
        if (this.#seite !== letzteSeite || inhalt !== letzterInhalt) {
          letzteSeite = this.#seite;
          letzterInhalt = inhalt;
          const ok = await this.#oledDaten(bild.puffer);
          if (!ok) this.#oledFehler++;
        }
      }
      try {
        // Kurzer Takt, damit ein Tastendruck sofort umblättert:
        await this.#time.delay(500, signal);
      } catch {
        return;
      }
    }
  }

  async #oledKommando(kommandos: number[]): Promise<boolean> {
    return this.#i2c(0x00, kommandos);
  }

  async #oledDaten(puffer: Uint8Array): Promise<boolean> {
    return this.#i2c(0x40, puffer);
  }

  async #i2c(steuerByte: number, bytes: number[] | Uint8Array): Promise<boolean> {
    const args = i2cTransferArgs(
      this.#o.i2cBus ?? 1,
      this.#o.oledAdresse ?? OLED_ADRESSE,
      steuerByte,
      bytes,
    );
    const res = await this.#runner('i2ctransfer', args);
    if (res.code !== 0) {
      this.#fehler('oled', res.output.trim() || `i2ctransfer Exit ${res.code}`);
      return false;
    }
    return true;
  }

  // ---- Taster ----------------------------------------------------------

  #tasterAbonnieren(): void {
    const abo =
      this.#o.taster ??
      ((cb: () => void): (() => void) => this.#gpiomonTaster(cb));
    try {
      this.#tasterStop = abo(() => {
        this.naechsteSeite();
      });
    } catch (err) {
      this.#fehler('taster', err);
    }
  }

  /** Taster über gpiomon (libgpiod); v2-Syntax mit v1-Fallback. */
  #gpiomonTaster(cb: () => void): () => void {
    const chip = this.#o.gpioChip ?? 'gpiochip0';
    const line = String(this.#o.tasterGpio ?? 17);
    let beendet = false;
    let kind = spawn('gpiomon', ['--edges', 'falling', '-c', chip, line], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const anEreignis = (): void => cb();
    kind.stdout.on('data', anEreignis);
    kind.on('error', () => {});
    kind.on('exit', (code) => {
      if (beendet || code === 0) return;
      // v1-Syntax versuchen:
      kind = spawn('gpiomon', ['--falling-edge', chip, line], {
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      kind.stdout.on('data', anEreignis);
      kind.on('error', () => {});
      kind.on('exit', (code2) => {
        if (!beendet && code2 !== 0) this.#fehler('taster', 'gpiomon nicht verfügbar');
      });
    });
    return () => {
      beendet = true;
      kind.kill('SIGTERM');
    };
  }

  #fehler(kontext: string, fehler: unknown): void {
    this.#o.onError?.(kontext, fehler);
  }
}
