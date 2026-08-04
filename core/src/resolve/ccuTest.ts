/**
 * CCU-Verbindungstest mit Diagnose.
 *
 * Warum das mehr ist als „geht/geht nicht"
 * ---------------------------------------
 * Der Abruf der Geräteliste kann an sechs verschiedenen Stellen scheitern,
 * und die häufigste hat nichts mit dem Netzwerk zu tun: Die Systemvariable
 * `AskSinAnalyzerDevList` ist auf der CCU gar nicht angelegt. Von außen sieht
 * das aus wie „CCU antwortet nicht" — die CCU antwortet aber tadellos, sie
 * hat nur nichts zu sagen.
 *
 * Genau das war bisher das Fehlerbild: Geräte erschienen als „1A2B3C" statt
 * mit Namen, und die Suche begann bei der IP-Adresse statt bei der CCU.
 *
 * Deshalb prüft dieser Test **stufenweise** und benennt bei jedem Halt die
 * nächste Handlung — nicht die Fehlermeldung der Bibliothek.
 *
 * Der Test ist eine reine Funktion über einer injizierten Abrufmethode; er
 * lässt sich damit ohne CCU vollständig prüfen.
 */

import { decodeCcuResponse } from './ccuResponse.ts';
import { parseDevList } from './devlist.ts';
import { buildDevListUrl } from './fetcher.ts';
import type { FetchBytes } from './fetcher.ts';

/** Name der Systemvariablen auf der CCU. An zwei Stellen gleich zu halten. */
export const SYSTEMVARIABLE = 'AskSinAnalyzerDevList';

/**
 * Wie weit der Test gekommen ist.
 *
 * Die Reihenfolge ist die Prüfreihenfolge — wer bei `variable` scheitert, hat
 * `erreichbar` und `antwort` bereits bestanden.
 */
export type Teststufe =
  /** Kein Rechnername eingetragen. */
  | 'keine-adresse'
  /** Name lässt sich nicht auflösen oder niemand nimmt ab. */
  | 'erreichbar'
  /** Antwort kam, sieht aber nicht nach CCU aus. */
  | 'antwort'
  /** CCU antwortet, die Systemvariable fehlt oder ist leer. */
  | 'variable'
  /** Variable da, Inhalt ist kein gültiges JSON in unserer Form. */
  | 'inhalt'
  /** Alles in Ordnung. */
  | 'ok';

export interface CcuTestErgebnis {
  ok: boolean;
  stufe: Teststufe;
  /** Eine Zeile, fett dargestellt. */
  titel: string;
  /** Was das bedeutet — ganze Sätze, kein Fehlercode. */
  text: string;
  /** Die nächste Handlung. Leer, wenn nichts zu tun ist. */
  tunSie: string;
  /** Zeigt die Oberfläche die ausführliche CCU-Anleitung? */
  anleitungZeigen: boolean;
  /** Gefundene Geräte — nur bei `ok`. */
  geraete: number | null;
  /**
   * Alter der Liste in Stunden — nur bei `ok`.
   *
   * Eine uralte Liste ist der zweithäufigste Stolperstein: Das Skript lief
   * einmal und seither nie wieder, neue Geräte fehlen. Der Test sagt das,
   * statt es den Anwender selbst herausfinden zu lassen.
   */
  alterStunden: number | null;
  /** Beispielnamen aus der Liste — belegt, dass es die richtige Anlage ist. */
  beispiele: string[];
  /** Rohe technische Meldung, klein darunter. */
  technisch: string;
}

function ergebnis(teil: Partial<CcuTestErgebnis> & { stufe: Teststufe; titel: string }): CcuTestErgebnis {
  return {
    ok: teil.stufe === 'ok',
    text: '',
    tunSie: '',
    anleitungZeigen: false,
    geraete: null,
    alterStunden: null,
    beispiele: [],
    technisch: '',
    ...teil,
  };
}

/** Deutet den Netzwerkfehler, statt ihn durchzureichen. */
function deuteNetzfehler(fehler: unknown, host: string): { text: string; tunSie: string } {
  const roh = fehler instanceof Error ? fehler.message : String(fehler);
  const code = (fehler as { cause?: { code?: string } })?.cause?.code ?? '';

  if (code === 'ENOTFOUND' || /getaddrinfo|ENOTFOUND/i.test(roh)) {
    return {
      text: `Der Name „${host}" lässt sich im Netzwerk nicht auflösen — es gibt kein Gerät mit diesem Namen.`,
      tunSie:
        'Tragen Sie die IP-Adresse der CCU ein statt des Namens. Sie steht in der CCU unter ' +
        'Einstellungen → Systemsteuerung → Netzwerkeinstellungen.',
    };
  }
  if (code === 'ECONNREFUSED' || /ECONNREFUSED/i.test(roh)) {
    return {
      text: `${host} ist erreichbar, weist die Verbindung auf Port 8181 aber ab.`,
      tunSie:
        'Auf Port 8181 antwortet der Logikbaustein der CCU. Wird abgewiesen, ist das Gerät ' +
        'unter dieser Adresse keine CCU/RaspberryMatic — Adresse prüfen.',
    };
  }
  if (code === 'ETIMEDOUT' || /timeout|aborted|ETIMEDOUT/i.test(roh)) {
    return {
      text: `${host} antwortet nicht innerhalb der Wartezeit.`,
      tunSie:
        'Läuft die CCU? Ist sie im selben Netz wie der Analyzer? Eine Firewall zwischen ' +
        'beiden muss Port 8181 durchlassen.',
    };
  }
  return {
    text: `Die CCU unter ${host} war nicht erreichbar.`,
    tunSie: 'Adresse prüfen und ob die CCU läuft.',
  };
}

/**
 * Führt den Test aus.
 *
 * @param host      Adresse der CCU, wie sie in den Einstellungen steht
 * @param fetchBytes Abrufmethode (injiziert, damit ohne CCU prüfbar)
 * @param jetzt     Zeitquelle für die Altersrechnung
 */
export async function testeCcu(
  host: string,
  fetchBytes: FetchBytes,
  jetzt: () => number = Date.now,
  timeoutMs = 8000,
): Promise<CcuTestErgebnis> {
  const adresse = host.trim();
  if (adresse === '') {
    return ergebnis({
      stufe: 'keine-adresse',
      titel: 'Keine CCU eingetragen',
      text:
        'Ohne Zentrale zeigt der Analyzer Geräte mit ihrer Funkadresse an — also „1A2B3C" ' +
        'statt „Wohnzimmer Fenster". Alles andere funktioniert unverändert.',
      tunSie: 'Tragen Sie oben die IP-Adresse oder den Namen Ihrer CCU ein.',
    });
  }

  const abbruch = new AbortController();
  const uhr = setTimeout(() => abbruch.abort(), timeoutMs);
  let roh: Uint8Array;
  try {
    roh = await fetchBytes(buildDevListUrl(adresse), abbruch.signal);
  } catch (fehler) {
    const { text, tunSie } = deuteNetzfehler(fehler, adresse);
    return ergebnis({
      stufe: 'erreichbar',
      titel: 'CCU nicht erreichbar',
      text,
      tunSie,
      technisch: fehler instanceof Error ? fehler.message : String(fehler),
    });
  } finally {
    clearTimeout(uhr);
  }

  // decodeCcuResponse packt die dreifache Verpackung aus: latin1, XML-Hülle,
  // HTML-Escapes. Wirft es, kam etwas anderes als eine CCU-Antwort zurück.
  let inhalt: string;
  try {
    inhalt = decodeCcuResponse(roh);
  } catch (fehler) {
    return ergebnis({
      stufe: 'antwort',
      titel: 'Antwort kommt nicht von einer CCU',
      text:
        `${adresse} hat auf Port 8181 geantwortet, aber nicht so, wie eine CCU antwortet. ` +
        'Vermutlich läuft dort ein anderer Dienst.',
      tunSie: 'Prüfen Sie, ob die Adresse wirklich zur CCU oder RaspberryMatic gehört.',
      technisch: fehler instanceof Error ? fehler.message : String(fehler),
    });
  }

  const wert = inhalt.trim();
  // Eine nicht vorhandene Systemvariable liefert kein Fehlersignal, sondern
  // eine leere Antwort oder wörtlich "null" — das ist der Normalfall bei
  // frischer Einrichtung und der mit Abstand häufigste Halt.
  if (wert === '' || wert === 'null' || wert === '<null>') {
    return ergebnis({
      stufe: 'variable',
      titel: `Die CCU antwortet — die Systemvariable fehlt`,
      text:
        `Die Verbindung zu ${adresse} steht. Auf der CCU gibt es aber keine Systemvariable ` +
        `namens „${SYSTEMVARIABLE}", oder sie ist leer. Der Analyzer bekommt deshalb keine ` +
        'Gerätenamen — die Anlage selbst wird davon nicht berührt.',
      tunSie:
        'Das Skript auf der CCU einmalig ausführen. Es legt die Variable an und füllt sie. ' +
        'Die Anleitung dazu steht unten — sie dauert etwa fünf Minuten.',
      anleitungZeigen: true,
    });
  }

  let liste: ReturnType<typeof parseDevList>;
  try {
    liste = parseDevList(wert);
  } catch (fehler) {
    return ergebnis({
      stufe: 'inhalt',
      titel: 'Die Systemvariable enthält etwas Unerwartetes',
      text:
        `Die Variable „${SYSTEMVARIABLE}" existiert und ist gefüllt, ihr Inhalt lässt sich ` +
        'aber nicht als Geräteliste lesen. Meist ist das Skript nur teilweise durchgelaufen.',
      tunSie:
        'Das Skript auf der CCU noch einmal vollständig ausführen und prüfen, ob es unten ' +
        'ohne Fehlermeldung endet.',
      anleitungZeigen: true,
      technisch: `${fehler instanceof Error ? fehler.message : String(fehler)} — Anfang: ${wert.slice(0, 80)}`,
    });
  }

  // created_at steht in SEKUNDEN (so schreibt es das CCU-Skript), nicht in
  // Millisekunden. Ein Vertauschen ergäbe ein Alter von 50 Jahren.
  const alterStunden = Math.max(0, (jetzt() / 1000 - liste.created_at) / 3600);
  const beispiele = liste.devices
    .map((d) => d.name)
    .filter((n) => n !== '' && !n.startsWith('HmIP Multicast') && n !== 'HMRF Broadcast')
    .slice(0, 3);

  if (liste.devices.length === 0) {
    return ergebnis({
      stufe: 'inhalt',
      titel: 'Die Liste ist leer',
      text:
        'Das Skript ist gelaufen und hat die Variable angelegt, aber kein einziges Gerät ' +
        'gefunden. Das kommt vor, wenn an der CCU noch keine Geräte angelernt sind.',
      tunSie: 'Nach dem Anlernen der Geräte das Skript erneut ausführen.',
      anleitungZeigen: true,
    });
  }

  const alt = alterStunden > 24;
  return ergebnis({
    stufe: 'ok',
    titel: `${liste.devices.length} Geräte von der CCU gelesen`,
    text:
      `Die Verbindung zu ${adresse} steht, und die Geräteliste ist lesbar. ` +
      (beispiele.length > 0 ? `Zum Beispiel: ${beispiele.join(', ')}. ` : '') +
      (alt
        ? `Die Liste ist allerdings ${Math.round(alterStunden / 24)} Tage alt — seither ` +
          'angelernte Geräte fehlen darin.'
        : 'Die Liste ist aktuell.'),
    tunSie: alt
      ? 'Das Skript auf der CCU erneut ausführen, am besten als tägliches Programm.'
      : '',
    geraete: liste.devices.length,
    alterStunden,
    beispiele,
  });
}
