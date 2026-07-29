/**
 * API-Client — spricht ausschließlich den dokumentierten Vertrag des Core
 * (core/src/api/): die eigene JSON-API unter /api/* plus die
 * Konfigurations-Endpunkte. Kein Code aus den Referenzprojekten.
 */

export interface RssiStat {
  last: number;
  min: number;
  max: number;
  ewma: number;
}

export interface GeraetEintrag {
  addr: number;
  address: string;
  name: string;
  serial: string | null;
  kind: string | null;
  isHmIp: boolean | null;
  rssi: RssiStat;
  lastSeen: number;
  telegrams: number;
  dutyCyclePercent: number;
}

export interface Snapshot {
  ts: number;
  ingest: {
    connected: boolean;
    connectedSince: number | null;
    lines: number;
    telegrams: number;
    noise: number;
    droppedLines: number;
    overlongLines: number;
    partialLines: number;
    consumerErrors: number;
    reconnects: number;
    lastLineAt: number | null;
    ignored: Record<string, number>;
  };
  recorder: {
    bufferedTelegrams: number;
    writtenTelegrams: number;
    flushes: number;
  };
  noiseFloor: { last: number | null; ewma: number | null; samples: number };
  telegramsPerMinute: number;
  devList: {
    source: 'ccu' | 'cache' | null;
    fetches: number;
    failures: number;
    lastSuccessAt: number | null;
    lastErrorAt: number | null;
    createdAt: number | null;
    entries: number | null;
  } | null;
  persistErrors: number;
  devices: GeraetEintrag[];
}

export interface Telegramm {
  id: number;
  ts: number;
  rssi: number;
  len: number;
  cnt: number;
  flags: number;
  flagNames: string[];
  type: number;
  typeName: string;
  isHmIp: boolean;
  fromAddr: number;
  fromHex: string;
  fromName: string;
  toAddr: number;
  toHex: string;
  toName: string;
  payload: string;
}

export interface NoiseMinute {
  minute: number;
  ts: number;
  samples: number;
  min: number;
  max: number;
  avg: number;
}

export interface Health {
  ok: boolean;
  version: string;
  now: number;
  boottime: number;
  connected: boolean;
  telegrams: number;
  droppedLines: number;
  persistErrors: number;
  devListSource: 'ccu' | 'cache' | null;
  demo: boolean;
}

/** /getConfig — die Felder, die die UI tatsächlich anzeigt. */
export interface Konfiguration {
  version_upper: number;
  version_lower: number;
  ccuip: string;
  hostname: string;
  ntp: string;
  ip: string;
  netmask: string;
  gw: string;
  macaddress: string;
  resolve: number;
  boottime: number;
  spiffssizekb: number;
  spiffsusedkb: number;
  demo: number;
  [weitere: string]: unknown;
}

const TOKEN_SCHLUESSEL = 'asksin.token';

export function authToken(): string {
  return localStorage.getItem(TOKEN_SCHLUESSEL) ?? '';
}

export function setzeAuthToken(token: string): void {
  if (token === '') localStorage.removeItem(TOKEN_SCHLUESSEL);
  else localStorage.setItem(TOKEN_SCHLUESSEL, token);
}

async function hole<T>(pfad: string): Promise<T> {
  const res = await fetch(pfad);
  if (!res.ok) throw new Error(`${pfad}: HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

export const holeSnapshot = (): Promise<Snapshot> => hole('/api/snapshot');
export const holeHealth = (): Promise<Health> => hole('/api/health');
export const holeKonfiguration = (): Promise<Konfiguration> => hole('/getConfig');
export const holeNoise = (minutes = 180): Promise<{ noise: NoiseMinute[] }> =>
  hole(`/api/noise?minutes=${minutes}`);

export function holeTelegramme(
  afterId?: number,
  limit = 200,
): Promise<{ telegrams: Telegramm[]; lastId: number }> {
  const nach = afterId === undefined ? '' : `afterId=${afterId}&`;
  return hole(`/api/telegrams?${nach}limit=${limit}`);
}

/** POST mit optionalem Bearer-Token (Einstellungen → Auth-Token). */
export async function sende(
  pfad: string,
  params?: Record<string, string>,
): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
  };
  const token = authToken();
  if (token !== '') headers['authorization'] = `Bearer ${token}`;
  const res = await fetch(pfad, {
    method: 'POST',
    headers,
    body: params === undefined ? '' : new URLSearchParams(params).toString(),
  });
  if (res.status === 401) {
    throw new Error('Nicht erlaubt — Auth-Token in den Einstellungen hinterlegen.');
  }
  if (!res.ok) throw new Error(`${pfad}: HTTP ${res.status}`);
  return res;
}
