import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ANTWORT_KARENZ_MS,
  WIEDERHOLUNG_FENSTER_MS,
  findeSendergruppen,
  werteFunklastAus,
} from '../src/analytics/funklast.ts';
import type { FunkZeile } from '../src/analytics/funklast.ts';

const CCU = 0x27508b;
const GERAET = 0x54192c;
const T0 = 1_800_000_000_000;

/** BURST-Flag laut decode/flags.ts. */
const BURST = 0x10;

function z(teil: Partial<FunkZeile> & { ts: number }): FunkZeile {
  return {
    from: CCU, to: GERAET, cnt: 100, type: 0x11, flags: 0, len: 25, rssi: -44,
    ...teil,
  };
}
/** Eine Quittung des Geräts — dieselbe Zählernummer, Gegenrichtung. */
function ack(ts: number, cnt: number, rssi = -76): FunkZeile {
  return z({ ts, cnt, from: GERAET, to: CCU, type: 0x02, len: 14, rssi });
}

test('Wiederholungen desselben Zaehlers sind EIN Vorgang', () => {
  const last = werteFunklastAus(
    [z({ ts: T0, cnt: 123 }), z({ ts: T0 + 288, cnt: 123 }),
      z({ ts: T0 + 576, cnt: 123 }), z({ ts: T0 + 864, cnt: 123 })],
    T0, T0 + 3_600_000,
  );
  const a = last.absender[0]!;
  assert.equal(a.vorgaenge, 1, 'ein Befehl');
  assert.equal(a.sendungen, 4);
  assert.equal(a.wiederholungen, 3);
  assert.equal(a.ohneAntwort, 1, 'niemand hat geantwortet');
  assert.equal(a.vergeblich, 0, 'ohne gehoerte Antwort ist nichts vergeblich');
});

test('Wiederholung nach gehoerter Antwort — der eigentliche Befund', () => {
  // Woertlich der Ablauf vom 26.08.2026, 11:28:40:
  //   .223 Zentrale -> Geraet, Burst
  //   .335 Geraet   -> Zentrale, Quittung   (der Analyzer hoert sie)
  //   .868 Zentrale -> Geraet, DERSELBE Befehl noch einmal
  // Die Zentrale hat die Quittung also nicht bekommen: Der Rueckweg ist das
  // Nadeloehr, nicht das Geraet.
  const last = werteFunklastAus(
    [
      z({ ts: T0, cnt: 124, flags: BURST }),
      ack(T0 + 112, 124),
      z({ ts: T0 + 645, cnt: 124, flags: BURST }),
      ack(T0 + 757, 124),
    ],
    T0, T0 + 3_600_000,
  );
  const zentrale = last.absender.find((a) => a.addr === CCU)!;
  assert.equal(zentrale.vorgaenge, 1);
  assert.equal(zentrale.sendungen, 2);
  assert.equal(zentrale.vergeblich, 1, 'die zweite Sendung war vergeblich');
  assert.equal(zentrale.ohneAntwort, 0);
  assert.equal(zentrale.paare[0]!.rssiAntwort, -76, 'so laut hoert der Analyzer die Antwort');
});

test('eine Antwort im selben Augenblick ist keine vergebliche Wiederholung', () => {
  // Antwort und Wiederholung koennen sich um Millisekunden ueberschneiden —
  // der Absender hatte dann schon losgesendet. Das ist Physik, kein Befund.
  const knapp = werteFunklastAus(
    [z({ ts: T0, cnt: 50 }), ack(T0 + 10, 50), z({ ts: T0 + 10 + ANTWORT_KARENZ_MS, cnt: 50 })],
    T0, T0 + 3_600_000,
  );
  assert.equal(knapp.absender.find((a) => a.addr === CCU)!.vergeblich, 0);
  const deutlich = werteFunklastAus(
    [z({ ts: T0, cnt: 50 }), ack(T0 + 10, 50), z({ ts: T0 + 500, cnt: 50 })],
    T0, T0 + 3_600_000,
  );
  assert.equal(deutlich.absender.find((a) => a.addr === CCU)!.vergeblich, 1);
});

test('derselbe Zaehler nach langer Pause ist ein neuer Vorgang', () => {
  // Der Zaehler ist ein Byte und laeuft nach 256 Vorgaengen ueber. Ohne
  // Zeitfenster wuerden zwei Befehle einer Stunde spaeter zu einem
  // zusammengefasst — und die Wiederholungszahl waere frei erfunden.
  const last = werteFunklastAus(
    [z({ ts: T0, cnt: 7 }), z({ ts: T0 + WIEDERHOLUNG_FENSTER_MS + 1, cnt: 7 })],
    T0, T0 + 3_600_000,
  );
  const a = last.absender[0]!;
  assert.equal(a.vorgaenge, 2);
  assert.equal(a.wiederholungen, 0);
});

test('Bursts bestimmen die Sendezeit, nicht die Stueckzahl', () => {
  // Der Kern des Falls: Ein Burst kostet 360 ms Dauertraeger, ein normales
  // Telegramm rund 29 ms. Wer nur Telegramme zaehlt, sieht nichts.
  const normal = werteFunklastAus(
    Array.from({ length: 10 }, (_, i) => z({ ts: T0 + i * 1000, cnt: i })),
    T0, T0 + 3_600_000,
  ).absender[0]!;
  const mitBurst = werteFunklastAus(
    Array.from({ length: 10 }, (_, i) => z({ ts: T0 + i * 1000, cnt: i, flags: BURST })),
    T0, T0 + 3_600_000,
  ).absender[0]!;
  assert.equal(normal.sendungen, mitBurst.sendungen, 'gleich viele Telegramme');
  assert.ok(mitBurst.sendezeitMs > normal.sendezeitMs * 10,
    `Burst kostet ein Vielfaches: ${mitBurst.sendezeitMs} gegen ${normal.sendezeitMs}`);
  assert.equal(mitBurst.bursts, 10);
  // Zehn Bursts = zehn Prozentpunkte des Stundenkontingents.
  assert.ok(Math.abs(mitBurst.prozentJeStunde - 10) < 1.5,
    `erwartet rund 10 %, bekommen ${mitBurst.prozentJeStunde.toFixed(1)} %`);
});

test('HmIP-Telegramme gelten nicht als Burst', () => {
  // Wie in dutyCycle.ts: Die Referenz wertet die Flags bei HmIP nicht aus.
  // Ohne diese Ausnahme haette jedes HmIP-Telegramm mit gesetztem Bit
  // 360 ms gekostet — und die Anzeige waere Unsinn.
  //
  // HmIP beginnt bei Typ 0x80 (msgTypes.ts). Mein erster Testwert 0x5E war
  // KEIN HmIP, sondern das Leistungstelegramm des Schaltaktors — der Test
  // haette also nie geprueft, was er zu pruefen vorgab.
  const hmip = werteFunklastAus([z({ ts: T0, type: 0x83, flags: BURST })], T0, T0 + 3_600_000);
  assert.equal(hmip.absender[0]!.bursts, 0);
});

test('Sendergruppen trennen zwei Gateways unter einer Adresse', () => {
  // Der Fund, der den Fall entschieden hat: Alle LAN-Gateways einer CCU
  // senden mit der Adresse der Zentrale. Auseinanderhalten lassen sie sich
  // nur an der Empfangsstaerke.
  const nah = Array.from({ length: 60 }, (_, i) =>
    z({ ts: T0 + i * 100, cnt: i, rssi: -44 - (i % 3), flags: BURST }));
  const fern = Array.from({ length: 40 }, (_, i) =>
    z({ ts: T0 + 10_000 + i * 100, cnt: i, rssi: -76 - (i % 5) }));
  const gruppen = findeSendergruppen([...nah, ...fern]);
  assert.equal(gruppen.length, 2, 'zwei Sender');
  const [laut, leise] = gruppen;
  assert.ok(laut!.rssi > -50 && laut!.rssi < -42, `nahes Gateway: ${laut!.rssi} dBm`);
  assert.ok(leise!.rssi < -70, `fernes Gateway: ${leise!.rssi} dBm`);
  assert.equal(laut!.bursts, 60, 'die Bursts kommen aus dem lauten Gipfel');
  assert.equal(leise!.bursts, 0);
});

test('ein einzelner Sender ergibt genau eine Gruppe', () => {
  // Der Normalfall. Waere hier eine Aufteilung zu sehen, muesste man ihr
  // nachgehen — die Anzeige darf sie deshalb nicht aus Rauschen erfinden.
  const zeilen = Array.from({ length: 50 }, (_, i) =>
    z({ ts: T0 + i * 100, cnt: i, rssi: -70 - (i % 7) }));
  assert.equal(findeSendergruppen(zeilen).length, 1);
  assert.equal(findeSendergruppen([]).length, 0);
});

test('Quittungen zaehlen zur Sendezeit ihres Absenders, aber nicht als Vorgang', () => {
  // Sie belegen das Band wie alles andere. Als eigener Vorgang gezaehlt
  // wuerden sie die Wiederholungsquote des Geraets verwaessern.
  const last = werteFunklastAus(
    [z({ ts: T0, cnt: 5 }), ack(T0 + 100, 5)],
    T0, T0 + 3_600_000,
  );
  const geraet = last.absender.find((a) => a.addr === GERAET)!;
  assert.equal(geraet.vorgaenge, 0, 'eine Quittung ist kein eigener Vorgang');
  assert.ok(geraet.sendezeitMs > 0, 'sie kostet trotzdem Sendezeit');
});

test('der gesamte Fall vom 26.08.2026 in einem Durchlauf', () => {
  // 26 Befehle in einer Stunde, jeder dreimal gesendet, ab dem zweiten Mal
  // als Burst, und jedes Mal hatte das Geraet laengst geantwortet.
  const zeilen: FunkZeile[] = [];
  for (let i = 0; i < 26; i++) {
    const t = T0 + i * 140_000;
    zeilen.push(z({ ts: t, cnt: i }));
    zeilen.push(ack(t + 112, i));
    zeilen.push(z({ ts: t + 645, cnt: i, flags: BURST }));
    zeilen.push(ack(t + 757, i));
    zeilen.push(z({ ts: t + 1290, cnt: i, flags: BURST }));
  }
  zeilen.sort((a, b) => a.ts - b.ts);
  const last = werteFunklastAus(zeilen, T0, T0 + 3_600_000);
  const zentrale = last.absender.find((a) => a.addr === CCU)!;

  assert.equal(zentrale.vorgaenge, 26);
  assert.equal(zentrale.sendungen, 78);
  assert.equal(zentrale.wiederholungen, 52);
  assert.equal(zentrale.vergeblich, 52, 'jede Wiederholung war vergeblich');
  assert.equal(zentrale.bursts, 52);
  // 52 Bursts = 52 Prozentpunkte, plus die kurzen Erstsendungen.
  assert.ok(zentrale.prozentJeStunde > 50 && zentrale.prozentJeStunde < 60,
    `erwartet gut 50 %, bekommen ${zentrale.prozentJeStunde.toFixed(1)} %`);
  // Ohne die Wiederholungen waere es ein Bruchteil davon — die Zahl, die den
  // Unterschied zwischen "harmlos" und "Kontingent erschoepft" ausmacht.
  const ohne = werteFunklastAus(
    zeilen.filter((x) => (x.flags & BURST) === 0), T0, T0 + 3_600_000,
  ).absender.find((a) => a.addr === CCU)!;
  assert.ok(ohne.prozentJeStunde < 3,
    `ohne Wiederholungen nur ${ohne.prozentJeStunde.toFixed(1)} %`);
  assert.ok(zentrale.anteilWiederholung > 0.6,
    `Anteil der Wiederholungen an der Sendezeit: ${zentrale.anteilWiederholung.toFixed(2)}`);
});
