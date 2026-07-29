/**
 * Zustandslogik der Statusanzeige (M11) — rein und vollständig testbar:
 * Analyzer-Zustand → LED-Farbe/Muster und OLED-Seiteninhalte.
 */

import type { Farbe } from './ws2812.ts';
import { OledBild } from './ssd1306.ts';

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

export const SEITEN_ANZAHL = 4;

/** Zeichnet die OLED-Seite `nummer` (0-basiert) in das Bild. */
export function zeichneSeite(bild: OledBild, nummer: number, s: StatusDaten): void {
  bild.leeren();
  const seite = ((nummer % SEITEN_ANZAHL) + SEITEN_ANZAHL) % SEITEN_ANZAHL;

  // Kopfzeile: Standort links, Seitenzähler rechts, Trennlinie.
  bild.text(0, 0, s.standort.slice(0, 18));
  bild.textRechts(0, `${seite + 1}/${SEITEN_ANZAHL}`);
  bild.linie(9);

  switch (seite) {
    case 0: {
      bild.text(0, 14, s.demo ? 'DEMO-MODUS' : 'AskSin-Analyzer');
      bild.text(0, 26, `IP ${s.ip}`);
      bild.text(0, 38, `Version ${s.version}`);
      bild.text(0, 52, s.connected ? 'Sniffer verbunden' : 'SNIFFER GETRENNT!');
      break;
    }
    case 1: {
      bild.text(0, 14, 'Telegramme/min');
      bild.text(0, 24, String(s.telegramsPerMinute), 2);
      bild.text(0, 44, 'Rauschen');
      bild.textRechts(44, s.noiseFloor === null ? '—' : `${s.noiseFloor} dBm`);
      bild.text(0, 54, 'Geräte');
      bild.textRechts(54, String(s.deviceCount));
      break;
    }
    case 2: {
      bild.text(0, 14, 'Duty-Cycle Spitze');
      if (s.maxDutyCycle === null) {
        bild.text(0, 30, 'noch keine Daten');
      } else {
        bild.text(0, 26, `${s.maxDutyCycle.percent.toFixed(1)} %`, 2);
        bild.text(0, 46, s.maxDutyCycle.name.slice(0, 21));
        if (s.maxDutyCycle.percent >= 80) bild.text(0, 56, '!! ALARM !!');
      }
      break;
    }
    case 3: {
      bild.text(0, 14, 'System');
      bild.text(0, 26, `Last ${s.system.cpuLast.toFixed(2)}`);
      bild.textRechts(
        26,
        s.system.tempC === null ? '' : `${s.system.tempC.toFixed(0)}°C`,
      );
      bild.text(0, 38, `RAM frei ${s.system.ramFreiProzent.toFixed(0)}%`);
      if (s.system.diskFreiProzent !== null) {
        bild.text(0, 50, `SSD frei ${s.system.diskFreiProzent.toFixed(0)}%`);
      }
      break;
    }
  }
}
