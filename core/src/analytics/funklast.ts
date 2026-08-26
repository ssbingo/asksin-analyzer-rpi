/**
 * Funklast: Wer verbraucht die Sendezeit — und wie viel davon ist vergeblich?
 *
 * ## Woher das kommt
 *
 * Am 26.08.2026 meldete die CCU für das Gateway LanGW03 einen Duty-Cycle von
 * über 100 %. Die Ursache zu finden kostete eine Stunde Handarbeit an der
 * Datenbank. Herausgekommen ist eine Kette, die sich jedes Mal gleich liest:
 *
 * 1. Ein Absender verbraucht auffällig viel **Sendezeit** — nicht auffällig
 *    viele Telegramme. Beides auseinanderzuhalten ist der erste Schritt: Die
 *    Telegrammzahl stieg damals von 219 auf 345, die Sendezeit aber von 4,6 s
 *    auf 30 s.
 * 2. Der Grund dafür sind **Bursts**: 360 ms Dauerträger statt ~10 ms. Ein
 *    einziger Burst kostet einen vollen Prozentpunkt des Stundenkontingents.
 * 3. Bursts entstehen, wenn ein Befehl **wiederholt** werden muss. Die
 *    Zentrale schaltet ab dem zweiten Versuch auf Burst.
 * 4. Und wiederholt wird, weil die **Quittung nicht ankommt** — nicht etwa,
 *    weil das Gerät nicht antwortet. Genau das kann nur ein Mithörer sagen:
 *    Er hört beide Seiten. Hört er die Antwort und sendet der Absender
 *    trotzdem noch einmal, ist der **Rückweg** das Nadelöhr.
 *
 * Punkt 4 ist der eigentliche Wert dieses Geräts. Eine CCU sieht nur, dass sie
 * wiederholen muss; sie kann nicht wissen, ob das Gerät geantwortet hat.
 *
 * ## Was hier gerechnet wird und was nicht
 *
 * Gerechnet wird aus Länge, Flags und Zählern — alles, was in der Datenbank
 * steht. Die Sendezeit ist wie überall im Projekt eine **Schätzung** aus
 * Längenbyte und Datenrate (siehe dutyCycle.ts), kein Messwert. Für die Frage
 * „wer verbraucht das Kontingent" ist sie belastbar; als Absolutwert gehört
 * sie gegen die CCU-Anzeige gehalten.
 */

import { hasFlag } from '../decode/flags.ts';
import { isHmIpType } from '../decode/msgTypes.ts';
import { MS_PER_PERCENT, estimateAirtimeMs } from './dutyCycle.ts';

/** Eine Zeile aus der Telegramm-Tabelle — nur die Spalten, die hier zählen. */
export interface FunkZeile {
  ts: number;
  from: number;
  to: number;
  cnt: number;
  type: number;
  flags: number;
  len: number;
  rssi: number;
}

/**
 * Wie lange nach der ersten Sendung eine weitere mit **demselben Zähler** noch
 * als Wiederholung gilt.
 *
 * Der Zähler ist ein Byte und läuft nach 256 Vorgängen über; zwei Befehle
 * können denselben tragen, wenn genug Zeit dazwischen liegt. Fünf Sekunden
 * sind großzügig gegenüber allem, was HomeMatic an Wiederholungen kennt
 * (gemessen: 288 ms bis 1,2 s Abstand), und kurz genug, dass ein
 * Zählerüberlauf nicht zwei Vorgänge zusammenwirft.
 */
export const WIEDERHOLUNG_FENSTER_MS = 5000;

/**
 * Wie lange nach einer gehörten Antwort eine Sendung noch „gleichzeitig" ist.
 *
 * Antwort und Wiederholung können sich um Millisekunden überschneiden — der
 * Absender hatte dann schon losgesendet, als die Antwort kam. Das ist keine
 * vergebliche Wiederholung, sondern Physik. 50 ms decken das ab; die
 * gemessenen echten Fälle lagen bei 500 ms und mehr.
 */
export const ANTWORT_KARENZ_MS = 50;

/** ACK — Antworten zählen nicht als eigener Vorgang. */
const TYP_ACK = 0x02;

/** Ein Absender-Empfänger-Paar. */
export interface FunkPaar {
  an: number;
  /** Verschiedene Vorgänge (Befehle oder Meldungen). */
  vorgaenge: number;
  sendungen: number;
  wiederholungen: number;
  /** Wiederholungen, obwohl der Analyzer die Antwort bereits gehört hatte. */
  vergeblich: number;
  /** Vorgänge, auf die gar keine Antwort kam. */
  ohneAntwort: number;
  bursts: number;
  sendezeitMs: number;
  /** Mittlere Empfangsstärke der Antworten; null, wenn keine kamen. */
  rssiAntwort: number | null;
}

/**
 * Eine Gruppe gleich lauter Sendungen unter derselben Adresse.
 *
 * Mehrere LAN-Gateways einer CCU senden **alle mit der Adresse der Zentrale**.
 * Auseinanderhalten lassen sie sich nur an der Empfangsstärke — und genau das
 * hat den Fall vom 26.08.2026 entschieden: 1054 Telegramme bei −44 dBm (das
 * Gateway nebenan) gegen 520 bei −72 bis −80 dBm (eine andere Schnittstelle),
 * und 77 von 81 Bursts kamen aus dem lauten Gipfel.
 */
export interface Sendergruppe {
  /** Mittlere Empfangsstärke dieser Gruppe. */
  rssi: number;
  sendungen: number;
  bursts: number;
  sendezeitMs: number;
}

export interface FunkAbsender {
  addr: number;
  vorgaenge: number;
  sendungen: number;
  wiederholungen: number;
  vergeblich: number;
  ohneAntwort: number;
  bursts: number;
  sendezeitMs: number;
  /** Anteil der Sendezeit, der auf Wiederholungen entfällt (0…1). */
  anteilWiederholung: number;
  /** Verbrauch am 1-%-Kontingent, im Mittel je Stunde des Fensters. */
  prozentJeStunde: number;
  /** Mehr als eine Gruppe = mehrere Geräte senden unter dieser Adresse. */
  gruppen: Sendergruppe[];
  paare: FunkPaar[];
}

export interface Funklast {
  vonMs: number;
  bisMs: number;
  /** Ausgewertete Telegramme. */
  zeilen: number;
  absender: FunkAbsender[];
}

function burstAnteil(z: FunkZeile): boolean {
  // Wie in dutyCycle.ts: Bei HmIP wertet die Referenz die Flags nicht aus.
  return !isHmIpType(z.type) && hasFlag(z.flags, 'BURST');
}

function sendezeit(z: FunkZeile): number {
  return estimateAirtimeMs(z.len, burstAnteil(z));
}

/**
 * Teilt die Empfangsstärken eines Absenders in Gruppen.
 *
 * Bewusst grob: 4-dB-Klassen, benachbarte Klassen wachsen zusammen, und eine
 * Gruppe zählt erst ab 5 % der Sendungen. Damit entstehen keine Gruppen aus
 * Rauschen, aber zwei Gateways mit 30 dB Abstand fallen sofort auseinander.
 *
 * Eine einzelne Gruppe ist der Normalfall und die langweilige Antwort — die
 * Oberfläche zeigt die Aufteilung nur, wenn es mehr als eine gibt.
 */
export function findeSendergruppen(zeilen: readonly FunkZeile[]): Sendergruppe[] {
  if (zeilen.length === 0) return [];
  const klassen = new Map<number, FunkZeile[]>();
  for (const z of zeilen) {
    const k = Math.floor(z.rssi / 4) * 4;
    const liste = klassen.get(k);
    if (liste === undefined) klassen.set(k, [z]);
    else liste.push(z);
  }
  const mindest = Math.max(3, zeilen.length * 0.05);
  const stark = [...klassen.entries()]
    .filter(([, l]) => l.length >= mindest)
    .sort((a, b) => a[0] - b[0]);

  const gruppen: Sendergruppe[] = [];
  let aktuell: FunkZeile[] = [];
  let letzteKlasse: number | null = null;
  const abschliessen = (): void => {
    if (aktuell.length === 0) return;
    gruppen.push({
      rssi: Math.round(aktuell.reduce((s, z) => s + z.rssi, 0) / aktuell.length),
      sendungen: aktuell.length,
      bursts: aktuell.filter(burstAnteil).length,
      sendezeitMs: aktuell.reduce((s, z) => s + sendezeit(z), 0),
    });
    aktuell = [];
  };
  for (const [k, liste] of stark) {
    // Mehr als eine leere Klasse dazwischen = eigener Sender.
    if (letzteKlasse !== null && k - letzteKlasse > 8) abschliessen();
    aktuell.push(...liste);
    letzteKlasse = k;
  }
  abschliessen();
  return gruppen.sort((a, b) => b.sendezeitMs - a.sendezeitMs);
}

/**
 * Wertet ein Zeitfenster aus.
 *
 * @param zeilen Alle Telegramme des Fensters, **nach Zeit sortiert**.
 * @param vonMs Beginn des Fensters.
 * @param bisMs Ende des Fensters.
 */
export function werteFunklastAus(
  zeilen: readonly FunkZeile[],
  vonMs: number,
  bisMs: number,
): Funklast {
  /** Antworten nachschlagen: Empfänger+Zähler → Zeitpunkt und Empfangsstärke. */
  const antworten = new Map<string, Array<{ ts: number; rssi: number }>>();
  for (const z of zeilen) {
    const schluessel = `${z.to}:${z.from}:${z.cnt}`;
    const liste = antworten.get(schluessel);
    if (liste === undefined) antworten.set(schluessel, [{ ts: z.ts, rssi: z.rssi }]);
    else liste.push({ ts: z.ts, rssi: z.rssi });
  }

  /** Ein laufender Vorgang je Absender/Empfänger/Zähler. */
  interface Vorgang {
    erste: number;
    letzte: number;
    sendungen: FunkZeile[];
  }
  const offen = new Map<string, Vorgang>();
  const fertige: Array<{ von: number; an: number; v: Vorgang }> = [];

  for (const z of zeilen) {
    // Reine Quittungen sind Antworten, keine eigenen Vorgänge. Sie zählen
    // trotzdem zur Sendezeit ihres Absenders — sie belegen das Band.
    if (z.type === TYP_ACK) continue;
    const schluessel = `${z.from}:${z.to}:${z.cnt}`;
    const laufend = offen.get(schluessel);
    if (laufend !== undefined && z.ts - laufend.letzte <= WIEDERHOLUNG_FENSTER_MS) {
      laufend.letzte = z.ts;
      laufend.sendungen.push(z);
      continue;
    }
    if (laufend !== undefined) {
      fertige.push({ von: z.from, an: z.to, v: laufend });
    }
    offen.set(schluessel, { erste: z.ts, letzte: z.ts, sendungen: [z] });
  }
  for (const [schluessel, v] of offen) {
    const [von, an] = schluessel.split(':').map(Number);
    fertige.push({ von: von!, an: an!, v });
  }

  // Zusammenfassen je Absender und Paar.
  interface Roh extends Omit<FunkPaar, 'rssiAntwort'> {
    antwortRssi: number[];
  }
  const jeAbsender = new Map<number, Map<number, Roh>>();
  const leer = (an: number): Roh => ({
    an, vorgaenge: 0, sendungen: 0, wiederholungen: 0, vergeblich: 0,
    ohneAntwort: 0, bursts: 0, sendezeitMs: 0, antwortRssi: [],
  });

  for (const { von, an, v } of fertige) {
    const paare = jeAbsender.get(von) ?? new Map<number, Roh>();
    jeAbsender.set(von, paare);
    const p = paare.get(an) ?? leer(an);
    paare.set(an, p);

    p.vorgaenge += 1;
    p.sendungen += v.sendungen.length;
    p.wiederholungen += v.sendungen.length - 1;
    p.bursts += v.sendungen.filter(burstAnteil).length;
    p.sendezeitMs += v.sendungen.reduce((s, z) => s + sendezeit(z), 0);

    const cnt = v.sendungen[0]!.cnt;
    const alle = antworten.get(`${von}:${an}:${cnt}`) ?? [];
    // Nur Antworten, die zu DIESEM Vorgang gehören — ein späterer Vorgang mit
    // demselben Zähler hat seine eigenen.
    const passend = alle.filter(
      (a) => a.ts >= v.erste && a.ts <= v.letzte + WIEDERHOLUNG_FENSTER_MS,
    );
    if (passend.length === 0) {
      p.ohneAntwort += 1;
    } else {
      const erste = passend[0]!.ts;
      p.vergeblich += v.sendungen.filter((z) => z.ts > erste + ANTWORT_KARENZ_MS).length;
      // Wie laut hört der Analyzer die Gegenseite? Bei einem schwachen
      // Rückweg ist das die Zahl, die man als Nächstes wissen will.
      for (const a of passend) p.antwortRssi.push(a.rssi);
    }
  }

  // Sendezeit der Quittungen ihrem Absender zuschlagen — sonst fehlte sie in
  // der Gesamtrechnung, und die Summe stimmte nicht mit dem Duty-Cycle überein.
  const ackZeit = new Map<number, number>();
  for (const z of zeilen) {
    if (z.type !== TYP_ACK) continue;
    ackZeit.set(z.from, (ackZeit.get(z.from) ?? 0) + sendezeit(z));
  }

  // Ein Geraet, das in diesem Fenster NUR quittiert hat, taucht sonst gar
  // nicht auf — seine Sendezeit fehlte dann in der Gesamtrechnung, obwohl sie
  // das Band genauso belegt. Es bekommt einen Eintrag ohne Vorgaenge.
  for (const addr of ackZeit.keys()) {
    if (!jeAbsender.has(addr)) jeAbsender.set(addr, new Map<number, Roh>());
  }

  const jeSender = new Map<number, FunkZeile[]>();
  for (const z of zeilen) {
    const l = jeSender.get(z.from);
    if (l === undefined) jeSender.set(z.from, [z]);
    else l.push(z);
  }

  const stunden = Math.max(1 / 60, (bisMs - vonMs) / 3_600_000);
  const absender: FunkAbsender[] = [];
  for (const [addr, paare] of jeAbsender) {
    const liste = [...paare.values()];
    const sendezeitMs =
      liste.reduce((s, p) => s + p.sendezeitMs, 0) + (ackZeit.get(addr) ?? 0);
    const wiederholungen = liste.reduce((s, p) => s + p.wiederholungen, 0);
    const sendungen = liste.reduce((s, p) => s + p.sendungen, 0);
    absender.push({
      addr,
      vorgaenge: liste.reduce((s, p) => s + p.vorgaenge, 0),
      sendungen,
      wiederholungen,
      vergeblich: liste.reduce((s, p) => s + p.vergeblich, 0),
      ohneAntwort: liste.reduce((s, p) => s + p.ohneAntwort, 0),
      bursts: liste.reduce((s, p) => s + p.bursts, 0),
      sendezeitMs,
      // Anteil an der Sendezeit, nicht an der Stückzahl: Ein wiederholter
      // Burst wiegt vierzigmal so schwer wie ein wiederholtes Kurztelegramm,
      // und genau das ist ja der Punkt.
      anteilWiederholung:
        sendungen === 0 ? 0 : liste.reduce(
          (s, p) => s + (p.sendungen === 0 ? 0 : p.sendezeitMs * (p.wiederholungen / p.sendungen)),
          0,
        ) / Math.max(1, sendezeitMs),
      prozentJeStunde: sendezeitMs / stunden / MS_PER_PERCENT,
      gruppen: findeSendergruppen(jeSender.get(addr) ?? []),
      paare: liste
        .map(({ antwortRssi, ...rest }) => ({
          ...rest,
          rssiAntwort:
            antwortRssi.length === 0
              ? null
              : Math.round(antwortRssi.reduce((a, b) => a + b, 0) / antwortRssi.length),
        }))
        .sort((a, b) => b.sendezeitMs - a.sendezeitMs),
    });
  }
  absender.sort((a, b) => b.sendezeitMs - a.sendezeitMs);

  return { vonMs, bisMs, zeilen: zeilen.length, absender };
}
