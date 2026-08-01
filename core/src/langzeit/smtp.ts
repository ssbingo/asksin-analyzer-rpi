/**
 * Ein sehr kleiner SMTP-Versender — nur für die Testmail (M14.2).
 *
 * Warum selbst und nicht über Grafana: Grafana kann Kontaktpunkte testen,
 * verlangt dafür aber seinen Admin-Zugang. Den kennt der Analyzer nicht — das
 * Passwort vergibt der Anwender beim ersten Anmelden, und es irgendwo
 * abzulegen wäre der falsche Weg.
 *
 * Selbst zu senden ist ohnehin der bessere Test: Wir prüfen damit **genau
 * das**, was eingegeben wurde — Server, Port, STARTTLS, Benutzer, Passwort,
 * Absender, Empfänger — und können die Antwort des Servers **wörtlich**
 * zurückgeben. „535 5.7.8 Authentication credentials invalid" sagt einem
 * Menschen mehr als ein rotes Kreuz.
 *
 * Keine Bibliothek: Der Core hat keine Laufzeit-Abhängigkeiten, und für einen
 * einzelnen Testversand reicht das Nötigste des Protokolls.
 *
 * ## Aufbau
 *
 * Der Ablauf (`smtpTestlauf`) kennt nur eine `Leitung` — senden, Antwort
 * lesen, auf TLS umschalten. Damit lässt er sich gegen eine erfundene
 * Gegenstelle prüfen, ohne dass je ein Netzwerkpaket fliegt. Die echte
 * Leitung (`netzLeitung`) steht darunter und tut nichts weiter als node:net
 * und node:tls zu bedienen.
 */

import { Buffer } from 'node:buffer';
import { connect as netzVerbinden } from 'node:net';
import type { Socket } from 'node:net';
import { connect as tlsVerbinden } from 'node:tls';

export interface SmtpAntwort {
  code: number;
  text: string;
}

export interface Leitung {
  sende(text: string): Promise<void>;
  antwort(): Promise<SmtpAntwort>;
  aufTls(rechnername: string): Promise<void>;
  schliesse(): void;
}

export interface TestmailAuftrag {
  host: string;
  port: number;
  benutzer: string;
  passwort: string;
  absender: string;
  empfaenger: string;
  standort: string;
}

/** Fehler mit der wörtlichen Serverantwort — die ist die eigentliche Auskunft. */
export class SmtpFehler extends Error {
  // Felder ausgeschrieben statt als Konstruktor-Parameter: Das Projekt
  // uebersetzt mit erasableSyntaxOnly, und Parameter-Eigenschaften erzeugen
  // Code, der sich nicht rein wegloeschen laesst.
  readonly schritt: string;
  readonly antwort: SmtpAntwort;

  constructor(schritt: string, antwort: SmtpAntwort) {
    super(`${schritt}: ${antwort.code} ${antwort.text}`);
    this.name = 'SmtpFehler';
    this.schritt = schritt;
    this.antwort = antwort;
  }
}

async function erwarte(
  l: Leitung,
  schritt: string,
  ...erlaubt: number[]
): Promise<SmtpAntwort> {
  const a = await l.antwort();
  if (!erlaubt.includes(a.code)) throw new SmtpFehler(schritt, a);
  return a;
}

/**
 * Baut die Testnachricht.
 *
 * Der Betreff geht als RFC-2047-Wort raus: Ein Umlaut im Klartext ist im
 * Kopf einer Mail nicht erlaubt und kommt je nach Server als Buchstabensalat
 * an — oder gar nicht.
 */
export function baueTestmail(a: TestmailAuftrag, jetzt: Date): string {
  const betreff = `AskSin-Analyzer (${a.standort}): Testmeldung`;
  const kodiert = `=?UTF-8?B?${Buffer.from(betreff, 'utf8').toString('base64')}?=`;
  const rumpf = [
    'Diese Nachricht bestaetigt, dass der Versand funktioniert.',
    '',
    `Standort : ${a.standort}`,
    `Server   : ${a.host}:${a.port}`,
    `Absender : ${a.absender}`,
    '',
    'Kommt sie an, erreichen dich auch die vier Alarme:',
    'Analyzer offline, Duty-Cycle ueber 80 Prozent, Geraet seit 24 Stunden',
    'stumm und Grundrauschen dauerhaft erhoeht.',
    '',
    '-- ',
    'AskSin-Analyzer',
  ].join('\r\n');

  return [
    `From: AskSin-Analyzer <${a.absender}>`,
    `To: ${a.empfaenger}`,
    `Subject: ${kodiert}`,
    `Date: ${jetzt.toUTCString()}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    rumpf,
  ].join('\r\n');
}

/** Punkt am Zeilenanfang verdoppeln — sonst endet die Nachricht dort. */
export function punktSchutz(text: string): string {
  return text.replace(/^\./gm, '..');
}

/**
 * Führt den Testversand über eine bereits geöffnete Leitung durch.
 *
 * Reihenfolge: Begrüssung, EHLO, STARTTLS, erneut EHLO (die Fähigkeiten
 * gelten nach dem Umschalten neu), Anmeldung, Umschlag, Inhalt, QUIT.
 */
export async function smtpTestlauf(
  l: Leitung,
  a: TestmailAuftrag,
  jetzt: Date = new Date(),
): Promise<void> {
  await erwarte(l, 'Verbindung', 220);

  await l.sende('EHLO asksin-analyzer\r\n');
  let faehigkeiten = (await erwarte(l, 'EHLO', 250)).text;

  // STARTTLS ist Pflicht, sobald der Server es kann: Zugangsdaten im Klartext
  // ueber das Netz zu schicken, waere unentschuldbar.
  if (/STARTTLS/i.test(faehigkeiten)) {
    await l.sende('STARTTLS\r\n');
    await erwarte(l, 'STARTTLS', 220);
    await l.aufTls(a.host);
    await l.sende('EHLO asksin-analyzer\r\n');
    faehigkeiten = (await erwarte(l, 'EHLO nach STARTTLS', 250)).text;
  } else if (a.passwort !== '') {
    throw new SmtpFehler('STARTTLS', {
      code: 0,
      text:
        'Der Server bietet keine Verschlüsselung an. Zugangsdaten würden im ' +
        'Klartext übertragen — abgebrochen. Port 587 statt 25 versuchen.',
    });
  }

  if (a.benutzer !== '') {
    // PLAIN wenn angeboten, sonst LOGIN. Beides ist verbreitet; PLAIN
    // braucht einen Umlauf weniger.
    if (/AUTH[^\r\n]*PLAIN/i.test(faehigkeiten)) {
      const wort = Buffer.from(`\0${a.benutzer}\0${a.passwort}`, 'utf8').toString('base64');
      await l.sende(`AUTH PLAIN ${wort}\r\n`);
    } else {
      await l.sende('AUTH LOGIN\r\n');
      await erwarte(l, 'Anmeldung', 334);
      await l.sende(`${Buffer.from(a.benutzer, 'utf8').toString('base64')}\r\n`);
      await erwarte(l, 'Benutzername', 334);
      await l.sende(`${Buffer.from(a.passwort, 'utf8').toString('base64')}\r\n`);
    }
    await erwarte(l, 'Anmeldung', 235);
  }

  await l.sende(`MAIL FROM:<${a.absender}>\r\n`);
  await erwarte(l, 'Absender', 250);

  // Mehrere Empfaenger sind mit Semikolon getrennt — so schreibt es Grafana.
  for (const e of a.empfaenger.split(';').map((x) => x.trim()).filter((x) => x !== '')) {
    await l.sende(`RCPT TO:<${e}>\r\n`);
    await erwarte(l, `Empfänger ${e}`, 250, 251);
  }

  await l.sende('DATA\r\n');
  await erwarte(l, 'DATA', 354);
  await l.sende(`${punktSchutz(baueTestmail(a, jetzt))}\r\n.\r\n`);
  await erwarte(l, 'Zustellung', 250);

  await l.sende('QUIT\r\n');
  l.schliesse();
}

/** Die echte Leitung über node:net und node:tls. */
export function netzLeitung(
  host: string,
  port: number,
  zeitlimitMs = 20_000,
): Promise<Leitung> {
  return new Promise((erfuellen, ablehnen) => {
    let sock: Socket = netzVerbinden({ host, port });
    let puffer = '';
    let warte: ((a: SmtpAntwort) => void) | null = null;
    let fehler: ((e: Error) => void) | null = null;

    const verteile = (): void => {
      // Mehrzeilige Antworten enden erst bei "250 text", nicht bei "250-text".
      // Wer das uebersieht, liest die naechste Antwort aus der Mitte der
      // vorherigen — und wundert sich ueber sinnlose Fehlermeldungen.
      const zeilen = puffer.split('\r\n');
      for (let i = 0; i < zeilen.length; i++) {
        const z = zeilen[i]!;
        if (/^\d{3} /.test(z)) {
          const ganz = zeilen.slice(0, i + 1).join('\n');
          puffer = zeilen.slice(i + 1).join('\r\n');
          const w = warte;
          warte = null;
          w?.({ code: Number(z.slice(0, 3)), text: ganz });
          return;
        }
      }
    };

    const anhaengen = (s: Socket): void => {
      s.setTimeout(zeitlimitMs);
      s.on('data', (d: Buffer) => {
        puffer += d.toString('utf8');
        verteile();
      });
      s.on('timeout', () => {
        s.destroy();
        fehler?.(new Error(`Zeitüberschreitung nach ${zeitlimitMs / 1000} s`));
      });
      s.on('error', (e: Error) => fehler?.(e));
    };
    anhaengen(sock);

    const leitung: Leitung = {
      sende: (text) =>
        new Promise((fertig, schief) => {
          fehler = schief;
          sock.write(text, (e) => (e ? schief(e) : fertig()));
        }),
      antwort: () =>
        new Promise((fertig, schief) => {
          warte = fertig;
          fehler = schief;
          verteile();
        }),
      aufTls: (rechnername) =>
        new Promise((fertig, schief) => {
          fehler = schief;
          const tls = tlsVerbinden({ socket: sock, servername: rechnername }, () => {
            sock = tls;
            puffer = '';
            anhaengen(tls);
            fertig();
          });
          tls.on('error', schief);
        }),
      schliesse: () => sock.destroy(),
    };

    sock.once('connect', () => erfuellen(leitung));
    sock.once('error', (e) => ablehnen(e));
  });
}

/**
 * Übersetzt eine abgelehnte Zustellung in einen Satz, mit dem man etwas
 * anfangen kann.
 *
 * Die wörtliche Serverantwort bleibt dabei erhalten — sie ist der Beweis.
 * Aber „550 Sender address is not allowed" sagt nur, DASS etwas nicht ging;
 * die Handlung daraus abzuleiten ist Arbeit, die man dem Anwender abnehmen
 * kann. Genau daran scheitert Einrichtung sonst: Die Auskunft ist da, aber
 * sie ist nicht die Antwort auf die Frage „was muss ich jetzt tun?".
 */
export function deuteSmtpFehler(e: unknown): string {
  if (!(e instanceof SmtpFehler)) {
    const text = e instanceof Error ? e.message : String(e);
    if (/ECONNREFUSED/.test(text)) {
      return (
        'Der Server nimmt auf diesem Port keine Verbindung an. Stimmen ' +
        'Adresse und Port? Üblich sind 587 (StartTLS) oder 465.\n\n' + text
      );
    }
    if (/ENOTFOUND|EAI_AGAIN/.test(text)) {
      return `Der Servername ist nicht auflösbar — Tippfehler?\n\n${text}`;
    }
    if (/Zeitüberschreitung|ETIMEDOUT/.test(text)) {
      return (
        'Keine Antwort vom Server. Blockiert eine Firewall den Port, oder ' +
        'ist der Port falsch?\n\n' + text
      );
    }
    return text;
  }

  const roh = e.antwort.text;
  const code = e.antwort.code;
  const anhang = `\n\nAntwort des Servers:\n${roh}`;

  if (code === 535 || code === 534 || code === 530) {
    return (
      'Benutzername oder Passwort werden nicht angenommen. Viele Anbieter ' +
      'verlangen ein eigenes E-Mail-Passwort statt des Kundenkennworts — bei ' +
      'T-Online wird es im Kundencenter vergeben, bei Google und anderen ist ' +
      'es ein App-Passwort.' + anhang
    );
  }
  if (e.schritt === 'Absender' && /sender|absender|not allowed|not permitted/i.test(roh)) {
    return (
      'Der Server erlaubt diese Absenderadresse nicht. Fast immer muss sie ' +
      'mit der Adresse übereinstimmen, mit der die Anmeldung erfolgt — trage ' +
      'bei „Absender" dasselbe ein wie bei „Benutzer".' + anhang
    );
  }
  if (e.schritt.startsWith('Empfänger') && /relay/i.test(roh)) {
    return (
      'Der Server möchte an diesen Empfänger nicht ausliefern. Das passiert, ' +
      'wenn die Anmeldung nicht gegriffen hat oder der Anbieter nur an ' +
      'eigene Adressen zustellt.' + anhang
    );
  }
  if (code === 550 || code === 553 || code === 554) {
    return `Der Server hat die Nachricht abgelehnt (${e.schritt}).${anhang}`;
  }
  return `Abgebrochen bei: ${e.schritt}.${anhang}`;
}
