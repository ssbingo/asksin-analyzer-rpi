/**
 * Demo-Modus — ein simulierter Sniffer-Port.
 *
 * Die Simulation setzt ganz unten an: Sie erzeugt exakt die Zeilen, die der
 * echte AskSinSniffer328P über die serielle Schnittstelle schicken würde
 * (Telegramme im `:RR…;`-Rahmen, Rauschzeilen alle 750 ms, eine Bootmeldung,
 * gelegentlich ein Störimpuls). Alles dahinter — Parser, Statistik, SQLite,
 * API, Web-UI — läuft unverändert und wird damit wirklich mitgetestet.
 *
 * Der passende `demoDevListFetch` liefert die Geräteliste im originalen
 * CCU-Drahtformat (latin1, XML-Hülle, HTML-Escapes), sodass auch der
 * komplette Dekodierpfad der Namensauflösung in Betrieb ist.
 */

import type { IngestStream, PortOpener } from '../ingest/ingest.ts';
import { systemTime } from '../ingest/time.ts';
import type { TimeSource } from '../ingest/time.ts';
import type { FetchBytes } from '../resolve/fetcher.ts';
import { DEMO_GERAETE, DEMO_ZENTRALE, demoDevListJson } from './anlage.ts';
import type { DemoGeraet } from './anlage.ts';

const NOISE_INTERVALL_MS = 750;
const STOERIMPULS_INTERVALL_MS = 600_000;

function hex2(n: number): string {
  return n.toString(16).toUpperCase().padStart(2, '0');
}

function hex6(n: number): string {
  return n.toString(16).toUpperCase().padStart(6, '0');
}

/** Telegrammzeile exakt im Sniffer-Rahmen; LL zählt alles nach dem LL-Byte. */
export function baueTelegrammZeile(felder: {
  rssi: number;
  cnt: number;
  flags: number;
  msgType: number;
  from: number;
  to: number;
  payloadHex: string;
}): string {
  const laenge = 9 + felder.payloadHex.length / 2;
  return (
    ':' + hex2(-felder.rssi) + hex2(laenge) + hex2(felder.cnt) +
    hex2(felder.flags) + hex2(felder.msgType) +
    hex6(felder.from) + hex6(felder.to) + felder.payloadHex + ';\r\n'
  );
}

export function baueNoiseZeile(rssi: number): string {
  return ':' + hex2(-rssi) + ';\r\n';
}

function zufallsPayload(bytes: number): string {
  let hex = '';
  for (let i = 0; i < bytes; i++) hex += hex2(Math.floor(Math.random() * 256));
  return hex;
}

interface GeraetZustand {
  geraet: DemoGeraet;
  naechsteAt: number;
  cnt: number;
}

function streuung(ms: number): number {
  return (Math.random() * 2 - 1) * ms;
}

async function* demoStrom(
  time: TimeSource,
  signal: AbortSignal,
): AsyncGenerator<Uint8Array> {
  yield Buffer.from('AskSin++ V4.1.4 (Demo-Modus)\r\n', 'latin1');

  const start = time.now();
  const geraete: GeraetZustand[] = DEMO_GERAETE.map((g) => ({
    geraet: g,
    // Erste Sendung irgendwo im ersten Intervall — kein Gleichtakt beim Start.
    naechsteAt: start + Math.random() * g.intervalMs,
    cnt: Math.floor(Math.random() * 256),
  }));
  let naechstesRauschen = start + NOISE_INTERVALL_MS;
  let naechsterStoerimpuls = start + STOERIMPULS_INTERVALL_MS;
  let rauschBasis = -91;

  for (;;) {
    let wann = Math.min(naechstesRauschen, naechsterStoerimpuls);
    let faellig: GeraetZustand | null = null;
    for (const z of geraete) {
      if (z.naechsteAt < wann) {
        wann = z.naechsteAt;
        faellig = z;
      }
    }

    try {
      await time.delay(Math.max(0, wann - time.now()), signal);
    } catch {
      return;                                   // Port geschlossen
    }

    if (faellig !== null) {
      const g = faellig.geraet;
      faellig.cnt = (faellig.cnt + 1) & 0xff;
      faellig.naechsteAt = wann + g.intervalMs + streuung(g.jitterMs);
      const rssi = Math.max(
        -104,
        Math.min(-45, Math.round(g.baseRssi + streuung(6))),
      );
      yield Buffer.from(
        baueTelegrammZeile({
          rssi,
          cnt: faellig.cnt,
          flags: g.flags,
          msgType: g.msgType,
          from: g.address,
          to: g.anZentrale ? DEMO_ZENTRALE : 0,
          payloadHex: zufallsPayload(g.payloadBytes),
        }),
        'latin1',
      );
    } else if (wann === naechstesRauschen) {
      naechstesRauschen = wann + NOISE_INTERVALL_MS;
      // Grundrauschen wandert träge, gelegentlich ein Störer-Ausreißer:
      rauschBasis = Math.max(-96, Math.min(-86, rauschBasis + streuung(0.4)));
      const ausreisser = Math.random() < 0.005 ? 10 + Math.random() * 6 : 0;
      yield Buffer.from(
        baueNoiseZeile(Math.round(rauschBasis + ausreisser)),
        'latin1',
      );
    } else {
      naechsterStoerimpuls = wann + STOERIMPULS_INTERVALL_MS;
      // Verstümmelte Zeile — hält die Verwurfszähler ehrlich in Betrieb.
      yield Buffer.from(':D3M0;\r\n', 'latin1');
    }
  }
}

/** Der Demo-Port — überall dort einsetzbar, wo `sttyPortOpener` steht. */
export function demoPortOpener(time: TimeSource = systemTime): PortOpener {
  return (signal): Promise<IngestStream> => {
    const ende = new AbortController();
    const schliessen = (): void => {
      ende.abort(new Error('Demo-Port geschlossen'));
    };
    if (signal.aborted) schliessen();
    else signal.addEventListener('abort', schliessen, { once: true });
    return Promise.resolve({
      readable: demoStrom(time, ende.signal),
      close: schliessen,
    });
  };
}

/** Geräteliste im CCU-Drahtformat: latin1-Bytes, XML-Hülle, HTML-Escapes. */
export function demoDevListFetch(time: TimeSource = systemTime): FetchBytes {
  return () => {
    const json = demoDevListJson(time.now());
    const escaped = json.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
    const xml = `<xml><exec>demo</exec><ret>${escaped}</ret></xml>`;
    return Promise.resolve(
      Uint8Array.from([...xml].map((c) => {
        const cp = c.codePointAt(0)!;
        return cp <= 0xff ? cp : 0x3f;
      })),
    );
  };
}
