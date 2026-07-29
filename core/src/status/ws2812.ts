/**
 * WS2812-Status-LED über SPI (M11).
 *
 * Auf der Platine V4 führt J7 die Daten wahlweise über R4 (GPIO18, PWM)
 * oder R5 (GPIO10 = SPI-MOSI). Für den Betrieb ohne native Bibliothek wird
 * die **SPI-Variante** genutzt: R5 (0 Ω) statt R4 bestücken, SPI mit
 * 2,4 MHz — dann kodiert jedes WS2812-Bit als drei SPI-Bits:
 * `1` → 110 (~0,83 µs high), `0` → 100 (~0,42 µs high). Genau das Timing,
 * das die LED erwartet; die Vorlage (Status-LED-OLED, Modus ws2812-spi)
 * macht es identisch.
 */

export const SPI_HZ = 2_400_000;

export type Farbe = [rot: number, gruen: number, blau: number];

/** Latch: > 50 µs Leitung low vor/nach den Daten. 64 Nullbytes ≈ 213 µs. */
const LATCH_BYTES = 64;

/**
 * Kodiert eine Farbe (GRB-Reihenfolge der WS2812) als SPI-Bytestrom,
 * inklusive Latch davor und dahinter. `helligkeit` 0–100.
 */
export function kodiereWs2812(farbe: Farbe, helligkeit: number): Uint8Array {
  const faktor = Math.max(0, Math.min(100, helligkeit)) / 100;
  const [r, g, b] = farbe;
  const grb = [
    Math.round(g * faktor) & 0xff,
    Math.round(r * faktor) & 0xff,
    Math.round(b * faktor) & 0xff,
  ];

  // 24 Farbbits × 3 SPI-Bits = 72 Bits = 9 Bytes
  const daten = new Uint8Array(LATCH_BYTES + 9 + LATCH_BYTES);
  let bitPos = LATCH_BYTES * 8;
  for (const byte of grb) {
    for (let bit = 7; bit >= 0; bit--) {
      const eins = ((byte >> bit) & 1) === 1;
      // Muster: 1 x 0  (x = Farbbit)
      setzeBit(daten, bitPos++, true);
      setzeBit(daten, bitPos++, eins);
      setzeBit(daten, bitPos++, false);
    }
  }
  return daten;
}

function setzeBit(puffer: Uint8Array, pos: number, an: boolean): void {
  if (!an) return;
  puffer[pos >> 3]! |= 0x80 >> (pos & 7);
}
