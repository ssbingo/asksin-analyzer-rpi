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

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { ApiServer } from '../src/api/server.ts';
import type { NetzwerkHooks, UpdateHooks } from '../src/api/server.ts';
import { VerbundDienst } from '../src/verbund/verbund.ts';
import type { PeerKonfig } from '../src/verbund/verbund.ts';
import { demoDevListFetch, demoPortOpener } from '../src/demo/port.ts';
import { DEFAULT_BAUD, DEFAULT_DEVICE, sttyPortOpener } from '../src/ingest/sttyPort.ts';
import { openDatabase } from '../src/persist/db.ts';
import { DevListService } from '../src/resolve/fetcher.ts';
import { Analyzer } from '../src/service/analyzer.ts';
import { flashFirmware, siehtNachIntelHexAus } from '../src/update/firmware.ts';

const execFileAsync = promisify(execFile);

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
  /** Dauerhaft simulierte Daten — üblicherweise steuert das die Flag-Datei
   *  im Datenverzeichnis (Schalter „Demo" in den Einstellungen). */
  demo?: boolean;
  /** Standortname dieses Analyzers (M9.1), z. B. „Keller" — ein REINES
   *  Anzeige-Etikett für Verbund/UI/APIs. Der Hostname des Systems wird
   *  nie verändert, nur als Vorgabe-Beschriftung gelesen. Leer: erst die
   *  über die Weboberfläche gesetzte Datei, sonst der Hostname. */
  standort?: string;
  /** Verbund-Rolle (M9.2): genau EIN Analyzer bekommt hier die anderen
   *  eingetragen; die eigene Instanz wird automatisch ergänzt. */
  verbund?: {
    peers?: Array<{ name?: string; url: string; token?: string }>;
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

// Demo-Modus: Schalter in der Weboberfläche → Flag-Datei im Datenverzeichnis
// (dorthin darf der Dienst schreiben; /etc ist per systemd schreibgeschützt).
// Ein Umschalten beendet den Prozess kontrolliert, systemd startet neu.
const demoFlag = join(dirname(konfig.db), 'demo-modus');
const demoAktiv = konfig.demo === true || existsSync(demoFlag);

// Standort-Identität (M9.1): Konfiguration > per UI gesetzte Datei > Hostname.
const standortDatei = join(dirname(konfig.db), 'standort.txt');
function leseStandort(): string {
  if (konfig.standort !== undefined && konfig.standort.trim() !== '') {
    return konfig.standort.trim();
  }
  try {
    const s = readFileSync(standortDatei, 'utf8').trim();
    if (s !== '') return s;
  } catch {
    /* keine Datei — Hostname als Rückfall */
  }
  return hostname();
}
const standort = leseStandort();

// Eigene Datenbank für die Simulation — echte Aufzeichnungen bleiben sauber.
const dbPfad = demoAktiv
  ? join(dirname(konfig.db), 'analyzer-demo.db')
  : konfig.db;
const db = openDatabase(dbPfad);
log(`Standort: ${standort}`);
log(`Datenbank: ${dbPfad}`);
if (demoAktiv) log('DEMO-MODUS aktiv — alle Daten sind simuliert');

const devList = demoAktiv
  ? new DevListService({
      host: 'demo',
      fetchBytes: demoDevListFetch(),
      onUpdate: (resolver, quelle) =>
        log(`Geräteliste (Demo): ${resolver.size} Einträge (${quelle})`),
    })
  : konfig.ccu.host === ''
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
  openPort: demoAktiv
    ? demoPortOpener()
    : sttyPortOpener(konfig.device, konfig.baud),
  db,
  ...(devList === undefined ? {} : { devList }),
  retention: demoAktiv
    ? { telegramsDays: 2, noiseDays: 7, deviceHoursDays: 30 }
    : konfig.retention,
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

// ---- Update-Mechanik (M7.5) ---------------------------------------------
// Core-Update: Trigger-Datei → systemd-Path-Unit → update.sh (als root).
// So braucht der unprivilegierte Dienst weder sudo noch Schreibrechte auf
// /opt; der Fortschritt kommt über die Statusdatei zurück — auch über den
// eigenen Neustart hinweg. Für M9.4 (Flotten-Update) ist alles reine API.

const installDir = resolve(import.meta.dirname, '../..');
const datenDir = dirname(konfig.db);
const updateTrigger = join(datenDir, 'update-anstoss');
const updateStatusDatei = join(datenDir, 'update-status.json');

function leseUpdateStatus(): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(updateStatusDatei, 'utf8')) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
}

async function gitKurz(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(
    'git', ['-C', installDir, ...args], { timeout: 15_000 },
  );
  return stdout.trim();
}

// Täglicher Selbstcheck: Ergebnis fließt über /api/health in das
// Hinweis-Badge der Weboberfläche. Erster Lauf kurz nach dem Start
// (Netz braucht nach dem Boot einen Moment), danach alle 24 h.
let updateVerfuegbar = false;

async function pruefeAktualitaet(): Promise<void> {
  try {
    const v = (await updateHooks.versions()) as { updateVerfuegbar: boolean };
    if (v.updateVerfuegbar !== updateVerfuegbar) {
      updateVerfuegbar = v.updateVerfuegbar;
      log(
        updateVerfuegbar
          ? 'Neue Version verfügbar — Hinweis in der Weboberfläche aktiv'
          : 'Software ist aktuell',
      );
    }
  } catch (err) {
    log(`Aktualitätsprüfung fehlgeschlagen: ${String(err)}`);
  }
}
setTimeout(() => void pruefeAktualitaet(), 60_000).unref();
setInterval(() => void pruefeAktualitaet(), 86_400_000).unref();

const updateHooks: UpdateHooks = {
  updateVerfuegbar: () => updateVerfuegbar,
  versions: async () => {
    let commit: string;
    try {
      commit = await gitKurz('rev-parse', '--short', 'HEAD');
    } catch (err) {
      // Häufigster Fall: git verweigert das root-eigene Repo („dubious
      // ownership"). installer/update.sh setzen safe.directory — hier
      // trotzdem lesbar melden statt mit 500 zu antworten.
      return {
        version: paketVersion(),
        commit: null,
        verfuegbarCommit: null,
        updateVerfuegbar: false,
        demo: demoAktiv,
        fehler:
          'git nicht nutzbar — auf dem Pi einmalig ausführen: ' +
          'sudo git config --system --add safe.directory /opt/asksin-analyzer ' +
          `(${String(err).split('\n')[0] ?? ''})`,
      };
    }
    let verfuegbar: string | null = null;
    try {
      const ref = await gitKurz('ls-remote', 'origin', 'main');
      verfuegbar = ref.slice(0, 7);
    } catch {
      /* offline — verfügbare Version bleibt unbekannt */
    }
    return {
      version: paketVersion(),
      commit,
      verfuegbarCommit: verfuegbar,
      updateVerfuegbar: verfuegbar !== null && !verfuegbar.startsWith(commit.slice(0, 7)),
      demo: demoAktiv,
    };
  },
  startCoreUpdate: () => {
    const status = leseUpdateStatus();
    if (status !== null && status['running'] === true) return false;
    writeFileSync(updateTrigger, `${new Date().toISOString()}\n`);
    log('Core-Update angestoßen (Trigger-Datei für die systemd-Path-Unit)');
    return true;
  },
  updateStatus: () => leseUpdateStatus(),
  flashFirmware: async (hex) => {
    if (demoAktiv) {
      return { ok: false, log: 'Im Demo-Modus gibt es keine Hardware zum Flashen.' };
    }
    if (!siehtNachIntelHexAus(hex)) {
      return { ok: false, log: 'Upload ist keine gültige Intel-HEX-Datei.' };
    }
    const hexPfad = join(datenDir, 'firmware-upload.hex');
    writeFileSync(hexPfad, hex);
    log('Firmware-Flash: Ingest wird angehalten, Port wird freigegeben');
    await analyzer.stop();
    try {
      const ergebnis = await flashFirmware(hexPfad, { device: konfig.device });
      log(`Firmware-Flash ${ergebnis.ok ? 'erfolgreich' : 'FEHLGESCHLAGEN'}`);
      return ergebnis;
    } finally {
      rmSync(hexPfad, { force: true });
      analyzer.start();
      log('Ingest fortgesetzt');
    }
  },
};

// ---- Verbund-Rolle (M9.2) ------------------------------------------------
// Nur aktiv, wenn Peers konfiguriert sind. Die eigene Instanz kommt
// automatisch als erster Eintrag dazu (über localhost) — die Übersicht
// zeigt damit immer ALLE Standorte inklusive des Masters.

const peerListe: PeerKonfig[] = (konfig.verbund?.peers ?? []).filter(
  (p): p is { url: string } & typeof p => typeof p.url === 'string' && p.url !== '',
);
const verbund =
  peerListe.length === 0
    ? undefined
    : new VerbundDienst({
        peers: [
          {
            name: standort,
            url: `http://127.0.0.1:${konfig.http.port}`,
            ...(konfig.http.authToken === '' ? {} : { token: konfig.http.authToken }),
          },
          ...peerListe,
        ],
      });
if (verbund !== undefined) {
  log(`Verbund-Rolle aktiv: ${peerListe.length} Peer(s) + eigener Standort`);
}

// ---- Netzwerkeinstellungen (M7.6) ---------------------------------------
// Lesen ohne Root; Ändern über Auftragsdatei → systemd-Path-Unit →
// deploy/netz-anwenden.sh (Probezeit + Rollback). docs/netzwerkeinstellungen.md.

const netzAuftrag = join(datenDir, 'netz-auftrag.json');
const netzBestaetigen = join(datenDir, 'netz-bestaetigen');
const netzStatusDatei = join(datenDir, 'netz-status.json');

const IPV4 = /^(\d{1,3})(\.\d{1,3}){3}$/;
const HOSTNAME_OK = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;

async function kommando(cmd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(cmd, args, { timeout: 10_000 });
  return stdout;
}

async function netzZustand(): Promise<Record<string, unknown>> {
  // Standardroute → Schnittstelle + Gateway
  let iface: string | null = null;
  let gateway: string | null = null;
  try {
    const routen = JSON.parse(await kommando('ip', ['-j', 'route', 'show', 'default'])) as Array<
      Record<string, unknown>
    >;
    iface = (routen[0]?.['dev'] as string | undefined) ?? null;
    gateway = (routen[0]?.['gateway'] as string | undefined) ?? null;
  } catch {
    /* keine Standardroute */
  }

  const adressen: Array<{ address: string; prefix: number }> = [];
  try {
    const geraete = JSON.parse(await kommando('ip', ['-j', 'addr', 'show'])) as Array<
      Record<string, unknown>
    >;
    for (const g of geraete) {
      if (iface !== null && g['ifname'] !== iface) continue;
      for (const a of (g['addr_info'] as Array<Record<string, unknown>> | undefined) ?? []) {
        if (a['family'] === 'inet' && typeof a['local'] === 'string') {
          adressen.push({ address: a['local'], prefix: Number(a['prefixlen'] ?? 24) });
        }
      }
    }
  } catch {
    /* ip nicht verfügbar — bleibt leer */
  }

  let dns: string[] = [];
  try {
    dns = readFileSync('/etc/resolv.conf', 'utf8')
      .split('\n')
      .filter((z) => z.startsWith('nameserver '))
      .map((z) => z.slice('nameserver '.length).trim());
  } catch {
    /* keine resolv.conf */
  }

  // Methode + Änderbarkeit über NetworkManager
  let methode: 'dhcp' | 'statisch' | 'unbekannt' = 'unbekannt';
  let verbindung: string | null = null;
  let aenderbar = false;
  let grund: string | null = null;
  try {
    const aktiv = await kommando('nmcli', ['-t', '-f', 'NAME,DEVICE', 'connection', 'show', '--active']);
    for (const zeile of aktiv.trim().split('\n')) {
      const [name, dev] = zeile.split(':');
      if (dev === iface && name !== undefined) verbindung = name;
    }
    if (verbindung !== null) {
      const m = (await kommando('nmcli', ['-t', '-f', 'ipv4.method', 'connection', 'show', verbindung])).trim();
      methode = m.endsWith('auto') ? 'dhcp' : m.endsWith('manual') ? 'statisch' : 'unbekannt';
      aenderbar = true;
    } else {
      grund = 'Keine aktive NetworkManager-Verbindung für die Schnittstelle gefunden';
    }
  } catch {
    grund = 'NetworkManager (nmcli) nicht gefunden — Ändern deaktiviert, Anzeige funktioniert';
  }

  // NTP-Zustand
  let ntpSync: boolean | null = null;
  let ntpServer: string | null = null;
  try {
    const td = await kommando('timedatectl', ['show']);
    ntpSync = /NTPSynchronized=yes/.test(td);
  } catch {
    /* timedatectl fehlt */
  }
  for (const pfad of [
    '/etc/systemd/timesyncd.conf.d/asksin.conf',
    '/etc/systemd/timesyncd.conf',
  ]) {
    try {
      const m = /^NTP=(.+)$/m.exec(readFileSync(pfad, 'utf8'));
      if (m !== null && m[1]!.trim() !== '') {
        ntpServer = m[1]!.trim();
        break;
      }
    } catch {
      /* Datei fehlt */
    }
  }

  return {
    hostname: hostname(),
    iface,
    verbindung,
    methode,
    aenderbar,
    grund,
    adressen,
    gateway,
    dns,
    ntp: { server: ntpServer, sync: ntpSync },
  };
}

function leseNetzStatus(): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(netzStatusDatei, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const netzwerkHooks: NetzwerkHooks = {
  zustand: netzZustand,
  status: leseNetzStatus,
  anwenden: (auftrag) => {
    const status = leseNetzStatus();
    if (status !== null && status['running'] === true) return false;
    const methode = auftrag['method'];
    if (methode !== 'dhcp' && methode !== 'statisch') {
      throw new Error('method muss dhcp oder statisch sein');
    }
    if (methode === 'statisch') {
      if (typeof auftrag['address'] !== 'string' || !IPV4.test(auftrag['address'])) {
        throw new Error('address: keine gültige IPv4-Adresse');
      }
      const prefix = Number(auftrag['prefix']);
      if (!Number.isInteger(prefix) || prefix < 1 || prefix > 32) {
        throw new Error('prefix: 1–32 erwartet');
      }
      if (typeof auftrag['gateway'] !== 'string' || !IPV4.test(auftrag['gateway'])) {
        throw new Error('gateway: keine gültige IPv4-Adresse');
      }
      const dns = auftrag['dns'];
      if (!Array.isArray(dns) || dns.some((d) => typeof d !== 'string' || !IPV4.test(d))) {
        throw new Error('dns: Liste gültiger IPv4-Adressen erwartet');
      }
    }
    const neuerHostname = auftrag['hostname'];
    if (
      neuerHostname !== undefined &&
      neuerHostname !== '' &&
      (typeof neuerHostname !== 'string' || !HOSTNAME_OK.test(neuerHostname))
    ) {
      throw new Error('hostname: nur Buchstaben, Ziffern und Bindestriche');
    }
    writeFileSync(netzAuftrag, JSON.stringify(auftrag, null, 2));
    log('Netzwerk-Auftrag abgelegt — Probezeit beginnt (netz-anwenden.sh)');
    return true;
  },
  bestaetigen: () => {
    writeFileSync(netzBestaetigen, `${new Date().toISOString()}\n`);
    log('Netzwerkeinstellungen bestätigt — werden dauerhaft übernommen');
    return true;
  },
};

const uiDir = resolve(import.meta.dirname, '../../webui/dist');
const api = new ApiServer({
  analyzer,
  db,
  ...(devList === undefined ? {} : { devList }),
  version: paketVersion(),
  config: { ccuip: konfig.ccu.host, demo: demoAktiv, standort },
  ...(konfig.http.authToken === '' ? {} : { authToken: konfig.http.authToken }),
  ...(existsSync(uiDir) ? { uiDir } : {}),
  update: updateHooks,
  ...(verbund === undefined ? {} : { verbund }),
  netzwerk: netzwerkHooks,
  onReboot: () => {
    log('Neustart über die API angefordert — beende (systemd startet neu)');
    void herunterfahren(0);
  },
  onSetConfig: (aenderungen) => {
    const neuerStandort = aenderungen['standort'];
    if (neuerStandort !== undefined) {
      // Dauerhaft merken — /etc ist schreibgeschützt, das Datenverzeichnis
      // gehört dem Dienst. Wirksam sofort (ApiServer) und nach Neustarts.
      if (neuerStandort.trim() === '') rmSync(standortDatei, { force: true });
      else writeFileSync(standortDatei, `${neuerStandort.trim()}\n`);
      log(`Standort geändert: ${neuerStandort.trim() || hostname()}`);
    }
    const demo = aenderungen['demo'];
    if (demo === undefined) return;
    const gewuenscht = demo === '1' || demo === 'true';
    if (gewuenscht === demoAktiv) return;
    if (!gewuenscht && konfig.demo === true) {
      log('Demo ist in der Konfigurationsdatei fest eingeschaltet — dort ändern');
      return;
    }
    if (gewuenscht) writeFileSync(demoFlag, 'aktiv\n');
    else rmSync(demoFlag, { force: true });
    log(`Demo-Modus ${gewuenscht ? 'ein' : 'aus'}geschaltet — Dienst startet neu`);
    // Antwort erst rausgehen lassen, dann kontrolliert beenden:
    setTimeout(() => void herunterfahren(0), 300);
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
