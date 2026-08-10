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

/**
 * Latch: Leitung low vor und nach den Daten, damit die LED übernimmt.
 *
 * 128 Nullbytes ≈ 427 µs bei 2,4 MHz. Vorher standen hier 64 Bytes ≈ 213 µs,
 * begründet mit den „> 50 µs" aus dem Datenblatt der **ursprünglichen**
 * WS2812B. Die Revision **V5** — alles, was seit etwa 2020 verkauft wird —
 * verlangt für dieselbe Bauform **über 280 µs**. Die alte Zahl lag darunter;
 * ein solches Bauteil übernimmt die Farbe dann nie, obwohl auf der
 * Datenleitung alles richtig aussieht. Mit 427 µs sind beide Fassungen
 * bedient, und teuer ist es nicht: Der Rahmen wächst um 128 Byte.
 */
export const LATCH_BYTES = 128;

/** Was die Revision V5 mindestens verlangt — die Prüfung rechnet dagegen. */
export const LATCH_MINDEST_US = 280;

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
