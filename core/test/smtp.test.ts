import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';

import {
  SmtpFehler,
  baueTestmail,
  punktSchutz,
  smtpTestlauf,
} from '../src/langzeit/smtp.ts';
import type { Leitung, SmtpAntwort, TestmailAuftrag } from '../src/langzeit/smtp.ts';

const AUFTRAG: TestmailAuftrag = {
  host: 'securesmtp.t-online.de',
  port: 587,
  benutzer: 'ich@online.de',
  passwort: 'geheim',
  absender: 'ich@online.de',
  empfaenger: 'ich@online.de',
  standort: 'Büro Keller',
};

/** Erfundene Gegenstelle: spielt ein Drehbuch ab und merkt sich, was kam. */
function fakeLeitung(drehbuch: SmtpAntwort[]): Leitung & {
  gesendet: string[];
  tlsUmschaltungen: number;
} {
  const gesendet: string[] = [];
  let i = 0;
  return {
    gesendet,
    tlsUmschaltungen: 0,
    sende(text) {
      gesendet.push(text);
      return Promise.resolve();
    },
    antwort() {
      const a = drehbuch[i++];
      if (a === undefined) throw new Error(`Drehbuch zu Ende bei Antwort ${i}`);
      return Promise.resolve(a);
    },
    aufTls(this: { tlsUmschaltungen: number }) {
      this.tlsUmschaltungen++;
      return Promise.resolve();
    },
    schliesse() {
      /* nichts */
    },
  };
}

const OK = (code: number, text = 'OK'): SmtpAntwort => ({ code, text });
const EHLO_MIT_TLS = OK(250, '250-mail\n250-STARTTLS\n250-AUTH PLAIN LOGIN\n250 OK');

test('SMTP: vollständiger Ablauf mit STARTTLS und AUTH PLAIN', async () => {
  const l = fakeLeitung([
    OK(220, 'bereit'),
    EHLO_MIT_TLS,
    OK(220, 'los'),
    EHLO_MIT_TLS,
    OK(235, 'angemeldet'),
    OK(250, 'Absender ok'),
    OK(250, 'Empfänger ok'),
    OK(354, 'Text senden'),
    OK(250, 'angenommen'),
  ]);
  await smtpTestlauf(l, AUFTRAG, new Date(0));

  const befehle = l.gesendet.map((z) => z.split(/[ \r]/)[0]);
  assert.deepEqual(befehle, [
    'EHLO', 'STARTTLS', 'EHLO', 'AUTH', 'MAIL', 'RCPT', 'DATA', 'From:', 'QUIT',
  ]);
  assert.equal(l.tlsUmschaltungen, 1, 'genau einmal auf TLS umgeschaltet');

  // Nach dem Umschalten MUSS erneut EHLO kommen: Die Faehigkeiten gelten
  // danach neu, und viele Server bieten AUTH erst dann an.
  assert.ok(l.gesendet.indexOf('EHLO asksin-analyzer\r\n') <
            l.gesendet.lastIndexOf('EHLO asksin-analyzer\r\n'));

  const auth = l.gesendet.find((z) => z.startsWith('AUTH PLAIN'))!;
  const wort = Buffer.from(auth.split(' ')[2]!.trim(), 'base64').toString('utf8');
  assert.equal(wort, '\0ich@online.de\0geheim');
});

test('SMTP: ohne PLAIN wird LOGIN verwendet', async () => {
  const nurLogin = OK(250, '250-STARTTLS\n250-AUTH LOGIN\n250 OK');
  const l = fakeLeitung([
    OK(220), nurLogin, OK(220), nurLogin,
    OK(334, 'Benutzer?'), OK(334, 'Passwort?'), OK(235),
    OK(250), OK(250), OK(354), OK(250),
  ]);
  await smtpTestlauf(l, AUFTRAG, new Date(0));
  assert.ok(l.gesendet.includes('AUTH LOGIN\r\n'));
  const [benutzer, passwort] = l.gesendet.slice(
    l.gesendet.indexOf('AUTH LOGIN\r\n') + 1,
  );
  assert.equal(Buffer.from(benutzer!.trim(), 'base64').toString('utf8'), 'ich@online.de');
  assert.equal(Buffer.from(passwort!.trim(), 'base64').toString('utf8'), 'geheim');
});

test('SMTP: die Serverantwort kommt wörtlich zurück', async () => {
  // Das ist der ganze Sinn des Testknopfes: "535 5.7.8 Authentication
  // credentials invalid" sagt einem Menschen, was zu tun ist. Ein rotes
  // Kreuz sagt gar nichts.
  const l = fakeLeitung([
    OK(220), EHLO_MIT_TLS, OK(220), EHLO_MIT_TLS,
    OK(535, '535 5.7.8 Authentication credentials invalid'),
  ]);
  await assert.rejects(() => smtpTestlauf(l, AUFTRAG, new Date(0)), (e: unknown) => {
    assert.ok(e instanceof SmtpFehler);
    assert.equal(e.schritt, 'Anmeldung');
    assert.match(e.message, /credentials invalid/);
    return true;
  });
});

test('SMTP: ohne Verschlüsselung wird nicht angemeldet', async () => {
  // Zugangsdaten im Klartext ueber das Netz waeren unentschuldbar — lieber
  // abbrechen und sagen, was zu tun ist.
  const ohneTls = OK(250, '250-mail\n250 AUTH LOGIN');
  const l = fakeLeitung([OK(220), ohneTls]);
  await assert.rejects(() => smtpTestlauf(l, AUFTRAG, new Date(0)), /Klartext/);
  assert.ok(!l.gesendet.some((z) => z.startsWith('AUTH')), 'kein Anmeldeversuch');
});

test('SMTP: mehrere Empfänger bekommen je ein RCPT', async () => {
  const l = fakeLeitung([
    OK(220), EHLO_MIT_TLS, OK(220), EHLO_MIT_TLS, OK(235),
    OK(250), OK(250), OK(251), OK(354), OK(250),
  ]);
  await smtpTestlauf(l, { ...AUFTRAG, empfaenger: 'a@b.de; c@d.de' }, new Date(0));
  const rcpt = l.gesendet.filter((z) => z.startsWith('RCPT'));
  assert.deepEqual(rcpt, ['RCPT TO:<a@b.de>\r\n', 'RCPT TO:<c@d.de>\r\n']);
});

test('Testmail: Umlaute im Betreff werden kodiert', () => {
  // Ein Umlaut im Klartext ist im Kopf einer Mail nicht erlaubt und kommt je
  // nach Server als Buchstabensalat an — oder gar nicht.
  const text = baueTestmail(AUFTRAG, new Date(0));
  const betreff = text.split('\r\n').find((z) => z.startsWith('Subject:'))!;
  assert.match(betreff, /^Subject: =\?UTF-8\?B\?/);
  const roh = Buffer.from(betreff.replace(/^Subject: =\?UTF-8\?B\?|\?=$/g, ''), 'base64');
  assert.match(roh.toString('utf8'), /Büro Keller/);
  // Der Rumpf bleibt lesbar und nennt, worum es geht.
  assert.match(text, /vier Alarme/);
});

test('Testmail: ein Punkt am Zeilenanfang beendet die Nachricht nicht', () => {
  assert.equal(punktSchutz('.geheim\nnormal\n.'), '..geheim\nnormal\n..');
});
