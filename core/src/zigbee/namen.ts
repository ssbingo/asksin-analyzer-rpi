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

  /**
   * Einen eigenen Schlüssel bei deCONZ anfordern.
   *
   * Warum das hierher gehört und nicht in eine Anleitung: deCONZ **zeigt
   * bestehende Schlüssel nie an**. Es vergibt nur neue, und zwar ausschliesslich
   * während des Anmeldefensters, das in Phoscon unter
   * „Einstellungen → Gateway → Erweitert → App authentifizieren" für rund eine
   * Minute geöffnet wird.
   *
   * Wer den Schlüssel von Hand besorgt, muss ihn abtippen oder kopieren — und
   * damit landet ein Zugangstoken in einer Zwischenablage, einem Chatfenster
   * oder einem Screenshot. Holt der Analyzer ihn selbst, sieht ihn niemand.
   *
   * @param altenWiderrufen Schlüssel, der danach aus der Freigabeliste
   *   entfernt wird. Ohne Widerruf sammeln sich dort mit jedem Versuch
   *   Einträge an, die alle gültig bleiben.
   */
  async schluesselAnfordern(
    host: string,
    altenWiderrufen?: string,
  ): Promise<{ ok: boolean; meldung: string }> {
    if (host === '') return { ok: false, meldung: 'Kein deCONZ-Rechner eingetragen.' };
    let neuer: string;
    try {
      const antwort = await holen(`http://${host}/api`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ devicetype: 'asksin-analyzer' }),
        signal: AbortSignal.timeout(this.#o.timeoutMs ?? 8000),
      });
      const roh = JSON.parse(new TextDecoder().decode(antwort.bytes)) as Array<
        Record<string, Record<string, string>>
      >;
      const ersterFehler = roh.find((e) => 'error' in e)?.['error'];
      if (ersterFehler !== undefined) {
        // Die haeufigste Antwort ueberhaupt — und die einzige, bei der man
        // genau weiss, was zu tun ist.
        const beschreibung = ersterFehler['description'] ?? '';
        return {
          ok: false,
          meldung: beschreibung.includes('unauthorized')
            ? 'deCONZ hat abgelehnt. Das Anmeldefenster ist zu — in Phoscon '
              + 'unter Einstellungen → Gateway → Erweitert auf '
              + '„App authentifizieren" klicken und es innerhalb einer Minute '
              + 'hier erneut versuchen.'
            : `deCONZ lehnt ab: ${beschreibung}`,
        };
      }
      const schluessel = roh.find((e) => 'success' in e)?.['success']?.['username'];
      if (schluessel === undefined || schluessel === '') {
        return { ok: false, meldung: 'deCONZ hat keinen Schlüssel geliefert.' };
      }
      neuer = schluessel;
    } catch (err) {
      return { ok: false, meldung: `deCONZ nicht erreichbar: ${String(err)}` };
    }

    this.#o.host = host;
    this.#o.schluessel = neuer;

    let nachsatz = '';
    if (altenWiderrufen !== undefined && altenWiderrufen !== ''
        && altenWiderrufen !== neuer) {
      try {
        const weg = await holen(
          `http://${host}/api/${neuer}/config/whitelist/${altenWiderrufen}`,
          { method: 'DELETE', signal: AbortSignal.timeout(this.#o.timeoutMs ?? 8000) },
        );
        // deCONZ 2.32.5 lehnt das Löschen von Schlüsseln über die API ab —
        // es antwortet "unauthorized user" (403), auch mit gültigem Schlüssel
        // (am 18.08.2026 nachgemessen). Der Versuch bleibt trotzdem stehen:
        // Er kostet nichts, andere Fassungen erlauben es, und die Antwort
        // sagt dem Anwender genau, was er noch von Hand tun muss.
        nachsatz = weg.ok
          ? ' Der alte Schlüssel wurde widerrufen.'
          : ' ACHTUNG: Der alte Schlüssel gilt weiter — deCONZ lässt ihn über '
            + 'die Schnittstelle nicht löschen. In Phoscon unter Einstellungen '
            + '→ Gateway → Erweitert bei den authentifizierten Apps entfernen.';
      } catch {
        nachsatz = ' ACHTUNG: Der alte Schlüssel gilt weiter — in Phoscon unter '
          + 'Einstellungen → Gateway → Erweitert entfernen.';
      }
    }
    // Der Schluessel selbst steht ausdruecklich NICHT in der Meldung.
    return { ok: true, meldung: `Neuer Schlüssel von deCONZ erhalten.${nachsatz}` };
  }

  /** Der aktuelle Schlüssel — nur für das Speichern im Dienst, nie für die UI. */
  get schluessel(): string {
    return this.#o.schluessel;
  }

  async #json(url: string): Promise<unknown> {
    const antwort = await holen(url, {
      signal: AbortSignal.timeout(this.#o.timeoutMs ?? 8000),
    });
    if (!antwort.ok) throw new Error(`HTTP ${antwort.status}`);
    return JSON.parse(new TextDecoder().decode(antwort.bytes));
  }
}
