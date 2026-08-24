/**
 * Systemaktualisierung — `apt-get update` und `apt-get full-upgrade`.
 *
 * ## Warum das in die Weboberfläche gehört
 *
 * Der Analyzer läuft dauerhaft, hängt am Netz und trägt einen Webserver. Ein
 * Gerät mit diesen drei Eigenschaften muss seine Sicherheitsaktualisierungen
 * bekommen — sonst sammelt es über Monate offene Lücken an, von denen niemand
 * erfährt.
 *
 * Der übliche Weg dorthin ist die Konsole, und genau die soll dieses Projekt
 * niemandem zumuten. Wer den Analyzer aufstellt, soll ihn über die Oberfläche
 * bedienen können — auch in diesem Punkt.
 *
 * ## Was hier steht und was nicht
 *
 * Hier steht nur, was sich ohne Wurzelrechte entscheiden lässt: wie alt eine
 * Aktualisierung ist, ob sie überfällig wird, und was in der Ausgabe von apt
 * eigentlich stand. Das Ausführen selbst macht `deploy/systemupdate.sh` als
 * eng begrenzter Root-Helfer — dasselbe Muster wie beim Alarmziel und beim
 * Core-Update.
 */

/**
 * Ab wie vielen Tagen ohne Aktualisierung gewarnt wird.
 *
 * Sieben Tage, so vom Betreiber vorgegeben. Die Zahl ist keine
 * Sicherheitsgrenze, sondern eine Gedächtnisstütze: Debian veröffentlicht
 * Sicherheitsaktualisierungen laufend, und eine Woche ist der Abstand, in dem
 * man ohne schlechtes Gewissen nicht hinsehen muss.
 */
export const SYSTEMUPDATE_WARNUNG_TAGE = 7;

/**
 * Ab wann ein als laufend vermerkter Lauf als steckengeblieben gilt.
 *
 * Eine Stunde, deutlich großzügiger als beim Core-Update (dort eine halbe).
 * `apt-get full-upgrade` kann auf einem Pi 3 mit SD-Karte nach einem längeren
 * Rückstand tatsächlich lange laufen — und eine Sperre, die zu früh greift,
 * startet einen zweiten apt-Lauf neben den ersten. Das Skript frischt
 * `updatedAt` bei jedem Schritt auf.
 */
export const SYSTEMUPDATE_STECKEN_MS = 60 * 60 * 1000;

/** Die Schritte, die das Helferskript meldet. */
export type SystemupdateSchritt =
  | 'start'
  | 'paketlisten'
  | 'aufruesten'
  | 'aufraeumen'
  | 'fertig';

/** Der Fortschritt, wie ihn der Root-Helfer in seine Statusdatei schreibt. */
export interface SystemupdateStatus {
  running: boolean;
  schritt: SystemupdateSchritt;
  /** null, solange es läuft. */
  ok: boolean | null;
  startedAt: number;
  updatedAt: number;
  /** Wie viele Pakete aufgerüstet wurden; null, wenn nicht ermittelbar. */
  pakete: number | null;
  /** Verlangt das System nach dem Lauf einen Neustart? */
  neustartNoetig: boolean;
  /** Klartext im Fehlerfall — die Meldung von apt, nicht unsere Deutung. */
  fehler: string | null;
}

/** Was beim letzten **erfolgreichen** Lauf herauskam. */
export interface SystemupdateErfolg {
  /** Zeitpunkt in Millisekunden. */
  zeit: number;
  pakete: number | null;
  neustartNoetig: boolean;
}

/** Wie dringend ist eine Aktualisierung? */
export type Dringlichkeit = 'nie' | 'frisch' | 'ueberfaellig';

export interface Altersbefund {
  stufe: Dringlichkeit;
  /** Volle Tage seit dem letzten Erfolg; null, wenn es noch keinen gab. */
  alterTage: number | null;
  /** Ein Satz für die Oberfläche — sie zeigt ihn wörtlich. */
  text: string;
}

/**
 * Wie lange ist die letzte erfolgreiche Aktualisierung her?
 *
 * „Noch nie" ist **nicht** dasselbe wie „lange her" und bekommt deshalb eine
 * eigene Stufe: Bei einem frisch aufgesetzten Gerät ist das der Normalzustand
 * und keine Versäumnis — die Aufforderung lautet trotzdem gleich, nur der Ton
 * ist ein anderer.
 *
 * @param letzterErfolgMs Zeitpunkt des letzten Erfolgs, oder null.
 * @param jetzt Wanduhr.
 * @param schwelleTage Ab wann gewarnt wird. Ohne Zeitplan die festen sieben
 *   Tage; mit Plan der Rhythmus plus Luft (siehe `warnschwelleTage`) — sonst
 *   stünde bei „monatlich" drei Wochen im Monat eine Warnung, obwohl alles
 *   nach Plan läuft.
 */
export function bewerteAlter(
  letzterErfolgMs: number | null,
  jetzt: number,
  schwelleTage: number = SYSTEMUPDATE_WARNUNG_TAGE,
): Altersbefund {
  if (letzterErfolgMs === null || !Number.isFinite(letzterErfolgMs)) {
    return {
      stufe: 'nie',
      alterTage: null,
      text: 'Über diese Oberfläche wurde noch nie aktualisiert.',
    };
  }
  // Ein Zeitstempel aus der Zukunft entsteht, wenn die Uhr nachträglich
  // zurückgestellt wird (Pi ohne Batterie, NTP kommt spät). Ihn als „in
  // −3 Tagen" anzuzeigen wäre Unsinn; als frisch zu werten ist die harmlosere
  // Deutung, denn kurz darauf stimmt die Uhr wieder.
  const alterMs = Math.max(0, jetzt - letzterErfolgMs);
  const alterTage = Math.floor(alterMs / 86_400_000);

  if (alterTage < schwelleTage) {
    return {
      stufe: 'frisch',
      alterTage,
      text:
        alterTage === 0
          ? 'Heute aktualisiert.'
          : `Vor ${alterTage} ${alterTage === 1 ? 'Tag' : 'Tagen'} aktualisiert.`,
    };
  }
  return {
    stufe: 'ueberfaellig',
    alterTage,
    text:
      `Die letzte Aktualisierung ist ${alterTage} Tage her — ` +
      (schwelleTage > SYSTEMUPDATE_WARNUNG_TAGE
        // Bei aktivem Plan ist das kein Vergessen, sondern ein Befund: Der
        // Lauf haette laengst stattfinden muessen. Beides gleich zu benennen
        // schickte den Leser an die falsche Stelle.
        ? 'ein geplanter Lauf scheint ausgefallen zu sein.'
        : 'bitte bald nachholen.'),
  };
}

/**
 * Liest aus apts Zusammenfassung, wie viele Pakete aufgerüstet wurden.
 *
 * Der Helfer ruft apt mit `LC_ALL=C` auf, damit die Ausgabe unabhängig von der
 * Spracheinstellung des Geräts ist. Die deutsche Form wird trotzdem erkannt:
 * Wer das Skript von Hand ohne diese Umgebung startet, soll keine Lücke in der
 * Anzeige bekommen.
 *
 * @returns Anzahl, oder null, wenn die Zeile nicht vorkam.
 */
export function zaehleAufgeruestet(ausgabe: string): number | null {
  const englisch = /^(\d+) upgraded, \d+ newly installed/m.exec(ausgabe);
  if (englisch !== null) return Number(englisch[1]);
  const deutsch = /^(\d+) aktualisiert, \d+ neu installiert/m.exec(ausgabe);
  if (deutsch !== null) return Number(deutsch[1]);
  return null;
}

/**
 * Läuft gerade ein Lauf — oder hängt einer?
 *
 * Dieselbe Überlegung wie beim Core-Update: Eine Sperre, aus der nur der
 * Erfolgsfall herausführt, ist keine Sperre, sondern eine Falle. Wird der Lauf
 * hart abgebrochen (Stromausfall mitten im Aufrüsten), bliebe `running` sonst
 * für immer stehen, und die Oberfläche verweigerte jeden weiteren Versuch.
 */
export function laeuftNoch(status: SystemupdateStatus | null, jetzt: number): boolean {
  if (status === null || !status.running) return false;
  const alterMs = jetzt - status.updatedAt;
  return Number.isFinite(alterMs) && alterMs < SYSTEMUPDATE_STECKEN_MS;
}

// ---- Zeitplan (M17.1) ------------------------------------------------------
//
// Ausgeführt wird der Plan von einem systemd-Timer, nicht von einem eigenen
// Zeitplaner im Dienst. Grund: Ein Zeitplaner, der nur läuft, solange der
// Dienst läuft, ist eine stille Lücke — war das Gerät zur fälligen Zeit aus,
// fällt der Lauf ersatzlos aus, und niemand erfährt davon. systemd bringt das
// Nachholen (`Persistent=true`) und die Streuung fertig mit.

/** Wie oft aktualisiert werden soll. */
export type Rhythmus = 'taeglich' | 'woechentlich' | 'monatlich';

export interface Zeitplan {
  aktiv: boolean;
  rhythmus: Rhythmus;
  /** 1 = Montag … 7 = Sonntag (ISO). Nur bei `woechentlich`. */
  wochentag: number;
  /** 1…31. Nur bei `monatlich`. */
  monatstag: number;
  stunde: number;
  minute: number;
  /** Nach dem Lauf neu starten, wenn das System es verlangt? */
  neustarten: boolean;
}

/**
 * Vorgabe: wöchentlich, Samstag 03:00, ohne automatischen Neustart.
 *
 * Wöchentlich, weil täglich für ein Haushaltsgerät mehr Bewegung ist als
 * nötig und monatlich Sicherheitslücken zu lange offen lässt. Samstag, weil
 * man dann eher zu Hause ist, falls doch etwas klemmt. Nachts, weil apt dabei
 * Dienste neu startet.
 */
export const ZEITPLAN_VORGABE: Zeitplan = {
  aktiv: false,
  rhythmus: 'woechentlich',
  wochentag: 6,
  monatstag: 1,
  stunde: 3,
  minute: 0,
  neustarten: false,
};

/**
 * Streuung in Sekunden.
 *
 * Ohne sie fragen alle Analyzer des Verbunds zur selben Sekunde denselben
 * Debian-Spiegel und wären — bei einem Kernel-Update mit Neustart —
 * gleichzeitig weg. Eine halbe Stunde reicht, um sie auseinanderzuziehen, und
 * ist kurz genug, dass „um drei" noch „um drei" bedeutet.
 */
export const ZEITPLAN_STREUUNG_S = 1800;

/**
 * Zusätzliche Frist, bevor bei aktivem Plan gewarnt wird.
 *
 * Zwei Tage Luft: Ein Lauf kann sich um die Streuung verschieben, das Gerät
 * kann einen Abend aus gewesen sein, und `Persistent=true` holt ihn dann beim
 * nächsten Start nach. Ohne diese Luft leuchtete die Warnung bei jedem
 * dieser harmlosen Fälle auf — und eine Warnung, die man oft grundlos sieht,
 * sieht man bald gar nicht mehr.
 */
export const ZEITPLAN_LUFT_TAGE = 2;

const WOCHENTAGE = [
  '', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag',
] as const;

/** systemd kennt die Tage englisch und dreibuchstabig. */
const WOCHENTAGE_SYSTEMD = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

const MONATE = [
  '', 'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
] as const;

function begrenze(wert: unknown, min: number, max: number, vorgabe: number): number {
  const z = Math.floor(Number(wert));
  if (!Number.isFinite(z) || z < min || z > max) return vorgabe;
  return z;
}

/** Macht aus einer beliebigen Eingabe einen gültigen Plan. */
export function pruefeZeitplan(teil: Partial<Zeitplan> | undefined): Zeitplan {
  const r = teil?.rhythmus;
  return {
    aktiv: teil?.aktiv === true,
    rhythmus:
      r === 'taeglich' || r === 'woechentlich' || r === 'monatlich'
        ? r
        : ZEITPLAN_VORGABE.rhythmus,
    wochentag: begrenze(teil?.wochentag, 1, 7, ZEITPLAN_VORGABE.wochentag),
    monatstag: begrenze(teil?.monatstag, 1, 31, ZEITPLAN_VORGABE.monatstag),
    stunde: begrenze(teil?.stunde, 0, 23, ZEITPLAN_VORGABE.stunde),
    minute: begrenze(teil?.minute, 0, 59, ZEITPLAN_VORGABE.minute),
    neustarten: teil?.neustarten === true,
  };
}

/**
 * In welchen Monaten es diesen Tag nicht gibt.
 *
 * Gemessen an systemd 257: `*-*-31 03:00` springt vom 31.08. auf den 31.10.,
 * dann den 31.12. — September und November fallen **ersatzlos** aus, ohne
 * Meldung. Wer den 31. wählt, bekommt in fünf von zwölf Monaten gar keine
 * Aktualisierung. Deshalb bleibt die Wahl frei, aber sie wird benannt.
 *
 * @returns Leere Liste bei 1…28.
 */
export function ausfallmonate(monatstag: number): string[] {
  if (monatstag <= 28) return [];
  if (monatstag === 29) return ['Februar (außer in Schaltjahren)'];
  if (monatstag === 30) return ['Februar'];
  return [MONATE[2]!, MONATE[4]!, MONATE[6]!, MONATE[9]!, MONATE[11]!];
}

/** Der `OnCalendar=`-Ausdruck für systemd. */
export function kalenderAusdruck(plan: Zeitplan): string {
  const uhr = `${String(plan.stunde).padStart(2, '0')}:${String(plan.minute).padStart(2, '0')}:00`;
  switch (plan.rhythmus) {
    case 'taeglich':
      return `*-*-* ${uhr}`;
    case 'woechentlich':
      return `${WOCHENTAGE_SYSTEMD[plan.wochentag]} *-*-* ${uhr}`;
    case 'monatlich':
      return `*-*-${String(plan.monatstag).padStart(2, '0')} ${uhr}`;
  }
}

/** Der Plan in einem Satz — die Oberfläche zeigt ihn wörtlich. */
export function beschreibeZeitplan(plan: Zeitplan): string {
  const uhr = `${String(plan.stunde).padStart(2, '0')}:${String(plan.minute).padStart(2, '0')}`;
  switch (plan.rhythmus) {
    case 'taeglich':
      return `Läuft täglich um ${uhr} Uhr`;
    case 'woechentlich':
      return `Läuft jeden ${WOCHENTAGE[plan.wochentag]} um ${uhr} Uhr`;
    case 'monatlich':
      return `Läuft am ${plan.monatstag}. jedes Monats um ${uhr} Uhr`;
  }
}

/**
 * Wann läuft es das nächste Mal?
 *
 * Gerechnet wird in **Ortszeit** — `new Date(j, m, t, …)` benutzt die Zone des
 * Geräts, und das ist die Zone, in der auch systemd seinen Kalender auswertet.
 * Ein Plan „um 03:00" soll um drei Uhr laufen, auch über die Zeitumstellung
 * hinweg.
 *
 * Die Streuung ist **nicht** eingerechnet: Sie ist zufällig, und eine Vorschau,
 * die eine erfundene Minute nennt, wäre schlechter als eine, die den geplanten
 * Zeitpunkt nennt und die Streuung dazusagt.
 *
 * @returns Zeitpunkt in Millisekunden, oder null bei abgeschaltetem Plan.
 */
export function naechsterLauf(plan: Zeitplan, jetzt: number): number | null {
  if (!plan.aktiv) return null;
  const start = new Date(jetzt);

  const anWelchemTag = (versatz: number): Date => {
    const d = new Date(
      start.getFullYear(), start.getMonth(), start.getDate() + versatz,
      plan.stunde, plan.minute, 0, 0,
    );
    return d;
  };

  if (plan.rhythmus === 'taeglich') {
    const heute = anWelchemTag(0);
    return (heute.getTime() > jetzt ? heute : anWelchemTag(1)).getTime();
  }

  if (plan.rhythmus === 'woechentlich') {
    // getDay(): 0 = Sonntag. Der Plan zählt nach ISO, 7 = Sonntag.
    const heuteIso = start.getDay() === 0 ? 7 : start.getDay();
    let versatz = (plan.wochentag - heuteIso + 7) % 7;
    if (versatz === 0 && anWelchemTag(0).getTime() <= jetzt) versatz = 7;
    return anWelchemTag(versatz).getTime();
  }

  // Monatlich: den nächsten Monat suchen, der diesen Tag ueberhaupt hat.
  // Bis zu 14 Monate weit — der 29. Februar kann vier Jahre entfernt sein,
  // aber schon der 30. findet sich spaetestens im uebernaechsten Monat. Vier
  // Jahre abzusuchen kostet nichts und beantwortet auch den Schaltjahr-Fall.
  for (let i = 0; i <= 48; i++) {
    const jahr = start.getFullYear();
    const monat = start.getMonth() + i;
    const tageImMonat = new Date(jahr, monat + 1, 0).getDate();
    if (plan.monatstag > tageImMonat) continue;
    const d = new Date(jahr, monat, plan.monatstag, plan.stunde, plan.minute, 0, 0);
    if (d.getTime() > jetzt) return d.getTime();
  }
  return null;
}

/**
 * Ab wie vielen Tagen ohne Erfolg gewarnt wird.
 *
 * Ohne Plan die festen sieben Tage. Mit Plan der Rhythmus plus Luft — sonst
 * stünde bei „monatlich" drei Wochen im Monat eine gelbe Warnung, obwohl alles
 * nach Plan läuft. Eine Warnung, die man gewohnheitsmäßig übersieht, warnt
 * niemanden mehr.
 */
export function warnschwelleTage(plan: Zeitplan | null): number {
  if (plan === null || !plan.aktiv) return SYSTEMUPDATE_WARNUNG_TAGE;
  const grund =
    plan.rhythmus === 'taeglich' ? 1 : plan.rhythmus === 'woechentlich' ? 7 : 31;
  return grund + ZEITPLAN_LUFT_TAGE;
}

/**
 * Die Timer-Unit für systemd.
 *
 * `Persistent=true` holt einen Lauf nach, der ausfiel, weil das Gerät aus war
 * — ohne das wäre ein Analyzer, der übers Wochenende vom Netz genommen wird,
 * dauerhaft ungepflegt, und die Anzeige sagte trotzdem „Plan aktiv".
 */
export function baueTimer(plan: Zeitplan): string {
  return [
    '# ERZEUGT vom AskSin-Analyzer aus den Einstellungen unter Wartung.',
    '# Änderungen hier werden beim nächsten Speichern überschrieben.',
    '[Unit]',
    `Description=AskSin-Analyzer: ${beschreibeZeitplan(plan)}`,
    '',
    '[Timer]',
    `OnCalendar=${kalenderAusdruck(plan)}`,
    '# Verhindert, dass alle Analyzer des Verbunds zur selben Sekunde loslaufen.',
    `RandomizedDelaySec=${ZEITPLAN_STREUUNG_S}`,
    '# Holt einen Lauf nach, der ausfiel, weil das Gerät aus war.',
    'Persistent=true',
    'Unit=asksin-analyzer-systemupdate-geplant.service',
    '',
    '[Install]',
    'WantedBy=timers.target',
    '',
  ].join('\n');
}

/** Was systemd über den Timer sagt. */
export interface TimerBefund {
  aktiv: boolean;
  /** Nächste Zündung in Millisekunden, oder null. */
  naechster: number | null;
  /** Welche Unit der Timer startet — muss die geplante sein. */
  startet: string | null;
}

/**
 * Liest `systemctl list-timers --output=json`.
 *
 * ## Warum nicht `systemctl show -p NextElapseUSecRealtime`
 *
 * Weil das trotz des Namens **keine Mikrosekunden** liefert, sondern einen
 * formatierten Zeitstempel:
 *
 *     NextElapseUSecRealtime=Mon 2026-08-31 03:09:45 CEST
 *
 * Mein erster Versuch suchte dort nach Ziffern und fand nie welche — die
 * Anzeige blieb still leer, obwohl der Timer lief. Genau die Sorte Fehler, für
 * die diese Zweitmeinung überhaupt da ist; sie hat sich damit gleich selbst
 * gefunden. `--timestamp=unix` hilft hier nicht, es wirkt auf andere Ausgaben.
 *
 * `list-timers --output=json` gibt `next` als Zahl (Mikrosekunden) und nennt
 * zusätzlich, welche Unit gestartet wird — womit sich auch belegen lässt, dass
 * der Timer die *geplante* Unit meint und nicht die manuelle.
 *
 * Ohne `--all` listet systemd nur aktive Timer. Eine leere Liste heisst also
 * „nicht aktiv" und ist kein Fehler.
 */
export function leseTimerJson(stdout: string): TimerBefund {
  const leer: TimerBefund = { aktiv: false, naechster: null, startet: null };
  let liste: unknown;
  try {
    liste = JSON.parse(stdout);
  } catch {
    return leer;
  }
  if (!Array.isArray(liste) || liste.length === 0) return leer;
  const e = liste[0] as { next?: unknown; activates?: unknown };
  const roh = typeof e.next === 'number' ? e.next : 0;
  return {
    aktiv: true,
    // Mikrosekunden seit der Epoche. 0 heisst „kein Termin bekannt".
    naechster: roh > 0 ? Math.round(roh / 1000) : null,
    startet: typeof e.activates === 'string' ? e.activates : null,
  };
}
