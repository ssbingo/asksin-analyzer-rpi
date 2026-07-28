/**
 * Geräteliste der CCU/RaspberryMatic — Parsen, Klassifizieren, Auflösen.
 *
 * Die Liste stammt aus der CCU-Systemvariable `AskSinAnalyzerDevList`, die das
 * Script `ccu_create_devlist.txt` befüllt (siehe docs/serial-protocol.md,
 * Abschnitt 7). Dieses Modul verarbeitet den JSON-Inhalt; den HTTP-Abruf
 * übernimmt später der Ingest-Teil von M4.
 *
 * Die Eigenheiten hier sind keine Theorie, sondern stammen aus einer echten
 * Anlage (Fixture `test/fixtures/devlist-real.json`, 241 Einträge):
 *
 *  - **Adressen sind nicht eindeutig.** Rauchmelder-Gruppen erscheinen als
 *    zweiter Eintrag unter der Adresse ihres Leitgeräts, erkennbar am
 *    `*`-Präfix der Seriennummer (`LEQ0311847` ↔ `*LEQ0311847`). Auch die
 *    Zentrale steht doppelt in der Liste (HmIP-RCV und RPI-RF-MOD unter
 *    derselben Adresse). Eine Map `Adresse → Eintrag` würde still
 *    überschreiben — deshalb `Adresse → Einträge[]` mit Vorrangregel.
 *  - **HmIP-Erkennung** nach der XS-Konvention: 14-stellige Seriennummer oder
 *    das Literal `HmIP-RF`.
 *  - **Pseudo-Einträge** des CCU-Scripts (HmIP-Multicasts, HMRF-Broadcast)
 *    tragen Seriennummern, die nur aus Nullen bestehen.
 */

export interface DevListDevice {
  address: number;
  serial: string;
  name: string;
}

export interface DevList {
  /** Unix-Sekunden, von der CCU beim Befüllen gesetzt. */
  created_at: number;
  devices: DevListDevice[];
}

/** Was ein Eintrag der Liste darstellt. */
export type DeviceKind =
  /** ein reales Funkgerät */
  | 'device'
  /** virtuelle Gruppe (z. B. Rauchmelder-Team), Serial mit `*`-Präfix */
  | 'team'
  /** die Zentrale selbst (BidCoS-RF bzw. HmIP-RF) */
  | 'central'
  /** vom CCU-Script fest eingetragene Multicast-/Broadcast-Pseudoadresse */
  | 'pseudo';

export interface ResolvedDevice extends DevListDevice {
  kind: DeviceKind;
  isHmIp: boolean;
}

const NUR_NULLEN = /^0+$/;

export function classify(entry: DevListDevice): DeviceKind {
  if (entry.serial.startsWith('*')) return 'team';
  if (entry.serial === 'BidCoS-RF' || entry.serial === 'HmIP-RF') return 'central';
  if (entry.address === 0 || NUR_NULLEN.test(entry.serial)) return 'pseudo';
  return 'device';
}

/** HmIP-Erkennung nach XS-Konvention. */
export function isHmIpSerial(serial: string): boolean {
  return serial.length === 14 || serial === 'HmIP-RF';
}

export function toResolved(entry: DevListDevice): ResolvedDevice {
  return { ...entry, kind: classify(entry), isHmIp: isHmIpSerial(entry.serial) };
}

/**
 * Strukturvalidierung des Listen-JSON. Wirft mit aussagekräftiger Meldung,
 * toleriert aber unbekannte Zusatzfelder — die CCU-Seite kann sich ändern.
 */
export function parseDevList(input: unknown): DevList {
  if (typeof input === 'string') {
    input = JSON.parse(input);
  }
  if (input === null || typeof input !== 'object') {
    throw new Error('DevList: kein Objekt');
  }
  const obj = input as Record<string, unknown>;
  if (typeof obj['created_at'] !== 'number') {
    throw new Error('DevList: created_at fehlt oder ist keine Zahl');
  }
  if (!Array.isArray(obj['devices'])) {
    throw new Error('DevList: devices fehlt oder ist kein Array');
  }
  const devices: DevListDevice[] = [];
  for (const [i, raw] of (obj['devices'] as unknown[]).entries()) {
    if (raw === null || typeof raw !== 'object') {
      throw new Error(`DevList: Eintrag ${i} ist kein Objekt`);
    }
    const d = raw as Record<string, unknown>;
    if (typeof d['address'] !== 'number' || !Number.isInteger(d['address'])) {
      throw new Error(`DevList: Eintrag ${i} ohne ganzzahlige address`);
    }
    if (typeof d['serial'] !== 'string' || typeof d['name'] !== 'string') {
      throw new Error(`DevList: Eintrag ${i} ohne serial/name`);
    }
    devices.push({ address: d['address'], serial: d['serial'], name: d['name'] });
  }
  return { created_at: obj['created_at'], devices };
}

/** Vorrang bei mehreren Einträgen je Adresse: reale Geräte zuerst. */
const KIND_RANG: Record<DeviceKind, number> = {
  device: 0,
  central: 1,
  pseudo: 2,
  team: 3,
};

export class DeviceResolver {
  readonly createdAt: Date;
  readonly #byAddress = new Map<number, ResolvedDevice[]>();
  readonly #total: number;

  constructor(list: DevList) {
    this.createdAt = new Date(list.created_at * 1000);
    this.#total = list.devices.length;
    for (const entry of list.devices) {
      const resolved = toResolved(entry);
      const existing = this.#byAddress.get(entry.address);
      if (existing === undefined) {
        this.#byAddress.set(entry.address, [resolved]);
      } else {
        existing.push(resolved);
        existing.sort((a, b) => KIND_RANG[a.kind] - KIND_RANG[b.kind]);
      }
    }
  }

  /** Anzahl der Listeneinträge (inklusive Gruppen und Pseudoadressen). */
  get size(): number {
    return this.#total;
  }

  /** Anzahl unterschiedlicher Adressen. */
  get addressCount(): number {
    return this.#byAddress.size;
  }

  /** Alle Einträge zu einer Adresse, Vorrangreihenfolge (Gerät zuerst). */
  entries(address: number): ResolvedDevice[] {
    return this.#byAddress.get(address) ?? [];
  }

  /** Der maßgebliche Eintrag zu einer Adresse — reale Geräte vor Gruppen. */
  resolve(address: number): ResolvedDevice | undefined {
    return this.#byAddress.get(address)?.[0];
  }

  /**
   * Anzeigename einer Adresse. Unbekannte Adressen liefern die Hex-Darstellung
   * — dasselbe, was der Sniffer ausgibt, damit die Zuordnung von Hand möglich
   * bleibt.
   */
  nameOf(address: number): string {
    return (
      this.resolve(address)?.name ??
      address.toString(16).toUpperCase().padStart(6, '0')
    );
  }
}
