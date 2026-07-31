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
import { existsSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';

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
  schreibeGeraet?: (pfad: string, daten: Uint8Array) => Promise<void>;
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

const MAX_FEHLER = 3;

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
      // SPI-Takt einmalig setzen; die Einstellung bleibt am Gerät bestehen.
      const geraet = this.#o.spiGeraet ?? '/dev/spidev0.0';
      this.#o.onAktion?.('SPI wird eingestellt', { geraet, hz: SPI_HZ });
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
      this.#takte.push(this.#oledTakt(signal));
      // Der Taster wird nur abonniert, wenn der Anzeigedienst wirklich
      // zeichnet — erkennbar an der Bilddatei, die er nach jedem Bild
      // schreibt. Ohne diese Bedingung lauschte gpiomon auf einem **offenen**
      // Eingang: GPIO17 hat weder auf der Platine noch im System einen
      // Ruhepegel, schwebt also und erzeugt aus Einstreuung fortlaufend
      // Flanken. Wer nichts angeschlossen hat, soll davon nichts abbekommen.
      if (this.#anzeigedienstLaeuft()) this.#tasterAbonnieren();
      else {
        this.#fehler(
          'oled',
          'Anzeigedienst meldet kein Bild — Taster bleibt inaktiv',
        );
      }
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
    // Wie viele Seiten es gibt, weiss der Anzeigedienst — er kennt auch die
    // Felder, die nur manchmal vorhanden sind (Lüfter, Platte). Vorher stand
    // hier die Konstante des Core, und nach Seite 9 sprang es zurueck auf 1,
    // obwohl der Dienst laengst mehr Seiten hatte.
    this.#seite = (this.#seite + 1) % this.#seitenGesamt();
    // Sofort weitergeben statt auf den naechsten Takt zu warten: Das
    // Umschalten war dadurch traege geworden.
    this.#schreibeZustand(this.#zustandFuerAnzeige());
  }

  /** Seitenzahl laut Anzeigedienst; ohne dessen Meldung die eigene. */
  #seitenGesamt(): number {
    const pfad = this.#o.oledBildDatei ?? '/var/lib/asksin-analyzer/oled-bild.b64';
    try {
      const roh = JSON.parse(
        (this.#o.leseDatei ?? ((p: string) => readFileSync(p, 'utf8')))(pfad),
      ) as { seiten?: number };
      if (typeof roh.seiten === 'number' && roh.seiten > 0) return roh.seiten;
    } catch {
      /* Anzeigedienst laeuft nicht — dann zaehlt die eigene Vorgabe */
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
        this.#o.onAktion?.('LED-Frame wird geschrieben', {
          ziel: geraet,
          farbe: muster.farbe,
          grund: muster.grund,
          bytes: daten.length,
        });
        await this.#schreibe(geraet, daten);
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
      // Solange gesetzt, zeigt der Anzeigedienst nur diese Meldung.
      ...(this.#neustartMeldung ? { meldung: 'Neustart…' } : {}),
    };
  }

  async #oledTakt(signal: AbortSignal): Promise<void> {
    let letzter = '';
    for (;;) {
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
