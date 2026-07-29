/**
 * SSD1306-OLED (128×64, I²C) — eigener Minimaltreiber (M11).
 *
 * Kein npm-Paket, kein natives Binding: Der Framebuffer wird hier gebaut
 * und mit `i2ctransfer` (Paket i2c-tools, wie `stty` beim Seriellen) aufs
 * Display geschoben. Alles außer dem Kommandoaufruf ist rein und ohne
 * Hardware testbar; die Schrift ist visuell gegen einen gerenderten
 * Framebuffer verifiziert.
 */

import { ZEICHEN_BREITE, glyphe } from './font.ts';

export const OLED_BREITE = 128;
export const OLED_HOEHE = 64;
export const OLED_ADRESSE = 0x3c;

/** Init-Sequenz für 128×64 mit horizontalem Adressmodus. */
export function initKommandos(helligkeit: number): number[] {
  const kontrast = Math.max(1, Math.min(255, Math.round(helligkeit * 2.55)));
  return [
    0xae,             // Display aus
    0xd5, 0x80,       // Takt
    0xa8, 0x3f,       // Multiplex 64
    0xd3, 0x00,       // kein Offset
    0x40,             // Startzeile 0
    0x8d, 0x14,       // Ladungspumpe an
    0x20, 0x00,       // horizontaler Adressmodus
    0xa1, 0xc8,       // Segment-/COM-Richtung (Kopfzeile oben)
    0xda, 0x12,       // COM-Pins
    0x81, kontrast,   // Kontrast (≙ Helligkeit)
    0xd9, 0xf1,       // Precharge
    0xdb, 0x40,       // VCOM
    0xa4,             // RAM anzeigen
    0xa6,             // nicht invertiert
    0x21, 0x00, 0x7f, // Spalten 0–127
    0x22, 0x00, 0x07, // Seiten 0–7
    0xaf,             // Display an
  ];
}

export const AUS_KOMMANDO = 0xae;

/** Argumente für i2ctransfer: ein Schreibvorgang mit Steuerbyte davor. */
export function i2cTransferArgs(
  bus: number,
  adresse: number,
  steuerByte: number,
  bytes: number[] | Uint8Array,
): string[] {
  const alle = [steuerByte, ...bytes];
  return [
    '-y',
    String(bus),
    `w${alle.length}@0x${adresse.toString(16)}`,
    ...alle.map((b) => `0x${b.toString(16).padStart(2, '0')}`),
  ];
}

/** Der Framebuffer: 8 Seiten × 128 Spalten, Bit 0 = oberste Zeile der Seite. */
export class OledBild {
  readonly puffer = new Uint8Array((OLED_BREITE * OLED_HOEHE) / 8);

  leeren(): void {
    this.puffer.fill(0);
  }

  pixel(x: number, y: number, an = true): void {
    if (x < 0 || x >= OLED_BREITE || y < 0 || y >= OLED_HOEHE) return;
    const index = (y >> 3) * OLED_BREITE + x;
    const maske = 1 << (y & 7);
    if (an) this.puffer[index]! |= maske;
    else this.puffer[index]! &= ~maske;
  }

  hatPixel(x: number, y: number): boolean {
    if (x < 0 || x >= OLED_BREITE || y < 0 || y >= OLED_HOEHE) return false;
    return ((this.puffer[(y >> 3) * OLED_BREITE + x]! >> (y & 7)) & 1) === 1;
  }

  linie(y: number): void {
    for (let x = 0; x < OLED_BREITE; x++) this.pixel(x, y);
  }

  /** Text in 5×7; `skala` 2 verdoppelt jede Glyphe (10×14). */
  text(x: number, y: number, inhalt: string, skala: 1 | 2 = 1): void {
    let cx = x;
    for (const zeichen of inhalt) {
      const spalten = glyphe(zeichen);
      for (let sx = 0; sx < spalten.length; sx++) {
        const bits = spalten[sx]!;
        for (let sy = 0; sy < 8; sy++) {
          if (((bits >> sy) & 1) === 1) {
            if (skala === 1) {
              this.pixel(cx + sx, y + sy);
            } else {
              this.pixel(cx + sx * 2, y + sy * 2);
              this.pixel(cx + sx * 2 + 1, y + sy * 2);
              this.pixel(cx + sx * 2, y + sy * 2 + 1);
              this.pixel(cx + sx * 2 + 1, y + sy * 2 + 1);
            }
          }
        }
      }
      cx += ZEICHEN_BREITE * skala;
    }
  }

  /** Rechtsbündiger Text an der rechten Kante. */
  textRechts(y: number, inhalt: string, skala: 1 | 2 = 1): void {
    this.text(OLED_BREITE - inhalt.length * ZEICHEN_BREITE * skala, y, inhalt, skala);
  }
}
