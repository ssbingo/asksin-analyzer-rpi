import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  SYSTEMUPDATE_STECKEN_MS,
  SYSTEMUPDATE_WARNUNG_TAGE,
  ZEITPLAN_VORGABE,
  ausfallmonate,
  baueTimer,
  baueUpdateEreignis,
  bewerteAlter,
  kalenderAusdruck,
  laeuftNoch,
  leseTimerJson,
  naechsterLauf,
  pruefeZeitplan,
  warnschwelleTage,
  zaehleAufgeruestet,
} from '../src/update/systemupdate.ts';
import type { SystemupdateStatus } from '../src/update/systemupdate.ts';
import { baueEreignisMeldung } from '../src/langzeit/alarmziel.ts';

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

// ---- Zeitplan (M17.1) ------------------------------------------------------

test('Kalenderausdruck: die drei Rhythmen', () => {
  const p = { ...ZEITPLAN_VORGABE, aktiv: true, stunde: 3, minute: 5 };
  assert.equal(kalenderAusdruck({ ...p, rhythmus: 'taeglich' }), '*-*-* 03:05:00');
  assert.equal(
    kalenderAusdruck({ ...p, rhythmus: 'woechentlich', wochentag: 6 }),
    'Sat *-*-* 03:05:00',
  );
  assert.equal(
    kalenderAusdruck({ ...p, rhythmus: 'monatlich', monatstag: 1 }),
    '*-*-01 03:05:00',
  );
  // Sonntag ist in ISO die 7 und bei systemd "Sun" — nicht die 0.
  assert.equal(
    kalenderAusdruck({ ...p, rhythmus: 'woechentlich', wochentag: 7 }),
    'Sun *-*-* 03:05:00',
  );
});

test('Ausfallmonate: der 31. faellt in fuenf Monaten aus', () => {
  // Gemessen an systemd 257: *-*-31 springt vom 31.08. auf den 31.10., dann
  // den 31.12. September und November fallen ersatzlos aus, ohne Meldung.
  assert.deepEqual(ausfallmonate(28), []);
  assert.deepEqual(ausfallmonate(30), ['Februar']);
  assert.equal(ausfallmonate(29).length, 1);
  assert.match(ausfallmonate(29)[0]!, /Schaltjahr/);
  assert.deepEqual(
    ausfallmonate(31),
    ['Februar', 'April', 'Juni', 'September', 'November'],
  );
});

test('Naechster Lauf: taeglich springt erst nach der Uhrzeit auf morgen', () => {
  const plan = { ...ZEITPLAN_VORGABE, aktiv: true, rhythmus: 'taeglich' as const,
    stunde: 3, minute: 0 };
  // 02:00 Ortszeit — der Lauf steht heute noch bevor.
  const frueh = new Date(2026, 7, 24, 2, 0).getTime();
  assert.equal(new Date(naechsterLauf(plan, frueh)!).getDate(), 24);
  // 04:00 — heute ist er durch, also morgen.
  const spaet = new Date(2026, 7, 24, 4, 0).getTime();
  assert.equal(new Date(naechsterLauf(plan, spaet)!).getDate(), 25);
  assert.equal(naechsterLauf({ ...plan, aktiv: false }, frueh), null);
});

test('Naechster Lauf: woechentlich trifft den richtigen Tag', () => {
  // 24.08.2026 ist ein Montag.
  const montag = new Date(2026, 7, 24, 12, 0).getTime();
  const plan = { ...ZEITPLAN_VORGABE, aktiv: true, rhythmus: 'woechentlich' as const,
    stunde: 3, minute: 0 };
  const samstag = new Date(naechsterLauf({ ...plan, wochentag: 6 }, montag)!);
  assert.equal(samstag.getDay(), 6, 'Samstag');
  assert.equal(samstag.getDate(), 29);
  // Derselbe Wochentag, aber die Uhrzeit ist schon vorbei: erst naechste Woche.
  const naechsterMontag = new Date(naechsterLauf({ ...plan, wochentag: 1 }, montag)!);
  assert.equal(naechsterMontag.getDate(), 31, 'eine Woche weiter');
  // Sonntag = 7 im Plan, 0 in getDay(). Genau hier vertut man sich.
  assert.equal(new Date(naechsterLauf({ ...plan, wochentag: 7 }, montag)!).getDay(), 0);
});

test('Naechster Lauf: der 31. ueberspringt die kurzen Monate', () => {
  const plan = { ...ZEITPLAN_VORGABE, aktiv: true, rhythmus: 'monatlich' as const,
    monatstag: 31, stunde: 3, minute: 0 };
  // Vom 01.09.2026 aus: September hat keinen 31., also der 31. Oktober.
  const september = new Date(2026, 8, 1, 12, 0).getTime();
  const naechster = new Date(naechsterLauf(plan, september)!);
  assert.equal(naechster.getMonth(), 9, 'Oktober');
  assert.equal(naechster.getDate(), 31);
  // Der 29. Februar ist erst 2028 wieder da — die Suche darf nicht aufgeben.
  const feb = { ...plan, monatstag: 29 };
  const nach = new Date(naechsterLauf(feb, new Date(2027, 1, 1, 12, 0).getTime())!);
  assert.equal(nach.getDate(), 29);
  assert.equal(nach.getMonth(), 2, 'kein 29. Februar 2027 — also der 29. Maerz');
});

test('Warnschwelle folgt dem Rhythmus', () => {
  // Ohne Plan die festen sieben Tage.
  assert.equal(warnschwelleTage(null), SYSTEMUPDATE_WARNUNG_TAGE);
  assert.equal(warnschwelleTage({ ...ZEITPLAN_VORGABE, aktiv: false }), 7);
  assert.equal(warnschwelleTage({ ...ZEITPLAN_VORGABE, aktiv: true, rhythmus: 'taeglich' }), 3);
  assert.equal(warnschwelleTage({ ...ZEITPLAN_VORGABE, aktiv: true }), 9, 'woechentlich');
  assert.equal(
    warnschwelleTage({ ...ZEITPLAN_VORGABE, aktiv: true, rhythmus: 'monatlich' }),
    33,
  );
  // Der Punkt der ganzen Uebung: Bei "monatlich" darf nach 20 Tagen keine
  // Warnung stehen — sonst leuchtete sie drei Wochen im Monat, obwohl alles
  // nach Plan laeuft, und niemand naehme sie mehr ernst.
  const monatlich = warnschwelleTage({ ...ZEITPLAN_VORGABE, aktiv: true, rhythmus: 'monatlich' });
  assert.equal(bewerteAlter(JETZT - 20 * TAG, JETZT, monatlich).stufe, 'frisch');
  assert.equal(bewerteAlter(JETZT - 20 * TAG, JETZT).stufe, 'ueberfaellig', 'ohne Plan schon');
  // Ausgefallener Lauf: anderer Text als beim schlichten Vergessen.
  assert.match(bewerteAlter(JETZT - 40 * TAG, JETZT, monatlich).text, /ausgefallen/);
  assert.match(bewerteAlter(JETZT - 40 * TAG, JETZT).text, /nachholen/);
});

test('Plan wird geprueft, nicht geglaubt', () => {
  const kaputt = pruefeZeitplan({
    aktiv: true, rhythmus: 'jaehrlich', wochentag: 99, monatstag: 0,
    stunde: 25, minute: -3,
  } as never);
  assert.equal(kaputt.rhythmus, 'woechentlich', 'unbekannter Rhythmus -> Vorgabe');
  assert.equal(kaputt.wochentag, ZEITPLAN_VORGABE.wochentag);
  assert.equal(kaputt.monatstag, ZEITPLAN_VORGABE.monatstag);
  assert.equal(kaputt.stunde, ZEITPLAN_VORGABE.stunde);
  assert.equal(kaputt.minute, ZEITPLAN_VORGABE.minute);
  assert.equal(pruefeZeitplan(undefined).aktiv, false);
  // Gueltige Randwerte muessen durchkommen.
  const rand = pruefeZeitplan({ aktiv: true, monatstag: 31, stunde: 23, minute: 59,
    wochentag: 7, rhythmus: 'monatlich' });
  assert.equal(rand.monatstag, 31);
  assert.equal(rand.stunde, 23);
  assert.equal(rand.minute, 59);
  assert.equal(rand.wochentag, 7);
});

test('Timer-Unit traegt Streuung, Nachholen und die richtige Ziel-Unit', () => {
  const text = baueTimer({ ...ZEITPLAN_VORGABE, aktiv: true });
  assert.match(text, /OnCalendar=Sat \*-\*-\* 03:00:00/);
  assert.match(text, /RandomizedDelaySec=1800/);
  assert.match(text, /Persistent=true/);
  // Der Timer startet die GEPLANTE Unit, nicht die manuelle: Nur dort darf ein
  // automatischer Neustart herauskommen.
  assert.match(text, /Unit=asksin-analyzer-systemupdate-geplant\.service/);
  assert.match(text, /WantedBy=timers\.target/);
});

test('die geplante Unit und der Timer meinen dieselbe Datei', () => {
  // Zwei Seiten, eine Annahme: Heisst die Unit im Timer anders als die Datei
  // in deploy/, laedt systemd nichts und meldet nichts — der Plan stuende in
  // der Oberflaeche und liefe nie.
  const unit = readFileSync(
    resolve(import.meta.dirname, '../../deploy/asksin-analyzer-systemupdate-geplant.service'),
    'utf8',
  );
  assert.match(unit, /--geplant/, 'die geplante Unit muss sich als solche melden');
  const text = baueTimer({ ...ZEITPLAN_VORGABE, aktiv: true });
  const genannt = /Unit=(\S+)/.exec(text)![1];
  assert.equal(genannt, 'asksin-analyzer-systemupdate-geplant.service');
});

test('Timer-Auskunft von systemd wird richtig gelesen', () => {
  // Woertlich das, was `systemctl list-timers --output=json` auf Analyzer 04
  // ausgegeben hat (systemd 257) — nicht nachgetippt, sondern kopiert.
  const echt = '[{"next":1788138585126294,"left":1788138585126294,"last":0,'
    + '"passed":0,"unit":"asksin-analyzer-systemupdate.timer",'
    + '"activates":"asksin-analyzer-systemupdate-geplant.service"}]';
  const b = leseTimerJson(echt);
  assert.equal(b.aktiv, true);
  // Mikrosekunden -> Millisekunden. Der Faktor ist die Stelle, an der man
  // sich um drei Nullen vertut und dann das Jahr 58000 anzeigt.
  assert.equal(b.naechster, 1788138585126);
  assert.equal(new Date(b.naechster!).getFullYear(), 2026);
  assert.equal(b.startet, 'asksin-analyzer-systemupdate-geplant.service');

  // Ohne --all listet systemd nur AKTIVE Timer. Leer heisst "aus", nicht
  // "kaputt" — und darf keine Behauptung ueber einen naechsten Lauf erzeugen.
  assert.deepEqual(leseTimerJson('[]'), { aktiv: false, naechster: null, startet: null });
  assert.equal(leseTimerJson('kein JSON').aktiv, false);
  assert.equal(leseTimerJson('').aktiv, false);
  // Aktiver Timer ohne bekannten Termin: aktiv ja, Termin nein.
  const ohne = leseTimerJson('[{"next":0,"unit":"x","activates":"y"}]');
  assert.equal(ohne.aktiv, true);
  assert.equal(ohne.naechster, null);
});

test('die Zweitmeinung liest NICHT das formatierte Feld von systemctl show', () => {
  // Der Fehler, der diese Pruefung ausgeloest hat: `systemctl show -p
  // NextElapseUSecRealtime` liefert trotz des Namens KEINE Mikrosekunden,
  // sondern "Mon 2026-08-31 03:09:45 CEST". Ein Muster, das dort nach Ziffern
  // sucht, findet nie welche — die Anzeige blieb still leer, obwohl der Timer
  // lief. Genau der Fall, fuer den die Zweitmeinung da ist.
  const daemon = readFileSync(
    resolve(import.meta.dirname, '../bin/analyzerd.ts'), 'utf8',
  );
  assert.ok(
    !daemon.includes('NextElapseUSecRealtime'),
    'die formatierte Auskunft ist als Zahlenquelle unbrauchbar',
  );
  assert.ok(daemon.includes('--output=json'), 'stattdessen die JSON-Ausgabe');
});

// ---- Benachrichtigung (M17.2) ---------------------------------------------

const FERTIG: SystemupdateStatus = {
  running: false, schritt: 'fertig', ok: true,
  startedAt: JETZT - 59_000, updatedAt: JETZT,
  pakete: 39, neustartNoetig: false, fehler: null,
};

test('Benachrichtigung: Erfolg nennt Standort, Anzahl und Dauer', () => {
  const e = baueUpdateEreignis(FERTIG, 'Keller Büro');
  assert.equal(e.schlecht, false);
  assert.match(e.summary, /Keller Büro/);
  assert.match(e.summary, /39 Pakete/);
  assert.match(e.description, /59 Sekunden/);
  assert.match(e.description, /nicht nötig/);
});

test('Benachrichtigung: null Pakete ist eine Aussage, keine Luecke', () => {
  // "Es wurden 0 Pakete aufgeruestet" laesst den Empfaenger raten, ob die
  // Meldung abgeschnitten ist. Der Satz muss sagen, was der Fall ist.
  const e = baueUpdateEreignis({ ...FERTIG, pakete: 0 }, 'Dachboden');
  assert.match(e.summary, /bereits aktuell/);
  assert.equal(e.schlecht, false);
  // Unbekannt ist wieder etwas anderes als null.
  assert.match(baueUpdateEreignis({ ...FERTIG, pakete: null }, 'X').summary, /nicht auslesen/);
});

test('Benachrichtigung: Neustart und Fehlschlag stehen deutlich drin', () => {
  const neu = baueUpdateEreignis({ ...FERTIG, neustartNoetig: true }, 'Gartenhaus');
  assert.match(neu.description, /Neustart/);
  assert.match(neu.description, /Kernel/);

  const kaputt = baueUpdateEreignis(
    { ...FERTIG, ok: false, fehler: 'apt-get update fehlgeschlagen (Code 100).' },
    'Gartenhaus',
  );
  assert.equal(kaputt.schlecht, true);
  assert.match(kaputt.name, /fehlgeschlagen/);
  // Die Meldung von apt woertlich — sie ist die eigentliche Auskunft.
  assert.match(kaputt.description, /Code 100/);
});

test('Benachrichtigung: lange Laeufe in Minuten', () => {
  const lang = baueUpdateEreignis(
    { ...FERTIG, startedAt: JETZT - 14 * 60_000 }, 'Keller Büro',
  );
  assert.match(lang.description, /14 Minuten/);
});

test('Ereignis geht im Grafana-Format an den Adapter', () => {
  // Der Adapter liest genau diese Struktur (adapter/lib/alarm.js). Weicht sie
  // ab, antwortet er mit "Keine Alarme in der Nutzlast" — und die Meldung
  // waere weg, ohne dass der Analyzer davon erfuehre.
  const e = baueUpdateEreignis(FERTIG, 'Keller Büro');
  const roh = baueEreignisMeldung('Keller Büro', e, new Date(JETZT)) as {
    status: string;
    alerts: Array<{ status: string; labels: Record<string, string>;
      annotations: Record<string, string>; startsAt: string }>;
  };
  assert.equal(roh.status, 'firing');
  assert.equal(roh.alerts.length, 1);
  assert.equal(roh.alerts[0]!.labels['alertname'], 'Systemaktualisierung durchgeführt');
  assert.equal(roh.alerts[0]!.labels['standort'], 'Keller Büro');
  assert.equal(roh.alerts[0]!.labels['bereich'], 'analyzer');
  assert.equal(roh.alerts[0]!.annotations['summary'], e.summary);
  assert.ok(roh.alerts[0]!.startsAt.endsWith('Z'));

  // Die Entwarnung raeumt den Zustand auf: Ohne sie zeigte der Adapter
  // dauerhaft einen aktiven Alarm, und wer daran eine Lampe haengt, haette
  // sie fuer immer an.
  const auf = baueEreignisMeldung('X', e, new Date(JETZT), 'resolved') as {
    status: string; alerts: Array<{ status: string; endsAt?: string }>;
  };
  assert.equal(auf.status, 'resolved');
  assert.equal(auf.alerts[0]!.status, 'resolved');
  assert.ok(auf.alerts[0]!.endsAt !== undefined, 'Grafana setzt endsAt beim Abklingen');
});

// ---- Client-Meldungen ueber den Master (M17.3) ----------------------------

test('Die Nachricht nennt den Zeitpunkt — sie kann verspaetet ankommen', () => {
  // Seit die Clients ueber den Master melden, kann zwischen Lauf und
  // Zustellung ein Tag liegen: Ist der Master weg, bleibt die Meldung liegen.
  // Ohne Datum laese sie sich dann so, als sei es eben erst passiert.
  const e = baueUpdateEreignis(FERTIG, 'Gartenhaus');
  assert.match(e.description, /Abgeschlossen am \d\d\.\d\d\.\d{4} um \d\d:\d\d Uhr/);
  const kaputt = baueUpdateEreignis({ ...FERTIG, ok: false, fehler: 'x' }, 'Gartenhaus');
  assert.match(kaputt.description, /Abgeschlossen am/, 'auch beim Fehlschlag');
});

test('Master und Client meinen dieselbe Abhak-Schnittstelle', () => {
  // Zwei Seiten, eine Annahme: Der Master haakt mit httpPost ab, und der
  // schickt KEINEN Rumpf. Läse der Client die Aktion aus dem Rumpf, käme sie
  // nie an — der Client bliebe still, der Master wiederholte die Meldung im
  // Minutentakt, und niemand meldete einen Fehler.
  const daemon = readFileSync(
    resolve(import.meta.dirname, '../bin/analyzerd.ts'), 'utf8',
  );
  const server = readFileSync(
    resolve(import.meta.dirname, '../src/api/server.ts'), 'utf8',
  );
  const verbund = readFileSync(
    resolve(import.meta.dirname, '../src/verbund/verbund.ts'), 'utf8',
  );

  assert.match(daemon, /aktion=gemeldet&startedAt=/, 'der Master ruft mit Abfragezeichenkette');
  assert.match(
    server,
    /url\.searchParams\.get\('aktion'\) === 'gemeldet'/,
    'der Client liest sie auch von dort',
  );
  // httpPost darf keinen Rumpf mitschicken — sonst waere die Annahme oben
  // zwar erfuellt, aber aus dem falschen Grund.
  const post = /export const httpPost[\s\S]*?\n\};/.exec(verbund)?.[0] ?? '';
  assert.ok(post !== '', 'httpPost gefunden');
  assert.ok(!post.includes('body:'), 'httpPost schickt bewusst keinen Rumpf');
});

test('Der Client haakt erst nach der Zustellung ab', () => {
  // Die Reihenfolge im Master ist der ganze Punkt: senden, pruefen, DANN
  // abhaken. Wer zuerst abhakt, verliert die Meldung, sobald die Zustellung
  // scheitert — und niemand erfuehre davon.
  const daemon = readFileSync(
    resolve(import.meta.dirname, '../bin/analyzerd.ts'), 'utf8',
  );
  const block = /async function holeClientMeldungen[\s\S]*?\n}/.exec(daemon)?.[0] ?? '';
  assert.ok(block !== '', 'holeClientMeldungen gefunden');
  const senden = block.indexOf('sendeEreignis');
  const abhaken = block.indexOf('aktion=gemeldet');
  assert.ok(senden !== -1 && abhaken !== -1);
  assert.ok(senden < abhaken, 'erst zustellen, dann abhaken');
  assert.match(block, /if \(!zugestellt\)/, 'ein Fehlschlag laesst die Meldung liegen');
});
