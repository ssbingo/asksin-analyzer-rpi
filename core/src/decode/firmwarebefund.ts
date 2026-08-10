/**
 * Versionsabhängigkeit zwischen Analyzer und Sniffer-Firmware.
 *
 * Es gilt dieselbe Regel wie zwischen Analyzer und ioBroker-Adapter: Wo zwei
 * Fassungen aufeinander angewiesen sind, muss die Abhängigkeit auf **beiden**
 * Seiten ausgewiesen und geprüft werden. Die Firmware nennt ihre Fassung in
 * der Auskunft auf `:?;`, der Analyzer prüft sie hier.
 *
 * Anders als beim Adapter ist eine zu alte Firmware **kein Fehler**. Die
 * Originalfassung läuft seit Jahren und tut, wofür sie da ist; sie kann nur
 * eben nichts über verlorene Zeilen sagen. Der Befund sagt deshalb, was
 * fehlt, statt zu mahnen.
 */

import type { Firmwareantwort } from './types.ts';

/**
 * Ab dieser Protokollfassung kann der Analyzer Lücken erkennen.
 *
 * Steigt nur, wenn sich das Drahtformat ändert — nicht bei jeder neuen
 * Firmware. Beschreibung: asksin-sniffer-firmware/docs/protokoll.md
 */
export const PROTOKOLL_MINDESTFASSUNG = 1;

/** Höchste Protokollfassung, die dieser Analyzer versteht. */
export const PROTOKOLL_HOECHSTFASSUNG = 1;

/**
 * Wie lange nach der Versionsfrage auf die Antwort gewartet wird, bevor
 * daraus ein Befund wird.
 *
 * Die Firmware antwortet in Millisekunden. Drei Sekunden sind also um
 * Groessenordnungen grosszuegig — sie decken auch den Fall ab, dass die
 * Antwort hinter einer Reihe Rauschzeilen einsortiert ist.
 *
 * Ohne diese Frist behauptete der Analyzer unmittelbar nach dem Start, es
 * laufe die Originalfassung, weil noch keine Antwort da war. Am 10.08.2026
 * an zwei Geraeten aufgetreten: nach dem Dienst-Neustart die falsche
 * Auskunft, nach einem Kaltstart die richtige. Aus dem Ausbleiben einer
 * Antwort darf erst dann eine Feststellung werden, wenn sie haette da sein
 * muessen.
 */
export const ANTWORTFRIST_MS = 3000;

export type Firmwarebefund =
  | { art: 'unbekannt'; text: string }
  | { art: 'passt'; text: string }
  | { art: 'original'; text: string }
  | { art: 'zuAlt'; text: string }
  | { art: 'zuNeu'; text: string }
  | { art: 'funkmodul'; text: string };

/**
 * Formuliert, wie Analyzer und Firmware zueinander stehen — **auch im guten
 * Fall**.
 *
 * Schweigen bei Erfolg wäre mehrdeutig: „geprüft und in Ordnung" sähe genauso
 * aus wie „konnte nicht prüfen".
 *
 * @param antwort        Auskunft der Firmware; null, wenn keine kam
 * @param analyzerVersion Fassung dieses Analyzers, für den Text
 */
export function baueFirmwarebefund(
  antwort: Firmwareantwort | null,
  analyzerVersion: string,
  frage?: { gefragtAm: number | null; jetzt: number },
): Firmwarebefund {
  if (antwort === null || antwort.art !== 'version') {
    // Noch gar nicht gefragt, oder die Frist laeuft noch: Dann ist nichts
    // festgestellt, und es wird auch nichts behauptet.
    if (
      frage !== undefined &&
      (frage.gefragtAm === null || frage.jetzt - frage.gefragtAm < ANTWORTFRIST_MS)
    ) {
      return {
        art: 'unbekannt',
        text:
          frage.gefragtAm === null
            ? 'Die Versionsfrage wurde noch nicht gestellt — der Sniffer ist ' +
              'noch nicht verbunden. Sobald die Verbindung steht, meldet sich ' +
              'die Firmware von selbst.'
            : 'Die Versionsfrage läuft — die Antwort steht noch aus. Das ' +
              'dauert normalerweise Millisekunden.',
      };
    }
    return {
      art: 'original',
      text:
        'Der Sniffer antwortet nicht auf die Versionsfrage — es läuft die ' +
        'Originalfassung der Firmware. Sie arbeitet einwandfrei, kann aber ' +
        'nicht sagen, ob Zeilen verlorengehen: Der Analyzer sieht dann ' +
        'weniger Telegramme und kann Verlust nicht von Funkstille ' +
        'unterscheiden. Wer das ändern möchte, spielt die erweiterte ' +
        'Firmware auf (Handbuch 11).',
    };
  }

  // Das tote Funkmodul zuerst: Es ist der einzige Fall, in dem tatsächlich
  // etwas kaputt ist. Eine passende Protokollfassung wäre da nur ein
  // Nebenbefund — und die Meldung darüber verdeckte das Wesentliche.
  if (antwort.cc1101 === null) {
    return {
      art: 'funkmodul',
      text:
        `Die Firmware meldet sich (Fassung ${antwort.firmware}), aber ihr ` +
        'Funkmodul antwortet nicht. Der Sniffer läuft dann scheinbar normal ' +
        'und empfängt trotzdem nie ein Telegramm. Zu prüfen sind der Sitz ' +
        'des CC1101-Moduls und die Lötstellen der SPI-Leitungen — nicht die ' +
        'Antenne.',
    };
  }

  if (antwort.protokoll < PROTOKOLL_MINDESTFASSUNG) {
    return {
      art: 'zuAlt',
      text:
        `Die Firmware spricht Protokoll ${antwort.protokoll}, nötig wäre ` +
        `mindestens ${PROTOKOLL_MINDESTFASSUNG}. Der Analyzer läuft ` +
        'weiter, kann aber keine Lücken erkennen.',
    };
  }

  if (antwort.protokoll > PROTOKOLL_HOECHSTFASSUNG) {
    return {
      art: 'zuNeu',
      text:
        `Die Firmware spricht Protokoll ${antwort.protokoll}; dieser ` +
        `Analyzer ${analyzerVersion} versteht höchstens ` +
        `${PROTOKOLL_HOECHSTFASSUNG}. Zuerst den Analyzer aktualisieren — ` +
        'die Firmware bleibt so lange im kompatiblen Betrieb, es geht also ' +
        'nichts verloren.',
    };
  }

  return {
    art: 'passt',
    text:
      `Sniffer-Firmware ${antwort.firmware} (Protokoll ${antwort.protokoll}, ` +
      `${antwort.taktMHz} MHz) und Analyzer ${analyzerVersion} passen ` +
      `zueinander. Das Funkmodul antwortet ` +
      `(CC1101-Version 0x${antwort.cc1101.toString(16).toUpperCase()}), ` +
      'und verlorene Zeilen werden erkannt.',
  };
}
