import type { FlagName } from './flags.ts';
import type { MsgTypeName } from './msgTypes.ts';

/** Ein decodiertes BidCoS-/HmIP-Telegramm. */
export interface Telegram {
  /** Empfangszeit auf dem Pi, ms seit Epoch. Nicht die Sendezeit. */
  ts: number;
  /** Empfangspegel in dBm, immer negativ. */
  rssi: number;
  /** BidCoS-Längenbyte. Zählt sich selbst nicht mit, Header danach ist 9 Byte. */
  length: number;
  /** Message-Counter des Absenders. */
  msgCounter: number;
  /** Rohe Flag-Bitmaske. */
  flags: number;
  /** Decodierte Flags. Bei HmIP-Telegrammen leer — die Semantik ist unbekannt. */
  flagNames: FlagName[];
  /** Roher Message-Type. */
  msgType: number;
  msgTypeName: MsgTypeName;
  isHmIp: boolean;
  /** Absenderadresse, 6 Hex-Zeichen in Großbuchstaben. */
  from: string;
  /** Empfängeradresse, 6 Hex-Zeichen in Großbuchstaben. */
  to: string;
  /** Absenderadresse numerisch — Schlüssel für Duty-Cycle und Namensauflösung. */
  fromAddr: number;
  toAddr: number;
  /** Payload in Hex, Länge 2·(length − 9). Kann leer sein. */
  payloadHex: string;
  /** Die getrimmte Rohzeile, für Replay und Fehlersuche. */
  raw: string;
}

/** Grundrauschen des Kanals, vom Sniffer alle 750 ms ausgegeben. */
export interface RssiNoise {
  ts: number;
  rssi: number;
}

/** Grund, aus dem eine Zeile verworfen wurde. */
export type IgnoreReason =
  /** Leerzeile. */
  | 'empty'
  /** Kein `:` am Anfang oder kein `;` am Ende — z. B. Boot-Meldungen der Firmware. */
  | 'no-frame'
  /** Zeichen außerhalb von [0-9A-Fa-f] im Rahmen. */
  | 'not-hex'
  /** Ungerade Anzahl Hex-Zeichen, also kein ganzes Byte. */
  | 'odd-length'
  /** Kürzer als der 11-Byte-Header, aber keine Rauschzeile. */
  | 'too-short'
  /** Längenbyte passt nicht zur tatsächlichen Zeilenlänge. */
  | 'length-mismatch'
  /** RSSI außerhalb des physikalisch möglichen Bereichs des CC1101. */
  | 'implausible-rssi';

export type ParsedLine =
  | { kind: 'telegram'; telegram: Telegram }
  | { kind: 'noise'; noise: RssiNoise }
  | { kind: 'ignored'; reason: IgnoreReason; raw: string };

/** Zähler über verworfene Zeilen — gehört als Selbstmetrik in den Health-Endpoint. */
export type IgnoreCounters = Record<IgnoreReason, number>;

export function emptyIgnoreCounters(): IgnoreCounters {
  return {
    empty: 0,
    'no-frame': 0,
    'not-hex': 0,
    'odd-length': 0,
    'too-short': 0,
    'length-mismatch': 0,
    'implausible-rssi': 0,
  };
}
