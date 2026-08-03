/**
 * Auswertung eines Mitschnitts — die Grundlinie in Zahlen.
 *
 * Der Zweck ist ein Vorher-Nachher-Vergleich zweier Firmware-Fassungen. Was
 * dabei zählt, ist nicht „läuft" oder „läuft nicht" — das sieht man ohnehin —,
 * sondern die Größen, die sich schleichend verschlechtern können:
 *
 *   Rauschtakt      Der Sniffer sendet alle 750 ms eine Pegelzeile. Dieser
 *                   Takt ist der ehrlichste Gesundheitswert, den wir haben:
 *                   Er hängt nur an der Firmware, nicht am Funkverkehr. Wird
 *                   er unruhig, ist etwas mit den Zeitscheiben nicht in
 *                   Ordnung — lange bevor Telegramme fehlen.
 *
 *   Lücken          Zeiträume ohne jede Zeile. Sie sind heute UNSICHTBAR: Der
 *                   Analyzer kann eine verlorene Zeile nicht von Funkstille
 *                   unterscheiden. Genau das soll die laufende Nummer
 *                   (Verbesserung 2) beheben — hier wird gemessen, wie oft es
 *                   überhaupt vorkommt.
 *
 *   Verworfene      Zeilen, die der Parser nicht deuten kann, nach Grund.
 *                   Heute die einzige Spur von Übertragungsfehlern.
 *
 * Wichtig für die Deutung: Telegrammzahl und Pegel hängen davon ab, was in
 * der Wohnung gerade funkt. Zwei Mitschnitte an verschiedenen Tagen sind
 * darin **nicht** vergleichbar. Rauschtakt, Lücken und Verworfene dagegen
 * schon — sie sind Eigenschaften der Strecke, nicht des Funkverkehrs.
 */

import { parseLine } from '../decode/parseLine.ts';
import type { IgnoreReason } from '../decode/types.ts';

/** Nenntakt der Rauschzeilen in ms — fest in der Firmware. */
export const RAUSCH_TAKT_MS = 750;

export interface Verteilung {
  n: number;
  min: number;
  median: number;
  p95: number;
  max: number;
}

export interface Luecke {
  von: number;
  bis: number;
  dauerMs: number;
}

export interface Auswertung {
  format: number;
  quelle: string;
  geraet: string | null;
  baud: number | null;
  von: number;
  bis: number;
  dauerMs: number;

  zeilen: number;
  /** Zeilen, die nicht dem Mitschnitt-Format entsprachen. */
  unlesbar: number;
  zeilenProMinute: number;

  telegramme: number;
  rauschzeilen: number;
  verworfen: number;
  verworfenNachGrund: Partial<Record<IgnoreReason, number>>;

  /** Abstände zwischen Rauschzeilen. Sollwert: 750 ms. */
  rauschTakt: Verteilung | null;
  /** Abstände, die mehr als 50 % vom Sollwert abweichen. */
  taktAusreisser: number;

  /**
   * Sendepausen über der Schwelle (Vorgabe: 3 × Rauschtakt).
   *
   * ACHTUNG: gekürzt auf die längsten `maxLuecken`. Für Zählungen und
   * Vergleiche ist `lueckenAnzahl` zu nehmen — sonst sähen ein Mitschnitt mit
   * 20 und einer mit 500 Lücken gleich aus, und der Vergleich bescheinigte
   * eine Verbesserung, die es nicht gab.
   */
  luecken: Luecke[];
  /** Alle gefundenen Lücken, ungekürzt. */
  lueckenAnzahl: number;
  lueckenGesamtMs: number;

  /** Verschiedene Absenderadressen. */
  absender: number;
  rssi: Verteilung | null;
  zeilenlaenge: Verteilung | null;
}

export interface AuswertungOptions {
  /** Ab welcher Stille eine Lücke gezählt wird. Vorgabe: 3 × 750 ms. */
  luckeAbMs?: number;
  /** Höchstzahl gemeldeter Lücken (die längsten). Vorgabe 20. */
  maxLuecken?: number;
}

interface Kopf {
  format: number;
  geraet: string | null;
  baud: number | null;
}

/** Wertet den Textinhalt eines Mitschnitts aus. */
export function werteAus(
  inhalt: string,
  quelle = '(Text)',
  options: AuswertungOptions = {},
): Auswertung {
  const luckeAb = options.luckeAbMs ?? RAUSCH_TAKT_MS * 3;
  const maxLuecken = options.maxLuecken ?? 20;

  const kopf: Kopf = { format: 0, geraet: null, baud: null };
  let zeilen = 0;
  let unlesbar = 0;
  let telegramme = 0;
  let rauschzeilen = 0;
  let verworfen = 0;
  const nachGrund: Partial<Record<IgnoreReason, number>> = {};
  const absender = new Set<string>();

  const rauschAbstaende: number[] = [];
  const rssiWerte: number[] = [];
  const laengen: number[] = [];
  const luecken: Luecke[] = [];

  let von = Number.POSITIVE_INFINITY;
  let bis = Number.NEGATIVE_INFINITY;
  let letzteZeit: number | null = null;
  let letztesRauschen: number | null = null;

  for (const roh of inhalt.split('\n')) {
    if (roh === '') continue;
    if (roh.startsWith('#')) {
      liesKopf(roh, kopf);
      continue;
    }

    const tab = roh.indexOf('\t');
    if (tab <= 0) {
      unlesbar++;
      continue;
    }
    const ts = Number(roh.slice(0, tab));
    if (!Number.isFinite(ts)) {
      unlesbar++;
      continue;
    }
    const nutz = roh.slice(tab + 1);

    zeilen++;
    if (ts < von) von = ts;
    if (ts > bis) bis = ts;
    laengen.push(nutz.length);

    // Lücken: Stille zwischen zwei aufeinanderfolgenden Zeilen. Der
    // Mitschnitt ist zeitlich geordnet, weil er in Empfangsreihenfolge
    // entsteht — ein Rücksprung wäre ein Formatfehler und keine Lücke.
    if (letzteZeit !== null && ts > letzteZeit) {
      const abstand = ts - letzteZeit;
      if (abstand >= luckeAb) {
        luecken.push({ von: letzteZeit, bis: ts, dauerMs: abstand });
      }
    }
    letzteZeit = ts;

    const geparst = parseLine(nutz, () => ts);
    if (geparst.kind === 'telegram') {
      telegramme++;
      absender.add(geparst.telegram.from);
      rssiWerte.push(geparst.telegram.rssi);
    } else if (geparst.kind === 'noise') {
      rauschzeilen++;
      if (letztesRauschen !== null && ts >= letztesRauschen) {
        rauschAbstaende.push(ts - letztesRauschen);
      }
      letztesRauschen = ts;
    } else {
      verworfen++;
      nachGrund[geparst.reason] = (nachGrund[geparst.reason] ?? 0) + 1;
    }
  }

  const dauerMs = zeilen > 0 ? Math.max(0, bis - von) : 0;
  const ausreisser = rauschAbstaende.filter(
    (a) => Math.abs(a - RAUSCH_TAKT_MS) > RAUSCH_TAKT_MS * 0.5,
  ).length;

  luecken.sort((a, b) => b.dauerMs - a.dauerMs);
  const luekenGesamt = luecken.reduce((s, l) => s + l.dauerMs, 0);

  return {
    format: kopf.format,
    quelle,
    geraet: kopf.geraet,
    baud: kopf.baud,
    von: zeilen > 0 ? von : 0,
    bis: zeilen > 0 ? bis : 0,
    dauerMs,
    zeilen,
    unlesbar,
    zeilenProMinute: dauerMs > 0 ? (zeilen / dauerMs) * 60_000 : 0,
    telegramme,
    rauschzeilen,
    verworfen,
    verworfenNachGrund: nachGrund,
    rauschTakt: verteilung(rauschAbstaende),
    taktAusreisser: ausreisser,
    luecken: luecken.slice(0, maxLuecken),
    lueckenAnzahl: luecken.length,
    lueckenGesamtMs: luekenGesamt,
    absender: absender.size,
    rssi: verteilung(rssiWerte),
    zeilenlaenge: verteilung(laengen),
  };
}

function liesKopf(zeile: string, kopf: Kopf): void {
  const teile = zeile.slice(1).trim().split(/\s+/);
  if (teile[0] === 'asksin-mitschnitt' && teile[1] !== undefined) {
    kopf.format = Number(teile[1]) || 0;
  } else if (teile[0] === 'geraet') {
    kopf.geraet = teile[1] ?? null;
    const b = teile.indexOf('baud');
    if (b >= 0 && teile[b + 1] !== undefined) kopf.baud = Number(teile[b + 1]);
  }
}

export function verteilung(werte: number[]): Verteilung | null {
  if (werte.length === 0) return null;
  const s = [...werte].sort((a, b) => a - b);
  return {
    n: s.length,
    min: s[0] as number,
    median: quantil(s, 0.5),
    p95: quantil(s, 0.95),
    max: s[s.length - 1] as number,
  };
}

function quantil(sortiert: number[], q: number): number {
  // Nächstliegender Rang. Für Diagnosewerte genügt das und ist erklärbar —
  // Interpolation zwischen zwei Messwerten erfindet einen dritten.
  const i = Math.min(sortiert.length - 1, Math.round(q * (sortiert.length - 1)));
  return sortiert[i] as number;
}

// ---------------------------------------------------------------------------

export interface VergleichZeile {
  groesse: string;
  vorher: string;
  nachher: string;
  /** true = vergleichbar; false = hängt vom Funkverkehr ab, nur informativ. */
  aussagekraeftig: boolean;
  /** '+' besser, '-' schlechter, '=' unverändert, null = nicht bewertbar. */
  richtung: '+' | '-' | '=' | null;
}

/**
 * Stellt zwei Auswertungen gegenüber.
 *
 * Bewertet wird nur, was von der Firmware abhängt. Telegrammzahl und Pegel
 * sind bewusst als „nicht aussagekräftig" gekennzeichnet: Sie hängen davon
 * ab, was gerade funkt. Sie stehen trotzdem in der Tabelle, weil man ohne sie
 * nicht sieht, ob die beiden Mitschnitte überhaupt vergleichbar lang und
 * ähnlich belebt waren.
 */
export function vergleiche(vorher: Auswertung, nachher: Auswertung): VergleichZeile[] {
  const zeilen: VergleichZeile[] = [];

  const add = (
    groesse: string,
    a: number | null,
    b: number | null,
    fmt: (v: number) => string,
    besser: 'kleiner' | 'groesser' | null,
    aussagekraeftig = true,
  ): void => {
    const t = (v: number | null): string => (v === null ? '—' : fmt(v));
    let richtung: '+' | '-' | '=' | null = null;
    if (besser !== null && a !== null && b !== null) {
      if (a === b) richtung = '=';
      else if (besser === 'kleiner') richtung = b < a ? '+' : '-';
      else richtung = b > a ? '+' : '-';
    }
    zeilen.push({ groesse, vorher: t(a), nachher: t(b), aussagekraeftig, richtung });
  };

  const ms = (v: number): string => `${Math.round(v)} ms`;
  // Summen werden schnell fünfstellig; "130477 ms" liest niemand als gut zwei
  // Minuten. Die Einheit wandert deshalb mit der Größenordnung mit.
  const dauer = (v: number): string =>
    v < 10_000 ? `${Math.round(v)} ms`
    : v < 120_000 ? `${(v / 1000).toFixed(1)} s`
    : `${(v / 60_000).toFixed(1)} min`;
  const n = (v: number): string => String(Math.round(v));
  const proMin = (v: number): string => `${v.toFixed(1)}/min`;

  add('Dauer', vorher.dauerMs, nachher.dauerMs, (v) => `${(v / 60000).toFixed(1)} min`, null);
  add('Zeilen', vorher.zeilen, nachher.zeilen, n, null);

  add(
    'Rauschtakt Median (Soll 750 ms)',
    vorher.rauschTakt?.median ?? null,
    nachher.rauschTakt?.median ?? null,
    ms,
    null,
  );
  add(
    'Rauschtakt p95',
    vorher.rauschTakt?.p95 ?? null,
    nachher.rauschTakt?.p95 ?? null,
    ms,
    'kleiner',
  );
  add('Takt-Ausreißer', vorher.taktAusreisser, nachher.taktAusreisser, n, 'kleiner');

  add('Lücken', vorher.lueckenAnzahl, nachher.lueckenAnzahl, n, 'kleiner');
  add('Lücken gesamt', vorher.lueckenGesamtMs, nachher.lueckenGesamtMs, dauer, 'kleiner');

  add('Verworfene Zeilen', vorher.verworfen, nachher.verworfen, n, 'kleiner');

  // Verworfene je Minute statt absolut: Zwei verschieden lange Mitschnitte
  // wären sonst nicht vergleichbar, und genau das passiert im Alltag.
  const rate = (a: Auswertung): number | null =>
    a.dauerMs > 0 ? (a.verworfen / a.dauerMs) * 60_000 : null;
  add('Verworfene je Minute', rate(vorher), rate(nachher), proMin, 'kleiner');

  add('Telegramme', vorher.telegramme, nachher.telegramme, n, null, false);
  add('Absender', vorher.absender, nachher.absender, n, null, false);
  add(
    'RSSI Median',
    vorher.rssi?.median ?? null,
    nachher.rssi?.median ?? null,
    (v) => `${Math.round(v)} dBm`,
    null,
    false,
  );

  return zeilen;
}
