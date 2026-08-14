/**
 * 328P-Firmware-Flash (M7.5) — Ablauf laut docs/webui-und-updates.md §3:
 *
 *   Ingest anhalten (macht der Aufrufer) → Reset auslösen → avrdude → fertig.
 *
 * Zwei Anbindungswege:
 *  - **HAT** (GPIO-Header): der Optiboot-Bootloader wartet nur ~1 s nach dem
 *    Reset — der Core muss GPIO4 selbst takten (300 ms LOW, dann wieder HIGH,
 *    libgpiod). gpioset v2 und v1 haben inkompatible Syntax; v2 zuerst.
 *
 *    Das Zurueckziehen auf HIGH ist kein Schoenheitsschritt. libgpiod gibt
 *    beim Beenden zwar die Anforderung frei, laesst Richtung und Pegel der
 *    Leitung aber stehen: Sie bleibt Ausgang und bleibt LOW.
 *
 *    Entscheidend ist dabei, wie der Reset verdrahtet ist: GPIO4 haengt ueber
 *    C8 (100 n) am RESET, dahinter zieht R2 (10 k) nach +3V3 (netlist.md,
 *    Netze `PI_RESET_DRV` und `RESET`). Der Reset entsteht also an der
 *    **fallenden Flanke**, nicht am Pegel — nach rund einer Millisekunde
 *    laeuft der 328P wieder. Eine liegengebliebene LOW-Leitung haelt ihn
 *    deshalb *nicht* im Reset.
 *
 *    Sie nimmt aber dem naechsten Aufruf die Flanke. Der erste Flash nach dem
 *    Systemstart gelingt, jeder weitere nicht: kein Pegelwechsel, kein Reset,
 *    der Bootloader startet nie, avrdude laeuft in `not in sync`. Ein Fehler,
 *    der beim ersten Ausprobieren nicht auffaellt — und danach immer.
 *
 *    (Gefunden am 07.08.2026 beim Nachmessen an Analyzer 05. Der erste Test
 *    hier verglich nur die Argumente, die wir bauen, nicht ihre Wirkung —
 *    derselbe Fehler wie seinerzeit bei stty. Der Test unten flasht deshalb
 *    zweimal hintereinander; genau daran faellt der alte Stand.)
 *  - **USB** (CP2102N): avrdude zieht die DTR-Leitung selbst, kein GPIO nötig.
 *
 * Baudrate 58 824, nicht 57 600 — der 8-MHz-Bootloader spricht real 58 823,5
 * (hardware/README.md, Abschnitt 2.5). Alle Kommandos laufen über einen
 * injizierbaren Runner, damit die Sequenz ohne Hardware testbar ist.
 */

import { execFile, spawn } from 'node:child_process';

export interface KommandoErgebnis {
  code: number;
  output: string;
}

export type KommandoRunner = (
  cmd: string,
  args: string[],
) => Promise<KommandoErgebnis>;

export const standardRunner: KommandoRunner = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: 120_000 }, (err, stdout, stderr) => {
      const code =
        err === null ? 0 : typeof err.code === 'number' ? err.code : 1;
      resolve({ code, output: `${stdout}${stderr}` });
    });
  });

/**
 * Wie `standardRunner`, meldet die Ausgabe aber **waehrend** des Laufs.
 *
 * Der Grund ist die Bedienbarkeit, nicht die Technik. Der Flash lief bisher in
 * einem einzigen HTTP-Aufruf: Die Oberflaeche schrieb "Flashe ..." und wartete
 * bis zum Schluss. Ob das Geraet arbeitete, haengte oder laengst fertig war,
 * liess sich von aussen nicht unterscheiden — und als der Dienst am 10.08.2026
 * tatsaechlich haengte, stand dort stundenlang dasselbe Wort.
 *
 * avrdude schreibt seinen Fortschrittsbalken fortlaufend auf die
 * Fehlerausgabe. Mit `spawn` statt `execFile` kommt er dort an, wo er
 * hingehoert: beim Anwender.
 *
 * Die Zeitgrenze bleibt dieselbe wie beim `standardRunner` — ein Flash, der
 * nach zwei Minuten nicht fertig ist, wird es nicht mehr.
 */
export function standardRunnerMitAusgabe(
  onAusgabe: (text: string) => void,
): KommandoRunner {
  return (cmd, args) =>
    new Promise((resolve) => {
      const kind = spawn(cmd, args);
      let gesammelt = '';
      const uhr = setTimeout(() => kind.kill('SIGKILL'), 120_000);

      const nimm = (stueck: Buffer): void => {
        const text = stueck.toString('utf8');
        gesammelt += text;
        onAusgabe(text);
      };
      kind.stdout.on('data', nimm);
      kind.stderr.on('data', nimm);
      // Ein Fehler auf einem Strom ohne Zuhoerer beendet den ganzen Dienst.
      // Hier waere das besonders unangenehm: Stirbt avrdude mitten im
      // Aufspielen, riss es den Analyzer mit — und die Platine bliebe mit
      // halber Firmware zurueck. Das Ende des Kindes meldet ohnehin `close`.
      kind.stdout.on('error', () => {});
      kind.stderr.on('error', () => {});

      const fertig = (code: number): void => {
        clearTimeout(uhr);
        resolve({ code, output: gesammelt });
      };
      // `error` feuert, wenn das Programm gar nicht erst startet (nicht
      // installiert). Ohne diesen Zweig bliebe das Versprechen offen — und
      // genau daran hing der Dienst schon einmal.
      kind.on('error', (fehler) => {
        gesammelt += `${String(fehler)}\n`;
        onAusgabe(`${String(fehler)}\n`);
        fertig(127);
      });
      kind.on('close', (code) => fertig(code ?? 1));
    });
}

export interface FlashOptions {
  /** Serielles Gerät, z. B. /dev/asksin-hat. */
  device: string;
  /** Reset-Weg; `auto` entscheidet am Gerätepfad (usb → dtr, sonst gpio). */
  reset?: 'gpio' | 'dtr' | 'auto';
  baud?: number;
  gpioChip?: string;
  gpioLine?: number;
  resetMs?: number;
  runCommand?: KommandoRunner;
  /** Wird bei jedem Schritt gerufen — fuer die Anzeige waehrend des Laufs. */
  onFortschritt?: (text: string) => void;
  /** Vorlauf fuer avrdude vor dem Reset; nur fuer Tests zu verkuerzen. */
  anlaufMs?: number;
}

export interface FlashErgebnis {
  ok: boolean;
  log: string;
}

/**
 * Wie lange die Leitung nach dem Impuls aktiv auf HIGH gehalten wird. Danach
 * endet `gpioset` und laesst sie auf diesem Pegel stehen — der 328P laeuft.
 * Kurz genug, dass avrdude noch in Optiboots ~1-s-Fenster kommt.
 */
/**
 * Laenge des Reset-Impulses.
 *
 * Der Reset entsteht an der FLANKE (GPIO4 haengt ueber C8 am RESET), die
 * Haltezeit ist also fuer die Wirkung gleichgueltig. Sie geht aber vom
 * Ein-Sekunden-Fenster ab, das urboot danach lauscht — deshalb so kurz wie
 * praktikabel. Frueher standen hier 300 ms, ohne Not.
 */
const RESET_MS = 50;

/** Ebenso kurz: Die Leitung muss nur wieder HIGH werden. */
const FREIGABE_MS = 50;

/**
 * Vorlauf fuer avrdude, bevor zurueckgesetzt wird.
 *
 * Lang genug, dass der Port offen ist und der erste Sync hinausgeht; kurz
 * genug, dass noch reichlich Wiederholungen folgen.
 */
/**
 * Baudrate zum Flashen — bewusst NICHT die krumme Betriebsrate 58 824.
 *
 * Am 10.08.2026 durchgemessen, Reset zuerst, dann avrdude:
 *
 *     115200  kein Sync
 *      57600  ERFOLG
 *      19200  ERFOLG
 *
 * urboot misst die Baudrate selbst (Autobaud), die Rate muss also nicht zur
 * Firmware passen. Bei 8 MHz ist 115200 aber zu schnell fuer seine
 * Zaehlschleife — sie kommt mit der Aufloesung nicht mit.
 *
 * 57600 passt zusaetzlich zu einem alten Optiboot: Der spricht bei 8 MHz real
 * 58 823,5, das sind 2,1 % Abweichung und damit innerhalb der Toleranz. Und
 * es ist eine genormte Rate, die jedes stty und jedes avrdude ohne Umweg
 * setzen kann.
 */
const FLASH_BAUD = 57_600;

/**
 * Programmer, in dieser Reihenfolge versucht.
 *
 * MiniCore schreibt seit 3.x **nicht mehr Optiboot**, sondern **urboot** —
 * und das spricht das urclock-Protokoll, nicht STK500v1:
 *
 *     328.menu.bootloader.uart0.upload.protocol=urclock
 *     ...bootloader.file=urboot/.../autobaud/.../urboot_atmega328p_pr_ee_ce.hex
 *
 * Mit `-c arduino` reden die beiden aneinander vorbei, und zwar voellig
 * gleichmaessig: An beiden Analyzern kam zehnmal hintereinander
 * `not in sync: resp=0xa0`. Ein Uebertragungsproblem sieht anders aus — bei
 * einem waeren die Antworten unterschiedlich.
 *
 * `arduino` bleibt als zweiter Versuch, weil aeltere Platinen noch Optiboot
 * tragen koennen. Der erste Versuch kostet dann ein paar Sekunden; das ist
 * der Preis dafuer, dass beide Fassungen bedient werden.
 */
const PROGRAMMER = ['urclock', 'arduino'] as const;

/**
 * Setzt eine GPIO-Leitung auf `wert` und haelt sie `ms` lang. Danach bleibt
 * sie auf diesem Pegel stehen — das ist das Verhalten von libgpiod, und genau
 * darauf bauen beide Aufrufe im Reset auf.
 *
 * `timeout` beendet `gpioset` mit 124; das ist hier der ERFOLGSFALL. Nur ein
 * anderer Code deutet auf eine unbekannte Syntax, dann kommt v1 zum Zug.
 */
async function gpioHalten(
  run: KommandoRunner,
  chip: string,
  line: number,
  wert: 0 | 1,
  ms: number,
  log: string[],
  melde: (text: string) => void = () => {},
): Promise<boolean> {
  const sekunden = (ms / 1000).toFixed(1);
  melde(`GPIO${line} → ${wert === 0 ? 'LOW' : 'HIGH'} (${ms} ms)`);
  log.push(`GPIO${line} → ${wert === 0 ? 'LOW' : 'HIGH'} (${ms} ms)`);
  const v2 = await run('timeout', [
    sekunden, 'gpioset', '-c', chip, `${line}=${wert}`,
  ]);
  if (v2.code === 0 || v2.code === 124) return true;

  melde('gpioset v2 nicht verfügbar, versuche v1-Syntax');
  log.push('gpioset v2 nicht verfügbar, versuche v1-Syntax');
  const v1 = await run('gpioset', [
    '--mode=time', `--usec=${ms * 1000}`, chip, `${line}=${wert}`,
  ]);
  if (v1.code === 0) return true;
  log.push(v1.output.trim());
  return false;
}

/** Flasht die HEX-Datei; wirft nie — Fehler stehen in `ok`/`log`. */
export async function flashFirmware(
  hexPfad: string,
  options: FlashOptions,
): Promise<FlashErgebnis> {
  const run = options.runCommand ?? standardRunner;
  const baud = options.baud ?? FLASH_BAUD;
  const chip = options.gpioChip ?? 'gpiochip0';
  const line = options.gpioLine ?? 4;
  const resetMs = options.resetMs ?? RESET_MS;
  const reset =
    options.reset === undefined || options.reset === 'auto'
      ? options.device.includes('usb')
        ? 'dtr'
        : 'gpio'
      : options.reset;

  const log: string[] = [];
  const melde = (text: string): void => options.onFortschritt?.(`${text}\n`);

  const bauArgs = (programmer: string): string[] => [
    '-c', programmer,
    '-p', 'm328p',
    '-P', options.device,
    '-b', String(baud),
    '-D',
    '-U', `flash:w:${hexPfad}:i`,
  ];

  if (reset !== 'gpio') {
    melde('Reset über DTR (übernimmt avrdude am USB-Port)');
    log.push('Reset über DTR (übernimmt avrdude am USB-Port)');
    for (const programmer of PROGRAMMER) {
      melde(`avrdude -c ${programmer} auf ${options.device} mit ${baud} Baud`);
      log.push(`avrdude -c ${programmer} auf ${options.device} mit ${baud} Baud`);
      const nurAvr = await run('avrdude', bauArgs(programmer));
      log.push(nurAvr.output.trim());
      if (nurAvr.code === 0) return { ok: true, log: log.join('\n') };
      const d = deuteAvrdude(nurAvr.output);
      if (d !== null) { melde(`\n${d}`); log.push(`\n${d}`); }
    }
    return { ok: false, log: log.join('\n') };
  }

  /*
   * Erst avrdude, DANN der Reset.
   *
   * Optiboot lauscht nach dem Reset genau eine Sekunde und springt dann ins
   * Programm. Wer vorher zuruecksetzt, muss avrdude innerhalb dieser Sekunde
   * fertig gestartet, den Port geoeffnet und die krumme Baudrate ueber
   * termios2 gesetzt haben — das ist ein Wettlauf, den man verliert.
   *
   * Am 10.08.2026 beide Male verloren: erst "resp=0x3a" (das laufende
   * Programm antwortete statt des Bootloaders), nach dem Brennen des
   * Bootloaders "resp=0x00" (niemand antwortete mehr, das Fenster war zu).
   *
   * Andersherum gibt es keinen Wettlauf: avrdude wiederholt den Sync zehnmal
   * ueber mehrere Sekunden. Faellt der Reset irgendwo dazwischen, trifft einer
   * dieser Versuche das Fenster. Das ist der uebliche Weg fuer Platinen ohne
   * DTR-Leitung.
   */
  let avr: KommandoErgebnis = { code: 1, output: '' };
  let tief = false;
  let hoch = false;

  /*
   * Erst der Reset, DANN avrdude — und moeglichst dicht hintereinander.
   *
   * urboot betritt seine Programmierschleife nur nach einem EXTERNEN Reset
   * (`sbrs r2, 1` auf MCUSR, Bit 1 = EXTRF) und loescht MCUSR dabei. Danach
   * lauscht er genau eine Sekunde; laeuft die ab, kommt er ohne neuen
   * externen Reset nie wieder.
   *
   * In dieser Sekunde misst er die Baudrate an der ERSTEN LOW-Phase auf der
   * Leitung. Deshalb muss sie beim Reset ruhig sein: Laeuft avrdude schon und
   * sendet, faellt der Reset mitten in ein Byte, urboot misst eine
   * angebrochene LOW-Phase und stellt eine falsche Rate ein.
   *
   * Genau das war der Fehler in v0.14.6. Dort habe ich die Reihenfolge
   * umgedreht, weil ich Optiboot vor mir sah — das kennt kein Autobaud und
   * ist gegen einen laufenden avrdude gleichgueltig. Gegen urboot ist es der
   * Unterschied zwischen "geht" und "geht nie".
   *
   * Nachgemessen am 10.08.2026 an Analyzer 01, urboot verifiziert im Flash:
   * mit dieser Reihenfolge und 57600 Baud meldet sich der Bootloader.
   */
  for (const programmer of PROGRAMMER) {
    tief = await gpioHalten(run, chip, line, 0, resetMs, log, melde);
    hoch = tief
      ? await gpioHalten(run, chip, line, 1, FREIGABE_MS, log, melde)
      : false;

    melde(`avrdude -c ${programmer} auf ${options.device} mit ${baud} Baud`);
    log.push(`avrdude -c ${programmer} auf ${options.device} mit ${baud} Baud`);
    avr = await run('avrdude', bauArgs(programmer));

    if (avr.code === 0) break;
    log.push(avr.output.trim());
    const zwischen = deuteAvrdude(avr.output);
    if (zwischen !== null) { melde(`\n${zwischen}`); log.push(`\n${zwischen}`); }
  }

  // Der Ausgang haengt an avrdude, nicht an der Leitung.
  //
  // Frueher brach die Funktion vor avrdude ab, wenn sich GPIO nicht schalten
  // liess — das ging, solange der Reset vorher kam. Jetzt laeuft avrdude
  // zuerst, und dann waere "fehlgeschlagen" schlicht falsch: Die Firmware
  // kann laengst geschrieben sein. Ein Hinweis gehoert trotzdem dazu, denn
  // eine liegengebliebene LOW-Leitung nimmt dem naechsten Flash die Flanke.
  if (!tief || !hoch) {
    log.push(
      `\nHinweis: GPIO${line} liess sich nicht vollstaendig schalten. ` +
        `Bleibt die Leitung auf LOW, findet der naechste Flash keine fallende ` +
        `Flanke. Von Hand loesen: sudo pinctrl set ${line} ip pu`,
    );
  }
  log.push(avr.output.trim());
  const deutung = deuteAvrdude(avr.output);
  if (deutung !== null) { melde(`\n${deutung}`); log.push(`\n${deutung}`); }
  return { ok: avr.code === 0, log: log.join('\n') };
}

/**
 * Uebersetzt die haeufigsten avrdude-Meldungen in einen Befund.
 *
 * `not in sync: resp=0x3a` ist die luecklichste davon, weil sie aussieht wie
 * ein Uebertragungsproblem und keines ist: 0x3a ist das Zeichen `:`, also der
 * Anfang einer ganz normalen Ausgabezeile des Sniffers. avrdude hoert das
 * laufende Programm statt des Bootloaders — es gibt schlicht keinen.
 *
 * Wie er abhanden kommt, ist die eigentliche Falle: "Hochladen mit
 * Programmer" in der Arduino IDE ruft avrdude ohne `-D` auf, und `-D` schaltet
 * das automatische Loeschen *ab*. Es ist also die Voreinstellung — der Chip
 * wird vollstaendig geloescht, Bootloader eingeschlossen. Ein ausgeschriebenes
 * `-e` steht nirgends; wer danach sucht, findet nichts und schliesst das
 * Falsche. (Genau das ist mir am 09.08.2026 passiert, und die Falschaussage
 * stand einen Tag lang im Handbuch.)
 */
export function deuteAvrdude(ausgabe: string): string | null {
  if (/not in sync: resp=0xa0/.test(ausgabe)) {
    return (
      'Befund: Der Bootloader spricht ein anderes Protokoll. MiniCore schreibt '
      + 'seit Fassung 3 nicht mehr Optiboot, sondern **urboot** — und das '
      + 'spricht urclock, nicht STK500v1.\n'
      + 'Gleichbleibendes 0xa0 ueber alle zehn Versuche ist genau das Bild: '
      + 'Bei einem Uebertragungsproblem waeren die Antworten unterschiedlich.\n'
      + 'Der Analyzer versucht urclock von sich aus zuerst; kommt diese Meldung '
      + 'trotzdem, ist das avrdude auf diesem Geraet zu alt dafuer '
      + '(urclock gibt es ab avrdude 7.1).'
    );
  }
  if (/uP_table does not know mcuid/.test(ausgabe)) {
    return (
      'Befund: Auf dem 328P ist kein Bootloader. avrdude hat die laufende '
      + 'Ausgabe des Sniffers als Antwort gedeutet und daraus eine Kennung '
      + 'errechnet, die es nicht gibt.\n'
      + 'Abhilfe: Einmalig den Bootloader ueber den USBasp brennen — Handbuch '
      + '7.7 beschreibt die Reihenfolge, deploy/bootloader-brennen.sh erledigt '
      + 'es vom Pi aus.'
    );
  }
  if (/not in sync: resp=0x3a/.test(ausgabe)) {
    return (
      'Befund: Auf dem 328P ist kein Bootloader. 0x3a ist das Zeichen ":" — ' +
      'avrdude hört die laufende Ausgabe des Sniffers statt einer Antwort des ' +
      'Bootloaders.\n' +
      'Ursache ist fast immer "Hochladen mit Programmer" in der Arduino IDE: ' +
      'Das löscht den Chip vollständig, Bootloader eingeschlossen.\n' +
      'Abhilfe: Einmalig den Bootloader brennen, danach die Firmware wieder ' +
      'von hier aus aufspielen — dieser Weg lässt ihn stehen. Handbuch 7.7 ' +
      'beschreibt die Reihenfolge; deploy/bootloader-brennen.sh erledigt das ' +
      'Brennen vom Pi aus, ohne PC.'
    );
  }
  if (/not in sync/.test(ausgabe)) {
    return (
      'Befund: Der Bootloader antwortet nicht. Entweder greift der Reset ' +
      'nicht, oder die Platine sitzt nicht richtig. Handbuch 7.6.'
    );
  }
  if (/can't open device|Permission denied/i.test(ausgabe)) {
    return (
      'Befund: Die serielle Schnittstelle liess sich nicht öffnen. Läuft ein ' +
      'zweiter Zugriff darauf? Handbuch 23.'
    );
  }
  return null;
}

/** Grobe Plausibilität: sieht der Upload nach Intel-HEX aus? */
export function siehtNachIntelHexAus(inhalt: Buffer): boolean {
  const text = inhalt.toString('latin1');
  if (!text.startsWith(':')) return false;
  const zeilen = text.split(/\r?\n/).filter((z) => z.length > 0);
  return (
    zeilen.length > 0 &&
    zeilen.every((z) => /^:[0-9A-Fa-f]{10,}$/.test(z)) &&
    zeilen.at(-1) === ':00000001FF'
  );
}
