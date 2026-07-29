/**
 * Die Demo-Anlage: ein erfundener, aber realistischer Homematic-Haushalt.
 *
 * Aus DERSELBEN Quelle entstehen der simulierte Funkverkehr (port.ts) und
 * die Geräteliste — Namen und Adressen passen deshalb immer zusammen, genau
 * wie bei einer echten CCU.
 */

export interface DemoGeraet {
  address: number;
  serial: string;
  name: string;
  /** BidCoS-Message-Typ; ≥ 0x80 gilt als HmIP. */
  msgType: number;
  flags: number;
  payloadBytes: number;
  /** mittlerer Sendeabstand; der tatsächliche streut um ±jitterMs. */
  intervalMs: number;
  jitterMs: number;
  /** typischer Empfangspegel dieses Geräts in dBm. */
  baseRssi: number;
  /** true → Telegramm an die Zentrale, sonst Broadcast (000000). */
  anZentrale: boolean;
}

export const DEMO_ZENTRALE = 0xb0_00_01;

const MIN = 60_000;

export const DEMO_GERAETE: DemoGeraet[] = [
  // Wettersensoren: gemütlicher Takt, Broadcast
  { address: 0x30_00_01, serial: 'LEQ0700001', name: 'Wetter_Terrasse',
    msgType: 0x70, flags: 0x00, payloadBytes: 5, intervalMs: 2.5 * MIN, jitterMs: 20_000, baseRssi: -72, anZentrale: false },
  { address: 0x30_00_02, serial: 'LEQ0700002', name: 'Wetter_Vorgarten',
    msgType: 0x70, flags: 0x00, payloadBytes: 5, intervalMs: 3 * MIN, jitterMs: 25_000, baseRssi: -84, anZentrale: false },
  { address: 0x30_00_03, serial: 'MEQ0700003', name: 'Temperatur_Wäschekeller',
    msgType: 0x70, flags: 0x00, payloadBytes: 5, intervalMs: 3 * MIN, jitterMs: 30_000, baseRssi: -61, anZentrale: false },

  // Heizkörperthermostate: melden an die Zentrale
  { address: 0x31_00_01, serial: 'NEQ0710001', name: 'Thermostat_Wohnzimmer',
    msgType: 0x5a, flags: 0x20, payloadBytes: 4, intervalMs: 2 * MIN, jitterMs: 15_000, baseRssi: -58, anZentrale: true },
  { address: 0x31_00_02, serial: 'NEQ0710002', name: 'Thermostat_Büro',
    msgType: 0x5a, flags: 0x20, payloadBytes: 4, intervalMs: 2 * MIN, jitterMs: 15_000, baseRssi: -66, anZentrale: true },
  { address: 0x31_00_03, serial: 'NEQ0710003', name: 'Thermostat_Schlafzimmer',
    msgType: 0x5a, flags: 0x20, payloadBytes: 4, intervalMs: 2.5 * MIN, jitterMs: 20_000, baseRssi: -74, anZentrale: true },
  { address: 0x31_00_04, serial: 'NEQ0710004', name: 'Thermostat_Bad OG',
    msgType: 0x5a, flags: 0x20, payloadBytes: 4, intervalMs: 2.5 * MIN, jitterMs: 20_000, baseRssi: -79, anZentrale: true },

  // Bewegungsmelder: Burst-Präambel, unregelmäßig
  { address: 0x32_00_01, serial: 'OEQ0720001', name: 'BWM_Flur EG',
    msgType: 0x41, flags: 0x10, payloadBytes: 3, intervalMs: 4 * MIN, jitterMs: 3 * MIN, baseRssi: -55, anZentrale: true },
  { address: 0x32_00_02, serial: 'OEQ0720002', name: 'BWM_Einfahrt',
    msgType: 0x41, flags: 0x10, payloadBytes: 3, intervalMs: 6 * MIN, jitterMs: 4 * MIN, baseRssi: -88, anZentrale: true },

  // Strommess-Steckdose: zyklisch
  { address: 0x33_00_01, serial: 'PEQ0730001', name: 'Steckdose_Waschmaschine',
    msgType: 0x5f, flags: 0x00, payloadBytes: 6, intervalMs: 2 * MIN, jitterMs: 5_000, baseRssi: -63, anZentrale: true },

  // HmIP-Geräte (Typ ≥ 0x80, 14-stellige Seriennummer)
  { address: 0x34_00_01, serial: '0030DDA9BEE001', name: 'Fenster_Küche (HmIP)',
    msgType: 0x96, flags: 0x00, payloadBytes: 6, intervalMs: 7 * MIN, jitterMs: 5 * MIN, baseRssi: -69, anZentrale: true },
  { address: 0x34_00_02, serial: '0030DDA9BEE002', name: 'Fenster_Büro (HmIP)',
    msgType: 0x96, flags: 0x00, payloadBytes: 6, intervalMs: 9 * MIN, jitterMs: 6 * MIN, baseRssi: -75, anZentrale: true },
  { address: 0x34_00_03, serial: '0030DDA9BEE003', name: 'Tür_Haustür (HmIP)',
    msgType: 0x96, flags: 0x00, payloadBytes: 6, intervalMs: 10 * MIN, jitterMs: 7 * MIN, baseRssi: -81, anZentrale: true },

  // Ein defektes Gerät, das dauersendet — führt die Duty-Cycle-Liste an
  // und zeigt die Warnfarben: Burst alle ~40 s ≈ 90 % Kontingent.
  { address: 0x35_00_01, serial: 'KEQ0750001', name: 'Defekt_BWM Carport (klemmt)',
    msgType: 0x41, flags: 0x10, payloadBytes: 3, intervalMs: 40_000, jitterMs: 5_000, baseRssi: -93, anZentrale: true },
];

/** Geräteliste im CCU-Format — Zentrale doppelt, wie im Original. */
export function demoDevListJson(nowMs: number): string {
  const devices = [
    { address: DEMO_ZENTRALE, serial: 'HmIP-RF', name: 'HmIP-RCV-50 HmIP-RCV-1' },
    { address: DEMO_ZENTRALE, serial: 'HmIP-RF', name: 'RPI-RF-MOD DEMO00000001' },
    ...DEMO_GERAETE.map((g) => ({
      address: g.address,
      serial: g.serial,
      name: g.name,
    })),
  ];
  return JSON.stringify({ created_at: Math.floor(nowMs / 1000), devices });
}
