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
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  statfsSync,
  writeFileSync,
} from 'node:fs';
import { freemem, hostname, loadavg, networkInterfaces, totalmem } from 'node:os';
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
import { INFLUX_VORGABEN, InfluxSchreiber } from '../src/influx/schreiber.ts';
import {
  geltendeRolle,
  istRolle,
  masterFaehig,
  rolleMitHardware,
  verlangeMaster,
} from '../src/langzeit/rolle.ts';
import type { Rolle } from '../src/langzeit/rolle.ts';
import {
  ALARMZIEL_VORGABEN,
  baueAlarmProvisionierung,
  baueProbeMeldung,
  baueProbeText,
  baueSmtpUmgebung,
  deuteZustellfehler,
  istAlarmkanal,
  pruefeAlarmziel,
} from '../src/langzeit/alarmziel.ts';
import type { Alarmkanal, Alarmziel } from '../src/langzeit/alarmziel.ts';
import { deuteSmtpFehler, netzLeitung, smtpTestlauf } from '../src/langzeit/smtp.ts';
import type { InfluxDaten, InfluxKonfig } from '../src/influx/schreiber.ts';
import { Protokoll, istStufe } from '../src/log/protokoll.ts';
import type { Stufe } from '../src/log/protokoll.ts';
import { auffaelligkeiten, erhebeSystemwerte, leseLuefterUpm } from '../src/log/diagnose.ts';
import { Systemlog } from '../src/log/systemlog.ts';
import { StatusAnzeige } from '../src/status/anzeige.ts';
import { OLED_HOEHE_VORGABE, OledBild } from '../src/status/ssd1306.ts';
import type { OledHoehe } from '../src/status/ssd1306.ts';
import {
  DUTY_ALARM_PROZENT,
  SEITEN_ANZAHL,
  ledMuster,
  zeichneSeite,
} from '../src/status/zustand.ts';
import type { StatusDaten } from '../src/status/zustand.ts';
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
    /** 'master' oder 'client' (M14). Entscheidet, ob Langzeitdaten lokal
     *  gespeichert werden duerfen. Ueblicherweise ueber das WebUI gesetzt. */
    rolle?: string;
  };
  /** Protokoll (M13): Stufe und Aufbewahrung; üblicherweise über das WebUI. */
  protokoll?: {
    stufe?: string;
    tage?: number;
  };
  /** Status-LED und OLED (M11) — Zubehör an J5–J7 der Platine V4.
   *  LED: SPI-Variante (R5 statt R4 bestücken). Vorgabe: alles aus. */
  statusanzeige?: {
    led?: 'ws2812-spi' | 'ws2812-pwm' | 'aus';
    oled?: boolean;
    helligkeit?: number;
    /** Bauhöhe des OLED: 32 (Adafruit PiOLED, Vorgabe) oder 64. */
    oledHoehe?: 32 | 64;
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

/** Wird erst nach dem Laden der Konfiguration gesetzt (Pfad steht dort). */
let protokoll: Protokoll | null = null;

function log(text: string): void {
  // journald stempelt selbst — keine eigene Uhrzeit davor.
  console.log(text);
  // Dasselbe zusätzlich in die Logdatei; sie überlebt einen harten Absturz
  // besser als der Journalpuffer und lässt sich im WebUI herunterladen.
  protokoll?.schreibe('info', 'dienst', text);
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

// ---- Protokoll (M13) ----------------------------------------------------
// Stufe und Aufbewahrung sind über die Weboberfläche einstellbar und liegen
// dienst-schreibbar im Datenverzeichnis; config.json bleibt Experten-Weg.
const protokollDatei = join(dirname(konfig.db), 'protokoll.json');
const protokollVerzeichnis = join(dirname(konfig.db), 'protokoll');

interface ProtokollKonfig {
  stufe: Stufe;
  tage: number;
}

function protokollKonfigLesen(): ProtokollKonfig {
  const basis: ProtokollKonfig = {
    stufe: istStufe(konfig.protokoll?.stufe) ? konfig.protokoll.stufe : 'info',
    tage: typeof konfig.protokoll?.tage === 'number' ? konfig.protokoll.tage : 14,
  };
  try {
    const ui = JSON.parse(readFileSync(protokollDatei, 'utf8')) as Record<string, unknown>;
    return {
      stufe: istStufe(ui['stufe']) ? ui['stufe'] : basis.stufe,
      tage: typeof ui['tage'] === 'number' ? ui['tage'] : basis.tage,
    };
  } catch {
    return basis;
  }
}

{
  const k = protokollKonfigLesen();
  protokoll = new Protokoll({
    verzeichnis: protokollVerzeichnis,
    stufe: k.stufe,
    tage: k.tage,
  });
}

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

/** Kerntemperatur in Grad Celsius; null ohne Sensor (Entwicklungsrechner). */
function leseTempC(): number | null {
  try {
    return (
      Number(readFileSync('/sys/class/thermal/thermal_zone0/temp', 'utf8')) / 1000
    );
  } catch {
    return null;
  }
}

/** Freier Platz im Datenverzeichnis in Prozent; null, wenn nicht ermittelbar. */
function leseDiskFreiProzent(): number | null {
  try {
    const fs = statfsSync(datenDir);
    return (fs.bavail / fs.blocks) * 100;
  } catch {
    return null;
  }
}

// ---- Verbund-Rolle (M9.2) ------------------------------------------------
// JEDER Analyzer ist verbundfähig; „Master" wird er dadurch, dass ihm der
// Anwender unter Einstellungen → Verbund Peers hinzufügt (keine Konsole
// nötig). config.json-Peers bleiben als Experten-Weg zusätzlich möglich.
// Die eigene Instanz ist immer der erste Eintrag.

const verbundPeersDatei = join(datenDir, 'verbund-peers.json');

const konfigPeers: PeerKonfig[] = (konfig.verbund?.peers ?? []).filter(
  (p): p is { url: string } & typeof p => typeof p.url === 'string' && p.url !== '',
);

function leseUiPeers(): PeerKonfig[] {
  try {
    const roh = JSON.parse(readFileSync(verbundPeersDatei, 'utf8')) as unknown;
    if (!Array.isArray(roh)) return [];
    return roh.filter(
      (p): p is PeerKonfig =>
        p !== null && typeof p === 'object' && typeof (p as PeerKonfig).url === 'string',
    );
  } catch {
    return [];
  }
}

function allePeers(): PeerKonfig[] {
  const selbst: PeerKonfig = {
    name: standort,
    url: `http://127.0.0.1:${konfig.http.port}`,
    ...(konfig.http.authToken === '' ? {} : { token: konfig.http.authToken }),
  };
  const gesehen = new Set([selbst.url]);
  const liste = [selbst];
  for (const p of [...konfigPeers, ...leseUiPeers()]) {
    const url = p.url.replace(/\/+$/, '');
    if (gesehen.has(url)) continue;
    gesehen.add(url);
    liste.push({ ...p, url });
  }
  return liste;
}

const verbund = new VerbundDienst({
  peers: allePeers(),
  // Flotten-Update (M9.4): der eigene Analyzer kommt zum Schluss und
  // nutzt denselben Mechanismus wie der Update-Knopf der Info-Seite.
  selbstUpdate: () => updateHooks.startCoreUpdate(),
});
if (verbund.peerAnzahl > 1) {
  log(`Verbund: ${verbund.peerAnzahl - 1} Peer(s) + eigener Standort`);
}

const URL_OK = /^https?:\/\/[^\s]+$/;

const verbundHooks = {
  uebersicht: () => verbund.uebersicht(),
  matrix: () => verbund.matrix(),
  matrixCsv: () => verbund.matrixCsv(),
  telegramme: () => verbund.telegramme(),
  starteFlottenUpdate: () => verbund.starteFlottenUpdate(),
  flottenStatus: () => verbund.flottenStatus(),
  /** Peer-Liste für die UI — Tokens werden NIE herausgegeben. */
  peers: () => ({
    peers: [
      ...konfigPeers.map((p) => ({
        url: p.url,
        name: p.name ?? null,
        hatToken: p.token !== undefined,
        quelle: 'config' as const,
      })),
      ...leseUiPeers().map((p) => ({
        url: p.url,
        name: p.name ?? null,
        hatToken: p.token !== undefined,
        quelle: 'ui' as const,
      })),
    ],
  }),
  peersAendern: (auftrag: Record<string, unknown>): void => {
    const aktion = auftrag['aktion'];
    const url = typeof auftrag['url'] === 'string' ? auftrag['url'].trim().replace(/\/+$/, '') : '';
    if (!URL_OK.test(url)) throw new Error('url: http(s)://… erwartet');
    let uiPeers = leseUiPeers();
    if (aktion === 'hinzufuegen') {
      if (uiPeers.some((p) => p.url === url) || konfigPeers.some((p) => p.url === url)) {
        throw new Error('Dieser Analyzer ist bereits eingetragen');
      }
      const neu: PeerKonfig = { url };
      if (typeof auftrag['name'] === 'string' && auftrag['name'].trim() !== '') {
        neu.name = auftrag['name'].trim();
      }
      if (typeof auftrag['token'] === 'string' && auftrag['token'] !== '') {
        neu.token = auftrag['token'];
      }
      uiPeers.push(neu);
    } else if (aktion === 'entfernen') {
      uiPeers = uiPeers.filter((p) => p.url !== url);
    } else {
      throw new Error('aktion: hinzufuegen oder entfernen erwartet');
    }
    writeFileSync(verbundPeersDatei, JSON.stringify(uiPeers, null, 2));
    verbund.setPeers(allePeers());
    log(`Verbund-Peers geändert (${String(aktion)}: ${url}) — sofort wirksam`);
  },
};

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

  // NTP-Zustand: konfigurierter Server (Drop-in/Conf) UND der tatsächlich
  // verwendete (timesyncd-Laufzeitdaten — deckt auch DHCP-gelieferte ab).
  let ntpSync: boolean | null = null;
  let ntpServer: string | null = null;
  let ntpAktiv: string | null = null;
  try {
    const td = await kommando('timedatectl', ['show']);
    ntpSync = /NTPSynchronized=yes/.test(td);
  } catch {
    /* timedatectl fehlt */
  }
  try {
    const ts = await kommando('timedatectl', ['show-timesync']);
    const server = /^ServerName=(.+)$/m.exec(ts)?.[1]?.trim();
    if (server !== undefined && server !== '') ntpAktiv = server;
    else {
      const fallback = /^FallbackNTPServers=(.+)$/m.exec(ts)?.[1]?.trim();
      if (fallback !== undefined && fallback !== '') {
        ntpAktiv = `${fallback.split(' ')[0]} (Fallback)`;
      }
    }
  } catch {
    /* show-timesync nicht verfügbar */
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
    ntp: { server: ntpServer, aktiv: ntpAktiv, sync: ntpSync },
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

// ---- Status-LED und OLED (M11) ------------------------------------------

function eigeneIp(): string {
  for (const eintraege of Object.values(networkInterfaces())) {
    for (const e of eintraege ?? []) {
      if (!e.internal && e.family === 'IPv4') return e.address;
    }
  }
  return '';
}

function statusDaten(): StatusDaten {
  const s = analyzer.snapshot();
  let maxDuty: { name: string; percent: number } | null = null;
  for (const g of s.devices) {
    if (maxDuty === null || g.dutyCyclePercent > maxDuty.percent) {
      maxDuty = { name: g.name, percent: g.dutyCyclePercent };
    }
  }
  // Dauersender: Ein einziges defektes Gerät kann das Funknetz zustopfen.
  // Höchstens fünf, sonst wird das Durchblättern am Gerät zur Zumutung.
  const dutyAlarme = s.devices
    .filter((g) => g.dutyCyclePercent >= DUTY_ALARM_PROZENT)
    .sort((a, b) => b.dutyCyclePercent - a.dutyCyclePercent)
    .slice(0, 5)
    .map((g) => ({ name: g.name, percent: g.dutyCyclePercent }));
  const tempC = leseTempC();
  const diskFreiProzent = leseDiskFreiProzent();
  // Lüfterdrehzahl kommt aus derselben hwmon-Quelle wie in der Diagnose;
  // ohne Lüfter (Pi 3, passiv gekühlt) bleibt der Wert null.
  const luefterUpm = leseLuefterUpm();
  return {
    standort,
    version: paketVersion(),
    ip: eigeneIp(),
    connected: s.ingest.connected,
    demo: demoAktiv,
    updateVerfuegbar,
    persistErrors: s.persistErrors,
    telegramsPerMinute: s.telegramsPerMinute,
    noiseFloor: s.noiseFloor.ewma,
    deviceCount: s.devices.length,
    maxDutyCycle: maxDuty,
    dutyAlarme,
    system: {
      cpuLast: loadavg()[0] ?? 0,
      tempC,
      ramFreiProzent: (freemem() / totalmem()) * 100,
      diskFreiProzent,
      luefterUpm,
    },
  };
}

// Konfiguration: die per WebUI gesetzte Datei ÜBERSCHREIBT config.json —
// „im Nachhinein aktivierbar", ganz ohne Konsole (Leitlinie des Projekts).
const statusKonfigDatei = join(datenDir, 'statusanzeige.json');

/**
 * Verzeichnis für kurzlebige Austauschdateien zwischen den Diensten.
 *
 * Die Farbe der LED, der Anzeigezustand und der zuletzt gezeichnete
 * Framebuffer sind **keine Daten**, sondern Zurufe zwischen Prozessen. Sie
 * lagen bisher unter /var/lib und damit auf der Platte — die Zustandsdatei
 * wird bei jeder Wertänderung neu geschrieben, im Demo-Modus mehrmals je
 * Minute. Auf einem Pi, der über USB von einer SSD bootet, ist das eine
 * unnötige Dauerlast auf genau der Verbindung, die als Wackelkandidat gilt.
 *
 * /run liegt im Arbeitsspeicher (tmpfs) und ist der richtige Ort dafür. Gibt
 * es das Verzeichnis nicht — etwa beim Start von Hand ohne systemd —, bleibt
 * es beim Datenverzeichnis.
 */
const laufzeitDir = (() => {
  const kandidat = '/run/asksin-analyzer';
  try {
    mkdirSync(kandidat, { recursive: true });
    accessSync(kandidat, constants.W_OK);
    return kandidat;
  } catch {
    return datenDir;
  }
})();

interface StatusKonfig {
  led: 'ws2812-spi' | 'ws2812-pwm' | 'aus';
  oled: boolean;
  helligkeit: number;
  /** Bauhöhe des Panels: 32 (Adafruit PiOLED, Vorgabe) oder 64. */
  oledHoehe: OledHoehe;
}

function statusKonfigLesen(): StatusKonfig {
  let basis = {
    led: konfig.statusanzeige?.led ?? 'aus',
    oled: konfig.statusanzeige?.oled === true,
    helligkeit: konfig.statusanzeige?.helligkeit ?? 40,
    oledHoehe: konfig.statusanzeige?.oledHoehe === 64 ? 64 : OLED_HOEHE_VORGABE,
  };
  try {
    const ui = JSON.parse(readFileSync(statusKonfigDatei, 'utf8')) as Partial<StatusKonfig>;
    basis = {
      led:
        ui.led === 'ws2812-spi' || ui.led === 'ws2812-pwm' || ui.led === 'aus'
          ? ui.led
          : basis.led,
      oled: typeof ui.oled === 'boolean' ? ui.oled : basis.oled,
      helligkeit: typeof ui.helligkeit === 'number' ? ui.helligkeit : basis.helligkeit,
      oledHoehe: ui.oledHoehe === 32 || ui.oledHoehe === 64 ? ui.oledHoehe : basis.oledHoehe,
    };
  } catch {
    /* keine UI-Datei — config.json/Vorgaben gelten */
  }
  return basis;
}

let statusAnzeige: StatusAnzeige | null = null;

async function statusAnzeigeAufbauen(): Promise<void> {
  await statusAnzeige?.stop();
  statusAnzeige = null;
  const k = statusKonfigLesen();
  if (k.led === 'aus' && !k.oled) return;
  statusAnzeige = new StatusAnzeige({
    led: k.led,
    oled: k.oled,
    helligkeit: k.helligkeit,
    oledHoehe: k.oledHoehe,
    // Im PWM-Modus schreibt der Core nur die Farbe hierhin; der Root-Dienst
    // asksin-analyzer-led liest sie und treibt GPIO18.
    pwmDatei: join(laufzeitDir, 'led-farbe'),
    // Werte für den Anzeigedienst; er zeichnet daraus mit den Bibliotheken
    // des Vorbilds und legt das fertige Bild wieder daneben.
    oledZustandDatei: join(laufzeitDir, 'oled-state.json'),
    oledBildDatei: join(laufzeitDir, 'oled-bild.b64'),
    daten: statusDaten,
    onError: (kontext, err) => log(`Statusanzeige (${kontext}): ${String(err)}`),
    // Jede Hardware-Aktion ins Protokoll (Stufe „debug"): Bricht die
    // Aufzeichnung unmittelbar nach einer solchen Zeile ab, ist der
    // Zusammenhang zwischen Anzeige und Ausfall belegt statt vermutet.
    onAktion: (was, daten) => protokoll?.debug('statusanzeige', was, daten),
  });
  await statusAnzeige.start();
  log(`Statusanzeige aktiv (LED: ${k.led}, OLED: ${k.oled ? 'an' : 'aus'})`);
}

const statusAnzeigeHooks = {
  /** Zustand fürs WebUI — inklusive pixelgenauer OLED-Vorschau. */
  zustand: (): Record<string, unknown> => {
    const k = statusKonfigLesen();
    const daten = statusDaten();
    // Vorschau: bevorzugt das Bild, das der Anzeigedienst zuletzt wirklich
    // aufs Display geschoben hat — sonst zeigte die Weboberfläche einen
    // Nachbau, der dem Gerät nur ähnelt.
    let vorschau: string | null = null;
    let vorschauHoehe = k.oledHoehe;
    let vorschauSeiten = SEITEN_ANZAHL;
    try {
      const roh = JSON.parse(
        readFileSync(join(laufzeitDir, 'oled-bild.b64'), 'utf8'),
      ) as { bild?: string; hoehe?: number; seiten?: number };
      if (typeof roh.bild === 'string') {
        vorschau = roh.bild;
        if (roh.hoehe === 32 || roh.hoehe === 64) vorschauHoehe = roh.hoehe;
        if (typeof roh.seiten === 'number' && roh.seiten > 0) vorschauSeiten = roh.seiten;
      }
    } catch {
      /* Anzeigedienst laeuft nicht — unten faellt es auf den Nachbau zurueck */
    }
    const bild = new OledBild(vorschauHoehe);
    if (vorschau === null) {
      zeichneSeite(bild, statusAnzeige?.zustandFuerApi().seite ?? 0, daten);
    }
    return {
      konfig: k,
      // Die Vorschau in der Weboberflaeche muss wissen, wie hoch das Bild ist —
      // sonst zeichnet sie fuer ein 128x32-Panel die doppelte Hoehe.
      oledHoehe: vorschauHoehe,
      seitenGesamt: vorschauSeiten,
      ...(statusAnzeige?.zustandFuerApi() ?? {
        aktiv: { led: false, oled: false },
        seite: 0,
        seiten: SEITEN_ANZAHL,
        fehler: {},
      }),
      ledMuster: ledMuster(daten),
      system: daten.system,
      oledBild: vorschau ?? Buffer.from(bild.puffer).toString('base64'),
    };
  },
  /** Konfiguration zur Laufzeit — persistiert, sofort wirksam. */
  einstellen: async (auftrag: Record<string, unknown>): Promise<void> => {
    const led = auftrag['led'];
    if (led !== 'ws2812-spi' && led !== 'ws2812-pwm' && led !== 'aus') {
      throw new Error('led: ws2812-spi, ws2812-pwm oder aus erwartet');
    }
    const helligkeit = Number(auftrag['helligkeit'] ?? 40);
    if (!Number.isFinite(helligkeit) || helligkeit < 1 || helligkeit > 100) {
      throw new Error('helligkeit: 1–100 erwartet');
    }
    // Bauhöhe: nur 32 und 64 sind zulässig; ohne Angabe bleibt der
    // bisherige Wert stehen, damit ältere Oberflächen ihn nicht wegwerfen.
    const hoeheRoh = auftrag['oledHoehe'];
    const oledHoehe: OledHoehe =
      hoeheRoh === 32 || hoeheRoh === 64 ? hoeheRoh : statusKonfigLesen().oledHoehe;
    const neu: StatusKonfig = {
      led,
      oled: auftrag['oled'] === true,
      helligkeit: Math.round(helligkeit),
      oledHoehe,
    };
    writeFileSync(statusKonfigDatei, JSON.stringify(neu, null, 2));
    await statusAnzeigeAufbauen();
    log(
      `Statusanzeige umkonfiguriert (LED: ${neu.led}, OLED: ${neu.oled}` +
        `, Panel 128x${neu.oledHoehe})`,
    );
  },
  seiteWeiter: (): void => {
    statusAnzeige?.naechsteSeite();
  },
};

// ---- Langzeitdaten nach InfluxDB (M9.5) ---------------------------------
// Konfiguriert über das WebUI (Einstellungen → Langzeitdaten), persistiert
// dienst-schreibbar; config.json bleibt Experten-Weg. Jeder Analyzer
// schreibt mit standort-Tag — Grafana wertet zentral aus.

const influxKonfigDatei = join(datenDir, 'influx.json');

function influxKonfigLesen(): InfluxKonfig {
  let basis: InfluxKonfig = {
    ...INFLUX_VORGABEN,
    ...((konfig as unknown as Record<string, unknown>)['influx'] as
      | Partial<InfluxKonfig>
      | undefined),
  };
  try {
    const ui = JSON.parse(readFileSync(influxKonfigDatei, 'utf8')) as Partial<InfluxKonfig>;
    basis = { ...basis, ...ui };
  } catch {
    /* keine UI-Datei */
  }
  return basis;
}

/** Zeitpunkt des Dienststarts — Grundlage der Laufzeit in den Langzeitdaten. */
const dienstStartMs = Date.now();

function influxDaten(): InfluxDaten {
  const s = analyzer.snapshot();
  const jetzt = Date.now();
  const tempC = leseTempC();
  return {
    standort,
    connected: s.ingest.connected,
    telegramsPerMinute: s.telegramsPerMinute,
    noiseFloorEwma: s.noiseFloor.ewma,
    deviceCount: s.devices.length,
    maxDutyCycle: s.devices.reduce((m, g) => Math.max(m, g.dutyCyclePercent), 0),
    dutyAlarme: s.devices.filter((g) => g.dutyCyclePercent >= DUTY_ALARM_PROZENT)
      .length,
    laufzeitSekunden: Math.round((jetzt - dienstStartMs) / 1000),
    system: {
      cpuLast: loadavg()[0] ?? 0,
      tempC,
      ramFreiProzent: (freemem() / totalmem()) * 100,
      diskFreiProzent: leseDiskFreiProzent(),
      luefterUpm: leseLuefterUpm(),
    },
    geraete: s.devices.map((g) => ({
      address: g.address,
      name: g.name,
      rssiEwma: g.rssi.ewma,
      dutyCyclePercent: g.dutyCyclePercent,
      telegrams: g.telegrams,
      // Sekunden statt Zeitstempel: In Grafana laesst sich damit direkt
      // sortieren und schwellen, ohne Zeitrechnung in der Abfrage.
      sekundenSeitEmpfang: Math.max(0, Math.round((jetzt - g.lastSeen) / 1000)),
    })),
  };
}

let influxSchreiber: InfluxSchreiber | null = null;

async function influxAufbauen(): Promise<void> {
  await influxSchreiber?.stop();
  influxSchreiber = null;
  const k = influxKonfigLesen();
  if (!k.aktiv || k.url === '') return;
  influxSchreiber = new InfluxSchreiber({
    konfig: k,
    daten: influxDaten,
    onError: (text) => log(`Influx: ${text}`),
  });
  influxSchreiber.start();
  log(`Langzeitdaten aktiv: ${k.url} (Bucket ${k.bucket}, alle ${k.intervallSekunden} s)`);
}

const influxHooks = {
  zustand: (): Record<string, unknown> => {
    const k = influxKonfigLesen();
    return {
      // Der Token geht mit zurueck — wie beim Alarmziel gilt: Wer ihn sucht,
      // soll ihn in der Oberflaeche nachsehen koennen statt in einer Datei
      // auf dem Pi. Die Leseroute ist dafuer mit dem Auth-Token geschuetzt.
      konfig: { ...k, hatToken: k.token !== '' },
      status: influxSchreiber?.status ?? { aktiv: false },
    };
  },
  einstellen: async (auftrag: Record<string, unknown>): Promise<void> => {
    const alt = influxKonfigLesen();
    const url = typeof auftrag['url'] === 'string' ? auftrag['url'].trim() : alt.url;
    if (auftrag['aktiv'] === true && !/^https?:\/\/\S+$/.test(url)) {
      throw new Error('url: http(s)://… erwartet');
    }
    const intervall = Number(auftrag['intervallSekunden'] ?? alt.intervallSekunden);
    if (!Number.isFinite(intervall) || intervall < 5 || intervall > 3600) {
      throw new Error('intervallSekunden: 5–3600 erwartet');
    }
    const neu: InfluxKonfig = {
      aktiv: auftrag['aktiv'] === true,
      url,
      org: typeof auftrag['org'] === 'string' ? auftrag['org'].trim() : alt.org,
      bucket:
        typeof auftrag['bucket'] === 'string' && auftrag['bucket'].trim() !== ''
          ? auftrag['bucket'].trim()
          : alt.bucket,
      // Leeres Token-Feld = vorhandenes behalten (es wird nie angezeigt):
      token:
        typeof auftrag['token'] === 'string' && auftrag['token'] !== ''
          ? auftrag['token']
          : alt.token,
      intervallSekunden: Math.round(intervall),
    };
    writeFileSync(influxKonfigDatei, JSON.stringify(neu, null, 2));
    await influxAufbauen();
    log(`Langzeitdaten umkonfiguriert (aktiv: ${neu.aktiv})`);
  },
};

// ---- Langzeitdaten vor Ort (M14) ----------------------------------------
//
// InfluxDB und Grafana duerfen nur auf dem Master laufen. Die Rolle steht
// entweder in der Weboberflaeche oder in config.json; die Hardware kann sie
// ueberstimmen, denn ein Pi 3 traegt die beiden Dienste nicht.
//
// Installiert wird ueber eine Anstossdatei: Der Analyzer laeuft unprivilegiert
// und darf keine Pakete nachladen. Eine systemd-Path-Unit sieht die Datei und
// startet das Skript als root — dasselbe Muster wie beim Update und beim
// Neustart per Taster.

const rolleDatei = join(datenDir, 'verbund-rolle.json');
const langzeitTrigger = join(datenDir, 'langzeit-anstoss');
const langzeitStatusDatei = join(datenDir, 'langzeit-status.json');

function leseRolleAusUi(): unknown {
  try {
    const roh = JSON.parse(readFileSync(rolleDatei, 'utf8')) as {
      rolle?: unknown;
    };
    return roh.rolle;
  } catch {
    return undefined;
  }
}

function leseModell(): string {
  try {
    // Der Knoten endet auf ein Nullbyte — das muss weg, sonst passt kein
    // Vergleich und die Baureihe wird nie erkannt.
    return readFileSync('/proc/device-tree/model', 'utf8').replace(/\0/g, '').trim();
  } catch {
    return '';
  }
}

const hardware = { modell: leseModell(), ramBytes: totalmem() };

/** Rolle, wie sie tatsaechlich gilt — inklusive Hardware-Veto. */
function aktuelleRolle(): {
  rolle: Rolle;
  gewuenscht: Rolle;
  erzwungen: boolean;
  grund: string;
} {
  const gewuenscht = geltendeRolle(leseRolleAusUi(), konfig.verbund?.rolle);
  return { gewuenscht, ...rolleMitHardware(gewuenscht, hardware) };
}

function leseLangzeitStatus(): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(langzeitStatusDatei, 'utf8')) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
}

/**
 * Wie viele Standorte liegen in der Datenbank?
 *
 * Nicht geraten aus der Peer-Liste, sondern gefragt: Ein Standort zaehlt,
 * wenn er auch wirklich schreibt. Ein eingetragener, aber ausgefallener Peer
 * darf hier nicht mitzaehlen — sonst behauptet die Uebersicht eine
 * Vollstaendigkeit, die nicht besteht.
 *
 * Das Ergebnis wird eine Minute lang behalten: Die Uebersichtsseite fragt im
 * Sekundentakt, und diese Zahl aendert sich hoechstens beim Aufbau.
 */
let standorteCache: { zahl: number | null; bis: number } = { zahl: null, bis: 0 };

async function zaehleStandorte(): Promise<number | null> {
  if (Date.now() < standorteCache.bis) return standorteCache.zahl;
  const k = influxKonfigLesen();
  if (!k.aktiv || k.url === '') {
    standorteCache = { zahl: null, bis: Date.now() + 60_000 };
    return null;
  }
  try {
    const res = await fetch(
      `${k.url.replace(/\/+$/, '')}/api/v2/query?org=${encodeURIComponent(k.org)}`,
      {
        method: 'POST',
        headers: {
          authorization: `Token ${k.token}`,
          'content-type': 'application/vnd.flux',
          accept: 'application/csv',
        },
        body:
          'import "influxdata/influxdb/schema"\n' +
          `schema.tagValues(bucket: "${k.bucket}", tag: "standort")`,
        signal: AbortSignal.timeout(4000),
      },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // CSV: eine Kopfzeile, danach je Standort eine Zeile.
    const zeilen = (await res.text())
      .split('\n')
      .filter((z) => z.trim() !== '' && !z.startsWith('#') && !z.includes(',_value'));
    const zahl = zeilen.length;
    standorteCache = { zahl, bis: Date.now() + 60_000 };
    return zahl;
  } catch {
    // Kein Wert statt einer Null: "0 Standorte" waere eine Aussage, "nicht
    // ermittelbar" ist die Wahrheit.
    standorteCache = { zahl: null, bis: Date.now() + 60_000 };
    return null;
  }
}

const langzeitHooks = {
  zustand: async (): Promise<unknown> => {
    const r = aktuelleRolle();
    const influx = influxKonfigLesen();
    const ziel = leseAlarmziel();
    return {
      ...r,
      // Fuer die Uebersichtsseite: nur Zustaende, keine Geheimnisse — deshalb
      // braucht diese Route auch keinen Token.
      influxAktiv: influx.aktiv && influx.url !== '',
      influxLokal: influx.url.includes('127.0.0.1') || influx.url.includes('localhost'),
      standorte: await zaehleStandorte(),
      alarmierung: ziel.aktiv ? ziel.kanal : null,
      hardware: {
        modell: hardware.modell === '' ? 'unbekannt' : hardware.modell,
        ramGb: Number((hardware.ramBytes / 1024 ** 3).toFixed(1)),
      },
      masterFaehig: masterFaehig(hardware),
      // Vorhandene Installation erkennen, ohne etwas zu starten: Die
      // Verzeichnisse legen die Pakete an, und sie bleiben auch dann liegen,
      // wenn das Geraet spaeter zum Client wird.
      installiert: {
        influxdb: existsSync('/etc/influxdb') || existsSync('/var/lib/influxdb'),
        grafana: existsSync('/etc/grafana'),
      },
      installation: leseLangzeitStatus(),
      laeuft: existsSync(langzeitTrigger),
      // Der Weg zur Oberflaeche — die IP kennt nur der Analyzer selbst.
      grafanaUrl: `http://${eigeneIp()}:3000`,
    };
  },
  einstellen: (auftrag: Record<string, unknown>): void => {
    if (auftrag['rolle'] !== undefined) {
      if (!istRolle(auftrag['rolle'])) {
        throw new Error("rolle: 'master' oder 'client' erwartet");
      }
      writeFileSync(rolleDatei, JSON.stringify({ rolle: auftrag['rolle'] }, null, 2));
      const r = aktuelleRolle();
      log(
        `Verbund-Rolle: ${r.rolle}` +
          (r.erzwungen ? ` (erzwungen — ${r.grund})` : ''),
      );
      return;
    }
    if (auftrag['aktion'] === 'installieren') {
      // Serverseitige Pruefung, nicht nur im Browser: Die API ist im Heimnetz
      // erreichbar, ein ausgeblendeter Knopf ist keine Zusicherung.
      verlangeMaster(aktuelleRolle().rolle);
      if (existsSync(langzeitTrigger)) {
        throw new Error('Eine Installation läuft bereits');
      }
      writeFileSync(langzeitTrigger, `${new Date().toISOString()}\n`);
      log('Langzeitdaten: Installation angestossen');
      return;
    }
    throw new Error("Unbekannter Auftrag — 'rolle' oder aktion 'installieren'");
  },
};

// ---- Alarmziele (M14.2) --------------------------------------------------
//
// Der Core ERZEUGT die beiden Dateien fuer Grafana — das ist der getestete
// Teil (src/langzeit/alarmziel.ts). Ein minimaler Root-Helfer legt sie nur
// noch an ihren Platz und startet Grafana neu. So bleibt im privilegierten
// Skript nichts, was schiefgehen koennte, ausser dem Kopieren.

const alarmzielDatei = join(datenDir, 'alarmziel.json');
const alarmzielTrigger = join(datenDir, 'alarmziel-anstoss');
const alarmzielYaml = join(datenDir, 'grafana-alarmziel.yaml');
const alarmzielSmtp = join(datenDir, 'grafana-smtp.conf');

function leseAlarmziel(): Alarmziel {
  try {
    const roh = JSON.parse(readFileSync(alarmzielDatei, 'utf8')) as Partial<Alarmziel>;
    return {
      ...ALARMZIEL_VORGABEN,
      ...roh,
      email: { ...ALARMZIEL_VORGABEN.email, ...(roh.email ?? {}) },
      telegram: { ...ALARMZIEL_VORGABEN.telegram, ...(roh.telegram ?? {}) },
      iobroker: { ...ALARMZIEL_VORGABEN.iobroker, ...(roh.iobroker ?? {}) },
    };
  } catch {
    return ALARMZIEL_VORGABEN;
  }
}

/**
 * Laeuft gerade eine Uebernahme — oder haengt sie?
 *
 * Der Anstoss wird vom Root-Helfer entfernt. Fehlt dessen Path-Unit — etwa
 * weil das Geraet die Aktualisierung noch nicht gesehen hat —, bleibt die
 * Datei liegen, und die Oberflaeche zeigte bis eben ewig "wird uebernommen".
 * Nach zehn Minuten ist das kein Laufen mehr, sondern ein Haenger, und der
 * gehoert benannt statt als Fortschritt getarnt.
 */
function uebernahmeZustand(): { laeuft: boolean; haengtSeitMinuten: number | null } {
  try {
    const alterMs = Date.now() - statSync(alarmzielTrigger).mtimeMs;
    if (alterMs < 10 * 60_000) return { laeuft: true, haengtSeitMinuten: null };
    return { laeuft: false, haengtSeitMinuten: Math.round(alterMs / 60_000) };
  } catch {
    return { laeuft: false, haengtSeitMinuten: null };
  }
}

/**
 * Schickt eine Probemeldung an eine Adresse und deutet das Ergebnis.
 *
 * Ein Weg fuer ioBroker und Telegram: Beide sind am Ende ein POST mit JSON,
 * und beide sollen im Fehlerfall dieselbe Sorte Auskunft geben — erst ein
 * Satz, was zu tun ist, dann die Antwort woertlich.
 */
async function schickeProbe(
  kanal: Alarmkanal,
  url: string,
  kopf: Record<string, string>,
  koerper: string,
  erfolg: string,
): Promise<string> {
  let antwort: Response;
  try {
    antwort = await fetch(url, {
      method: 'POST',
      headers: kopf,
      body: koerper,
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    // Kein Status: Es kam gar keine Antwort. Die Ursache steht in der
    // Ausnahme — Verbindung verweigert, Name unbekannt, Zeit abgelaufen.
    throw new Error(
      deuteZustellfehler(kanal, 0, e instanceof Error ? e.message : String(e)),
    );
  }
  const text = await antwort.text().catch(() => '');
  if (!antwort.ok) {
    throw new Error(deuteZustellfehler(kanal, antwort.status, text));
  }
  return erfolg;
}

const alarmzielHooks = {
  zustand: (): unknown => {
    const z = leseAlarmziel();
    return {
      kanal: z.kanal,
      aktiv: z.aktiv,
      iobroker: { ...z.iobroker, hatToken: z.iobroker.token !== '' },
      // Die Geheimnisse gehen mit zurueck, damit man sie in der Oberflaeche
      // nachsehen kann — wer sein SMTP-Passwort sucht, soll es nicht in einer
      // Datei auf dem Pi suchen muessen. Der Preis dafuer: Diese Leseroute
      // verlangt den Auth-Token, anders als die uebrigen.
      email: { ...z.email, hatPasswort: z.email.passwort !== '' },
      telegram: { ...z.telegram, hatBotToken: z.telegram.botToken !== '' },
      angewendet: existsSync(alarmzielYaml),
      ...uebernahmeZustand(),
      // Seit M15 gibt es den Endpunkt im Adapter (ab dessen Fassung mit
      // Alarm-Empfang). Ob er auf DIESEM ioBroker eingeschaltet ist, kann der
      // Analyzer nicht wissen — deshalb kein Versprechen, sondern der Weg
      // dorthin in der Oberflaeche.
      iobrokerBereit: true,
    };
  },
  einstellen: (auftrag: Record<string, unknown>): void => {
    verlangeMaster(aktuelleRolle().rolle);
    const alt = leseAlarmziel();
    const teil = auftrag as Partial<Alarmziel>;
    const neu: Alarmziel = {
      aktiv: auftrag['aktiv'] === true,
      kanal: istAlarmkanal(auftrag['kanal']) ? auftrag['kanal'] : alt.kanal,
      iobroker: { ...alt.iobroker, ...(teil.iobroker ?? {}) },
      email: { ...alt.email, ...(teil.email ?? {}) },
      telegram: { ...alt.telegram, ...(teil.telegram ?? {}) },
    };
    // Leeres Geheimnis heisst "behalten" — es wird ja nie angezeigt, sonst
    // muesste man es bei jeder anderen Aenderung neu eintippen.
    if (neu.email.passwort === '') neu.email.passwort = alt.email.passwort;
    if (neu.telegram.botToken === '') neu.telegram.botToken = alt.telegram.botToken;

    pruefeAlarmziel(neu);

    writeFileSync(alarmzielDatei, JSON.stringify(neu, null, 2) + '\n', { mode: 0o600 });
    writeFileSync(alarmzielYaml, baueAlarmProvisionierung(neu), { mode: 0o600 });
    writeFileSync(alarmzielSmtp, baueSmtpUmgebung(neu), { mode: 0o600 });
    writeFileSync(alarmzielTrigger, `${new Date().toISOString()}\n`);
    log(`Alarmziel gesetzt: ${neu.kanal} (aktiv: ${neu.aktiv})`);
  },
  testen: async (auftrag: Record<string, unknown>): Promise<string> => {
    verlangeMaster(aktuelleRolle().rolle);
    const gespeichert = leseAlarmziel();
    const kanal = istAlarmkanal(auftrag['kanal'])
      ? auftrag['kanal']
      : gespeichert.kanal;

    if (kanal === 'iobroker') {
      const io = {
        ...gespeichert.iobroker,
        ...((auftrag['iobroker'] ?? {}) as Partial<Alarmziel['iobroker']>),
      };
      if (io.token === '') io.token = gespeichert.iobroker.token;
      if (!/^https?:\/\/\S+$/.test(io.url)) {
        throw new Error('Adresse des Adapters fehlt oder ist unvollständig');
      }
      return schickeProbe(
        'iobroker',
        io.url,
        {
          'content-type': 'application/json',
          ...(io.token === '' ? {} : { authorization: `Bearer ${io.token}` }),
        },
        JSON.stringify(baueProbeMeldung(standort, new Date())),
        `Probemeldung an ${io.url} zugestellt — der Adapter hat sie angenommen.`,
      );
    }

    if (kanal === 'telegram') {
      const t = {
        ...gespeichert.telegram,
        ...((auftrag['telegram'] ?? {}) as Partial<Alarmziel['telegram']>),
      };
      if (t.botToken === '') t.botToken = gespeichert.telegram.botToken;
      if (t.botToken === '' || t.chatId === '') {
        throw new Error('Bot-Token und Chat-Kennung werden beide gebraucht');
      }
      return schickeProbe(
        'telegram',
        `https://api.telegram.org/bot${t.botToken}/sendMessage`,
        { 'content-type': 'application/json' },
        JSON.stringify({ chat_id: t.chatId, text: baueProbeText(standort) }),
        'Probemeldung an Telegram übergeben — sie müsste jetzt im Chat stehen.',
      );
    }

    const e: Alarmziel['email'] = {
      ...gespeichert.email,
      ...((auftrag['email'] ?? {}) as Partial<Alarmziel['email']>),
    };
    // Leeres Passwort heisst auch hier "das gespeicherte nehmen" — sonst
    // liesse sich nichts testen, ohne es vorher neu einzutippen.
    if (e.passwort === '') e.passwort = gespeichert.email.passwort;
    if (!e.empfaenger.includes('@')) throw new Error('Empfänger fehlt');
    if (e.smtpHost.trim() === '') throw new Error('SMTP-Server fehlt');

    // Alles ab hier gedeutet zurueckgeben: Ein "Interner Fehler: SmtpFehler"
    // ist keine Auskunft, sondern eine Zumutung.
    try {
      const leitung = await netzLeitung(e.smtpHost, e.smtpPort);
      try {
        await smtpTestlauf(leitung, {
          host: e.smtpHost,
          port: e.smtpPort,
          benutzer: e.benutzer,
          passwort: e.passwort,
          absender: e.absender,
          empfaenger: e.empfaenger,
          standort,
        });
      } finally {
        leitung.schliesse();
      }
    } catch (fehler) {
      throw new Error(deuteSmtpFehler(fehler));
    }
    log(`Testmail an ${e.empfaenger} verschickt`);
    return `Testmail an ${e.empfaenger} verschickt — der Server hat sie angenommen.`;
  },
};

const uiDir = resolve(import.meta.dirname, '../../webui/dist');
// Das Handbuch liegt im Projekt, nicht im Web-UI-Verzeichnis; ausgeliefert
// wird es über eine eigene Route, damit es auch ohne Internet erreichbar ist.
const handbuchDatei = resolve(
  import.meta.dirname,
  '../../docs/handbuch/AskSin-Analyzer-Handbuch.pdf',
);
// ---- Protokoll-Hooks fuer die Weboberflaeche ----------------------------

const protokollHooks = {
  zustand: (): Record<string, unknown> => {
    const p = protokoll;
    if (p === null) return { verfuegbar: false };
    return {
      verfuegbar: true,
      stufe: p.stufe,
      tage: p.tage,
      verzeichnis: protokollVerzeichnis,
      eintraege: p.eintraege,
      schreibfehler: p.schreibfehler,
      dateien: p.dateien(),
    };
  },
  einstellen: (auftrag: Record<string, unknown>): void => {
    const p = protokoll;
    if (p === null) throw new Error('Protokoll nicht verfügbar');
    const stufe = auftrag['stufe'];
    if (!istStufe(stufe)) {
      throw new Error('stufe: fehler, info, debug oder alles erwartet');
    }
    const tage = auftrag['tage'];
    if (typeof tage !== 'number' || !Number.isFinite(tage) || tage < 1 || tage > 365) {
      throw new Error('tage: 1–365 erwartet');
    }
    p.einstellen(stufe, Math.round(tage));
    writeFileSync(
      protokollDatei,
      JSON.stringify({ stufe, tage: Math.round(tage) }, null, 2) + '\n',
    );
    p.info('protokoll', `Stufe ${stufe}, Aufbewahrung ${Math.round(tage)} Tage`);
  },
  datei: (name: string): string | null => protokoll?.lies(name) ?? null,
};

const api = new ApiServer({
  analyzer,
  db,
  ...(devList === undefined ? {} : { devList }),
  version: paketVersion(),
  config: { ccuip: konfig.ccu.host, demo: demoAktiv, standort },
  ...(konfig.http.authToken === '' ? {} : { authToken: konfig.http.authToken }),
  ...(existsSync(uiDir) ? { uiDir } : {}),
  ...(existsSync(handbuchDatei) ? { handbuchDatei } : {}),
  update: updateHooks,
  verbund: verbundHooks,
  netzwerk: netzwerkHooks,
  statusAnzeige: statusAnzeigeHooks,
  influx: influxHooks,
  langzeit: langzeitHooks,
  alarmziel: alarmzielHooks,
  protokoll: protokollHooks,
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
await statusAnzeigeAufbauen();
await influxAufbauen();
// Beim Binden schiefgehen kann viel — und ein roher Stacktrace hilft am
// Datenschrank niemandem. Deshalb hier die drei Fälle im Klartext, bevor
// der Dienst mit Code 1 endet und systemd ihn endlos neu startet.
const { host, port } = await api.listen(konfig.http.port, konfig.http.host).catch(
  (err: NodeJS.ErrnoException) => {
    const p = konfig.http.port;
    if (err.code === 'EACCES' && p < 1024) {
      log(`Port ${p} ist ein privilegierter Port und der Dienst läuft ohne Rechte dafür.`);
      log('Abhilfe: entweder einen Port ab 1024 eintragen (z. B. 8080) in');
      log('  /etc/asksin-analyzer/config.json  →  "http": { "port": 8080 }');
      log('oder der Unit die Fähigkeit geben:  AmbientCapabilities=CAP_NET_BIND_SERVICE');
      log('(die mitgelieferte Unit bringt sie mit — dann genügt "sudo asksin-analyzer update").');
    } else if (err.code === 'EADDRINUSE') {
      log(`Port ${p} ist bereits belegt — ein anderer Dienst hört dort schon.`);
      log(`Belegung zeigen:  sudo ss -tlnp | grep :${p}`);
    } else if (err.code === 'EADDRNOTAVAIL') {
      log(`Adresse ${konfig.http.host} gibt es auf diesem Gerät nicht.`);
    }
    throw err;
  },
);
log(`AskSin-Analyzer ${paketVersion()} — API auf http://${host}:${port}`);
if (existsSync(uiDir)) log(`Web-UI: ${uiDir}`);
if (existsSync(handbuchDatei)) log('Handbuch: /handbuch.pdf');
else log('Kein Web-UI gefunden (webui/dist fehlt) — nur API');

// ---- Systemdiagnose im Takt (M13) ---------------------------------------
//
// Der eigentliche Zweck des Protokolls: Wenn der Pi nach Stunden einfriert,
// steht in der Datei, was kurz davor los war. Aufgezeichnet wird deshalb
// regelmäßig — und **sofort und als Fehler**, sobald etwas auffällt.
// Erfahrungsgemäß ist die häufigste Ursache Unterspannung: PoE-HAT plus SSD
// am USB reichen aus, um die 5-V-Schiene einbrechen zu lassen.

let letzteAuffaelligkeiten = '';

// ---- Systemjournal mitlesen ---------------------------------------------
// Beantwortet die Frage, die unser eigenes Protokoll nicht beantworten kann:
// Kam die Störung aus der Anwendung oder aus dem System? Der Cursor wird
// mitgeschrieben, damit über einen Dienst-Neustart hinweg keine Zeile doppelt
// und keine verloren geht.
const systemlog = new Systemlog();
const cursorDatei = join(dirname(konfig.db), 'journal-cursor');
try {
  systemlog.cursor = readFileSync(cursorDatei, 'utf8').trim() || null;
} catch {
  systemlog.cursor = null;
}

async function systemzeilenUebernehmen(): Promise<void> {
  const p = protokoll;
  if (p === null) return;
  try {
    const zeilen = await systemlog.neueZeilen();
    for (const z of zeilen) {
      if (z.auffaellig !== null) {
        p.fehler('systemlog', `${z.auffaellig}: ${z.text}`);
      } else {
        p.debug('systemlog', z.text);
      }
    }
    if (systemlog.cursor !== null) {
      writeFileSync(cursorDatei, systemlog.cursor + '\n');
    }
  } catch (err) {
    p.debug('systemlog', `nicht lesbar: ${String(err)}`);
  }
}

/** Einmal beim Start: Wie endete der vorherige Systemlauf? */
async function vorherigenStartBewerten(): Promise<void> {
  const p = protokoll;
  if (p === null) return;
  if (!(await systemlog.verfuegbar())) {
    p.info(
      'systemlog',
      'Systemjournal nicht lesbar — Dienstbenutzer in die Gruppe systemd-journal ' +
        'aufnehmen, sonst fehlen genau die Meldungen, die einen Systemausfall belegen',
    );
    return;
  }
  const v = await systemlog.vorherigerStart();
  if (!v.vorhanden) {
    p.info(
      'systemlog',
      'Kein vorheriger Systemstart im Journal — entweder der erste Start, oder ' +
        'das Journal ist flüchtig (Storage=volatile) und wird bei jedem Neustart verworfen',
    );
    return;
  }
  if (v.sauberBeendet === false) {
    p.fehler(
      'systemlog',
      'Der vorherige Systemlauf wurde NICHT sauber beendet — Hinweis auf ' +
        'Stromausfall, Spannungseinbruch oder Kernel-Absturz, nicht auf einen ' +
        'Fehler dieser Anwendung',
    );
  } else {
    p.info('systemlog', 'Vorheriger Systemlauf wurde sauber beendet');
  }
  for (const z of v.zeilen) {
    p.schreibe(
      z.auffaellig === null ? 'info' : 'fehler',
      'systemlog-vorher',
      z.auffaellig === null ? z.text : `${z.auffaellig}: ${z.text}`,
    );
  }
}

async function diagnoseSchreiben(regelmaessig: boolean): Promise<void> {
  if (protokoll === null) return;
  try {
    const w = await erhebeSystemwerte();
    const auff = auffaelligkeiten(w);
    const schluessel = auff.join(' | ');

    // Neue Auffälligkeit → als Fehler, damit sie auch bei Stufe „fehler"
    // in der Datei landet. Unverändert bestehende nicht wiederholen.
    if (schluessel !== '' && schluessel !== letzteAuffaelligkeiten) {
      protokoll.fehler('system', `Auffällig: ${schluessel}`, w);
    } else if (schluessel === '' && letzteAuffaelligkeiten !== '') {
      protokoll.info('system', 'Auffälligkeiten sind wieder weg', w);
    } else if (regelmaessig) {
      protokoll.info(
        'system',
        `Temperatur ${w.temperaturC?.toFixed(1) ?? '?'} °C · ` +
          `Speicher frei ${(w.speicherVerfuegbarMb ?? w.speicherFreiMb).toFixed(0)} MB · ` +
          `Last ${w.last5.toFixed(2)} · Laufzeit ${(w.laufzeitS / 3600).toFixed(1)} h`,
        w,
      );
    }
    letzteAuffaelligkeiten = schluessel;
  } catch (err) {
    protokoll.fehler('system', `Diagnose fehlgeschlagen: ${String(err)}`);
  }
}

// Alle 60 s prüfen (das ist billig), aber nur alle 15 min eine Zeile
// schreiben, solange nichts auffällt — sonst läuft die Datei voll.
let diagnoseZaehler = 0;
const diagnoseTakt = setInterval(() => {
  diagnoseZaehler++;
  void diagnoseSchreiben(diagnoseZaehler % 15 === 0);
}, 60_000);
diagnoseTakt.unref();
void diagnoseSchreiben(true);

const systemlogTakt = setInterval(() => void systemzeilenUebernehmen(), 60_000);
systemlogTakt.unref();
void vorherigenStartBewerten().then(() => systemzeilenUebernehmen());

// ---- Unerwartetes Ende festhalten ---------------------------------------
// Ohne diese Haken endet der Prozess bei einem Programmierfehler wortlos —
// genau das macht die Suche nach einem Absturz nach Stunden aussichtslos.
process.on('uncaughtException', (err) => {
  protokoll?.fehler('absturz', `Unbehandelte Ausnahme: ${String(err)}`, {
    stack: err.stack,
  });
  console.error(err);
  process.exit(1);
});
process.on('unhandledRejection', (grund) => {
  protokoll?.fehler('absturz', `Unbehandelte Zusage: ${String(grund)}`);
  console.error(grund);
});
for (const signal of ['SIGHUP', 'SIGQUIT', 'SIGABRT'] as const) {
  process.on(signal, () => {
    protokoll?.fehler('absturz', `Signal ${signal} empfangen — Prozess endet`);
    void herunterfahren(1);
  });
}

// ---- Sauber herunterfahren ---------------------------------------------

let beendet = false;
async function herunterfahren(code: number): Promise<void> {
  if (beendet) return;
  beendet = true;
  log('Fahre herunter …');
  try {
    await api.close();
    await influxSchreiber?.stop();
    await statusAnzeige?.stop();    // LED dunkel, OLED aus
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
