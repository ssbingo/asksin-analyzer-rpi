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
  /** Abgleich der CCU-Liste mit allem, was je empfangen wurde. */
  ccuAbgleich: {
    inListe: number;
    jeGehoert: number;
    nieGehoert: number;
    fremde: number;
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
  /**
   * Zustand der Sniffer-Firmware. Fehlt bei älteren Core-Fassungen.
   */
  sniffer?: SnifferZustand;
  /** Ist der Zigbee-Mithörer eingeschaltet? Steuert die Menüpunkte. */
  zigbee?: boolean;
  /**
   * Antwortet der Zigbee-Stick auch?
   *
   * Getrennt von `zigbee`, weil „eingeschaltet und stumm" genau der Fall ist,
   * den man in der Kopfzeile sehen will — das Gegenstück zu `connected` beim
   * BidCoS-Sniffer.
   */
  zigbeeVerbunden?: boolean;
  /** Empfangsbalken für beide Funknetze, samt der Zahlen dahinter. */
  empfang?: {
    bidcos: {
      /** Median über die Geräte, nicht über die Telegramme. */
      rssiMedian: number | null;
      rauschen: number | null;
      /** Nutzsignal minus Rauschen — darin kürzt sich der Bauteilversatz weg. */
      stoerabstand: number | null;
      balken: number;
    };
    zigbee: { lqiMedian: number | null; balken: number };
  };
  /** Rolle im Verbund — Verbund-Ansichten gibt es nur auf dem Master. */
  rolle?: 'master' | 'client';
}

/** Auskunft der Firmware auf `:?;` — nur bei der erweiterten Fassung. */
export interface SnifferFirmware {
  art: string;
  protokoll: number;
  firmware: number;
  taktMHz: number;
  /** Versionsregister des CC1101; null = das Funkmodul antwortet nicht. */
  cc1101: number | null;
}

export interface SnifferZustand {
  /** Liefert die Firmware Folgenummern und Prüfsummen? */
  erweitert: boolean;
  firmware: SnifferFirmware | null;
  befund: {
    art: 'passt' | 'original' | 'zuAlt' | 'zuNeu' | 'funkmodul';
    text: string;
  };
  folge: {
    gesehen: number;
    verloren: number;
    neuanfaenge: number;
    ueberlaeufe: number;
    letzte: number | null;
    verlustProzent: number | null;
  };
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
  minuten?: number,
): Promise<{ telegrams: Telegramm[]; lastId: number; gekuerzt?: boolean }> {
  const nach = afterId === undefined ? '' : `afterId=${afterId}&`;
  // `minuten` grenzt nach Zeit ein statt nach Anzahl. Ohne die Angabe liefert
  // die Schnittstelle wie bisher „die neuesten n" — was fuer die
  // Telegrammliste richtig ist, fuer ein Zeitdiagramm aber nicht.
  const zeit = minuten === undefined ? '' : `minutes=${minuten}&`;
  return hole(`/api/telegrams?${nach}${zeit}limit=${limit}`);
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
  /** Bauhöhe des OLED in Pixeln: 32 (Adafruit PiOLED) oder 64. */
  oledHoehe?: 32 | 64;
  /** Seitenzahl laut Anzeigedienst — er kennt die optionalen Felder. */
  seitenGesamt?: number;
  fehler: Record<string, string>;
  ledMuster: { farbe: [number, number, number]; blinken: string; grund: string };
  system: {
    cpuLast: number;
    tempC: number | null;
    ramFreiProzent: number;
    diskFreiProzent: number | null;
    /** Lüfterdrehzahl in U/min; null bei passiv gekühlten Geräten. */
    luefterUpm: number | null;
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

// ---- Zigbee-Mithörer (M16) ----------------------------------------------

export interface ZigbeeZustand {
  aktiv: boolean;
  device: string;
  kanal: number;
  demo: boolean;
  /** Hört der Stick gerade? Ohne Stick bleibt das false — die Zahlen sind trotzdem da. */
  verbunden: boolean;
  verbundenSeit: number | null;
  zeilen: number;
  pakete: number;
  verworfen: Record<string, number> | null;
  /** Durch Überlauf der Warteschlange verlorene Pakete. */
  ueberlauf: number;
  neuverbindungen: number;
  letzteZeileAm: number | null;
  gespeichert: number;
  /** Zustand der Namensanbindung — enthält NIE den Schlüssel. */
  namen?: {
    aktiv: boolean; host: string; anzahl: number;
    quelle: 'deconz' | 'cache' | 'keine'; geholtAm: number | null; fehler: string;
  };
  /** Bestätigungen — gezählt, nicht gespeichert (sie tragen keine Adressen). */
  bestaetigungen: number;
  schreibfehler: number;
}

export interface ZigbeeGeraet {
  pan: number;
  addr: string;
  /** IEEE-Adresse, aus dem NWK-Kopf gelernt — fehlt, solange kein Paket sie trug. */
  ieee?: string;
  /** Name aus deCONZ, über die IEEE-Adresse zugeordnet. */
  name?: string;
  hersteller?: string;
  modell?: string;
  pakete: number;
  /** Davon mit LQI unter 50 — die gemessene Kante liegt bei etwa −87 dBm. */
  schwach: number;
  min_rssi: number;
  max_rssi: number;
  sum_rssi: number;
  min_lqi: number;
  max_lqi: number;
  sum_lqi: number;
  zuletzt: number;
}

export interface ZigbeePaket {
  ts: number;
  kanal: number;
  rssi: number;
  lqi: number;
  laenge: number;
  typ: number;
  seq: number;
  pan: number | null;
  von: string | null;
  an: string | null;
  rundruf: number;
}

export const holeZigbee = (): Promise<ZigbeeZustand> => hole('/api/zigbee');

/** Ein Gerät, das deCONZ kennt, dieser Analyzer aber nicht gehört hat. */
export interface ZigbeeVermisst {
  ieee: string;
  name: string;
  hersteller?: string;
  modell?: string;
}

export const holeZigbeeGeraete = (
  stunden = 24,
): Promise<{ stunden: number; geraete: ZigbeeGeraet[]; nieGehoert: ZigbeeVermisst[] }> =>
  hole(`/api/zigbee/geraete?stunden=${stunden}`);

export const holeZigbeePakete = (
  minuten = 10,
  max = 500,
): Promise<{ minuten: number; pakete: ZigbeePaket[]; gekuerzt: boolean }> =>
  hole(`/api/zigbee/pakete?minuten=${minuten}&max=${max}`);

/** Ein- und Ausschalten oder Kanalwechsel. Antwort sagt, ob ein Neustart nötig ist. */
export async function setzeZigbee(
  auftrag: {
    aktiv?: boolean; kanal?: number;
    deconzHost?: string;
    /** Leer lassen heißt „unverändert" — die Oberfläche zeigt ihn nur maskiert. */
    deconzSchluessel?: string;
  },
): Promise<{ aktiv: boolean; kanal: number; neustartNoetig: boolean }> {
  const res = await fetch('/api/zigbee', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authKopf() },
    body: JSON.stringify(auftrag),
  });
  if (res.status === 401) {
    throw new Error('Nicht erlaubt — Auth-Token in den Einstellungen hinterlegen.');
  }
  if (!res.ok) throw new Error(await res.text());
  return await res.json() as { aktiv: boolean; kanal: number; neustartNoetig: boolean };
}

/**
 * Einen deCONZ-Schlüssel anfordern, während dort das Anmeldefenster offen ist.
 *
 * Der Schlüssel kommt NICHT zurück — er bleibt auf dem Analyzer. deCONZ zeigt
 * bestehende Schlüssel ohnehin nie an; wer einen von Hand besorgt, trägt ein
 * Zugangstoken durch Zwischenablage und Bildschirm.
 */
export async function zigbeeSchluesselAnfordern(
  host: string,
): Promise<{ ok: boolean; meldung: string; anzahl?: number }> {
  const res = await fetch('/api/zigbee/schluessel', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authKopf() },
    body: JSON.stringify({ host }),
  });
  if (res.status === 401) {
    throw new Error('Nicht erlaubt — Auth-Token in den Einstellungen hinterlegen.');
  }
  if (!res.ok) throw new Error(await res.text());
  return await res.json() as { ok: boolean; meldung: string; anzahl?: number };
}

/** Was sich über Stick und Firmware sagen lässt, ohne den Anschluss zu öffnen. */
export interface ZigbeeFirmwareStand {
  /** Wie viele SONOFF-Sticks stecken. 0, 1 — oder mehr, und dann ist unklar welcher. */
  sticks: number;
  geraet: string | null;
  /** Läuft gerade ein Aufspielvorgang? */
  laeuft: boolean;
  /** Bekommt der eigene Mithörer Zeilen? Der endgültige Beweis. */
  hoert: boolean;
  aktiv: boolean;
  letzterLauf: {
    laeuft: boolean; schritt: string; ok: boolean | null; text: string; stand: number;
  } | null;
}

export function holeZigbeeFirmware(): Promise<ZigbeeFirmwareStand> {
  return hole('/api/zigbee/firmware');
}

/**
 * Das Aufspielen der Mithörer-Firmware anstoßen.
 *
 * Antwortet mit 202: angenommen, aber noch nicht fertig. Der Vorgang dauert
 * Minuten und startet den Analyzer-Dienst dabei einmal neu — die Oberfläche
 * verliert also zwischendurch die Verbindung. Das ist erwartet.
 */
export async function zigbeeFirmwareAufspielen(): Promise<{ meldung: string }> {
  const res = await fetch('/api/zigbee/firmware', {
    method: 'POST',
    headers: { ...authKopf() },
  });
  if (res.status === 401) {
    throw new Error('Nicht erlaubt — Auth-Token in den Einstellungen hinterlegen.');
  }
  if (!res.ok) throw new Error(await res.text());
  return await res.json() as { meldung: string };
}

export interface ZigbeeMatrixGeraet {
  ieee: string | null;
  addr: string;
  pan: number;
  name: string;
  /** Standortname → Empfang. Fehlt der Eintrag, hat der Standort nichts gehört. */
  empfang: Record<string, {
    rssi: number; lqi: number; pakete: number; schwachProzent: number;
  }>;
  beste: string | null;
  nirgends: boolean;
}

export interface ZigbeeMatrix {
  ts: number;
  stunden: number;
  standorte: string[];
  /** Standorte, die gerade nicht antworten — unbekannt, nicht leer. */
  nichtErreichbar: string[];
  /** Standorte, die laufen, aber keinen Mithörer betreiben. */
  ohneMithoerer: string[];
  geraete: ZigbeeMatrixGeraet[];
  zusammenfassung: { gesamt: number; nirgends: number; nurEinStandort: number };
}

export const holeZigbeeMatrix = (stunden = 24): Promise<ZigbeeMatrix> =>
  hole(`/api/verbund/zigbee?stunden=${stunden}`);

// ---- Langzeitdaten / InfluxDB (M9.5) ------------------------------------

export interface InfluxZustand {
  konfig: {
    aktiv: boolean;
    url: string;
    org: string;
    bucket: string;
    /** Kommt im Klartext zurück — die Leseroute ist token-geschützt. */
    token: string;
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
  // 202 = angenommen und gestartet, 400 = gar nicht erst begonnen.
  // Der Verlauf kommt danach über holeFlashStand().
  return (await res.json()) as { ok: boolean; log: string };
}

/**
 * Verlauf und Ausgang des laufenden Flashs.
 *
 * `ok` bleibt `null`, solange es läuft. Ohne diese Abfrage stand in der
 * Oberfläche bis zum Schluss nur „Flashe …" — und als der Dienst am
 * 10.08.2026 tatsächlich hängte, stand es dort stundenlang.
 */
export async function holeFlashStand(): Promise<{
  laeuft: boolean;
  log: string;
  ok: boolean | null;
}> {
  const res = await fetch('/api/update/firmware/stand', { headers: authKopf() });
  if (!res.ok) throw new Error(`Stand nicht abrufbar (${res.status})`);
  return (await res.json()) as { laeuft: boolean; log: string; ok: boolean | null };
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

// --- Mitschnitt (Grundlinie vor Firmware-Änderungen) ----------------------

export interface MitschnittZustand {
  aktiv: boolean;
  /** Läuft der Analyzer im Demo-Modus? Dann sind die Daten simuliert. */
  demo: boolean;
  pfad: string;
  vorhanden: boolean;
  bytes: number;
  geschrieben: number;
  verworfen: number;
  abgeschnitten: number;
  fehler: number;
  seit: number | null;
}

export const holeMitschnitt = (): Promise<MitschnittZustand> =>
  hole('/api/mitschnitt');

/** Adresse zum Herunterladen der Aufzeichnung (Browser lädt direkt). */
export const mitschnittDateiUrl = (): string => '/api/mitschnitt/datei';

export async function sendeMitschnitt(auftrag: {
  aktiv: boolean;
  /** Nur mit ausdrücklicher Bestätigung — eine Grundlinie ist unersetzlich. */
  loeschen?: boolean;
}): Promise<MitschnittZustand> {
  const res = await fetch('/api/mitschnitt', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authKopf() },
    body: JSON.stringify(auftrag),
  });
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()) as MitschnittZustand;
}

// ---- Langzeitdaten vor Ort (M14) ----------------------------------------

export interface LangzeitZustand {
  /** Was tatsächlich gilt — die Hardware kann den Wunsch überstimmen. */
  rolle: 'master' | 'client';
  /** Was eingestellt ist. Weicht bei zu schwacher Hardware von `rolle` ab. */
  gewuenscht: 'master' | 'client';
  erzwungen: boolean;
  grund: string;
  hardware: { modell: string; ramGb: number };
  masterFaehig: { faehig: boolean; grund: string };
  installiert: { influxdb: boolean; grafana: boolean };
  /** Schreibt der Analyzer gerade in eine InfluxDB? */
  influxAktiv: boolean;
  /** Liegt diese Datenbank auf demselben Gerät? */
  influxLokal: boolean;
  /** Wie viele Standorte tatsächlich in der Datenbank stehen; null = unbekannt. */
  standorte: number | null;
  /** Eingestellter Alarmweg; null, wenn keiner aktiv ist. */
  alarmierung: 'iobroker' | 'email' | 'telegram' | null;
  /** Fortschritt des Einrichtungsskripts; null, solange nie eines lief. */
  installation: {
    schritt?: string;
    fertig?: boolean;
    fehler?: string | null;
    zeit?: string;
  } | null;
  /** Läuft gerade eine Einrichtung? */
  laeuft: boolean;
  grafanaUrl: string;
}

export const holeLangzeit = (): Promise<LangzeitZustand> => hole('/api/langzeitdaten');

export async function sendeLangzeit(
  auftrag: { rolle: 'master' | 'client' } | { aktion: 'installieren' },
): Promise<void> {
  const res = await fetch('/api/langzeitdaten', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authKopf() },
    body: JSON.stringify(auftrag),
  });
  if (res.status === 401) {
    throw new Error('Nicht erlaubt — Auth-Token in den Einstellungen hinterlegen.');
  }
  if (!res.ok) throw new Error(await res.text());
}

// ---- Alarmziele (M14.2) --------------------------------------------------

export type Alarmkanal = 'iobroker' | 'email' | 'telegram';

export interface AlarmzielZustand {
  kanal: Alarmkanal;
  aktiv: boolean;
  iobroker: { url: string; token: string; hatToken: boolean };
  email: {
    empfaenger: string;
    smtpHost: string;
    smtpPort: number;
    benutzer: string;
    absender: string;
    /** Kommt im Klartext zurück — die Leseroute ist dafür token-geschützt. */
    passwort: string;
    hatPasswort: boolean;
  };
  telegram: { chatId: string; botToken: string; hatBotToken: boolean };
  /** Wurde schon einmal etwas nach Grafana übernommen? */
  angewendet: boolean;
  laeuft: boolean;
  /** Liegt der Anstoß seit Minuten unbearbeitet herum? Dann fehlt der Helfer. */
  haengtSeitMinuten: number | null;
  /** Der Endpunkt im ioBroker-Adapter ist ab dessen Fassung mit Alarm-Empfang da. */
  iobrokerBereit: boolean;
  /** Welche Adapterfassung mindestens gebraucht wird. */
  adapterMindestversion: string;
}

export const holeAlarmziel = (): Promise<AlarmzielZustand> => hole('/api/alarmziel');

/** Verschickt eine Testmail; liefert die Klartextmeldung des Servers. */
export async function testeAlarmziel(auftrag: Record<string, unknown>): Promise<string> {
  const res = await fetch('/api/alarmziel/test', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authKopf() },
    body: JSON.stringify(auftrag),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(text);
  return text;
}

export async function sendeAlarmziel(auftrag: Record<string, unknown>): Promise<void> {
  const res = await fetch('/api/alarmziel', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authKopf() },
    body: JSON.stringify(auftrag),
  });
  if (res.status === 401) {
    throw new Error('Nicht erlaubt — Auth-Token in den Einstellungen hinterlegen.');
  }
  if (!res.ok) throw new Error(await res.text());
}

// --- CCU-Verbindungstest --------------------------------------------------

export interface CcuTestErgebnis {
  ok: boolean;
  stufe: 'keine-adresse' | 'erreichbar' | 'antwort' | 'variable' | 'inhalt' | 'ok';
  titel: string;
  text: string;
  /** Die nächste Handlung; leer, wenn nichts zu tun ist. */
  tunSie: string;
  /** Soll die ausführliche CCU-Anleitung eingeblendet werden? */
  anleitungZeigen: boolean;
  geraete: number | null;
  alterStunden: number | null;
  beispiele: string[];
  technisch: string;
}

/**
 * Prüft die CCU-Verbindung — vom Analyzer aus, nicht aus dem Browser.
 *
 * Erreichen muss die CCU der Dienst; ein Test aus dem Browser beantwortete
 * die falsche Frage (der Browser steht oft in einem anderen Netz).
 */
export async function testeCcu(host: string): Promise<CcuTestErgebnis> {
  const res = await fetch('/api/ccu/test', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authKopf() },
    body: JSON.stringify({ host }),
  });
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()) as CcuTestErgebnis;
}
