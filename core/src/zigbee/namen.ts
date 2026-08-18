import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { holen } from '../net/holen.ts';

/**
 * Gerätenamen aus deCONZ — damit aus `0x837E` „LED Garten Weg 06" wird.
 *
 * Der Weg dorthin führt über zwei Quellen, weil keine allein reicht:
 *
 *   * **deCONZ** kennt Name, Hersteller und Modell zu jeder **IEEE-Adresse**.
 *     Die Kurzadresse, die auf dem Funk unterwegs ist, kennt es NICHT.
 *   * **Der Mithörer** sieht die Kurzadresse und lernt die zugehörige
 *     IEEE-Adresse aus dem NWK-Kopf (siehe `zigbee_adressen`).
 *
 * Erst beide zusammen ergeben den Namen. Gemessen am 18.08.2026: 34 von 42
 * gehörten Kurzadressen bekamen so einen Namen — die übrigen acht waren der
 * Koordinator selbst und Geräte aus Nachbarnetzen.
 *
 * Aufbau nach dem Vorbild der CCU-Geräteliste: regelmässig holen, auf Platte
 * zwischenspeichern, bei Ausfall der Quelle den Zwischenspeicher benutzen.
 * Ein Analyzer im Schrank soll nicht namenlos werden, weil ein anderer
 * Rechner gerade neu startet.
 */

export interface DeconzGeraet {
  ieee: string;
  name: string;
  hersteller?: string;
  modell?: string;
}

export interface NamenOptionen {
  /** IP oder Hostname des deCONZ-Rechners. Leer = abgeschaltet. */
  host: string;
  /** API-Schlüssel. Wird nur mitgesendet, nie protokolliert. */
  schluessel: string;
  /** Zwischenspeicher auf Platte. */
  cachePfad: string;
  /** Zeitgrenze je Abruf. */
  timeoutMs?: number;
  onLog?: (text: string) => void;
}

/** deCONZ liefert IEEE-Adressen mit Doppelpunkten und klein. */
function normIeee(roh: string): string {
  return roh.replace(/[^0-9a-fA-F]/g, '').toUpperCase();
}

export class DeconzNamen {
  readonly #o: NamenOptionen;
  #namen = new Map<string, DeconzGeraet>();
  #geholtAm: number | null = null;
  #quelle: 'deconz' | 'cache' | 'keine' = 'keine';
  #letzterFehler = '';

  constructor(o: NamenOptionen) {
    this.#o = o;
    this.#ausCacheLesen();
  }

  get anzahl(): number {
    return this.#namen.size;
  }

  get zustand(): Record<string, unknown> {
    return {
      aktiv: this.#o.host !== '' && this.#o.schluessel !== '',
      host: this.#o.host,
      anzahl: this.#namen.size,
      quelle: this.#quelle,
      geholtAm: this.#geholtAm,
      // Der Schlüssel steht hier bewusst NICHT drin.
      fehler: this.#letzterFehler,
    };
  }

  /** Name zu einer IEEE-Adresse, oder undefined. */
  name(ieee: string): string | undefined {
    return this.#namen.get(normIeee(ieee))?.name;
  }

  geraet(ieee: string): DeconzGeraet | undefined {
    return this.#namen.get(normIeee(ieee));
  }

  alle(): DeconzGeraet[] {
    return [...this.#namen.values()];
  }

  #ausCacheLesen(): void {
    if (!existsSync(this.#o.cachePfad)) return;
    try {
      const roh = JSON.parse(readFileSync(this.#o.cachePfad, 'utf8')) as {
        geraete?: DeconzGeraet[]; geholtAm?: number;
      };
      for (const g of roh.geraete ?? []) this.#namen.set(normIeee(g.ieee), g);
      this.#geholtAm = roh.geholtAm ?? null;
      this.#quelle = this.#namen.size > 0 ? 'cache' : 'keine';
    } catch {
      // Ein kaputter Zwischenspeicher ist kein Grund, ohne Namen zu starten —
      // beim naechsten Abruf wird er ohnehin ueberschrieben.
    }
  }

  /**
   * Namen bei deCONZ holen. Wirft nie — ein Ausfall der Gegenstelle darf den
   * Analyzer nicht stören; dann bleibt der Zwischenspeicher gültig.
   */
  async aktualisieren(): Promise<boolean> {
    const { host, schluessel } = this.#o;
    if (host === '' || schluessel === '') return false;
    const basis = `http://${host}/api/${schluessel}`;
    try {
      const liste = await this.#json(`${basis}/devices`);
      if (!Array.isArray(liste)) throw new Error('/devices lieferte keine Liste');

      const neu = new Map<string, DeconzGeraet>();
      for (const kennung of liste) {
        if (typeof kennung !== 'string') continue;
        const d = await this.#json(`${basis}/devices/${kennung}`) as
          Record<string, unknown> | null;
        if (d === null) continue;
        const name = typeof d['name'] === 'string' ? d['name'] : '';
        if (name === '') continue;
        const g: DeconzGeraet = { ieee: normIeee(kennung), name };
        if (typeof d['manufacturername'] === 'string') g.hersteller = d['manufacturername'];
        if (typeof d['modelid'] === 'string') g.modell = d['modelid'];
        neu.set(g.ieee, g);
      }
      if (neu.size === 0) throw new Error('keine benannten Geräte gefunden');

      this.#namen = neu;
      this.#geholtAm = Date.now();
      this.#quelle = 'deconz';
      this.#letzterFehler = '';
      writeFileSync(
        this.#o.cachePfad,
        JSON.stringify({ geholtAm: this.#geholtAm, geraete: [...neu.values()] }, null, 2),
        { mode: 0o600 },
      );
      this.#o.onLog?.(`Zigbee-Namen: ${neu.size} Geräte von deCONZ`);
      return true;
    } catch (err) {
      // Die Meldung darf den Schlüssel nicht enthalten — er steht in der URL.
      this.#letzterFehler = String(err).replaceAll(schluessel, '…');
      this.#o.onLog?.(`Zigbee-Namen: deCONZ nicht erreichbar (${this.#letzterFehler})` +
        (this.#namen.size > 0 ? ` — ${this.#namen.size} Namen aus dem Zwischenspeicher` : ''));
      return false;
    }
  }

  async #json(url: string): Promise<unknown> {
    const antwort = await holen(url, {
      signal: AbortSignal.timeout(this.#o.timeoutMs ?? 8000),
    });
    if (!antwort.ok) throw new Error(`HTTP ${antwort.status}`);
    return JSON.parse(new TextDecoder().decode(antwort.bytes));
  }
}
