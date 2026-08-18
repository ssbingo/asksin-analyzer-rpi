/**
 * Empfangsmatrix für Zigbee: Welcher Standort hört welches Gerät wie gut?
 *
 * Das ist der eigentliche Ertrag des ganzen Vorhabens. Ein einzelner Standort
 * kann zwei Fälle nicht unterscheiden, die völlig verschiedene Folgen haben:
 *
 *   * Das Gerät sendet nicht (leer, defekt, abgemeldet).
 *   * Das Gerät sendet, aber dieser Standort hört es nicht.
 *
 * Sobald ein zweiter Standort mithört, trennen sich die beiden. Wird ein Gerät
 * nirgends gehört, obwohl die Steuerung es kennt, ist es tatsächlich still.
 *
 * Bewusst als **reine Funktion**: Sie bekommt fertige Gerätelisten und liefert
 * die Matrix. Kein Netzwerk, keine Uhr, keine Datenbank — damit ist jeder Fall
 * exakt prüfbar, auch die, die man im Betrieb kaum herstellen kann (ein
 * Standort ohne Stick, ein Gerät mit wechselnder Kurzadresse, zwei Netze mit
 * derselben Kurzadresse).
 */

/** Was ein Standort über ein Gerät berichtet. */
export interface StandortGeraet {
  pan: number;
  addr: string;
  /** IEEE-Adresse, sofern der Standort sie gelernt hat. */
  ieee?: string;
  name?: string;
  pakete: number;
  sum_rssi: number;
  sum_lqi: number;
  schwach: number;
}

export interface StandortBericht {
  standort: string;
  /** Nicht erreichbar? Dann steht der Standort in der Matrix, aber ohne Werte. */
  erreichbar: boolean;
  geraete: StandortGeraet[];
}

/** Ein Gerät aus der Sollmenge (deCONZ) — nur der Master kennt sie. */
export interface SollGeraet {
  ieee: string;
  name: string;
}

export interface MatrixEmpfang {
  rssi: number;
  lqi: number;
  pakete: number;
  /** Anteil schwach empfangener Pakete in Prozent. */
  schwachProzent: number;
}

export interface ZigbeeMatrixGeraet {
  /** Stabile Kennung, wenn bekannt — sonst die Kurzadresse. */
  ieee: string | null;
  addr: string;
  pan: number;
  name: string;
  /** Standortname → Empfang; fehlt der Eintrag, hat der Standort nichts gehört. */
  empfang: Record<string, MatrixEmpfang>;
  /** Standort mit dem besten Empfang (höchster RSSI). */
  beste: string | null;
  /** Von niemandem gehört — steht nur in der Sollmenge. */
  nirgends: boolean;
}

export interface ZigbeeMatrix {
  standorte: string[];
  /** Standorte, die gerade nicht antworten — ihre Spalten sind nicht leer, sondern unbekannt. */
  nichtErreichbar: string[];
  geraete: ZigbeeMatrixGeraet[];
  /** Kurzfassung für die Kopfzeile. */
  zusammenfassung: {
    gesamt: number;
    nirgends: number;
    nurEinStandort: number;
  };
}

/**
 * Schlüssel für die Zusammenführung.
 *
 * **IEEE zuerst**, weil eine Kurzadresse beim Neuanmelden neu vergeben wird:
 * Zwei Standorte, die ein Gerät zu verschiedenen Zeiten gehört haben, würden
 * sonst zwei Zeilen ergeben — oder schlimmer, zwei verschiedene Geräte in
 * einer Zeile landen. Ohne IEEE bleibt nur PAN und Kurzadresse; das ist
 * ungenauer, aber besser als nichts, und die Zeile ist daran erkennbar, dass
 * `ieee` null ist.
 */
function schluessel(g: StandortGeraet): string {
  return g.ieee !== undefined && g.ieee !== ''
    ? `ieee:${g.ieee}`
    : `kurz:${g.pan}:${g.addr}`;
}

function mittel(summe: number, anzahl: number): number {
  return anzahl > 0 ? Math.round(summe / anzahl) : 0;
}

export function baueZigbeeMatrix(
  eingang: readonly StandortBericht[],
  soll: readonly SollGeraet[] = [],
): ZigbeeMatrix {
  // Gleichnamige Standorte zusammenfassen — zwei Spalten mit demselben Namen
  // wären für den Leser nicht auseinanderzuhalten. Der Fall entsteht, wenn ein
  // Master sich selbst als Gegenstelle führt (127.0.0.1) und zusätzlich seine
  // eigenen Geräte beisteuert. Der Aufrufer soll das vermeiden; hier steht die
  // zweite Verteidigungslinie, damit die Tabelle nie doppelt erscheint.
  const zusammen = new Map<string, StandortBericht>();
  for (const b of eingang) {
    const vorhanden = zusammen.get(b.standort);
    if (vorhanden === undefined) {
      zusammen.set(b.standort, { ...b, geraete: [...b.geraete] });
      continue;
    }
    // Erreichbar schlägt unerreichbar, und die Gerätelisten werden vereinigt.
    vorhanden.erreichbar = vorhanden.erreichbar || b.erreichbar;
    vorhanden.geraete.push(...b.geraete);
  }
  const berichte = [...zusammen.values()];
  const standorte = berichte.map((b) => b.standort);
  const nichtErreichbar = berichte.filter((b) => !b.erreichbar).map((b) => b.standort);

  const zeilen = new Map<string, ZigbeeMatrixGeraet>();

  for (const bericht of berichte) {
    if (!bericht.erreichbar) continue;
    for (const g of bericht.geraete) {
      const k = schluessel(g);
      let zeile = zeilen.get(k);
      if (zeile === undefined) {
        zeile = {
          ieee: g.ieee ?? null,
          addr: g.addr,
          pan: g.pan,
          name: g.name ?? '',
          empfang: {},
          beste: null,
          nirgends: false,
        };
        zeilen.set(k, zeile);
      }
      // Ein Name von irgendeinem Standort ist besser als keiner.
      if (zeile.name === '' && g.name !== undefined) zeile.name = g.name;
      if (zeile.ieee === null && g.ieee !== undefined) zeile.ieee = g.ieee;

      zeile.empfang[bericht.standort] = {
        rssi: mittel(g.sum_rssi, g.pakete),
        lqi: mittel(g.sum_lqi, g.pakete),
        pakete: g.pakete,
        schwachProzent: g.pakete > 0
          ? Math.round((g.schwach * 1000) / g.pakete) / 10
          : 0,
      };
    }
  }

  // Sollmenge nachtragen: Was niemand gehört hat, muss trotzdem dastehen —
  // sonst faellt gerade das auf, wonach man sucht, aus der Liste heraus.
  const gehoerteIeee = new Set(
    [...zeilen.values()].map((z) => z.ieee).filter((i): i is string => i !== null),
  );
  for (const s of soll) {
    if (gehoerteIeee.has(s.ieee)) continue;
    zeilen.set(`ieee:${s.ieee}`, {
      ieee: s.ieee,
      addr: '',
      pan: 0,
      name: s.name,
      empfang: {},
      beste: null,
      nirgends: true,
    });
  }

  for (const z of zeilen.values()) {
    let beste: string | null = null;
    let bester = -Infinity;
    for (const [ort, e] of Object.entries(z.empfang)) {
      if (e.rssi > bester) { bester = e.rssi; beste = ort; }
    }
    z.beste = beste;
    z.nirgends = Object.keys(z.empfang).length === 0;
  }

  const geraete = [...zeilen.values()].sort((a, b) => {
    // Die Fragezeichen nach oben: nirgends gehört, dann nur an einem Standort.
    const rang = (g: ZigbeeMatrixGeraet): number =>
      g.nirgends ? 0 : Object.keys(g.empfang).length === 1 ? 1 : 2;
    const d = rang(a) - rang(b);
    return d !== 0 ? d : a.name.localeCompare(b.name, 'de');
  });

  return {
    standorte,
    nichtErreichbar,
    geraete,
    zusammenfassung: {
      gesamt: geraete.length,
      nirgends: geraete.filter((g) => g.nirgends).length,
      nurEinStandort: geraete.filter(
        (g) => Object.keys(g.empfang).length === 1,
      ).length,
    },
  };
}
