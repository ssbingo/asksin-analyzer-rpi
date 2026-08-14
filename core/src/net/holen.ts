/**
 * Der einzige Ort im Core, an dem `fetch` aufgerufen wird.
 *
 * Warum das zentral gehört
 * ------------------------
 * Wer eine Antwort holt und ihren Körper nicht liest, gibt sie nicht frei.
 * Undici — die HTTP-Schicht von Node — hält die Verbindung samt gepuffertem
 * Körper so lange fest, bis er gelesen oder verworfen wurde. Das sieht man
 * dem Aufrufer nicht an: Der Code wirkt vollständig, es fehlt nur der Satz,
 * der nicht dasteht.
 *
 * Genau so verteilt lagen im Core vier Stellen:
 *
 *   * `influx/schreiber.ts` las den Körper **nur im Fehlerfall** — der
 *     Erfolgsfall lief alle 30 Sekunden und ließ jedes Mal einen liegen.
 *   * `verbund/verbund.ts` warf bei `!res.ok`, bevor irgendetwas gelesen war,
 *     und gab in `httpPost` nur den Status zurück.
 *   * `resolve/fetcher.ts` warf ebenfalls vor dem Lesen.
 *
 * Auf Analyzer 01 wuchs der Speicher dadurch gleichmäßig um rund 9 MB je
 * Stunde — unabhängig von Last und Telegrammaufkommen, was gut zu einem
 * Zeittakt und schlecht zu allem anderen passt.
 *
 * Deshalb: **ein** Weg nach draußen, und der liest den Körper immer zu Ende.
 * `tools/pruefe-fetch.py` hält fest, dass es dabei bleibt.
 */

/** Was von einer Antwort übrig bleibt, nachdem sie vollständig gelesen wurde. */
export interface Antwort {
  status: number;
  ok: boolean;
  /** Der Körper — immer gelesen, damit die Verbindung freigegeben ist. */
  bytes: Uint8Array;
}

/**
 * Holt eine Antwort und liest ihren Körper **immer** zu Ende — auch bei
 * einem Fehlerstatus, auch wenn der Aufrufer ihn gar nicht braucht.
 *
 * Der Körper ist bei allen Aufrufern klein (Statusantworten, Geräteliste).
 * Wo das einmal nicht gilt, gehört an dieser Stelle ein Strom hin und kein
 * weiterer eigener `fetch`.
 */
export async function holen(url: string, init?: RequestInit): Promise<Antwort> {
  const res = await fetch(url, init);
  // Kein try/catch drumherum: Bricht das Lesen ab, ist die Verbindung
  // ohnehin hin, und der Fehler gehört zum Aufrufer.
  const bytes = new Uint8Array(await res.arrayBuffer());
  return { status: res.status, ok: res.ok, bytes };
}

/** Bequemlichkeit für die Aufrufer, die Text wollen. */
export function alsText(a: Antwort): string {
  return new TextDecoder().decode(a.bytes);
}
