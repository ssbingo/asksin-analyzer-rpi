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
  OLED_HOEHE_VORGABE,
  OledBild,
  i2cTransferArgs,
  initKommandos,
} from './ssd1306.ts';
import type { OledHoehe } from './ssd1306.ts';
import { SPI_HZ, kodiereWs2812 } from './ws2812.ts';
import type { Farbe } from './ws2812.ts';
import { SEITEN_ANZAHL, blinkPhase, ledMuster, zeichneSeite } from './zustand.ts';
import type { StatusDaten } from './zustand.ts';

export interface StatusAnzeigeOptions {
  /**
   * Ansteuerung der WS2812:
   *   `ws2812-spi` — Daten über SPI/GPIO10 (Platine: R5). Läuft ohne
   *     Root-Rechte. Auf dem **Pi 5** der einzige Weg, weil die
   *     PWM/DMA-Bibliotheken den RP1 nicht bedienen.
   *   `ws2812-pwm` — Daten über PWM/GPIO18 (Platine: R4). Auf **Pi 3/4**
   *     der robuste Weg: dort leitet sich der SPI-Takt vom Kerntakt ab und
   *     wandert mit dessen Skalierung, was das WS2812-Timing zerstört.
   *     Braucht Root und damit den Hilfsdienst `asksin-analyzer-led`; der
   *     Core schreibt hier nur die gewünschte Farbe in eine Datei.
   */
  led: 'ws2812-spi' | 'ws2812-pwm' | 'aus';
  oled: boolean;
  /** 0–100; wirkt auf LED und OLED-Kontrast. */
  helligkeit?: number;
  spiGeraet?: string;
  /** Farbdatei für den PWM-Hilfsdienst. */
  pwmDatei?: string;
  i2cBus?: number;
  oledAdresse?: number;
  /** Bauhöhe des Panels: 32 (Adafruit PiOLED, Vorgabe) oder 64. */
  oledHoehe?: OledHoehe;
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

/** Flanken je Sekunde, ab denen der Taster als gestört gilt (siehe unten). */
const STURM_GRENZE = 50;

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
  readonly #fehlerTexte = new Map<string, string>();

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
    } else if (this.#o.led === 'ws2812-pwm') {
      // Kein Gerät zu öffnen: Die Farbe geht als Text an den Root-Hilfsdienst.
      this.#takte.push(this.#ledTakt(signal, this.#pwmDatei()));
    }

    if (this.#o.oled) {
      const ok = await this.#oledKommando(
        initKommandos(this.#helligkeit, this.#o.oledHoehe ?? OLED_HOEHE_VORGABE),
      );
      if (!ok) this.#oledFehler = MAX_FEHLER;
      this.#takte.push(this.#oledTakt(signal));
      // Der Taster wird nur abonniert, wenn das OLED tatsächlich geantwortet
      // hat. Vorher geschah das bedingungslos — auch bei völlig leerem
      // I2C-Bus, also wenn erkennbar gar kein Zubehör angeschlossen ist.
      // Dann lauschte gpiomon auf einem **offenen** Eingang: GPIO17 hat weder
      // auf der Platine noch im System einen Ruhepegel, schwebt also und
      // erzeugt aus Einstreuung fortlaufend Flanken. Wer nichts angeschlossen
      // hat, soll davon nichts abbekommen.
      if (ok) this.#tasterAbonnieren();
      else this.#fehler('oled', 'kein Anzeigegerät gefunden — Taster inaktiv');
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
    if (this.#ledFehler < MAX_FEHLER && this.#o.led !== 'aus') {
      const [ziel, daten] = this.#ledNutzlast([0, 0, 0], 0);
      await this.#schreibe(ziel, daten).catch(() => {});
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

  #pwmDatei(): string {
    return this.#o.pwmDatei ?? '/var/lib/asksin-analyzer/led-farbe';
  }

  /**
   * Ziel und Nutzlast für die gewünschte Farbe — je nach Ansteuerung.
   * SPI: fertiger Bytestrom fürs Gerät. PWM: `r,g,b` als Text für den
   * Hilfsdienst, Helligkeit ist dort bereits eingerechnet.
   */
  #ledNutzlast(farbe: Farbe, helligkeit: number): [string, Uint8Array] {
    if (this.#o.led === 'ws2812-pwm') {
      const f = Math.max(0, Math.min(100, helligkeit)) / 100;
      const werte = farbe.map((k) => Math.round(k * f) & 0xff);
      return [this.#pwmDatei(), new TextEncoder().encode(`${werte.join(',')}\n`)];
    }
    return [
      this.#o.spiGeraet ?? '/dev/spidev0.0',
      kodiereWs2812(farbe, helligkeit),
    ];
  }

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
        const [, daten] = this.#ledNutzlast(muster.farbe, this.#helligkeit * faktor);
        await this.#schreibe(geraet, daten);
      } catch (err) {
        this.#ledFehler++;
        this.#fehler('led', err);
      }
    }
  }

  // ---- OLED ------------------------------------------------------------

  async #oledTakt(signal: AbortSignal): Promise<void> {
    const bild = new OledBild(this.#o.oledHoehe ?? OLED_HOEHE_VORGABE);
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

  /**
   * Taster über gpiomon (libgpiod); v2-Syntax mit v1-Fallback.
   *
   * Zwei Vorkehrungen, die beide aus einem realen Ausfall stammen:
   *
   * **Ruhepegel.** Der Taster schaltet GPIO17 gegen Masse; einen Pull-up gibt
   * es auf der Platine nicht. Ohne `--bias=pull-up` liegt der Eingang im
   * Ruhezustand also auf keinem definierten Pegel, sondern schwebt — und ein
   * schwebender CMOS-Eingang erzeugt aus Einstreuung fortlaufend Flanken.
   * Das betrifft auch den Normalbetrieb **mit** angeschlossenem Taster: Ohne
   * Ruhepegel blätterte die Anzeige von selbst weiter.
   *
   * **Sturmsicherung.** Kommen trotzdem unsinnig viele Flanken, wird das
   * Lauschen eingestellt statt jedes Ereignis weiterzureichen. Ein Mensch
   * drückt keine 50-mal je Sekunde; was schneller kommt, ist eine Störung.
   * Der Analyzer soll daran nicht mitwirken.
   */
  #gpiomonTaster(cb: () => void): () => void {
    const chip = this.#o.gpioChip ?? 'gpiochip0';
    const line = String(this.#o.tasterGpio ?? 17);
    let beendet = false;
    let kind = spawn(
      'gpiomon',
      ['--edges', 'falling', '--bias', 'pull-up', '-c', chip, line],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );

    let fensterBeginn = this.#time.now();
    let imFenster = 0;
    const anEreignis = (): void => {
      const jetzt = this.#time.now();
      if (jetzt - fensterBeginn >= 1000) {
        fensterBeginn = jetzt;
        imFenster = 0;
      }
      imFenster++;
      if (imFenster > STURM_GRENZE) {
        if (!beendet) {
          beendet = true;
          kind.kill('SIGTERM');
          this.#fehler(
            'taster',
            `mehr als ${STURM_GRENZE} Flanken je Sekunde — Eingang offen ` +
              'oder gestört; Taster abgeschaltet',
          );
        }
        return;
      }
      cb();
    };

    kind.stdout.on('data', anEreignis);
    kind.on('error', () => {});
    kind.on('exit', (code) => {
      if (beendet || code === 0) return;
      // v1-Syntax versuchen (libgpiod 1.x kennt --edges/-c nicht):
      kind = spawn(
        'gpiomon',
        ['--falling-edge', '--bias', 'pull-up', chip, line],
        { stdio: ['ignore', 'pipe', 'ignore'] },
      );
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
    this.#fehlerTexte.set(kontext, String(fehler).split('\n')[0] ?? '');
    this.#o.onError?.(kontext, fehler);
  }

  /** Für die Status-Seite der Weboberfläche (M11): Zustand der Anzeige. */
  zustandFuerApi(): {
    aktiv: { led: boolean; oled: boolean };
    seite: number;
    seiten: number;
    fehler: Record<string, string>;
  } {
    return {
      aktiv: {
        led: this.#o.led === 'ws2812-spi' && this.#ledFehler < MAX_FEHLER,
        oled: this.#o.oled && this.#oledFehler < MAX_FEHLER,
      },
      seite: this.#seite,
      // Die Zahl gehört in die API, nicht in die Oberfläche: Dort stand sie
      // fest verdrahtet als „/4" und wäre beim Erweitern auf sieben Seiten
      // still falsch geworden.
      seiten: SEITEN_ANZAHL,
      fehler: Object.fromEntries(this.#fehlerTexte),
    };
  }
}
