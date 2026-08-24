import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  SYSTEMUPDATE_STECKEN_MS,
  SYSTEMUPDATE_WARNUNG_TAGE,
  bewerteAlter,
  laeuftNoch,
  zaehleAufgeruestet,
} from '../src/update/systemupdate.ts';
import type { SystemupdateStatus } from '../src/update/systemupdate.ts';

const TAG = 86_400_000;
const JETZT = 1_800_000_000_000;

test('Alter: noch nie ist etwas anderes als lange her', () => {
  // Bei einem frisch aufgesetzten Geraet ist "noch nie" der Normalzustand und
  // kein Versaeumnis. Die Oberflaeche faerbt beides gleich, sagt aber
  // Verschiedenes — deshalb eine eigene Stufe statt „vor 20000 Tagen".
  const nie = bewerteAlter(null, JETZT);
  assert.equal(nie.stufe, 'nie');
  assert.equal(nie.alterTage, null);
  assert.match(nie.text, /noch nie/i);
});

test('Alter: die Grenze liegt genau bei sieben Tagen', () => {
  assert.equal(bewerteAlter(JETZT, JETZT).stufe, 'frisch', 'gerade eben');
  assert.equal(bewerteAlter(JETZT - 6 * TAG, JETZT).stufe, 'frisch', 'sechs Tage');
  // Der Tag davor ist noch in Ordnung, dieser nicht mehr. Genau hier vertut
  // man sich mit < statt <=, und der Fehler faellt eine Woche lang nicht auf.
  assert.equal(bewerteAlter(JETZT - 7 * TAG, JETZT).stufe, 'ueberfaellig', 'sieben Tage');
  assert.equal(bewerteAlter(JETZT - 30 * TAG, JETZT).stufe, 'ueberfaellig', 'ein Monat');
  assert.equal(SYSTEMUPDATE_WARNUNG_TAGE, 7);
});

test('Alter: angebrochene Tage zaehlen nicht mit', () => {
  // Sechs Tage und 23 Stunden sind sechs Tage. Aufrunden liesse die Warnung
  // einen Tag zu frueh erscheinen — und wer sie dann befolgt, aktualisiert
  // ein System, das gestern schon aktuell war.
  assert.equal(bewerteAlter(JETZT - (7 * TAG - 1), JETZT).alterTage, 6);
  assert.equal(bewerteAlter(JETZT - (7 * TAG - 1), JETZT).stufe, 'frisch');
  assert.equal(bewerteAlter(JETZT - TAG, JETZT).text, 'Vor 1 Tag aktualisiert.');
  assert.equal(bewerteAlter(JETZT - 2 * TAG, JETZT).text, 'Vor 2 Tagen aktualisiert.');
  assert.equal(bewerteAlter(JETZT - 1000, JETZT).text, 'Heute aktualisiert.');
});

test('Alter: ein Zeitstempel aus der Zukunft warnt nicht', () => {
  // Der Pi hat keine Batterieuhr. Vor dem ersten NTP-Abgleich kann die Uhr
  // hinter dem Zeitstempel liegen — „vor −3 Tagen aktualisiert" waere Unsinn,
  // und eine Warnung waere schlicht falsch.
  const befund = bewerteAlter(JETZT + 30 * TAG, JETZT);
  assert.equal(befund.stufe, 'frisch');
  assert.equal(befund.alterTage, 0);
});

test('apt-Zusammenfassung wird gelesen — englisch wie deutsch', () => {
  const englisch = [
    'Reading package lists... Done',
    '12 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.',
  ].join('\n');
  assert.equal(zaehleAufgeruestet(englisch), 12);
  assert.equal(
    zaehleAufgeruestet('0 aktualisiert, 0 neu installiert, 0 zu entfernen'),
    0,
    'null Pakete ist eine Antwort, nicht „unbekannt"',
  );
  assert.equal(zaehleAufgeruestet('irgendwas ganz anderes'), null);
});

test('Sperre: ein steckengebliebener Lauf gibt wieder frei', () => {
  // Eine Sperre, aus der nur der Erfolgsfall herausfuehrt, ist keine Sperre,
  // sondern eine Falle — beim Core-Update am 10.08.2026 genau so erlebt.
  const basis: SystemupdateStatus = {
    running: true, schritt: 'aufruesten', ok: null,
    startedAt: JETZT - 60_000, updatedAt: JETZT - 60_000,
    pakete: null, neustartNoetig: false, fehler: null,
  };
  assert.equal(laeuftNoch(basis, JETZT), true, 'frische Meldung = laeuft');
  assert.equal(
    laeuftNoch({ ...basis, updatedAt: JETZT - SYSTEMUPDATE_STECKEN_MS - 1 }, JETZT),
    false,
    'seit ueber einer Stunde kein Lebenszeichen = haengt',
  );
  assert.equal(laeuftNoch({ ...basis, running: false }, JETZT), false);
  assert.equal(laeuftNoch(null, JETZT), false);
});

test('das Helferskript und der Core reden von denselben Dateien', () => {
  // Zwei Seiten, eine Annahme: Schreibt das Skript nach systemupdate-status
  // und liest der Core systemupdate-stand, meldet niemand etwas — die
  // Oberflaeche zeigte einfach ewig „noch nie aktualisiert".
  const skript = readFileSync(
    resolve(import.meta.dirname, '../../deploy/systemupdate.sh'), 'utf8',
  );
  const daemon = readFileSync(
    resolve(import.meta.dirname, '../bin/analyzerd.ts'), 'utf8',
  );
  for (const datei of [
    'systemupdate-anstoss',
    'systemupdate-status.json',
    'systemupdate-erfolg.json',
    'systemupdate.log',
  ]) {
    assert.ok(skript.includes(datei), `Skript kennt ${datei} nicht`);
    assert.ok(daemon.includes(datei), `Der Dienst kennt ${datei} nicht`);
  }
  // Die Schritte, die das Skript meldet, muessen zum Typ passen — sonst zeigt
  // die Oberflaeche einen Fortschritt, den es nicht gibt.
  for (const schritt of ['start', 'paketlisten', 'aufruesten', 'aufraeumen', 'fertig']) {
    assert.ok(
      skript.includes(`schreibe_status true ${schritt}`)
        || skript.includes(`schreibe_status false ${schritt}`),
      `Skript meldet den Schritt ${schritt} nicht`,
    );
  }
});
