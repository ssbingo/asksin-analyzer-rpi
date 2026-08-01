/**
 * Versionsabhängigkeit zwischen Analyzer und ioBroker-Adapter.
 *
 * ## Die Regel
 *
 * Analyzer und Adapter werden getrennt gepflegt und getrennt aktualisiert.
 * Wer beide betreibt, hat damit zwangsläufig irgendwann zwei Fassungen im
 * Haus, die nicht zusammenpassen — und der Fehler äussert sich dann als
 * „geht nicht", nicht als „Version zu alt".
 *
 * Deshalb gilt seit 0.12.0: **Beide Seiten weisen aus, welche Fassung der
 * anderen sie mindestens brauchen, und prüfen es auch.** Hier steht die
 * Angabe des Analyzers; im Adapter steht die spiegelbildliche
 * (`lib/version.js`).
 *
 * ## Die bisherigen Paare
 *
 * | Analyzer | Adapter | wodurch |
 * | -------- | ------- | ------- |
 * | 0.12.0   | 0.0.2   | erste Fassung mit Alarm-Zustellung |
 *
 * Wer hier eine Zeile ergänzt, ergänzt auch die im Adapter — sonst behauptet
 * jede Seite etwas anderes.
 */

/** Fassung des ioBroker-Adapters, ab der die Alarm-Zustellung funktioniert. */
export const ADAPTER_MINDESTVERSION = '0.0.2';

/**
 * Vergleicht zwei Versionsangaben.
 *
 * Bewusst ohne Bibliothek und bewusst schlicht: Verglichen werden die Zahlen
 * vor dem ersten Bindestrich, Stelle für Stelle. Ein reiner
 * Zeichenkettenvergleich läge falsch — „0.9.0" wäre darin grösser als
 * „0.12.0". Ein Vorabkennzeichen wie `1.2.3-beta.1` zählt wie `1.2.3`: Wer
 * eine Vorabfassung einsetzt, weiss, was er tut.
 */
export function vergleicheVersion(a: string, b: string): number {
  const teile = (v: string): number[] =>
    String(v || '0')
      .split('-')[0]!
      .split('.')
      .map((x) => Number.parseInt(x, 10) || 0);
  const x = teile(a);
  const y = teile(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Genügt die vorhandene Fassung der geforderten Mindestversion?
 *
 * Eine unbekannte Fassung gilt als ausreichend. Sonst schlüge der Analyzer
 * bei jedem Adapter Alarm, der seine Version nicht meldet — und die Warnung
 * wäre wertlos, weil sie überall stünde.
 */
export function versionGenuegt(
  vorhanden: string | null | undefined,
  noetig: string,
): boolean {
  if (vorhanden === null || vorhanden === undefined || !/^\d/.test(vorhanden)) {
    return true;
  }
  return vergleicheVersion(vorhanden, noetig) >= 0;
}

/**
 * Der Satz für die Oberfläche, wenn der Adapter zu alt ist.
 *
 * Er nennt beide Fassungen und den Weg zur Abhilfe — „Version zu alt" allein
 * lässt den Leser mit der Frage zurück, was er nun tun soll.
 */
export function adapterZuAlt(gefunden: string): string {
  return (
    `Der ioBroker-Adapter meldet Version ${gefunden}, gebraucht wird ` +
    `mindestens ${ADAPTER_MINDESTVERSION}. Ältere Fassungen nehmen die ` +
    `Alarme nicht entgegen. Im ioBroker aktualisieren, dann erneut testen.`
  );
}

/** Was die Prüfung der Gegenstelle ergeben hat. */
export type Versionsbefund =
  | { art: 'passt'; text: string }
  | { art: 'zuAlt'; text: string }
  | { art: 'unbekannt'; text: string };

/**
 * Formuliert das Ergebnis der Versionsprüfung — **auch im guten Fall**.
 *
 * Schweigen bei Erfolg wäre mehrdeutig: „geprüft und in Ordnung" sähe genauso
 * aus wie „konnte nicht prüfen". Wer wissen will, ob zwei Fassungen
 * zueinander passen, braucht eine Antwort, keine Abwesenheit einer Warnung.
 *
 * @param adapterVersion Was der Adapter gemeldet hat; null, wenn er nichts sagte
 * @param eigeneVersion  Fassung dieses Analyzers
 */
export function baueVersionsbefund(
  adapterVersion: string | null,
  eigeneVersion: string,
): Versionsbefund {
  if (adapterVersion === null || !/^\d/.test(adapterVersion)) {
    return {
      art: 'unbekannt',
      text:
        'Der Adapter nennt seine Fassung nicht — die Prüfung war nicht ' +
        `möglich. Ab Adapter ${ADAPTER_MINDESTVERSION} meldet er sie; ` +
        'ältere Fassungen nehmen die Alarme ohnehin nicht entgegen.',
    };
  }
  if (!versionGenuegt(adapterVersion, ADAPTER_MINDESTVERSION)) {
    return { art: 'zuAlt', text: adapterZuAlt(adapterVersion) };
  }
  return {
    art: 'passt',
    text:
      `Adapter ${adapterVersion} und Analyzer ${eigeneVersion} passen ` +
      `zueinander (nötig wäre Adapter ab ${ADAPTER_MINDESTVERSION}).`,
  };
}
