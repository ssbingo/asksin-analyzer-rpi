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
  /** Ergebnis des täglichen Selbstchecks des Dienstes. */
  updateVerfuegbar: boolean;
  /** Standort-Identität dieses Analyzers (M9.1). */
  standort: string;
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
  standort: string;
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

function authKopf(): Record<string, string> {
  const token = authToken();
  return token === '' ? {} : { authorization: `Bearer ${token}` };
}

async function hole<T>(pfad: string): Promise<T> {
  const res = await fetch(pfad, { headers: authKopf() });
  if (res.status === 401) {
    throw new Error('Nicht erlaubt — Auth-Token in den Einstellungen hinterlegen.');
  }
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
  const res = await fetch(pfad, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      ...authKopf(),
    },
    body: params === undefined ? '' : new URLSearchParams(params).toString(),
  });
  if (res.status === 401) {
    throw new Error('Nicht erlaubt — Auth-Token in den Einstellungen hinterlegen.');
  }
  if (!res.ok) throw new Error(`${pfad}: HTTP ${res.status}`);
  return res;
}

// ---- Update-Pfade (M7.5) -------------------------------------------------

export interface UpdateVersionen {
  version: string;
  commit: string | null;
  verfuegbarCommit: string | null;
  updateVerfuegbar: boolean;
  /** Lesbarer Grund, wenn die Versionsermittlung scheitert. */
  fehler?: string;
}

export interface UpdateStatus {
  running: boolean;
  step?: string;
  ok?: boolean | null;
  from?: string;
  to?: string;
  updatedAt?: number;
}

export const holeUpdateVersionen = (): Promise<UpdateVersionen> =>
  hole('/api/update/versions');
export const holeUpdateStatus = (): Promise<UpdateStatus> =>
  hole('/api/update/status');
export const starteCoreUpdate = (): Promise<Response> =>
  sende('/api/update/core');

// ---- Status-LED / OLED (M11) --------------------------------------------

/** Ansteuerung der WS2812: SPI/GPIO10 (Pi 5) oder PWM/GPIO18 (Pi 3/4). */
export type LedMethode = 'ws2812-spi' | 'ws2812-pwm';

export interface StatusAnzeigeZustand {
  konfig: { led: LedMethode | 'aus'; oled: boolean; helligkeit: number };
  aktiv: { led: boolean; oled: boolean };
  seite: number;
  /** Gesamtzahl der Displayseiten — kommt vom Core, nicht fest verdrahtet. */
  seiten: number;
  fehler: Record<string, string>;
  ledMuster: { farbe: [number, number, number]; blinken: string; grund: string };
  system: {
    cpuLast: number;
    tempC: number | null;
    ramFreiProzent: number;
    diskFreiProzent: number | null;
  };
  /** SSD1306-Framebuffer (1024 Bytes, base64) für die Live-Vorschau. */
  oledBild: string;
}

export const holeStatusAnzeige = (): Promise<StatusAnzeigeZustand> =>
  hole('/api/statusanzeige');
export const statusSeiteWeiter = (): Promise<Response> =>
  sende('/api/statusanzeige/seite');

export async function sendeStatusAnzeige(auftrag: {
  led: LedMethode | 'aus';
  oled: boolean;
  helligkeit: number;
}): Promise<void> {
  const res = await fetch('/api/statusanzeige', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authKopf() },
    body: JSON.stringify(auftrag),
  });
  if (res.status === 401) {
    throw new Error('Nicht erlaubt — Auth-Token in den Einstellungen hinterlegen.');
  }
  if (!res.ok) throw new Error(await res.text());
}

// ---- Langzeitdaten / InfluxDB (M9.5) ------------------------------------

export interface InfluxZustand {
  konfig: {
    aktiv: boolean;
    url: string;
    org: string;
    bucket: string;
    hatToken: boolean;
    intervallSekunden: number;
  };
  status: {
    aktiv: boolean;
    schreibvorgaenge?: number;
    fehler?: number;
    letzterErfolg?: number | null;
    letzterFehler?: number | null;
    letzterFehlerText?: string | null;
  };
}

export const holeInflux = (): Promise<InfluxZustand> => hole('/api/influx');

export async function sendeInflux(auftrag: {
  aktiv: boolean;
  url: string;
  org: string;
  bucket: string;
  token: string;
  intervallSekunden: number;
}): Promise<void> {
  const res = await fetch('/api/influx', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authKopf() },
    body: JSON.stringify(auftrag),
  });
  if (res.status === 401) {
    throw new Error('Nicht erlaubt — Auth-Token in den Einstellungen hinterlegen.');
  }
  if (!res.ok) throw new Error(await res.text());
}

// ---- Verbund (M9.2) ------------------------------------------------------

export interface VerbundPeer {
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
  noiseFloor: number | null;
  deviceCount: number | null;
  maxDutyCycle: { name: string; percent: number } | null;
  zeitdriftMs: number | null;
}

export interface VerbundUebersicht {
  ts: number;
  driftWarnMs: number;
  peers: VerbundPeer[];
}

export const holeVerbund = (): Promise<VerbundUebersicht> => hole('/api/verbund');

export interface MatrixGeraet {
  addr: number;
  address: string;
  name: string;
  rssi: Record<string, number | null>;
  beste: string | null;
}

export interface VerbundMatrix {
  ts: number;
  standorte: string[];
  geraete: MatrixGeraet[];
}

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

export interface VerbundPeerEintrag {
  url: string;
  name: string | null;
  hatToken: boolean;
  quelle: 'config' | 'ui';
}

export const holeVerbundPeers = (): Promise<{ peers: VerbundPeerEintrag[] }> =>
  hole('/api/verbund/peers');

export async function aenderePeer(auftrag: {
  aktion: 'hinzufuegen' | 'entfernen';
  url: string;
  name?: string;
  token?: string;
}): Promise<void> {
  const res = await fetch('/api/verbund/peers', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authKopf() },
    body: JSON.stringify(auftrag),
  });
  if (res.status === 401) {
    throw new Error('Nicht erlaubt — Auth-Token in den Einstellungen hinterlegen.');
  }
  if (!res.ok) throw new Error(await res.text());
}

export interface FlottenSchritt {
  name: string;
  url: string;
  status: 'wartet' | 'läuft' | 'aktualisiert' | 'aktuell' | 'fehler' | 'übersprungen' | 'angestoßen';
  detail: string | null;
}

export interface FlottenStatus {
  running: boolean;
  startedAt?: number;
  updatedAt?: number;
  ok?: boolean | null;
  schritte?: FlottenSchritt[];
}

export const holeFlottenStatus = (): Promise<FlottenStatus> =>
  hole('/api/verbund/flottenupdate');
export const starteFlottenUpdate = (): Promise<Response> =>
  sende('/api/verbund/flottenupdate');

export const holeVerbundMatrix = (): Promise<VerbundMatrix> =>
  hole('/api/verbund/matrix');
export const holeVerbundTelegramme = (): Promise<{
  ts: number;
  telegramme: VerbundTelegramm[];
}> => hole('/api/verbund/telegramme');

// ---- Netzwerkeinstellungen (M7.6) ---------------------------------------

export interface NetzwerkZustand {
  hostname: string;
  iface: string | null;
  verbindung: string | null;
  methode: 'dhcp' | 'statisch' | 'unbekannt';
  aenderbar: boolean;
  grund: string | null;
  adressen: Array<{ address: string; prefix: number }>;
  gateway: string | null;
  dns: string[];
  ntp: {
    /** konfigurierter Server (Drop-in), null = nichts gesetzt */
    server: string | null;
    /** tatsächlich verwendeter Server laut timesyncd */
    aktiv: string | null;
    sync: boolean | null;
  };
}

export interface NetzwerkStatus {
  running: boolean;
  step?: string;
  ok?: boolean | null;
  deadline?: number | null;
  updatedAt?: number;
}

export interface NetzwerkAuftrag {
  method: 'dhcp' | 'statisch';
  address?: string;
  prefix?: number;
  gateway?: string;
  dns?: string[];
  hostname?: string;
  ntp?: string;
}

export const holeNetzwerk = (): Promise<NetzwerkZustand> => hole('/api/netzwerk');
export const holeNetzwerkStatus = (): Promise<NetzwerkStatus> =>
  hole('/api/netzwerk/status');
export const bestaetigeNetzwerk = (): Promise<Response> =>
  sende('/api/netzwerk/bestaetigen');

export async function sendeNetzwerk(auftrag: NetzwerkAuftrag): Promise<void> {
  const res = await fetch('/api/netzwerk', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authKopf() },
    body: JSON.stringify(auftrag),
  });
  if (res.status === 401) {
    throw new Error('Nicht erlaubt — Auth-Token in den Einstellungen hinterlegen.');
  }
  if (res.status === 409) {
    throw new Error('Es läuft bereits ein Netzwerk-Auftrag (Probezeit).');
  }
  if (!res.ok) throw new Error(await res.text());
}

export async function flasheFirmware(
  datei: File,
): Promise<{ ok: boolean; log: string }> {
  const res = await fetch('/api/update/firmware', {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', ...authKopf() },
    body: datei,
  });
  if (res.status === 401) {
    throw new Error('Nicht erlaubt — Auth-Token in den Einstellungen hinterlegen.');
  }
  // 200 und 500 tragen beide das Ergebnis-JSON mit dem avrdude-Log:
  return (await res.json()) as { ok: boolean; log: string };
}

// ---- Protokoll (M13) ------------------------------------------------------

/** Protokollstufen, aufsteigend gesprächig. */
export type ProtokollStufe = 'fehler' | 'info' | 'debug' | 'alles';

export interface ProtokollDatei {
  name: string;
  groesse: number;
  datum: string;
}

export interface ProtokollZustand {
  verfuegbar: boolean;
  stufe: ProtokollStufe;
  tage: number;
  verzeichnis: string;
  eintraege: number;
  schreibfehler: string | null;
  dateien: ProtokollDatei[];
}

export const holeProtokoll = (): Promise<ProtokollZustand> =>
  hole('/api/protokoll');

export async function sendeProtokoll(auftrag: {
  stufe: ProtokollStufe;
  tage: number;
}): Promise<void> {
  const res = await fetch('/api/protokoll', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authKopf() },
    body: JSON.stringify(auftrag),
  });
  if (!res.ok) throw new Error(await res.text());
}

/** Adresse zum Herunterladen einer Logdatei (Browser lädt direkt). */
export const protokollDateiUrl = (name: string): string =>
  `/api/protokoll/datei/${encodeURIComponent(name)}`;
