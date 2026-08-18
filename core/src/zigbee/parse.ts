import type {
  ZigbeeErgebnis,
  ZigbeeIgnoreGrund,
  ZigbeePaket,
  ZigbeeTyp,
} from './types.ts';

/*
 * Zeilenformat des Mithörers (am Gerät verifiziert, 18.08.2026, 962 Pakete):
 *
 *   {"L":74,"Q":255,"R":-85,"C":11,"S":"418898FDE9FFFF6D16...."}
 *
 *   L  Länge des Rahmens in Byte, einschließlich Prüfsumme
 *   Q  LQI, 0 bis 255
 *   R  RSSI in dBm, negativ
 *   C  Kanal, 11 bis 26
 *   S  der Rahmen in Hex
 *
 * In allen 962 gemessenen Zeilen galt `L === S.length / 2` ohne Ausnahme.
 * Das wird geprüft, nicht angenommen — ein Widerspruch bedeutet, dass die
 * Zeile unterwegs beschädigt wurde.
 *
 * MAC-Kopf nach IEEE 802.15.4 (alles Mehrbyte little endian):
 *
 *   Offset  Länge  Feld
 *        0      2  FCF
 *        2      1  Folgenummer
 *        3      2  Ziel-PAN      nur wenn Zielmodus ≠ 0
 *        5    2/8  Zieladresse
 *        …      2  Quell-PAN     nur wenn Quellmodus ≠ 0 und keine Verdichtung
 *        …    2/8  Quelladresse
 *        …      2  Prüfsumme (am Ende)
 *
 * FCF, bitweise:
 *   0–2   Rahmenart      1 = Daten, 2 = Bestätigung, 3 = Kommando, 0 = Beacon
 *   3     gesichert      Nutzdaten verschlüsselt
 *   5     ackErbeten
 *   6     PAN-Verdichtung — Quell-PAN gleich Ziel-PAN und deshalb weggelassen
 *   10–11 Zielmodus      0 = keine, 2 = kurz (2 Byte), 3 = lang (8 Byte)
 *   14–15 Quellmodus     dito
 *
 * Bestätigungen tragen weder PAN noch Adressen — das ist kein Fehler, sondern
 * die Bauart. Genau daran hängt eine Selbstkontrolle: Im Mitschnitt waren
 * 425 Bestätigungen ohne PAN und 537 übrige mit genau einer PAN, und
 * 508 + 29 = 537 ging auf. Wer hier falsch abzählt, merkt es an dieser Summe.
 *
 * Die Nutzdaten bleiben verschlossen (AES-CCM*) und werden nicht angefasst.
 * Ein Netzschlüssel wird weder gebraucht noch unterstützt.
 */

const RAHMENART: Record<number, ZigbeeTyp> = {
  0: 'beacon',
  1: 'daten',
  2: 'bestaetigung',
  3: 'kommando',
};

/** Kürzester gültiger Rahmen: FCF (2) + Folgenummer (1) + Prüfsumme (2). */
const MIN_LAENGE = 5;

/** Zigbee belegt die Kanäle 11 bis 26; alles andere ist keine Messung. */
const KANAL_MIN = 11;
const KANAL_MAX = 26;

/**
 * Grenzen für RSSI. Der EFR32 liefert Werte um −20 bis −100 dBm; alles
 * außerhalb dieses großzügigen Fensters ist eine verstümmelte Zeile und
 * kein schwaches Gerät.
 */
const RSSI_MIN = -128;
const RSSI_MAX = 0;

const RUNDRUF = 'FFFF';

/** Rahmensteuerung, Ziel, Quelle, Reichweite, Folgenummer. */
const NWK_KOPF_MIN = 8;

function ignoriert(grund: ZigbeeIgnoreGrund, raw: string): ZigbeeErgebnis {
  return { kind: 'ignoriert', grund, raw };
}

/** Little endian aus dem Puffer, als Hex-Zeichenkette in Lesereihenfolge. */
function adresse(b: Uint8Array, offset: number, bytes: number): string {
  let s = '';
  for (let i = bytes - 1; i >= 0; i--) {
    s += b[offset + i]!.toString(16).padStart(2, '0');
  }
  return s.toUpperCase();
}

function le16(b: Uint8Array, offset: number): number {
  return b[offset]! | (b[offset + 1]! << 8);
}

function hexZuBytes(hex: string): Uint8Array | undefined {
  if (hex.length % 2 !== 0) return undefined;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const wert = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(wert)) return undefined;
    out[i] = wert;
  }
  return out;
}

/**
 * Eine Zeile des Mithörers in ein Paket übersetzen.
 *
 * Liefert nie `undefined` und wirft nie: Jede unbrauchbare Zeile wird mit
 * Grund verworfen, damit die Zähler stimmen.
 */
export function parseZigbeeZeile(raw: string, now: () => number): ZigbeeErgebnis {
  const zeile = raw.trim();
  if (zeile.length === 0) return ignoriert('kein-json', raw);

  let roh: unknown;
  try {
    roh = JSON.parse(zeile);
  } catch {
    return ignoriert('kein-json', raw);
  }
  if (typeof roh !== 'object' || roh === null) return ignoriert('kein-json', raw);

  const o = roh as Record<string, unknown>;
  const { L, Q, R, C, S } = o;
  if (
    typeof L !== 'number' || typeof Q !== 'number' ||
    typeof R !== 'number' || typeof C !== 'number' || typeof S !== 'string'
  ) {
    return ignoriert('felder-fehlen', raw);
  }

  if (
    !Number.isInteger(C) || C < KANAL_MIN || C > KANAL_MAX ||
    !Number.isInteger(Q) || Q < 0 || Q > 255 ||
    !Number.isInteger(R) || R < RSSI_MIN || R > RSSI_MAX
  ) {
    return ignoriert('werte-unplausibel', raw);
  }

  const b = hexZuBytes(S);
  if (b === undefined) return ignoriert('hex-ungueltig', raw);
  if (b.length !== L) return ignoriert('laenge-widerspruch', raw);
  if (b.length < MIN_LAENGE) return ignoriert('mac-unlesbar', raw);

  const fcf = le16(b, 0);
  const typ = RAHMENART[fcf & 0b111];
  if (typ === undefined) return ignoriert('mac-unlesbar', raw);

  const zielModus = (fcf >> 10) & 0b11;
  const quellModus = (fcf >> 14) & 0b11;
  const verdichtet = ((fcf >> 6) & 1) === 1;

  const paket: ZigbeePaket = {
    ts: now(),
    kanal: C,
    rssi: R,
    lqi: Q,
    laenge: L,
    typ,
    seq: b[2]!,
    rundruf: false,
    ackErbeten: ((fcf >> 5) & 1) === 1,
    gesichert: ((fcf >> 3) & 1) === 1,
  };

  // Adressfelder liegen zwischen Folgenummer und Prüfsumme.
  let i = 3;
  const ende = b.length - 2;
  const breite = (modus: number): number => (modus === 2 ? 2 : modus === 3 ? 8 : 0);

  if (zielModus === 1 || quellModus === 1) return ignoriert('mac-unlesbar', raw);

  if (zielModus !== 0) {
    if (i + 2 + breite(zielModus) > ende) return ignoriert('mac-unlesbar', raw);
    paket.pan = adresse(b, i, 2); i += 2;
    paket.an = adresse(b, i, breite(zielModus)); i += breite(zielModus);
    paket.rundruf = paket.an === RUNDRUF;
  }

  if (quellModus !== 0) {
    if (!verdichtet) {
      if (i + 2 > ende) return ignoriert('mac-unlesbar', raw);
      // Ohne Verdichtung steht hier die Quell-PAN. Sie ist für uns dieselbe
      // Angabe wie oben; ist keine Ziel-PAN vorhanden, gilt sie.
      const quellPan = adresse(b, i, 2); i += 2;
      paket.pan ??= quellPan;
    }
    if (i + breite(quellModus) > ende) return ignoriert('mac-unlesbar', raw);
    paket.von = adresse(b, i, breite(quellModus)); i += breite(quellModus);
  }

  // --- Netzebene (NWK) -----------------------------------------------------
  //
  // Nur bei Datenrahmen, und nur so weit, wie es ohne Schlüssel geht. Der
  // NWK-Kopf liegt unmittelbar hinter dem MAC-Kopf:
  //
  //   Offset  Länge  Feld
  //        0      2  Rahmensteuerung
  //        2      2  Ziel (kurz)
  //        4      2  Quelle (kurz)
  //        6      1  Reichweite
  //        7      1  Folgenummer
  //        8      8  Ziel-IEEE     nur wenn Bit 11 gesetzt
  //        …      8  Quell-IEEE    nur wenn Bit 12 gesetzt
  //
  // Was danach kommt (Mehrfachsteuerung, Quellroute, Sicherheitskopf), wird
  // nicht angefasst — dafür bräuchte es den Netzschlüssel, und den wollen
  // wir nicht.
  if (typ === 'daten' && i + NWK_KOPF_MIN <= ende) {
    const nwkFcf = le16(b, i);
    const zielIeeeDa = ((nwkFcf >> 11) & 1) === 1;
    const quellIeeeDa = ((nwkFcf >> 12) & 1) === 1;
    let j = i + 2;
    paket.nwkAn = adresse(b, j, 2); j += 2;
    paket.nwkVon = adresse(b, j, 2); j += 2;
    j += 2;                                   // Reichweite + Folgenummer
    if (zielIeeeDa) j += 8;
    if (quellIeeeDa && j + 8 <= ende) {
      paket.ieee = adresse(b, j, 8);
    }
  }

  return { kind: 'paket', paket };
}
