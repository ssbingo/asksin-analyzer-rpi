import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import {
  MITSCHNITT_FORMAT,
  MitschnittSchreiber,
} from '../src/mitschnitt/schreiber.ts';
import { vergleiche, werteAus } from '../src/mitschnitt/auswertung.ts';
import { SerialIngest } from '../src/ingest/ingest.ts';
import type { IngestStream } from '../src/ingest/ingest.ts';

const tmp = mkdtempSync(join(tmpdir(), 'asksin-mitschnitt-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

let lauf = 0;
function pfad(): string {
  lauf += 1;
  return join(tmp, `m${lauf}.txt`);
}

/** Eine gültige Telegrammzeile bauen (Länge 0x0B = 11, also 2 Byte Payload). */
function telegramm(rssi = 0x5a, from = 'ABCDEF', to = '123456'): string {
  return `:${rssi.toString(16).padStart(2, '0').toUpperCase()}0B01A002${from}${to}0102;`;
}

describe('MitschnittSchreiber', () => {
  it('schreibt Kopf und Zeilen im dokumentierten Format', () => {
    const p = pfad();
    const s = new MitschnittSchreiber({
      pfad: p,
      geraet: '/dev/ttyAMA0',
      baud: 58824,
      jetzt: () => 1_000,
    });
    s.zeile(':5A;', 1_100);
    s.zeile(':5B;', 1_850);
    s.stop();

    const zeilen = readFileSync(p, 'utf8').split('\n');
    assert.equal(zeilen[0], `# asksin-mitschnitt ${MITSCHNITT_FORMAT}`);
    assert.match(zeilen[1] as string, /^# begonnen \d{4}-/);
    assert.equal(zeilen[2], '# geraet /dev/ttyAMA0 baud 58824');
    assert.equal(zeilen[3], '# demo nein');
    assert.equal(zeilen[4], '1100\t:5A;');
    assert.equal(zeilen[5], '1850\t:5B;');
    assert.equal(s.stats().geschrieben, 2);
  });

  it('haengt an eine bestehende Datei an, statt sie zu ueberschreiben', () => {
    // Ein Neustart des Dienstes mitten in der Aufzeichnung darf die
    // Grundlinie nicht loeschen — sonst waere sie nach jedem Update weg.
    const p = pfad();
    const a = new MitschnittSchreiber({ pfad: p, jetzt: () => 1 });
    a.zeile(':AA;', 10);
    a.stop();

    const b = new MitschnittSchreiber({ pfad: p, jetzt: () => 2 });
    b.zeile(':BB;', 20);
    b.stop();

    const inhalt = readFileSync(p, 'utf8');
    assert.equal(inhalt.match(/# asksin-mitschnitt/g)?.length, 1, 'nur ein Kopf');
    assert.ok(inhalt.includes('10\t:AA;'));
    assert.ok(inhalt.includes('20\t:BB;'));
  });

  it('verwirft bei Pufferueberlauf die AELTESTEN Zeilen und zaehlt sie', () => {
    // Der neueste Zustand ist der interessante. Ein Mitschnitt, der
    // stattdessen hinter der Wirklichkeit zurueckbleibt, taeuscht.
    const p = pfad();
    const s = new MitschnittSchreiber({
      pfad: p,
      pufferGrenze: 8,
      bündelGroesse: 1000, // nichts spuelen, damit der Puffer wirklich volllaeuft
      spuelIntervallMs: 3_600_000,
      jetzt: () => 0,
    });
    for (let i = 0; i < 20; i++) s.zeile(`:${i};`, i);
    s.stop();

    const stats = s.stats();
    assert.ok(stats.verworfen > 0, 'Verluste werden ausgewiesen');
    const inhalt = readFileSync(p, 'utf8');
    assert.ok(inhalt.includes('19\t:19;'), 'die neueste Zeile ist da');
    assert.ok(!inhalt.includes('0\t:0;'), 'die aelteste ist weg');
    assert.equal(stats.geschrieben + stats.verworfen, 20);
  });

  it('hoert bei maxBytes auf zu wachsen und zaehlt weiter', () => {
    const p = pfad();
    const s = new MitschnittSchreiber({
      pfad: p,
      maxBytes: 200,
      bündelGroesse: 1,
      jetzt: () => 0,
    });
    for (let i = 0; i < 100; i++) s.zeile(':5A;', 1_000_000 + i);
    s.stop();

    const stats = s.stats();
    assert.ok(stats.abgeschnitten > 0, 'die Grenze greift');
    assert.ok(readFileSync(p, 'utf8').length < 400);
    // Kein Datenverlust ohne Ausweis: alles ist entweder drin oder gezaehlt.
    assert.equal(stats.geschrieben + stats.abgeschnitten + stats.verworfen, 100);
  });

  it('meldet Schreibfehler genau einmal je Art und laeuft weiter', () => {
    const gemeldet: unknown[] = [];
    // Ein VORHANDENES Verzeichnis als Ziel: appendFileSync scheitert dauerhaft
    // mit EISDIR. Ein blosser Pfad ohne Datei genuegt nicht — den legt der
    // Schreiber selbst an, und dann gaebe es gar keinen Fehler zu melden.
    const alsOrdner = join(tmp, 'ordner');
    mkdirSync(alsOrdner, { recursive: true });
    const s = new MitschnittSchreiber({
      pfad: alsOrdner,
      bündelGroesse: 1,
      jetzt: () => 0,
      onFehler: (f) => gemeldet.push(f),
    });
    s.zeile(':5A;', 1);
    s.zeile(':5B;', 2);
    s.zeile(':5C;', 3);
    s.stop();

    assert.equal(gemeldet.length, 1, 'nicht bei jeder Zeile erneut');
    assert.ok(s.stats().fehler >= 3, 'gezaehlt wird trotzdem jedes Mal');
  });

  it('nimmt nach stop() nichts mehr an', () => {
    const p = pfad();
    const s = new MitschnittSchreiber({ pfad: p, jetzt: () => 0 });
    s.stop();
    s.zeile(':5A;', 1);
    assert.equal(s.stats().geschrieben, 0);
    assert.ok(!readFileSync(p, 'utf8').includes(':5A;'));
  });
});

describe('SerialIngest.onRawLine', () => {
  function stromAus(zeilen: string[]): IngestStream {
    const daten = new TextEncoder().encode(`${zeilen.join('\r\n')}\r\n`);
    return {
      readable: (async function* () {
        yield daten;
      })(),
      close() {},
    };
  }

  it('liefert die Rohzeile VOR dem Parsen — auch die verworfenen', async () => {
    // Genau die verworfenen Zeilen sind der Grund fuer den Mitschnitt:
    // Ohne sie waere nicht belegbar, wie oft die Strecke heute stolpert.
    const roh: string[] = [];
    const ingest = new SerialIngest({
      openPort: async () => stromAus([':5A;', 'Boot: AskSin++', telegramm()]),
      onRawLine: (z) => roh.push(z),
      silenceTimeoutMs: 50,
    });
    const laeuft = ingest.start();
    await new Promise((r) => setTimeout(r, 150));
    await ingest.stop();
    await laeuft;

    assert.deepEqual(roh, [':5A;', 'Boot: AskSin++', telegramm()]);
    assert.equal(ingest.stats.ignored['no-frame'], 1);
  });

  it('eine Ausnahme im Mitschnitt haelt den Empfang nicht an', async () => {
    // Der Mitschnitt ist Beiwerk. Wenn die Platte voll ist, soll der Analyzer
    // weiterlaufen — nicht verstummen.
    const gesehen: string[] = [];
    const ingest = new SerialIngest({
      openPort: async () => stromAus([':5A;', ':5B;', ':5C;']),
      onRawLine: () => {
        throw new Error('Platte voll');
      },
      onLine: (l) => {
        if (l.kind === 'noise') gesehen.push(String(l.noise.rssi));
      },
      silenceTimeoutMs: 50,
    });
    const laeuft = ingest.start();
    await new Promise((r) => setTimeout(r, 150));
    await ingest.stop();
    await laeuft;

    assert.equal(gesehen.length, 3, 'alle drei Zeilen wurden trotzdem verarbeitet');
    assert.equal(ingest.stats.consumerErrors, 3);
  });
});

describe('Auswertung', () => {
  /** Baut einen Mitschnitt mit sauberem 750-ms-Takt. */
  function grundlinie(takte: number, start = 1_700_000_000_000): string {
    const z = [
      '# asksin-mitschnitt 1',
      '# begonnen 2026-08-03T09:00:00.000Z',
      '# geraet /dev/ttyAMA0 baud 58824',
    ];
    for (let i = 0; i < takte; i++) z.push(`${start + i * 750}\t:5A;`);
    return `${z.join('\n')}\n`;
  }

  it('liest den Kopf und zaehlt die Zeilenarten', () => {
    const inhalt =
      grundlinie(4) + `1700000003000\t${telegramm()}\n1700000003100\tMuell\n`;
    const a = werteAus(inhalt, 'test');

    assert.equal(a.format, 1);
    assert.equal(a.geraet, '/dev/ttyAMA0');
    assert.equal(a.baud, 58824);
    assert.equal(a.rauschzeilen, 4);
    assert.equal(a.telegramme, 1);
    assert.equal(a.verworfen, 1);
    assert.equal(a.verworfenNachGrund['no-frame'], 1);
    assert.equal(a.absender, 1);
  });

  it('misst den Rauschtakt und erkennt Ausreisser', () => {
    const sauber = werteAus(grundlinie(50), 'sauber');
    assert.equal(sauber.rauschTakt?.median, 750);
    assert.equal(sauber.taktAusreisser, 0);

    // Ein Takt haengt: 750 → 2000 ms.
    const zeilen = grundlinie(20).trimEnd().split('\n');
    const kopfEnde = 3;
    const kaputt = zeilen.map((z, i) => {
      if (i <= kopfEnde + 9) return z;
      const [ts, rest] = z.split('\t');
      return `${Number(ts) + 1250}\t${rest}`;
    });
    const a = werteAus(`${kaputt.join('\n')}\n`, 'kaputt');
    assert.equal(a.taktAusreisser, 1, 'genau der eine gestreckte Abstand');
    assert.equal(a.rauschTakt?.max, 2000);
    assert.equal(a.rauschTakt?.median, 750, 'der Median bleibt vom Ausreisser unberuehrt');
  });

  it('findet Luecken und sortiert sie nach Dauer', () => {
    const inhalt = [
      '# asksin-mitschnitt 1',
      '1000\t:5A;',
      '1750\t:5A;',
      '9000\t:5A;', // 7250 ms Stille
      '9750\t:5A;',
      '14000\t:5A;', // 4250 ms Stille
    ].join('\n');
    const a = werteAus(inhalt, 'luecken');

    assert.equal(a.luecken.length, 2);
    assert.equal(a.lueckenAnzahl, 2);
    assert.equal(a.luecken[0]?.dauerMs, 7250, 'die laengste zuerst');
    assert.equal(a.luecken[1]?.dauerMs, 4250);
    assert.equal(a.lueckenGesamtMs, 11500);
  });

  it('zaehlt kaputte Mitschnittzeilen getrennt von verworfenen Funkzeilen', () => {
    // Zwei verschiedene Fehler: eine defekte Datei ist nicht dasselbe wie
    // eine gestoerte Funkstrecke. Wer das vermischt, sucht am falschen Ende.
    const a = werteAus('# asksin-mitschnitt 1\nohne-tabulator\n1000\tMuell\n', 'x');
    assert.equal(a.unlesbar, 1);
    assert.equal(a.verworfen, 1);
    assert.equal(a.zeilen, 1);
  });

  it('kuerzt die Lueckenliste, aber NICHT die Anzahl', () => {
    // Sonst saehen 5 und 500 Luecken im Vergleich gleich aus, und das
    // Werkzeug bescheinigte eine Verbesserung, die es nie gab.
    const z = ['# asksin-mitschnitt 1'];
    let t = 1_000;
    for (let i = 0; i < 30; i++) {
      z.push(`${t}\t:5A;`);
      t += 5_000; // jede Pause ist eine Luecke
    }
    const a = werteAus(`${z.join('\n')}\n`, 'viele', { maxLuecken: 3 });
    assert.equal(a.luecken.length, 3, 'die Liste ist gekuerzt');
    assert.equal(a.lueckenAnzahl, 29, 'die Anzahl nicht');

    const wenig = werteAus(
      ['# asksin-mitschnitt 1', '1000\t:5A;', '9000\t:5A;'].join('\n'),
      'wenig',
      { maxLuecken: 3 },
    );
    const zeile = vergleiche(a, wenig).find((v) => v.groesse === 'Lücken');
    assert.equal(zeile?.vorher, '29', 'der Vergleich sieht die echte Zahl');
    assert.equal(zeile?.richtung, '+');
  });

  it('kommt mit einer leeren Datei zurecht', () => {
    const a = werteAus('', 'leer');
    assert.equal(a.zeilen, 0);
    assert.equal(a.dauerMs, 0);
    assert.equal(a.rauschTakt, null);
    assert.equal(a.zeilenProMinute, 0);
  });
});

describe('Herkunft der Daten', () => {
  it('schreibt die Demo-Kennzeichnung in den Kopf', () => {
    const p = pfad();
    const s = new MitschnittSchreiber({ pfad: p, demo: true, jetzt: () => 0 });
    s.zeile(':5A;', 1);
    s.stop();
    assert.ok(readFileSync(p, 'utf8').includes('# demo ja'));
    assert.equal(werteAus(readFileSync(p, 'utf8'), p).demo, true);
  });

  it('unterscheidet "nein" von "keine Angabe"', () => {
    // Der gefaehrliche Fall ist die alte Datei ohne Kopfzeile. Sie als echt zu
    // behandeln hiesse, Simulation und Wirklichkeit stillschweigend zu mischen.
    assert.equal(werteAus('# asksin-mitschnitt 1\n# demo nein\n1\t:5A;\n').demo, false);
    assert.equal(werteAus('# asksin-mitschnitt 1\n1\t:5A;\n').demo, null);
    assert.equal(werteAus('# asksin-mitschnitt 1\n# demo ja\n1\t:5A;\n').demo, true);
  });

  it('behaelt Leerzeichen im Geraetenamen', () => {
    // "DEMO (simuliert)" wurde zu "DEMO" — und die Klammer war genau der
    // Teil, der die Warnung transportiert.
    const a = werteAus(
      '# asksin-mitschnitt 1\n# geraet DEMO (simuliert) baud 58824\n1\t:5A;\n',
    );
    assert.equal(a.geraet, 'DEMO (simuliert)');
    assert.equal(a.baud, 58824);
  });

  it('ueberliest unbekannte Kopfzeilen, statt sie als Daten zu zaehlen', () => {
    // Damit bleiben Dateien aus kuenftigen Fassungen lesbar — und aeltere
    // Werkzeuge stolpern nicht ueber Zeilen, die es frueher nicht gab.
    const a = werteAus(
      '# asksin-mitschnitt 1\n# irgendwas Neues\n# demo nein\n1000\t:5A;\n',
    );
    assert.equal(a.zeilen, 1);
    assert.equal(a.unlesbar, 0);
    assert.equal(a.demo, false);
  });
});

describe('vergleiche', () => {
  const basis = (verworfen: number, ausreisser: number): string => {
    const z = ['# asksin-mitschnitt 1'];
    let t = 1_700_000_000_000;
    for (let i = 0; i < 100; i++) {
      t += i < ausreisser ? 2000 : 750;
      z.push(`${t}\t:5A;`);
    }
    for (let i = 0; i < verworfen; i++) z.push(`${t + i + 1}\tMuell`);
    return `${z.join('\n')}\n`;
  };

  it('bewertet nur, was von der Firmware abhaengt', () => {
    const v = vergleiche(werteAus(basis(10, 5), 'a'), werteAus(basis(2, 0), 'b'));
    const finde = (name: string) => v.find((z) => z.groesse.startsWith(name));

    assert.equal(finde('Takt-Ausreißer')?.richtung, '+');
    assert.equal(finde('Verworfene Zeilen')?.richtung, '+');
    // Telegramme haengen am Funkverkehr, nicht an der Firmware — sie duerfen
    // nicht als Verbesserung oder Verschlechterung gelesen werden.
    assert.equal(finde('Telegramme')?.aussagekraeftig, false);
    assert.equal(finde('Telegramme')?.richtung, null);
    assert.equal(finde('RSSI')?.aussagekraeftig, false);
  });

  it('meldet eine Verschlechterung als solche', () => {
    const v = vergleiche(werteAus(basis(0, 0), 'a'), werteAus(basis(9, 4), 'b'));
    assert.equal(v.find((z) => z.groesse === 'Verworfene Zeilen')?.richtung, '-');
    assert.equal(v.find((z) => z.groesse === 'Takt-Ausreißer')?.richtung, '-');
  });

  it('rechnet Verworfene auf die Minute um — sonst gewinnt der kuerzere Lauf', () => {
    // Zwei Mitschnitte sind im Alltag nie gleich lang. Absolute Zahlen wuerden
    // dann den kuerzeren automatisch besser aussehen lassen.
    const kurz = werteAus(basis(5, 0), 'kurz');
    const lang = werteAus(`${basis(20, 0)}`, 'lang');
    const zeile = vergleiche(kurz, lang).find(
      (z) => z.groesse === 'Verworfene je Minute',
    );
    assert.ok(zeile);
    assert.notEqual(zeile?.vorher, '—');
  });
});

describe('Ende zu Ende', () => {
  it('aufgezeichnet und wieder ausgewertet ergibt dieselben Zahlen', () => {
    // Der eigentliche Zweck: Schreiber und Auswertung muessen dasselbe Format
    // meinen. Ein Test je Seite wuerde genau diesen Bruch nicht bemerken.
    const p = pfad();
    const s = new MitschnittSchreiber({
      pfad: p,
      geraet: '/dev/ttyAMA0',
      baud: 58824,
      jetzt: () => 0,
    });
    let t = 1_700_000_000_000;
    for (let i = 0; i < 40; i++) {
      s.zeile(':5A;', t);
      t += 750;
    }
    s.zeile(telegramm(), t);
    s.zeile('Boot: AskSin++ V5', t + 10);
    s.stop();

    const a = werteAus(readFileSync(p, 'utf8'), p);
    assert.equal(a.rauschzeilen, 40);
    assert.equal(a.telegramme, 1);
    assert.equal(a.verworfen, 1);
    assert.equal(a.geraet, '/dev/ttyAMA0');
    assert.equal(a.baud, 58824);
    assert.equal(a.rauschTakt?.median, 750);
    assert.equal(a.taktAusreisser, 0);
    assert.equal(a.luecken.length, 0);
    assert.equal(a.lueckenAnzahl, 0);
    assert.equal(a.unlesbar, 0);
    assert.equal(a.zeilen, s.stats().geschrieben);
  });
});
