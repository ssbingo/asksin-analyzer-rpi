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
  /** Dedup-Zeitfenster: gleicher Schlüssel innerhalb ±Fenster = EIN Telegramm. */
  dedupFensterMs?: number;
  /** Zusammengeführte Telegramme im Speicher (Obergrenze). */
  maxTelegramme?: number;
}

/** Ein Gerät in der Empfangsmatrix: RSSI (EWMA) je Standort. */
export interface MatrixGeraet {
  addr: number;
  address: string;
  name: string;
  /** Standortname → RSSI-EWMA; null = dort nicht gehört. */
  rssi: Record<string, number | null>;
  /** Standort mit dem besten Empfang. */
  beste: string | null;
}

export interface VerbundMatrix {
  ts: number;
  standorte: string[];
  geraete: MatrixGeraet[];
}

/** Ein zusammengeführtes Telegramm mit allen Standorten, die es hörten. */
export interface VerbundTelegramm {
  ts: number;
  fromAddr: number;
  fromHex: string;
  fromName: string;
  toName: string;
  typeName: string;
  isHmIp: boolean;
  len: number;
  cnt: number;
  flagNames: string[];
  gehoertVon: Array<{ standort: string; rssi: number }>;
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
  readonly #dedupFensterMs: number;
  readonly #maxTelegramme: number;
  #cache: { at: number; daten: VerbundUebersicht } | null = null;
  #laufend: Promise<VerbundUebersicht> | null = null;
  /** Gerätelisten des letzten Fan-outs, je Standortname (für die Matrix). */
  readonly #geraeteJeStandort = new Map<
    string,
    Array<{ addr: number; address: string; name: string; ewma: number }>
  >();
  /** Dedup-Puffer: Schlüssel → Kandidaten in verschiedenen Zeitfenstern. */
  readonly #telegramme = new Map<string, VerbundTelegramm[]>();
  #letzterTelegrammPull = 0;
  #telegrammPull: Promise<void> | null = null;

  constructor(options: VerbundOptions) {
    this.#peers = options.peers;
    this.#fetch = options.fetchJson ?? httpFetchJson;
    this.#time = options.time ?? systemTime;
    this.#cacheMs = options.cacheMs ?? 3000;
    this.#driftWarnMs = options.driftWarnMs ?? 1000;
    this.#dedupFensterMs = options.dedupFensterMs ?? 1500;
    this.#maxTelegramme = options.maxTelegramme ?? 500;
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

      // Gerätedaten für die Empfangsmatrix aufheben:
      this.#geraeteJeStandort.set(
        peer.name ?? standort ?? basis,
        geraete
          .filter((g) => zahl(g['addr']) !== null)
          .map((g) => {
            const rssi = g['rssi'] as Record<string, unknown> | undefined;
            return {
              addr: g['addr'] as number,
              address: String(g['address'] ?? ''),
              name: String(g['name'] ?? ''),
              ewma: (rssi === undefined ? null : zahl(rssi['ewma'])) ?? -999,
            };
          }),
      );

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

  // ---- Empfangsmatrix (M9.3) -------------------------------------------

  /** Gerät × Standort mit RSSI-EWMA — aus dem letzten Fan-out gerechnet. */
  async matrix(): Promise<VerbundMatrix> {
    await this.uebersicht();                   // Fan-out auffrischen (gecacht)
    const standorte = [...this.#geraeteJeStandort.keys()];
    const zeilen = new Map<number, MatrixGeraet>();

    for (const [standort, geraete] of this.#geraeteJeStandort) {
      for (const g of geraete) {
        let zeile = zeilen.get(g.addr);
        if (zeile === undefined) {
          zeile = {
            addr: g.addr,
            address: g.address,
            name: g.name,
            rssi: Object.fromEntries(standorte.map((s) => [s, null])),
            beste: null,
          };
          zeilen.set(g.addr, zeile);
        }
        if (g.ewma > -999) zeile.rssi[standort] = g.ewma;
        // Ein aufgelöster Name schlägt die Hex-Darstellung anderer Standorte:
        if (zeile.name === zeile.address && g.name !== g.address) {
          zeile.name = g.name;
        }
      }
    }
    for (const zeile of zeilen.values()) {
      let beste: string | null = null;
      for (const s of standorte) {
        const wert = zeile.rssi[s];
        if (wert !== null && (beste === null || wert > (zeile.rssi[beste] ?? -999))) {
          beste = s;
        }
      }
      zeile.beste = beste;
    }
    return {
      ts: this.#time.now(),
      standorte,
      geraete: [...zeilen.values()].sort((a, b) => a.name.localeCompare(b.name, 'de')),
    };
  }

  /** Die Matrix als CSV (Semikolon, wie die übrigen Exporte). */
  async matrixCsv(): Promise<string> {
    const m = await this.matrix();
    const kopf = ['Geraet', 'Adresse', ...m.standorte].join(';');
    const zeilen = m.geraete.map((g) =>
      [g.name, g.address, ...m.standorte.map((s) => g.rssi[s] ?? '')].join(';'),
    );
    return [kopf, ...zeilen].join('\n');
  }

  // ---- Dedup-Telegrammliste (M9.3) -------------------------------------

  /**
   * Führt die jüngsten Telegramme aller Standorte zusammen. Bewusst
   * zustandsarm: Jeder Abruf holt je Peer die letzten 100 Zeilen — die
   * Deduplizierung absorbiert Wiederholungen, dadurch übersteht der
   * Sammler Peer-Neustarts ohne jede Zähler-Buchführung.
   */
  async telegramme(): Promise<{ ts: number; telegramme: VerbundTelegramm[] }> {
    const jetzt = this.#time.now();
    if (jetzt - this.#letzterTelegrammPull >= 2000) {
      this.#telegrammPull ??= (async () => {
        // Erst den (gecachten) Fan-out — er liefert die Standortnamen:
        await this.uebersicht();
        await Promise.all(this.#peers.map((p) => this.#zieheTelegramme(p)));
        this.#letzterTelegrammPull = this.#time.now();
        this.#aufraeumen();
        this.#telegrammPull = null;
      })();
      await this.#telegrammPull;
    }
    const alle: VerbundTelegramm[] = [];
    for (const kandidaten of this.#telegramme.values()) alle.push(...kandidaten);
    alle.sort((a, b) => b.ts - a.ts);
    return { ts: this.#time.now(), telegramme: alle.slice(0, 300) };
  }

  async #zieheTelegramme(peer: PeerKonfig): Promise<void> {
    const basis = peer.url.replace(/\/+$/, '');
    let antwort: Record<string, unknown>;
    try {
      antwort = (await this.#fetch(
        `${basis}/api/telegrams?limit=100`,
        peer.token,
      )) as Record<string, unknown>;
    } catch {
      return;                                  // Peer offline — kein Drama
    }
    const standort = this.#standortName(peer);
    for (const roh of (antwort['telegrams'] as Array<Record<string, unknown>> | undefined) ?? []) {
      const ts = zahl(roh['ts']);
      const rssi = zahl(roh['rssi']);
      const fromAddr = zahl(roh['fromAddr']);
      if (ts === null || rssi === null || fromAddr === null) continue;
      this.#verbuche(
        {
          ts,
          fromAddr,
          fromHex: String(roh['fromHex'] ?? ''),
          fromName: String(roh['fromName'] ?? ''),
          toName: String(roh['toName'] ?? ''),
          typeName: String(roh['typeName'] ?? ''),
          isHmIp: roh['isHmIp'] === true,
          len: zahl(roh['len']) ?? 0,
          cnt: zahl(roh['cnt']) ?? 0,
          flagNames: Array.isArray(roh['flagNames'])
            ? (roh['flagNames'] as string[])
            : [],
          gehoertVon: [],
        },
        standort,
        rssi,
      );
    }
  }

  #verbuche(t: VerbundTelegramm, standort: string, rssi: number): void {
    const key = `${t.fromAddr}:${t.cnt}:${t.typeName}:${t.len}`;
    let kandidaten = this.#telegramme.get(key);
    if (kandidaten === undefined) {
      kandidaten = [];
      this.#telegramme.set(key, kandidaten);
    }
    for (const k of kandidaten) {
      if (Math.abs(k.ts - t.ts) <= this.#dedupFensterMs) {
        if (!k.gehoertVon.some((g) => g.standort === standort)) {
          k.gehoertVon.push({ standort, rssi });
          k.gehoertVon.sort((a, b) => b.rssi - a.rssi);
          if (t.ts < k.ts) k.ts = t.ts;        // frühester Empfang zählt
          // Aufgelöster Name gewinnt gegen Hex-Anzeige eines anderen Peers:
          if (k.fromName === k.fromHex && t.fromName !== t.fromHex) {
            k.fromName = t.fromName;
            k.toName = t.toName;
          }
        }
        return;
      }
    }
    t.gehoertVon = [{ standort, rssi }];
    kandidaten.push(t);
  }

  #aufraeumen(): void {
    const grenze = this.#time.now() - 15 * 60_000;
    const alle: Array<[string, VerbundTelegramm]> = [];
    for (const [key, kandidaten] of this.#telegramme) {
      const frisch = kandidaten.filter((k) => k.ts >= grenze);
      if (frisch.length === 0) this.#telegramme.delete(key);
      else {
        this.#telegramme.set(key, frisch);
        for (const k of frisch) alle.push([key, k]);
      }
    }
    if (alle.length > this.#maxTelegramme) {
      alle.sort((a, b) => a[1].ts - b[1].ts);  // älteste zuerst verwerfen
      for (const [key, alt] of alle.slice(0, alle.length - this.#maxTelegramme)) {
        const rest = this.#telegramme.get(key)!.filter((k) => k !== alt);
        if (rest.length === 0) this.#telegramme.delete(key);
        else this.#telegramme.set(key, rest);
      }
    }
  }

  #standortName(peer: PeerKonfig): string {
    if (peer.name !== undefined) return peer.name;
    const basis = peer.url.replace(/\/+$/, '');
    const cached = this.#cache?.daten.peers.find((p) => p.url === basis);
    return cached?.name ?? basis;
  }
}
