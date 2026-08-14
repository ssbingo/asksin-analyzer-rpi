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
  | 'implausible-rssi'
  /**
   * Anhang vorhanden, aber die Prüfsumme stimmt nicht.
   *
   * Das ist der einzige Verwurfsgrund, der eine **verfälschte** Zeile meldet
   * statt einer unverständlichen. Alle anderen bedeuten „das war nie eine
   * Telegrammzeile"; dieser bedeutet „das war eine, und unterwegs ist etwas
   * kaputtgegangen". Der Unterschied ist bei der Fehlersuche wesentlich:
   * Häufen sich Prüfsummenfehler, stimmt etwas mit der Leitung oder der
   * Baudrate nicht.
   */
  | 'checksum';

/**
 * Antwort der Firmware auf einen Befehl — `:!…;`.
 *
 * Die alte Firmware kennt keine Befehle und antwortet nie. Bleibt `antwort`
 * also aus, ist das selbst eine Auskunft: Es läuft die Originalfassung.
 */
export type Firmwareantwort =
  | {
      art: 'version';
      /** Fassung des Drahtprotokolls. */
      protokoll: number;
      /** Fassung der Firmware. */
      firmware: number;
      /** Quarzfrequenz in MHz. */
      taktMHz: number;
      /**
       * Versionsregister des CC1101, oder null, wenn das Modul nicht
       * antwortet. null heißt: Funkmodul fehlt, sitzt schief, oder SPI hängt
       * — bisher von einer ruhigen Funkstrecke nicht zu unterscheiden.
       */
      cc1101: number | null;
    }
  | {
      /**
       * Selbstauskunft des Funkmoduls beim Start — ungefragt.
       *
       * Die erweiterte Firmware sagt beim Hochlaufen, ob der CC1101
       * antwortet. Das ist beim Aufbau die erste Frage überhaupt: Ohne diese
       * Zeile ist „es kommen keine Telegramme" nicht von „es ist gerade
       * nichts los" zu unterscheiden.
       */
      art: 'funkmodul';
      /** Versionsregister, oder null wenn das Modul nicht antwortet. */
      cc1101: number | null;
    }
  | { art: 'erweitert'; an: boolean }
  | {
      /**
       * Der Empfang wurde neu aufgesetzt — ungefragt, ab Firmware 2.
       *
       * Die Firmware prüft alle 750 ms den Zustand der Ablaufsteuerung des
       * CC1101. Steht der Chip dauerhaft nicht auf Empfang, setzt sie ihn
       * zurück und meldet, **in welchem Zustand** sie ihn angetroffen hat.
       *
       * Das ist kein Betriebsereignis, sondern ein Hardwarebefund: Am
       * 14.08.2026 lieferte Analyzer 01 stundenlang keine Telegramme, während
       * die Rauschzeilen ungestört weiterliefen. Ein Analyzer, der sich
       * stillschweigend selbst heilt, verbirgt genau das.
       */
      art: 'empfang';
      /** MARCSTATE des CC1101; 0x11 = übergelaufener Empfangspuffer. */
      zustand: number;
    }
  | { art: 'unbekannter-befehl' };

export type ParsedLine =
  | {
      kind: 'telegram';
      telegram: Telegram;
      /** Folgenummer aus dem Anhang; fehlt im kompatiblen Betrieb. */
      folge?: number;
    }
  | { kind: 'noise'; noise: RssiNoise; folge?: number }
  | { kind: 'antwort'; antwort: Firmwareantwort; raw: string }
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
    checksum: 0,
    'implausible-rssi': 0,
  };
}
