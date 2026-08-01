/**
 * Langzeitdaten nach InfluxDB v2 (M9.5) — ohne Client-Bibliothek.
 *
 * Jeder Analyzer schreibt seine Kennzahlen mit `standort`-Tag in eine
 * zentrale Influx-Instanz (`POST /api/v2/write`, Line Protocol); Grafana
 * wertet dann standortübergreifend aus. Grundsätze:
 *
 *  - **Fehlertolerant**: Influx weg = Zähler hoch, Log-Zeile, nächster
 *    Takt versucht es wieder. Der Analyzer selbst bleibt unbeeindruckt —
 *    seine SQLite bleibt die primäre Wahrheit.
 *  - **Line Protocol von Hand**: das Format ist trivial, die Escaping-
 *    Regeln sind es nicht — deshalb hier als reine, getestete Funktionen.
 */

import { systemTime } from '../ingest/time.ts';
import type { TimeSource } from '../ingest/time.ts';

/** Tag-Schlüssel/-Werte: Komma, Gleichheitszeichen und Leerzeichen escapen. */
export function escapeTag(wert: string): string {
  return wert.replace(/([,= ])/g, '\\$1');
}

/** Measurement: Komma und Leerzeichen escapen. */
export function escapeMeasurement(wert: string): string {
  return wert.replace(/([, ])/g, '\\$1');
}

/** String-Feldwert: Backslash und Anführungszeichen escapen, in "…". */
export function escapeFeldText(wert: string): string {
  return `"${wert.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export type FeldWert = number | boolean | string;

/**
 * Eine Zeile Line Protocol. Zahlen werden als Float geschrieben (Influx
 * verträgt keine gemischten int/float-Felder), Zeitstempel in Nanosekunden.
 */
export function zeile(
  measurement: string,
  tags: Record<string, string>,
  felder: Record<string, FeldWert>,
  tsMs: number,
): string {
  const tagTeil = Object.entries(tags)
    .filter(([, v]) => v !== '')
    .map(([k, v]) => `,${escapeTag(k)}=${escapeTag(v)}`)
    .join('');
  const feldTeil = Object.entries(felder)
    .map(([k, v]) => {
      const wert =
        typeof v === 'number'
          ? String(v)
          : typeof v === 'boolean'
            ? String(v)
            : escapeFeldText(v);
      return `${escapeTag(k)}=${wert}`;
    })
    .join(',');
  return `${escapeMeasurement(measurement)}${tagTeil} ${feldTeil} ${tsMs * 1_000_000}`;
}

export interface InfluxKonfig {
  aktiv: boolean;
  url: string;
  org: string;
  bucket: string;
  token: string;
  intervallSekunden: number;
}

export const INFLUX_VORGABEN: InfluxKonfig = {
  aktiv: false,
  url: '',
  org: '',
  bucket: 'asksin',
  token: '',
  intervallSekunden: 30,
};

/** Die Kennzahlen eines Schreibtakts. */
export interface InfluxDaten {
  standort: string;
  connected: boolean;
  telegramsPerMinute: number;
  noiseFloorEwma: number | null;
  deviceCount: number;
  /** Hoechster Duty-Cycle ueber alle Geraete — spart die Aggregation. */
  maxDutyCycle: number;
  /** Wie viele Geraete gerade ueber der Alarmschwelle liegen. */
  dutyAlarme: number;
  /** Laufzeit des Dienstes in Sekunden.
   *
   *  Der Zaehler `telegramme` faengt bei jedem Neustart wieder bei null an.
   *  Ohne diesen Wert sieht Grafana das als negativen Ausschlag; mit ihm
   *  laesst sich der Ruecksetzer erkennen und ausblenden. */
  laufzeitSekunden: number;
  /** Zustand des Geraets selbst. Bei der Absturzsuche im Juli 2026 fehlte
   *  genau das: Es gab Stichproben, aber keine Kurve. */
  system: {
    cpuLast: number;
    tempC: number | null;
    ramFreiProzent: number;
    diskFreiProzent: number | null;
    luefterUpm: number | null;
  };
  geraete: Array<{
    address: string;
    name: string;
    rssiEwma: number;
    dutyCyclePercent: number;
    telegrams: number;
    /** Sekunden seit dem letzten Telegramm dieses Geraets.
     *
     *  Der praktisch wertvollste Wert der ganzen Reihe: Ein Homematic-Geraet,
     *  das ploetzlich schweigt, hat fast immer eine leere Batterie. */
    sekundenSeitEmpfang: number;
  }>;
}

/** Baut alle Zeilen eines Takts — rein und damit exakt testbar. */
export function baueZeilen(daten: InfluxDaten, tsMs: number): string[] {
  const standort = { standort: daten.standort };
  const zeilen = [
    zeile(
      'analyzer',
      standort,
      {
        connected: daten.connected,
        telegrammeProMinute: daten.telegramsPerMinute,
        ...(daten.noiseFloorEwma === null
          ? {}
          : { grundrauschen: daten.noiseFloorEwma }),
        geraete: daten.deviceCount,
        maxDutyCycle: daten.maxDutyCycle,
        dutyAlarme: daten.dutyAlarme,
        laufzeitSekunden: daten.laufzeitSekunden,
      },
      tsMs,
    ),
    // Eigene Messreihe fuer den Geraetezustand: Wer nur die Funkdaten
    // auswertet, bekommt sie so nicht in die Abfragen gemischt.
    zeile(
      'system',
      standort,
      {
        cpuLast: daten.system.cpuLast,
        ramFreiProzent: daten.system.ramFreiProzent,
        ...(daten.system.tempC === null ? {} : { tempC: daten.system.tempC }),
        ...(daten.system.diskFreiProzent === null
          ? {}
          : { diskFreiProzent: daten.system.diskFreiProzent }),
        ...(daten.system.luefterUpm === null
          ? {}
          : { luefterUpm: daten.system.luefterUpm }),
      },
      tsMs,
    ),
  ];
  for (const g of daten.geraete) {
    zeilen.push(
      zeile(
        'geraet',
        { ...standort, adresse: g.address, name: g.name },
        {
          rssi: g.rssiEwma,
          dutyCycle: g.dutyCyclePercent,
          telegramme: g.telegrams,
          sekundenSeitEmpfang: g.sekundenSeitEmpfang,
        },
        tsMs,
      ),
    );
  }
  return zeilen;
}

export type InfluxPost = (
  url: string,
  token: string,
  body: string,
) => Promise<{ status: number; text: string }>;

export const httpInfluxPost: InfluxPost = async (url, token, body) => {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Token ${token}`,
      'content-type': 'text/plain; charset=utf-8',
    },
    body,
    signal: AbortSignal.timeout(8000),
  });
  return { status: res.status, text: res.ok ? '' : await res.text() };
};

export interface InfluxStatus {
  aktiv: boolean;
  schreibvorgaenge: number;
  fehler: number;
  letzterErfolg: number | null;
  letzterFehler: number | null;
  letzterFehlerText: string | null;
}

export interface InfluxSchreiberOptions {
  konfig: InfluxKonfig;
  daten: () => InfluxDaten;
  post?: InfluxPost;
  time?: TimeSource;
  onError?: (fehler: string) => void;
}

export class InfluxSchreiber {
  readonly #o: InfluxSchreiberOptions;
  readonly #time: TimeSource;
  readonly #post: InfluxPost;
  #stop: AbortController | null = null;
  #takt: Promise<void> | null = null;
  #schreibvorgaenge = 0;
  #fehler = 0;
  #letzterErfolg: number | null = null;
  #letzterFehler: number | null = null;
  #letzterFehlerText: string | null = null;

  constructor(options: InfluxSchreiberOptions) {
    this.#o = options;
    this.#time = options.time ?? systemTime;
    this.#post = options.post ?? httpInfluxPost;
  }

  get status(): InfluxStatus {
    return {
      aktiv: this.#stop !== null,
      schreibvorgaenge: this.#schreibvorgaenge,
      fehler: this.#fehler,
      letzterErfolg: this.#letzterErfolg,
      letzterFehler: this.#letzterFehler,
      letzterFehlerText: this.#letzterFehlerText,
    };
  }

  start(): void {
    if (this.#stop !== null) throw new Error('InfluxSchreiber läuft bereits');
    this.#stop = new AbortController();
    this.#takt = this.#lauf(this.#stop.signal);
  }

  async stop(): Promise<void> {
    if (this.#stop === null) return;
    this.#stop.abort(new Error('gestoppt'));
    try {
      await this.#takt;
    } finally {
      this.#stop = null;
      this.#takt = null;
    }
  }

  async #lauf(signal: AbortSignal): Promise<void> {
    const k = this.#o.konfig;
    const intervall = Math.max(5, k.intervallSekunden) * 1000;
    const url =
      `${k.url.replace(/\/+$/, '')}/api/v2/write` +
      `?org=${encodeURIComponent(k.org)}&bucket=${encodeURIComponent(k.bucket)}&precision=ns`;
    for (;;) {
      try {
        await this.#time.delay(intervall, signal);
      } catch {
        return;
      }
      await this.#schreiben(url, k.token);
    }
  }

  async #schreiben(url: string, token: string): Promise<void> {
    const zeilen = baueZeilen(this.#o.daten(), this.#time.now());
    try {
      const res = await this.#post(url, token, zeilen.join('\n'));
      if (res.status === 204) {
        this.#schreibvorgaenge++;
        this.#letzterErfolg = this.#time.now();
      } else {
        this.#fehlerMelden(`HTTP ${res.status}: ${res.text.slice(0, 200)}`);
      }
    } catch (err) {
      this.#fehlerMelden(String(err));
    }
  }

  #fehlerMelden(text: string): void {
    this.#fehler++;
    this.#letzterFehler = this.#time.now();
    this.#letzterFehlerText = text;
    this.#o.onError?.(text);
  }
}
