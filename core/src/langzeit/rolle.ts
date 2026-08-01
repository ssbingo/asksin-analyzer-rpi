/**
 * Rolle eines Analyzers im Verbund — Master oder Client.
 *
 * Bisher ergab sich „Master" beiläufig daraus, dass jemand Peers eingetragen
 * hat. Für die Langzeitdaten reicht das nicht: Ein einzeln stehender Analyzer
 * hat keine Peers, ist aber trotzdem kein Client. Und die Entscheidung, wo
 * InfluxDB und Grafana laufen sollen, ist eine bewusste — keine, die man aus
 * einer Peer-Liste erraten sollte.
 *
 * Deshalb eine ausdrückliche Rolle:
 *
 *   **master** — darf Langzeitdaten lokal speichern. Vorgabe, denn ein Gerät
 *     ist erst dann Client, wenn jemand das sagt. Ein Alleingerät ist sein
 *     eigener Master.
 *   **client** — liefert nur zu. Der ganze Abschnitt verschwindet aus der
 *     Weboberfläche, und der Server weist entsprechende Aufträge ab. Eine
 *     bereits vorhandene Installation bleibt dabei **stehen**: Daten
 *     wegzuwerfen darf nie ein Nebeneffekt einer Umschaltung sein.
 */

export type Rolle = 'master' | 'client';

export const ROLLE_VORGABE: Rolle = 'master';

/** Prüft eine beliebige Eingabe auf eine gültige Rolle. */
export function istRolle(wert: unknown): wert is Rolle {
  return wert === 'master' || wert === 'client';
}

/**
 * Ermittelt die geltende Rolle aus den drei möglichen Quellen.
 *
 * Reihenfolge wie überall im Projekt: Was die Weboberfläche gesetzt hat,
 * schlägt die Datei `config.json`, und diese die Vorgabe. So bleibt die
 * Konsole der Experten-Weg, ohne die Bedienung ohne Konsole zu behindern.
 */
export function geltendeRolle(
  ausUi: unknown,
  ausKonfig: unknown,
  vorgabe: Rolle = ROLLE_VORGABE,
): Rolle {
  if (istRolle(ausUi)) return ausUi;
  if (istRolle(ausKonfig)) return ausKonfig;
  return vorgabe;
}

/** Was für die Entscheidung „darf Master sein" zählt. */
export interface Hardware {
  /** Inhalt von /proc/device-tree/model; leer auf Nicht-Pi-Rechnern. */
  modell: string;
  /** Arbeitsspeicher in Bytes, wie ihn os.totalmem() meldet. */
  ramBytes: number;
}

/**
 * Kleinste Baureihe, die Master werden darf.
 *
 * Der Pi 3 ist zu schwach: InfluxDB und Grafana brauchen zusammen rund 700 MB,
 * und daneben soll noch der Sniffer laufen. Geprüft wird die **Nummer** der
 * Baureihe, nicht eine Liste aus „4" und „5" — sonst müsste dieser Code beim
 * nächsten Modell wieder angefasst werden, obwohl die Aussage dieselbe bleibt.
 */
export const MASTER_AB_BAUREIHE = 4;

/**
 * Mindest-Arbeitsspeicher.
 *
 * Bewusst 1,8 GiB statt glatter 2 GiB: Ein 2-GB-Pi meldet nie die vollen
 * 2·1024³ Bytes — Firmware und Grafikspeicher gehen vorher ab. Eine strenge
 * Grenze würde genau die Geräte abweisen, die gemeint sind.
 */
export const MASTER_MIN_RAM = 1.8 * 1024 ** 3;

/**
 * Darf dieses Gerät Master sein?
 *
 * Die Prüfung ist absichtlich hier und nicht im Installationsskript: Sie gilt
 * auch für das nachträgliche Einrichten aus der Weboberfläche, und beides soll
 * dieselbe Antwort geben.
 */
export function masterFaehig(hw: Hardware): { faehig: boolean; grund: string } {
  const gb = (hw.ramBytes / 1024 ** 3).toFixed(1);
  const treffer = /Raspberry Pi (\d+)/.exec(hw.modell);

  if (treffer !== null) {
    const baureihe = Number(treffer[1]);
    if (baureihe < MASTER_AB_BAUREIHE) {
      return {
        faehig: false,
        grund:
          `Raspberry Pi ${baureihe} ist als Master zu schwach — ` +
          `nötig ist mindestens ein Pi ${MASTER_AB_BAUREIHE}. Dieses Gerät ` +
          `kann als Client mitlaufen und seine Daten an den Master liefern.`,
      };
    }
  }
  // Kein Pi (Entwicklungsrechner, virtuelle Maschine): Baureihe unbekannt,
  // also nicht darüber urteilen. Der Arbeitsspeicher zählt trotzdem.
  if (hw.ramBytes < MASTER_MIN_RAM) {
    return {
      faehig: false,
      grund:
        `${gb} GB Arbeitsspeicher reichen nicht — nötig sind mindestens 2 GB. ` +
        `InfluxDB und Grafana belegen zusammen rund 700 MB, und der Sniffer ` +
        `soll daneben weiterlaufen.`,
    };
  }
  return { faehig: true, grund: '' };
}

/**
 * Die tatsächlich geltende Rolle, nachdem die Hardware mitgeredet hat.
 *
 * Ein zu schwaches Gerät wird zum Client, auch wenn in der Konfiguration
 * „master" steht. Sonst hinge die Zusicherung daran, dass niemand die Datei
 * von Hand bearbeitet — und ein Pi 3 mit InfluxDB wäre genau das
 * Ressourcenproblem, das wir vermeiden wollen.
 */
export function rolleMitHardware(
  gewuenscht: Rolle,
  hw: Hardware,
): { rolle: Rolle; erzwungen: boolean; grund: string } {
  if (gewuenscht === 'client') return { rolle: 'client', erzwungen: false, grund: '' };
  const { faehig, grund } = masterFaehig(hw);
  if (faehig) return { rolle: 'master', erzwungen: false, grund: '' };
  return { rolle: 'client', erzwungen: true, grund };
}

/** Fehlermeldung, wenn ein Client etwas anfordert, das nur dem Master zusteht. */
export const NUR_MASTER =
  'Nur auf dem Master verfügbar. Dieses Gerät ist als Client eingetragen — ' +
  'zu ändern unter Einstellungen → Langzeitdaten.';

/**
 * Wirft, wenn die Rolle die Aktion nicht zulässt.
 *
 * Bewusst serverseitig und nicht nur in der Oberfläche: Ein ausgeblendeter
 * Knopf ist keine Zusicherung, und die API ist im Heimnetz erreichbar.
 */
export function verlangeMaster(rolle: Rolle): void {
  if (rolle !== 'master') throw new Error(NUR_MASTER);
}
