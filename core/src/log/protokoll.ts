/**
 * Protokoll — Dateilogbuch mit Stufen, Tagesrotation und Aufbewahrung.
 *
 * Anlass: Ein Analyzer stürzte nach Stunden reproduzierbar ab und war danach
 * nicht mehr erreichbar. Ohne Aufzeichnung ist so etwas nicht zu finden — das
 * Journal von systemd hilft nur, wenn der Dienst selbst noch schreibt, und es
 * überlebt einen harten Absturz nur teilweise.
 *
 * Bewusst ohne Fremdbibliothek (der Core hat keine Laufzeitabhängigkeiten):
 *
 *   * **Stufen** `fehler` < `info` < `debug` < `alles`. Eingestellt wird die
 *     höchste Stufe, die noch geschrieben wird.
 *   * **Eine Datei je Tag** (`asksin-JJJJ-MM-TT.log`), umgeschaltet beim ersten
 *     Eintrag nach Mitternacht — kein Zeitgeber nötig.
 *   * **Aufbewahrung** in Tagen; ältere Dateien werden beim Rotieren gelöscht.
 *   * **Lesbares Format**, feste Spalten, damit `grep` und Auge gleichermaßen
 *     zurechtkommen:
 *
 *         2026-07-31 08:12:33.123  FEHLER  [ingest]     Port weg (EIO)
 *         2026-07-31 08:12:34.001  INFO    [system]     Temperatur 62,3 °C
 *
 *   * Schreibfehler dürfen den Dienst **nie** beenden: schlägt das Schreiben
 *     fehl, merkt sich das Protokoll den Fehler und läuft weiter.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { systemTime } from '../ingest/time.ts';
import type { TimeSource } from '../ingest/time.ts';

export type Stufe = 'fehler' | 'info' | 'debug' | 'alles';

/** Rang: je höher, desto gesprächiger. */
const RANG: Record<Stufe, number> = { fehler: 0, info: 1, debug: 2, alles: 3 };

export const STUFEN: Stufe[] = ['fehler', 'info', 'debug', 'alles'];

export function istStufe(wert: unknown): wert is Stufe {
  return typeof wert === 'string' && (STUFEN as string[]).includes(wert);
}

export interface ProtokollOptions {
  /** Verzeichnis der Logdateien, z. B. /var/lib/asksin-analyzer/protokoll. */
  verzeichnis: string;
  stufe?: Stufe;
  /** Aufbewahrung in Tagen (1–365). */
  tage?: number;
  time?: TimeSource;
  /** Für Tests: Anhängen an eine Datei. */
  anhaengen?: (pfad: string, text: string) => void;
  /** Zusätzliche Ausgabe, üblicherweise console.log für journald. */
  auchAuf?: (zeile: string) => void;
}

export interface Dateiinfo {
  name: string;
  groesse: number;
  datum: string;
}

const DATEI_MUSTER = /^asksin-(\d{4}-\d{2}-\d{2})\.log$/;

export class Protokoll {
  #verzeichnis: string;
  #stufe: Stufe;
  #tage: number;
  readonly #time: TimeSource;
  readonly #anhaengen: (pfad: string, text: string) => void;
  readonly #auchAuf: ((zeile: string) => void) | undefined;
  #aktuellerTag = '';
  #schreibfehler: string | null = null;
  #gezaehlt = 0;

  constructor(o: ProtokollOptions) {
    this.#verzeichnis = o.verzeichnis;
    this.#stufe = o.stufe ?? 'info';
    this.#tage = klemmeTage(o.tage ?? 14);
    this.#time = o.time ?? systemTime;
    this.#anhaengen =
      o.anhaengen ?? ((pfad, text) => appendFileSync(pfad, text, 'utf8'));
    this.#auchAuf = o.auchAuf;
  }

  get stufe(): Stufe {
    return this.#stufe;
  }

  get tage(): number {
    return this.#tage;
  }

  get schreibfehler(): string | null {
    return this.#schreibfehler;
  }

  get eintraege(): number {
    return this.#gezaehlt;
  }

  einstellen(stufe: Stufe, tage: number): void {
    this.#stufe = stufe;
    this.#tage = klemmeTage(tage);
    this.raeumeAuf();
  }

  /** Wird diese Stufe derzeit geschrieben? Spart teure Textaufbereitung. */
  schreibt(stufe: Stufe): boolean {
    return RANG[stufe] <= RANG[this.#stufe];
  }

  fehler(bereich: string, text: string, daten?: unknown): void {
    this.schreibe('fehler', bereich, text, daten);
  }

  info(bereich: string, text: string, daten?: unknown): void {
    this.schreibe('info', bereich, text, daten);
  }

  debug(bereich: string, text: string, daten?: unknown): void {
    this.schreibe('debug', bereich, text, daten);
  }

  /** Feinste Stufe („alles") — Rohdaten, Einzeltelegramme, Schleifen. */
  spur(bereich: string, text: string, daten?: unknown): void {
    this.schreibe('alles', bereich, text, daten);
  }

  schreibe(stufe: Stufe, bereich: string, text: string, daten?: unknown): void {
    if (!this.schreibt(stufe)) return;
    const jetzt = new Date(this.#time.now());
    const zeile = formatiere(jetzt, stufe, bereich, text, daten);
    this.#auchAuf?.(zeile);
    try {
      const tag = tagesschluessel(jetzt);
      if (tag !== this.#aktuellerTag) {
        mkdirSync(this.#verzeichnis, { recursive: true });
        this.#aktuellerTag = tag;
        this.raeumeAuf();
      }
      this.#anhaengen(join(this.#verzeichnis, `asksin-${tag}.log`), zeile + '\n');
      this.#gezaehlt++;
      this.#schreibfehler = null;
    } catch (err) {
      // Ein volles oder schreibgeschütztes Dateisystem darf den Analyzer
      // nicht anhalten — der Fehler wird gemerkt und im WebUI angezeigt.
      this.#schreibfehler = String(err);
    }
  }

  /** Vorhandene Logdateien, neueste zuerst. */
  dateien(): Dateiinfo[] {
    let namen: string[];
    try {
      namen = readdirSync(this.#verzeichnis);
    } catch {
      return [];
    }
    const out: Dateiinfo[] = [];
    for (const name of namen) {
      const m = DATEI_MUSTER.exec(name);
      if (m === null) continue;
      try {
        out.push({
          name,
          groesse: statSync(join(this.#verzeichnis, name)).size,
          datum: m[1]!,
        });
      } catch {
        /* verschwunden — überspringen */
      }
    }
    return out.sort((a, b) => b.datum.localeCompare(a.datum));
  }

  /**
   * Inhalt einer Logdatei. Der Name wird streng geprüft — sonst wäre der
   * Download-Endpunkt ein Pfad-Ausbruch (`../../etc/shadow`).
   */
  lies(name: string): string | null {
    if (!DATEI_MUSTER.test(name)) return null;
    const pfad = join(this.#verzeichnis, name);
    if (!existsSync(pfad)) return null;
    try {
      return readFileSync(pfad, 'utf8');
    } catch {
      return null;
    }
  }

  /** Dateien löschen, die älter als die Aufbewahrungsfrist sind. */
  raeumeAuf(): number {
    const grenze = new Date(this.#time.now());
    grenze.setDate(grenze.getDate() - (this.#tage - 1));
    const aelteste = tagesschluessel(grenze);
    let weg = 0;
    for (const d of this.dateien()) {
      if (d.datum < aelteste) {
        try {
          rmSync(join(this.#verzeichnis, d.name), { force: true });
          weg++;
        } catch {
          /* nicht löschbar — beim nächsten Mal wieder */
        }
      }
    }
    return weg;
  }
}

function klemmeTage(n: number): number {
  if (!Number.isFinite(n)) return 14;
  return Math.max(1, Math.min(365, Math.round(n)));
}

function zweistellig(n: number): string {
  return String(n).padStart(2, '0');
}

export function tagesschluessel(d: Date): string {
  return `${d.getFullYear()}-${zweistellig(d.getMonth() + 1)}-${zweistellig(d.getDate())}`;
}

/** Eine Protokollzeile in fester Spaltenbreite. */
export function formatiere(
  d: Date,
  stufe: Stufe,
  bereich: string,
  text: string,
  daten?: unknown,
): string {
  const zeit =
    `${tagesschluessel(d)} ${zweistellig(d.getHours())}:${zweistellig(d.getMinutes())}` +
    `:${zweistellig(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
  // padEnd sichert die Spalte; bei langen Bereichsnamen bleibt so mindestens
  // ein Abstand, sonst klebte der Text am Klammerende.
  const kopf = `${zeit}  ${stufe.toUpperCase().padEnd(6)}  [${bereich}]`.padEnd(45) + ' ';
  const zusatz = daten === undefined ? '' : `  ${kurzJson(daten)}`;
  // Zeilenumbrüche im Text würden das Spaltenbild zerstören.
  return `${kopf}${text.replace(/[\r\n]+/g, ' ⏎ ')}${zusatz}`;
}

function kurzJson(daten: unknown): string {
  try {
    const s = JSON.stringify(daten, (_k, v: unknown) =>
      typeof v === 'number' && !Number.isInteger(v)
        ? Number(v.toFixed(3))
        : v,
    );
    return s === undefined ? '' : s.length > 600 ? `${s.slice(0, 600)}…` : s;
  } catch {
    return '[nicht darstellbar]';
  }
}
