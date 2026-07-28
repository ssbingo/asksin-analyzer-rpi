/**
 * Dekodierung der rohen CCU-Antwort.
 *
 * Der Abruf `http://<ccu>:8181/a.exe?ret=…` liefert die Systemvariable nicht
 * als sauberes JSON, sondern dreifach verpackt (verifiziert in
 * docs/serial-protocol.md, Abschnitt 7):
 *
 *   1. **latin1-kodiert** — nicht UTF-8. Umlaute in Gerätenamen
 *      („Wäschekeller", „Büro") werden bei falscher Dekodierung zerstört.
 *   2. in einer XML-Hülle: `<xml><exec>…</exec><ret>…</ret></xml>`
 *   3. der Inhalt von `<ret>` ist HTML-escaped (`&quot;` statt `"`).
 *
 * Diese Datei packt aus — als reine Funktionen, ohne HTTP. Der Abruf selbst
 * kommt mit dem Ingest-Teil von M4.
 */

const ENTITIES: Record<string, string> = {
  quot: '"',
  amp: '&',
  lt: '<',
  gt: '>',
  apos: "'",
  nbsp: ' ',
};

/** HTML-Entities auflösen, auch numerische (`&#228;`, `&#xE4;`). */
export function unescapeHtml(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (ganz, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      return String.fromCodePoint(parseInt(body.slice(2), 16));
    }
    if (body.startsWith('#')) {
      return String.fromCodePoint(parseInt(body.slice(1), 10));
    }
    return ENTITIES[body] ?? ganz;
  });
}

/** Inhalt des `<ret>`-Elements aus der ReGa-Antwort schneiden. */
export function extractRet(xml: string): string {
  const match = /<ret>([\s\S]*?)<\/ret>/.exec(xml);
  if (match === null) {
    throw new Error('CCU-Antwort: kein <ret>-Element gefunden');
  }
  return match[1] ?? '';
}

/**
 * Rohe HTTP-Antwort (Bytes!) → JSON-String der Geräteliste.
 *
 * Nimmt bewusst Bytes entgegen und nicht einen String: Wer die Antwort
 * vorher mit dem UTF-8-Default dekodiert, hat die Umlaute bereits zerstört,
 * bevor diese Funktion sie retten könnte.
 */
export function decodeCcuResponse(raw: Uint8Array): string {
  const text = new TextDecoder('latin1').decode(raw);
  return unescapeHtml(extractRet(text));
}
