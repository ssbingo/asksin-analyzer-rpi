/**
 * Bytestrom → Zeilen.
 *
 * Der Sniffer liefert reine ASCII-Zeilen mit `\n` (teils `\r\n`). Der Splitter
 * arbeitet trotzdem auf **Bytes** und dekodiert erst die fertige Zeile — wer
 * vorher dekodiert, kann an Chunk-Grenzen mitten in einem Mehrbyte-Zeichen
 * landen, sobald doch einmal Fremdbytes im Strom auftauchen (Boot-Müll,
 * Störungen auf der Leitung). Dekodiert wird als latin1: ein Byte, ein
 * Zeichen, wirft nie.
 *
 * Schutz gegen Zeilen ohne Ende: Ab `maxLineLength` Bytes ohne `\n` schaltet
 * der Splitter in den Verwerfen-Modus und ignoriert alles bis zum nächsten
 * Zeilenumbruch. Ohne diese Grenze würde ein dauerhaft falsch konfigurierter
 * Port (falsche Baudrate → nie ein `\n`) den Speicher füllen. Die längste
 * gültige Sniffer-Zeile hat 127 Zeichen — 1024 ist reichlich.
 */

const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;

export class LineSplitter {
  readonly #maxLineLength: number;
  #rest: Buffer = Buffer.alloc(0);
  #verwerfen = false;
  #overlong = 0;
  #partial = 0;

  constructor(maxLineLength = 1024) {
    this.#maxLineLength = maxLineLength;
  }

  /** Zeilen, die durch Überlänge verworfen wurden. */
  get overlongDropped(): number {
    return this.#overlong;
  }

  /** Beim Schließen verworfene angefangene Zeilen. */
  get partialDropped(): number {
    return this.#partial;
  }

  /** Nächsten Datenblock einspeisen; liefert alle vollständigen Zeilen. */
  push(chunk: Uint8Array): string[] {
    let buf = this.#rest.length === 0
      ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
      : Buffer.concat([this.#rest, chunk]);

    const lines: string[] = [];
    let start = 0;

    for (;;) {
      const nl = buf.indexOf(NEWLINE, start);
      if (nl === -1) break;

      if (this.#verwerfen) {
        // Rest der überlangen Zeile fällt weg, ab hier wieder normal.
        this.#verwerfen = false;
      } else {
        let end = nl;
        if (end > start && buf[end - 1] === CARRIAGE_RETURN) end--;
        lines.push(buf.toString('latin1', start, end));
      }
      start = nl + 1;
    }

    this.#rest = buf.subarray(start);
    if (this.#verwerfen) {
      this.#rest = Buffer.alloc(0);
    } else if (this.#rest.length > this.#maxLineLength) {
      this.#verwerfen = true;
      this.#overlong++;
      this.#rest = Buffer.alloc(0);
    }
    return lines;
  }

  /** Strom zu Ende — angefangene Zeile wird gezählt und verworfen. */
  end(): void {
    if (this.#rest.length > 0) this.#partial++;
    this.#rest = Buffer.alloc(0);
    this.#verwerfen = false;
  }
}
