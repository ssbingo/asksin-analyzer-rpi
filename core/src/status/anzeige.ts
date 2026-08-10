/**
 * StatusAnzeige (M11) — der Dienst hinter LED und OLED.
 *
 * Bezieht seine Daten aus einem injizierten Snapshot-Lieferanten und
 * spricht die Hardware ausschließlich über injizierbare Kommandos an
 * (`i2ctransfer`, `gpiomon`, Datei-Schreiben) sowie über einen injizierbaren
 * SPI-Schreiber — dadurch ist der komplette Ablauf ohne Hardware testbar,
 * und auf dem Pi genügen die Bordmittel i2c-tools/gpiod plus python3.
 *
 * Fehlertoleranz: Fehlt ein Gerät (kein OLED gesteckt, SPI nicht
 * aktiviert), wird der jeweilige Teil nach wenigen Fehlversuchen
 * stillgelegt und geloggt — der Analyzer läuft unbeirrt weiter.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { systemTime } from '../ingest/time.ts';
import type { TimeSource } from '../ingest/time.ts';
import type { KommandoRunner } from '../update/firmware.ts';
import { standardRunner } from '../update/firmware.ts';
import type { OledHoehe } from './ssd1306.ts';
import { SPI_HZ, kodiereWs2812 } from './ws2812.ts';
import type { Farbe } from './ws2812.ts';
import { SEITEN_ANZAHL, blinkPhase, ledMuster } from './zustand.ts';
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
  /** Datei, aus der der Anzeigedienst seine Werte liest. */
  oledZustandDatei?: string;
  /** Datei, die der Anzeigedienst nach jedem Bild schreibt (Lebenszeichen). */
  oledBildDatei?: string;
  /** Für Tests: Prüfung, ob die Bilddatei existiert. */
  bildVorhanden?: (pfad: string) => boolean;
  /** Für Tests: aktueller Pegel des Tasters (true = gedrückt). */
  tasteGedrueckt?: () => Promise<boolean>;
  /** Für Tests: Lesen einer Datei. */
  leseDatei?: (pfad: string) => string;
  /** Datei, auf die der Root-Helfer für den Neustart wartet. */
  neustartDatei?: string;
  /** Taster an J6 — GPIO17 laut Platine V4. */
  tasterGpio?: number;
  gpioChip?: string;
  daten: () => StatusDaten;
  time?: TimeSource;
  runner?: KommandoRunner;
  /** Für Tests: überschreibt die Modellerkennung. */
  istPi5?: () => boolean;
  schreibeGeraet?: (pfad: string, daten: Uint8Array) => Promise<void>;
  /**
   * Öffnet den SPI-Schreiber. Vorgabe: der Python-Helfer als Kindprozess.
   * Für Tests überschreibbar — sonst bräuchte jeder Test ein spidev-Gerät.
   */
  spiOeffnen?: (geraet: string, hz: number) => Promise<SpiSchreiber>;
  /** Tastendrücke abonnieren; Rückgabe stoppt das Lauschen. Vorgabe: gpiomon. */
  taster?: (cb: () => void) => () => void;
  onError?: (kontext: string, fehler: unknown) => void;
  /**
   * Jede Aktion an der Hardware — fuer das Protokoll.
   *
   * Anlass: Der Pi fiel zweimal aus, waehrend die Status-LED eingeschaltet,
   * aber nichts angeschlossen war. Ohne Zeitstempel unmittelbar vor dem
   * Ausfall bleibt das eine Vermutung. Steht die letzte Zeile im Protokoll
   * direkt vor dem Abriss, ist der Zusammenhang belegt — oder widerlegt.
   */
  onAktion?: (was: string, daten?: unknown) => void;
}

/**
 * Ein offener Schreibweg auf das SPI-Gerät.
 *
 * Muss offen bleiben: Der Takt hängt am Dateideskriptor, nicht am Gerät —
 * beim Schließen setzt der Kern ihn auf den Höchstwert des Reglers zurück.
 * Begründung und Messung in `deploy/ws2812-spi.py`.
 */
export interface SpiSchreiber {
  schreibe(daten: Uint8Array): Promise<void>;
  schliesse(): Promise<void>;
}

/** Pfad des Helfers — liegt neben dem Core: core/src/status → ../../../deploy */
export const WS2812_HELFER = fileURLToPath(
  new URL('../../../deploy/ws2812-spi.py', import.meta.url),
);

/**
 * Vorgabe-Schreiber: der Python-Helfer als **dauerhaft offener** Kindprozess.
 *
 * Er meldet den zurückgelesenen Takt auf der Fehlerausgabe und beendet sich,
 * wenn er ihn nicht stellen kann. Genau das braucht es hier: Ein stiller
 * Fehlschlag sähe von außen aus wie eine kaputte LED.
 */
export function spiHelferOeffnen(geraet: string, hz: number): Promise<SpiSchreiber> {
  return new Promise<SpiSchreiber>((auf, ab) => {
    const kind = spawn('python3', [WS2812_HELFER, geraet, String(hz)], {
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let meldung = '';
    let entschieden = false;

    kind.stderr.setEncoding('utf8');
    kind.stderr.on('data', (stueck: string) => {
      meldung += stueck;
      // Die Bereitschaftszeile ist die Quittung: Erst danach steht fest,
      // dass der Takt wirklich anliegt.
      if (!entschieden && meldung.includes('SPI bereit:')) {
        entschieden = true;
        auf(schreiber);
      }
    });
    const fehlschlag = (grund: string): void => {
      if (entschieden) return;
      entschieden = true;
      ab(new Error(`${grund}${meldung.trim() === '' ? '' : `: ${meldung.trim()}`}`));
    };
    kind.on('error', (err) => fehlschlag(`ws2812-spi.py: ${String(err)}`));
    kind.on('exit', (code) => fehlschlag(`ws2812-spi.py endete mit Code ${String(code)}`));

    const schreiber: SpiSchreiber = {
      schreibe: (daten) =>
        new Promise<void>((fertig, schief) => {
          if (kind.exitCode !== null || kind.signalCode !== null) {
            schief(new Error(`ws2812-spi.py läuft nicht mehr${meldung.trim() === '' ? '' : `: ${meldung.trim()}`}`));
            return;
          }
          // Hex je Zeile: robust gegen jede Pufferung, und im Protokoll
          // lesbar. Ein Rahmen sind rund 140 Byte, das faellt nicht ins Gewicht.
          kind.stdin.write(`${Buffer.from(daten).toString('hex')}\n`, (err) =>
            err ? schief(err) : fertig(),
          );
        }),
      schliesse: () =>
        new Promise<void>((fertig) => {
          if (kind.exitCode !== null || kind.signalCode !== null) {
            fertig();
            return;
          }
          kind.once('close', () => fertig());
          kind.stdin.end();      // EOF genuegt — der Helfer laeuft dann aus
        }),
    };
  });
}

const MAX_FEHLER = 3;

/** Wie oft nachgesehen wird, ob der PWM-Hilfsdienst läuft. */
const PWM_PRUEFUNG_MS = 60_000;

/** Flanken je Sekunde, ab denen der Taster als gestört gilt (siehe unten). */
const STURM_GRENZE = 50;

// Tastendruck — Zeiten aus dem Vorbild (Status-LED-OLED, Config):
//   button_debounce_s      0,05 s  Mindestdauer für „kurz"
//   button_long_press_s    5,0 s   ab hier Neustart
//   button_reboot_message_s 3,0 s  so lange steht „Neustart…" auf dem Display
const ENTPRELLUNG_MS = 50;
const LANG_MS = 5000;
const NEUSTART_MELDUNG_MS = 3000;
/** Wie oft der Pegel während des Haltens abgefragt wird. */
const HALTE_TAKT_MS = 200;
/**
 * Nach dieser Zeit ohne Tastendruck springt die Anzeige auf Seite 1 zurück.
 *
 * Das Vorbild macht dasselbe nach 30 Sekunden (`oled_page_timeout_s`); hier
 * sind es 60 — Vorgabe von Silvio. Der Sinn ist derselbe: Wer im Vorbeigehen
 * blättert, soll nicht dauerhaft eine Systemseite stehen lassen. Auf Seite 1
 * steht der Standort, und die will man sehen, wenn man vor dem Schrank steht.
 */
const RUECKSPRUNG_MS = 60_000;

/**
 * Erkennt einen Pi 5 am Modellstring aus dem Gerätebaum.
 *
 * Trifft auf „Raspberry Pi 5 Model B Rev 1.1" und auf „Raspberry Pi Compute
 * Module 5" zu. Eigene Funktion, weil zwei Stellen sie brauchen: die Anzeige
 * für ihre Meldung und der Dienst, um die Betriebsart zu korrigieren, bevor
 * PWM überhaupt anläuft.
 */
export function istPi5Modell(modell: string): boolean {
  return modell.includes('Raspberry Pi 5') || modell.includes('Compute Module 5');
}

export class StatusAnzeige {
  readonly #o: StatusAnzeigeOptions;
  readonly #time: TimeSource;
  readonly #runner: KommandoRunner;
  readonly #schreibe: (pfad: string, daten: Uint8Array) => Promise<void>;
  readonly #helligkeit: number;
  #stop: AbortController | null = null;
  #takte: Promise<void>[] = [];
  #tasterStop: (() => void) | null = null;
  /** Damit der Grund einmal im Journal steht und nicht alle 500 ms. */
  #tasterGemeldet = false;
  /** Damit der fehlende PWM-Helfer einmal gemeldet wird, nicht dauernd. */
  #pwmGemeldet = false;
  #letztePwmPruefung = 0;
  #seite = 0;
  /** Hat der Anzeigedienst zuletzt eine Seitenzahl gemeldet? */
  #seitenGemeldet = true;
  #letzterTastendruck = 0;
  #letzteSeitenaenderung = 0;
  #ledFehler = 0;
  /** Offener Schreibweg auf das SPI-Gerät; null bei PWM oder abgeschalteter LED. */
  #spi: SpiSchreiber | null = null;
  #oledFehler = 0;
  #letzterLedSchluessel = '';
  #tasteLaeuft = false;
  #neustartMeldung = false;
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
      // Der Takt gehoert zum Deskriptor, nicht zum Geraet: Beim Schliessen
      // setzt der Kern ihn auf den Hoechstwert des Reglers zurueck. Hier lief
      // deshalb frueher `spi-config` als eigener Prozess — und hinterliess
      // nichts. Der Helfer bleibt offen, solange die Anzeige laeuft.
      const geraet = this.#o.spiGeraet ?? '/dev/spidev0.0';
      this.#o.onAktion?.('SPI wird geoeffnet', { geraet, hz: SPI_HZ });
      try {
        this.#spi = await (this.#o.spiOeffnen ?? spiHelferOeffnen)(geraet, SPI_HZ);
      } catch (err) {
        this.#fehler('led', err);
        this.#ledFehler = MAX_FEHLER;
      }
      this.#takte.push(this.#ledTakt(signal, geraet));
    } else if (this.#o.led === 'ws2812-pwm') {
      // Kein Gerät zu öffnen: Die Farbe geht als Text an den Root-Hilfsdienst.
      this.#takte.push(this.#ledTakt(signal, this.#pwmDatei()));
    }

    if (this.#o.oled) {
      this.#takte.push(this.#oledTakt(signal));
      // Der Taster wird nur abonniert, wenn der Anzeigedienst wirklich
      // zeichnet — erkennbar an der Bilddatei, die er nach jedem Bild
      // schreibt. Ohne diese Bedingung lauschte gpiomon auf einem **offenen**
      // Eingang: GPIO17 hat weder auf der Platine noch im System einen
      // Ruhepegel, schwebt also und erzeugt aus Einstreuung fortlaufend
      // Flanken. Wer nichts angeschlossen hat, soll davon nichts abbekommen.
      // Nicht einmalig pruefen — der Takt holt es nach, sobald das Bild da
      // ist. Begruendung in #tasterNachziehen().
      this.#tasterNachziehen();
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
      await this.#ledSchreiben(ziel, daten).catch(() => {});
    }
    // Erst danach schliessen — sonst geht der letzte Rahmen ins Leere.
    if (this.#spi !== null) {
      await this.#spi.schliesse().catch(() => {});
      this.#spi = null;
    }
    if (this.#o.oled) {
      // Ein leerer Zustand lässt den Anzeigedienst das Display räumen.
      this.#schreibeZustand({ aus: true });
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
    this.#letzteSeitenaenderung = jetzt;
    // Wie viele Seiten es gibt, weiss der Anzeigedienst — er kennt auch die
    // Felder, die nur manchmal vorhanden sind (Lüfter, Platte). Vorher stand
    // hier die Konstante des Core, und nach Seite 9 sprang es zurueck auf 1,
    // obwohl der Dienst laengst mehr Seiten hatte.
    this.#seite = (this.#seite + 1) % this.#seitenGesamt();
    // Sofort weitergeben statt auf den naechsten Takt zu warten: Das
    // Umschalten war dadurch traege geworden.
    this.#schreibeZustand(this.#zustandFuerAnzeige());
  }

  /** Seitenzahl laut Anzeigedienst; ohne dessen Meldung die eigene.
   *
   * Beide Orte werden geprueft. Der Anzeigedienst kann starten, bevor der
   * Core /run/asksin-analyzer angelegt hat, und landet dann in /var/lib —
   * frueher lasen beide Seiten daraufhin aneinander vorbei, und die Anzeige
   * fiel wortlos auf die Notfallzahl zurueck. Genau dieser Rueckfall wird
   * jetzt einmal gemeldet, statt sich als "9 Seiten" zu tarnen.
   */
  #seitenGesamt(): number {
    const lesen = this.#o.leseDatei ?? ((p: string) => readFileSync(p, 'utf8'));
    const orte = [
      this.#o.oledBildDatei,
      '/run/asksin-analyzer/oled-bild.b64',
      '/var/lib/asksin-analyzer/oled-bild.b64',
    ].filter((p): p is string => typeof p === 'string');
    for (const pfad of orte) {
      try {
        const roh = JSON.parse(lesen(pfad)) as { seiten?: number };
        if (typeof roh.seiten === 'number' && roh.seiten > 0) {
          this.#seitenGemeldet = true;
          return roh.seiten;
        }
      } catch {
        /* naechster Ort */
      }
    }
    if (this.#seitenGemeldet) {
      this.#seitenGemeldet = false;
      console.warn(
        `[anzeige] Anzeigedienst meldet keine Seitenzahl (gesucht: ` +
          `${orte.join(', ')}) — es gelten ${SEITEN_ANZAHL} Seiten. ` +
          `Laeuft asksin-analyzer-oled?`,
      );
    }
    return SEITEN_ANZAHL;
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

  /**
   * Prueft bei PWM, ob der Root-Hilfsdienst ueberhaupt laeuft.
   *
   * Der Core schreibt bei dieser Betriebsart nur die Farbe als Text nach
   * /run/asksin-analyzer/led-farbe; treiben muss sie der Dienst
   * asksin-analyzer-led, weil PWM/DMA Root braucht. Laeuft der nicht, gelingt
   * das Schreiben trotzdem — es liest nur niemand. Von aussen: dunkle LED,
   * keine Fehlermeldung, alles scheinbar richtig eingestellt.
   *
   * Genau so am 10.08.2026 an Analyzer 01: Die Betriebsart war in der
   * Weboberflaeche auf PWM gestellt worden, aber die Voraussetzungen dafuer
   * schafft bisher nur der Installer — rpi_ws281x, der Hilfsdienst und das
   * Abschalten des Onboard-Audio. Die Einstellung sah aus, als wirke sie.
   *
   * Selten geprueft (alle 60 s): Der Dienst kann jederzeit nachtraeglich
   * eingerichtet werden, und ein Aufruf je Minute faellt nicht ins Gewicht.
   */
  async #pwmHelferPruefen(): Promise<void> {
    if (this.#o.led !== 'ws2812-pwm') return;
    const jetzt = this.#time.now();
    if (jetzt - this.#letztePwmPruefung < PWM_PRUEFUNG_MS) return;
    this.#letztePwmPruefung = jetzt;

    // Zuerst das Modell: Auf dem Pi 5 kann PWM gar nicht arbeiten, und dann
    // waere "der Hilfsdienst laeuft nicht" zwar wahr, aber irrefuehrend — er
    // beendet sich dort mit Absicht.
    //
    // Grund: Auf dem Pi 5 sitzt die Peripherie hinter dem RP1-Chip, waehrend
    // rpi_ws281x weiterhin auf die alte Speicherlage zielt. Im guenstigen
    // Fall verweigert die Bibliothek den Start, im unguenstigen richtet ein
    // DMA-Kanal Schreibzugriffe auf fremden Speicher — das haengt den Rechner
    // hart auf, ohne eine Zeile im Journal.
    //
    // Am 10.08.2026 an Analyzer 01 aufgetreten: Das Geraet wurde fuer einen
    // Pi 4 gehalten, PWM eingestellt, LED blieb dunkel. Die Erklaerung stand
    // nur auf der Fehlerausgabe des Helfers, die niemand sieht — der Dienst
    // laeuft ja unter systemd.
    if (this.#istPi5()) {
      if (this.#pwmGemeldet) return;
      this.#pwmGemeldet = true;
      this.#fehler(
        'led',
        'Dieses Gerät ist ein Raspberry Pi 5 — dort kann PWM die LED nicht ' +
          'ansteuern. Einstellungen → Ansteuerung auf **SPI / GPIO10** ' +
          'stellen und den Schiebeschalter SW1 auf der Platine ebenfalls auf ' +
          'SPI schieben. Einen Hilfsdienst braucht es dann nicht.',
      );
      return;
    }
    let laeuft = false;
    try {
      const erg = await this.#runner('systemctl', ['is-active', 'asksin-analyzer-led']);
      laeuft = erg.code === 0;
    } catch {
      return;   // systemctl nicht da: keine Aussage, also keine Behauptung
    }
    if (laeuft) {
      this.#pwmGemeldet = false;
      return;
    }
    if (this.#pwmGemeldet) return;
    this.#pwmGemeldet = true;
    this.#fehler(
      'led',
      'Betriebsart PWM gewählt, aber der Hilfsdienst asksin-analyzer-led ' +
        'läuft nicht — die Farbe wird geschrieben und von niemandem gelesen. ' +
        'Einrichten mit: sudo bash /opt/asksin-analyzer/deploy/' +
        'led-pwm-einrichten.sh (Handbuch 18)',
    );
  }

  /**
   * Ein LED-Rahmen — bei SPI durch den offenen Helfer, bei PWM als Text in
   * die Datei, die der Root-Hilfsdienst liest.
   */
  async #ledSchreiben(ziel: string, daten: Uint8Array): Promise<void> {
    if (this.#o.led !== 'ws2812-spi') {
      await this.#schreibe(ziel, daten);
      return;
    }
    if (this.#spi === null) throw new Error('SPI ist nicht geöffnet');
    await this.#spi.schreibe(daten);
  }

  async #ledTakt(signal: AbortSignal, geraet: string): Promise<void> {
    for (;;) {
      try {
        await this.#time.delay(250, signal);
      } catch {
        return;
      }
      await this.#pwmHelferPruefen();
      if (this.#ledFehler >= MAX_FEHLER) continue;
      const muster = ledMuster(this.#o.daten());
      const faktor = blinkPhase(muster.blinken, this.#time.now());
      const schluessel = `${muster.farbe.join(',')}:${faktor.toFixed(2)}`;
      if (schluessel === this.#letzterLedSchluessel) continue;
      this.#letzterLedSchluessel = schluessel;
      try {
        const [, daten] = this.#ledNutzlast(muster.farbe, this.#helligkeit * faktor);
        this.#o.onAktion?.('LED-Frame wird geschrieben', {
          ziel: geraet,
          farbe: muster.farbe,
          grund: muster.grund,
          bytes: daten.length,
        });
        await this.#ledSchreiben(geraet, daten);
        this.#o.onAktion?.('LED-Frame geschrieben');
      } catch (err) {
        this.#ledFehler++;
        this.#fehler('led', err);
      }
    }
  }

  // ---- OLED ------------------------------------------------------------

  /**
   * Werte für die Anzeige bereitstellen.
   *
   * Gezeichnet wird **nicht** hier, sondern im Dienst `asksin-analyzer-oled`.
   * Der arbeitet mit denselben Bibliotheken wie das Vorbild (Status-LED-OLED):
   * adafruit_ssd1306 als Treiber, Pillow zum Zeichnen und DejaVuSans-Bold als
   * Schrift, deren Größe je Wert automatisch gesucht wird. Ein eigener
   * Nachbau in TypeScript war auf dem Gerät deutlich schlechter zu lesen.
   *
   * Hier wird deshalb nur noch geschrieben, was der Analyzer weiß; die
   * Systemwerte (IP, MAC, CPU, RAM, Laufzeit, Lüfter) holt sich der
   * Anzeigedienst selbst — wie im Original.
   */
  #zustandFuerAnzeige(): Record<string, unknown> {
    const d = this.#o.daten();
    return {
      seite: this.#seite,
      version: d.version,
      standort: d.standort,
      status: d.demo ? 'DEMO' : d.connected ? 'BEREIT' : 'GETRENNT',
      telegramsPerMinute: d.telegramsPerMinute,
      noiseFloor: d.noiseFloor,
      deviceCount: d.deviceCount,
      maxDutyCycle: d.maxDutyCycle,
      dutyAlarme: d.dutyAlarme,
      // Solange gesetzt, zeigt der Anzeigedienst nur diese Meldung.
      ...(this.#neustartMeldung ? { meldung: 'Neustart…' } : {}),
    };
  }

  async #oledTakt(signal: AbortSignal): Promise<void> {
    let letzter = '';
    for (;;) {
      // Rücksprung auf Seite 1 nach Ablauf der Frist — geprüft im laufenden
      // Takt, damit es keinen zweiten Zeitgeber braucht.
      if (
        this.#seite !== 0 &&
        this.#time.now() - this.#letzteSeitenaenderung >= RUECKSPRUNG_MS
      ) {
        this.#seite = 0;
        this.#letzteSeitenaenderung = this.#time.now();
      }
      this.#tasterNachziehen();
      const zustand = this.#zustandFuerAnzeige();
      const text = JSON.stringify(zustand);
      if (text !== letzter) {
        letzter = text;
        this.#schreibeZustand(zustand);
      }
      try {
        await this.#time.delay(500, signal);
      } catch {
        return;
      }
    }
  }

  /**
   * Abonniert den Taster, sobald der Anzeigedienst zeichnet — und laesst ihn
   * wieder los, wenn der Dienst verstummt.
   *
   * Die Bedingung selbst ist richtig: GPIO17 hat ohne angeschlossenen Taster
   * weder auf der Platine noch im System einen Ruhepegel. Ein Abonnement auf
   * einem schwebenden Eingang liefert aus Einstreuung fortlaufend Flanken.
   *
   * Falsch war, sie **einmalig beim Start** zu pruefen. Die Bilddatei liegt in
   * /run/asksin-analyzer — einem tmpfs, das nach jedem Systemstart leer ist —
   * und der Anzeigedienst startet laut seiner Unit `After=asksin-analyzer`.
   * Beim Start des Analyzers kann die Datei also gar nicht da sein. Ergebnis:
   * Der Taster blieb nach **jedem Neustart** tot, bauartbedingt, und half
   * nur ein Neustart des Analyzers von Hand — nachdem der Anzeigedienst
   * gezeichnet hatte.
   *
   * Am 10.08.2026 an Analyzer 01 aufgefallen: LED dunkel, Taster ohne
   * Funktion, beide Haken in den Einstellungen gesetzt.
   *
   * Der OLED-Takt laeuft ohnehin alle 500 ms; das Nachziehen kostet einen
   * Dateisystemzugriff und behebt den Fall vollstaendig.
   */
  #tasterNachziehen(): void {
    const zeichnet = this.#anzeigedienstLaeuft();
    if (zeichnet && this.#tasterStop === null) {
      this.#tasterAbonnieren();
      this.#tasterGemeldet = false;   // beim naechsten Ausfall wieder melden
      return;
    }
    if (!zeichnet && this.#tasterStop === null && !this.#tasterGemeldet) {
      // Einmal sagen, nicht alle 500 ms. Ohne diese Meldung sucht man den
      // Taster bei der Hardware, obwohl nur der Anzeigedienst fehlt.
      this.#tasterGemeldet = true;
      this.#fehler(
        'oled',
        'Anzeigedienst meldet kein Bild — Taster bleibt inaktiv, ' +
          'bis er zeichnet',
      );
      return;
    }
    if (!zeichnet && this.#tasterStop !== null) {
      // Der Dienst ist weg — nicht auf einem schwebenden Eingang lauschen
      // bleiben.
      this.#tasterStop();
      this.#tasterStop = null;
      this.#tasterGemeldet = true;
      this.#fehler(
        'oled',
        'Anzeigedienst meldet kein Bild mehr — Taster wieder inaktiv',
      );
    }
  }

  /**
   * Modell aus dem Gerätebaum — die verlässlichste Quelle, die es gibt: Sie
   * kommt vom Bootloader, nicht aus einer Vermutung über Kernel oder CPU.
   */
  #istPi5(): boolean {
    if (this.#o.istPi5 !== undefined) return this.#o.istPi5();
    try {
      return istPi5Modell(readFileSync('/proc/device-tree/model', 'latin1'));
    } catch {
      return false;   // Unbekannt heißt nicht "Pi 5" — nichts behaupten
    }
  }

  #zustandDatei(): string {
    return this.#o.oledZustandDatei ?? '/var/lib/asksin-analyzer/oled-state.json';
  }

  #schreibeZustand(wert: unknown): void {
    void this.#schreibe(
      this.#zustandDatei(),
      new TextEncoder().encode(`${JSON.stringify(wert)}\n`),
    ).then(
      () => {
        this.#oledFehler = 0;
      },
      (err: unknown) => {
        this.#oledFehler++;
        if (this.#oledFehler <= MAX_FEHLER) this.#fehler('oled', err);
      },
    );
  }

  /**
   * Ein Tastendruck ist erkannt worden — jetzt entscheidet die **Haltedauer**.
   *
   * Wie im Vorbild: kurz (ab 50 ms) blättert eine Seite weiter, ab 5 Sekunden
   * Halten startet der Pi neu. Dazwischen erscheint drei Sekunden lang
   * „Neustart…" auf dem Display, damit ein versehentliches langes Drücken
   * noch auffällt, bevor der Rechner weg ist.
   *
   * Gemessen wird durch Abfragen des Pegels (`gpioget`), nicht durch Zählen
   * von Flanken: Die Ausgabe von gpiomon unterscheidet sich zwischen libgpiod
   * 1 und 2, der abgefragte Pegel nicht.
   */
  async #tastendruck(): Promise<void> {
    if (this.#tasteLaeuft) return;                   // Prellen abfangen
    this.#tasteLaeuft = true;
    const beginn = this.#time.now();
    try {
      for (;;) {
        try {
          await this.#time.delay(HALTE_TAKT_MS, this.#stop?.signal);
        } catch {
          return;
        }
        const gehalten = this.#time.now() - beginn;
        if (!(await this.#tasteGedrueckt())) {
          if (gehalten >= ENTPRELLUNG_MS) this.naechsteSeite();
          return;
        }
        if (gehalten >= LANG_MS) {
          await this.#neustartAusloesen();
          return;
        }
      }
    } finally {
      this.#tasteLaeuft = false;
    }
  }

  /** Aktueller Pegel des Tasters; gedrückt = LOW (Pull-up nach 3,3 V). */
  async #tasteGedrueckt(): Promise<boolean> {
    if (this.#o.tasteGedrueckt !== undefined) return this.#o.tasteGedrueckt();
    const chip = this.#o.gpioChip ?? 'gpiochip0';
    const line = String(this.#o.tasterGpio ?? 17);
    for (const args of [
      ['--bias', 'pull-up', '-c', chip, line],       // libgpiod 2
      ['--bias=pull-up', chip, line],                // libgpiod 1
    ]) {
      const res = await this.#runner('gpioget', args);
      if (res.code === 0) return /(^|[=\s])0(\s|$)/.test(res.output.trim());
    }
    return false;
  }

  async #neustartAusloesen(): Promise<void> {
    this.#fehler('taster', 'lange gedrückt — Neustart wird ausgelöst');
    this.#neustartMeldung = true;                    // Display zeigt „Neustart…"
    this.#schreibeZustand(this.#zustandFuerAnzeige());
    try {
      await this.#time.delay(NEUSTART_MELDUNG_MS, this.#stop?.signal);
    } catch {
      /* beim Beenden trotzdem auslösen */
    }
    // Neustarten darf der Dienst nicht selbst — er läuft unprivilegiert.
    // Wie bei Update und Netzwerk übernimmt das ein Root-Helfer, der auf
    // diese Datei wartet.
    await this.#schreibe(
      this.#o.neustartDatei ?? '/var/lib/asksin-analyzer/neustart-anstoss',
      new TextEncoder().encode('Taster lange gedrückt\n'),
    ).catch((err: unknown) => this.#fehler('taster', err));
  }

  /** Zeichnet der Anzeigedienst? Sein Lebenszeichen ist die Bilddatei. */
  #anzeigedienstLaeuft(): boolean {
    const pfad = this.#o.oledBildDatei ?? '/var/lib/asksin-analyzer/oled-bild.b64';
    return (this.#o.bildVorhanden ?? existsSync)(pfad);
  }

  // ---- Taster ----------------------------------------------------------

  #tasterAbonnieren(): void {
    const abo =
      this.#o.taster ??
      ((cb: () => void): (() => void) => this.#gpiomonTaster(cb));
    try {
      this.#tasterStop = abo(() => {
        void this.#tastendruck();
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
        // `!== 'aus'`, nicht `=== 'ws2812-spi'`: Hier stand der SPI-Weg als
        // einzige gültige Betriebsart, und damit meldete jede PWM-Anlage
        // dauerhaft „LED gestört" — auch bei einwandfrei leuchtender LED.
        // Am 10.08.2026 auf dem Pi 3 aufgefallen, unmittelbar nachdem die
        // LED dort zum ersten Mal lief. Die Weboberfläche zeigt das Abzeichen
        // genau dann, wenn eine Betriebsart eingestellt ist und dieser Wert
        // false ist (HomeView.vue).
        led: this.#o.led !== 'aus' && this.#ledFehler < MAX_FEHLER,
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
