/**
 * VerbundDienst (M9.2) — die Föderations-Leseschicht.
 *
 * Genau EIN Analyzer eines Verbunds bekommt Peers konfiguriert und fragt
 * deren `/api/health` + `/api/snapshot` ab. Grundsätze aus docs/verbund.md:
 *
 *  - **Fehlertoleranz je Peer**: ein nicht erreichbarer Standort ist ein
 *    Datenpunkt („offline"), kein Fehler der Übersicht.
 *  - **Zeitdrift**: `health.now` des Peers gegen die eigene Uhr, korrigiert
 *    um die halbe Antwortzeit. Der Verbund braucht synchrone Uhren
 *    (Dedup-Fenster M9.3) — Drift über der Schwelle wird markiert.
 *  - **Kurzer Cache**: das UI-Polling soll nicht bei jedem Aufruf alle
 *    Peers hämmern.
 */

import { systemTime } from '../ingest/time.ts';
import type { TimeSource } from '../ingest/time.ts';

export interface PeerKonfig {
  /** Anzeigename; leer = Standortname aus health des Peers. */
  name?: string;
  /** Basis-URL, z. B. http://192.168.1.71:8080 */
  url: string;
  /** Auth-Token des Peers (für spätere schreibende Aufrufe, M9.4). */
  token?: string;
}

export type FetchJson = (url: string, token?: string) => Promise<unknown>;

export const httpFetchJson: FetchJson = async (url, token) => {
  const res = await fetch(url, {
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};

export interface PeerZustand {
  name: string;
  url: string;
  erreichbar: boolean;
  fehler: string | null;
  standort: string | null;
  version: string | null;
  connected: boolean | null;
  demo: boolean | null;
  updateVerfuegbar: boolean | null;
  telegramsPerMinute: number | null;
  /** Grundrauschen, geglättet (dBm). */
  noiseFloor: number | null;
  deviceCount: number | null;
  maxDutyCycle: { name: string; percent: number } | null;
  /** Uhr des Peers minus eigene Uhr (ms), um die halbe Laufzeit korrigiert. */
  zeitdriftMs: number | null;
}

export interface VerbundUebersicht {
  ts: number;
  /** Ab dieser Drift gilt ein Peer als auffällig (Dedup-Fenster M9.3!). */
  driftWarnMs: number;
  peers: PeerZustand[];
}

export interface VerbundOptions {
  peers: PeerKonfig[];
  fetchJson?: FetchJson;
  time?: TimeSource;
  cacheMs?: number;
  driftWarnMs?: number;
}

function zahl(x: unknown): number | null {
  return typeof x === 'number' && Number.isFinite(x) ? x : null;
}

function wahrheit(x: unknown): boolean | null {
  return typeof x === 'boolean' ? x : null;
}

export class VerbundDienst {
  readonly #peers: PeerKonfig[];
  readonly #fetch: FetchJson;
  readonly #time: TimeSource;
  readonly #cacheMs: number;
  readonly #driftWarnMs: number;
  #cache: { at: number; daten: VerbundUebersicht } | null = null;
  #laufend: Promise<VerbundUebersicht> | null = null;

  constructor(options: VerbundOptions) {
    this.#peers = options.peers;
    this.#fetch = options.fetchJson ?? httpFetchJson;
    this.#time = options.time ?? systemTime;
    this.#cacheMs = options.cacheMs ?? 3000;
    this.#driftWarnMs = options.driftWarnMs ?? 1000;
  }

  get peerAnzahl(): number {
    return this.#peers.length;
  }

  /** Zustand aller Peers; parallel abgefragt, kurz gecacht. */
  uebersicht(): Promise<VerbundUebersicht> {
    const jetzt = this.#time.now();
    if (this.#cache !== null && jetzt - this.#cache.at < this.#cacheMs) {
      return Promise.resolve(this.#cache.daten);
    }
    // Gleichzeitige Aufrufe teilen sich EINEN Fan-out:
    this.#laufend ??= (async () => {
      const peers = await Promise.all(this.#peers.map((p) => this.#frage(p)));
      const daten: VerbundUebersicht = {
        ts: this.#time.now(),
        driftWarnMs: this.#driftWarnMs,
        peers,
      };
      this.#cache = { at: this.#time.now(), daten };
      this.#laufend = null;
      return daten;
    })();
    return this.#laufend;
  }

  async #frage(peer: PeerKonfig): Promise<PeerZustand> {
    const basis = peer.url.replace(/\/+$/, '');
    const leer: PeerZustand = {
      name: peer.name ?? basis,
      url: basis,
      erreichbar: false,
      fehler: null,
      standort: null,
      version: null,
      connected: null,
      demo: null,
      updateVerfuegbar: null,
      telegramsPerMinute: null,
      noiseFloor: null,
      deviceCount: null,
      maxDutyCycle: null,
      zeitdriftMs: null,
    };
    try {
      const vorher = this.#time.now();
      const health = (await this.#fetch(
        `${basis}/api/health`,
        peer.token,
      )) as Record<string, unknown>;
      const nachher = this.#time.now();
      const snapshot = (await this.#fetch(
        `${basis}/api/snapshot`,
        peer.token,
      )) as Record<string, unknown>;

      const peerNow = zahl(health['now']);
      const drift =
        peerNow === null ? null : Math.round(peerNow - (vorher + nachher) / 2);

      const geraete = Array.isArray(snapshot['devices'])
        ? (snapshot['devices'] as Array<Record<string, unknown>>)
        : [];
      let maxDuty: { name: string; percent: number } | null = null;
      for (const g of geraete) {
        const prozent = zahl(g['dutyCyclePercent']);
        if (prozent !== null && (maxDuty === null || prozent > maxDuty.percent)) {
          maxDuty = { name: String(g['name'] ?? '?'), percent: prozent };
        }
      }
      const noise = snapshot['noiseFloor'] as Record<string, unknown> | undefined;
      const standort =
        typeof health['standort'] === 'string' && health['standort'] !== ''
          ? health['standort']
          : null;

      return {
        ...leer,
        name: peer.name ?? standort ?? basis,
        erreichbar: true,
        standort,
        version: typeof health['version'] === 'string' ? health['version'] : null,
        connected: wahrheit(health['connected']),
        demo: wahrheit(health['demo']),
        updateVerfuegbar: wahrheit(health['updateVerfuegbar']),
        telegramsPerMinute: zahl(snapshot['telegramsPerMinute']),
        noiseFloor: noise === undefined ? null : zahl(noise['ewma']),
        deviceCount: geraete.length,
        maxDutyCycle: maxDuty,
        zeitdriftMs: drift,
      };
    } catch (err) {
      return { ...leer, fehler: String(err) };
    }
  }
}
