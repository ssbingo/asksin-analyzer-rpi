/**
 * Projektionen für den Kompatibilitäts-Endpunktsatz der originalen Web-UI
 * (Vertrag: docs/webui-und-updates.md, Abschnitt 2 — abgeleitet aus
 * EspService.js). Reine Funktionen, damit die Formate ohne HTTP testbar sind.
 *
 * Die CSV-Zeile ist eine Projektion der `telegrams`-Tabelle; `lognumber` ist
 * die SQLite-rowid — monoton steigend, genau was das Polling der App braucht.
 */

import { toXsFlagList } from '../decode/flags.ts';
import { isHmIpType, toXsTypeName } from '../decode/msgTypes.ts';

/** Eine Zeile der `telegrams`-Tabelle samt rowid. */
export interface TelegramRow {
  lognumber: number;
  ts: number;
  rssi: number;
  len: number;
  cnt: number;
  flags: number;
  type: number;
  from_addr: number;
  to_addr: number;
}

function hex6(addr: number): string {
  return addr.toString(16).toUpperCase().padStart(6, '0');
}

/**
 * `lognumber;tstamp;rssi;from;to;len;cnt;typ;flags` — Reihenfolge fix,
 * `tstamp` in Millisekunden, `from`/`to` als Hex (die App macht
 * `parseInt(v, 16)`), `flags` leerzeichengetrennt (die App splittet an ' ').
 */
export function toCsvLine(row: TelegramRow): string {
  const flags = toXsFlagList(row.flags, isHmIpType(row.type)).join(' ');
  return [
    row.lognumber,
    row.ts,
    row.rssi,
    hex6(row.from_addr),
    hex6(row.to_addr),
    row.len,
    row.cnt,
    toXsTypeName(row.type),
    flags,
  ].join(';');
}

/** Eine Zeile der `noise_minutes`-Tabelle. */
export interface NoiseMinuteRow {
  minute: number;
  samples: number;
  sum_rssi: number;
}

/**
 * Eintrag für `/getRSSILog`: `type: 0` ist Grundrauschen (die App filtert
 * darauf), `tstamp` in **Sekunden** (die App multipliziert mit 1000). Wir
 * führen Minutenaggregate, also ein Eintrag je Minute mit dem Mittelwert.
 */
export function toRssiLogEntry(row: NoiseMinuteRow): {
  type: number;
  tstamp: number;
  rssi: number;
} {
  return {
    type: 0,
    tstamp: row.minute * 60,
    rssi: Math.round(row.sum_rssi / row.samples),
  };
}

/**
 * `version_upper`/`version_lower` aus unserer Semver: aus `0.4.2` wird
 * upper 0 und lower 4.2 — die App baut `currentVersion = "<upper>.<lower>"`
 * daraus wieder zusammen und vergleicht beide numerisch (Update-Weiche).
 */
export function toVersionParts(version: string): { upper: number; lower: number } {
  const [major = '0', minor = '0', patch] = version.split('.');
  return {
    upper: Number(major) || 0,
    lower: Number(patch === undefined ? minor : `${minor}.${patch}`) || 0,
  };
}

/**
 * Lokale Tagesgrenzen zu `yyyymmdd` (Tages-CSV-Endpunkte). Lokale Zeit wie
 * beim Original, das je Kalendertag eine Datei auf der SD-Karte anlegte.
 * Wirft bei allem, was kein achtstelliges Datum ist.
 */
export function dayRange(yyyymmdd: string): { fromTs: number; toTs: number } {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(yyyymmdd);
  if (m === null) {
    throw new Error(`Kein Tagesdatum (yyyymmdd): ${yyyymmdd}`);
  }
  const jahr = Number(m[1]);
  const monat = Number(m[2]);
  const tag = Number(m[3]);
  const von = new Date(jahr, monat - 1, tag);
  const bis = new Date(jahr, monat - 1, tag + 1);
  if (von.getMonth() !== monat - 1 || von.getDate() !== tag) {
    throw new Error(`Kein gültiger Kalendertag: ${yyyymmdd}`);
  }
  return { fromTs: von.getTime(), toTs: bis.getTime() };
}

/** `yyyymmdd` des lokalen Kalendertags zu einem Zeitstempel. */
export function dayOf(ts: number): string {
  const d = new Date(ts);
  return (
    String(d.getFullYear()).padStart(4, '0') +
    String(d.getMonth() + 1).padStart(2, '0') +
    String(d.getDate()).padStart(2, '0')
  );
}
