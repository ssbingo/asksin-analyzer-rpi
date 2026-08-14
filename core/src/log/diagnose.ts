/**
 * Systemdiagnose — die Werte, an denen sich ein Absturz im Nachhinein
 * festmachen lässt.
 *
 * Anlass: Ein Analyzer wurde nach Stunden unerreichbar. Für genau diesen Fall
 * werden hier regelmäßig die Größen mitgeschrieben, die auf einem Raspberry Pi
 * erfahrungsgemäß dahinterstecken:
 *
 *   * **Unterspannung / Drosselung** (`vcgencmd get_throttled`) — mit PoE-HAT
 *     und SSD am USB die häufigste Ursache für Einfrieren und harte Neustarts.
 *     Das Bitfeld unterscheidet „tritt gerade auf" von „ist seit dem Start
 *     schon einmal aufgetreten"; beides wird ausgewertet.
 *   * **Temperatur** — ab etwa 80 °C drosselt der Pi, ab 85 °C hart.
 *   * **Arbeitsspeicher** inklusive verfügbarem Speicher und Auslagerung: Wird
 *     der Speicher knapp, greift der OOM-Killer, und der Dienst verschwindet
 *     ohne eigene Fehlermeldung.
 *   * **Dateisystem** — eine volle Systempartition legt Dienste still.
 *   * **Last und Laufzeit** als Einordnung; ein Sprung der Laufzeit auf
 *     Sekunden nach Stunden Betrieb beweist einen Neustart.
 *
 * Alles über Bordmittel gelesen, ohne Fremdbibliothek und ohne Root-Rechte.
 */

import { execFile } from 'node:child_process';
import { readFileSync, readdirSync, statfsSync } from 'node:fs';
import { freemem, loadavg, totalmem, uptime } from 'node:os';

export interface Systemwerte {
  /** Laufzeit des Systems in Sekunden. */
  laufzeitS: number;
  last1: number;
  last5: number;
  speicherGesamtMb: number;
  speicherFreiMb: number;
  /** „verfügbar" laut /proc/meminfo — aussagekräftiger als „frei". */
  speicherVerfuegbarMb: number | null;
  auslagerungBenutztMb: number | null;
  plattenFreiMb: number | null;
  temperaturC: number | null;
  /** Drehzahl des Lüfters in Umdrehungen je Minute; null ohne Lüfter. */
  luefterUpm: number | null;
  /** Rohwert von `vcgencmd get_throttled`, z. B. 0x50005. */
  drosselungRoh: number | null;
  drosselung: Drosselung | null;
  /** Speicher dieses Prozesses. */
  prozessRssMb: number;
  /**
   * Aufschlüsselung desselben Speichers — die Diagnose eines Lecks.
   *
   * Anlass: Auf Analyzer 01 wuchs `prozessRssMb` im Dauerbetrieb gleichmäßig
   * um rund 9 MB je Stunde (118 → 379 MB in 70 h), ohne Zusammenhang mit
   * Last oder Telegrammaufkommen. Aus dem RSS allein lässt sich nicht
   * ablesen, **was** wächst; aus diesen drei Zahlen schon:
   *
   *   * `heapBenutztMb` steigt   → JS-Objekte werden gehalten, die niemand
   *     mehr braucht. Dann lohnt ein Heap-Schnappschuss.
   *   * `externMb`/`pufferMb` steigen → Buffer oder native Zuordnungen; da
   *     hilft ein Heap-Schnappschuss NICHT, sie stehen nicht darin.
   *   * Alle drei flach, RSS wächst → Zersplitterung des Allokators oder
   *     etwas ausserhalb von Node (offene Deskriptoren, Kindprozesse).
   *
   * Drei Zahlen je Viertelstunde im Protokoll — billiger als jeder Versuch,
   * das Leck durch Lesen zu finden.
   */
  heapGesamtMb: number;
  heapBenutztMb: number;
  externMb: number;
  pufferMb: number;
  /** Wie viele Deskriptoren der Prozess offen hält; null, wenn nicht lesbar. */
  deskriptoren: number | null;
}

export interface Drosselung {
  unterspannungJetzt: boolean;
  drosselungJetzt: boolean;
  temperaturgrenzeJetzt: boolean;
  unterspannungSeitStart: boolean;
  drosselungSeitStart: boolean;
  temperaturgrenzeSeitStart: boolean;
}

/** Bitbelegung laut Raspberry-Pi-Dokumentation zu `get_throttled`. */
export function deuteDrosselung(roh: number): Drosselung {
  return {
    unterspannungJetzt: (roh & 0x1) !== 0,
    drosselungJetzt: (roh & 0x4) !== 0,
    temperaturgrenzeJetzt: (roh & 0x8) !== 0,
    unterspannungSeitStart: (roh & 0x10000) !== 0,
    drosselungSeitStart: (roh & 0x40000) !== 0,
    temperaturgrenzeSeitStart: (roh & 0x80000) !== 0,
  };
}

/** Klartext für die auffälligen Bits; leer, wenn alles in Ordnung ist. */
export function drosselungText(d: Drosselung): string[] {
  const out: string[] = [];
  if (d.unterspannungJetzt) out.push('Unterspannung JETZT');
  if (d.drosselungJetzt) out.push('Taktdrosselung JETZT');
  if (d.temperaturgrenzeJetzt) out.push('Temperaturgrenze JETZT');
  if (d.unterspannungSeitStart) out.push('Unterspannung seit dem Start aufgetreten');
  if (d.drosselungSeitStart) out.push('Taktdrosselung seit dem Start aufgetreten');
  if (d.temperaturgrenzeSeitStart) out.push('Temperaturgrenze seit dem Start erreicht');
  return out;
}

export interface DiagnoseOptions {
  /** Für Tests: Ersatz für den vcgencmd-Aufruf. */
  leseDrosselung?: () => Promise<number | null>;
  leseTemperatur?: () => number | null;
  leseLuefter?: () => number | null;
  leseMeminfo?: () => string | null;
  leseDeskriptoren?: () => number | null;
  plattePfad?: string;
}

function zahlAusDatei(pfad: string): number | null {
  try {
    return Number(readFileSync(pfad, 'utf8').trim());
  } catch {
    return null;
  }
}

function standardTemperatur(): number | null {
  const roh = zahlAusDatei('/sys/class/thermal/thermal_zone0/temp');
  return roh === null || !Number.isFinite(roh) ? null : roh / 1000;
}

/**
 * Drehzahl des Lüfters aus hwmon.
 *
 * Der Raspberry Pi 5 meldet seinen Lüfter als hwmon-Gerät; der Name der
 * Instanz wechselt je nach Boot-Reihenfolge, deshalb wird das Verzeichnis
 * durchsucht statt ein fester Pfad angenommen. Auch PoE-HATs mit geregeltem
 * Lüfter melden sich hier. Ohne Lüfter — etwa auf einem Pi 3 — gibt es keinen
 * Eintrag, dann bleibt der Wert null.
 */
export function leseLuefterUpm(): number | null {
  try {
    for (const eintrag of readdirSync('/sys/class/hwmon')) {
      const wert = zahlAusDatei(`/sys/class/hwmon/${eintrag}/fan1_input`);
      if (wert !== null && Number.isFinite(wert)) return wert;
    }
  } catch {
    /* kein hwmon vorhanden */
  }
  return null;
}

function standardMeminfo(): string | null {
  try {
    return readFileSync('/proc/meminfo', 'utf8');
  } catch {
    return null;
  }
}

function standardDrosselung(): Promise<number | null> {
  return new Promise((resolve) => {
    execFile('vcgencmd', ['get_throttled'], { timeout: 5000 }, (err, stdout) => {
      if (err !== null) {
        resolve(null);
        return;
      }
      const m = /throttled=0x([0-9a-fA-F]+)/.exec(stdout);
      resolve(m === null ? null : Number.parseInt(m[1]!, 16));
    });
  });
}

export function meminfoWert(text: string, schluessel: string): number | null {
  const m = new RegExp(`^${schluessel}:\\s+(\\d+) kB`, 'm').exec(text);
  return m === null ? null : Number(m[1]) / 1024;
}

export async function erhebeSystemwerte(
  o: DiagnoseOptions = {},
): Promise<Systemwerte> {
  const meminfo = (o.leseMeminfo ?? standardMeminfo)();
  const roh = await (o.leseDrosselung ?? standardDrosselung)();
  let plattenFreiMb: number | null = null;
  try {
    const s = statfsSync(o.plattePfad ?? '/');
    plattenFreiMb = (Number(s.bavail) * Number(s.bsize)) / 1024 / 1024;
  } catch {
    plattenFreiMb = null;
  }
  const [last1, last5] = loadavg();
  // Einmal abfragen, nicht fünfmal: memoryUsage() hält kurz die Schleife an.
  const speicher = process.memoryUsage();
  const auslagerungGesamt = meminfo === null ? null : meminfoWert(meminfo, 'SwapTotal');
  const auslagerungFrei = meminfo === null ? null : meminfoWert(meminfo, 'SwapFree');
  return {
    laufzeitS: Math.round(uptime()),
    last1: last1 ?? 0,
    last5: last5 ?? 0,
    speicherGesamtMb: totalmem() / 1024 / 1024,
    speicherFreiMb: freemem() / 1024 / 1024,
    speicherVerfuegbarMb:
      meminfo === null ? null : meminfoWert(meminfo, 'MemAvailable'),
    auslagerungBenutztMb:
      auslagerungGesamt === null || auslagerungFrei === null
        ? null
        : auslagerungGesamt - auslagerungFrei,
    plattenFreiMb,
    temperaturC: (o.leseTemperatur ?? standardTemperatur)(),
    luefterUpm: (o.leseLuefter ?? leseLuefterUpm)(),
    drosselungRoh: roh,
    drosselung: roh === null ? null : deuteDrosselung(roh),
    prozessRssMb: speicher.rss / MB,
    heapGesamtMb: speicher.heapTotal / MB,
    heapBenutztMb: speicher.heapUsed / MB,
    externMb: speicher.external / MB,
    pufferMb: speicher.arrayBuffers / MB,
    deskriptoren: (o.leseDeskriptoren ?? zaehleDeskriptoren)(),
  };
}

const MB = 1024 * 1024;

/**
 * Offene Dateideskriptoren dieses Prozesses.
 *
 * Steht im Verdachtsfall neben dem Speicher: Ein Leck an Deskriptoren — nicht
 * geschlossene Kindprozesse, liegengebliebene Sockets — treibt den Speicher
 * mit hoch und ist an dieser Zahl sofort zu sehen, während ein
 * Heap-Schnappschuss nichts davon zeigt.
 */
export function zaehleDeskriptoren(): number | null {
  try {
    return readdirSync(`/proc/${process.pid}/fd`).length;
  } catch {
    return null;   // kein /proc (nicht Linux) — dann eben keine Aussage
  }
}

/**
 * Bewertung für die Protokollstufe: Was ist auffällig genug, um auch bei
 * Stufe „fehler" geschrieben zu werden?
 */
export function auffaelligkeiten(w: Systemwerte): string[] {
  const out: string[] = [];
  if (w.drosselung !== null) out.push(...drosselungText(w.drosselung));
  if (w.temperaturC !== null && w.temperaturC >= 80) {
    out.push(`Temperatur ${w.temperaturC.toFixed(1)} °C — der Pi drosselt ab 80 °C`);
  }
  if (w.speicherVerfuegbarMb !== null && w.speicherVerfuegbarMb < 80) {
    out.push(`nur noch ${w.speicherVerfuegbarMb.toFixed(0)} MB Arbeitsspeicher verfügbar`);
  }
  if (w.plattenFreiMb !== null && w.plattenFreiMb < 200) {
    out.push(`nur noch ${w.plattenFreiMb.toFixed(0)} MB frei auf der Systempartition`);
  }
  if (w.last5 > 8) out.push(`Systemlast ${w.last5.toFixed(1)} (5 min)`);
  return out;
}
