import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ANTWORTFRIST_MS, baueFirmwarebefund } from '../src/decode/firmwarebefund.ts';
import { parseAntwort, parseLine, pruefsumme } from '../src/decode/parseLine.ts';
import { FOLGE_RAUM, Folgezaehler, NEUANFANG_AB } from '../src/ingest/folge.ts';
import { SerialIngest } from '../src/ingest/ingest.ts';
import type { IngestStream } from '../src/ingest/ingest.ts';

/**
 * Hängt den Anhang an, wie die Firmware es tut.
 *
 * Das '+' gehört mit in die Summe — es liegt zwischen ';' und der
 * Folgenummer, und die Vorgabe deckt „alle Zeichen von ':' bis
 * einschließlich der letzten Ziffer der Folgenummer" ab. Hier stand es
 * früher nicht, genau wie im Parser: Der Test baute seine Zeilen mit
 * derselben falschen Formel, gegen die er prüfte, und war deshalb grün,
 * während der Analyzer am Gerät jede einzelne Zeile verwarf.
 *
 * Gegen diese Art Selbstbestätigung hilft nur eine Quelle von außen —
 * dafür stehen weiter unten echte, am 10.08.2026 an Analyzer 01
 * mitgeschnittene Zeilen.
 */
function mitAnhang(rahmen: string, folge: number): string {
  const nummer = folge.toString(16).toUpperCase().padStart(4, '0');
  const summe = pruefsumme(`${rahmen}+${nummer}`)
    .toString(16)
    .toUpperCase()
    .padStart(2, '0');
  return `${rahmen}+${nummer}${summe}`;
}

const TELEGRAMM = ':5A0B01A002ABCDEF1234560102;';

describe('Anhang der erweiterten Firmware', () => {
  it('liest Folgenummer und Pruefsumme, ohne den Rahmen zu veraendern', () => {
    const zeile = mitAnhang(TELEGRAMM, 0x1234);
    const r = parseLine(zeile, () => 1000);

    assert.equal(r.kind, 'telegram');
    if (r.kind !== 'telegram') return;
    assert.equal(r.folge, 0x1234);
    assert.equal(r.telegram.from, 'ABCDEF');
    // Die Rohzeile bleibt OHNE Anhang: Sie geht in die Datenbank und in den
    // Wiedergabe-Modus, und dort muss das Format stabil bleiben.
    assert.equal(r.telegram.raw, TELEGRAMM);
  });

  it('liest den Anhang auch an einer Rauschzeile', () => {
    const r = parseLine(mitAnhang(':5A;', 7), () => 1000);
    assert.equal(r.kind, 'noise');
    if (r.kind !== 'noise') return;
    assert.equal(r.folge, 7);
    assert.equal(r.noise.rssi, -90);
  });

  it('verwirft eine Zeile mit falscher Pruefsumme — und sagt warum', () => {
    // Das ist der eigentliche Gewinn: Bisher waere aus dieser Zeile ein
    // Telegramm mit falschem Inhalt geworden, und niemand haette es bemerkt.
    const echt = mitAnhang(TELEGRAMM, 5);
    const gefaelscht = `${echt.slice(0, -2)}00`;
    const r = parseLine(gefaelscht, () => 1000);

    assert.equal(r.kind, 'ignored');
    if (r.kind !== 'ignored') return;
    assert.equal(r.reason, 'checksum');
  });

  it('bemerkt ein gekipptes Zeichen mitten im Telegramm', () => {
    const echt = mitAnhang(TELEGRAMM, 5);
    const kaputt = `${echt.slice(0, 10)}F${echt.slice(11)}`;
    const r = parseLine(kaputt, () => 1000);
    assert.equal(r.kind, 'ignored');
    if (r.kind !== 'ignored') return;
    assert.equal(r.reason, 'checksum');
  });

  it('bemerkt eine verfaelschte FOLGENUMMER', () => {
    // Deshalb deckt die Pruefsumme die Nummer mit ab: Sonst koennte gerade
    // die Zahl kippen, die den Verlust sichtbar machen soll.
    const echt = mitAnhang(':5A;', 0x0010);
    const kaputt = echt.replace('+0010', '+0020');
    const r = parseLine(kaputt, () => 1000);
    assert.equal(r.kind, 'ignored');
    if (r.kind !== 'ignored') return;
    assert.equal(r.reason, 'checksum');
  });

  it('laesst Zeilen ohne Anhang unveraendert durch', () => {
    // Rueckwaertskompatibilitaet: Die alte Firmware muss weiterlaufen.
    const r = parseLine(TELEGRAMM, () => 1000);
    assert.equal(r.kind, 'telegram');
    if (r.kind !== 'telegram') return;
    assert.equal(r.folge, undefined);
  });
});

describe('Antworten der Firmware', () => {
  it('liest die Versionsauskunft samt Selbsttest', () => {
    const a = parseAntwort(':!AS,1,2,8,14;');
    assert.deepEqual(a, {
      art: 'version',
      protokoll: 1,
      firmware: 2,
      taktMHz: 8,
      cc1101: 0x14,
    });
  });

  it('meldet ein totes Funkmodul als null, nicht als 0', () => {
    // 0 waere ein Messwert. null ist "keine Antwort". Der Unterschied
    // entscheidet, ob jemand an der Antenne sucht oder am Steckverbinder.
    const a = parseAntwort(':!AS,1,1,8,--;');
    assert.equal(a?.art, 'version');
    if (a?.art !== 'version') return;
    assert.equal(a.cc1101, null);
  });

  it('liest die Bestaetigung der Freischaltung', () => {
    assert.deepEqual(parseAntwort(':!E,1;'), { art: 'erweitert', an: true });
    assert.deepEqual(parseAntwort(':!E,0;'), { art: 'erweitert', an: false });
  });

  it('erkennt normale Zeilen NICHT als Antwort', () => {
    assert.equal(parseAntwort(TELEGRAMM), null);
    assert.equal(parseAntwort(':5A;'), null);
  });

  it('eine Antwort ist kein Verwurf', () => {
    // Sonst zaehlte jede Auskunft als Stoerung, und die Fehlerzaehler
    // stiegen ausgerechnet dann, wenn alles funktioniert.
    const r = parseLine(':!AS,1,1,8,14;', () => 1000);
    assert.equal(r.kind, 'antwort');
  });
});

describe('Folgezaehler', () => {
  it('zaehlt lueckenlos, ohne Verlust zu melden', () => {
    const z = new Folgezaehler();
    for (let i = 0; i < 200; i++) z.melde(i);
    assert.equal(z.stats().verloren, 0);
    assert.equal(z.stats().gesehen, 200);
    assert.equal(z.stats().verlustProzent, 0);
  });

  it('rechnet aus, WIE VIELE Zeilen fehlen', () => {
    const z = new Folgezaehler();
    z.melde(41);
    const b = z.melde(45);
    assert.deepEqual(b, { art: 'verlust', anzahl: 3 });
    assert.equal(z.stats().verloren, 3);
  });

  it('behandelt den Ueberlauf als das, was er ist — kein Verlust', () => {
    const z = new Folgezaehler();
    z.melde(0xfffe);
    assert.deepEqual(z.melde(0xffff), { art: 'lueckenlos' });
    assert.deepEqual(z.melde(0x0000), { art: 'ueberlauf' });
    assert.equal(z.stats().verloren, 0);
    assert.equal(z.stats().ueberlaeufe, 1);
  });

  it('rechnet einen Verlust UEBER den Ueberlauf hinweg richtig', () => {
    // FFFE -> 0002: erwartet waere FFFF, es fehlen drei. Ohne Ringrechnung
    // kaeme hier eine absurde Zahl heraus.
    const z = new Folgezaehler();
    z.melde(0xfffe);
    assert.deepEqual(z.melde(0x0002), { art: 'verlust', anzahl: 3 });
    assert.equal(z.stats().verloren, 3);
  });

  it('erkennt einen Firmware-Neustart statt 65000 verlorener Zeilen', () => {
    // Das ist der Fall, der die Statistik zerstoeren wuerde: Nach einem
    // Neustart faengt die Firmware bei 0 an. Als Verlust gebucht waere das
    // ein Ausfall von zwei Wochen — und ein Alarm, wo nur ein Neustart war.
    const z = new Folgezaehler();
    for (let i = 0; i < 100; i++) z.melde(50_000 + i);
    const b = z.melde(0);
    assert.deepEqual(b, { art: 'neuanfang' });
    assert.equal(z.stats().verloren, 0);
    assert.equal(z.stats().neuanfaenge, 1);
  });

  it('die Grenze zwischen Verlust und Neuanfang liegt, wo sie dokumentiert ist', () => {
    const knapp = new Folgezaehler();
    knapp.melde(0);
    assert.deepEqual(knapp.melde(NEUANFANG_AB - 1), {
      art: 'verlust',
      anzahl: NEUANFANG_AB - 2,
    });

    const darueber = new Folgezaehler();
    darueber.melde(0);
    assert.deepEqual(darueber.melde(NEUANFANG_AB + 1), { art: 'neuanfang' });
  });

  it('meldet einen kleinen Ruecksprung als eigenen Befund', () => {
    // Eine UART ordnet nicht um. Passiert es doch, ist das ein Hinweis auf
    // etwas Ernstes und darf nicht in "Neustart" verschwinden.
    const z = new Folgezaehler();
    z.melde(100);
    assert.deepEqual(z.melde(98), { art: 'rueckwaerts' });
    assert.equal(z.stats().verloren, 0);
    assert.equal(z.stats().neuanfaenge, 0, 'kein Neustart');
  });

  it('haelt sich mit Prozentangaben zurueck, solange die Grundlage fehlt', () => {
    const z = new Folgezaehler();
    z.melde(0);
    z.melde(5);
    assert.equal(z.stats().verlustProzent, null, 'unter 100 Zeilen keine Quote');

    for (let i = 6; i < 200; i++) z.melde(i);
    const p = z.stats().verlustProzent;
    assert.ok(p !== null && p > 0 && p < 5);
  });

  it('faengt beim Zuruecksetzen sauber von vorn an', () => {
    const z = new Folgezaehler();
    z.melde(10);
    z.melde(20);
    z.zuruecksetzen();
    assert.deepEqual(z.stats().letzte, null);
    assert.equal(z.stats().verloren, 0);
    assert.deepEqual(z.melde(500), { art: 'erste' });
  });
});

describe('Freischaltung beim Verbindungsaufbau', () => {
  function strom(zeilen: string[], geschrieben: string[]): IngestStream {
    return {
      readable: (async function* () {
        yield new TextEncoder().encode(`${zeilen.join('\r\n')}\r\n`);
      })(),
      close() {},
      schreibe(text: string) {
        geschrieben.push(text);
      },
    };
  }

  async function laufen(ingest: SerialIngest): Promise<void> {
    ingest.start();
    await new Promise((r) => setTimeout(r, 150));
    await ingest.stop();
  }

  it('fragt AUCH DANN, wenn keine einzige Zeile deutbar ist', async () => {
    // Der Fehler vom 10.08.2026, und der wichtigste dieser Reihe.
    //
    // Die Versionsfrage hing an der ersten GUELTIGEN Zeile. Fehlt das
    // Funkmodul, liest der SPI-Bus 0x00 oder 0xFF, der Pegel jeder
    // Rauschzeile wird unplausibel, und der Parser verwirft sie zu Recht —
    // restlos alle. Also wurde nie gefragt, und ausgerechnet die Auskunft,
    // die das fehlende Funkmodul benennt, kam nie zustande.
    //
    // An zwei Geraeten gesehen: 212 Zeilen, alle verworfen, "Versionsfrage
    // wurde noch nicht gestellt". Das Schwestergeraet hatte genau EINE
    // Rauschzeile, die durchkam, und meldete prompt die richtige Fassung.
    const geschrieben: string[] = [];
    const ingest = new SerialIngest({
      // ':FF;' und ':00;' liegen ausserhalb des plausiblen Pegelbereichs —
      // genau das sendet die Firmware ohne antwortendes Funkmodul.
      openPort: async () => strom([':FF;', ':00;', ':FF;'], geschrieben),
      silenceTimeoutMs: 50,
    });
    await laufen(ingest);
    assert.deepEqual(geschrieben, [':?;', ':E1;'],
      'ohne Frage kann die Firmware nicht sagen, dass ihr Funkmodul fehlt');
    assert.notEqual(ingest.stats.firmwareGefragtAm, null,
      'der Zeitpunkt der Frage muss gesetzt sein');
  });

  it('meldet die Firmware einen wiederhergestellten Empfang, wird es gezaehlt', async () => {
    // Ab Firmware 2. Am 14.08.2026 lieferte Analyzer 01 stundenlang keine
    // Telegramme, waehrend die Rauschzeilen im 750-ms-Takt weiterliefen: der
    // CC1101 hing, das RSSI-Register blieb lesbar. Die Firmware erkennt das
    // jetzt selbst und setzt den Empfang neu auf — und sagt, in welchem
    // Zustand sie den Chip angetroffen hat.
    const befunde: string[] = [];
    const ingest = new SerialIngest({
      openPort: async () => strom([':5A;', ':!RX,11;', ':5B;', ':!RX,01;'], []),
      silenceTimeoutMs: 50,
      onFirmware: (a) => {
        if (a.art === 'empfang') befunde.push(`0x${a.zustand.toString(16)}`);
      },
    });
    await laufen(ingest);

    assert.deepEqual(befunde, ['0x11', '0x1'], 'beide Befunde kommen durch');
    assert.equal(ingest.stats.empfangErholungen, 2);
    assert.equal(ingest.stats.letzterEmpfangszustand, 0x01);
    // Und sie duerfen NICHT als verworfene Zeilen zaehlen — sonst sieht der
    // Selbstheilungsbericht aus wie eine Stoerung der Strecke.
    const summe = Object.values(ingest.stats.ignored).reduce((a, b) => a + b, 0);
    assert.equal(summe, 0, 'Antworten sind keine Fehler');
  });

  it('startet die Firmware neu, wird die Erweiterung neu freigeschaltet', async () => {
    // Am 14.08.2026 gemessen: Nach einem Reset des 328P ueber GPIO4 lief die
    // Firmware in der EINFACHEN Betriebsart weiter — die serielle Verbindung
    // war ja nie abgerissen, und `:E1;` schickte der Core nur einmal je
    // Verbindung. Folge: keine Folgenummern, keine Pruefsummen. `Folge:
    // gesehen` stand fest auf 76, waehrend `Zeilen` weiterlief. Die
    // Verlusterkennung war still gestorben.
    //
    // Die Startmeldung `:!CC,…;` kommt ungefragt nach jedem Hochlaufen und
    // ist damit die Nachricht "ich bin neu gestartet".
    const geschrieben: string[] = [];
    const ingest = new SerialIngest({
      openPort: async () =>
        strom(
          [':5A;', ':!AS,1,1,8,14;', ':!E,1;', ':5B;', ':!CC,14;', ':5C;'],
          geschrieben,
        ),
      silenceTimeoutMs: 50,
    });
    await laufen(ingest);

    assert.deepEqual(
      geschrieben,
      [':?;', ':E1;', ':?;', ':E1;'],
      'nach der Startmeldung muss erneut freigeschaltet werden',
    );
    assert.equal(ingest.stats.firmwareNeustarts, 1, 'der Neustart wird gezaehlt');
  });

  it('fragt die Firmware und schaltet die Erweiterung frei', async () => {
    const geschrieben: string[] = [];
    const ingest = new SerialIngest({
      openPort: async () => strom([':5A;', ':!AS,1,1,8,14;', ':!E,1;'], geschrieben),
      silenceTimeoutMs: 50,
    });
    await laufen(ingest);

    assert.deepEqual(geschrieben, [':?;', ':E1;']);
    assert.equal(ingest.stats.erweitert, true);
    assert.deepEqual(ingest.stats.firmware, {
      art: 'version',
      protokoll: 1,
      firmware: 1,
      taktMHz: 8,
      cc1101: 0x14,
    });
  });

  it('kommt ohne Antwort zurecht — dann laeuft die alte Firmware', async () => {
    // Das Ausbleiben der Antwort IST die Auskunft. Es darf kein Fehler
    // daraus werden, sonst meldete jeder Analyzer mit Originalfirmware
    // dauerhaft eine Stoerung.
    const geschrieben: string[] = [];
    const ingest = new SerialIngest({
      openPort: async () => strom([':5A;', ':5B;'], geschrieben),
      silenceTimeoutMs: 50,
    });
    await laufen(ingest);

    assert.equal(ingest.stats.erweitert, false);
    assert.equal(ingest.stats.firmware, null);
    assert.equal(ingest.stats.ignored['not-hex'], 0, 'keine Fehlerzaehlung');
    assert.equal(ingest.stats.folge.gesehen, 0);
  });

  it('schreibt nichts, wenn der Port es nicht kann', async () => {
    // Aeltere Portoeffner haben keine schreibe()-Methode. Das darf nicht
    // stuerzen — der Empfang ist die Hauptsache.
    const ingest = new SerialIngest({
      openPort: async () => ({
        readable: (async function* () {
          yield new TextEncoder().encode(':5A;\r\n');
        })(),
        close() {},
      }),
      silenceTimeoutMs: 50,
    });
    await laufen(ingest);
    assert.equal(ingest.stats.noise, 1);
    assert.equal(ingest.stats.erweitert, false);
  });

  it('laesst sich abschalten', async () => {
    const geschrieben: string[] = [];
    const ingest = new SerialIngest({
      openPort: async () => strom([':5A;'], geschrieben),
      erweiterungAnfordern: false,
      silenceTimeoutMs: 50,
    });
    await laufen(ingest);
    assert.deepEqual(geschrieben, []);
  });

  it('zaehlt Verluste ueber den ganzen Strom', async () => {
    const geschrieben: string[] = [];
    const zeilen = [
      mitAnhang(':5A;', 0),
      mitAnhang(':5A;', 1),
      mitAnhang(':5A;', 5), // drei fehlen
      mitAnhang(':5A;', 6),
    ];
    const ingest = new SerialIngest({
      openPort: async () => strom(zeilen, geschrieben),
      silenceTimeoutMs: 50,
    });
    await laufen(ingest);

    assert.equal(ingest.stats.folge.gesehen, 4);
    assert.equal(ingest.stats.folge.verloren, 3);
    assert.equal(ingest.stats.noise, 4);
  });
});

describe('Pruefsumme', () => {
  it('stimmt zeichenweise mit der Firmware ueberein', () => {
    // Beide Seiten sind durch docs/protokoll.md gebunden. Weicht eine ab,
    // verwirft der Analyzer JEDE Zeile — dieser Test ist die einzige Stelle,
    // an der das vor dem Aufspielen auffallen kann.
    assert.equal(pruefsumme(''), 0);
    assert.equal(pruefsumme('A'), 65);
    // ':5A;+0000' — von Hand nachgerechnet, MIT dem '+' (43).
    const soll = (58 + 53 + 65 + 59 + 43 + 48 * 4) & 0xff;
    assert.equal(pruefsumme(':5A;+0000'), soll);
  });

  it('laeuft bei 256 sauber ueber', () => {
    const lang = 'Z'.repeat(1000);
    const p = pruefsumme(lang);
    assert.ok(p >= 0 && p <= 255);
    assert.equal(p, (90 * 1000) & 0xff);
  });

  it('nimmt echte Zeilen vom Gerät an', () => {
    // Am 10.08.2026 an Analyzer 01 mitgeschnitten, unmittelbar nachdem das
    // Funkmodul bestückt war — mit `cat /dev/asksin-hat`, also roh und
    // ungefiltert. Diese Zeilen sind der Prüfstein: Sie stammen aus der
    // Firmware selbst und teilen keine Annahme mit dem Analyzer. Die
    // handgebauten Zeilen weiter oben konnten das nicht leisten; sie waren
    // grün, während am Gerät ausnahmslos alles verworfen wurde.
    const echt = [
      ':72;+02AFF2',
      ':73;+02B0DE',
      ':6E;+02B3F2',
      ':460CED84702D88B400000001022C;+032B64',
      ':52131200835AAC3CF0000100003CA6D1F5303514DC;+03305A',
      ':430D66A6102499E127508B06012800;+035ABF',
      ':532110008E3CC0A2BEF6470003DA72EBDB39E53E7AD7EBDDAEC4AA792B616B80FD6900;+039262',
    ];
    for (const zeile of echt) {
      const p = parseLine(zeile, () => 0);
      assert.notEqual(p.kind, 'ignored', `verworfen: ${zeile}`);
    }
    // Und die Deutung muss auch stimmen, nicht nur das Durchkommen:
    const rausch = parseLine(':72;+02AFF2', () => 0);
    assert.equal(rausch.kind, 'noise');
    assert.equal(rausch.kind === 'noise' ? rausch.noise.rssi : 0, -0x72);
    assert.equal(rausch.kind === 'noise' ? rausch.folge : -1, 0x02af);

    const tele = parseLine(':460CED84702D88B400000001022C;+032B64', () => 0);
    assert.equal(tele.kind, 'telegram');
    assert.equal(tele.kind === 'telegram' ? tele.telegram.rssi : 0, -0x46);
    // :46 0C ED 84 70 2D88B4 000000 01022C ;
    //  ^  ^  ^  ^  ^  ^      ^      ^
    //  |  |  |  |  |  |      |      Payload, LL-9 = 3 Byte
    //  |  |  |  |  |  |      Empfaenger (Broadcast)
    //  |  |  |  |  |  Absender
    //  |  |  |  |  Typ
    //  |  |  |  Flags
    //  |  |  Zaehler
    //  |  Laenge
    //  RSSI-Betrag
    assert.equal(tele.kind === 'telegram' ? tele.telegram.from : '', '2D88B4');
    assert.equal(tele.kind === 'telegram' ? tele.telegram.to : '', '000000');

    // Eine verfälschte Zeile muss weiterhin auffallen — sonst hätte ich die
    // Prüfung nur abgeschaltet statt richtiggestellt.
    const kaputt = parseLine(':72;+02AFF3', () => 0);
    assert.equal(kaputt.kind, 'ignored');
    assert.equal(kaputt.kind === 'ignored' ? kaputt.reason : '', 'checksum');
  });

  it('deckt genau den Bereich ab, den die Firmware auch deckt', () => {
    // FOLGE_RAUM taucht hier auf, damit der Test bricht, wenn jemand die
    // Nummer auf 8 oder 32 Bit aendert, ohne das Format anzupassen.
    assert.equal(FOLGE_RAUM, 0x10000);
    assert.equal((0xffff).toString(16).padStart(4, '0').length, 4);
  });
});

describe('Versionsabhaengigkeit Firmware <-> Analyzer', () => {
  it('spricht den guten Fall aus, statt zu schweigen', () => {
    // Dieselbe Regel wie beim Adapter: Schweigen bei Erfolg waere
    // mehrdeutig — "geprueft und in Ordnung" saehe aus wie "konnte nicht
    // pruefen".
    const b = baueFirmwarebefund(
      { art: 'version', protokoll: 1, firmware: 1, taktMHz: 8, cc1101: 0x14 },
      '0.13.0',
    );
    assert.equal(b.art, 'passt');
    assert.match(b.text, /passen/);
    assert.match(b.text, /0x14/);
  });

  it('behauptet nichts, solange die Antwort noch aussteht', () => {
    // Der Fehler vom 10.08.2026: Nach einem Dienst-Neustart stand sofort
    // "es laeuft die Originalfassung" da — die Frage war gerade erst
    // hinausgegangen. Nach einem Kaltstart stimmte die Anzeige wieder, weil
    // dann Zeit vergangen war. Aus dem Ausbleiben einer Antwort darf erst
    // dann eine Feststellung werden, wenn sie haette da sein muessen.
    const gerade = baueFirmwarebefund(null, '0.14.1', {
      gefragtAm: 1_000,
      jetzt: 1_200,
    });
    assert.equal(gerade.art, 'unbekannt');
    assert.match(gerade.text, /läuft|steht noch aus/);
    assert.doesNotMatch(gerade.text, /Originalfassung/,
      'darf die Originalfassung nicht behaupten, bevor es sie wissen kann');
  });

  it('behauptet nichts, wenn noch gar nicht gefragt wurde', () => {
    const b = baueFirmwarebefund(null, '0.14.1', { gefragtAm: null, jetzt: 5_000 });
    assert.equal(b.art, 'unbekannt');
    assert.match(b.text, /nicht gestellt|nicht verbunden/);
  });

  it('nach Ablauf der Frist wird aus dem Schweigen eine Auskunft', () => {
    const b = baueFirmwarebefund(null, '0.14.1', {
      gefragtAm: 1_000,
      jetzt: 1_000 + ANTWORTFRIST_MS + 1,
    });
    assert.equal(b.art, 'original');
    assert.match(b.text, /Originalfassung/);
  });

  it('nennt die Originalfirmware beim Namen, ohne sie zu tadeln', () => {
    // Sie laeuft seit Jahren und tut, wofuer sie da ist. Nur eben eines
    // nicht — und genau das soll dastehen.
    const b = baueFirmwarebefund(null, '0.13.0');
    assert.equal(b.art, 'original');
    assert.match(b.text, /Originalfassung/);
    assert.match(b.text, /verlorengehen|Verlust/);
  });

  it('meldet ein totes Funkmodul VOR allem anderen', () => {
    // Das ist der einzige Fall, in dem wirklich etwas kaputt ist. Eine
    // Bemerkung ueber Protokollfassungen verdeckte ihn nur.
    const b = baueFirmwarebefund(
      { art: 'version', protokoll: 1, firmware: 1, taktMHz: 8, cc1101: null },
      '0.13.0',
    );
    assert.equal(b.art, 'funkmodul');
    assert.match(b.text, /CC1101/);
    assert.match(b.text, /nicht die\s+Antenne|nicht die Antenne/);
  });

  it('weist eine zu neue Firmware aus und beruhigt zugleich', () => {
    const b = baueFirmwarebefund(
      { art: 'version', protokoll: 99, firmware: 9, taktMHz: 8, cc1101: 0x14 },
      '0.13.0',
    );
    assert.equal(b.art, 'zuNeu');
    assert.match(b.text, /Analyzer aktualisieren/);
    // Wichtig: Es geht nichts verloren, weil die Firmware kompatibel bleibt.
    assert.match(b.text, /nichts verloren/);
  });
});

describe('Startmeldung des Funkmoduls', () => {
  it('liest die ungefragte Selbstauskunft beim Hochlaufen', () => {
    // Die erweiterte Firmware sagt beim Start, ob der CC1101 antwortet —
    // ohne dass jemand fragt. Beim Aufbau ist das die erste Frage ueberhaupt.
    assert.deepEqual(parseAntwort(':!CC,14;'), { art: 'funkmodul', cc1101: 0x14 });
    assert.deepEqual(parseAntwort(':!CC,--;'), { art: 'funkmodul', cc1101: null });
  });

  it('die Startmeldung zaehlt NICHT als verworfene Zeile', () => {
    // Sonst stiege der Fehlerzaehler bei jedem Neustart der Firmware — und
    // ausgerechnet bei einer fehlenden Platine saehe es nach zwei Fehlern
    // statt nach einem Befund aus.
    const r = parseLine(':!CC,--;', () => 1000);
    assert.equal(r.kind, 'antwort');
    if (r.kind !== 'antwort') return;
    assert.equal(r.antwort.art, 'funkmodul');
  });

  it('unterscheidet fehlendes Modul von Version 0x00', () => {
    // "--" heisst "keine Antwort". 0x00 waere ein gelesener Wert. Der
    // Unterschied entscheidet, wo gesucht wird.
    const ohne = parseAntwort(':!CC,--;');
    const null0 = parseAntwort(':!CC,00;');
    assert.equal(ohne?.art === 'funkmodul' ? ohne.cc1101 : 'x', null);
    assert.equal(null0?.art === 'funkmodul' ? null0.cc1101 : 'x', 0);
  });
});
