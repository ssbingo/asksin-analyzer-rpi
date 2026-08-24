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
  renameSync,
  rmSync,
  statSync,
  statfsSync,
  writeFileSync,
} from 'node:fs';
import { readdir } from 'node:fs/promises';
import { freemem, hostname, loadavg, networkInterfaces, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { ApiServer } from '../src/api/server.ts';
import type { ZigbeeHooks } from '../src/api/server.ts';
import type { NetzwerkHooks, UpdateHooks } from '../src/api/server.ts';
import { VerbundDienst } from '../src/verbund/verbund.ts';
import type { PeerKonfig } from '../src/verbund/verbund.ts';
import { demoDevListFetch, demoPortOpener } from '../src/demo/port.ts';
import { DEFAULT_BAUD, DEFAULT_DEVICE, sttyPortOpener } from '../src/ingest/sttyPort.ts';
import { openDatabase } from '../src/persist/db.ts';
import {
  ZIGBEE_BAUD,
  ZIGBEE_DEVICE,
  ZIGBEE_KANAL,
  ZigbeeLeser,
} from '../src/zigbee/leser.ts';
import { ZigbeeSpeicher } from '../src/zigbee/speicher.ts';
import { baueZigbeeMatrix } from '../src/verbund/zigbeeMatrix.ts';
import { median } from '../src/analytics/balken.ts';
import { DeconzNamen } from '../src/zigbee/namen.ts';
import { testeCcu } from '../src/resolve/ccuTest.ts';
import { DevListService, httpFetchBytes } from '../src/resolve/fetcher.ts';
import { Analyzer } from '../src/service/analyzer.ts';
import { MitschnittSchreiber } from '../src/mitschnitt/schreiber.ts';
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
import {
  SYSTEMUPDATE_WARNUNG_TAGE,
  bewerteAlter,
  laeuftNoch,
} from '../src/update/systemupdate.ts';
import type {
  SystemupdateErfolg,
  SystemupdateStatus,
} from '../src/update/systemupdate.ts';
import {
  ALARMREGELN,
  mitSchaltern,
  vollstaendig,
} from '../src/langzeit/alarmschalter.ts';
import type { Alarmschalter } from '../src/langzeit/alarmschalter.ts';
import {
  ADAPTER_MINDESTVERSION,
  baueVersionsbefund,
} from '../src/langzeit/kompatibilitaet.ts';
import type { Versionsbefund } from '../src/langzeit/kompatibilitaet.ts';
import { deuteSmtpFehler, netzLeitung, smtpTestlauf } from '../src/langzeit/smtp.ts';
import type { InfluxDaten, InfluxKonfig } from '../src/influx/schreiber.ts';
import { Protokoll, istStufe } from '../src/log/protokoll.ts';
import type { Stufe } from '../src/log/protokoll.ts';
import { auffaelligkeiten, erhebeSystemwerte, leseLuefterUpm } from '../src/log/diagnose.ts';
import { Systemlog } from '../src/log/systemlog.ts';
import { istPi5Modell, StatusAnzeige } from '../src/status/anzeige.ts';
import { OLED_HOEHE_VORGABE, OledBild } from '../src/status/ssd1306.ts';
import type { OledHoehe } from '../src/status/ssd1306.ts';
import {
  DUTY_ALARM_PROZENT,
  SEITEN_ANZAHL,
  BLITZ_TAKT_MS,
  ledMuster,
  zeichneSeite,
} from '../src/status/zustand.ts';
import type { StatusDaten } from '../src/status/zustand.ts';
import {
  flashFirmware,
  siehtNachIntelHexAus,
  standardRunnerMitAusgabe,
} from '../src/update/firmware.ts';
import { alsText, holen } from '../src/net/holen.ts';
import type { Antwort } from '../src/net/holen.ts';

/** Verlauf des letzten oder laufenden Firmware-Flashs. */
let flashStand: { laeuft: boolean; log: string; ok: boolean | null } = {
  laeuft: false,
  log: '',
  ok: null,
};

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
    /** Blitzt die LED bei jedem Telegramm kurz magenta? Vorgabe: ja. */
    blitz?: boolean;
  };
  /**
   * Mitschnitt des rohen Zeilenstroms (Phase F1) — die Grundlinie, gegen die
   * eine geänderte Sniffer-Firmware später gehalten wird.
   *
   * Standardmäßig **aus**. Er kostet Schreibvorgänge auf dem Bootmedium, und
   * bei einem Gerät, das jahrelang durchläuft, schaltet man so etwas bewusst
   * ein und nicht aus Versehen. Für eine Grundlinie genügt eine Stunde.
   *
   * Der Weg über den Dienst hat einen Vorteil gegenüber
   * `bin/mitschnitt.ts aufzeichnen`: Der Analyzer läuft dabei weiter. Die
   * serielle Schnittstelle verträgt nur einen Leser.
   */
  mitschnitt?: {
    aktiv?: boolean;
    /** Zieldatei. Vorgabe: <Datenverzeichnis>/mitschnitt.txt */
    pfad?: string;
    /** Obergrenze in MiB, danach wächst die Datei nicht weiter. Vorgabe 256. */
    maxMiB?: number;
  };
  /**
   * Zigbee-Mithörer (M16) — das zweite Ohr auf 2,4 GHz.
   *
   * Standardmäßig **aus**, und zwar so, dass eine Konfiguration ohne diesen
   * Block unverändert gültig bleibt. Vier von fünf Analyzern brauchen ihn
   * vermutlich nie; eine Erweiterung, die sich bei allen bemerkbar macht,
   * wäre keine Option, sondern eine Zumutung.
   */
  zigbee?: {
    aktiv?: boolean;
    /** Vorgabe: /dev/asksin-zigbee (udev-Regel, siehe hardware/). */
    device?: string;
    /** 11 bis 26. Vorgabe 11 — der verbreitetste Kanal. */
    kanal?: number;
    /**
     * Bestätigungen einzeln speichern statt nur zählen.
     *
     * Vorgabe `zaehlen`. Eine Bestätigung trägt weder Absender noch Netz und
     * ist keinem Gerät zuzuordnen; gemessen macht sie 41 % der Zeilen aus
     * (85 statt 55 MB am Tag). Siehe src/zigbee/speicher.ts.
     */
    bestaetigungen?: 'speichern' | 'zaehlen';
    /** Aufbewahrung der Einzelpakete in Tagen. Vorgabe 14. */
    paketeTage?: number;
    /** Aufbewahrung der Stundensummen in Tagen. Vorgabe 365. */
    stundenTage?: number;
    /**
     * Gerätenamen von deCONZ (M16.7).
     *
     * Der Schlüssel steht NICHT hier, sondern in zigbee.json im
     * Datenverzeichnis (Rechte 0600) — wie das SMTP-Passwort. config.json
     * ist mit 0640 lesbar für die Dienstgruppe und wird herumgereicht.
     */
    deconz?: { host?: string; cachePath?: string };
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

// ---- Mitschnitt (F1) ------------------------------------------------------
// Grundlinie vor Firmware-Änderungen. Im laufenden Betrieb ein- und
// ausschaltbar (API /api/mitschnitt, Schalter in den Einstellungen) — dafür
// soll niemand die Konfigurationsdatei anfassen müssen.
//
// Ein Fehler beim Anlegen darf den Analyzer nicht am Start hindern: Die
// Aufzeichnung ist ein Hilfsmittel, nicht sein Zweck.
const mitschnittZiel =
  konfig.mitschnitt?.pfad ?? join(dirname(konfig.db), 'mitschnitt.txt');
const mitschnittWahl = join(dirname(konfig.db), 'mitschnitt.json');
let mitschnitt: MitschnittSchreiber | null = null;

function mitschnittStarten(): void {
  if (mitschnitt !== null) return;
  mitschnitt = new MitschnittSchreiber({
    pfad: mitschnittZiel,
    geraet: demoAktiv ? 'DEMO (simuliert)' : konfig.device,
    baud: konfig.baud,
    demo: demoAktiv,
    maxBytes: (konfig.mitschnitt?.maxMiB ?? 256) * 1024 * 1024,
    onFehler: (f) => log(`Mitschnitt: ${String(f)}`),
  });
  log(`Mitschnitt aktiv → ${mitschnittZiel}`);
  if (demoAktiv) {
    // Deutlich, und zwar hier: Wer im Demobetrieb mitschneidet, meint
    // meistens eine Grundlinie — und die waere wertlos. Lieber einmal zu
    // viel gewarnt als eine falsche Messung als Beleg im Repo.
    log('ACHTUNG: DEMO-MODUS — dieser Mitschnitt enthaelt SIMULIERTE Daten');
    log('Als Grundlinie fuer einen Firmware-Vergleich ist er NICHT geeignet.');
  }
}

// Der letzte Stand einer beendeten Aufzeichnung. Ohne ihn meldete die API
// nach dem Ausschalten "0 Zeilen" — was aussieht, als sei nichts
// aufgezeichnet worden, obwohl die Datei danebenliegt.
let mitschnittLetzte: ReturnType<MitschnittSchreiber['stats']> | null = null;

function mitschnittStoppen(): void {
  if (mitschnitt === null) return;
  mitschnitt.stop();
  const m = mitschnitt.stats();
  mitschnittLetzte = m;
  log(
    `Mitschnitt beendet: ${m.geschrieben} Zeilen` +
      (m.verworfen > 0 ? `, ${m.verworfen} im Puffer verworfen` : '') +
      (m.abgeschnitten > 0 ? `, ${m.abgeschnitten} nach Groessengrenze` : ''),
  );
  mitschnitt = null;
}

// Die Wahl aus der Weboberfläche hat Vorrang vor der Konfigurationsdatei —
// sonst käme nach jedem Neustart wieder der alte Stand zurück, und der
// Schalter im Browser wäre eine Lüge.
let mitschnittGewuenscht = konfig.mitschnitt?.aktiv === true;
try {
  const gespeichert = JSON.parse(readFileSync(mitschnittWahl, 'utf8')) as {
    aktiv?: unknown;
  };
  if (typeof gespeichert.aktiv === 'boolean') mitschnittGewuenscht = gespeichert.aktiv;
} catch {
  // Keine Datei: Es gilt die Konfiguration. Kein Fehler.
}
if (mitschnittGewuenscht) {
  try {
    mitschnittStarten();
  } catch (fehler) {
    log(`Mitschnitt konnte nicht starten: ${String(fehler)} — Analyzer läuft weiter`);
  }
}

const mitschnittHooks = {
  zustand: (): Record<string, unknown> => {
    const s = mitschnitt?.stats() ?? mitschnittLetzte;
    return {
      aktiv: mitschnitt !== null,
      demo: demoAktiv,
      pfad: mitschnittZiel,
      // Auch wenn gerade nichts läuft: Was schon aufgezeichnet wurde, soll
      // sichtbar bleiben — sonst wirkt die Datei nach dem Ausschalten weg.
      vorhanden: existsSync(mitschnittZiel),
      bytes: existsSync(mitschnittZiel) ? statSync(mitschnittZiel).size : (s?.bytes ?? 0),
      geschrieben: s?.geschrieben ?? 0,
      verworfen: s?.verworfen ?? 0,
      abgeschnitten: s?.abgeschnitten ?? 0,
      fehler: s?.fehler ?? 0,
      seit: s?.seit ?? null,
    };
  },
  einstellen: (auftrag: Record<string, unknown>): void => {
    const aktiv = auftrag['aktiv'];
    if (typeof aktiv !== 'boolean') throw new Error('aktiv: true oder false erwartet');
    if (auftrag['loeschen'] === true) {
      // Ausdrücklich verlangt, nie nebenbei: Eine Grundlinie ist nicht
      // wiederbeschaffbar, und ein versehentlich geleerter Mitschnitt wäre
      // genau der Verlust, den das Ganze verhindern soll.
      mitschnittStoppen();
      rmSync(mitschnittZiel, { force: true });
      log('Mitschnitt gelöscht (ausdrücklich angefordert)');
    }
    if (aktiv) mitschnittStarten();
    else mitschnittStoppen();
    writeFileSync(mitschnittWahl, JSON.stringify({ aktiv }, null, 2) + '\n');
  },
  datei: (): Buffer | null => {
    // Vor dem Ausliefern spuelen, sonst fehlen dem Herunterladenden die
    // letzten Sekunden — und ausgerechnet die schaut man sich zuerst an.
    mitschnitt?.spuelen();
    if (!existsSync(mitschnittZiel)) return null;
    return readFileSync(mitschnittZiel);
  },
};

/**
 * Wann kam zuletzt ein Telegramm — für den Blitz auf der Status-LED.
 *
 * Auf der Platine zeigt D1 jedes Telegramm an, sitzt aber im Schrank. Die
 * WS2812 an der Front kann dasselbe zeigen, und dafür braucht es keine
 * Leitung: Die Firmware schickt jedes Telegramm ohnehin über die serielle
 * Verbindung hierher. Der Impuls ist längst da, nur als Zeile.
 */
let letztesTelegrammMs: number | null = null;

const analyzer = new Analyzer({
  openPort: demoAktiv
    ? demoPortOpener()
    : sttyPortOpener(konfig.device, konfig.baud, (t) => log(`Serielle Schnittstelle: ${t}`)),
  // Immer gesetzt, auch wenn gerade nicht aufgezeichnet wird: Nur so lässt
  // sich der Mitschnitt im laufenden Betrieb einschalten. Ist er aus, kostet
  // der Aufruf einen null-Vergleich je Zeile.
  onRawLine: (z: string, ts: number) => mitschnitt?.zeile(z, ts),
  // Nur der Zeitstempel, und der auch nur gedrosselt: Bei einem Schwall
  // bliebe die LED sonst durchgehend magenta, und die Grundfarbe — die den
  // Zustand des Geraets zeigt — waere nie zu sehen. Die Drosselung gehoert
  // hierher und nicht in die Anzeige: Hier kostet sie einen Vergleich je
  // Telegramm, dort muesste die Schleife sich merken, was sie schon blitzte.
  onLine: (line) => {
    if (line.kind !== 'telegram') return;
    const jetzt = Date.now();
    if (letztesTelegrammMs !== null && jetzt - letztesTelegrammMs < BLITZ_TAKT_MS) return;
    letztesTelegrammMs = jetzt;
  },
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
  onFirmware: (a) => {
    if (a.art === 'empfang') {
      // Ein Analyzer, der sich stillschweigend selbst heilt, verbirgt einen
      // Hardwarefehler. Deshalb steht jeder Eingriff im Protokoll, mit dem
      // Zustand, in dem das Funkmodul angetroffen wurde.
      const hex = `0x${a.zustand.toString(16).toUpperCase().padStart(2, '0')}`;
      const grund =
        a.zustand === 0x11
          ? 'uebergelaufener Empfangspuffer'
          : a.zustand === 0x01
            ? 'Ruhezustand'
            : 'nicht auf Empfang';
      log(
        `Funkmodul hing (${grund}, MARCSTATE ${hex}) — die Firmware hat den ` +
          'Empfang neu aufgesetzt. Haeuft sich das, stimmt etwas mit dem ' +
          'Modul, seiner Versorgung oder der SPI-Strecke nicht.',
      );
    } else if (a.art === 'funkzustand') {
      // Lebenszeichen bei Funkstille (ab Firmware 3). Im Klartext, weil die
      // Deutung sonst niemand im Kopf hat — und weil genau diese Zeile die
      // Frage beantwortet, die sich hinterher nicht mehr stellen laesst.
      const hx = (n: number): string =>
        `0x${n.toString(16).toUpperCase().padStart(2, '0')}`;
      // FREQEST ist ein Zweierkomplement: Werte ab 0x80 sind negativ.
      const ablage = a.freqEst > 0x7f ? a.freqEst - 0x100 : a.freqEst;
      const deutung =
        a.rxBytes > 0
          ? 'Pakete liegen im Puffer, werden aber nicht abgeholt — Verdacht auf GDO0'
          : Math.abs(ablage) > 20
            ? 'Empfaenger steht neben dem Kanal — Verdacht auf Frequenzdrift'
            : 'kein Traeger in Reichweite';
      log(
        `Funkstille seit einer Minute: MARCSTATE ${hx(a.zustand)}, ` +
          `Empfangspuffer ${a.rxBytes} Byte, Frequenzablage ${ablage}, ` +
          `PKTSTATUS ${hx(a.pktStatus)}, LQI ${hx(a.lqi)} — ${deutung}.`,
      );
    } else if (a.art === 'funkmodul') {
      log(
        a.cc1101 === null
          ? 'Firmware neu gestartet — ihr Funkmodul antwortet NICHT'
          : `Firmware neu gestartet — Funkmodul antwortet (0x${a.cc1101
              .toString(16)
              .toUpperCase()
              .padStart(2, '0')})`,
      );
    }
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

/**
 * Ab wann ein als laufend vermerktes Update als steckengeblieben gilt.
 *
 * update.sh frischt `updatedAt` bei jedem Schritt auf; eine halbe Stunde ohne
 * Lebenszeichen bedeutet, dass niemand mehr daran arbeitet.
 */
const STECKENGEBLIEBEN_MS = 30 * 60 * 1000;

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
    if (status !== null && status['running'] === true) {
      // Eine Sperre, aus der nur der Erfolgsfall herausfuehrt, ist keine
      // Sperre, sondern eine Falle.
      //
      // update.sh schreibt bei jedem Schritt `updatedAt` neu. Wird das Update
      // hart abgebrochen — abgeschossener Dienst, Stromausfall, Neustart
      // mitten im Lauf — bleibt "running": true stehen, und die Weboberflaeche
      // antwortete von da an dauerhaft mit 409. Am 10.08.2026 genau so
      // erlebt; herausgeholfen hat nur das Loeschen der Datei von Hand.
      //
      // Ein Update, das seit einer halben Stunde keinen Schritt gemeldet hat,
      // laeuft nicht mehr. Die Grenze ist grosszuegig: Der langsamste
      // beobachtete Durchlauf auf einem Pi 3 blieb weit darunter, und jeder
      // Schritt frischt die Marke auf.
      const zuletzt = Number(status['updatedAt'] ?? 0);
      const alterMs = Date.now() - zuletzt;
      if (Number.isFinite(alterMs) && alterMs < STECKENGEBLIEBEN_MS) return false;
      log(
        `Vorheriges Update gilt als steckengeblieben (letzte Meldung vor ` +
          `${Math.round(alterMs / 60_000)} min) — Sperre wird aufgehoben.`,
      );
    }
    writeFileSync(updateTrigger, `${new Date().toISOString()}\n`);
    log('Core-Update angestoßen (Trigger-Datei für die systemd-Path-Unit)');
    return true;
  },
  updateStatus: () => leseUpdateStatus(),
  flashFirmware: (hex) => {
    // Kein Riegel wegen des Demo-Modus. Der simuliert die FUNKANLAGE, nicht
    // das Geraet: Er laeuft auch dann, wenn die Platine steckt — etwa um
    // Funktionen ohne echtes Homematic-Netz auszuprobieren. Wer dabei die
    // Firmware aufspielen will, soll das koennen.
    //
    // Fehlt die Platine tatsaechlich, scheitert avrdude von selbst und sagt
    // auch warum. Eine vorweggenommene Absage haette stattdessen einen
    // erfundenen Grund genannt — und wer danach sucht, sucht am falschen Ende.
    if (!siehtNachIntelHexAus(hex)) {
      return Promise.resolve({ ok: false, log: 'Upload ist keine gültige Intel-HEX-Datei.' });
    }
    if (flashStand.laeuft) {
      return Promise.resolve({ ok: false, log: 'Es läuft bereits ein Flash-Vorgang.' });
    }

    const hexPfad = join(datenDir, 'firmware-upload.hex');
    writeFileSync(hexPfad, hex);
    flashStand = { laeuft: true, log: '', ok: null };
    const anhaengen = (text: string): void => {
      // Der Verlauf ist begrenzt: avrdudes Fortschrittsbalken kommt in vielen
      // kleinen Stuecken, und ein unbegrenzter String waere im Dauerbetrieb
      // ein Leck. Die letzten 64 KB reichen weit ueber jeden Flash hinaus.
      flashStand.log = (flashStand.log + text).slice(-65_536);
    };

    // Bewusst NICHT erwartet: Der HTTP-Aufruf kehrt sofort zurueck, den
    // Verlauf holt sich die Oberflaeche ueber /api/update/firmware/stand.
    void (async () => {
      try {
        anhaengen('Ingest wird angehalten, Port wird freigegeben\n');
        log('Firmware-Flash: Ingest wird angehalten, Port wird freigegeben');
        await analyzer.stop();
        const ergebnis = await flashFirmware(hexPfad, {
          device: konfig.device,
          runCommand: standardRunnerMitAusgabe(anhaengen),
          onFortschritt: anhaengen,
        });
        flashStand.ok = ergebnis.ok;
        log(`Firmware-Flash ${ergebnis.ok ? 'erfolgreich' : 'FEHLGESCHLAGEN'}`);
      } catch (fehler) {
        // flashFirmware wirft nicht — aber analyzer.stop() kann es. Ohne
        // diesen Zweig bliebe `laeuft` fuer immer stehen, und die Oberflaeche
        // zeigte ewig einen laufenden Vorgang.
        anhaengen(`\nAbbruch: ${String(fehler)}\n`);
        flashStand.ok = false;
        log(`Firmware-Flash abgebrochen: ${String(fehler)}`);
      } finally {
        rmSync(hexPfad, { force: true });
        analyzer.start();
        anhaengen('Ingest fortgesetzt\n');
        log('Ingest fortgesetzt');
        flashStand.laeuft = false;
      }
    })();

    return Promise.resolve({ ok: true, log: 'Flash gestartet.' });
  },
  flashStand: () => ({ ...flashStand }),
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
  zigbeeMatrix: async (stunden: number) => {
    // Zusammenführen ist Sache des Masters — auch über die Leitung, nicht nur
    // im Menü. Ein Client, der diese Antwort gäbe, würde eine Matrix aus
    // seiner eigenen Gegenstellenliste bauen; wer dazugehört, entscheidet
    // aber der Master.
    verlangeMaster(aktuelleRolle().rolle);

    // Ohne eigenen Mithörer gibt es keine Zigbee-Auswertung im Verbund.
    //
    // Das ist eine ausdrückliche Festlegung, keine technische Not: Der Master
    // führt zusammen, und wer zusammenführt, soll selbst messen. Ein Master,
    // der nur fremde Zahlen weiterreicht, hätte keine eigene Zeile in der
    // Matrix — und niemand könnte sagen, ob ein „nirgends gehört" an den
    // Standorten liegt oder daran, dass der Master gar nicht hinhört.
    //
    // Die Clients dürfen Zigbee trotzdem lokal betreiben; sie sehen ihre
    // eigenen Daten unter „Meldungen · Zigbee". Ob sie im Verbund erscheinen,
    // entscheidet der Master über seine Gegenstellenliste — wie bei BidCoS.
    if (!zigbeeKonfig.aktiv) {
      throw new Error(
        'Der Master hat keinen Zigbee-Mithörer. Ohne ihn gibt es keine '
        + 'Verbund-Auswertung für Zigbee.',
      );
    }

    // Die Standorte melden Adressen samt IEEE; die Namen hängt der Master an.
    // So liegt genau EIN deCONZ-Zugangstoken im Verbund statt fünf.
    const berichte = await verbund.zigbeeBerichte(stunden);

    // Den eigenen Standort NUR dann ergänzen, wenn ihn nicht schon eine
    // Gegenstelle liefert.
    //
    // Die Peer-Liste enthält den Master üblicherweise selbst (als
    // http://127.0.0.1:8080) — der Installer trägt ihn dort ein, damit die
    // Übersicht vollständig ist. Wer ihn hier blind voranstellt, bekommt eine
    // Tabelle mit zwei gleichnamigen Spalten. Genau so ist es am 18.08.2026
    // passiert: „Keller Büro | Keller Büro | Dachboden | Gartenhaus".
    if (!berichte.some((b) => b.standort === standort)) {
      berichte.unshift({
        standort,
        erreichbar: zigbeeKonfig.aktiv,
        geraete: zigbeeHooks.geraete(stunden) as never,
      });
    }
    const soll = zigbeeNamen.alle().map((g) => ({ ieee: g.ieee, name: g.name }));
    const matrix = baueZigbeeMatrix(berichte, soll);
    // Namen nachtragen, wo die Standorte keine kannten.
    for (const g of matrix.geraete) {
      if (g.name !== '' || g.ieee === null) continue;
      const treffer = zigbeeNamen.name(g.ieee);
      if (treffer !== undefined) g.name = treffer;
    }
    return { ts: Date.now(), stunden, ...matrix };
  },
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
      if (typeof auftrag['token'] === 'string' && auftrag['token'].trim() !== '') {
        // Getrimmt wie ueberall, wo ein Token von Hand eingefuegt wird.
        neu.token = auftrag['token'].trim();
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
    // Fuer die Funkstatus-Seite des Displays: eingeschaltet UND der Stick
    // antwortet. Nur „eingeschaltet" waere dort irrefuehrend — ein Haken
    // neben einem stummen Stick ist schlimmer als kein Haken.
    zigbee: zigbeeKonfig.aktiv && (zigbeeLeser?.stats.verbunden ?? false),
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
  /** Blitzt die LED bei jedem Telegramm kurz magenta? */
  blitz: boolean;
}

/**
 * Damit die Meldung unten einmal erscheint und nicht bei jedem Abruf der
 * Weboberfläche — `statusKonfigLesen()` läuft auch für die Live-Vorschau.
 */
let pwmAufPi5Gemeldet = false;

function statusKonfigLesen(): StatusKonfig {
  let basis = {
    led: konfig.statusanzeige?.led ?? 'aus',
    oled: konfig.statusanzeige?.oled === true,
    helligkeit: konfig.statusanzeige?.helligkeit ?? 40,
    oledHoehe: konfig.statusanzeige?.oledHoehe === 64 ? 64 : OLED_HOEHE_VORGABE,
    // Vorgabe an: Wer eine LED an der Front hat, will sehen, dass etwas
    // ankommt. Wem es zu unruhig ist, schaltet es in den Einstellungen ab —
    // das ist die richtige Richtung, denn die andere verschweigt eine
    // Funktion, von der man nie erfaehrt, dass es sie gibt.
    blitz: konfig.statusanzeige?.blitz !== false,
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
      blitz: typeof ui.blitz === 'boolean' ? ui.blitz : basis.blitz,
    };
  } catch {
    /* keine UI-Datei — config.json/Vorgaben gelten */
  }
  // Auf dem Pi 5 kann PWM die LED nicht ansteuern: Die Peripherie sitzt hinter
  // dem RP1-Chip, rpi_ws281x zielt weiterhin auf die alte Speicherlage.
  //
  // Das gehört hierher und nicht nur in den Installer. Am 10.08.2026 hat
  // Analyzer 01 (ein Pi 5) genau das vorgeführt: Der Installer stellte die
  // config.json korrekt auf SPI um — die Betriebsart kommt aber aus
  // statusanzeige.json, und die fasst er nicht an. Also blieb dort „ws2812-pwm"
  // stehen, überstimmte die richtige Einstellung, und die LED blieb dunkel,
  // während beide Dateien einander widersprachen. Wer nur in die config.json
  // sieht, sucht danach an der falschen Stelle — ich auch.
  if (basis.led === 'ws2812-pwm' && istPi5Modell(leseModell())) {
    if (!pwmAufPi5Gemeldet) {
      pwmAufPi5Gemeldet = true;
      log(
        'PWM ist auf dem Raspberry Pi 5 nicht möglich (RP1) — die Status-LED ' +
          'läuft hier über SPI/GPIO10. Der Schiebeschalter SW1 auf der Platine ' +
          'muss dazu auf SPI stehen.',
      );
    }
    basis.led = 'ws2812-spi';
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
    blitz: k.blitz,
    letztesTelegramm: () => letztesTelegrammMs,
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
    // Fehlt die Angabe, bleibt der bisherige Wert stehen — eine aeltere
    // Oberflaeche schaltet den Blitz sonst beim Speichern der Helligkeit ab.
    const blitzRoh = auftrag['blitz'];
    const neu: StatusKonfig = {
      led,
      oled: auftrag['oled'] === true,
      helligkeit: Math.round(helligkeit),
      oledHoehe,
      blitz: typeof blitzRoh === 'boolean' ? blitzRoh : statusKonfigLesen().blitz,
    };
    writeFileSync(statusKonfigDatei, JSON.stringify(neu, null, 2));
    await statusAnzeigeAufbauen();
    log(
      `Statusanzeige umkonfiguriert (LED: ${neu.led}, OLED: ${neu.oled}` +
        `, Panel 128x${neu.oledHoehe}, Telegramm-Blitz: ${neu.blitz ? 'an' : 'aus'})`,
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

/**
 * Wie oft die CCU-Geraeteliste in die Langzeitdaten geschrieben wird.
 *
 * Deutlich seltener als die Messwerte, und zwar aus Groessengruenden: Die
 * Liste hat bei einer mittleren Anlage ueber 200 Eintraege. Im
 * 30-Sekunden-Takt waeren das 8 Punkte je Sekunde, rund 700 000 am Tag und
 * Analyzer — fuer eine Menge, die sich nur aendert, wenn jemand ein Geraet
 * an- oder ablernt.
 *
 * Fuenf Minuten reichen: Grafana fragt ohnehin "der letzte bekannte Stand je
 * Adresse", und eine Anlage, bei der ein neu angelerntes Geraet fuenf Minuten
 * spaeter im Dashboard steht, ist schnell genug.
 */
const LISTE_INTERVALL_MS = 300_000;
let listeZuletzt = 0;

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
    // Die Sollmenge nur alle paar Minuten mitschicken; dazwischen bleibt das
    // Feld leer und es entstehen keine Zeilen.
    geraeteliste:
      jetzt - listeZuletzt >= LISTE_INTERVALL_MS
        ? ((listeZuletzt = jetzt),
          analyzer.ccuGeraete().map((g) => ({
            address: g.address,
            name: g.name,
            serial: g.serial,
            jeGehoert: g.jeGehoert,
          })))
        : [],
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
    // Zigbee (M16.7). Läuft kein Mithörer, bleiben beide Felder leer und es
    // entstehen gar keine Zeilen — eine Messreihe voller Nullen wäre eine
    // Behauptung, keine Messung.
    zigbee: zigbeeKonfig.aktiv ? zigbeeFuerInflux() : [],
    zigbeeListe:
      zigbeeKonfig.aktiv && jetzt - zigbeeListeZuletzt >= LISTE_INTERVALL_MS
        ? ((zigbeeListeZuletzt = jetzt), zigbeeListeFuerInflux())
        : [],
  };
}

/** Zeitpunkt der letzten Zigbee-Sollmenge — sie ändert sich selten. */
let zigbeeListeZuletzt = 0;

/**
 * Die Geräte der letzten Stunde für die Langzeitdaten.
 *
 * Eine Stunde, nicht 24: Grafana soll den Verlauf zeigen, nicht einen über den
 * Tag verschmierten Mittelwert. Die Stundensummen liegen ohnehin so vor.
 */
function zigbeeFuerInflux(): NonNullable<InfluxDaten['zigbee']> {
  const roh = zigbeeHooks.geraete(1) as Array<Record<string, unknown>>;
  if (roh.length === 0) return [];
  // Das Netz mit den meisten Paketen ist das eigene — der Mithörer steht
  // mittendrin, Nachbarnetze kommen nur von weit her herein.
  const jePan = new Map<number, number>();
  for (const g of roh) {
    const pan = g['pan'] as number;
    jePan.set(pan, (jePan.get(pan) ?? 0) + (g['pakete'] as number));
  }
  let eigenes: number | null = null;
  let max = -1;
  for (const [pan, n] of jePan) if (n > max) { max = n; eigenes = pan; }

  return roh.map((g) => {
    const pakete = g['pakete'] as number;
    return {
      addr: g['addr'] as string,
      ieee: typeof g['ieee'] === 'string' ? g['ieee'] : null,
      // Leerer Name ist zulaessig — baueZeilen() setzt dafuer die Kurzadresse
      // ein, damit das Etikett nie leer bleibt (siehe dort).
      name: typeof g['name'] === 'string' ? g['name'] : '',
      pan: `${(g['pan'] as number).toString(16).toUpperCase().padStart(4, '0')}`,
      pakete,
      rssi: Math.round((g['sum_rssi'] as number) / pakete),
      lqi: Math.round((g['sum_lqi'] as number) / pakete),
      schwachProzent: Math.round(((g['schwach'] as number) * 1000) / pakete) / 10,
      eigenesNetz: g['pan'] === eigenes,
    };
  });
}

/** Sollmenge aus deCONZ mit dem Kennzeichen „hier je gehört". */
function zigbeeListeFuerInflux(): NonNullable<InfluxDaten['zigbeeListe']> {
  const alle = zigbeeNamen.alle();
  if (alle.length === 0) return [];
  const vermisst = new Set(
    (zigbeeHooks.nieGehoert(24) as Array<{ ieee: string }>).map((v) => v.ieee),
  );
  return alle.map((g) => ({
    ieee: g.ieee,
    name: g.name,
    jeGehoert: !vermisst.has(g.ieee),
  }));
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

/**
 * Nimmt einen von Hand eingefuegten Token entgegen.
 *
 * Leer heisst "den vorhandenen behalten" — er wird ja bei jeder anderen
 * Aenderung mitgeschickt. Alles andere wird getrimmt: Beim Kopieren aus einer
 * Datei oder einem Terminal haengt regelmaessig ein Zeilenumbruch dran, und
 * der macht aus einem gueltigen Token einen ungueltigen.
 */
function geputzterToken(roh: unknown, bisher: string): string {
  if (typeof roh !== 'string') return bisher;
  const sauber = roh.trim();
  return sauber === '' ? bisher : sauber;
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
      // Getrimmt, und zwar zwingend: Ein Token wird immer kopiert, und beim
      // Kopieren haengt regelmaessig ein Zeilenumbruch oder Leerzeichen dran.
      // Die Kopfzeile lautet dann "Token abc\n", und InfluxDB antwortet mit
      // 401 unauthorized — ein Fehler, der wie ein falscher Token aussieht,
      // obwohl der Token stimmt. Genau daran ist Silvio haengengeblieben.
      token: geputzterToken(auftrag['token'], alt.token),
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
/** Wo die stabilen Namen der seriellen Geräte stehen. */
const BY_ID_DIR = '/dev/serial/by-id';
const zigbeeFirmwareTrigger = join(datenDir, 'zigbee-firmware-anstoss');
const zigbeeFirmwareStatus = join(datenDir, 'zigbee-firmware-status.json');
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
    const res = await holen(
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
    const zeilen = alsText(res)
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
function uebernahmeZustand(
  anstoss: string = alarmzielTrigger,
): { laeuft: boolean; haengtSeitMinuten: number | null } {
  try {
    const alterMs = Date.now() - statSync(anstoss).mtimeMs;
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
  let antwort: Antwort;
  try {
    antwort = await holen(url, {
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
  const text = alsText(antwort);
  if (!antwort.ok) {
    throw new Error(deuteZustellfehler(kanal, antwort.status, text));
  }
  return erfolg;
}

/**
 * Fragt den Adapter nach seiner Fassung und vergleicht sie.
 *
 * Der Adapter beantwortet einen gewoehnlichen Aufruf mit seinen
 * Versionsangaben — genau dafuer tut er das. Das Ergebnis wird IMMER
 * ausgesprochen, auch wenn alles passt: Schweigen bei Erfolg saehe genauso
 * aus wie eine nicht durchgefuehrte Pruefung.
 */
async function pruefeAdapterVersion(url: string): Promise<Versionsbefund> {
  let gemeldet: string | null = null;
  try {
    const res = await holen(url, { signal: AbortSignal.timeout(4000) });
    if (res.ok) {
      const d = JSON.parse(alsText(res)) as { version?: unknown };
      if (typeof d.version === 'string') gemeldet = d.version;
    }
  } catch {
    /* keine Auskunft — das ist ein eigener Befund, kein stiller Erfolg */
  }
  return baueVersionsbefund(gemeldet, paketVersion());
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
      adapterMindestversion: ADAPTER_MINDESTVERSION,
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
      // Vor dem Zustellversuch die Fassung erfragen: Ein zu alter Adapter
      // nimmt die Meldung womoeglich an, ohne sie zu verarbeiten — dann
      // meldete der Test einen Erfolg, den es nicht gibt.
      // Vor dem Zustellversuch die Fassung erfragen: Ein zu alter Adapter
      // nimmt die Meldung womoeglich an, ohne sie zu verarbeiten — dann
      // meldete der Test einen Erfolg, den es nicht gibt.
      const befund = await pruefeAdapterVersion(io.url);
      const ergebnis = await schickeProbe(
        'iobroker',
        io.url,
        {
          'content-type': 'application/json',
          ...(io.token === '' ? {} : { authorization: `Bearer ${io.token}` }),
        },
        JSON.stringify(baueProbeMeldung(standort, new Date())),
        `Probemeldung an ${io.url} zugestellt — der Adapter hat sie angenommen.`,
      );
      const zeichen = { passt: '✓', zuAlt: '⚠', unbekannt: 'ℹ' }[befund.art];
      return `${ergebnis}\n\n${zeichen} ${befund.text}`;
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

// ---- Einzelne Alarme ein- und ausschalten (M14.3) ------------------------
//
// Anlass (21.08.2026): "Die Meldung ueber 24 h nicht erreichbare Geraete war
// gestern Abend sehr stoerend, zumal man ja auch nicht jeden Tag jeden
// Schalter betaetigt oder jedes Fenster oeffnet." Ein Alarm, den man
// gewohnheitsmaessig wegklickt, erzieht dazu, auch den zu ueberlesen, der
// zaehlt — also muss er einzeln abschaltbar sein.
//
// Derselbe Weg wie beim Alarmziel: Der Core erzeugt die fertige Datei, ein
// minimaler Root-Helfer legt sie nach /etc/grafana und startet Grafana neu.

const alarmschalterDatei = join(datenDir, 'alarme.json');
const alarmschalterTrigger = join(datenDir, 'alarmschalter-anstoss');
const alarmschalterYaml = join(datenDir, 'grafana-alarme.yaml');
/** Der Regeltext, wie er im Projekt liegt — einzige Quelle der Regeln. */
const alarmschalterVorlage = join(
  installDir, 'deploy/grafana/provisioning/alerting/asksin-alarme.yaml',
);

function leseAlarmschalter(): Alarmschalter {
  try {
    return vollstaendig(
      JSON.parse(readFileSync(alarmschalterDatei, 'utf8')) as Partial<Alarmschalter>,
    );
  } catch {
    return vollstaendig(undefined);
  }
}

const alarmschalterHooks = {
  zustand: (): unknown => {
    const s = leseAlarmschalter();
    return {
      regeln: ALARMREGELN.map((r) => ({
        uid: r.uid,
        name: r.name,
        zweck: r.zweck,
        aktiv: s[r.uid] === true,
      })),
      angewendet: existsSync(alarmschalterYaml),
      ...uebernahmeZustand(alarmschalterTrigger),
    };
  },
  einstellen: (auftrag: Record<string, unknown>): void => {
    verlangeMaster(aktuelleRolle().rolle);
    // Nur der Master hat Grafana — und nur dort gibt es Regeln zu pausieren.
    const teil = (auftrag['schalter'] ?? auftrag) as Partial<Alarmschalter>;
    const neu = vollstaendig(teil);

    // Die Vorlage kommt aus dem Projektverzeichnis. Fehlt sie, ist die
    // Installation unvollstaendig — dann lieber laut abbrechen als eine
    // halbe Datei nach /etc/grafana schicken.
    const vorlage = readFileSync(alarmschalterVorlage, 'utf8');

    writeFileSync(alarmschalterDatei, JSON.stringify(neu, null, 2) + '\n', { mode: 0o644 });
    writeFileSync(alarmschalterYaml, mitSchaltern(vorlage, neu), { mode: 0o644 });
    writeFileSync(alarmschalterTrigger, `${new Date().toISOString()}\n`);

    const aus = ALARMREGELN.filter((r) => neu[r.uid] === false).map((r) => r.uid);
    log(`Alarmschalter gesetzt — ausgeschaltet: ${aus.length === 0 ? 'keine' : aus.join(', ')}`);
  },
};

// ---- Systemaktualisierung (M17) ------------------------------------------
//
// apt-get update und apt-get full-upgrade aus der Weboberflaeche.
//
// Der Analyzer laeuft dauerhaft, haengt am Netz und traegt einen Webserver.
// Ein Geraet mit diesen drei Eigenschaften muss seine
// Sicherheitsaktualisierungen bekommen. Der uebliche Weg dorthin ist die
// Konsole — und genau die soll dieses Projekt niemandem zumuten.
//
// Ausgefuehrt wird in deploy/systemupdate.sh; hier steht nur, was der Dienst
// ohne Wurzelrechte tun darf: den Ausloeser legen und den Fortschritt lesen.

const systemupdateTrigger = join(datenDir, 'systemupdate-anstoss');
const systemupdateStatusDatei = join(datenDir, 'systemupdate-status.json');
const systemupdateErfolgDatei = join(datenDir, 'systemupdate-erfolg.json');
const systemupdateLog = join(datenDir, 'systemupdate.log');
/** Derselbe Ausloeser, den ein langer Tastendruck am Geraet benutzt. */
const neustartTrigger = join(datenDir, 'neustart-anstoss');

/** Wie viele Zeilen des Protokolls die Oberflaeche mitbekommt. */
const SYSTEMUPDATE_ZEILEN = 40;

function leseSystemupdateStatus(): SystemupdateStatus | null {
  try {
    return JSON.parse(readFileSync(systemupdateStatusDatei, 'utf8')) as SystemupdateStatus;
  } catch {
    return null;
  }
}

function leseSystemupdateErfolg(): SystemupdateErfolg | null {
  try {
    const roh = JSON.parse(readFileSync(systemupdateErfolgDatei, 'utf8')) as SystemupdateErfolg;
    return Number.isFinite(roh.zeit) ? roh : null;
  } catch {
    return null;
  }
}

/**
 * Die letzten Zeilen der Ausgabe.
 *
 * Damit sieht man in der Oberflaeche, WAS gerade passiert, und nicht nur, DASS
 * etwas passiert. Bei einem Fehlschlag steht die Meldung von apt darin —
 * woertlich, denn sie ist die eigentliche Auskunft.
 */
function systemupdateAusgabe(): string {
  try {
    // Die Datei bleibt klein (ein Lauf), aber nicht winzig: nur den Schwanz
    // lesen, damit ein langer Lauf die Antwort nicht aufblaeht.
    const alles = readFileSync(systemupdateLog, 'utf8');
    return alles.split('\n').slice(-SYSTEMUPDATE_ZEILEN).join('\n').trimEnd();
  } catch {
    return '';
  }
}

const systemupdateHooks = {
  zustand: (): unknown => {
    const status = leseSystemupdateStatus();
    const erfolg = leseSystemupdateErfolg();
    const jetzt = Date.now();
    return {
      laeuft: laeuftNoch(status, jetzt),
      status,
      letzterErfolg: erfolg,
      befund: bewerteAlter(erfolg?.zeit ?? null, jetzt),
      warnungAbTagen: SYSTEMUPDATE_WARNUNG_TAGE,
      // Nach einem Kernel-Update verlangt Debian einen Neustart. Die Auskunft
      // kommt aus der letzten Statusdatei UND aus der Gegenwart: Die Datei
      // /var/run/reboot-required kann auch ein Paket angelegt haben, das
      // ausserhalb dieser Oberflaeche eingespielt wurde.
      neustartNoetig: existsSync('/var/run/reboot-required') || (erfolg?.neustartNoetig === true),
      ausgabe: systemupdateAusgabe(),
    };
  },
  starten: (): boolean => {
    if (laeuftNoch(leseSystemupdateStatus(), Date.now())) return false;
    // Nicht neben dem Core-Update: update.sh installiert selbst Pakete
    // (jq, i2c-tools). Zwei apt-Laeufe gleichzeitig blockieren einander an der
    // Sperre, und der zweite liefe zehn Minuten ins Leere.
    const core = leseUpdateStatus();
    if (core !== null && core['running'] === true) {
      throw new Error(
        'Es läuft gerade eine Aktualisierung des Analyzers. Erst die abwarten — '
        + 'zwei apt-Läufe behindern einander.',
      );
    }
    writeFileSync(systemupdateTrigger, `${new Date().toISOString()}\n`);
    log('Systemaktualisierung angestoßen (Trigger-Datei für die systemd-Path-Unit)');
    return true;
  },
  /**
   * Startet den RECHNER neu, nicht den Dienst.
   *
   * Musste mit dazu: Nach einem Kernel-Update sagt die Oberflaeche "Neustart
   * noetig" — und bis eben war der einzige Weg dorthin ein fuenf Sekunden
   * langer Druck auf den Taster am Geraet. Wer keinen angeloetet hat, haette
   * die Konsole gebraucht, und die soll niemand brauchen.
   */
  neustart: (): void => {
    writeFileSync(neustartTrigger, `${new Date().toISOString()}\n`);
    log('Neustart des Rechners angefordert (Trigger-Datei für die Path-Unit)');
  },
};

const uiDir = resolve(import.meta.dirname, '../../webui/dist');
// Die Handbücher liegen im Projekt, nicht im Web-UI-Verzeichnis; ausgeliefert
// werden sie über eigene Routen, damit sie auch ohne Internet erreichbar sind.
//
// Zwei Bücher mit zwei Lesern: Das grosse begleitet den Analyzer von der
// Platine an, das Zigbee-Buch nur den Mithörer. Solange die Zigbee-Erweiterung
// eigenständig gepflegt wird, bleibt es ein eigenes Buch; erst danach wandert
// sein Inhalt als Kapitel in das grosse.
const handbuecher: Record<string, { datei: string; name: string }> = {
  '/handbuch.pdf': {
    datei: resolve(import.meta.dirname, '../../docs/handbuch/AskSin-Analyzer-Handbuch.pdf'),
    name: 'AskSin-Analyzer-Handbuch.pdf',
  },
  '/handbuch-zigbee.pdf': {
    datei: resolve(
      import.meta.dirname,
      '../../projekt/zigbee-integration/handbuch/Zigbee-Mithoerer-Handbuch.pdf',
    ),
    name: 'Zigbee-Mithoerer-Handbuch.pdf',
  },
};
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

// ---- Zigbee-Mithörer (M16) ---------------------------------------------
//
// Einstellungen aus der Oberflaeche landen in einer eigenen Datei im
// Datenverzeichnis, nicht in /etc/asksin-analyzer/config.json: Der Dienst
// laeuft unprivilegiert und darf dort nicht schreiben.
//
// Diese Datei **uebersteuert** config.json. Genau daran ist die Statusanzeige
// schon einmal gescheitert — config.json stand auf SPI, statusanzeige.json auf
// PWM, und die LED blieb dunkel, waehrend beide Dateien "richtig" aussahen.
// Deshalb wird der uebersteuerte Wert hier beim Start ins Protokoll geschrieben.
const zigbeeKonfigDatei = join(datenDir, 'zigbee.json');

interface ZigbeeKonfig {
  aktiv: boolean;
  device: string;
  kanal: number;
  /** deCONZ-Anbindung für die Gerätenamen. Leer = keine Namen. */
  deconzHost: string;
  /** API-Schlüssel — nur hier im Speicher und in zigbee.json, sonst nirgends. */
  deconzSchluessel: string;
}

function zigbeeKonfigLesen(): ZigbeeKonfig {
  const ausConfig: ZigbeeKonfig = {
    aktiv: konfig.zigbee?.aktiv === true,
    device: konfig.zigbee?.device ?? ZIGBEE_DEVICE,
    kanal: konfig.zigbee?.kanal ?? ZIGBEE_KANAL,
    deconzHost: konfig.zigbee?.deconz?.host ?? '',
    deconzSchluessel: '',
  };
  if (!existsSync(zigbeeKonfigDatei)) return ausConfig;
  try {
    const roh = JSON.parse(readFileSync(zigbeeKonfigDatei, 'utf8')) as Partial<ZigbeeKonfig>;
    const zusammen: ZigbeeKonfig = {
      aktiv: typeof roh.aktiv === 'boolean' ? roh.aktiv : ausConfig.aktiv,
      device: typeof roh.device === 'string' && roh.device !== ''
        ? roh.device : ausConfig.device,
      kanal: Number.isInteger(roh.kanal) && (roh.kanal as number) >= 11
        && (roh.kanal as number) <= 26 ? (roh.kanal as number) : ausConfig.kanal,
      deconzHost: typeof roh.deconzHost === 'string'
        ? roh.deconzHost : ausConfig.deconzHost,
      deconzSchluessel: typeof roh.deconzSchluessel === 'string'
        ? roh.deconzSchluessel : ausConfig.deconzSchluessel,
    };
    // 'deconzSchluessel' fehlt hier mit Absicht: Der Wert gehoert in kein Protokoll.
    for (const feld of ['aktiv', 'device', 'kanal', 'deconzHost'] as const) {
      if (zusammen[feld] !== ausConfig[feld]) {
        log(`Zigbee: ${feld} aus zigbee.json (${String(zusammen[feld])}) ` +
            `uebersteuert config.json (${String(ausConfig[feld])})`);
      }
    }
    return zusammen;
  } catch (err) {
    log(`Zigbee: ${zigbeeKonfigDatei} unlesbar (${String(err)}) — config.json gilt`);
    return ausConfig;
  }
}

//
// Eigener Leser, eigener Speicher, eigene Tabellen — der BidCoS-Pfad wird
// nicht angefasst. Fehlt der Stick, versucht der Leser es weiter und der
// Analyzer läuft davon unberührt: KEIN Startabbruch, keine Neustartschleife.
//
// Im Demo-Modus bleibt er aus. Erfundene Funktelegramme gibt es dort mit
// Absicht; erfundene Zigbee-Pakete wären etwas anderes — sie sollen zeigen,
// was wirklich in der Luft ist.
const zigbeeKonfig = zigbeeKonfigLesen();
let zigbeeLeser: ZigbeeLeser | null = null;
let zigbeeSpeicher: ZigbeeSpeicher | null = null;

if (zigbeeKonfig.aktiv && !demoAktiv) {
  const geraet = zigbeeKonfig.device;
  zigbeeSpeicher = new ZigbeeSpeicher(db, {
    ...(konfig.zigbee?.bestaetigungen === undefined
      ? {}
      : { bestaetigungen: konfig.zigbee.bestaetigungen }),
  });
  const speicher = zigbeeSpeicher;
  zigbeeLeser = new ZigbeeLeser({
    openPort: sttyPortOpener(geraet, ZIGBEE_BAUD, (text) =>
      log(`Zigbee-Anschluss: ${text}`)),
    kanal: zigbeeKonfig.kanal,
    onPaket: (paket) => speicher.aufnehmen(paket),
  });
  zigbeeLeser.start();
  log(`Zigbee-Mithörer aktiv: ${geraet}, Kanal ${zigbeeLeser.kanal}`);

  // Regelmäßig spülen, damit nach einem harten Abbruch höchstens ein paar
  // Sekunden fehlen. Der Speicher schreibt zusätzlich bei vollem Puffer.
  const spuelTakt = setInterval(() => {
    try {
      speicher.schreiben();
    } catch (err) {
      protokoll?.fehler('zigbee', `Zigbee-Schreiben fehlgeschlagen: ${String(err)}`);
    }
  }, 30_000);
  spuelTakt.unref();

  // Aufräumen einmal täglich — dieselbe Taktung wie beim BidCoS-Pfad.
  const aufraeumTakt = setInterval(() => {
    try {
      const weg = speicher.aufraeumen({
        ...(konfig.zigbee?.paketeTage === undefined
          ? {}
          : { paketeTage: konfig.zigbee.paketeTage }),
        ...(konfig.zigbee?.stundenTage === undefined
          ? {}
          : { stundenTage: konfig.zigbee.stundenTage }),
      });
      if (weg.pakete > 0 || weg.stunden > 0) {
        log(`Zigbee aufgeraeumt: ${weg.pakete} Pakete, ${weg.stunden} Stundenzeilen`);
      }
    } catch (err) {
      protokoll?.fehler('zigbee', `Zigbee-Aufraeumen fehlgeschlagen: ${String(err)}`);
    }
  }, 86_400_000);
  aufraeumTakt.unref();
} else if (zigbeeKonfig.aktiv) {
  log('Zigbee-Mithörer im Demo-Modus ausgelassen');
}

// Gerätenamen von deCONZ. Läuft unabhängig vom Mithörer: Die Namen sind auch
// dann nützlich, wenn gerade kein Stick steckt — dann zeigt die Liste, welche
// Geräte es gibt, und der Vergleich „nie gehört" bleibt möglich.
const zigbeeNamen = new DeconzNamen({
  host: zigbeeKonfig.deconzHost,
  schluessel: zigbeeKonfig.deconzSchluessel,
  cachePfad: join(datenDir, 'zigbee-namen.json'),
  onLog: (text) => log(text),
});

if (zigbeeKonfig.deconzHost !== '' && zigbeeKonfig.deconzSchluessel !== '') {
  void zigbeeNamen.aktualisieren();
  // Halbstündlich: Namen ändern sich selten, und jeder Abruf fragt deCONZ
  // einmal je Gerät — bei 35 Geräten sind das 36 Anfragen.
  setInterval(() => void zigbeeNamen.aktualisieren(), 1_800_000).unref();
}

/**
 * Mittlere Verbindungsgüte des eigenen Zigbee-Netzes, höchstens minütlich neu
 * gerechnet.
 *
 * Median über die **Geräte**, nicht über die Pakete: Der Koordinator sitzt
 * meist im selben Raum, sendet am meisten und liefert LQI 255. Über die
 * Pakete gemittelt stünde der Balken dauerhaft auf fünf, ganz gleich wie der
 * Rest des Hauses gehört wird.
 *
 * Fremde Netze bleiben draussen — dasselbe Verfahren wie in der Übersicht:
 * Das eigene Netz ist das mit den meisten Paketen.
 */
let zigbeeGueteWert: number | null = null;
let zigbeeGueteAm = 0;

function zigbeeGueteGepuffert(): number | null {
  const jetzt = Date.now();
  if (jetzt - zigbeeGueteAm < 60_000) return zigbeeGueteWert;
  zigbeeGueteAm = jetzt;
  if (!zigbeeKonfig.aktiv) {
    zigbeeGueteWert = null;
    return null;
  }
  try {
    const roh = zigbeeHooks.geraete(1) as Array<Record<string, unknown>>;
    const jePan = new Map<number, number>();
    for (const g of roh) {
      const pan = g['pan'] as number;
      jePan.set(pan, (jePan.get(pan) ?? 0) + (g['pakete'] as number));
    }
    let eigenes: number | null = null;
    let max = -1;
    for (const [pan, n] of jePan) if (n > max) { max = n; eigenes = pan; }

    zigbeeGueteWert = median(
      roh
        .filter((g) => g['pan'] === eigenes)
        .map((g) => {
          const pakete = g['pakete'] as number;
          return pakete > 0 ? (g['sum_lqi'] as number) / pakete : Number.NaN;
        }),
    );
  } catch {
    // Eine fehlgeschlagene Abfrage darf /api/health nicht mitreissen.
    zigbeeGueteWert = null;
  }
  return zigbeeGueteWert;
}

/** Was die Oberfläche über Zigbee erfährt und einstellen darf. */
const zigbeeHooks: ZigbeeHooks = {
  // Was `zustand()` im Feld `aktiv` sagt, sagt diese Frage der Leitung: Die
  // Einstellungsseite darf einen ausgeschalteten Mithörer sehen, die
  // Verbund-Auswertung darf ihn nicht mit einem stillen verwechseln.
  aktiv: (): boolean => zigbeeKonfig.aktiv,

  /**
   * Was sich über Stick und Firmware sagen lässt, **ohne den Anschluss
   * aufzumachen** — plus der letzte Lauf des Aufspielhelfers.
   *
   * Der Analyzer läuft unprivilegiert und ruft hier ausdrücklich keinen
   * Root-Helfer über sudo auf: Das Trennmuster des ganzen Projekts ist
   * „unprivilegierter Dienst schreibt eine Datei, eng begrenzter Root-Helfer
   * führt aus". Eine sudo-Regel für eine blosse Auskunft würde es aufweichen.
   *
   * Auch nicht selbst gemessen wird, ob die Mithör-Firmware auf dem Stick
   * sitzt. Dafür müsste der Anschluss geöffnet werden — und läuft der
   * Mithörer, nähme das ihm die Bytes weg. Diese Frage beantwortet der
   * Helfer beim Aufspielen, mit angehaltenem Dienst. Hier steht nur, was
   * ohne Eingriff sichtbar ist:
   *
   *   sticks    wie viele SONOFF-Sticks stecken (0, 1 oder mehr)
   *   laeuft    ob gerade aufgespielt wird
   *   hoert     ob der eigene Mithörer Zeilen bekommt — das ist der
   *             endgültige Beweis, dass die Firmware stimmt
   */
  firmwareStand: async (): Promise<Record<string, unknown>> => {
    let sticks: string[] = [];
    try {
      sticks = (await readdir(BY_ID_DIR))
        .filter((n) => /sonoff_zigbee/i.test(n))
        .map((n) => join(BY_ID_DIR, n));
    } catch { /* Verzeichnis fehlt, wenn gar kein serielles USB-Gerät steckt */ }

    let letzterLauf: unknown = null;
    try {
      letzterLauf = JSON.parse(readFileSync(zigbeeFirmwareStatus, 'utf8')) as unknown;
    } catch { /* noch nie gelaufen */ }

    const s = zigbeeLeser?.stats;
    return {
      sticks: sticks.length,
      geraet: sticks[0] ?? null,
      laeuft: existsSync(zigbeeFirmwareTrigger),
      hoert: (s?.verbunden ?? false) && (s?.pakete ?? 0) > 0,
      aktiv: zigbeeKonfig.aktiv,
      letzterLauf,
    };
  },

  firmwareAufspielen: (): void => {
    if (existsSync(zigbeeFirmwareTrigger)) {
      throw new Error('Es läuft bereits ein Aufspielvorgang');
    }
    writeFileSync(zigbeeFirmwareTrigger, `${new Date().toISOString()}\n`);
    log('Zigbee: Aufspielen der Mithörer-Firmware angestossen');
  },

  zustand: (): Record<string, unknown> => {
    const s = zigbeeLeser?.stats;
    return {
      aktiv: zigbeeKonfig.aktiv,
      device: zigbeeKonfig.device,
      kanal: zigbeeLeser?.kanal ?? zigbeeKonfig.kanal,
      demo: demoAktiv,
      // Ohne Stick bleibt `verbunden` false — daran ist der Zustand
      // erkennbar, nicht daran, dass Zahlen fehlen.
      verbunden: s?.verbunden ?? false,
      verbundenSeit: s?.verbundenSeit ?? null,
      zeilen: s?.zeilen ?? 0,
      pakete: s?.pakete ?? 0,
      verworfen: s?.verworfen ?? null,
      ueberlauf: s?.ueberlauf ?? 0,
      neuverbindungen: s?.neuverbindungen ?? 0,
      letzteZeileAm: s?.letzteZeileAm ?? null,
      gespeichert: zigbeeSpeicher?.stats.geschrieben ?? 0,
      bestaetigungen: zigbeeSpeicher?.stats.bestaetigungen ?? 0,
      schreibfehler: zigbeeSpeicher?.stats.fehler ?? 0,
      namen: zigbeeNamen.zustand,
    };
  },

  geraete: (stunden: number): unknown[] => {
    const ab = Math.floor(Date.now() / 3_600_000) - stunden;
    const zeilen = db.prepare(
      `SELECT pan, addr,
              SUM(pakete)  AS pakete,
              SUM(schwach) AS schwach,
              MIN(min_rssi) AS min_rssi,
              MAX(max_rssi) AS max_rssi,
              SUM(sum_rssi) AS sum_rssi,
              MIN(min_lqi)  AS min_lqi,
              MAX(max_lqi)  AS max_lqi,
              SUM(sum_lqi)  AS sum_lqi,
              MAX(hour)     AS zuletzt
         FROM zigbee_device_hours
        WHERE hour >= ?
        GROUP BY pan, addr
        ORDER BY pakete DESC`,
    ).all(ab) as Array<Record<string, unknown>>;

    // Kurzadresse -> IEEE -> Name. Die IEEE-Adresse kommt aus dem NWK-Kopf
    // der mitgehörten Pakete, der Name von deCONZ. Keine der beiden Quellen
    // allein reicht: deCONZ kennt keine Kurzadressen, der Funk keine Namen.
    //
    // Bei mehreren Zuordnungen zählt die zuletzt gesehene — eine Kurzadresse
    // wird beim Neuanmelden neu vergeben.
    const zuIeee = db.prepare(
      `SELECT ieee FROM zigbee_adressen
        WHERE pan = ? AND addr = ?
        ORDER BY zuletzt DESC LIMIT 1`,
    );
    for (const z of zeilen) {
      // Typen ausdruecklich pruefen statt durchzureichen: Die Abfrage liefert
      // SQLOutputValue, und ein falscher Typ soll hier auffallen und nicht
      // erst in der Datenbankschicht.
      const pan = z['pan'];
      const addr = z['addr'];
      if (typeof pan !== 'number' || typeof addr !== 'string') continue;
      const treffer = zuIeee.get(pan, addr) as { ieee: string } | undefined;
      if (treffer === undefined) continue;
      z['ieee'] = treffer.ieee;
      const g = zigbeeNamen.geraet(treffer.ieee);
      if (g !== undefined) {
        z['name'] = g.name;
        if (g.hersteller !== undefined) z['hersteller'] = g.hersteller;
        if (g.modell !== undefined) z['modell'] = g.modell;
      }
    }
    return zeilen;
  },

  nieGehoert: (stunden: number): unknown[] => {
    // Sollmenge: was deCONZ kennt. Istmenge: welche IEEE-Adressen in diesem
    // Zeitraum gehört wurden. Ohne Namensanbindung gibt es keine Sollmenge —
    // dann ist die Liste leer statt erfunden.
    const alle = zigbeeNamen.alle();
    if (alle.length === 0) return [];

    const ab = Math.floor(Date.now() / 3_600_000) - stunden;
    const gehoert = new Set<string>();
    const zeilen = db.prepare(
      `SELECT DISTINCT a.ieee
         FROM zigbee_device_hours h
         JOIN zigbee_adressen a ON a.pan = h.pan AND a.addr = h.addr
        WHERE h.hour >= ?`,
    ).all(ab) as Array<{ ieee: string }>;
    for (const z of zeilen) gehoert.add(z.ieee);

    return alle
      .filter((g) => !gehoert.has(g.ieee))
      .map((g) => ({
        ieee: g.ieee,
        name: g.name,
        ...(g.hersteller === undefined ? {} : { hersteller: g.hersteller }),
        ...(g.modell === undefined ? {} : { modell: g.modell }),
      }));
  },

  pakete: (minuten: number, grenze: number): { pakete: unknown[]; gekuerzt: boolean } => {
    const ab = Date.now() - minuten * 60_000;
    // Eins mehr holen als erlaubt: Nur so ist zu erkennen, ob gekuerzt wurde.
    // Ohne diese Auskunft haelt die Oberflaeche eine Kuerzung fuer Funkstille.
    const zeilen = db.prepare(
      `SELECT ts, kanal, rssi, lqi, laenge, typ, seq, pan, von, an, rundruf
         FROM zigbee_packets
        WHERE ts >= ?
        ORDER BY ts DESC
        LIMIT ?`,
    ).all(ab, grenze + 1);
    const gekuerzt = zeilen.length > grenze;
    return { pakete: gekuerzt ? zeilen.slice(0, grenze) : zeilen, gekuerzt };
  },

  schluesselAnfordern: async (host: string): Promise<Record<string, unknown>> => {
    const ziel = host.trim() === '' ? zigbeeKonfig.deconzHost : host.trim();
    const ergebnis = await zigbeeNamen.schluesselAnfordern(
      ziel, zigbeeKonfig.deconzSchluessel);
    if (!ergebnis.ok) return { ...ergebnis };

    zigbeeKonfig.deconzHost = ziel;
    zigbeeKonfig.deconzSchluessel = zigbeeNamen.schluessel;
    writeFileSync(
      zigbeeKonfigDatei,
      JSON.stringify({
        aktiv: zigbeeKonfig.aktiv,
        device: zigbeeKonfig.device,
        kanal: zigbeeKonfig.kanal,
        deconzHost: zigbeeKonfig.deconzHost,
        deconzSchluessel: zigbeeKonfig.deconzSchluessel,
      }, null, 2),
      { mode: 0o600 },
    );
    // Der Schluessel steht nicht im Protokoll — nur, dass es einen gibt.
    log(`Zigbee: neuer deCONZ-Schlüssel für ${ziel} hinterlegt`);
    await zigbeeNamen.aktualisieren();
    return { ...ergebnis, anzahl: zigbeeNamen.anzahl };
  },

  setzen: async (auftrag: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const neu: ZigbeeKonfig = { ...zigbeeKonfig };
    let neustartNoetig = false;

    if ('kanal' in auftrag) {
      const k = Number(auftrag['kanal']);
      if (!Number.isInteger(k) || k < 11 || k > 26) {
        throw new Error('kanal: ganze Zahl von 11 bis 26 erwartet');
      }
      neu.kanal = k;
    }
    if ('deconzHost' in auftrag) {
      const h = auftrag['deconzHost'];
      if (typeof h !== 'string') throw new Error('deconzHost: Text erwartet');
      neu.deconzHost = h.trim();
    }
    if ('deconzSchluessel' in auftrag) {
      const s = auftrag['deconzSchluessel'];
      if (typeof s !== 'string') throw new Error('deconzSchluessel: Text erwartet');
      // Leer heisst „unveraendert lassen" — sonst loescht jedes Speichern der
      // Seite den Schluessel, weil die Oberflaeche ihn nur maskiert anzeigt.
      if (s !== '') neu.deconzSchluessel = s;
    }
    if ('aktiv' in auftrag) {
      if (typeof auftrag['aktiv'] !== 'boolean') {
        throw new Error('aktiv: true oder false erwartet');
      }
      neu.aktiv = auftrag['aktiv'];
      // Ein- und Ausschalten heisst: serielle Schnittstelle oeffnen oder
      // schliessen und die Tabellen anlegen. Das im laufenden Dienst zu
      // verdrahten waere mehr Zustand als Nutzen — ein Neustart ist ehrlicher.
      if (neu.aktiv !== zigbeeKonfig.aktiv) neustartNoetig = true;
    }

    // 0600: Hier steht der deCONZ-Schluessel drin.
    writeFileSync(zigbeeKonfigDatei, JSON.stringify(neu, null, 2), { mode: 0o600 });
    const kanalGewechselt = neu.kanal !== zigbeeKonfig.kanal;
    zigbeeKonfig.aktiv = neu.aktiv;
    zigbeeKonfig.kanal = neu.kanal;
    zigbeeKonfig.deconzHost = neu.deconzHost;
    zigbeeKonfig.deconzSchluessel = neu.deconzSchluessel;

    // Der Kanal wirkt sofort, wenn der Leser laeuft — dafuer braucht es
    // keinen Neustart, und die Oberflaeche soll das auch nicht behaupten.
    if (kanalGewechselt && zigbeeLeser !== null) {
      await zigbeeLeser.kanalSetzen(neu.kanal);
      log(`Zigbee: Kanal auf ${neu.kanal} gewechselt`);
    }
    if (neustartNoetig) {
      log(`Zigbee ${neu.aktiv ? 'ein' : 'aus'}geschaltet — wirkt nach dem Neustart`);
    }
    // Der Schluessel geht NICHT zurueck an die Oberflaeche.
    const { deconzSchluessel, ...ohneGeheimnis } = neu;
    return { ...ohneGeheimnis, neustartNoetig,
             deconzSchluesselGesetzt: deconzSchluessel !== '' };
  },
};

const api = new ApiServer({
  analyzer,
  db,
  ...(devList === undefined ? {} : { devList }),
  version: paketVersion(),
  config: { ccuip: konfig.ccu.host, demo: demoAktiv, standort },
  ...(konfig.http.authToken === '' ? {} : { authToken: konfig.http.authToken }),
  ...(existsSync(uiDir) ? { uiDir } : {}),
  handbuecher,
  update: updateHooks,
  verbund: verbundHooks,
  netzwerk: netzwerkHooks,
  statusAnzeige: statusAnzeigeHooks,
  zigbee: zigbeeHooks,
  rolle: () => aktuelleRolle().rolle,
  zigbeeGuete: () => zigbeeGueteGepuffert(),
  influx: influxHooks,
  langzeit: langzeitHooks,
  alarmziel: alarmzielHooks,
  alarmschalter: alarmschalterHooks,
  systemupdate: systemupdateHooks,
  protokoll: protokollHooks,
  mitschnitt: mitschnittHooks,
  // Der Test läuft vom Analyzer aus, nicht aus dem Browser: Erreichen muss
  // die CCU der Dienst, und nur sein Ergebnis zählt.
  ccuTest: (host: string) => testeCcu(host, httpFetchBytes),
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
// Das `else` hing bis zum 18.08.2026 am Handbuch statt am Web-UI: Lag das
// Handbuch da, blieb die Meldung "Kein Web-UI gefunden" aus — und fehlte es,
// stand sie da, obwohl das Web-UI vorhanden war. Aufgefallen ist es erst, als
// aus dem einen Handbuch eine Schleife wurde und der Compiler sich meldete.
if (existsSync(uiDir)) {
  log(`Web-UI: ${uiDir}`);
} else {
  log('Kein Web-UI gefunden (webui/dist fehlt) — nur API');
}
for (const [route, buch] of Object.entries(handbuecher)) {
  // Ein fehlendes Handbuch ist kein Fehler — die PDFs werden gebaut, nicht
  // eingecheckt erzeugt. Nur soll niemand vergeblich auf den Knopf drücken,
  // ohne dass es irgendwo steht.
  log(existsSync(buch.datei) ? `Handbuch: ${route}` : `Handbuch fehlt: ${buch.datei}`);
}

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
      // Erst danebenschreiben, dann umbenennen. Ein Umbenennen ist unteilbar,
      // und ext4 schiebt bei einem Umbenennen ueber eine bestehende Datei die
      // Daten vorher hinaus (auto_da_alloc). Ohne das stand nach einem
      // Stromausfall die richtige Laenge in der Datei, aber lauter Nullbytes —
      // und der Analyzer versuchte minuetlich, damit das Journal zu lesen.
      const tmp = `${cursorDatei}.neu`;
      writeFileSync(tmp, systemlog.cursor + '\n');
      renameSync(tmp, cursorDatei);
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
          `Last ${w.last5.toFixed(2)} · Laufzeit ${(w.laufzeitS / 3600).toFixed(1)} h · ` +
          // Aufschlüsselung im Klartext, damit ein wachsender Speicher schon
          // beim Überfliegen des Protokolls zuzuordnen ist und nicht erst,
          // wenn jemand die JSON-Anhänge auswertet.
          `Prozess ${w.prozessRssMb.toFixed(0)} MB ` +
          `(Heap ${w.heapBenutztMb.toFixed(0)}, extern ${w.externMb.toFixed(0)}, ` +
          `Puffer ${w.pufferMb.toFixed(0)}) · ` +
          `${w.deskriptoren ?? '?'} Deskriptoren`,
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
    // Nach analyzer.stop(): Erst dann kommen keine Zeilen mehr nach, und der
    // letzte Puffer landet vollstaendig in der Datei.
    mitschnittStoppen();
    // Reihenfolge zaehlt: erst den Leser anhalten, dann den letzten Schub
    // schreiben. Umgekehrt landeten die Pakete der letzten Sekunden nicht
    // mehr in der Datenbank.
    await zigbeeLeser?.stop();
    try {
      zigbeeSpeicher?.schreiben();
    } catch (err) {
      log(`Zigbee: letzter Schub verloren (${String(err)})`);
    }
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
