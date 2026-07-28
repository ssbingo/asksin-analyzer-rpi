/**
 * Testdaten für den Parser.
 *
 * ⚠️ Diese Zeilen sind **konstruiert**, nicht mitgeschnitten. Sie decken das in
 * `docs/serial-protocol.md` verifizierte Format vollständig ab, ersetzen aber
 * keinen echten Mitschnitt. Sobald M0 (Sniffer läuft, ein paar Stunden
 * Rohdaten) vorliegt, gehören echte Zeilen hier hinein — dann fallen genau die
 * Fälle auf, die man sich nicht ausdenkt: Teilzeilen nach einem Reconnect,
 * Boot-Ausgaben mitten im Strom, Kollisionsartefakte.
 */

export interface TelegramFixture {
  name: string;
  line: string;
  rssi: number;
  length: number;
  msgCounter: number;
  flags: number;
  flagNames: string[];
  msgType: number;
  msgTypeName: string;
  isHmIp: boolean;
  from: string;
  to: string;
  payloadHex: string;
}

export const TELEGRAMS: TelegramFixture[] = [
  {
    // 5A 0E 01 00 70 | 1A2B3C -> 000000 | 0102030405
    name: 'WEATHER, keine Flags, Broadcast an 000000',
    line: ':5A0E0100701A2B3C0000000102030405;',
    rssi: -90,
    length: 14,
    msgCounter: 1,
    flags: 0x00,
    flagNames: [],
    msgType: 0x70,
    msgTypeName: 'WEATHER',
    isHmIp: false,
    from: '1A2B3C',
    to: '000000',
    payloadHex: '0102030405',
  },
  {
    // 46 0B 2A A0 11 | ABCDEF -> 123456 | 0201
    name: 'ACTION mit BIDI und RPTEN',
    line: ':460B2AA011ABCDEF1234560201;',
    rssi: -70,
    length: 11,
    msgCounter: 42,
    flags: 0xa0,
    flagNames: ['BIDI', 'RPTEN'],
    msgType: 0x11,
    msgTypeName: 'ACTION',
    isHmIp: false,
    from: 'ABCDEF',
    to: '123456',
    payloadHex: '0201',
  },
  {
    // 64 10 05 10 01 | 111111 -> 222222 | 01020304050607
    name: 'CONFIG mit BURST',
    line: ':641005100111111122222201020304050607;',
    rssi: -100,
    length: 16,
    msgCounter: 5,
    flags: 0x10,
    flagNames: ['BURST'],
    msgType: 0x01,
    msgTypeName: 'CONFIG',
    isHmIp: false,
    from: '111111',
    to: '222222',
    payloadHex: '01020304050607',
  },
  {
    // 4B 09 00 02 02 | AAAAAA -> BBBBBB | (leer)
    name: 'RESPONSE, kürzestmögliches Telegramm (length = 9, keine Payload)',
    line: ':4B09000202AAAAAABBBBBB;',
    rssi: -75,
    length: 9,
    msgCounter: 0,
    flags: 0x02,
    flagNames: ['WKMEUP'],
    msgType: 0x02,
    msgTypeName: 'RESPONSE',
    isHmIp: false,
    from: 'AAAAAA',
    to: 'BBBBBB',
    payloadHex: '',
  },
  {
    // 55 1A 11 00 84 | F11223 -> F44556 | 17 Byte Payload
    name: 'HmIP (Typ >= 0x80), Flags werden nicht ausgewertet',
    line: ':551A110084F11223F445560102030405060708090A0B0C0D0E0F1011;',
    rssi: -85,
    length: 26,
    msgCounter: 17,
    flags: 0x00,
    flagNames: [],
    msgType: 0x84,
    msgTypeName: 'HMIP_TYPE',
    isHmIp: true,
    from: 'F11223',
    to: 'F44556',
    payloadHex: '0102030405060708090A0B0C0D0E0F1011',
  },
  {
    // 3C 0C 07 25 7F | 0A0B0C -> 0D0E0F | 123456
    // 0x7F ist der höchste Typ, der noch nicht als HmIP gilt — die Flags
    // werden hier also noch ausgewertet.
    name: 'unbekannter Message-Type unterhalb 0x80',
    line: ':3C0C07257F0A0B0C0D0E0F123456;',
    rssi: -60,
    length: 12,
    msgCounter: 7,
    flags: 0x25,
    flagNames: ['BCAST', 'BIDI', 'WKUP'],
    msgType: 0x7f,
    msgTypeName: 'UNKNOWN',
    isHmIp: false,
    from: '0A0B0C',
    to: '0D0E0F',
    payloadHex: '123456',
  },
];

/** Grundrauschen: `:RR;`, genau vier Zeichen. */
export const NOISE_LINES: { line: string; rssi: number }[] = [
  { line: ':5B;', rssi: -91 },
  { line: ':0B;', rssi: -11 }, // untere Grenze der CC1101-Umrechnung
  { line: ':8A;', rssi: -138 }, // obere Grenze der CC1101-Umrechnung
];

/** Zeilen, die der Parser verwerfen muss — mit dem erwarteten Grund. */
export const IGNORED_LINES: { line: string; reason: string; why: string }[] = [
  { line: '', reason: 'empty', why: 'Leerzeile' },
  { line: '   \r\n', reason: 'empty', why: 'nur Weißraum' },
  {
    line: 'AskSin++ V4.1.4 (Jan  1 2020 12:00:00)',
    reason: 'no-frame',
    why: 'Boot-Meldung der Firmware',
  },
  {
    line: ':5A0E0100701A2B3C000000010203040',
    reason: 'no-frame',
    why: 'abgeschnitten, kein Semikolon — typisch nach einem Reconnect',
  },
  { line: '5A0E01;', reason: 'no-frame', why: 'Startzeichen fehlt' },
  {
    line: ':5A0E01XX701A2B3C0000000102030405;',
    reason: 'not-hex',
    why: 'Zeichen außerhalb des Hex-Alphabets',
  },
  { line: ':5A0;', reason: 'odd-length', why: 'kein ganzes Byte' },
  { line: ':;', reason: 'too-short', why: 'leerer Rahmen' },
  {
    line: ':5A0E0100701A2B3C000000010203;',
    reason: 'length-mismatch',
    why: 'Längenbyte 0x0E verlangt 5 Byte Payload, geliefert werden 4',
  },
  {
    line: ':5A08000202AAAAAABBBBBB;',
    reason: 'length-mismatch',
    why: 'Längenbyte 0x08 ist kleiner als der 9-Byte-Header',
  },
  {
    line: ':5A0E0100701A2B3C00000001020304050607;',
    reason: 'length-mismatch',
    why: 'mehr Payload als angekündigt',
  },
  { line: ':00;', reason: 'implausible-rssi', why: '0 dBm ist physikalisch unmöglich' },
  {
    line: ':FF;',
    reason: 'implausible-rssi',
    why: 'die CC1101-Umrechnung kann keinen Betrag über 138 liefern',
  },
  {
    line: ':FF0E0100701A2B3C0000000102030405;',
    reason: 'implausible-rssi',
    why: 'unplausibler RSSI deutet auf eine verstümmelte Zeile',
  },
];

/**
 * Baut eine formal korrekte Telegrammzeile. Nützlich, um den Parser über den
 * gesamten Längenbereich zu prüfen, ohne jede Zeile von Hand abzuzählen.
 */
export function buildTelegramLine(opts: {
  rssiMagnitude: number;
  msgCounter: number;
  flags: number;
  msgType: number;
  from: string;
  to: string;
  payloadHex: string;
}): string {
  if (opts.payloadHex.length % 2 !== 0) {
    throw new Error('payloadHex muss eine gerade Anzahl Zeichen haben');
  }
  const length = 9 + opts.payloadHex.length / 2;
  const hex2 = (n: number) => n.toString(16).toUpperCase().padStart(2, '0');
  return (
    ':' +
    hex2(opts.rssiMagnitude) +
    hex2(length) +
    hex2(opts.msgCounter) +
    hex2(opts.flags) +
    hex2(opts.msgType) +
    opts.from.toUpperCase() +
    opts.to.toUpperCase() +
    opts.payloadHex.toUpperCase() +
    ';'
  );
}
