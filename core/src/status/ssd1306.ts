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

/**
 * Bauhöhe des Panels in Pixeln.
 *
 * **128 × 32** ist die Adafruit PiOLED und die Vorgabe des Vorbilds
 * (Status-LED-OLED) — und damit auch hier die Vorgabe. 128 × 64 gibt es als
 * 0,96-Zoll-Modul ebenfalls häufig.
 *
 * Die Unterscheidung ist nicht kosmetisch: Multiplex-Verhältnis, COM-Pin-Lage
 * und der Seitenbereich der Init-Sequenz hängen daran, und der Framebuffer ist
 * doppelt so groß. Wird ein 32-zeiliges Panel mit den Werten für 64 Zeilen
 * angesprochen, zeigt es ein verdoppeltes, unleserliches Bild — genau danach
 * sah es aus.
 */
export type OledHoehe = 32 | 64;
export const OLED_HOEHE_VORGABE: OledHoehe = 32;

/** Vergrößerungsstufe der Pixelschrift. */
export type Skala = 1 | 2 | 3;

/** Zeichen je Zeile bei der jeweiligen Stufe — 128 / (6 · skala). */
export function zeichenProZeile(skala: Skala): number {
  return Math.floor(OLED_BREITE / (ZEICHEN_BREITE * skala));
}
export const OLED_ADRESSE = 0x3c;

/**
 * Init-Sequenz, Reihenfolge und Werte nach `Adafruit_CircuitPython_SSD1306`
 * — derselben Bibliothek, die das Vorbild (Status-LED-OLED) verwendet.
 *
 * Zwei Werte hängen an der Bauhöhe, und beide falsch zu setzen macht das Bild
 * unbrauchbar statt bloß unschön:
 *   * **Multiplex** = Höhe − 1 (0x1f bei 32, 0x3f bei 64).
 *   * **COM-Pin-Lage**: 0x02, wenn Breite > 2 × Höhe (also beim 128 × 32),
 *     sonst 0x12. Genau diese Bedingung steht auch in der Bibliothek.
 *
 * `0xad, 0x30` schaltet die interne Referenzstromquelle ein. Die
 * Adafruit-Bibliothek sendet das seit der SSD1315-Welle mit; viele günstige
 * Module bleiben ohne sie auffällig dunkel.
 */
export function initKommandos(
  helligkeit: number,
  hoehe: OledHoehe = OLED_HOEHE_VORGABE,
): number[] {
  const kontrast = Math.max(1, Math.min(255, Math.round(helligkeit * 2.55)));
  const comPins = OLED_BREITE > 2 * hoehe ? 0x02 : 0x12;
  return [
    0xae,               // Display aus
    0x20, 0x00,         // horizontaler Adressmodus
    0x40,               // Startzeile 0
    0xa1,               // Spalte 127 auf SEG0 — Kopfzeile oben
    0xa8, hoehe - 1,    // Multiplex-Verhältnis
    0xc8,               // COM-Abtastung von COM[N] nach COM0
    0xd3, 0x00,         // kein Offset
    0xda, comPins,      // COM-Pin-Lage
    0xd5, 0x80,         // Takt
    0xd9, 0xf1,         // Precharge
    0xdb, 0x30,         // VCOM-Abwahlpegel
    0x81, kontrast,     // Kontrast (≙ Helligkeit)
    0xa4,               // RAM anzeigen
    0xa6,               // nicht invertiert
    0xad, 0x30,         // interne Referenzstromquelle einschalten
    0x8d, 0x14,         // Ladungspumpe an
    0x21, 0x00, 0x7f,           // Spalten 0–127
    0x22, 0x00, hoehe / 8 - 1,  // Seitenbereich
    0xaf,               // Display an
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
  readonly hoehe: OledHoehe;
  readonly puffer: Uint8Array;

  constructor(hoehe: OledHoehe = OLED_HOEHE_VORGABE) {
    this.hoehe = hoehe;
    this.puffer = new Uint8Array((OLED_BREITE * hoehe) / 8);
  }

  leeren(): void {
    this.puffer.fill(0);
  }

  pixel(x: number, y: number, an = true): void {
    if (x < 0 || x >= OLED_BREITE || y < 0 || y >= this.hoehe) return;
    const index = (y >> 3) * OLED_BREITE + x;
    const maske = 1 << (y & 7);
    if (an) this.puffer[index]! |= maske;
    else this.puffer[index]! &= ~maske;
  }

  hatPixel(x: number, y: number): boolean {
    if (x < 0 || x >= OLED_BREITE || y < 0 || y >= this.hoehe) return false;
    return ((this.puffer[(y >> 3) * OLED_BREITE + x]! >> (y & 7)) & 1) === 1;
  }

  linie(y: number): void {
    for (let x = 0; x < OLED_BREITE; x++) this.pixel(x, y);
  }

  /**
   * Text in 5×7, ganzzahlig vergrößert.
   *
   * `skala` 1 = 5×7 (21 Zeichen je Zeile), 2 = 10×14 (10 Zeichen),
   * 3 = 15×21 (7 Zeichen). Auf einem 0,96-Zoll-Display ist die Grundgröße
   * nur rund 1,7 mm hoch — aus zwei Metern im Schrank nicht mehr lesbar.
   * Deshalb tragen Messwerte eine größere Stufe als ihre Beschriftung.
   */
  text(x: number, y: number, inhalt: string, skala: Skala = 1): void {
    let cx = x;
    for (const zeichen of inhalt) {
      const spalten = glyphe(zeichen);
      for (let sx = 0; sx < spalten.length; sx++) {
        const bits = spalten[sx]!;
        for (let sy = 0; sy < 8; sy++) {
          if (((bits >> sy) & 1) !== 1) continue;
          // Jedes Quellpixel wird zu einem skala×skala-Block.
          for (let dy = 0; dy < skala; dy++) {
            for (let dx = 0; dx < skala; dx++) {
              this.pixel(cx + sx * skala + dx, y + sy * skala + dy);
            }
          }
        }
      }
      cx += ZEICHEN_BREITE * skala;
    }
  }

  /** Rechtsbündiger Text an der rechten Kante. */
  textRechts(y: number, inhalt: string, skala: Skala = 1): void {
    this.text(OLED_BREITE - inhalt.length * ZEICHEN_BREITE * skala, y, inhalt, skala);
  }

  /** Waagerecht mittig — so setzt auch das Vorbild seine großen Werte. */
  textMitte(y: number, inhalt: string, skala: Skala = 1): void {
    const breite = inhalt.length * ZEICHEN_BREITE * skala;
    this.text(Math.max(0, Math.round((OLED_BREITE - breite) / 2)), y, inhalt, skala);
  }

  /**
   * Seitenanzeige als Punktreihe am unteren Rand.
   *
   * Als Text („3/9") bräuchte der Zähler eine eigene kleine Zeile — und genau
   * die kleinen Zeilen sind auf diesem Display nicht zu entziffern. Punkte
   * sagen dasselbe auf drei Pixel Höhe und werden auch aus der Entfernung
   * noch als Position erkannt.
   */
  punktreihe(y: number, anzahl: number, aktiv: number): void {
    const abstand = 7;
    const gesamt = anzahl * abstand - (abstand - 3);
    let x = Math.max(0, Math.round((OLED_BREITE - gesamt) / 2));
    for (let i = 0; i < anzahl; i++) {
      if (i === aktiv) {
        for (let dy = 0; dy < 3; dy++) {
          for (let dx = 0; dx < 3; dx++) this.pixel(x + dx, y + dy);
        }
      } else {
        this.pixel(x + 1, y + 1);
      }
      x += abstand;
    }
  }
}
