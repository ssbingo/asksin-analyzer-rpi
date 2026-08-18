/**
 * Echte Zeilen des Zigbee-Mithörers — mit einer Änderung.
 *
 * Aufgenommen am 18.08.2026 an Analyzer 04. **Der Aufbau der Rahmen ist
 * unverändert**: Rahmenart, Flags, Adressierungsmodi, Folgenummern und
 * die Lage jedes Feldes stammen aus der Aufnahme. Genau darauf kommt es
 * an — das ist der Teil, den ein Decoder falsch machen kann.
 *
 * Ersetzt wurden PAN-ID, Kurzadressen und die Nutzdaten. Grund: In den
 * Nutzdaten stehen IEEE-Adressen, also weltweit eindeutige Kennungen der
 * Geräte samt Herstellerpräfix. Das Repo ist öffentlich.
 *
 * Die Erwartungswerte unten stammen aus der Ersetzung, NICHT aus einem
 * Lauf des Parsers. Ein Parser, der dieselbe falsche Annahme trifft wie
 * sein Test, ist grün und trotzdem kaputt — im BidCoS-Pfad ist genau das
 * schon einmal passiert.
 */

export interface ZigbeeFixture {
  readonly name: string;
  readonly line: string;
  readonly typ: string;
  readonly seq: number;
  readonly kanal: number;
  readonly rssi: number;
  readonly lqi: number;
  readonly laenge: number;
  readonly pan?: string;
  readonly von?: string;
  readonly an?: string;
  readonly rundruf: boolean;
  readonly ackErbeten: boolean;
}

export const ZIGBEE_PAKETE: readonly ZigbeeFixture[] = [
  {
    name: 'daten #1',
    line: '{"L":74,"Q":255,"R":-85,"C":11,"S":"418898CDABFFFF2222AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}',
    typ: 'daten',
    seq: 152,
    kanal: 11, rssi: -85, lqi: 255, laenge: 74,
    pan: 'ABCD',
    von: '2222',
    an: 'FFFF',
    rundruf: true,
    ackErbeten: false,
  },
  {
    name: 'bestaetigung #2',
    line: '{"L":5,"Q":255,"R":-29,"C":11,"S":"020077AAAA"}',
    typ: 'bestaetigung',
    seq: 119,
    kanal: 11, rssi: -29, lqi: 255, laenge: 5,
    rundruf: false,
    ackErbeten: false,
  },
  {
    name: 'bestaetigung #3',
    line: '{"L":5,"Q":43,"R":-90,"C":11,"S":"02007EAAAA"}',
    typ: 'bestaetigung',
    seq: 126,
    kanal: 11, rssi: -90, lqi: 43, laenge: 5,
    rundruf: false,
    ackErbeten: false,
  },
  {
    name: 'daten #4',
    line: '{"L":52,"Q":13,"R":-89,"C":11,"S":"618883CDAB33334444AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}',
    typ: 'daten',
    seq: 131,
    kanal: 11, rssi: -89, lqi: 13, laenge: 52,
    pan: 'ABCD',
    von: '4444',
    an: '3333',
    rundruf: false,
    ackErbeten: true,
  },
  {
    name: 'daten #5',
    line: '{"L":47,"Q":255,"R":-31,"C":11,"S":"6188EBCDAB55550000AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}',
    typ: 'daten',
    seq: 235,
    kanal: 11, rssi: -31, lqi: 255, laenge: 47,
    pan: 'ABCD',
    von: '0000',
    an: '5555',
    rundruf: false,
    ackErbeten: true,
  },
];
