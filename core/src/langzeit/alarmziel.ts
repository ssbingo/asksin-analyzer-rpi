/**
 * Wohin Grafana seine Alarme meldet (M14.2).
 *
 * Grafana kann das selbst — nur muss man es dort an drei Stellen eintragen
 * (Kontaktpunkt, Benachrichtigungsrichtlinie, SMTP-Zugang in einer
 * Konfigurationsdatei), und die dritte geht nur über die Konsole. Genau das
 * soll dem Anwender erspart bleiben: Hier wird einmal ausgewählt, und der
 * Rest entsteht daraus.
 *
 * Drei Wege stehen zur Wahl:
 *
 *   **ioBroker** (Vorgabe) — Grafana ruft den Adapter über einen Webhook auf,
 *     der die Meldung dann über die im ioBroker ohnehin vorhandenen
 *     Messaging-Adapter verteilt. Das ist der beste Weg für ein Haus, in dem
 *     ioBroker läuft: Man richtet Telegram, Signal, Pushover oder E-Mail
 *     **einmal dort** ein und nicht ein zweites Mal in Grafana.
 *   **E-Mail** — direkt aus Grafana. Braucht einen SMTP-Zugang.
 *   **Telegram** — direkt aus Grafana, mit Bot-Token und Chat-Kennung.
 *
 * ## Warum das Ergebnis JSON ist, obwohl die Datei .yaml heisst
 *
 * Grafana liest die Provisionierung als YAML. YAML ist eine Obermenge von
 * JSON — eine Datei mit gültigem JSON ist also gültiges YAML. Das ist hier
 * kein Trick, sondern Absicht: Der Core hat **keine Laufzeit-Abhängigkeiten**,
 * ein YAML-Erzeuger müsste also von Hand geschrieben werden. Und wer schon
 * einmal Anführungszeichen, Doppelpunkte oder ein führendes @ in einem
 * handgeschriebenen YAML-Erzeuger vergessen hat, weiß, wie still so etwas
 * schiefgeht. JSON.stringify kann das seit jeher richtig.
 */

export type Alarmkanal = 'iobroker' | 'email' | 'telegram';

/** Reihenfolge in der Oberfläche — ioBroker zuerst, weil er im Haus liegt. */
export const ALARMKANAELE: Alarmkanal[] = ['iobroker', 'email', 'telegram'];

export interface Alarmziel {
  aktiv: boolean;
  kanal: Alarmkanal;
  iobroker: {
    /** Webhook des ioBroker-Adapters, z. B. http://iobroker:8095/asksin/alarm */
    url: string;
    /**
     * Dasselbe Verbindungspasswort, das im Adapter steht.
     *
     * Es geht als `Authorization: Bearer …` mit, nicht als `?token=` in der
     * Adresse: Adressen landen in Protokollen, Kopfzeilen nicht.
     */
    token: string;
  };
  email: {
    /** Ein oder mehrere Empfänger, durch Semikolon getrennt. */
    empfaenger: string;
    smtpHost: string;
    smtpPort: number;
    benutzer: string;
    passwort: string;
    absender: string;
  };
  telegram: {
    botToken: string;
    chatId: string;
  };
}

export const ALARMZIEL_VORGABEN: Alarmziel = {
  aktiv: false,
  kanal: 'iobroker',
  iobroker: { url: '', token: '' },
  email: {
    empfaenger: '',
    smtpHost: '',
    // 587 mit STARTTLS statt 465: Grafana geht damit zuverlaessiger um, und
    // praktisch jeder Anbieter unterstuetzt es.
    smtpPort: 587,
    benutzer: '',
    passwort: '',
    absender: '',
  },
  telegram: { botToken: '', chatId: '' },
};

export function istAlarmkanal(wert: unknown): wert is Alarmkanal {
  return ALARMKANAELE.includes(wert as Alarmkanal);
}

/**
 * Prüft ein Ziel, bevor es gespeichert wird.
 *
 * Die Meldungen sagen, **was** einzutragen ist — nicht nur, dass etwas fehlt.
 * Ein „ungültige Konfiguration" hilft am Datenschrank niemandem.
 */
export function pruefeAlarmziel(z: Alarmziel): void {
  // Tokens werden kopiert, und beim Kopieren haengt regelmaessig ein
  // Zeilenumbruch dran. Ein Token mit unsichtbarem Anhaengsel sieht aus wie
  // ein falscher Token — deshalb hier weg damit, bevor irgendetwas prueft.
  z.iobroker.token = z.iobroker.token.trim();
  z.telegram.botToken = z.telegram.botToken.trim();
  z.telegram.chatId = z.telegram.chatId.trim();

  if (!istAlarmkanal(z.kanal)) {
    throw new Error("kanal: 'iobroker', 'email' oder 'telegram' erwartet");
  }
  // Ausgeschaltet muss nichts stimmen — sonst könnte man ein halb
  // ausgefülltes Ziel nie abschalten, ohne es vorher zu vervollständigen.
  if (!z.aktiv) return;

  if (z.kanal === 'iobroker') {
    if (!/^https?:\/\/\S+$/.test(z.iobroker.url)) {
      throw new Error(
        'ioBroker-Adresse: vollständige URL erwartet, z. B. ' +
          'http://192.168.1.20:8095/asksin/alarm',
      );
    }
    return;
  }

  if (z.kanal === 'email') {
    if (!z.email.empfaenger.includes('@')) {
      throw new Error('Empfänger: E-Mail-Adresse erwartet');
    }
    if (z.email.smtpHost.trim() === '') {
      throw new Error(
        'SMTP-Server fehlt — z. B. securesmtp.t-online.de oder smtp.gmail.com',
      );
    }
    if (!Number.isInteger(z.email.smtpPort) || z.email.smtpPort < 1 ||
        z.email.smtpPort > 65535) {
      throw new Error('SMTP-Port: Zahl zwischen 1 und 65535 erwartet (üblich: 587)');
    }
    if (!z.email.absender.includes('@')) {
      throw new Error('Absender: E-Mail-Adresse erwartet — meist dieselbe wie der Benutzer');
    }
    return;
  }

  // Telegram. Ein Bot-Token sieht immer aus wie 123456789:AA... — die Prüfung
  // faengt den haeufigsten Fehler ab, naemlich den Bot-NAMEN einzutragen.
  if (!/^\d+:[\w-]{20,}$/.test(z.telegram.botToken)) {
    throw new Error(
      'Bot-Token: erwartet wird die Form 123456789:AA… vom BotFather — ' +
        'nicht der Name des Bots',
    );
  }
  if (!/^-?\d+$/.test(z.telegram.chatId)) {
    throw new Error(
      'Chat-Kennung: Zahl erwartet (bei Gruppen mit Minuszeichen davor)',
    );
  }
}

/** Der eine Kontaktpunkt, den Grafana bekommt. */
const EMPFAENGER_NAME = 'AskSin-Alarmziel';

/**
 * Baut die Provisionierung für Grafana: Kontaktpunkt **und** Richtlinie.
 *
 * Beides zusammen, weil das eine ohne das andere nichts tut — genau daran
 * scheitert die Einrichtung von Hand am häufigsten: Der Kontaktpunkt steht
 * da und ist „Unused", während die Standardrichtlinie weiter ins Leere zeigt.
 */
export function baueAlarmProvisionierung(z: Alarmziel): string {
  const empfaenger = {
    uid: 'asksin-alarmziel',
    type: kanalTyp(z.kanal),
    settings: kanalEinstellungen(z),
    disableResolveMessage: false,
  };

  return (
    JSON.stringify(
      {
        apiVersion: 1,
        contactPoints: [
          { orgId: 1, name: EMPFAENGER_NAME, receivers: [empfaenger] },
        ],
        policies: [
          {
            orgId: 1,
            receiver: EMPFAENGER_NAME,
            // Nach Standort gruppieren: Faellt ein Analyzer aus, ist das EINE
            // Meldung — nicht eine je Regel, die dort gerade anschlaegt.
            group_by: ['alertname', 'standort'],
            group_wait: '30s',
            group_interval: '5m',
            // Zwoelf Stunden statt vier: Bei einer leeren Batterie waere
            // haeufiger nur laestig, und niemand handelt deswegen schneller.
            repeat_interval: '12h',
          },
        ],
      },
      null,
      2,
    ) + '\n'
  );
}

function kanalTyp(kanal: Alarmkanal): string {
  // ioBroker bekommt einen gewoehnlichen Webhook — der Adapter verteilt dann
  // im Haus weiter. Grafana kennt "iobroker" nicht und muss es auch nicht.
  return kanal === 'iobroker' ? 'webhook' : kanal;
}

function kanalEinstellungen(z: Alarmziel): Record<string, unknown> {
  switch (z.kanal) {
    case 'iobroker':
      return {
        url: z.iobroker.url,
        httpMethod: 'POST',
        // Nur setzen, wenn eines hinterlegt ist — sonst schickt Grafana eine
        // leere Kopfzeile, und der Adapter weist sie ab, obwohl gar kein
        // Passwort verlangt wird.
        ...(z.iobroker.token === ''
          ? {}
          : {
              authorization_scheme: 'Bearer',
              authorization_credentials: z.iobroker.token,
            }),
      };
    case 'email':
      // Grafana trennt mehrere Empfaenger mit Semikolon.
      return { addresses: z.email.empfaenger };
    case 'telegram':
      return { bottoken: z.telegram.botToken, chatid: z.telegram.chatId };
  }
}

/**
 * SMTP-Zugang als systemd-Umgebung statt als Eingriff in die grafana.ini.
 *
 * Grafana liest jede Einstellung auch aus `GF_<ABSCHNITT>_<SCHLUESSEL>`. Eine
 * Ergänzungsdatei zur Unit ist damit gleichwertig — und deutlich sauberer:
 * Die mitgelieferte `grafana.ini` bleibt unangetastet, ein Paket-Update kann
 * sie ersetzen, ohne dass etwas verlorengeht, und das Passwort liegt in einer
 * Datei, die nur root lesen darf statt mitten in der Hauptkonfiguration.
 */
export function baueSmtpUmgebung(z: Alarmziel): string {
  if (!z.aktiv || z.kanal !== 'email') {
    return (
      '# Kein E-Mail-Versand eingestellt — Grafana verschickt selbst nichts.\n' +
      '[Service]\n' +
      'Environment=GF_SMTP_ENABLED=false\n'
    );
  }
  const e = z.email;
  return (
    '# Erzeugt vom AskSin-Analyzer. Nicht von Hand bearbeiten —\n' +
    '# die Datei wird bei jeder Änderung in der Weboberfläche neu geschrieben.\n' +
    '[Service]\n' +
    'Environment=GF_SMTP_ENABLED=true\n' +
    `Environment=GF_SMTP_HOST=${e.smtpHost}:${e.smtpPort}\n` +
    `Environment=GF_SMTP_USER=${e.benutzer}\n` +
    `Environment="GF_SMTP_PASSWORD=${e.passwort}"\n` +
    `Environment=GF_SMTP_FROM_ADDRESS=${e.absender}\n` +
    'Environment=GF_SMTP_FROM_NAME=AskSin-Analyzer\n' +
    'Environment=GF_SMTP_STARTTLS_POLICY=MandatoryStartTLS\n'
  );
}

/**
 * Die Probemeldung — in genau der Form, die Grafana später schicken wird.
 *
 * Absichtlich dieselbe Struktur: Der Testknopf soll den ganzen Weg prüfen,
 * nicht einen eigenen. Ein Test, der anders läuft als der Ernstfall, bestätigt
 * am Ende nur sich selbst.
 *
 * @param standort Anzeigename dieses Analyzers
 */
export function baueProbeMeldung(standort: string, jetzt: Date): unknown {
  return {
    status: 'firing',
    alerts: [
      {
        status: 'firing',
        labels: { alertname: 'Probe', standort, bereich: 'analyzer' },
        annotations: {
          summary: 'Testmeldung — der Weg vom Analyzer bis hierher funktioniert.',
          description:
            'Diese Meldung wurde von Hand ausgelöst. Kommt sie an, erreichen ' +
            'dich auch die vier Alarme: Analyzer offline, Duty-Cycle über ' +
            '80 Prozent, Gerät seit 24 Stunden stumm und Grundrauschen erhöht.',
        },
        startsAt: jetzt.toISOString(),
      },
    ],
  };
}

/** Derselbe Inhalt als Fließtext — für Wege ohne Struktur, etwa Telegram. */
export function baueProbeText(standort: string): string {
  return (
    `AskSin-Analyzer (${standort})\n\n` +
    '⚠ Probe — Testmeldung\n' +
    'Der Weg vom Analyzer bis hierher funktioniert.\n\n' +
    'Kommt sie an, erreichen dich auch die vier Alarme: Analyzer offline, ' +
    'Duty-Cycle über 80 Prozent, Gerät seit 24 Stunden stumm und ' +
    'Grundrauschen dauerhaft erhöht.'
  );
}

/**
 * Übersetzt eine gescheiterte Zustellung in einen Satz, mit dem man etwas
 * anfangen kann — die rohe Antwort bleibt darunter stehen.
 *
 * @param kanal Der Weg, über den es versucht wurde
 * @param status HTTP-Status der Antwort; 0, wenn gar keine kam
 * @param antwort Wortlaut der Antwort oder der Fehlermeldung
 */
export function deuteZustellfehler(
  kanal: Alarmkanal,
  status: number,
  antwort: string,
): string {
  const anhang = antwort.trim() === '' ? '' : `\n\nAntwort:\n${antwort.trim()}`;

  if (status === 0) {
    if (/ECONNREFUSED/.test(antwort)) {
      return kanal === 'iobroker'
        ? 'Unter dieser Adresse nimmt niemand an. Läuft die Adapter-Instanz, ' +
            'und ist dort „Alarme entgegennehmen" eingeschaltet? Stimmen Port ' +
            `und Pfad?${anhang}`
        : `Keine Verbindung zum Server.${anhang}`;
    }
    if (/ENOTFOUND|EAI_AGAIN/.test(antwort)) {
      return `Der Name ist nicht auflösbar — Tippfehler in der Adresse?${anhang}`;
    }
    if (/timeout|abort/i.test(antwort)) {
      return `Keine Antwort innerhalb der Wartezeit.${anhang}`;
    }
    return `Die Verbindung kam nicht zustande.${anhang}`;
  }

  if (kanal === 'iobroker') {
    if (status === 401) {
      return (
        'Der Adapter weist das Verbindungspasswort zurück. Es muss auf beiden ' +
        'Seiten dasselbe sein — im Adapter unter „Alarme vom Analyzer", hier ' +
        `im Feld daneben.${anhang}`
      );
    }
    if (status === 404) {
      return (
        'Diesen Pfad kennt der Adapter nicht. Er steht in den ' +
        `Instanzeinstellungen, Vorgabe ist /asksin/alarm.${anhang}`
      );
    }
  }

  if (kanal === 'telegram' && /chat not found/i.test(antwort)) {
    return (
      'Telegram kennt diese Chat-Kennung nicht. Der Bot muss einmal ' +
      'angeschrieben oder in die Gruppe eingeladen worden sein, bevor er ' +
      `dorthin senden darf.${anhang}`
    );
  }
  if (kanal === 'telegram' && /unauthorized/i.test(antwort)) {
    return `Telegram lehnt den Bot-Token ab.${anhang}`;
  }

  return `Der Empfänger hat abgelehnt (HTTP ${status}).${anhang}`;
}

// ---- Ereignismeldungen (M17.2) --------------------------------------------
//
// Nicht jede Nachricht ist ein Alarm. Eine abgeschlossene Systemaktualisierung
// ist ein Ereignis: Sie tritt ein, ist vorbei und hat keinen Zustand, der
// andauert. Zugestellt wird sie trotzdem auf demselben Weg — ein zweiter
// Versandweg neben diesem hiesse, SMTP, Token und Fehlerdeutung ein zweites
// Mal richtig hinzubekommen.

export interface Ereignis {
  /** Kurzname; landet als `alertname` im Adapter. */
  name: string;
  /** Eine Zeile — die Kurzfassung. */
  summary: string;
  /** Die Einzelheiten. */
  description: string;
  /** Ist es eine schlechte Nachricht? Bestimmt nur das Zeichen im Fliesstext. */
  schlecht: boolean;
}

/**
 * Ein Ereignis im Grafana-Webhook-Format.
 *
 * Dieselbe Struktur wie bei den Alarmen — der Adapter kennt genau diese, und
 * jeder andere Webhook-Empfänger ebenso. Eine eigene Struktur zu erfinden
 * hiesse, den Adapter anzufassen und beide Seiten aneinander zu binden.
 *
 * @param status `firing` wird vom Adapter weitergeleitet; `resolved` räumt
 *   danach den Zustand wieder auf — siehe `ereignisAufraeumen`.
 */
export function baueEreignisMeldung(
  standort: string,
  e: Ereignis,
  jetzt: Date,
  status: 'firing' | 'resolved' = 'firing',
): unknown {
  return {
    status,
    alerts: [
      {
        status,
        labels: { alertname: e.name, standort, bereich: 'analyzer' },
        annotations: { summary: e.summary, description: e.description },
        startsAt: jetzt.toISOString(),
        ...(status === 'resolved' ? { endsAt: jetzt.toISOString() } : {}),
      },
    ],
  };
}

/**
 * Warum unmittelbar ein `resolved` hinterhergeschickt wird.
 *
 * Der Adapter leitet nur weiter, was `firing` ist, und merkt sich in
 * `alarm.aktiv`, dass etwas ansteht. Für einen Alarm ist das richtig. Ein
 * abgeschlossenes Update steht aber nicht an — bliebe es bei `firing`, zeigte
 * der Adapter dauerhaft einen aktiven Alarm, und wer daran eine Lampe oder
 * eine Anzeige hängt, hätte sie für immer an.
 *
 * Deshalb dieselbe Folge, die auch Grafana benutzt: erst `firing` (das wird
 * zugestellt), dann `resolved` (das räumt den Zustand auf). Die Entwarnung
 * wird vom Adapter nur weitergeleitet, wenn man das ausdrücklich eingestellt
 * hat — sonst kommt genau eine Nachricht an.
 */
export const EREIGNIS_AUFRAEUMEN = true;

/** Derselbe Inhalt als Fliesstext — für Telegram und E-Mail. */
export function baueEreignisText(standort: string, e: Ereignis): string {
  return (
    `AskSin-Analyzer (${standort})\n\n` +
    `${e.schlecht ? '⚠' : '✓'} ${e.name}\n` +
    `${e.summary}\n\n` +
    e.description
  );
}
