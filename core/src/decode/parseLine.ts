import { decodeFlags } from './flags.ts';
import { decodeMsgType, isHmIpType } from './msgTypes.ts';
import type {
  Firmwareantwort,
  IgnoreReason,
  ParsedLine,
  Telegram,
} from './types.ts';

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

/**
 * Anhang der erweiterten Firmware:  ;+NNNNKK
 *
 *   NNNN  Folgenummer, 16 Bit
 *   KK    8-Bit-Summe über alles davor, einschließlich der Folgenummer
 *
 * Das `+` ist unverwechselbar — keine Hexziffer, kein `:` oder `;`. Deshalb
 * lässt sich ohne jede Zweideutigkeit erkennen, wo die eigentliche Zeile
 * endet, auch wenn man den Anhang gar nicht kennt.
 *
 * Vollständige Beschreibung: asksin-sniffer-firmware/docs/protokoll.md
 */
const ANHANG_RE = /^(.*;)\+([0-9A-Fa-f]{4})([0-9A-Fa-f]{2})$/;

/** Antwort der Firmware auf einen Befehl: `:!…;` */
const ANTWORT_RE = /^:!([^;]*);$/;

/**
 * 8-Bit-Summe, wie die Firmware sie bildet.
 *
 * Muss zeichenweise mit `protokoll.cpp` übereinstimmen — beide Seiten sind
 * durch `docs/protokoll.md` gebunden. Weicht eine ab, verwirft der Analyzer
 * jede Zeile, und zwar mit dem Grund 'checksum'; das ist immerhin ein
 * sprechendes Fehlerbild.
 */
export function pruefsumme(text: string): number {
  let summe = 0;
  for (let i = 0; i < text.length; i++) {
    summe = (summe + (text.charCodeAt(i) & 0xff)) & 0xff;
  }
  return summe;
}

/**
 * Deutet eine Antwortzeile der Firmware.
 *
 * Gibt `null` zurück, wenn die Zeile keine Antwort ist — der Aufrufer parst
 * sie dann normal weiter.
 */
export function parseAntwort(raw: string): Firmwareantwort | null {
  const treffer = ANTWORT_RE.exec(raw.trim());
  if (treffer === null) return null;
  const felder = (treffer[1] ?? '').split(',');

  if (felder[0] === 'AS' && felder.length >= 5) {
    const zahl = (i: number): number => Number.parseInt(felder[i] ?? '', 10);
    const chip = felder[4] ?? '';
    return {
      art: 'version',
      protokoll: zahl(1),
      firmware: zahl(2),
      taktMHz: zahl(3),
      // '--' heißt: Das Funkmodul antwortet nicht. Bewusst null und nicht 0 —
      // 0 wäre ein Messwert, null ist „keine Antwort".
      cc1101: /^[0-9A-Fa-f]{2}$/.test(chip) ? Number.parseInt(chip, 16) : null,
    };
  }
  if (felder[0] === 'CC' && felder.length >= 2) {
    const chip = felder[1] ?? '';
    return {
      art: 'funkmodul',
      cc1101: /^[0-9A-Fa-f]{2}$/.test(chip) ? Number.parseInt(chip, 16) : null,
    };
  }
  if (felder[0] === 'E' && felder.length >= 2) {
    return { art: 'erweitert', an: felder[1] === '1' };
  }
  if (felder[0] === '?') return { art: 'unbekannter-befehl' };
  return null;
}

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

  // Antworten der Firmware zuerst: Sie sind gerahmt, aber kein Hex, und
  // liefen sonst als 'not-hex' durch — also als Fehler, obwohl sie genau das
  // sind, wonach gefragt wurde.
  const antwort = parseAntwort(line);
  if (antwort !== null) return { kind: 'antwort', antwort, raw: line };

  // Anhang abtrennen und prüfen, BEVOR der Rahmen gedeutet wird. Eine
  // verfälschte Zeile soll nicht erst als Telegramm durchgehen und dann
  // nachträglich verworfen werden — sie könnte sonst gezählt sein.
  let folge: number | undefined;
  let rumpfzeile = line;
  const anhang = ANHANG_RE.exec(line);
  if (anhang !== null) {
    const rahmen = anhang[1] as string;
    const nummer = anhang[2] as string;
    const summe = Number.parseInt(anhang[3] as string, 16);
    // Das '+' gehört MIT in die Summe. docs/protokoll.md der Firmware:
    // „8-Bit-Summe über alle Zeichen von ':' bis einschließlich der letzten
    // Ziffer der Folgenummer" — und das '+' liegt in diesem Bereich. Die
    // Firmware summiert schlicht ihren Ausgabepuffer (protokoll.cpp:69), in
    // dem es natürlich steht.
    //
    // Hier fehlte es. Der Analyzer lag damit bei jeder Zeile um genau 43
    // daneben — den ASCII-Wert von '+' — und verwarf ausnahmslos alles mit
    // dem Grund 'checksum'. Sichtbar wurde das erst am 10.08.2026, als
    // Analyzer 01 sein Funkmodul bekam: Telegramme lagen auf der Leitung,
    // in der Weboberfläche kam keines an. Vorher gab es nichts zu verwerfen.
    if (pruefsumme(`${rahmen}+${nummer}`) !== summe) return ignored('checksum', raw);
    folge = Number.parseInt(nummer, 16);
    rumpfzeile = rahmen;
  }

  if (!rumpfzeile.startsWith(':') || !rumpfzeile.endsWith(';')) {
    return ignored('no-frame', raw);
  }

  const body = rumpfzeile.slice(1, -1);
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
    return folge === undefined
      ? { kind: 'noise', noise: { ts: now(), rssi } }
      : { kind: 'noise', noise: { ts: now(), rssi }, folge };
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
    // Die Rohzeile OHNE Anhang: Sie geht in die Datenbank und in den
    // Wiedergabe-Modus, und dort soll das Format stabil bleiben, egal ob die
    // Firmware gerade erweitert läuft.
    raw: rumpfzeile,
  };

  return folge === undefined
    ? { kind: 'telegram', telegram }
    : { kind: 'telegram', telegram, folge };
}
