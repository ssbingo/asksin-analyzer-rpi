import { decodeFlags } from './flags.ts';
import { decodeMsgType, isHmIpType } from './msgTypes.ts';
import type { IgnoreReason, ParsedLine, Telegram } from './types.ts';

/*
 * Zeilenformat (verifiziert, siehe docs/serial-protocol.md):
 *
 *   :RRLLCCFFTTAAAAAABBBBBBP...P;      Telegramm
 *   :RR;                               Grundrauschen
 *
 * Nach dem Entfernen von ':' und ';' ergibt sich der Rumpf:
 *
 *   Offset  Länge  Feld
 *        0      2  RR  RSSI-Betrag
 *        2      2  LL  BidCoS-Längenbyte
 *        4      2  CC  Message-Counter
 *        6      2  FF  Flags
 *        8      2  TT  Message-Type
 *       10      6  AA  Absender
 *       16      6  BB  Empfänger
 *       22   2·(LL−9) Payload
 */

const OFF_RSSI = 0;
const OFF_LEN = 2;
const OFF_CNT = 4;
const OFF_FLAGS = 6;
const OFF_TYPE = 8;
const OFF_FROM = 10;
const OFF_TO = 16;
const OFF_PAYLOAD = 22;

/** Header ohne Payload: rssi, len, cnt, flags, type, from[3], to[3] = 11 Byte. */
const HEADER_HEX_LEN = OFF_PAYLOAD;

/** Das Längenbyte zählt den 9-Byte-Header nach sich mit, sich selbst nicht. */
const HEADER_BYTES_AFTER_LEN = 9;

/**
 * Der 328P überträgt den Betrag des dBm-Werts. Die Umrechnung in
 * `Radio-CC1101.h` kann konstruktionsbedingt nur Werte von 11 bis 138 liefern.
 * Alles außerhalb dieses Fensters ist keine gültige Messung, sondern ein
 * Hinweis auf eine verstümmelte Zeile.
 */
const RSSI_MAGNITUDE_MIN = 10;
const RSSI_MAGNITUDE_MAX = 140;

const HEX_RE = /^[0-9A-Fa-f]*$/;

function ignored(reason: IgnoreReason, raw: string): ParsedLine {
  return { kind: 'ignored', reason, raw };
}

function byteAt(body: string, offset: number): number {
  return parseInt(body.slice(offset, offset + 2), 16);
}

/**
 * Parst genau eine Zeile der seriellen Schnittstelle.
 *
 * Reine Funktion, wirft nie. Unbekannte oder verstümmelte Zeilen liefern
 * `kind: 'ignored'` mit einem auswertbaren Grund — der Aufrufer zählt sie,
 * bricht aber nicht ab. Boot- und Debugausgaben der Firmware laufen als
 * `no-frame` durch.
 *
 * @param raw   Rohzeile, mit oder ohne `\r\n`.
 * @param now   Zeitquelle, injizierbar für deterministische Tests.
 */
export function parseLine(raw: string, now: () => number = Date.now): ParsedLine {
  const line = raw.trim();

  if (line.length === 0) return ignored('empty', raw);
  if (!line.startsWith(':') || !line.endsWith(';')) return ignored('no-frame', raw);

  const body = line.slice(1, -1);
  if (!HEX_RE.test(body)) return ignored('not-hex', raw);
  if (body.length % 2 !== 0) return ignored('odd-length', raw);
  if (body.length < 2) return ignored('too-short', raw);

  const rssiMagnitude = byteAt(body, OFF_RSSI);
  if (rssiMagnitude < RSSI_MAGNITUDE_MIN || rssiMagnitude > RSSI_MAGNITUDE_MAX) {
    return ignored('implausible-rssi', raw);
  }
  const rssi = -rssiMagnitude;

  // Rauschzeile: exakt ein Byte im Rahmen, entspricht `line.length === 4`.
  if (body.length === 2) {
    return { kind: 'noise', noise: { ts: now(), rssi } };
  }

  if (body.length < HEADER_HEX_LEN) return ignored('too-short', raw);

  const length = byteAt(body, OFF_LEN);
  if (length < HEADER_BYTES_AFTER_LEN) return ignored('length-mismatch', raw);

  const expectedBodyLen = HEADER_HEX_LEN + 2 * (length - HEADER_BYTES_AFTER_LEN);
  if (body.length !== expectedBodyLen) return ignored('length-mismatch', raw);

  const msgType = byteAt(body, OFF_TYPE);
  const flags = byteAt(body, OFF_FLAGS);
  const hmIp = isHmIpType(msgType);
  const from = body.slice(OFF_FROM, OFF_FROM + 6).toUpperCase();
  const to = body.slice(OFF_TO, OFF_TO + 6).toUpperCase();

  const telegram: Telegram = {
    ts: now(),
    rssi,
    length,
    msgCounter: byteAt(body, OFF_CNT),
    flags,
    // Bei HmIP bleibt die Liste leer: die Flag-Semantik ist nicht bekannt.
    // Das rohe Byte steht weiterhin in `flags`.
    flagNames: hmIp ? [] : decodeFlags(flags),
    msgType,
    msgTypeName: decodeMsgType(msgType),
    isHmIp: hmIp,
    from,
    to,
    fromAddr: parseInt(from, 16),
    toAddr: parseInt(to, 16),
    payloadHex: body.slice(OFF_PAYLOAD).toUpperCase(),
    raw: line,
  };

  return { kind: 'telegram', telegram };
}
