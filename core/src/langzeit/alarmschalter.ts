/**
 * Einzelne Alarme ein- und ausschalten.
 *
 * ## Warum das nötig ist
 *
 * Der Betreiber am 21.08.2026: „Die Meldung über 24 h nicht erreichbare Geräte
 * war gestern Abend sehr störend, zumal man ja auch nicht jeden Tag jeden
 * Schalter betätigt oder jedes Fenster öffnet."
 *
 * Das ist keine Geschmacksfrage. Ein Fensterkontakt an einem Fenster, das im
 * Winter zwei Wochen zu bleibt, meldet sich zu Recht nicht — und ein Alarm,
 * der daraufhin jeden Abend anschlägt, bringt niemandem etwas bei. Schlimmer:
 * Wer eine Meldung gewohnheitsmäßig wegklickt, klickt auch die weg, die zählt.
 *
 * ## Wie geschaltet wird
 *
 * Über `isPaused` in Grafanas Provisionierung. Eine pausierte Regel wird gar
 * nicht erst ausgewertet — keine Abfrage, keine Last, keine Meldung. Das ist
 * ehrlicher als eine Regel, die läuft und deren Meldung unterwegs verworfen
 * wird: Im ersten Fall steht in Grafana „paused", im zweiten sähe alles normal
 * aus, und niemand fände den Grund für die ausbleibende Meldung.
 *
 * Der Regeltext selbst bleibt, wo er ist — in
 * `deploy/grafana/provisioning/alerting/asksin-alarme.yaml`. Hier wird ihm nur
 * ein `isPaused` beigelegt. Zwei Dateien, die dieselben Regeln beschreiben,
 * liefen sonst auseinander.
 */

/** Ein schaltbarer Alarm, wie ihn die Oberfläche anbietet. */
export interface Alarmregel {
  /** uid der Regel in der Provisionierung. */
  uid: string;
  /** Kurzname für den Schalter. */
  name: string;
  /** Was er meldet — steht als Erklärung unter dem Schalter. */
  zweck: string;
  /**
   * Voreinstellung für neue Installationen.
   *
   * Alle an: Wer den Analyzer aufstellt, will zunächst alles wissen. Was
   * stört, schaltet er ab — das ist die richtige Richtung, denn die andere
   * verschweigt Dinge, von denen man nie erfährt, dass es sie gab.
   */
  vorgabe: boolean;
}

/**
 * Die vier Alarme aus `asksin-alarme.yaml`.
 *
 * Diese Liste ist die Verbindung zwischen Regeltext und Oberfläche. Wer dort
 * eine Regel ergänzt, ergänzt sie hier — sonst gibt es einen Alarm ohne
 * Schalter, und der lässt sich dann nur noch in Grafana abstellen.
 */
export const ALARMREGELN: readonly Alarmregel[] = [
  {
    uid: 'asksin-alarm-offline',
    name: 'Analyzer offline',
    zweck: 'Ein Analyzer meldet seit über zehn Minuten keine gültige '
      + 'Verbindung zum Funkmodul.',
    vorgabe: true,
  },
  {
    uid: 'asksin-alarm-dutycycle',
    name: 'Duty-Cycle über 80 %',
    zweck: 'Ein Gerät reizt sein Sendekontingent aus und stopft damit das '
      + 'Funknetz zu.',
    vorgabe: true,
  },
  {
    uid: 'asksin-alarm-stumm',
    name: 'Gerät seit 24 Stunden stumm',
    zweck: 'Von einem Gerät kam einen Tag lang kein Telegramm — meist eine '
      + 'leere Batterie. Meldet sich aber auch bei Geräten, die man schlicht '
      + 'länger nicht benutzt: ein Fenster, das zu bleibt, ein Schalter, den '
      + 'niemand drückt.',
    vorgabe: true,
  },
  {
    uid: 'asksin-alarm-rauschen',
    name: 'Grundrauschen erhöht',
    zweck: 'Das Grundrauschen an einem Standort liegt dauerhaft höher als '
      + 'gewohnt — ein Störer ist aktiv.',
    vorgabe: true,
  },
] as const;

/** Der Zustand aller Schalter. Fehlt einer, gilt seine Vorgabe. */
export type Alarmschalter = Record<string, boolean>;

/** Vollständiger Schalterzustand aus einer möglicherweise lückenhaften Angabe. */
export function vollstaendig(teil: Partial<Alarmschalter> | undefined): Alarmschalter {
  const raus: Alarmschalter = {};
  for (const r of ALARMREGELN) {
    const wert = teil?.[r.uid];
    raus[r.uid] = typeof wert === 'boolean' ? wert : r.vorgabe;
  }
  return raus;
}

/**
 * Legt jeder Regel ihr `isPaused` bei.
 *
 * Rein textlich und Zeile für Zeile, nicht über einen YAML-Parser: Die Datei
 * ist von Hand gepflegt und trägt ausführliche Kommentare, die ein
 * Parser-Umlauf allesamt verlöre. Die Begründungen dort sind teuer erarbeitet
 * — sie sind mehr wert als die Bequemlichkeit, ein Objekt zu bearbeiten.
 *
 * Verankert wird an `- uid: <regel>`; das `isPaused` kommt unmittelbar
 * danach, auf derselben Einrückung. Ein bereits vorhandenes wird ersetzt.
 *
 * @param yaml Der Regeltext, wie er im Projekt liegt.
 * @param schalter true = Alarm aktiv (also NICHT pausiert).
 */
export function mitSchaltern(yaml: string, schalter: Alarmschalter): string {
  const zeilen = yaml.split('\n');
  const raus: string[] = [];

  for (let i = 0; i < zeilen.length; i++) {
    const zeile = zeilen[i]!;
    raus.push(zeile);

    const treffer = /^(\s*)-\s+uid:\s*(\S+)\s*$/.exec(zeile);
    if (treffer === null) continue;
    const [, einzug, uid] = treffer;
    if (!(uid! in schalter)) continue;

    // Ein schon vorhandenes isPaused der Regel überspringen — sonst stünde es
    // zweimal da, und Grafana nähme das letzte. Nur bis zur nächsten Regel
    // suchen, damit nicht das der folgenden erwischt wird.
    const einzugRegel = `${einzug}  `;
    while (i + 1 < zeilen.length) {
      const naechste = zeilen[i + 1]!;
      if (/^\s*-\s+uid:/.test(naechste)) break;
      if (naechste.startsWith(`${einzugRegel}isPaused:`)) { i++; continue; }
      break;
    }

    // `isPaused: true` heisst pausiert; der Schalter sagt „aktiv". Die
    // Umkehrung steht genau hier und nirgends sonst.
    raus.push(`${einzugRegel}isPaused: ${schalter[uid!] === false}`);
  }
  return raus.join('\n');
}
