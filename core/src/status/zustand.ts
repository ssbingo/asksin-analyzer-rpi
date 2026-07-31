/**
 * Zustandslogik der Statusanzeige (M11) — rein und vollständig testbar:
 * Analyzer-Zustand → LED-Farbe/Muster und OLED-Seiteninhalte.
 */

import type { Farbe } from './ws2812.ts';
import { OledBild, zeichenProZeile } from './ssd1306.ts';
import type { Skala } from './ssd1306.ts';

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
  if (s.maxDutyCycle !== null && s.maxDutyCycle.percent >= 80) {
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

export const SEITEN_ANZAHL = 7;

// Seitenraster für 128 × 64 Pixel.
//
// Die Grundschrift ist 5 × 7 Pixel — auf einem 0,96-Zoll-Display rund 1,7 mm
// hoch und damit aus zwei Metern nicht mehr zu lesen. Deshalb ist der Aufbau
// jeder Seite gleich und großzügig: kleine Kopfzeile, **mittelgroße
// Beschriftung**, **großer Wert**, darunter höchstens eine kleine Fußzeile.
// Lieber eine Seite mehr zum Durchblättern als eine, die niemand entziffert.
//
//   0 …  8   Kopfzeile (Standort, Seitenzähler) — Stufe 1
//   9        Trennlinie
//  12 … 25   Beschriftung — Stufe 2 (10 Zeichen)
//  30 … 50   Wert — Stufe 3 (7 Zeichen)
//  55 … 62   Fußzeile — Stufe 1 (21 Zeichen)
const LABEL: Skala = 2;
const WERT: Skala = 3;
const LABEL_Y = 12;
const WERT_Y = 30;
const FUSS_Y = 55;

/** Eine Seite: Beschriftung, großer Wert, optionale Fußzeile. */
function seiteZeichnen(
  bild: OledBild,
  label: string,
  wert: string,
  fuss = '',
): void {
  bild.text(0, LABEL_Y, label.slice(0, zeichenProZeile(LABEL)), LABEL);
  bild.text(0, WERT_Y, wert.slice(0, zeichenProZeile(WERT)), WERT);
  if (fuss !== '') bild.text(0, FUSS_Y, fuss.slice(0, zeichenProZeile(1)));
}

/** Zeichnet die OLED-Seite `nummer` (0-basiert) in das Bild. */
export function zeichneSeite(bild: OledBild, nummer: number, s: StatusDaten): void {
  bild.leeren();
  const seite = ((nummer % SEITEN_ANZAHL) + SEITEN_ANZAHL) % SEITEN_ANZAHL;

  // Kopfzeile: Standort links, Seitenzähler rechts, Trennlinie.
  bild.text(0, 0, s.standort.slice(0, 16));
  bild.textRechts(0, `${seite + 1}/${SEITEN_ANZAHL}`);
  bild.linie(9);

  switch (seite) {
    case 0:
      seiteZeichnen(
        bild,
        s.demo ? 'Demo-Modus' : 'Sniffer',
        s.connected ? 'BEREIT' : 'GETRENNT',
        `${s.ip} v${s.version}`,
      );
      break;
    case 1:
      seiteZeichnen(bild, 'Telegramme', String(s.telegramsPerMinute), 'je Minute');
      break;
    case 2:
      seiteZeichnen(
        bild,
        'Rauschen',
        s.noiseFloor === null ? '—' : String(s.noiseFloor),
        'dBm Grundrauschen',
      );
      break;
    case 3:
      seiteZeichnen(bild, 'Geräte', String(s.deviceCount), 'aktiv im Funknetz');
      break;
    case 4:
      seiteZeichnen(
        bild,
        'Duty-Cycle',
        s.maxDutyCycle === null ? '—' : `${s.maxDutyCycle.percent.toFixed(1)}%`,
        s.maxDutyCycle === null
          ? 'noch keine Daten'
          : s.maxDutyCycle.percent >= 80
            ? '!! ALARM !!'
            : s.maxDutyCycle.name,
      );
      break;
    case 5:
      seiteZeichnen(
        bild,
        'Temperatur',
        s.system.tempC === null ? '—' : `${s.system.tempC.toFixed(0)}\u00b0C`,
        `Last ${s.system.cpuLast.toFixed(2)}  RAM ${s.system.ramFreiProzent.toFixed(0)}%`,
      );
      break;
    case 6:
      seiteZeichnen(
        bild,
        'Lüfter',
        s.system.luefterUpm === null ? '—' : String(Math.round(s.system.luefterUpm)),
        s.system.luefterUpm === null
          ? 'kein Lüfter gemeldet'
          : `U/min${s.system.diskFreiProzent === null ? '' : `  SSD ${s.system.diskFreiProzent.toFixed(0)}%`}`,
      );
      break;
  }
}
