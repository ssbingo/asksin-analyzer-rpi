import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ALARMKANAELE,
  ALARMZIEL_VORGABEN,
  baueAlarmProvisionierung,
  baueSmtpUmgebung,
  pruefeAlarmziel,
} from '../src/langzeit/alarmziel.ts';
import type { Alarmziel } from '../src/langzeit/alarmziel.ts';

/** Erlaubt auch halb ausgefüllte Unterobjekte — genau darum geht es hier. */
type TeilZiel = Partial<Omit<Alarmziel, 'email' | 'telegram' | 'iobroker'>> & {
  email?: Partial<Alarmziel['email']>;
  telegram?: Partial<Alarmziel['telegram']>;
  iobroker?: Partial<Alarmziel['iobroker']>;
};

const ziel = (teil: TeilZiel): Alarmziel => ({
  ...ALARMZIEL_VORGABEN,
  ...teil,
  email: { ...ALARMZIEL_VORGABEN.email, ...(teil.email ?? {}) },
  telegram: { ...ALARMZIEL_VORGABEN.telegram, ...(teil.telegram ?? {}) },
  iobroker: { ...ALARMZIEL_VORGABEN.iobroker, ...(teil.iobroker ?? {}) },
});

test('Alarmziel: ioBroker steht an erster Stelle', () => {
  // Reihenfolge ist hier eine Aussage, keine Zufaelligkeit: Wer ioBroker
  // betreibt, richtet Messaging einmal DORT ein statt ein zweites Mal in
  // Grafana.
  assert.deepEqual(ALARMKANAELE, ['iobroker', 'email', 'telegram']);
  assert.equal(ALARMZIEL_VORGABEN.kanal, 'iobroker');
});

test('Alarmziel: ausgeschaltet muss nichts ausgefüllt sein', () => {
  // Sonst liesse sich ein halb ausgefuelltes Ziel nie abschalten, ohne es
  // vorher zu vervollstaendigen — eine Sackgasse in der Bedienung.
  assert.doesNotThrow(() => pruefeAlarmziel(ziel({ aktiv: false })));
});

test('Alarmziel: ioBroker verlangt eine vollständige Adresse', () => {
  assert.throws(
    () => pruefeAlarmziel(ziel({ aktiv: true, iobroker: { url: 'iobroker:8087' } })),
    /vollständige URL/,
  );
  assert.doesNotThrow(() =>
    pruefeAlarmziel(
      ziel({ aktiv: true, iobroker: { url: 'http://192.168.1.20:8087/asksin/alarm' } }),
    ),
  );
});

test('Alarmziel: die E-Mail-Meldungen sagen, was einzutragen ist', () => {
  const basis = { aktiv: true, kanal: 'email' as const };
  assert.throws(() => pruefeAlarmziel(ziel({ ...basis })), /E-Mail-Adresse/);
  assert.throws(
    () => pruefeAlarmziel(ziel({ ...basis, email: { empfaenger: 'a@b.de' } })),
    /SMTP-Server fehlt/,
  );
  assert.throws(
    () =>
      pruefeAlarmziel(
        ziel({
          ...basis,
          email: { empfaenger: 'a@b.de', smtpHost: 'mail.de', smtpPort: 0 },
        }),
      ),
    /1 und 65535/,
  );
  assert.doesNotThrow(() =>
    pruefeAlarmziel(
      ziel({
        ...basis,
        email: {
          empfaenger: 'a@b.de',
          smtpHost: 'securesmtp.t-online.de',
          smtpPort: 587,
          benutzer: 'a@b.de',
          passwort: 'geheim',
          absender: 'a@b.de',
        },
      }),
    ),
  );
});

test('Alarmziel: der Bot-NAME statt des Tokens wird abgefangen', () => {
  // Der mit Abstand haeufigste Fehler bei Telegram.
  const basis = { aktiv: true, kanal: 'telegram' as const };
  assert.throws(
    () => pruefeAlarmziel(ziel({ ...basis, telegram: { botToken: 'MeinBot', chatId: '1' } })),
    /nicht der Name des Bots/,
  );
  assert.throws(
    () =>
      pruefeAlarmziel(
        ziel({
          ...basis,
          telegram: { botToken: '123456789:AAEhBOweik6ad9r_ABCDEFGHIJKL', chatId: 'Familie' },
        }),
      ),
    /Chat-Kennung/,
  );
  assert.doesNotThrow(() =>
    pruefeAlarmziel(
      ziel({
        ...basis,
        telegram: { botToken: '123456789:AAEhBOweik6ad9r_ABCDEFGHIJKL', chatId: '-1001234' },
      }),
    ),
  );
});

test('Provisionierung: gültiges JSON — und damit gültiges YAML', () => {
  // Der Core hat keine Laufzeit-Abhaengigkeiten; ein handgeschriebener
  // YAML-Erzeuger waere die Fehlerquelle. YAML ist eine Obermenge von JSON,
  // also erzeugen wir JSON und nennen die Datei .yaml.
  const text = baueAlarmProvisionierung(
    ziel({ aktiv: true, iobroker: { url: 'http://io:8087/a' } }),
  );
  const d = JSON.parse(text) as {
    contactPoints: Array<{ name: string; receivers: Array<{ type: string; settings: Record<string, unknown> }> }>;
    policies: Array<{ receiver: string; group_by: string[] }>;
  };
  assert.equal(d.contactPoints[0]!.receivers[0]!.type, 'webhook', 'ioBroker geht als Webhook raus');
  assert.equal(d.contactPoints[0]!.receivers[0]!.settings['url'], 'http://io:8087/a');
  // Kontaktpunkt UND Richtlinie: Das eine ohne das andere tut nichts, und
  // genau daran scheitert die Einrichtung von Hand am haeufigsten.
  assert.equal(d.policies[0]!.receiver, d.contactPoints[0]!.name);
  assert.deepEqual(d.policies[0]!.group_by, ['alertname', 'standort']);
});

test('Provisionierung: Sonderzeichen im Passwortfeld zerlegen nichts', () => {
  // Ein Doppelpunkt oder Anfuehrungszeichen haette handgeschriebenes YAML
  // zerrissen — hier faellt das JSON.stringify zu.
  const text = baueAlarmProvisionierung(
    ziel({
      aktiv: true,
      kanal: 'telegram',
      telegram: { botToken: '1:AA"quote:doppelpunkt\\backslash_XXXXXXXXXXXXXXXXXXX', chatId: '-1' },
    }),
  );
  const d = JSON.parse(text) as {
    contactPoints: Array<{ receivers: Array<{ settings: Record<string, string> }> }>;
  };
  assert.match(d.contactPoints[0]!.receivers[0]!.settings['bottoken']!, /"quote:doppelpunkt/);
});

test('SMTP-Umgebung: nur bei E-Mail eingeschaltet, Passwort in Anführungszeichen', () => {
  const aus = baueSmtpUmgebung(ziel({ aktiv: true, kanal: 'iobroker' }));
  assert.match(aus, /GF_SMTP_ENABLED=false/);

  const an = baueSmtpUmgebung(
    ziel({
      aktiv: true,
      kanal: 'email',
      email: {
        empfaenger: 'a@b.de',
        smtpHost: 'securesmtp.t-online.de',
        smtpPort: 587,
        benutzer: 'a@b.de',
        passwort: 'mit Leerzeichen',
        absender: 'a@b.de',
      },
    }),
  );
  assert.match(an, /GF_SMTP_HOST=securesmtp\.t-online\.de:587/);
  // systemd trennt Environment-Zeilen an Leerzeichen — ohne Anfuehrungszeichen
  // waere von "mit Leerzeichen" nur "mit" angekommen.
  assert.match(an, /Environment="GF_SMTP_PASSWORD=mit Leerzeichen"/);
});

test('ioBroker: das Passwort geht als Kopfzeile mit, nicht in der Adresse', () => {
  // Adressen landen in Protokollen — bei Grafana, im Netz, beim Empfaenger.
  // Kopfzeilen nicht.
  const text = baueAlarmProvisionierung(
    ziel({
      aktiv: true,
      kanal: 'iobroker',
      iobroker: { url: 'http://io:8095/asksin/alarm', token: 'geheim123' },
    }),
  );
  const s = JSON.parse(text) as {
    contactPoints: Array<{ receivers: Array<{ settings: Record<string, string> }> }>;
  };
  const e = s.contactPoints[0]!.receivers[0]!.settings;
  assert.equal(e['url'], 'http://io:8095/asksin/alarm', 'keine Anhaengsel in der Adresse');
  assert.equal(e['authorization_scheme'], 'Bearer');
  assert.equal(e['authorization_credentials'], 'geheim123');
});

test('ioBroker: ohne Passwort bleibt die Kopfzeile ganz weg', () => {
  // Eine leere Kopfzeile wuerde der Adapter abweisen, obwohl er gar keins
  // verlangt.
  const text = baueAlarmProvisionierung(
    ziel({ aktiv: true, kanal: 'iobroker', iobroker: { url: 'http://io:8095/a' } }),
  );
  const s = JSON.parse(text) as {
    contactPoints: Array<{ receivers: Array<{ settings: Record<string, string> }> }>;
  };
  const e = s.contactPoints[0]!.receivers[0]!.settings;
  assert.equal(e['authorization_scheme'], undefined);
  assert.equal(e['authorization_credentials'], undefined);
});
