/**
 * Empfangsbalken — die fünf Stufen, die jeder vom Mobiltelefon kennt.
 *
 * ## Warum nicht einfach der RSSI
 *
 * Der CC1101 liefert einen Rohwert, den die Firmware nach der Vorschrift aus
 * dem Datenblatt in dBm umrechnet (`reference/AskSinPP/Radio-CC1101.h`):
 *
 *     RSSI[dBm] = Rohwert/2 − 74
 *
 * Die 74 dB sind ein **typischer** Wert des Datenblatts, kein für dieses
 * Bauteil gemessener. Zwei Module derselben Bauart können daher denselben
 * Sender mit leicht verschiedenen dBm ausweisen, ohne dass eines schlechter
 * empfinge. Ein Balken, der unmittelbar am dBm hinge, würde diese
 * Bauteilstreuung anzeigen und als Empfangsunterschied ausgeben.
 *
 * ## Was stattdessen gemessen wird
 *
 * Für BidCoS der **Störabstand**: Nutzsignal minus Grundrauschen, beides vom
 * *selben* Modul gemessen. Der unbekannte Versatz steckt in beiden Summanden
 * und **kürzt sich weg**. Was bleibt, ist die Grösse, die tatsächlich
 * darüber entscheidet, ob ein Telegramm ankommt.
 *
 * Für Zigbee der **LQI**: Die Sniffer-Firmware liefert kein Grundrauschen
 * (Leitentscheidung E5), dafür je Paket eine Güte von 0 bis 255 — sie sagt,
 * wie sauber das Signal ankam, und ist bereits ein Qualitätsmass.
 *
 * ## Woher die Schwellen stammen
 *
 * Gemessen am 19.08.2026 an drei laufenden Analyzern und 38 Zigbee-Geräten,
 * nicht geschätzt. Die Werte stehen bei den Tabellen.
 */

/** Fünf Stufen wie beim Mobiltelefon; 0 heisst „keine Aussage möglich". */
export type Balken = 0 | 1 | 2 | 3 | 4 | 5;

/**
 * Störabstand in dB → Balken.
 *
 * Gemessene Lage der drei Analyzer am 19.08.2026:
 *
 * | Standort    | Median-RSSI | Rauschen | Störabstand |
 * | ----------- | ----------- | -------- | ----------- |
 * | Keller Büro | −74 dBm     | −115 dBm | **41 dB**   |
 * | Dachboden   | −78 dBm     | −111 dBm | **33 dB**   |
 * | Gartenhaus  | −86 dBm     | −116 dBm | **30 dB**   |
 *
 * Die Skala ist so gelegt, dass diese drei bei vier bis fünf Balken stehen —
 * sie empfangen gut, und das soll der Balken auch sagen. Die unteren Stufen
 * sind für den Fall da, für den das Gerät gebaut ist: wenn es schlechter
 * wird.
 *
 * Unter 12 dB bleibt ein Balken stehen und nicht null: Null heisst „keine
 * Aussage", und das wäre etwas anderes als „sehr schlecht".
 *
 * @param db Störabstand in dB, oder null, wenn eine der beiden Grössen fehlt.
 */
export function balkenAusStoerabstand(db: number | null): Balken {
  if (db === null || !Number.isFinite(db)) return 0;
  if (db >= 40) return 5;
  if (db >= 30) return 4;
  if (db >= 20) return 3;
  if (db >= 12) return 2;
  return 1;
}

/**
 * LQI (0…255) → Balken.
 *
 * Gemessen am 18.08.2026 über 24 Stunden an 38 Zigbee-Geräten. Der
 * Zusammenhang zwischen Pegel und Güte ist **keine Gerade, sondern eine
 * Kante**:
 *
 * | RSSI       | gemessener LQI |
 * | ---------- | -------------- |
 * | −26…−62    | 255            |
 * | −63…−79    | 237…254        |
 * | −80…−86    | 149…237        |
 * | **−87**    | **108**        |
 * | −88…−89    | 8…60           |
 * | −90 und darunter | 0…10     |
 *
 * Zwischen −86 und −90 dBm liegen vier Dezibel, und die Güte fällt dabei von
 * 149 auf 0. Die Schwellen liegen deshalb dort, wo die Kante ist, und nicht
 * in gleichen Abständen: Ein Gerät bei LQI 120 ist keine „halbe" Verbindung,
 * sondern eine, die beim nächsten verschobenen Möbel abreisst.
 *
 * @param lqi Mittlere Verbindungsgüte, oder null ohne Messung.
 */
export function balkenAusLqi(lqi: number | null): Balken {
  if (lqi === null || !Number.isFinite(lqi) || lqi <= 0) return 0;
  if (lqi >= 240) return 5;
  if (lqi >= 180) return 4;
  if (lqi >= 120) return 3;
  if (lqi >= 60) return 2;
  return 1;
}

/**
 * Median einer Zahlenreihe — oder null, wenn sie leer ist.
 *
 * Median und nicht Mittelwert: Ein einziges sehr nahes Gerät (der
 * Zigbee-Koordinator sitzt oft im selben Raum) zöge den Mittelwert nach oben
 * und liesse die Anzeige besser aussehen, als der Empfang ist.
 */
export function median(werte: readonly number[]): number | null {
  const gueltig = werte.filter((w) => Number.isFinite(w)).sort((a, b) => a - b);
  if (gueltig.length === 0) return null;
  const mitte = gueltig.length >> 1;
  return gueltig.length % 2 === 1
    ? gueltig[mitte]!
    : ((gueltig[mitte - 1]! + gueltig[mitte]!) / 2);
}
