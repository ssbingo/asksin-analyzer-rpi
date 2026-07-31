/**
 * Systemjournal mitlesen — damit sich „lag es an uns oder am System?"
 * beantworten lässt.
 *
 * Unser eigenes Protokoll zeigt nur, was der Analyzer selbst bemerkt. Wenn
 * der Raspberry Pi einfriert oder ein Dienst vom Kernel abgeräumt wird, steht
 * der Beweis dafür im Journal von systemd — und zwar in Zeilen, die unser
 * Prozess nie zu sehen bekommt:
 *
 *   * `Under-voltage detected! (0x00050005)` — der Kernel meldet
 *     Spannungseinbrüche selbst, nicht nur `vcgencmd`.
 *   * `Out of memory: Killed process …` — der OOM-Killer. Ein so beendeter
 *     Dienst hinterlässt keine eigene Fehlermeldung.
 *   * `usb 2-1: reset SuperSpeed USB device` — die Boot-SSD hat sich neu
 *     angemeldet; wiederholt sich das, ist die Stromversorgung verdächtig.
 *   * `EXT4-fs error` — Dateisystemfehler, oft Folge harter Abstürze.
 *   * `thermal_zone0: critical temperature reached`.
 *
 * Zwei Betriebsarten:
 *
 *   1. **Fortlaufend**: Bei jedem Takt werden die seit dem letzten Mal neu
 *      hinzugekommenen Zeilen geholt (über den Journal-Cursor, deshalb ohne
 *      Doppelungen und ohne Zeitfenster-Gefummel).
 *   2. **Nach dem Start**: Der *vorherige* Systemstart wird zusammengefasst.
 *      Endete er unsauber, steht genau das im Protokoll — der stärkste
 *      Hinweis darauf, dass nicht die Anwendung, sondern das System ausfiel.
 *
 * Voraussetzung: Der Dienstbenutzer muss das Journal lesen dürfen (Gruppe
 * `systemd-journal`), und für die Zeit **vor** einem Neustart muss das Journal
 * dauerhaft gespeichert sein — auf Raspberry Pi OS ist es ab Werk flüchtig,
 * dann ist nach jedem Neustart alles weg. Beides richtet der Installer ein.
 */

import { execFile } from 'node:child_process';

export interface Systemzeile {
  text: string;
  /** Klartext des erkannten Musters, sonst null. */
  auffaellig: string | null;
}

/**
 * Muster, die auf eine Ursache außerhalb unserer Anwendung hindeuten.
 * Bewusst knapp gehalten: Jeder Treffer soll etwas bedeuten.
 */
const MUSTER: Array<[RegExp, string]> = [
  [/under[- ]?voltage/i, 'Unterspannung (Kernel)'],
  [/over[- ]?current|overcurrent/i, 'Überstrom'],
  [/out of memory|oom-killer|killed process/i, 'Speichermangel — Prozess abgeräumt'],
  // „SuperSpeed" schreibt der Kernel zusammen, „high-speed" mit Bindestrich:
  [/reset\s+\S*speed\s+usb|usb\s+[\d.-]+:\s*(reset|disconnect)/i,
   'USB-Gerät neu angemeldet'],
  [/ext4-fs error|i\/o error|blk_update_request/i, 'Dateisystem- oder Datenträgerfehler'],
  [/critical temperature|thermal shutdown/i, 'Temperaturnotabschaltung'],
  [/watchdog|hung task|kernel panic|oops|bug: /i, 'Kernel meldet schweren Fehler'],
  [/mmc\d+: .*(timeout|error)/i, 'Fehler an der SD-Karte'],
  [/segfault|general protection/i, 'Absturz eines Prozesses'],
];

/**
 * Journalctl meldet so, dass es keinen vorherigen Systemstart gibt — und
 * endet dabei mit Code 0. Ohne diese Erkennung sähe der Hinweistext wie ein
 * Logeintrag aus und der fehlende Abmeldevermerk wie ein Absturz.
 */
const KEIN_VORLAUF =
  /no persistent journal|Specifying boot ID|Data from the specified boot|not (been )?found/i;

export function bewerte(zeile: string): string | null {
  for (const [muster, text] of MUSTER) {
    if (muster.test(zeile)) return text;
  }
  return null;
}

export type Kommando = (
  cmd: string,
  args: string[],
) => Promise<{ code: number; output: string }>;

const standardKommando: Kommando = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: 15_000, maxBuffer: 4 << 20 }, (err, stdout, stderr) => {
      resolve({
        code: err === null ? 0 : typeof err.code === 'number' ? err.code : 1,
        output: `${stdout}${stderr}`,
      });
    });
  });

export interface SystemlogOptions {
  run?: Kommando;
  /** Höchstzahl Zeilen je Abruf — schützt vor Protokoll-Lawinen. */
  maxZeilen?: number;
  /** Journal-Priorität: 4 = warning und schlimmer. */
  prioritaet?: number;
}

/**
 * Liest das Systemjournal ab dem übergebenen Cursor.
 * Rückgabe: neue Zeilen **und** der neue Cursor (für den nächsten Aufruf).
 */
export class Systemlog {
  readonly #run: Kommando;
  readonly #max: number;
  readonly #prio: number;
  #cursor: string | null = null;
  #verfuegbar: boolean | null = null;

  constructor(o: SystemlogOptions = {}) {
    this.#run = o.run ?? standardKommando;
    this.#max = o.maxZeilen ?? 200;
    this.#prio = o.prioritaet ?? 4;
  }

  get cursor(): string | null {
    return this.#cursor;
  }

  set cursor(wert: string | null) {
    this.#cursor = wert;
  }

  /** Ist journalctl da und für uns lesbar? Ergebnis wird gemerkt. */
  async verfuegbar(): Promise<boolean> {
    if (this.#verfuegbar !== null) return this.#verfuegbar;
    const res = await this.#run('journalctl', ['--no-pager', '-q', '-n', '1']);
    this.#verfuegbar = res.code === 0;
    return this.#verfuegbar;
  }

  /** Neue Zeilen seit dem letzten Aufruf. */
  async neueZeilen(): Promise<Systemzeile[]> {
    if (!(await this.verfuegbar())) return [];
    const args = [
      '--no-pager',
      // -q: sonst schreibt journalctl seinen Hinweis „You are currently not
      // seeing messages from other users" mitten in die Ausgabe, und der
      // landete als vermeintliche Logzeile im Protokoll.
      '-q',
      '-o', 'short-iso',
      '-p', String(this.#prio),
      '-n', String(this.#max),
      '--show-cursor',
    ];
    if (this.#cursor !== null) args.push(`--after-cursor=${this.#cursor}`);
    const res = await this.#run('journalctl', args);
    if (res.code !== 0) return [];
    return this.#zerlege(res.output);
  }

  /**
   * Zusammenfassung des vorherigen Systemstarts. Genau hier zeigt sich, ob
   * das System selbst ausfiel: Ein sauberes Herunterfahren hinterlässt eine
   * Abmeldezeile, ein Absturz nicht.
   */
  async vorherigerStart(): Promise<{
    vorhanden: boolean;
    sauberBeendet: boolean | null;
    zeilen: Systemzeile[];
  }> {
    if (!(await this.verfuegbar())) {
      return { vorhanden: false, sauberBeendet: null, zeilen: [] };
    }
    const res = await this.#run('journalctl', [
      '--no-pager', '-q', '-b', '-1', '-p', '3', '-n', '40', '-o', 'short-iso',
    ]);
    // Ohne dauerhaftes Journal gibt es keinen vorherigen Start — journalctl
    // sagt das als Hinweistext und endet trotzdem mit Code 0. Wer das nicht
    // abfängt, meldet fälschlich „nicht sauber beendet": genau das ist am
    // 31.07.2026 passiert und hat einen Systemabsturz vorgetäuscht, den es
    // nie gab.
    if (res.code !== 0 || KEIN_VORLAUF.test(res.output)) {
      return { vorhanden: false, sauberBeendet: null, zeilen: [] };
    }
    const zeilen = this.#zerlege(res.output);
    const ende = await this.#run('journalctl', [
      '--no-pager', '-q', '-b', '-1', '-n', '15', '-o', 'short-iso',
    ]);
    const sauber = /Shutting down|Reached target.*(Power-Off|Reboot|Shutdown)|systemd-shutdown/i
      .test(ende.output);
    return { vorhanden: true, sauberBeendet: sauber, zeilen };
  }

  #zerlege(ausgabe: string): Systemzeile[] {
    const out: Systemzeile[] = [];
    for (const roh of ausgabe.split('\n')) {
      const zeile = roh.trimEnd();
      if (zeile === '') continue;
      // Die Cursor-Zeile ist Steuerinformation, kein Logeintrag.
      const m = /^-- cursor: (.+)$/.exec(zeile);
      if (m !== null) {
        this.#cursor = m[1]!.trim();
        continue;
      }
      // Kopf- und Hinweiszeilen von journalctl überspringen.
      if (zeile.startsWith('-- ')) continue;
      if (/^(Hint:|\s+(Users in groups|Pass -q))/.test(zeile)) continue;
      if (KEIN_VORLAUF.test(zeile)) continue;
      out.push({ text: zeile, auffaellig: bewerte(zeile) });
    }
    return out;
  }
}
