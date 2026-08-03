/**
 * Folgenummern auswerten — verlorene Zeilen sichtbar machen.
 *
 * Das Problem, das hier gelöst wird
 * ---------------------------------
 * Bis zur erweiterten Firmware war ein Verlust **unsichtbar**. Verschluckte
 * die Leitung eine Zeile oder lief ein Puffer über, sah der Analyzer schlicht
 * weniger Telegramme — und hielt das für Funkstille. Beides ist von außen
 * nicht zu unterscheiden, und genau diese Ununterscheidbarkeit steht bis
 * heute als Warnung in der Mitschnitt-Auswertung.
 *
 * Mit einer laufenden Nummer je Zeile wird daraus eine Rechnung: Fehlt
 * zwischen 0041 und 0045 etwas, sind drei Zeilen verloren. Nicht „vielleicht",
 * sondern genau drei.
 *
 * Die drei Fälle, die auseinandergehalten werden müssen
 * ----------------------------------------------------
 *   Verlust      Kleiner Sprung vorwärts. So viele Zeilen fehlen.
 *   Überlauf     FFFF → 0000. Kein Verlust, sondern Zahlenbereichsende.
 *   Neuanfang    Die Firmware hat neu gestartet und zählt wieder bei 0.
 *
 * Überlauf und Neuanfang sehen zunächst gleich aus, und ein Neuanfang darf
 * nicht als 65 000 verlorene Zeilen erscheinen — das würde jede Statistik
 * unbrauchbar machen und einen Alarm auslösen, wo nur ein Neustart war.
 */

/** Größe des Zahlenraums der Folgenummer (16 Bit). */
export const FOLGE_RAUM = 0x10000;

/**
 * Ab dieser Sprungweite gilt ein Vorwärtssprung als Neuanfang, nicht als
 * Verlust.
 *
 * Begründung: Bei rund 80 Zeilen je Minute wären 4096 verlorene Zeilen ein
 * Ausfall von fast einer Stunde — dann hätte längst der Stille-Wächter
 * angeschlagen und die Verbindung neu aufgebaut. Ein Sprung dieser Größe ist
 * in der Praxis immer ein Neustart der Firmware, kein Verlust.
 *
 * Die Grenze bewusst großzügig: Lieber ein echter Großverlust als Neuanfang
 * verbucht (und damit als Lücke im Zeitverlauf sichtbar) als ein Neustart
 * als 60 000 verlorene Zeilen — Letzteres verdürbe jede Auswertung.
 */
export const NEUANFANG_AB = 4096;

/**
 * Bis zu so vielen Schritten rückwärts gilt der Sprung als Doppelung oder
 * Vertauschung, nicht als Neuanfang.
 *
 * Beides darf auf einer UART nicht vorkommen. Wenn es doch geschieht, ist es
 * ein Befund für sich — er verschwindet nicht in der Sammelkategorie
 * „Neustart", wo ihn niemand mehr fände.
 */
export const RUECKWAERTS_BIS = 16;

export interface Folgestatistik {
  /** Zeilen mit Anhang, seit dem Beginn der Verbindung. */
  gesehen: number;
  /** Aus den Sprüngen errechnete verlorene Zeilen. */
  verloren: number;
  /** Wie oft ein Neuanfang erkannt wurde (Firmware-Neustart). */
  neuanfaenge: number;
  /** Wie oft der Zahlenraum ordentlich übergelaufen ist. */
  ueberlaeufe: number;
  /** Zuletzt gesehene Nummer, oder null vor der ersten Zeile. */
  letzte: number | null;
  /**
   * Anteil verlorener Zeilen an allen erwarteten, in Prozent.
   * null, solange zu wenig Zeilen für eine Aussage vorliegen.
   */
  verlustProzent: number | null;
}

/** Was eine einzelne Nummer bedeutet hat. */
export type Folgebefund =
  | { art: 'erste' }
  | { art: 'lueckenlos' }
  | { art: 'ueberlauf' }
  | { art: 'verlust'; anzahl: number }
  | { art: 'neuanfang' }
  /** Nummer kleiner als die vorige, aber kein Neuanfang — sollte nie
   *  vorkommen und wird deshalb ausdrücklich gemeldet statt geraten. */
  | { art: 'rueckwaerts' };

export class Folgezaehler {
  #gesehen = 0;
  #verloren = 0;
  #neuanfaenge = 0;
  #ueberlaeufe = 0;
  #letzte: number | null = null;

  /** Eine Folgenummer einspeisen. Liefert, wie sie zu deuten war. */
  melde(nummer: number): Folgebefund {
    this.#gesehen++;
    const vorher = this.#letzte;
    this.#letzte = nummer;

    if (vorher === null) return { art: 'erste' };

    const erwartet = (vorher + 1) % FOLGE_RAUM;
    if (nummer === erwartet) {
      // Der Überlauf ist der Normalfall, nur eben an der Bereichsgrenze.
      // Er wird gezählt, damit sich später nachvollziehen lässt, warum die
      // Zahlen wieder klein sind — sonst sieht das im Protokoll nach Fehler aus.
      if (nummer === 0) this.#ueberlaeufe++;
      return nummer === 0 ? { art: 'ueberlauf' } : { art: 'lueckenlos' };
    }

    // Abstand im Ringraum. Damit ist ein Überlauf mitten in einem Verlust
    // (etwa FFFE → 0002) richtig gerechnet: drei fehlende Zeilen, nicht
    // 65 000.
    const abstand = (nummer - erwartet + FOLGE_RAUM) % FOLGE_RAUM;

    if (abstand >= NEUANFANG_AB) {
      // Im Ringraum ist „weit vorwärts" dasselbe wie „ein Stück zurück".
      // Diese beiden Fälle müssen getrennt werden:
      //
      //   ein paar Schritte zurück   Eine Zeile kam doppelt oder verspätet.
      //                              Das darf nie passieren — eine UART
      //                              ordnet nicht um — und ist deshalb ein
      //                              eigener Befund, kein Achselzucken.
      //   weit weg                   Die Firmware hat neu gestartet.
      const zurueck = FOLGE_RAUM - abstand;
      if (zurueck <= RUECKWAERTS_BIS) return { art: 'rueckwaerts' };

      this.#neuanfaenge++;
      return { art: 'neuanfang' };
    }

    this.#verloren += abstand;
    return { art: 'verlust', anzahl: abstand };
  }

  /** Setzt alles zurück — beim Neuaufbau der Verbindung. */
  zuruecksetzen(): void {
    this.#gesehen = 0;
    this.#verloren = 0;
    this.#neuanfaenge = 0;
    this.#ueberlaeufe = 0;
    this.#letzte = null;
  }

  stats(): Folgestatistik {
    const erwartet = this.#gesehen + this.#verloren;
    return {
      gesehen: this.#gesehen,
      verloren: this.#verloren,
      neuanfaenge: this.#neuanfaenge,
      ueberlaeufe: this.#ueberlaeufe,
      letzte: this.#letzte,
      // Unter 100 Zeilen ist jede Prozentangabe Zahlenspielerei: Eine
      // einzelne verlorene Zeile ergäbe dann schon 1 %, und das liest sich
      // dramatischer, als es ist.
      verlustProzent: erwartet >= 100 ? (this.#verloren / erwartet) * 100 : null,
    };
  }
}
