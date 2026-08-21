/**
 * ApiServer — REST-Schicht auf `node:http`, ohne Laufzeitabhängigkeit.
 *
 * Zwei Endpunktfamilien:
 *
 *  - **Kompatibilitätssatz** der originalen Web-UI (docs/webui-und-updates.md
 *    §2): `/getLogByLogNumber`, `/getRSSILog`, `/getConfig`,
 *    `/getAskSinAnalyzerDevListJSON` plus die Kommando-Routen. Die
 *    unveränderte App funktioniert damit gegen den Core, sobald man ihre
 *    Basis-URL hierher richtet.
 *  - **Eigene API** unter `/api/*` für den UI-Nachbau (M5.5) und den
 *    ioBroker-Adapter: `snapshot` und `health`. Ein WebSocket-Live-Feed
 *    folgt mit dem UI-Nachbau — die Original-App pollt ohnehin nur.
 *
 * Sicherheit (§5): bindet standardmäßig an 127.0.0.1. Ist `authToken`
 * gesetzt, verlangen alle **verändernden** Routen `Authorization: Bearer`.
 * `/rebootInConfigMode` (ESP-WLAN-Portal) antwortet 501; die SD-Routen
 * antworten kompatibel mit `OK`, gemeldet wird `sdcardavailable: 0`.
 */

import { readFileSync } from 'node:fs';
import { balkenAusLqi, balkenAusStoerabstand, median } from '../analytics/balken.ts';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { hostname, networkInterfaces } from 'node:os';
import { extname, join, normalize, resolve, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { baueFirmwarebefund } from '../decode/firmwarebefund.ts';
import { decodeFlags } from '../decode/flags.ts';
import { decodeMsgType, isHmIpType } from '../decode/msgTypes.ts';
import { systemTime } from '../ingest/time.ts';
import type { TimeSource } from '../ingest/time.ts';
import type { DevListService } from '../resolve/fetcher.ts';
import type { Analyzer } from '../service/analyzer.ts';
import {
  dayOf,
  dayRange,
  toCsvLine,
  toRssiLogEntry,
  toVersionParts,
} from './compat.ts';
import type { NoiseMinuteRow, TelegramRow } from './compat.ts';

export interface ApiConfig {
  /** Hostname/IP der CCU — landet in `/getConfig` (Feld `ccuip`). */
  ccuip?: string;
  ntp?: string;
  rssiAlarmThreshold?: number;
  rssiAlarmCount?: number;
  /** Läuft die Instanz mit simulierten Daten? Reine Anzeige — das
   *  Umschalten übernimmt der Dienst über `/setConfig` (Feld `demo`). */
  demo?: boolean;
  /** Standort-Identität (M9.1): unterscheidet die Analyzer eines Verbunds
   *  in UI, APIs und später als Influx-Tag/Adapter-Instanzname. */
  standort?: string;
}

/**
 * Was die Oberfläche über den Zigbee-Mithörer wissen und einstellen kann.
 *
 * `zustand()` beantwortet drei Fragen auf einmal, weil die Seite sie
 * zusammen stellt: Ist er eingeschaltet? Hört er gerade? Und was kommt an?
 * Ein Analyzer ohne Stick soll daran erkennbar sein, dass `verbunden` false
 * ist — nicht daran, dass die Zahlen fehlen.
 */
/**
 * Obergrenze fuer die Paketliste. Bei rund 13 Paketen je Sekunde sind 5000
 * gut sechs Minuten — mehr braucht eine Live-Ansicht nicht, und mehr will
 * ein Browser auf einem Tablet auch nicht geliefert bekommen.
 */
const MAX_ZIGBEE_PAKETE = 5000;

/**
 * Zahl aus der Abfragezeichenkette, auf einen Bereich begrenzt.
 *
 * Begrenzt statt abgewiesen: Wer `?minuten=99999` schickt, bekommt das
 * Zulaessige und keine Fehlermeldung. Eine Ansicht, die wegen einer zu
 * grossen Zahl gar nichts zeigt, ist unbrauchbarer als eine gekuerzte.
 */
function zahlAusUrl(url: URL, name: string, vorgabe: number,
                    min: number, max: number): number {
  const roh = url.searchParams.get(name);
  if (roh === null) return vorgabe;
  const n = Number(roh);
  if (!Number.isFinite(n)) return vorgabe;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

export interface ZigbeeHooks {
  zustand(): Record<string, unknown>;
  /**
   * Läuft hier ein Mithörer?
   *
   * Muss sein, weil die Hooks **immer** hängen — auch ohne Stick, sonst gäbe
   * es keine Einstellungsseite, auf der man Zigbee einschalten könnte. Ohne
   * diese Frage antwortet ein Analyzer ohne Stick auf `/api/zigbee/geraete`
   * mit einer leeren Liste und 200, und das heißt auf der Leitung dasselbe
   * wie „ich höre mit und habe nichts gehört". Genau diese beiden Fälle
   * auseinanderzuhalten ist der Zweck der ganzen Matrix.
   */
  aktiv(): boolean;
  /**
   * Zustand des Sticks und der Firmware darauf, zusammen mit dem letzten
   * Lauf des Aufspielhelfers.
   *
   * Getrennt von `zustand()`, weil es etwas anderes beantwortet: `zustand()`
   * sagt, was der Mithörer gerade tut; das hier sagt, ob überhaupt ein Stick
   * dasteht und ob die richtige Firmware darauf ist.
   */
  firmwareStand(): Promise<unknown>;
  /** Aufspielen anstoßen. Wirft, wenn schon etwas läuft. */
  firmwareAufspielen(): void;
  /** Geräte der letzten `stunden` Stunden, aus den Stundensummen. */
  geraete(stunden: number): unknown[];
  /**
   * Geräte, die deCONZ kennt, dieser Analyzer aber im Zeitraum **nicht**
   * gehört hat.
   *
   * Der eigentliche Zweck des Ganzen — und er funktioniert schon mit einem
   * einzigen Standort: Die deCONZ-Liste ist die Sollmenge, alles Gehörte die
   * Istmenge, die Differenz die Frage. Ohne Namensanbindung ist die Liste
   * leer, denn dann gibt es keine Sollmenge.
   */
  nieGehoert(stunden: number): unknown[];
  /** Pakete der letzten `minuten` Minuten, höchstens `grenze` Stück. */
  pakete(minuten: number, grenze: number): { pakete: unknown[]; gekuerzt: boolean };
  /**
   * Einschalten, ausschalten, Kanal wechseln. Wirft bei ungültigen Angaben.
   *
   * Ein Kanalwechsel wirkt sofort; das Ein- und Ausschalten schreibt die
   * Konfiguration und verlangt einen Neustart des Dienstes — das sagt die
   * Antwort im Feld `neustartNoetig`, statt es zu verschweigen.
   */
  setzen(auftrag: Record<string, unknown>): Promise<Record<string, unknown>>;
  /**
   * Einen Schlüssel bei deCONZ anfordern, solange dort das Anmeldefenster
   * offen ist.
   *
   * Der Grund für diesen Zweig: deCONZ zeigt bestehende Schlüssel nie an. Wer
   * einen von Hand besorgt, kopiert ein Zugangstoken durch Zwischenablage und
   * Bildschirm. Holt der Analyzer ihn selbst, sieht ihn niemand — und die
   * Antwort enthält ihn ausdrücklich nicht.
   */
  schluesselAnfordern(host: string): Promise<Record<string, unknown>>;
}

export interface ApiServerOptions {
  analyzer: Analyzer;
  db: DatabaseSync;
  devList?: DevListService;
  /** Semver des Core — wird zu `version_upper`/`version_lower`. */
  version?: string;
  /**
   * Rolle im Verbund für `/api/health`.
   *
   * Die Oberfläche blendet daran die Verbund-Tabs ein oder aus. Sie gehört in
   * health und nicht in einen eigenen Zweig: Die Kopfzeile holt health ohnehin
   * im Sekundentakt, und ein zweiter Abruf nur für ein Wort wäre Verschwendung.
   */
  rolle?: () => 'master' | 'client';
  /**
   * Mittlere Zigbee-Verbindungsgüte des eigenen Netzes (LQI 0…255).
   *
   * Vom Aufrufer geliefert und dort zwischengespeichert: Der Wert entsteht
   * aus einer Zusammenfassung über Stunden, und `/api/health` wird im
   * Sekundentakt abgefragt. Ohne Mithörer oder ohne Messung: null.
   */
  zigbeeGuete?: () => number | null;
  config?: ApiConfig;
  /** Wenn gesetzt: Pflicht-Bearer-Token für alle verändernden Endpunkte. */
  authToken?: string;
  time?: TimeSource;
  /** Neustart des Core-Diensts (nicht des Pi). Ohne Callback: 501. */
  onReboot?: () => void;
  /** Erhält alle per `/setConfig` übergebenen bekannten Felder. */
  onSetConfig?: (changes: Record<string, string>) => void;
  /** Max. Telegramme je `/getLogByLogNumber`-Antwort. Vorgabe 50 (Original). */
  maxLogBatch?: number;
  /** Verzeichnis des gebauten Web-UI (webui/dist). Ohne Angabe: kein UI. */
  uiDir?: string;
  /**
   * Die Handbücher, jeweils Route → Datei und Anzeigename.
   *
   * Eigene Routen statt Ablage im Web-UI-Verzeichnis: Die PDFs liegen im Repo
   * (`docs/handbuch/` und `projekt/…/handbuch/`) und sollen dort auch bleiben —
   * Kopien in `webui/dist` würden bei jedem Bau mitwandern und die Dateien
   * doppelt im Repository halten. Der Weg über Routen hält die Handbücher
   * zugleich **ohne Internet** erreichbar; das Gerät steht im Schrank.
   *
   * Als Liste und nicht als einzelnes Feld, seit es zwei sind: Das
   * Zigbee-Handbuch ist ein eigenes Buch mit eigenem Leser, und wer auf der
   * Zigbee-Seite steht, soll nicht das BidCoS-Handbuch angeboten bekommen.
   */
  handbuecher?: Record<string, { datei: string; name: string }>;
  /** Update-Mechanik (liefert analyzerd). Ohne Hooks: 501 auf /api/update/*. */
  update?: UpdateHooks;
  /** Verbund-Rolle (M9.2/M9.3). Ohne: 501 auf /api/verbund*. */
  verbund?: {
    uebersicht(): Promise<unknown>;
    matrix?(): Promise<unknown>;
    /**
     * Zigbee-Empfangsmatrix (M16.7): welcher Standort hört welches Gerät.
     *
     * Getrennt von `matrix()`, nicht dazugemischt: BidCoS- und Zigbee-Adressen
     * sind verschieden lang, und eine gemeinsame Tabelle würde sie früher oder
     * später verwechseln — an einer Stelle, an der es niemandem auffällt.
     */
    zigbeeMatrix?(stunden: number): Promise<unknown>;
    matrixCsv?(): Promise<string>;
    telegramme?(): Promise<unknown>;
    /** Peer-Liste für die UI-Verwaltung — OHNE Tokens. */
    peers?(): unknown;
    /** {aktion:'hinzufuegen'|'entfernen', url, name?, token?} — wirft bei
     *  ungültigen Angaben; Änderung ist sofort wirksam und persistiert. */
    peersAendern?(auftrag: Record<string, unknown>): void;
    /** Flotten-Update (M9.4): Start (false = läuft bereits) und Status. */
    starteFlottenUpdate?(): boolean;
    flottenStatus?(): unknown;
  };
  /**
   * Zigbee-Mithörer (M16). Ohne Hooks: 501 auf /api/zigbee*.
   *
   * Bewusst eigene Zweige und nicht in `/api/snapshot` hineingemischt: Der
   * Schnappschuss ist die Live-Sicht auf den BidCoS-Empfang, und die wird von
   * der Übersichtsseite im Sekundentakt geholt. Zigbee dort einzuhängen hiesse,
   * jedem Analyzer ohne Stick bei jedem Abruf leere Felder zuzumuten.
   */
  zigbee?: ZigbeeHooks;
  /** Netzwerkeinstellungen (M7.6). Ohne Hooks: 501 auf /api/netzwerk*. */
  netzwerk?: NetzwerkHooks;
  /** Status-LED/OLED (M11): Zustand fürs WebUI, Konfiguration zur Laufzeit,
   *  Blättern der OLED-Seite. Ohne Hooks: 501. */
  statusAnzeige?: {
    zustand(): unknown;
    einstellen(auftrag: Record<string, unknown>): void | Promise<void>;
    seiteWeiter(): void;
  };
  /** Langzeitdaten nach InfluxDB (M9.5): Zustand + Laufzeit-Konfiguration. */
  influx?: {
    zustand(): unknown;
    einstellen(auftrag: Record<string, unknown>): void | Promise<void>;
  };
  /** Langzeitdaten vor Ort (M14): Verbund-Rolle und Installation von
   *  InfluxDB und Grafana. Nur der Master darf installieren — geprüft wird
   *  das im Hook, nicht hier. */
  langzeit?: {
    zustand(): unknown | Promise<unknown>;
    einstellen(auftrag: Record<string, unknown>): void | Promise<void>;
  };
  /** Alarmziele (M14.2): wohin Grafana meldet — ioBroker, E-Mail, Telegram. */
  alarmziel?: {
    zustand(): unknown;
    einstellen(auftrag: Record<string, unknown>): void | Promise<void>;
    /** Schickt eine Testmail und liefert den Klartext für die Oberfläche. */
    testen(auftrag: Record<string, unknown>): Promise<string>;
  };
  /** Protokoll (M13): Stufe und Aufbewahrung einstellen, Dateien herunterladen. */
  protokoll?: {
    zustand(): unknown;
    einstellen(auftrag: Record<string, unknown>): void | Promise<void>;
    /** Inhalt einer Logdatei; null, wenn der Name ungültig ist oder fehlt. */
    datei(name: string): string | null;
  };
  /**
   * Mitschnitt des rohen Sniffer-Stroms (F1) — Grundlinie vor
   * Firmware-Änderungen. Ein- und ausschaltbar im laufenden Betrieb, damit
   * dafür niemand an die Konfigurationsdatei muss.
   */
  /**
   * Verbindungstest zur CCU mit Diagnose.
   *
   * Liegt hier und nicht in der Oberfläche, weil der Analyzer die CCU
   * erreichen können muss — nicht der Browser des Anwenders. Ein Test aus dem
   * Browser heraus beantwortete die falsche Frage.
   */
  ccuTest?: (host: string) => Promise<unknown>;
  mitschnitt?: {
    zustand(): unknown;
    einstellen(auftrag: Record<string, unknown>): void;
    /**
     * Die Aufzeichnung zum Herunterladen.
     *
     * Muss sein: Die Datei liegt auf dem Geraet, ausgewertet wird sie am PC.
     * Ohne diesen Weg braeuchte man scp — also die Konsole, und genau das
     * soll das Projekt niemandem zumuten.
     *
     * Liefert `null`, wenn noch nichts aufgezeichnet wurde.
     */
    datei(): Buffer | null;
  };
}

/**
 * Netzwerk-Mechanik ist Deployment-Sache (nmcli, hostnamectl, Probezeit-
 * Rollback über die systemd-Path-Unit) — der Server kennt nur diese
 * Schnittstelle. Details: docs/netzwerkeinstellungen.md.
 */
export interface NetzwerkHooks {
  /** Ist-Zustand inkl. DHCP-Zuweisungen — reine Anzeige, ohne Root lesbar. */
  zustand(): Promise<unknown>;
  /** Legt den Auftrag ab (Probezeit beginnt); false = einer läuft bereits. */
  anwenden(auftrag: Record<string, unknown>): boolean | Promise<boolean>;
  /** Bestätigt die Probe-Einstellungen als dauerhaft. */
  bestaetigen(): boolean;
  /** Fortschritt/Ergebnis aus der Statusdatei oder null. */
  status(): unknown;
}

/**
 * Die Update-Mechanik ist Sache des Deployments (git, systemd, avrdude) —
 * der Server kennt nur diese Schnittstelle. Alle /api/update/*-Routen
 * verlangen bei gesetztem Token Authentifizierung (Designdok §5); ein
 * `httpupdate` mit freier URL wird bewusst nicht angeboten.
 */
export interface UpdateHooks {
  /** Installierte und verfügbare Version (z. B. Git-Commits). */
  versions(): Promise<unknown>;
  /** Stößt das Core-Update an; false = läuft bereits. */
  startCoreUpdate(): boolean | Promise<boolean>;
  /** Letzter/laufender Update-Status (Statusdatei) oder null. */
  updateStatus(): unknown;
  /**
   * Stoesst den Firmware-Flash an und kehrt **sofort** zurueck.
   *
   * Frueher lief der ganze Vorgang in diesem einen Aufruf. Das hatte zwei
   * Nachteile: Die Oberflaeche konnte bis zum Schluss nichts anzeigen, und
   * als der Dienst am 10.08.2026 beim Anhalten des Ingest haengte, blieb der
   * HTTP-Aufruf stundenlang offen — ohne dass irgendwo sichtbar wurde, woran
   * es lag. Der Verlauf kommt jetzt ueber `flashStand()`.
   *
   * `ok: false` heisst hier nur, dass gar nicht erst begonnen wurde (etwa
   * weil die Datei kein Intel-HEX ist oder schon ein Flash laeuft).
   */
  flashFirmware(hex: Buffer): Promise<{ ok: boolean; log: string }>;
  /** Verlauf und Ausgang des letzten oder laufenden Flashs. */
  flashStand?(): { laeuft: boolean; log: string; ok: boolean | null };
  /** Ergebnis des täglichen Selbstchecks — landet in /api/health und
   *  treibt das Hinweis-Badge der Weboberfläche. */
  updateVerfuegbar?(): boolean;
}

const SET_CONFIG_FELDER = ['ccuip', 'hostname', 'ntp', 'ip', 'netmask', 'gw', 'demo', 'standort'];
const MAX_BODY_BYTES = 65_536;
/**
 * Obergrenze für `/api/telegrams`.
 *
 * Drei Stunden bei 16 Telegrammen je Minute sind rund 2900 — das Diagramm
 * der Übersicht braucht also gut 3000. 5000 lässt Luft für lebhaftere
 * Anlagen und bleibt eine Antwort, die auch ein Pi 3 ohne Nachdenken
 * ausliefert. Greift die Grenze, sagt die Antwort es (`gekuerzt`).
 */
const MAX_TELEGRAMME = 5000;
/** Intel-HEX für 32 KiB Flash ist ~90 KiB — 256 KiB lassen reichlich Luft. */
const MAX_FIRMWARE_BYTES = 262_144;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/** Erste externe IPv4-Schnittstelle — für die Info-Ansicht der App. */
function ersteSchnittstelle(): { ip: string; netmask: string; mac: string } {
  for (const eintraege of Object.values(networkInterfaces())) {
    for (const e of eintraege ?? []) {
      if (!e.internal && e.family === 'IPv4') {
        return { ip: e.address, netmask: e.netmask, mac: e.mac };
      }
    }
  }
  return { ip: '', netmask: '', mac: '' };
}

export class ApiServer {
  readonly #opts: ApiServerOptions;
  readonly #time: TimeSource;
  readonly #config: ApiConfig;
  readonly #server: Server;
  readonly #maxBatch: number;
  #boottime = 0;

  constructor(options: ApiServerOptions) {
    this.#opts = options;
    this.#time = options.time ?? systemTime;
    this.#config = { ...options.config };
    this.#maxBatch = options.maxLogBatch ?? 50;
    this.#server = createServer((req, res) => {
      void this.#verteilen(req, res);
    });
  }

  /** Startet auf `host:port`; `port 0` wählt einen freien (Tests). */
  listen(port: number, host = '127.0.0.1'): Promise<{ host: string; port: number }> {
    this.#boottime = this.#time.now();
    return new Promise((resolve, reject) => {
      this.#server.once('error', reject);
      this.#server.listen(port, host, () => {
        const adr = this.#server.address() as AddressInfo;
        resolve({ host: adr.address, port: adr.port });
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.#server.close((err) => {
        if (err === undefined) resolve();
        else reject(err);
      });
      this.#server.closeAllConnections();
    });
  }

  async #verteilen(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      await this.#route(req, res);
    } catch (err) {
      if (!res.headersSent) {
        this.#text(res, 500, `Interner Fehler: ${String(err)}`);
      } else {
        res.end();
      }
    }
  }

  async #route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://intern');
    const pfad = url.pathname;
    const methode = req.method ?? 'GET';

    // ---- Kompatibilitätssatz: Datenabruf (GET) --------------------------
    if (methode === 'GET') {
      switch (pfad) {
        case '/getLogByLogNumber':
          return this.#getLog(url, res);
        case '/getRSSILog':
          return this.#getRssiLog(url, res);
        case '/getConfig':
          return this.#json(res, 200, this.#configAntwort());
        case '/getAskSinAnalyzerDevListJSON': {
          const json = this.#opts.devList?.json;
          if (json === undefined || json === null) {
            return this.#text(res, 503, 'Geräteliste (noch) nicht verfügbar');
          }
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(json);
          return;
        }
        case '/downloadcsv':
          return this.#tagesCsv(res, dayOf(this.#time.now()));
        case '/download': {
          const datei = url.searchParams.get('filename') ?? '';
          const m = /^(\d{8})\.csv$/.exec(datei);
          if (m === null) {
            return this.#text(res, 400, 'filename muss yyyymmdd.csv sein');
          }
          return this.#tagesCsv(res, m[1]!);
        }
        case '/insertSD':
        case '/ejectSD':
        case '/listSD':
          // SD-Karte gibt es nicht; die App erfährt das über sdcardavailable.
          return this.#text(res, 200, 'OK');
        case '/api/snapshot':
          return this.#json(res, 200, {
            standort: this.#config.standort ?? '',
            ...this.#opts.analyzer.snapshot(this.#time.now()),
          });
        case '/api/health':
          return this.#json(res, 200, this.#health());
        case '/api/telegrams':
          return this.#apiTelegrams(url, res);
        case '/api/noise':
          return this.#apiNoise(url, res);
        case '/api/update/versions': {
          if (!this.#autorisiert(req, res)) return;
          const hooks = this.#opts.update;
          if (hooks === undefined) return this.#text(res, 501, 'Kein Update-Mechanismus');
          return this.#json(res, 200, await hooks.versions());
        }
        case '/api/update/firmware/stand': {
          if (!this.#autorisiert(req, res)) return;
          const stand = this.#opts.update?.flashStand?.();
          if (stand === undefined) {
            return this.#text(res, 501, 'Kein Flash-Stand verfügbar');
          }
          return this.#json(res, 200, stand);
        }
        case '/api/update/status': {
          if (!this.#autorisiert(req, res)) return;
          const hooks = this.#opts.update;
          if (hooks === undefined) return this.#text(res, 501, 'Kein Update-Mechanismus');
          return this.#json(res, 200, hooks.updateStatus() ?? { running: false });
        }
        case '/api/verbund': {
          const verbund = this.#opts.verbund;
          if (verbund === undefined) {
            return this.#text(res, 501, 'Keine Verbund-Rolle konfiguriert');
          }
          return this.#json(res, 200, await verbund.uebersicht());
        }
        case '/api/verbund/zigbee': {
          const hooks = this.#opts.verbund;
          if (hooks?.zigbeeMatrix === undefined) {
            return this.#text(res, 501, 'Keine Zigbee-Matrix');
          }
          const stunden = zahlAusUrl(url, 'stunden', 24, 1, 24 * 90);
          try {
            return this.#json(res, 200, await hooks.zigbeeMatrix(stunden));
          } catch (err) {
            // 501 und nicht 500: „gibt es hier nicht" ist kein Fehler, sondern
            // ein Zustand — und die Oberflaeche behandelt 501 bereits als
            // „diese Ansicht ist auf diesem Geraet nicht eingerichtet".
            return this.#text(res, 501,
              err instanceof Error ? err.message : String(err));
          }
        }
        case '/api/verbund/matrix': {
          const verbund = this.#opts.verbund;
          if (verbund?.matrix === undefined) {
            return this.#text(res, 501, 'Keine Verbund-Rolle konfiguriert');
          }
          return this.#json(res, 200, await verbund.matrix());
        }
        case '/api/verbund/matrix.csv': {
          const verbund = this.#opts.verbund;
          if (verbund?.matrixCsv === undefined) {
            return this.#text(res, 501, 'Keine Verbund-Rolle konfiguriert');
          }
          res.writeHead(200, {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': 'attachment; filename="empfangsmatrix.csv"',
          });
          res.end(await verbund.matrixCsv());
          return;
        }
        case '/api/verbund/telegramme': {
          const verbund = this.#opts.verbund;
          if (verbund?.telegramme === undefined) {
            return this.#text(res, 501, 'Keine Verbund-Rolle konfiguriert');
          }
          return this.#json(res, 200, await verbund.telegramme());
        }
        case '/api/verbund/peers': {
          const verbund = this.#opts.verbund;
          if (verbund?.peers === undefined) {
            return this.#text(res, 501, 'Keine Peer-Verwaltung');
          }
          return this.#json(res, 200, verbund.peers());
        }
        case '/api/verbund/flottenupdate': {
          const verbund = this.#opts.verbund;
          if (verbund?.flottenStatus === undefined) {
            return this.#text(res, 501, 'Kein Flotten-Update');
          }
          return this.#json(res, 200, verbund.flottenStatus() ?? { running: false });
        }
        case '/api/netzwerk': {
          const netz = this.#opts.netzwerk;
          if (netz === undefined) return this.#text(res, 501, 'Keine Netzwerk-Verwaltung');
          return this.#json(res, 200, await netz.zustand());
        }
        case '/api/statusanzeige': {
          const hooks = this.#opts.statusAnzeige;
          if (hooks === undefined) return this.#text(res, 501, 'Keine Statusanzeige');
          return this.#json(res, 200, hooks.zustand());
        }
        case '/api/zigbee': {
          const hooks = this.#opts.zigbee;
          if (hooks === undefined) return this.#text(res, 501, 'Kein Zigbee-Mithörer');
          return this.#json(res, 200, hooks.zustand());
        }
        case '/api/zigbee/geraete': {
          const hooks = this.#opts.zigbee;
          if (hooks === undefined || !hooks.aktiv()) {
            return this.#text(res, 501, 'Kein Zigbee-Mithörer');
          }
          const stunden = zahlAusUrl(url, 'stunden', 24, 1, 24 * 90);
          return this.#json(res, 200, {
            stunden,
            geraete: hooks.geraete(stunden),
            nieGehoert: hooks.nieGehoert(stunden),
          });
        }
        case '/api/zigbee/firmware': {
          // Ohne Aktiv-Prüfung, anders als die beiden Zweige daneben: Der
          // Sinn dieser Auskunft ist gerade der Analyzer, auf dem Zigbee noch
          // NICHT läuft, weil die Firmware auf dem Stick fehlt.
          const hooks = this.#opts.zigbee;
          if (hooks === undefined) return this.#text(res, 501, 'Kein Zigbee-Mithörer');
          return this.#json(res, 200, await hooks.firmwareStand());
        }
        case '/api/zigbee/pakete': {
          const hooks = this.#opts.zigbee;
          if (hooks === undefined || !hooks.aktiv()) {
            return this.#text(res, 501, 'Kein Zigbee-Mithörer');
          }
          const minuten = zahlAusUrl(url, 'minuten', 10, 1, 60 * 24);
          const grenze = zahlAusUrl(url, 'max', 500, 1, MAX_ZIGBEE_PAKETE);
          return this.#json(res, 200, { minuten, ...hooks.pakete(minuten, grenze) });
        }
        case '/api/influx': {
          // Mit Token geschuetzt wie /api/alarmziel: Hier steht der
          // Influx-Zugangstoken drin. Er wird bewusst zurueckgegeben, damit er
          // in der Oberflaeche nachschlagbar ist — dann muss der Zugriff
          // darauf aber geschuetzt sein.
          if (!this.#autorisiert(req, res)) return;
          const hooks = this.#opts.influx;
          if (hooks === undefined) return this.#text(res, 501, 'Keine Influx-Anbindung');
          return this.#json(res, 200, hooks.zustand());
        }
        case '/api/langzeitdaten': {
          const hooks = this.#opts.langzeit;
          if (hooks === undefined) return this.#text(res, 501, 'Keine Langzeitdaten');
          return this.#json(res, 200, await hooks.zustand());
        }
        case '/api/alarmziel': {
          // Als einzige Leseroute mit Token geschuetzt: Hier stehen das
          // SMTP-Passwort und der Bot-Token drin. Sie werden bewusst
          // zurueckgegeben, damit man sie in der Oberflaeche nachsehen kann —
          // dann muss aber auch der Zugriff darauf geschuetzt sein.
          if (!this.#autorisiert(req, res)) return;
          const hooks = this.#opts.alarmziel;
          if (hooks === undefined) return this.#text(res, 501, 'Keine Alarmziele');
          return this.#json(res, 200, hooks.zustand());
        }
        case '/api/protokoll': {
          const hooks = this.#opts.protokoll;
          if (hooks === undefined) return this.#text(res, 501, 'Kein Protokoll');
          return this.#json(res, 200, hooks.zustand());
        }
        case '/api/mitschnitt': {
          const hooks = this.#opts.mitschnitt;
          if (hooks === undefined) return this.#text(res, 501, 'Kein Mitschnitt');
          return this.#json(res, 200, hooks.zustand());
        }
        case '/api/netzwerk/status': {
          const netz = this.#opts.netzwerk;
          if (netz === undefined) return this.#text(res, 501, 'Keine Netzwerk-Verwaltung');
          return this.#json(res, 200, netz.status() ?? { running: false });
        }
      }
      // Mitschnitt herunterladen. Wie beim Protokoll ohne Token, weil der
      // Browser bei einem einfachen Link keine Kopfzeile mitschicken kann —
      // und weil dieselben Telegramme ohnehin ueber /api/telegrams zu haben
      // sind. Wer das Geraet ins offene Netz haengt, sichert es ueber die
      // Netzwerkeinstellungen ab, nicht ueber einzelne Endpunkte.
      if (pfad === '/api/mitschnitt/datei') {
        const hooks = this.#opts.mitschnitt;
        if (hooks === undefined) return this.#text(res, 501, 'Kein Mitschnitt');
        const inhalt = hooks.datei();
        if (inhalt === null) {
          return this.#text(res, 404, 'Noch nichts aufgezeichnet');
        }
        res.writeHead(200, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Disposition': 'attachment; filename="mitschnitt.txt"',
          'Content-Length': String(inhalt.byteLength),
        });
        res.end(inhalt);
        return;
      }
      // Logdatei herunterladen: /api/protokoll/datei/asksin-JJJJ-MM-TT.log
      if (pfad.startsWith('/api/protokoll/datei/')) {
        const hooks = this.#opts.protokoll;
        if (hooks === undefined) return this.#text(res, 501, 'Kein Protokoll');
        const name = decodeURIComponent(pfad.slice('/api/protokoll/datei/'.length));
        const inhalt = hooks.datei(name);
        if (inhalt === null) return this.#text(res, 404, 'Keine solche Logdatei');
        res.writeHead(200, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Disposition': `attachment; filename="${name}"`,
        });
        res.end(inhalt);
        return;
      }
      // Handbücher — eigene Pfade, damit sie ohne Internet erreichbar sind.
      const buch = this.#opts.handbuecher?.[pfad];
      if (buch !== undefined) {
        const datei = this.#leseDatei(buch.datei);
        if (datei === null) {
          return this.#text(
            res,
            404,
            `Handbuch nicht gefunden (${buch.name}). Es liegt im Projekt unter ` +
              `${buch.datei} und steht auch bei jedem Release auf GitHub bereit.`,
          );
        }
        res.writeHead(200, {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `inline; filename="${buch.name}"`,
          'Cache-Control': 'no-cache',
        });
        res.end(datei);
        return;
      }
      // Alles Übrige: das gebaute Web-UI (mit SPA-Fallback).
      if (this.#opts.uiDir !== undefined && !pfad.startsWith('/api/')) {
        return this.#statisch(pfad, res);
      }
    }

    // ---- Kompatibilitätssatz: Kommandos (POST, ggf. mit Auth) -----------
    if (methode === 'POST') {
      switch (pfad) {
        case '/api/update/core': {
          if (!this.#autorisiert(req, res)) return;
          const hooks = this.#opts.update;
          if (hooks === undefined) return this.#text(res, 501, 'Kein Update-Mechanismus');
          const gestartet = await hooks.startCoreUpdate();
          if (!gestartet) return this.#text(res, 409, 'Update läuft bereits');
          res.writeHead(202, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Update angestoßen — Fortschritt unter /api/update/status');
          return;
        }
        case '/api/netzwerk': {
          if (!this.#autorisiert(req, res)) return;
          const netz = this.#opts.netzwerk;
          if (netz === undefined) return this.#text(res, 501, 'Keine Netzwerk-Verwaltung');
          let auftrag: Record<string, unknown>;
          try {
            auftrag = JSON.parse(await this.#leseBody(req)) as Record<string, unknown>;
          } catch {
            return this.#text(res, 400, 'Body muss JSON sein');
          }
          const angenommen = await netz.anwenden(auftrag);
          if (!angenommen) return this.#text(res, 409, 'Ein Netzwerk-Auftrag läuft bereits');
          res.writeHead(202, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Auftrag angenommen — Probezeit läuft, Status unter /api/netzwerk/status');
          return;
        }
        case '/api/zigbee/firmware': {
          if (!this.#autorisiert(req, res)) return;
          const hooks = this.#opts.zigbee;
          if (hooks === undefined) return this.#text(res, 501, 'Kein Zigbee-Mithörer');
          try {
            hooks.firmwareAufspielen();
          } catch (err) {
            // 409 und nicht 400: Der Auftrag ist in Ordnung, nur der
            // Zeitpunkt nicht — es läuft bereits einer.
            return this.#text(res, 409, err instanceof Error ? err.message : String(err));
          }
          return this.#json(res, 202, {
            angestossen: true,
            meldung: 'Das Aufspielen läuft. Der Analyzer-Dienst startet dabei einmal neu.',
          });
        }
        case '/api/zigbee/schluessel': {
          if (!this.#autorisiert(req, res)) return;
          const hooks = this.#opts.zigbee;
          if (hooks === undefined) return this.#text(res, 501, 'Kein Zigbee-Mithörer');
          let auftrag: Record<string, unknown> = {};
          try {
            const roh = await this.#leseBody(req);
            if (roh.trim() !== '') auftrag = JSON.parse(roh) as Record<string, unknown>;
          } catch {
            return this.#text(res, 400, 'Ungültiges JSON');
          }
          const host = typeof auftrag['host'] === 'string' ? auftrag['host'] : '';
          return this.#json(res, 200, await hooks.schluesselAnfordern(host));
        }
        case '/api/zigbee': {
          if (!this.#autorisiert(req, res)) return;
          const hooks = this.#opts.zigbee;
          if (hooks === undefined) return this.#text(res, 501, 'Kein Zigbee-Mithörer');
          let auftrag: Record<string, unknown>;
          try {
            auftrag = JSON.parse(await this.#leseBody(req)) as Record<string, unknown>;
          } catch {
            return this.#text(res, 400, 'Ungültiges JSON');
          }
          try {
            return this.#json(res, 200, await hooks.setzen(auftrag));
          } catch (err) {
            return this.#text(res, 400, err instanceof Error ? err.message : String(err));
          }
        }
        case '/api/statusanzeige': {
          if (!this.#autorisiert(req, res)) return;
          const hooks = this.#opts.statusAnzeige;
          if (hooks === undefined) return this.#text(res, 501, 'Keine Statusanzeige');
          let auftrag: Record<string, unknown>;
          try {
            auftrag = JSON.parse(await this.#leseBody(req)) as Record<string, unknown>;
          } catch {
            return this.#text(res, 400, 'Body muss JSON sein');
          }
          await hooks.einstellen(auftrag);
          return this.#text(res, 200, 'OK — sofort wirksam');
        }
        case '/api/protokoll': {
          if (!this.#autorisiert(req, res)) return;
          const hooks = this.#opts.protokoll;
          if (hooks === undefined) return this.#text(res, 501, 'Kein Protokoll');
          let auftrag: Record<string, unknown>;
          try {
            auftrag = JSON.parse(await this.#leseBody(req)) as Record<string, unknown>;
          } catch {
            return this.#text(res, 400, 'Body muss JSON sein');
          }
          // Ungültige Werte sind Eingabefehler des Aufrufers, kein Serverfehler:
          try {
            await hooks.einstellen(auftrag);
          } catch (err) {
            return this.#text(res, 400, err instanceof Error ? err.message : String(err));
          }
          return this.#text(res, 200, 'OK — sofort wirksam');
        }
        case '/api/ccu/test': {
          // Ohne Token: Der Test verändert nichts, er liest nur. Wer ihn
          // sperrte, zwänge zum Blindflug bei der Einrichtung — und genau
          // dort wird er gebraucht.
          const pruefen = this.#opts.ccuTest;
          if (pruefen === undefined) return this.#text(res, 501, 'Kein CCU-Test');
          let auftrag: Record<string, unknown> = {};
          try {
            auftrag = JSON.parse(await this.#leseBody(req)) as Record<string, unknown>;
          } catch {
            /* leerer Body ist erlaubt — dann gilt die gespeicherte Adresse */
          }
          const host =
            typeof auftrag['host'] === 'string' ? auftrag['host'] : (this.#config.ccuip ?? '');
          return this.#json(res, 200, await pruefen(host));
        }
        case '/api/mitschnitt': {
          if (!this.#autorisiert(req, res)) return;
          const hooks = this.#opts.mitschnitt;
          if (hooks === undefined) return this.#text(res, 501, 'Kein Mitschnitt');
          let auftrag: Record<string, unknown>;
          try {
            auftrag = JSON.parse(await this.#leseBody(req)) as Record<string, unknown>;
          } catch {
            return this.#text(res, 400, 'Body muss JSON sein');
          }
          try {
            hooks.einstellen(auftrag);
          } catch (err) {
            return this.#text(res, 400, err instanceof Error ? err.message : String(err));
          }
          return this.#json(res, 200, hooks.zustand());
        }
        case '/api/influx': {
          if (!this.#autorisiert(req, res)) return;
          const hooks = this.#opts.influx;
          if (hooks === undefined) return this.#text(res, 501, 'Keine Influx-Anbindung');
          let auftrag: Record<string, unknown>;
          try {
            auftrag = JSON.parse(await this.#leseBody(req)) as Record<string, unknown>;
          } catch {
            return this.#text(res, 400, 'Body muss JSON sein');
          }
          await hooks.einstellen(auftrag);
          return this.#text(res, 200, 'OK — sofort wirksam');
        }
        case '/api/alarmziel/test': {
          if (!this.#autorisiert(req, res)) return;
          const hooks = this.#opts.alarmziel;
          if (hooks === undefined) return this.#text(res, 501, 'Keine Alarmziele');
          let auftrag: Record<string, unknown> = {};
          try {
            auftrag = JSON.parse(await this.#leseBody(req)) as Record<string, unknown>;
          } catch {
            /* leerer Body = gespeicherte Werte nehmen */
          }
          try {
            return this.#text(res, 200, await hooks.testen(auftrag));
          } catch (e) {
            // 400 statt 500: Ein abgewiesener Versand ist kein Serverfehler,
            // sondern eine Auskunft ueber die Eingabe — und "Interner Fehler"
            // davorzuschreiben verdeckt sie nur.
            return this.#text(res, 400, e instanceof Error ? e.message : String(e));
          }
        }
        case '/api/alarmziel':
        case '/api/langzeitdaten': {
          if (!this.#autorisiert(req, res)) return;
          const hooks =
            pfad === '/api/alarmziel' ? this.#opts.alarmziel : this.#opts.langzeit;
          if (hooks === undefined) return this.#text(res, 501, 'Nicht verfügbar');
          let auftrag: Record<string, unknown>;
          try {
            auftrag = JSON.parse(await this.#leseBody(req)) as Record<string, unknown>;
          } catch {
            return this.#text(res, 400, 'Body muss JSON sein');
          }
          await hooks.einstellen(auftrag);
          return this.#text(res, 200, 'OK');
        }
        case '/api/statusanzeige/seite': {
          const hooks = this.#opts.statusAnzeige;
          if (hooks === undefined) return this.#text(res, 501, 'Keine Statusanzeige');
          hooks.seiteWeiter();
          return this.#text(res, 200, 'OK');
        }
        case '/api/verbund/flottenupdate': {
          if (!this.#autorisiert(req, res)) return;
          const verbund = this.#opts.verbund;
          if (verbund?.starteFlottenUpdate === undefined) {
            return this.#text(res, 501, 'Kein Flotten-Update');
          }
          if (!verbund.starteFlottenUpdate()) {
            return this.#text(res, 409, 'Flotten-Update läuft bereits');
          }
          res.writeHead(202, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Flotten-Update gestartet — Status unter /api/verbund/flottenupdate');
          return;
        }
        case '/api/verbund/peers': {
          if (!this.#autorisiert(req, res)) return;
          const verbund = this.#opts.verbund;
          if (verbund?.peersAendern === undefined) {
            return this.#text(res, 501, 'Keine Peer-Verwaltung');
          }
          let auftrag: Record<string, unknown>;
          try {
            auftrag = JSON.parse(await this.#leseBody(req)) as Record<string, unknown>;
          } catch {
            return this.#text(res, 400, 'Body muss JSON sein');
          }
          verbund.peersAendern(auftrag);
          return this.#text(res, 200, 'OK');
        }
        case '/api/netzwerk/bestaetigen': {
          if (!this.#autorisiert(req, res)) return;
          const netz = this.#opts.netzwerk;
          if (netz === undefined) return this.#text(res, 501, 'Keine Netzwerk-Verwaltung');
          netz.bestaetigen();
          return this.#text(res, 200, 'OK — Einstellungen werden dauerhaft übernommen');
        }
        case '/api/update/firmware': {
          if (!this.#autorisiert(req, res)) return;
          const hooks = this.#opts.update;
          if (hooks === undefined) return this.#text(res, 501, 'Kein Update-Mechanismus');
          const hex = await this.#leseBodyRoh(req, MAX_FIRMWARE_BYTES);
          if (hex === null) return this.#text(res, 413, 'Firmware-Datei zu groß');
          // Startet nur; der Verlauf kommt über /api/update/firmware/stand.
          const ergebnis = await hooks.flashFirmware(hex);
          return this.#json(res, ergebnis.ok ? 202 : 400, ergebnis);
        }
        case '/setConfig':
          if (!this.#autorisiert(req, res)) return;
          return this.#setConfig(req, url, res);
        case '/reboot':
          if (!this.#autorisiert(req, res)) return;
          if (this.#opts.onReboot === undefined) {
            return this.#text(res, 501, 'Kein Neustart-Mechanismus konfiguriert');
          }
          this.#text(res, 200, 'OK');
          setImmediate(this.#opts.onReboot);
          return;
        case '/rebootInConfigMode':
          // WLAN-Config-Portal des ESP — auf dem Pi sinnlos.
          return this.#text(res, 501, 'Auf dem Raspberry Pi nicht vorhanden');
        case '/formatspiffs': {
          if (!this.#autorisiert(req, res)) return;
          const db = this.#opts.db;
          db.exec('DELETE FROM telegrams');
          db.exec('DELETE FROM noise_minutes');
          db.exec('DELETE FROM device_hours');
          db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
          return this.#text(res, 200, 'OK');
        }
        case '/deletecsv': {
          if (!this.#autorisiert(req, res)) return;
          const { fromTs, toTs } = dayRange(dayOf(this.#time.now()));
          this.#opts.db
            .prepare('DELETE FROM telegrams WHERE ts >= ? AND ts < ?')
            .run(fromTs, toTs);
          return this.#text(res, 200, 'OK');
        }
      }
    }

    this.#text(res, 404, `Unbekannter Endpunkt: ${methode} ${pfad}`);
  }

  // ---- Datenabruf ------------------------------------------------------

  #getLog(url: URL, res: ServerResponse): void {
    const lognum = Number(url.searchParams.get('lognum') ?? 0) || 0;
    const rows = this.#opts.db
      .prepare(
        `SELECT rowid AS lognumber, ts, rssi, len, cnt, flags, type, from_addr, to_addr
         FROM telegrams WHERE rowid > ? ORDER BY rowid LIMIT ?`,
      )
      .all(lognum, this.#maxBatch) as unknown as TelegramRow[];
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8' });
    res.end(rows.map(toCsvLine).join('\n'));
  }

  #getRssiLog(url: URL, res: ServerResponse): void {
    const roh = url.searchParams.get('fromTstamp');
    // Ohne Angabe: letzte 24 h — sonst wären es bei 90 Tagen Retention
    // 130 000 Einträge in einer Antwort.
    const fromSec =
      roh === null || Number.isNaN(Number(roh))
        ? Math.floor(this.#time.now() / 1000) - 86_400
        : Number(roh);
    const rows = this.#opts.db
      .prepare(
        `SELECT minute, samples, sum_rssi FROM noise_minutes
         WHERE minute >= ? ORDER BY minute`,
      )
      .all(Math.ceil(fromSec / 60)) as unknown as NoiseMinuteRow[];
    this.#json(res, 200, rows.map(toRssiLogEntry));
  }

  /**
   * JSON-Telegramme für den UI-Nachbau: mit aufgelösten Namen, Klarnamen der
   * Flags/Typen und `id` (rowid) für inkrementelles Nachladen. Ohne `afterId`
   * kommen die neuesten `limit` Zeilen, mit `afterId` alles Neuere daran.
   */
  #apiTelegrams(url: URL, res: ServerResponse): void {
    const afterRoh = url.searchParams.get('afterId');
    // Fehlender Parameter ≠ afterId=0: ohne Parameter die neuesten Zeilen,
    // mit afterId=0 ausdrücklich von ganz vorn.
    const afterId = afterRoh === null ? null : Math.max(0, Number(afterRoh) || 0);
    const limit = Math.min(
      MAX_TELEGRAMME,
      Math.max(1, Number(url.searchParams.get('limit') ?? 200) || 200),
    );
    // Zeitfenster, wahlweise. Ohne Angabe gilt weiter „die neuesten n".
    //
    // Das Diagramm der Uebersicht zeigt zwei Reihen nebeneinander: das
    // Grundrauschen nach ZEIT (minutes=180) und die Telegramme — bis
    // 0.16.0 — nach ANZAHL. Bei 16 Telegrammen je Minute waren 500 Stueck
    // genau 31 Minuten, waehrend die Unterschrift drei Stunden versprach.
    // Am 14.08.2026 gefragt: „wieso haben beide Analyzer nur ab ca 8:00 Uhr
    // Telegramme in der Uebersicht?" — sie hatten mehr, es wurden nur nie
    // mehr geholt.
    const minutenRoh = url.searchParams.get('minutes');
    const abTs =
      minutenRoh === null
        ? null
        : this.#time.now() -
          Math.min(100_000, Math.max(1, Number(minutenRoh) || 180)) * 60_000;

    const db = this.#opts.db;
    const felder =
      'rowid AS id, ts, rssi, len, cnt, flags, type, from_addr, to_addr, payload';
    const rows = (
      afterId !== null
        ? db
            .prepare(
              `SELECT ${felder} FROM telegrams WHERE rowid > ?${
                abTs === null ? '' : ' AND ts >= ?'
              } ORDER BY rowid LIMIT ?`,
            )
            .all(...(abTs === null ? [afterId, limit] : [afterId, abTs, limit]))
        : db
            .prepare(
              `SELECT ${felder} FROM telegrams${
                abTs === null ? '' : ' WHERE ts >= ?'
              } ORDER BY rowid DESC LIMIT ?`,
            )
            .all(...(abTs === null ? [limit] : [abTs, limit]))
            .reverse()
    ) as unknown as Array<{
      id: number;
      ts: number;
      rssi: number;
      len: number;
      cnt: number;
      flags: number;
      type: number;
      from_addr: number;
      to_addr: number;
      payload: string;
    }>;
    const nameOf = (addr: number): string =>
      this.#opts.devList?.nameOf(addr) ??
      addr.toString(16).toUpperCase().padStart(6, '0');
    const hex6 = (addr: number): string =>
      addr.toString(16).toUpperCase().padStart(6, '0');
    /**
     * Adresse, die die Zentrale nicht kennt — also kein eigenes Gerät.
     *
     * Ohne Geräteliste bleibt alles `false`: Dann ist nichts als fremd
     * belegbar. Ein Verdacht ohne Grundlage waere schlimmer als keine
     * Kennzeichnung, weil man ihm glaubt.
     */
    const fremd = (addr: number): boolean =>
      this.#opts.devList !== undefined && !this.#opts.devList.kennt(addr);
    const telegrams = rows.map((r) => ({
      id: r.id,
      ts: r.ts,
      rssi: r.rssi,
      len: r.len,
      cnt: r.cnt,
      flags: r.flags,
      flagNames: decodeFlags(r.flags),
      type: r.type,
      typeName: decodeMsgType(r.type),
      isHmIp: isHmIpType(r.type),
      fromAddr: r.from_addr,
      fromHex: hex6(r.from_addr),
      fromName: nameOf(r.from_addr),
      fromFremd: fremd(r.from_addr),
      toAddr: r.to_addr,
      toHex: hex6(r.to_addr),
      toName: nameOf(r.to_addr),
      toFremd: fremd(r.to_addr),
      payload: r.payload,
    }));
    this.#json(res, 200, {
      telegrams,
      lastId: telegrams.at(-1)?.id ?? afterId ?? 0,
      // Sagen, wenn die Obergrenze gegriffen hat. Sonst sieht ein gekuerztes
      // Fenster genauso aus wie ein leeres Funkband — und genau diese
      // Verwechslung war der Anlass.
      gekuerzt: telegrams.length >= limit,
    });
  }

  /** Grundrauschen als Minutenaggregat für den Zeitchart der eigenen UI. */
  #apiNoise(url: URL, res: ServerResponse): void {
    const minuten = Math.min(
      100_000,
      Math.max(1, Number(url.searchParams.get('minutes') ?? 180) || 180),
    );
    const ab = Math.floor(this.#time.now() / 60_000) - minuten;
    const rows = this.#opts.db
      .prepare(
        `SELECT minute, samples, min_rssi, max_rssi, sum_rssi
         FROM noise_minutes WHERE minute >= ? ORDER BY minute`,
      )
      .all(ab) as unknown as Array<{
      minute: number;
      samples: number;
      min_rssi: number;
      max_rssi: number;
      sum_rssi: number;
    }>;
    this.#json(res, 200, {
      noise: rows.map((r) => ({
        minute: r.minute,
        ts: r.minute * 60_000,
        samples: r.samples,
        min: r.min_rssi,
        max: r.max_rssi,
        avg: Math.round((r.sum_rssi / r.samples) * 10) / 10,
      })),
    });
  }

  #tagesCsv(res: ServerResponse, yyyymmdd: string): void {
    const { fromTs, toTs } = dayRange(yyyymmdd);
    const rows = this.#opts.db
      .prepare(
        `SELECT rowid AS lognumber, ts, rssi, len, cnt, flags, type, from_addr, to_addr
         FROM telegrams WHERE ts >= ? AND ts < ? ORDER BY rowid`,
      )
      .all(fromTs, toTs) as unknown as TelegramRow[];
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${yyyymmdd}.csv"`,
    });
    res.end(rows.map(toCsvLine).join('\n'));
  }

  // ---- Konfiguration ---------------------------------------------------

  /** Alle Felder, die die App auswertet (§2.3) — SD/SPIFFS sinnvoll umgedeutet. */
  #configAntwort(): Record<string, unknown> {
    const { upper, lower } = toVersionParts(this.#opts.version ?? '0.0.1');
    const netz = ersteSchnittstelle();
    const seite = this.#opts.db.prepare('PRAGMA page_size').get() as {
      page_size: number;
    };
    const anzahl = this.#opts.db.prepare('PRAGMA page_count').get() as {
      page_count: number;
    };
    const dbKb = Math.ceil((seite.page_size * anzahl.page_count) / 1024);
    return {
      version_upper: upper,
      version_lower: lower,
      display: 0,
      ccuip: this.#config.ccuip ?? '',
      hostname: hostname(),
      ntp: this.#config.ntp ?? '',
      ip: netz.ip,
      netmask: netz.netmask,
      gw: '',
      macaddress: netz.mac,
      resolve: this.#opts.devList === undefined ? 0 : 1,
      boottime: Math.floor(this.#boottime / 1000),
      rssi_hbw: 0,
      rssi_alarmcount: this.#config.rssiAlarmCount ?? 0,
      rssi_alarmthreshold: this.#config.rssiAlarmThreshold ?? 0,
      sdcardavailable: 0,
      sdcardsizemb: 0,
      sdcardtotalspacemb: 0,
      sdcardusedspacemb: 0,
      // SPIFFS des ESP ≙ unserer SQLite-Datei — die Info-Ansicht zeigt damit
      // die tatsächliche Datenbankgröße.
      spiffssizekb: dbKb,
      spiffsusedkb: dbKb,
      staticipconfig: 0,
      ccuhttps: 0,
      backend: 0,
      backendurl: '',
      demo: this.#config.demo === true ? 1 : 0,
      standort: this.#config.standort ?? '',
    };
  }

  async #setConfig(
    req: IncomingMessage,
    url: URL,
    res: ServerResponse,
  ): Promise<void> {
    const body = await this.#leseBody(req);
    const bodyParams = new URLSearchParams(body);
    const änderungen: Record<string, string> = {};
    for (const feld of SET_CONFIG_FELDER) {
      const wert = bodyParams.get(feld) ?? url.searchParams.get(feld);
      if (wert !== null) änderungen[feld] = wert;
    }
    // Direkt wirksam wird nur, was der Core selbst verantwortet; Netzwerk
    // und Hostname des Pi setzt — wenn gewünscht — der onSetConfig-Empfänger.
    if (änderungen['ccuip'] !== undefined) this.#config.ccuip = änderungen['ccuip'];
    if (änderungen['ntp'] !== undefined) this.#config.ntp = änderungen['ntp'];
    if (änderungen['standort'] !== undefined) {
      this.#config.standort = änderungen['standort'].trim();
    }
    this.#opts.onSetConfig?.(änderungen);
    this.#text(res, 200, 'OK');
  }

  // ---- Eigene API ------------------------------------------------------

  #health(): Record<string, unknown> {
    const now = this.#time.now();
    const s = this.#opts.analyzer.snapshot(now);
    return {
      ok: true,
      version: this.#opts.version ?? '0.0.1',
      now,
      boottime: this.#boottime,
      connected: s.ingest.connected,
      telegrams: s.ingest.telegrams,
      droppedLines: s.ingest.droppedLines,
      persistErrors: s.persistErrors,
      devListSource: s.devList?.source ?? null,
      demo: this.#config.demo === true,
      updateVerfuegbar: this.#opts.update?.updateVerfuegbar?.() ?? false,
      standort: this.#config.standort ?? '',
      // Sniffer-Firmware: Fassung, Selbsttest und Lueckenerkennung. Steht
      // im Health-Endpunkt, weil es zur Betriebsbereitschaft gehoert — ein
      // stummes Funkmodul ist kein Detail fuer eine Unterseite.
      sniffer: {
        erweitert: s.ingest.erweitert,
        firmware: s.ingest.firmware,
        befund: baueFirmwarebefund(
          s.ingest.firmware,
          this.#opts.version ?? '0.0.1',
          { gefragtAm: s.ingest.firmwareGefragtAm, jetzt: now },
        ),
        folge: s.ingest.folge,
      },
      // Zwei Ja/Nein, und sie bedeuten Verschiedenes.
      //
      // `zigbee` heisst „eingeschaltet" — daran haengen die Menuepunkte.
      // `zigbeeVerbunden` heisst „der Stick antwortet auch" — das ist die
      // Anzeige in der Kopfzeile, das Gegenstueck zu `connected` beim
      // BidCoS-Sniffer. Eingeschaltet und stumm ist genau der Fall, den man
      // sehen will; eine einzige Angabe koennte ihn nicht ausdruecken.
      zigbee: this.#opts.zigbee !== undefined
        && this.#opts.zigbee.zustand()['aktiv'] === true,
      zigbeeVerbunden: this.#opts.zigbee !== undefined
        && this.#opts.zigbee.zustand()['verbunden'] === true,
      empfang: this.#empfang(s),
      rolle: this.#opts.rolle?.() ?? 'master',
    };
  }

  /**
   * Empfangsbalken für beide Funknetze — die Zahlen dahinter und die Stufe.
   *
   * Beides steht hier, nicht nur die Stufe: Die Balken sind die Anzeige, die
   * dB und der LQI die Begründung. Wer wissen will, warum vier statt fünf,
   * findet es im Tooltip, ohne die Seite zu wechseln.
   *
   * Für BidCoS wird der **Störabstand** gebildet und nicht der blosse Pegel:
   * Der Versatz, mit dem die Firmware den Rohwert des CC1101 in dBm
   * umrechnet, ist ein typischer Wert des Datenblatts und kein für dieses
   * Bauteil gemessener. In der Differenz zum Grundrauschen — vom selben
   * Modul gemessen — kürzt er sich weg.
   */
  #empfang(s: ReturnType<Analyzer['snapshot']>): Record<string, unknown> {
    // Median über die GERÄTE, nicht über die Telegramme: Sonst bestimmte ein
    // gesprächiges Gerät allein die Anzeige.
    const pegel = median(
      s.devices
        .map((g) => g.rssi.ewma)
        .filter((r): r is number => r !== null && Number.isFinite(r)),
    );
    const rauschen = s.noiseFloor.ewma;
    const abstand = pegel !== null && rauschen !== null ? Math.round(pegel - rauschen) : null;

    const zigbeeLqi = this.#opts.zigbeeGuete?.() ?? null;
    return {
      bidcos: {
        rssiMedian: pegel === null ? null : Math.round(pegel),
        rauschen: rauschen === null ? null : Math.round(rauschen),
        stoerabstand: abstand,
        balken: balkenAusStoerabstand(abstand),
      },
      zigbee: {
        lqiMedian: zigbeeLqi === null ? null : Math.round(zigbeeLqi),
        balken: balkenAusLqi(zigbeeLqi),
      },
    };
  }

  // ---- statisches Web-UI ----------------------------------------------

  /**
   * Liefert Dateien aus `uiDir`; unbekannte Pfade ohne Dateiendung fallen auf
   * `index.html` zurück (SPA-Routing). Pfade außerhalb der Wurzel sind tabu.
   */
  #statisch(pfad: string, res: ServerResponse): void {
    const wurzel = resolve(this.#opts.uiDir!);
    let dekodiert: string;
    try {
      dekodiert = decodeURIComponent(pfad);
    } catch {
      return this.#text(res, 400, 'Kaputte URL-Kodierung');
    }
    const ziel = normalize(join(wurzel, dekodiert === '/' ? 'index.html' : dekodiert.slice(1)));
    if (ziel !== wurzel && !ziel.startsWith(wurzel + sep)) {
      return this.#text(res, 404, 'Nicht gefunden');
    }
    const datei = this.#leseDatei(ziel);
    if (datei !== null) {
      // Vite-Assets tragen einen Inhalts-Hash im Namen → dauerhaft cachebar.
      const cache = dekodiert.startsWith('/assets/')
        ? 'public, max-age=31536000, immutable'
        : 'no-cache';
      res.writeHead(200, {
        'Content-Type': MIME[extname(ziel)] ?? 'application/octet-stream',
        'Cache-Control': cache,
      });
      res.end(datei);
      return;
    }
    if (extname(dekodiert) === '') {
      const index = this.#leseDatei(join(wurzel, 'index.html'));
      if (index !== null) {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-cache',
        });
        res.end(index);
        return;
      }
    }
    this.#text(res, 404, 'Nicht gefunden');
  }

  #leseDatei(pfad: string): Buffer | null {
    try {
      return readFileSync(pfad);
    } catch {
      return null;
    }
  }

  // ---- Hilfen ----------------------------------------------------------

  /** true = weitermachen; false = 401 ist bereits gesendet. */
  #autorisiert(req: IncomingMessage, res: ServerResponse): boolean {
    const token = this.#opts.authToken;
    if (token === undefined) return true;
    if (req.headers.authorization === `Bearer ${token}`) return true;
    res.writeHead(401, { 'WWW-Authenticate': 'Bearer' });
    res.end('Auth-Token erforderlich');
    return false;
  }

  /** Binären Body lesen; null bei Überschreitung des Limits (→ 413). */
  #leseBodyRoh(req: IncomingMessage, limit: number): Promise<Buffer | null> {
    return new Promise((resolve, reject) => {
      const teile: Buffer[] = [];
      let bytes = 0;
      let zuGross = false;
      req.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > limit) {
          zuGross = true;
          req.resume();                        // Rest verwerfen, aber lesen
          return;
        }
        teile.push(chunk);
      });
      req.on('end', () => resolve(zuGross ? null : Buffer.concat(teile)));
      req.on('error', reject);
    });
  }

  #leseBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const teile: Buffer[] = [];
      let bytes = 0;
      req.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_BODY_BYTES) {
          reject(new Error('Body zu groß'));
          req.destroy();
          return;
        }
        teile.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(teile).toString('utf8')));
      req.on('error', reject);
    });
  }

  #text(res: ServerResponse, status: number, body: string): void {
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(body);
  }

  #json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  }
}
