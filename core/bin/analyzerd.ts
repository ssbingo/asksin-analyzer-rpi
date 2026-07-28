#!/usr/bin/env node
/**
 * analyzerd — der Dienst-Einstiegspunkt für den Dauerbetrieb.
 *
 * Setzt alle Bausteine zusammen (Analyzer, DevListService, ApiServer) und
 * kümmert sich um das Drumherum: Konfigurationsdatei, Verzeichnisse,
 * Logzeilen für journald und sauberes Herunterfahren auf SIGINT/SIGTERM.
 *
 *   node core/bin/analyzerd.ts [/etc/asksin-analyzer/config.json]
 *
 * Ohne Argument wird /etc/asksin-analyzer/config.json versucht; fehlt die
 * Datei, laufen überall die Vorgaben (lokale Datenbank, nur 127.0.0.1).
 * `/reboot` der API beendet den Prozess mit Code 0 — systemd startet ihn
 * mit `Restart=always` neu.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { ApiServer } from '../src/api/server.ts';
import { DEFAULT_BAUD, DEFAULT_DEVICE, sttyPortOpener } from '../src/ingest/sttyPort.ts';
import { openDatabase } from '../src/persist/db.ts';
import { DevListService } from '../src/resolve/fetcher.ts';
import { Analyzer } from '../src/service/analyzer.ts';

// ---- Konfiguration ------------------------------------------------------

interface Konfiguration {
  /** Serielles Gerät des Sniffers. */
  device: string;
  /** Baudrate — 58 824, nicht 57 600 (hardware/README.md, Abschnitt 2.5). */
  baud: number;
  /** Pfad der SQLite-Datenbank. */
  db: string;
  http: {
    /** 127.0.0.1 = nur lokal; fürs LAN bewusst auf 0.0.0.0 stellen. */
    host: string;
    port: number;
    /** Wenn gesetzt: Pflicht-Token für alle verändernden Endpunkte. */
    authToken: string;
  };
  ccu: {
    /** IP/Hostname der CCU; leer = keine Namensauflösung. */
    host: string;
    cachePath: string;
  };
  retention: {
    telegramsDays: number;
    noiseDays: number;
    deviceHoursDays: number;
  };
}

const VORGABEN: Konfiguration = {
  device: DEFAULT_DEVICE,
  baud: DEFAULT_BAUD,
  db: '/var/lib/asksin-analyzer/analyzer.db',
  http: { host: '127.0.0.1', port: 8080, authToken: '' },
  ccu: { host: '', cachePath: '/var/lib/asksin-analyzer/devlist.json' },
  retention: { telegramsDays: 30, noiseDays: 90, deviceHoursDays: 365 },
};

function ladeKonfiguration(pfad: string): Konfiguration {
  if (!existsSync(pfad)) {
    log(`Keine Konfigurationsdatei ${pfad} — Vorgaben aktiv`);
    return VORGABEN;
  }
  const roh = JSON.parse(readFileSync(pfad, 'utf8')) as Record<string, unknown>;
  const k: Konfiguration = {
    ...VORGABEN,
    ...roh,
    http: { ...VORGABEN.http, ...(roh['http'] as object | undefined) },
    ccu: { ...VORGABEN.ccu, ...(roh['ccu'] as object | undefined) },
    retention: { ...VORGABEN.retention, ...(roh['retention'] as object | undefined) },
  };
  log(`Konfiguration aus ${pfad} geladen`);
  return k;
}

// ---- Kleinkram ----------------------------------------------------------

function log(text: string): void {
  // journald stempelt selbst — keine eigene Uhrzeit davor.
  console.log(text);
}

function paketVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(join(import.meta.dirname, '../package.json'), 'utf8'),
    ) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

// ---- Zusammensetzen -----------------------------------------------------

const konfig = ladeKonfiguration(process.argv[2] ?? '/etc/asksin-analyzer/config.json');

mkdirSync(dirname(konfig.db), { recursive: true });
const db = openDatabase(konfig.db);
log(`Datenbank: ${konfig.db}`);

const devList =
  konfig.ccu.host === ''
    ? undefined
    : new DevListService({
        host: konfig.ccu.host,
        cachePath: konfig.ccu.cachePath,
        onUpdate: (resolver, quelle) =>
          log(`Geräteliste: ${resolver.size} Einträge (${quelle})`),
        onError: (err) => log(`Geräteliste: ${String(err)}`),
      });
if (devList === undefined) {
  log('Keine CCU konfiguriert — Geräte erscheinen als Hex-Adressen');
}

const analyzer = new Analyzer({
  openPort: sttyPortOpener(konfig.device, konfig.baud),
  db,
  ...(devList === undefined ? {} : { devList }),
  retention: konfig.retention,
  onStateChange: (s) => {
    if (s.connected) log('Sniffer verbunden — gültige Daten auf der Leitung');
    else
      log(
        `Sniffer getrennt (${s.reason})` +
          (s.retryInMs === undefined ? '' : ` — nächster Versuch in ${s.retryInMs} ms`),
      );
  },
  onError: (err) => log(`Persistenz: ${String(err)}`),
});

const uiDir = resolve(import.meta.dirname, '../../webui/dist');
const api = new ApiServer({
  analyzer,
  db,
  ...(devList === undefined ? {} : { devList }),
  version: paketVersion(),
  config: { ccuip: konfig.ccu.host },
  ...(konfig.http.authToken === '' ? {} : { authToken: konfig.http.authToken }),
  ...(existsSync(uiDir) ? { uiDir } : {}),
  onReboot: () => {
    log('Neustart über die API angefordert — beende (systemd startet neu)');
    void herunterfahren(0);
  },
});

analyzer.start();
const { host, port } = await api.listen(konfig.http.port, konfig.http.host);
log(`AskSin-Analyzer ${paketVersion()} — API auf http://${host}:${port}`);
if (existsSync(uiDir)) log(`Web-UI: ${uiDir}`);
else log('Kein Web-UI gefunden (webui/dist fehlt) — nur API');

// ---- Sauber herunterfahren ---------------------------------------------

let beendet = false;
async function herunterfahren(code: number): Promise<void> {
  if (beendet) return;
  beendet = true;
  log('Fahre herunter …');
  try {
    await api.close();
    await analyzer.stop();          // letzter Flush passiert hier
    db.close();
    log('Sauber beendet');
  } catch (err) {
    log(`Beim Beenden: ${String(err)}`);
    code = 1;
  }
  process.exit(code);
}

process.on('SIGINT', () => void herunterfahren(0));
process.on('SIGTERM', () => void herunterfahren(0));
