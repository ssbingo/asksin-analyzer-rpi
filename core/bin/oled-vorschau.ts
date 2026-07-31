#!/usr/bin/env node
/**
 * Rendert die OLED-Seiten in eine PNG-Datei — für Handbuch und Sichtprüfung.
 *
 * Warum es das gibt: Das Bild `docs/handbuch/img/oled-seiten.png` war von Hand
 * erzeugt und veraltete still, sobald sich das Seitenlayout änderte. Jetzt
 * entsteht es aus demselben Code, den auch das Gerät ausführt — was hier zu
 * sehen ist, steht so auch auf dem Display.
 *
 * Aufruf:
 *     node core/bin/oled-vorschau.ts [ziel.png] [pixelgroesse]
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

import { OLED_BREITE, OLED_HOEHE, OledBild } from '../src/status/ssd1306.ts';
import { SEITEN_ANZAHL, zeichneSeite } from '../src/status/zustand.ts';
import type { StatusDaten } from '../src/status/zustand.ts';

const BEISPIEL: StatusDaten = {
  standort: 'Büro Keller',
  version: '0.8.0',
  ip: '192.168.1.71',
  connected: true,
  demo: false,
  updateVerfuegbar: false,
  persistErrors: 0,
  telegramsPerMinute: 137,
  noiseFloor: -91,
  deviceCount: 16,
  maxDutyCycle: { name: 'Thermostat_Bad OG', percent: 3.4 },
  system: { cpuLast: 0.42, tempC: 51, ramFreiProzent: 68, diskFreiProzent: 83, luefterUpm: 3120 },
};

/** Graustufen-PNG ohne Fremdbibliothek. */
function schreibePng(pfad: string, breite: number, hoehe: number, pixel: Uint8Array): void {
  const roh = Buffer.alloc((breite + 1) * hoehe);
  for (let y = 0; y < hoehe; y++) {
    roh[y * (breite + 1)] = 0;                       // Filtertyp „keiner"
    for (let x = 0; x < breite; x++) {
      roh[y * (breite + 1) + 1 + x] = pixel[y * breite + x]!;
    }
  }
  const bloecke: Buffer[] = [];
  const block = (typ: string, daten: Buffer): void => {
    const laenge = Buffer.alloc(4);
    laenge.writeUInt32BE(daten.length);
    const inhalt = Buffer.concat([Buffer.from(typ, 'ascii'), daten]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(inhalt) >>> 0);
    bloecke.push(laenge, inhalt, crc);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(breite, 0);
  ihdr.writeUInt32BE(hoehe, 4);
  ihdr[8] = 8;                                        // 8 Bit je Kanal
  ihdr[9] = 0;                                        // Graustufen
  block('IHDR', ihdr);
  block('IDAT', deflateSync(roh));
  block('IEND', Buffer.alloc(0));
  writeFileSync(
    pfad,
    Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), ...bloecke]),
  );
}

const CRC_TABELLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(daten: Buffer): number {
  let c = -1;
  for (const b of daten) c = CRC_TABELLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return c ^ -1;
}

const ziel = process.argv[2] ?? 'oled-seiten.png';
const zoom = Number(process.argv[3] ?? 4);
const ABSTAND = 6;                                    // Rand und Lücke zwischen Seiten

const spalten = 2;
const zeilen = Math.ceil(SEITEN_ANZAHL / spalten);
const kachelB = OLED_BREITE * zoom;
const kachelH = OLED_HOEHE * zoom;
const breite = spalten * kachelB + (spalten + 1) * ABSTAND;
const hoehe = zeilen * kachelH + (zeilen + 1) * ABSTAND;

const leinwand = new Uint8Array(breite * hoehe).fill(210);   // heller Grund

const bild = new OledBild();
for (let seite = 0; seite < SEITEN_ANZAHL; seite++) {
  zeichneSeite(bild, seite, BEISPIEL);
  const sx = ABSTAND + (seite % spalten) * (kachelB + ABSTAND);
  const sy = ABSTAND + Math.floor(seite / spalten) * (kachelH + ABSTAND);
  for (let y = 0; y < OLED_HOEHE; y++) {
    for (let x = 0; x < OLED_BREITE; x++) {
      const an = bild.hatPixel(x, y);
      for (let dy = 0; dy < zoom; dy++) {
        for (let dx = 0; dx < zoom; dx++) {
          leinwand[(sy + y * zoom + dy) * breite + (sx + x * zoom + dx)] =
            an ? 255 : 20;                            // Leuchtpunkt auf Schwarz
        }
      }
    }
  }
}

schreibePng(ziel, breite, hoehe, leinwand);
console.log(`${ziel}: ${breite}×${hoehe} Pixel, ${SEITEN_ANZAHL} Seiten à ${zoom}×`);
