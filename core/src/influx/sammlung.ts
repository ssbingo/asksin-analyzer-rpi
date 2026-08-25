/**
 * „Sammlung": Wie viele Standorte liefern gerade in die Langzeitdatenbank?
 *
 * ## Warum nicht die Datenbank fragen
 *
 * Genau das tat diese Auskunft bis zum 25.08.2026 — mit
 * `schema.tagValues(bucket, tag: "standort")`. Die Abfrage war richtig und
 * lief auch. Dann wurden die InfluxDB-Token getrennt: Grafana bekam einen
 * **Lese**-Token, die Analyzer einen **Schreib**-Token. Damit sieht ein
 * Analyzer den Bucket nicht mehr, und InfluxDB antwortet:
 *
 *     HTTP 404  {"code":"not found",
 *                "message":"failed to initialize execute state:
 *                           could not find bucket \"…\""}
 *
 * Kein Rechtefehler, sondern ein *Nicht gefunden* — der Bucket existiert für
 * diesen Token schlicht nicht. Der `catch` machte daraus ein stilles „nicht
 * ermittelbar", und in der Übersicht stand monatelang ein Strich, ohne dass
 * irgendwo ein Fehler auftauchte.
 *
 * Die Lehre daran ist nicht „Lesezugriff zurückgeben". Der Schreib-Token ist
 * richtig so: Ein Analyzer im Gartenhaus soll die Datenbank füttern und nicht
 * ausleseren können. Falsch war, eine Anzeige an einen Zugriff zu hängen, den
 * das Gerät gar nicht mehr haben soll.
 *
 * ## Was stattdessen gezählt wird
 *
 * Die Analyzer selbst. Jeder weiß, ob er schreibt und wann sein letzter
 * Schreibvorgang geglückt ist — das steht in seinem eigenen Zustand und kostet
 * keine Rechte an der Datenbank. Der Master fragt der Reihe nach alle ab.
 *
 * Der ursprüngliche Anspruch bleibt damit erhalten: **Ein Standort zählt,
 * wenn er auch wirklich schreibt.** Ein eingetragener, aber ausgefallener Peer
 * zählt nicht mit — er ist entweder nicht erreichbar oder meldet selbst, dass
 * seit Langem nichts mehr durchging.
 */

/** Was ein Analyzer über seine eigene Lieferung sagt. */
export interface SammlungBericht {
  standort: string;
  /** Ist die Langzeitaufzeichnung dort eingeschaltet? */
  influxAktiv: boolean;
  /** Zeitpunkt des letzten geglückten Schreibvorgangs, oder null. */
  letzterErfolg: number | null;
  /** Schreibtakt dieses Analyzers in Sekunden. */
  intervallSekunden: number;
}

/**
 * Untergrenze für das Zeitfenster, in dem ein Schreibvorgang „frisch" ist.
 *
 * Fünf Minuten, auch wenn jemand alle fünf Sekunden schreibt: Ein einzelner
 * verpasster Durchgang — Netz kurz weg, InfluxDB startet neu — darf einen
 * Standort nicht aus der Zählung werfen. Wer die Anzeige dabei flackern sieht,
 * traut ihr danach nicht mehr.
 */
export const SAMMLUNG_FRIST_MIN_MS = 5 * 60_000;

/**
 * Wie viele Takte ein Standort aussetzen darf, bevor er als stumm gilt.
 *
 * Drei: Einer kann immer danebengehen, zwei sind Zufall, drei sind ein Muster.
 * Bei einem Takt von einer Stunde bedeutet das drei Stunden Geduld — richtig
 * so, denn dort ist ein einzelner Ausfall auch drei Stunden lang unauffällig.
 */
export const SAMMLUNG_TAKTE = 3;

export interface Sammlung {
  /** Standorte, die gerade liefern — alphabetisch, ohne Dubletten. */
  liefern: string[];
  /**
   * Standorte, die eingeschaltet sind, aber gerade nicht liefern. Sie werden
   * **nicht** mitgezählt, aber benannt: „2 von 3" mit Namen ist eine
   * Auskunft, „2" allein wäre eine halbe.
   *
   * Bewusst nicht „seit Langem still": Hier landet auch ein Analyzer, der
   * gerade erst neu gestartet ist und seinen ersten Schreibvorgang noch vor
   * sich hat. Das ist für eine Handvoll Sekunden nach jeder Aktualisierung der
   * Fall — „liefert gerade nicht" stimmt dann, „seit Langem still" wäre eine
   * Übertreibung, und eine Anzeige, die übertreibt, glaubt man später nicht.
   */
  stumm: string[];
}

/**
 * Zählt die liefernden Standorte.
 *
 * Doppelte Namen zählen einmal: Zwei Analyzer mit demselben Standortnamen
 * schreiben in dieselbe Zeitreihe, und die Datenbank sähe sie auch als einen.
 * Die alte Abfrage lieferte Tag-Werte und hatte diese Eigenschaft von selbst —
 * sie darf beim Wechsel der Quelle nicht verloren gehen.
 *
 * @param berichte Auskünfte aller bekannten Analyzer; unerreichbare fehlen.
 * @param jetzt Wanduhr.
 */
export function zaehleSammlung(
  berichte: readonly SammlungBericht[],
  jetzt: number,
): Sammlung {
  const liefern = new Set<string>();
  const stumm = new Set<string>();

  for (const b of berichte) {
    const name = b.standort.trim();
    if (name === '' || !b.influxAktiv) continue;

    const takt = Math.max(1, b.intervallSekunden) * 1000 * SAMMLUNG_TAKTE;
    const frist = Math.max(SAMMLUNG_FRIST_MIN_MS, takt);
    // Ein Zeitstempel aus der Zukunft (Uhr eines Peers laeuft vor) gilt als
    // frisch — er ist jedenfalls kein Beleg fuer Stille.
    const frisch =
      b.letzterErfolg !== null && jetzt - b.letzterErfolg <= frist;

    if (frisch) liefern.add(name);
    else stumm.add(name);
  }

  // Ein Standort, der von einem Gerät liefert und von einem zweiten nicht,
  // liefert. Die Datenbank bekommt ihre Daten; das schweigende Gerät ist ein
  // anderes Thema und steht in der Verbund-Ansicht.
  for (const name of liefern) stumm.delete(name);

  return {
    liefern: [...liefern].sort((a, b) => a.localeCompare(b, 'de')),
    stumm: [...stumm].sort((a, b) => a.localeCompare(b, 'de')),
  };
}
