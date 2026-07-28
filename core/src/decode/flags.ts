/**
 * BidCoS-Message-Flags.
 *
 * Quelle: `reference/AskSinAnalyzerXS/app/src/SnifferParser.ts` (getFlags).
 * Bit 0x08 ist in keiner der beiden Referenzimplementierungen belegt und wird
 * hier bewusst nicht geraten — es taucht in `unknownBits` auf.
 */

export const FLAG_BITS = {
  WKUP: 0x01,
  WKMEUP: 0x02,
  BCAST: 0x04,
  BURST: 0x10,
  BIDI: 0x20,
  RPTED: 0x40,
  RPTEN: 0x80,
} as const;

export type FlagName = keyof typeof FLAG_BITS;

/** Alle bekannten Bits als Maske — alles darüber hinaus ist undokumentiert. */
export const KNOWN_FLAG_MASK = 0x01 | 0x02 | 0x04 | 0x10 | 0x20 | 0x40 | 0x80;

const FLAG_NAMES = Object.keys(FLAG_BITS) as FlagName[];

/** Gesetzte Flags als Namen, alphabetisch sortiert (wie in AskSinAnalyzerXS). */
export function decodeFlags(flags: number): FlagName[] {
  const res: FlagName[] = [];
  for (const name of FLAG_NAMES) {
    if ((flags & FLAG_BITS[name]) !== 0) res.push(name);
  }
  return res.sort();
}

export function hasFlag(flags: number, name: FlagName): boolean {
  return (flags & FLAG_BITS[name]) !== 0;
}

/** Bits, für die kein Name bekannt ist (aktuell nur 0x08). */
export function unknownFlagBits(flags: number): number {
  return flags & ~KNOWN_FLAG_MASK;
}

/**
 * Flag-Liste exakt so, wie AskSinAnalyzerXS sie erzeugt — inklusive der
 * Eigenheit, bei `flags === 0` den Pseudo-Eintrag `HMIP_UNKNOWN` zu setzen,
 * und HmIP-Telegramme ganz ohne Flags zu lassen.
 *
 * Nur für die Kompatibilitätsschicht zur bestehenden Web-UI verwenden, nicht
 * für eigene Logik — `HMIP_UNKNOWN` ist dort auch bei reinen BidCoS-Telegrammen
 * mit Flags 0x00 gesetzt und damit inhaltlich irreführend.
 */
export function toXsFlagList(flags: number, isHmIp: boolean): string[] {
  if (isHmIp) return [];
  const res: string[] = decodeFlags(flags);
  if (flags === 0x00) res.push('HMIP_UNKNOWN');
  return res.sort();
}
