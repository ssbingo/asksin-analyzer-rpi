/**
 * Typen des Zigbee-Pfads.
 *
 * Bewusst getrennt von `src/decode/types.ts`: Zigbee-Kurzadressen sind zwei
 * Byte lang, BidCoS-Adressen drei. Beide als Hex-Zeichenkette in denselben
 * Topf zu werfen hieße, sie irgendwann zu verwechseln — und zwar an einer
 * Stelle, an der es niemandem auffällt.
 */

/** Rahmenart nach IEEE 802.15.4, Feld „Frame Type" im FCF. */
export type ZigbeeTyp = 'beacon' | 'daten' | 'bestaetigung' | 'kommando';

/** Ein empfangenes Funkpaket, so weit es unverschlüsselt lesbar ist. */
export interface ZigbeePaket {
  /** Empfangszeitpunkt (Millisekunden seit Epoche). */
  ts: number;
  /** Funkkanal 11 bis 26. */
  kanal: number;
  /** Empfangsstärke in dBm, immer negativ. Näher an null ist besser. */
  rssi: number;
  /** Verbindungsgüte 0 bis 255. Größer ist besser. */
  lqi: number;
  /** Länge des Rahmens in Byte, einschließlich Prüfsumme. */
  laenge: number;
  typ: ZigbeeTyp;
  /** Folgenummer des Senders, 0 bis 255. Für Wiederholungserkennung. */
  seq: number;
  /** PAN-ID des Netzes, vierstellig hex. Fehlt bei Bestätigungen. */
  pan?: string;
  /** Absender: vier Hexstellen (Kurzadresse) oder sechzehn (IEEE). */
  von?: string;
  /** Empfänger, gleiche Schreibweise. */
  an?: string;
  /** Ziel ist der Rundruf FFFF. */
  rundruf: boolean;
  /** Der Sender erwartet eine Bestätigung. */
  ackErbeten: boolean;
  /** Sicherheitsbit im FCF gesetzt (Nutzdaten verschlüsselt). */
  gesichert: boolean;
  /**
   * Absender auf Netzebene, vier Hexstellen.
   *
   * Nicht dasselbe wie `von`: `von` ist der letzte Sender auf der Funkstrecke,
   * `nwkVon` der Urheber. Bei einem weitergereichten Paket unterscheiden sie
   * sich — und für die Frage „welches Gerät sendet" zählt der Urheber.
   */
  nwkVon?: string;
  /** Empfänger auf Netzebene, vier Hexstellen. */
  nwkAn?: string;
  /**
   * IEEE-Adresse des Absenders, sechzehn Hexstellen — wenn das Paket sie
   * mitträgt.
   *
   * Zigbee überträgt sie im NWK-Kopf **unverschlüsselt**, in rund der Hälfte
   * der Datenrahmen (gemessen: 13 936 von 28 017). Damit lernt der Mithörer
   * die Zuordnung Kurzadresse → IEEE von selbst, ohne den Koordinator zu
   * fragen. Und erst über die IEEE-Adresse lassen sich die Namen aus deCONZ
   * anhängen: Kurzadressen kennt deCONZ nicht.
   */
  ieee?: string;
}

/**
 * Warum eine Zeile verworfen wurde. Jeder Grund wird gezählt und in der
 * Oberfläche ausgewiesen — eine stille Kürzung wäre eine Lüge.
 */
export type ZigbeeIgnoreGrund =
  | 'kein-json'
  | 'felder-fehlen'
  | 'werte-unplausibel'
  | 'hex-ungueltig'
  | 'laenge-widerspruch'
  | 'mac-unlesbar';

export type ZigbeeErgebnis =
  | { kind: 'paket'; paket: ZigbeePaket }
  | { kind: 'ignoriert'; grund: ZigbeeIgnoreGrund; raw: string };

export type ZigbeeIgnoreZaehler = Record<ZigbeeIgnoreGrund, number>;

export function leereIgnoreZaehler(): ZigbeeIgnoreZaehler {
  return {
    'kein-json': 0,
    'felder-fehlen': 0,
    'werte-unplausibel': 0,
    'hex-ungueltig': 0,
    'laenge-widerspruch': 0,
    'mac-unlesbar': 0,
  };
}
