/**
 * BidCoS-Message-Typen.
 *
 * Quelle: `reference/AskSinAnalyzerXS/app/src/SnifferParser.ts` (getType).
 * Ab 0x80 wertet die Referenz alles als HmIP; Payload- und Flag-Semantik von
 * HmIP ist nicht bekannt (siehe `docs/serial-protocol.md`, Abschnitt 8).
 */

export const MSG_TYPES = {
  0x00: 'DEVINFO',
  0x01: 'CONFIG',
  0x02: 'RESPONSE',
  0x03: 'RESPONSE_AES',
  0x04: 'KEY_EXCHANGE',
  0x10: 'INFO',
  0x11: 'ACTION',
  0x12: 'HAVE_DATA',
  0x3e: 'SWITCH_EVENT',
  0x3f: 'TIMESTAMP',
  0x40: 'REMOTE_EVENT',
  0x41: 'SENSOR_EVENT',
  0x53: 'SENSOR_DATA',
  0x58: 'CLIMATE_EVENT',
  0x5a: 'CLIMATECTRL_EVENT',
  0x5e: 'POWER_EVENT',
  0x5f: 'POWER_EVENT_CYCLIC',
  0x70: 'WEATHER',
} as const;

export type KnownMsgTypeName = (typeof MSG_TYPES)[keyof typeof MSG_TYPES];
export type MsgTypeName = KnownMsgTypeName | 'HMIP_TYPE' | 'UNKNOWN';

/** Ab diesem Typ behandelt die Referenzimplementierung ein Telegramm als HmIP. */
export const HMIP_TYPE_MIN = 0x80;

export function isHmIpType(msgType: number): boolean {
  return msgType >= HMIP_TYPE_MIN;
}

export function decodeMsgType(msgType: number): MsgTypeName {
  if (isHmIpType(msgType)) return 'HMIP_TYPE';
  const known = (MSG_TYPES as Record<number, KnownMsgTypeName | undefined>)[msgType];
  return known ?? 'UNKNOWN';
}

/**
 * Typname exakt wie AskSinAnalyzerXS: unbekannte Typen liefern dort einen
 * leeren String. Nur für die Kompatibilitätsschicht zur Web-UI.
 */
export function toXsTypeName(msgType: number): string {
  const name = decodeMsgType(msgType);
  return name === 'UNKNOWN' ? '' : name;
}
