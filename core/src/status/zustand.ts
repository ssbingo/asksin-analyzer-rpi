/**
 * Zustandslogik der Statusanzeige (M11) — rein und vollständig testbar:
 * Analyzer-Zustand → LED-Farbe/Muster und OLED-Seiteninhalte.
 */

import type { Farbe } from './ws2812.ts';
import { OledBild, zeichenProZeile } from './ssd1306.ts';
import type { Skala } from './ssd1306.ts';

/**
 * Ab diesem Duty-Cycle gilt ein Gerät als Dauersender.
 *
 * Dieselbe Schwelle, die auch die Status-LED rot blinken lässt — eine zweite,
 * abweichende Zahl wäre nur verwirrend.
 */
export const DUTY_ALARM_PROZENT = 80;

export interface StatusDaten {
  standort: string;
  version: string;
  ip: string;
  connected: boolean;
  demo: boolean;
  updateVerfuegbar: boolean;
  persistErrors: number;
  telegramsPerMinute: number;
  /** Grundrauschen (EWMA, dBm) oder null. */
  noiseFloor: number | null;
  deviceCount: number;
  maxDutyCycle: { name: string; percent: number } | null;
  /**
   * Geräte, die ihren Duty-Cycle ausreizen — absteigend sortiert.
   *
   * Ein einzelnes defektes Gerät kann das ganze Funknetz zustopfen; im
   * Demo-Modus heisst es „Defekt_BWM Carport (klemmt)". Am Gerät soll man
   * beim Durchblättern sehen, **welches** es ist, nicht nur dass etwas hoch
   * ist.
   */
  dutyAlarme: Array<{ name: string; percent: number }>;
  /**
   * Hört dieser Analyzer Zigbee mit, und antwortet der Stick auch?
   *
   * Optional, weil ein Analyzer ohne Mithörer die Angabe nicht liefern muss
   * und ältere Aufrufer sie nicht kennen. Fehlt sie, zeigt die Anzeige „aus" —
   * das ist die richtige Auskunft und keine Notlüge.
   */
  zigbee?: boolean;
  system: {
    cpuLast: number;        // Loadavg 1 min
    tempC: number | null;
    ramFreiProzent: number;
    diskFreiProzent: number | null;
    /** Lüfterdrehzahl in U/min; null, wenn kein Lüfter gemeldet wird. */
    luefterUpm: number | null;
  };
}

export type Blinken = 'aus' | 'langsam' | 'schnell' | 'puls';

export interface LedMuster {
  farbe: Farbe;
  blinken: Blinken;
  /** Klartext für Log/Test — sagt, WARUM diese Farbe leuchtet. */
  grund: string;
}

const GRUEN: Farbe = [0, 255, 40];
const ROT: Farbe = [255, 0, 0];
const ORANGE: Farbe = [255, 90, 0];
const BLAU: Farbe = [0, 120, 255];
const GELB: Farbe = [255, 200, 0];

/** Prioritätsleiter: Alarm > getrennt > Persistenzfehler > Demo > Update > ok. */
export function ledMuster(s: StatusDaten): LedMuster {
  if (s.maxDutyCycle !== null && s.maxDutyCycle.percent >= DUTY_ALARM_PROZENT) {
    return {
      farbe: ROT,
      blinken: 'schnell',
      grund: `Duty-Cycle-Alarm: ${s.maxDutyCycle.name}`,
    };
  }
  if (!s.connected) return { farbe: ROT, blinken: 'aus', grund: 'Sniffer getrennt' };
  if (s.persistErrors > 0) {
    return { farbe: GELB, blinken: 'langsam', grund: 'Persistenz-Fehler' };
  }
  if (s.demo) return { farbe: ORANGE, blinken: 'aus', grund: 'Demo-Modus' };
  if (s.updateVerfuegbar) {
    return { farbe: BLAU, blinken: 'puls', grund: 'Update verfügbar' };
  }
  return { farbe: GRUEN, blinken: 'aus', grund: 'alles in Ordnung' };
}

/**
 * Telegramm-Blitz: Farbe, Dauer und Mindestabstand.
 *
 * ## Wozu
 *
 * Auf der Platine zeigt D1 (an PD4 des ATmega, über R1) jedes empfangene
 * Telegramm. Die LED sitzt aber **auf** der Platine — im geschlossenen
 * Schrank sieht sie niemand. Die WS2812 steckt an der Gehäusefront und ist
 * genau dafür da: von außen zu zeigen, was drinnen los ist.
 *
 * ## Warum das keine Leitung braucht
 *
 * PD4 geht nirgends an den Pi-Stecker; ein elektrisches Abgreifen wäre ein
 * Eingriff an einer Platine, die in Produktion ist — und brächte nichts, denn
 * die WS2812 will keinen Pegel, sondern einen auf 800 kHz getakteten
 * Datenstrom. Sie hört ohnehin nur auf den Pi.
 *
 * Nötig ist der Umweg auch nicht: **Jedes** Telegramm, das D1 blinken lässt,
 * schickt die Firmware im selben Atemzug über die serielle Leitung zum Pi.
 * Der Impuls ist also längst da, nur eben als Zeile statt als Spannung.
 *
 * ## Magenta
 *
 * Die einzige Farbe, die in der Prioritätsleiter oben nicht vorkommt. Grün,
 * Rot, Orange, Blau und Gelb sagen etwas über den *Zustand* des Geräts; der
 * Blitz sagt etwas über den *Verkehr*. Zwei Aussagen, die man nicht
 * verwechseln können soll — also auch keine zwei Bedeutungen für eine Farbe.
 */
export const BLITZ_FARBE: Farbe = [255, 0, 255];

/**
 * Wie lange ein Blitz leuchtet.
 *
 * Unter etwa 30 ms nimmt das Auge im Vorbeigehen nichts mehr wahr, ab etwa
 * 150 ms wirkt es nicht mehr wie ein Blitz, sondern wie ein Farbwechsel.
 * 90 ms liegt dazwischen und ist auch bei hellem Umgebungslicht noch sicher
 * zu sehen.
 */
export const BLITZ_MS = 90;

/**
 * Kürzester Abstand zwischen zwei Blitzen.
 *
 * Ohne ihn wäre die LED bei einem Schwall durchgehend magenta — und die
 * Grundfarbe, die den *Zustand* des Geräts zeigt, nie zu sehen. Genau dann
 * wäre sie am wichtigsten: Ein Gerät, das seinen Duty-Cycle ausreizt, erzeugt
 * viele Telegramme, und die LED soll dabei rot bleiben und nicht in Magenta
 * ertrinken.
 *
 * Mit 210 ms leuchtet der Blitz höchstens 43 % der Zeit; dazwischen steht die
 * Grundfarbe immer wieder sichtbar da.
 */
export const BLITZ_TAKT_MS = 210;

/**
 * Läuft gerade ein Blitz?
 *
 * @param letztesMs Zeitpunkt des letzten gemeldeten Telegramms, oder null.
 * @param jetzt Wanduhr.
 */
export function telegrammBlitz(letztesMs: number | null, jetzt: number): LedMuster | null {
  if (letztesMs === null) return null;
  const alter = jetzt - letztesMs;
  // Ein Zeitstempel aus der Zukunft (Uhrsprung nach NTP) darf die LED nicht
  // dauerhaft magenta stellen — dann lieber kein Blitz.
  if (alter < 0 || alter >= BLITZ_MS) return null;
  return { farbe: BLITZ_FARBE, blinken: 'aus', grund: 'Telegramm empfangen' };
}

/**
 * Ist die LED in dieser Blinkphase an, und mit welchem Helligkeitsfaktor?
 * `t` in ms — die Muster leben von der Wanduhr, nicht von Zählern.
 */
export function blinkPhase(blinken: Blinken, t: number): number {
  switch (blinken) {
    case 'aus':
      return 1;
    case 'langsam':
      return t % 1600 < 800 ? 1 : 0;
    case 'schnell':
      return t % 500 < 250 ? 1 : 0;
    case 'puls': {
      // Dreieck 0,2…1,0 über 2 s — ruhiges Atmen statt hartem Blinken.
      const phase = (t % 2000) / 2000;
      const dreieck = phase < 0.5 ? phase * 2 : (1 - phase) * 2;
      return 0.2 + 0.8 * dreieck;
    }
  }
}

/**
 * Seitenaufbau nach dem Vorbild des Status-LED-OLED-Projekts.
 *
 * Dort trägt jede Wertseite **nur zwei Dinge**: ein kurzes Label oben und
 * darunter den Wert, waagerecht zentriert und in der größten Schrift, die noch
 * in die Breite passt (`_fit_font` probiert von 28 px abwärts). Kopf- und
 * Fußzeilen gibt es nicht — und genau die waren hier das Problem: Sie liefen
 * auf der Grundschrift 5 × 7 und waren auf einem 0,96-Zoll-Panel nicht mehr zu
 * entziffern.
 *
 * Deshalb jetzt auch hier: kein Kopf, kein Fuß, ein Wert je Seite, Größe
 * gesucht statt gesetzt. Die Seitennummer steht als Punktreihe am unteren
 * Rand — drei Pixel hoch und trotzdem aus der Entfernung zu erfassen. Statt
 * Zeilen zu quetschen gibt es lieber eine Seite mehr.
 */
export const SEITEN_ANZAHL = 9;

/** Kandidaten für den großen Wert: erst so groß wie möglich, dann umbrechen. */
export function passeWertAn(
  text: string,
  hoechste: Skala = 3,
): { zeilen: string[]; skala: Skala } {
  const stufen: Skala[] = hoechste === 3 ? [3, 2] : [2];
  for (const skala of stufen) {
    if (text.length <= zeichenProZeile(skala)) return { zeilen: [text], skala };
  }
  // Zu lang für eine Zeile — an einem Trenner umbrechen, damit etwa eine
  // IP-Adresse groß bleibt, statt auf die Grundschrift zu fallen.
  const breite = zeichenProZeile(2);
  const trenner = ['.', ' ', '-', '_'];
  for (let i = Math.min(breite, text.length - 1); i > 0; i--) {
    if (trenner.includes(text[i - 1]!)) {
      const rest = text.slice(i);
      if (rest.length <= breite) return { zeilen: [text.slice(0, i), rest], skala: 2 };
    }
  }
  return { zeilen: [text.slice(0, zeichenProZeile(1))], skala: 1 };
}

/** Label, Wert und Zusatz je Seite — die Reihenfolge ist die Blätterreihenfolge. */
export function seitenFelder(s: StatusDaten): Array<[string, string, string]> {
  const dc = s.maxDutyCycle;
  return [
    ['Standort', s.standort, `v${s.version}`],
    ['Sniffer', s.connected ? 'BEREIT' : 'GETRENNT', s.demo ? 'Demo-Modus' : ''],
    ['IP', s.ip, ''],
    ['Telegr/min', String(s.telegramsPerMinute), ''],
    ['Rauschen', s.noiseFloor === null ? '\u2014' : `${s.noiseFloor} dBm`, ''],
    ['Geräte', String(s.deviceCount), 'im Funknetz'],
    [
      'Duty-Cycle',
      dc === null ? '\u2014' : `${dc.percent.toFixed(1)}%`,
      dc === null
        ? 'keine Daten'
        : dc.percent >= DUTY_ALARM_PROZENT
          ? '! ALARM !'
          : dc.name,
    ],
    [
      'Temperatur',
      s.system.tempC === null ? '\u2014' : `${s.system.tempC.toFixed(0)}\u00b0C`,
      `Last ${s.system.cpuLast.toFixed(2)}`,
    ],
    [
      'Lüfter',
      s.system.luefterUpm === null ? '\u2014' : String(Math.round(s.system.luefterUpm)),
      s.system.luefterUpm === null ? 'keiner' : 'U/min',
    ],
  ];
}

/**
 * Zeichnet die OLED-Seite `nummer` (0-basiert).
 *
 * Aufbau wie beim Vorbild: kleines Label oben links, darunter **ein** Wert,
 * waagerecht zentriert und in der größten Schrift, die in die Breite passt.
 * Keine Kopf-, keine Fußzeile — die liefen auf der Grundschrift und waren auf
 * dem Panel nicht mehr zu entziffern.
 *
 * Auf dem 128 × 32 (Adafruit PiOLED, die Vorgabe) ist Platz für genau diese
 * zwei Elemente. Auf einem 128 × 64 kommt der Zusatz und eine Punktreihe als
 * Seitenanzeige hinzu.
 */
export function zeichneSeite(bild: OledBild, nummer: number, s: StatusDaten): void {
  bild.leeren();
  const seite = ((nummer % SEITEN_ANZAHL) + SEITEN_ANZAHL) % SEITEN_ANZAHL;
  const [label, wert, zusatz] = seitenFelder(s)[seite]!;
  const klein = bild.hoehe <= 32;
  const angepasst = passeWertAn(wert);

  if (klein) {
    // 32 Zeilen sind knapp. Einzeiliger Wert: Label 0–6, Wert 10–30.
    // Zweizeiliger Wert: zwei Zeilen à 14 Pixel füllen die Höhe bereits aus —
    // dann entfällt das Label, sonst würde die zweite Zeile unten abgeschnitten.
    // Der Verlust ist gering: Eine IP-Adresse und ein Standortname erklären
    // sich von selbst, ein halb abgeschnittener Wert nicht.
    const z = angepasst.zeilen;
    if (z.length > 1) {
      bild.textMitte(1, z[0]!, 2);
      bild.textMitte(17, z[1]!, 2);
      return;
    }
    bild.text(0, 0, label.slice(0, zeichenProZeile(1)));
    bild.textMitte(angepasst.skala === 3 ? 10 : 13, z[0]!, angepasst.skala);
    return;
  }

  bild.text(0, 2, label.slice(0, zeichenProZeile(2)), 2);

  if (angepasst.zeilen.length === 1) {
    bild.textMitte(24, angepasst.zeilen[0]!, angepasst.skala);
    if (zusatz !== '') bild.textMitte(48, zusatz.slice(0, zeichenProZeile(2)), 2);
  } else {
    bild.textMitte(20, angepasst.zeilen[0]!, angepasst.skala);
    bild.textMitte(40, angepasst.zeilen[1]!, angepasst.skala);
  }
  bild.punktreihe(60, SEITEN_ANZAHL, seite);
}
