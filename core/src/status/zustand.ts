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
