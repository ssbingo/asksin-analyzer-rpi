/**
 * Systemaktualisierung — `apt-get update` und `apt-get full-upgrade`.
 *
 * ## Warum das in die Weboberfläche gehört
 *
 * Der Analyzer läuft dauerhaft, hängt am Netz und trägt einen Webserver. Ein
 * Gerät mit diesen drei Eigenschaften muss seine Sicherheitsaktualisierungen
 * bekommen — sonst sammelt es über Monate offene Lücken an, von denen niemand
 * erfährt.
 *
 * Der übliche Weg dorthin ist die Konsole, und genau die soll dieses Projekt
 * niemandem zumuten. Wer den Analyzer aufstellt, soll ihn über die Oberfläche
 * bedienen können — auch in diesem Punkt.
 *
 * ## Was hier steht und was nicht
 *
 * Hier steht nur, was sich ohne Wurzelrechte entscheiden lässt: wie alt eine
 * Aktualisierung ist, ob sie überfällig wird, und was in der Ausgabe von apt
 * eigentlich stand. Das Ausführen selbst macht `deploy/systemupdate.sh` als
 * eng begrenzter Root-Helfer — dasselbe Muster wie beim Alarmziel und beim
 * Core-Update.
 */

/**
 * Ab wie vielen Tagen ohne Aktualisierung gewarnt wird.
 *
 * Sieben Tage, so vom Betreiber vorgegeben. Die Zahl ist keine
 * Sicherheitsgrenze, sondern eine Gedächtnisstütze: Debian veröffentlicht
 * Sicherheitsaktualisierungen laufend, und eine Woche ist der Abstand, in dem
 * man ohne schlechtes Gewissen nicht hinsehen muss.
 */
export const SYSTEMUPDATE_WARNUNG_TAGE = 7;

/**
 * Ab wann ein als laufend vermerkter Lauf als steckengeblieben gilt.
 *
 * Eine Stunde, deutlich großzügiger als beim Core-Update (dort eine halbe).
 * `apt-get full-upgrade` kann auf einem Pi 3 mit SD-Karte nach einem längeren
 * Rückstand tatsächlich lange laufen — und eine Sperre, die zu früh greift,
 * startet einen zweiten apt-Lauf neben den ersten. Das Skript frischt
 * `updatedAt` bei jedem Schritt auf.
 */
export const SYSTEMUPDATE_STECKEN_MS = 60 * 60 * 1000;

/** Die Schritte, die das Helferskript meldet. */
export type SystemupdateSchritt =
  | 'start'
  | 'paketlisten'
  | 'aufruesten'
  | 'aufraeumen'
  | 'fertig';

/** Der Fortschritt, wie ihn der Root-Helfer in seine Statusdatei schreibt. */
export interface SystemupdateStatus {
  running: boolean;
  schritt: SystemupdateSchritt;
  /** null, solange es läuft. */
  ok: boolean | null;
  startedAt: number;
  updatedAt: number;
  /** Wie viele Pakete aufgerüstet wurden; null, wenn nicht ermittelbar. */
  pakete: number | null;
  /** Verlangt das System nach dem Lauf einen Neustart? */
  neustartNoetig: boolean;
  /** Klartext im Fehlerfall — die Meldung von apt, nicht unsere Deutung. */
  fehler: string | null;
}

/** Was beim letzten **erfolgreichen** Lauf herauskam. */
export interface SystemupdateErfolg {
  /** Zeitpunkt in Millisekunden. */
  zeit: number;
  pakete: number | null;
  neustartNoetig: boolean;
}

/** Wie dringend ist eine Aktualisierung? */
export type Dringlichkeit = 'nie' | 'frisch' | 'ueberfaellig';

export interface Altersbefund {
  stufe: Dringlichkeit;
  /** Volle Tage seit dem letzten Erfolg; null, wenn es noch keinen gab. */
  alterTage: number | null;
  /** Ein Satz für die Oberfläche — sie zeigt ihn wörtlich. */
  text: string;
}

/**
 * Wie lange ist die letzte erfolgreiche Aktualisierung her?
 *
 * „Noch nie" ist **nicht** dasselbe wie „lange her" und bekommt deshalb eine
 * eigene Stufe: Bei einem frisch aufgesetzten Gerät ist das der Normalzustand
 * und keine Versäumnis — die Aufforderung lautet trotzdem gleich, nur der Ton
 * ist ein anderer.
 *
 * @param letzterErfolgMs Zeitpunkt des letzten Erfolgs, oder null.
 * @param jetzt Wanduhr.
 */
export function bewerteAlter(letzterErfolgMs: number | null, jetzt: number): Altersbefund {
  if (letzterErfolgMs === null || !Number.isFinite(letzterErfolgMs)) {
    return {
      stufe: 'nie',
      alterTage: null,
      text: 'Über diese Oberfläche wurde noch nie aktualisiert.',
    };
  }
  // Ein Zeitstempel aus der Zukunft entsteht, wenn die Uhr nachträglich
  // zurückgestellt wird (Pi ohne Batterie, NTP kommt spät). Ihn als „in
  // −3 Tagen" anzuzeigen wäre Unsinn; als frisch zu werten ist die harmlosere
  // Deutung, denn kurz darauf stimmt die Uhr wieder.
  const alterMs = Math.max(0, jetzt - letzterErfolgMs);
  const alterTage = Math.floor(alterMs / 86_400_000);

  if (alterTage < SYSTEMUPDATE_WARNUNG_TAGE) {
    return {
      stufe: 'frisch',
      alterTage,
      text:
        alterTage === 0
          ? 'Heute aktualisiert.'
          : `Vor ${alterTage} ${alterTage === 1 ? 'Tag' : 'Tagen'} aktualisiert.`,
    };
  }
  return {
    stufe: 'ueberfaellig',
    alterTage,
    text:
      `Die letzte Aktualisierung ist ${alterTage} Tage her — ` +
      'bitte bald nachholen.',
  };
}

/**
 * Liest aus apts Zusammenfassung, wie viele Pakete aufgerüstet wurden.
 *
 * Der Helfer ruft apt mit `LC_ALL=C` auf, damit die Ausgabe unabhängig von der
 * Spracheinstellung des Geräts ist. Die deutsche Form wird trotzdem erkannt:
 * Wer das Skript von Hand ohne diese Umgebung startet, soll keine Lücke in der
 * Anzeige bekommen.
 *
 * @returns Anzahl, oder null, wenn die Zeile nicht vorkam.
 */
export function zaehleAufgeruestet(ausgabe: string): number | null {
  const englisch = /^(\d+) upgraded, \d+ newly installed/m.exec(ausgabe);
  if (englisch !== null) return Number(englisch[1]);
  const deutsch = /^(\d+) aktualisiert, \d+ neu installiert/m.exec(ausgabe);
  if (deutsch !== null) return Number(deutsch[1]);
  return null;
}

/**
 * Läuft gerade ein Lauf — oder hängt einer?
 *
 * Dieselbe Überlegung wie beim Core-Update: Eine Sperre, aus der nur der
 * Erfolgsfall herausführt, ist keine Sperre, sondern eine Falle. Wird der Lauf
 * hart abgebrochen (Stromausfall mitten im Aufrüsten), bliebe `running` sonst
 * für immer stehen, und die Oberfläche verweigerte jeden weiteren Versuch.
 */
export function laeuftNoch(status: SystemupdateStatus | null, jetzt: number): boolean {
  if (status === null || !status.running) return false;
  const alterMs = jetzt - status.updatedAt;
  return Number.isFinite(alterMs) && alterMs < SYSTEMUPDATE_STECKEN_MS;
}
