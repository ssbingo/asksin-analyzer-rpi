import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  SAMMLUNG_FRIST_MIN_MS,
  SAMMLUNG_TAKTE,
  zaehleSammlung,
} from '../src/influx/sammlung.ts';
import type { SammlungBericht } from '../src/influx/sammlung.ts';

const JETZT = 1_800_000_000_000;

function bericht(teil: Partial<SammlungBericht>): SammlungBericht {
  return {
    standort: 'Keller Büro',
    influxAktiv: true,
    letzterErfolg: JETZT - 30_000,
    intervallSekunden: 60,
    ...teil,
  };
}

test('drei liefernde Standorte werden zu drei', () => {
  const s = zaehleSammlung(
    [
      bericht({ standort: 'Keller Büro' }),
      bericht({ standort: 'Dachboden' }),
      bericht({ standort: 'Gartenhaus' }),
    ],
    JETZT,
  );
  assert.deepEqual(s.liefern, ['Dachboden', 'Gartenhaus', 'Keller Büro']);
  assert.deepEqual(s.stumm, []);
});

test('wer nicht schreibt, zaehlt nicht mit — wird aber benannt', () => {
  // Der urspruengliche Anspruch der Anzeige: Ein eingetragener, aber
  // ausgefallener Standort darf keine Vollstaendigkeit vortaeuschen.
  const s = zaehleSammlung(
    [
      bericht({ standort: 'Keller Büro' }),
      bericht({ standort: 'Gartenhaus', letzterErfolg: JETZT - 3 * 3_600_000 }),
      bericht({ standort: 'Dachboden', influxAktiv: false }),
      bericht({ standort: 'Schuppen', letzterErfolg: null }),
    ],
    JETZT,
  );
  assert.deepEqual(s.liefern, ['Keller Büro']);
  // Abgeschaltet ist etwas anderes als stumm: Wer die Aufzeichnung gar nicht
  // eingeschaltet hat, ist kein Stoerfall und taucht nirgends auf.
  assert.deepEqual(s.stumm, ['Gartenhaus', 'Schuppen']);
});

test('ein einzelner verpasster Durchgang wirft niemanden hinaus', () => {
  // Netz kurz weg, InfluxDB startet neu — das darf die Anzeige nicht flackern
  // lassen. Wer sie flackern sieht, traut ihr danach nicht mehr.
  const knapp = bericht({ letzterErfolg: JETZT - 2 * 60_000, intervallSekunden: 60 });
  assert.deepEqual(zaehleSammlung([knapp], JETZT).liefern, ['Keller Büro']);
  // Erst nach drei Takten gilt er als stumm — und nie frueher als nach der
  // Mindestfrist, selbst bei einem Takt von fuenf Sekunden.
  const schnell = bericht({
    letzterErfolg: JETZT - (SAMMLUNG_FRIST_MIN_MS - 1_000), intervallSekunden: 5,
  });
  assert.deepEqual(zaehleSammlung([schnell], JETZT).liefern, ['Keller Büro'],
    'Mindestfrist schlaegt den kurzen Takt');
  const langsam = bericht({
    letzterErfolg: JETZT - 3_600_000 * 2, intervallSekunden: 3600,
  });
  assert.deepEqual(zaehleSammlung([langsam], JETZT).liefern, ['Keller Büro'],
    'bei Stundentakt sind zwei Stunden noch in Ordnung');
  const zuLang = bericht({
    letzterErfolg: JETZT - 3_600_000 * (SAMMLUNG_TAKTE + 1), intervallSekunden: 3600,
  });
  assert.deepEqual(zaehleSammlung([zuLang], JETZT).liefern, []);
});

test('derselbe Standortname zaehlt einmal', () => {
  // Die alte Abfrage lieferte Tag-Werte aus der Datenbank und hatte diese
  // Eigenschaft von selbst. Beim Wechsel der Quelle darf sie nicht verloren
  // gehen — sonst zeigte die Uebersicht ploetzlich mehr Standorte als die
  // Auswertung in Grafana kennt.
  const s = zaehleSammlung(
    [bericht({ standort: 'Keller Büro' }), bericht({ standort: 'Keller Büro' })],
    JETZT,
  );
  assert.deepEqual(s.liefern, ['Keller Büro']);
});

test('liefert eines von zwei Geraeten desselben Standorts, liefert der Standort', () => {
  // Die Datenbank bekommt ihre Daten. Das schweigende Geraet ist ein anderes
  // Thema und steht in der Verbund-Ansicht, nicht hier.
  const s = zaehleSammlung(
    [
      bericht({ standort: 'Dachboden' }),
      bericht({ standort: 'Dachboden', letzterErfolg: JETZT - 86_400_000 }),
    ],
    JETZT,
  );
  assert.deepEqual(s.liefern, ['Dachboden']);
  assert.deepEqual(s.stumm, [], 'nicht gleichzeitig liefernd und stumm');
});

test('eine vorlaufende Uhr ist kein Beleg fuer Stille', () => {
  const s = zaehleSammlung([bericht({ letzterErfolg: JETZT + 600_000 })], JETZT);
  assert.deepEqual(s.liefern, ['Keller Büro']);
});

test('leere Namen werden nicht gezaehlt', () => {
  assert.deepEqual(zaehleSammlung([bericht({ standort: '   ' })], JETZT).liefern, []);
});

test('ein frisch gestarteter Analyzer heisst nicht "seit Langem still"', () => {
  // Nach jeder Aktualisierung steht ein voellig gesunder Analyzer fuer die
  // Dauer eines Schreibtakts ohne letzterErfolg da. Er zaehlt zu Recht noch
  // nicht mit — aber die Anzeige darf ihn nicht als Stoerfall ausgeben.
  // Beobachtet am 25.08.2026 an Dachboden, unmittelbar nach dem Rollout.
  const frisch = bericht({ standort: 'Dachboden', letzterErfolg: null });
  const s = zaehleSammlung([bericht({ standort: 'Keller Büro' }), frisch], JETZT);
  assert.deepEqual(s.liefern, ['Keller Büro']);
  assert.deepEqual(s.stumm, ['Dachboden'], 'genannt, aber nicht mitgezaehlt');
});

test('der Master fragt sich nicht selbst ueber HTTP', () => {
  // Sonst ruft /api/langzeitdaten sich selbst auf, dieser Aufruf ruft wieder
  // ermittleSammlung(), und das endet erst in Zeitueberschreitungen — die
  // Kachel zeigte danach wieder einen Strich, diesmal aus dem umgekehrten
  // Grund. Am 25.08.2026 genau so erlebt.
  const daemon = readFileSync(
    resolve(import.meta.dirname, '../bin/analyzerd.ts'), 'utf8',
  );
  const block = /async function ermittleSammlung[\s\S]*?\n}/.exec(daemon)?.[0] ?? '';
  assert.ok(block !== '', 'ermittleSammlung gefunden');
  assert.match(block, /allePeers\(\)\.filter/, 'die eigene Adresse wird ausgenommen');
  assert.match(block, /const eigene = /, 'und dafuer auch bestimmt');
  // Der eigene Bericht muss trotzdem drin sein — sonst zaehlte sich der
  // Master selbst nicht mit, und aus drei Standorten wuerden zwei.
  const vorFilter = block.slice(0, block.indexOf('allePeers()'));
  assert.match(vorFilter, /standort,/, 'der eigene Standort kommt direkt hinein');
});
