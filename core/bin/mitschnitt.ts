#!/usr/bin/env node
/**
 * mitschnitt — Grundlinie aufzeichnen und vergleichen.
 *
 * Vor jeder Änderung an der Sniffer-Firmware wird festgehalten, wie sie sich
 * heute verhält. Hinterher wird erneut aufgezeichnet und gegengehalten. Ohne
 * dieses Vorher gibt es kein belastbares Nachher — man verglicht eine Messung
 * mit einer Erinnerung.
 *
 *   node core/bin/mitschnitt.ts aufzeichnen <datei> [--dauer 60] [--port …]
 *   node core/bin/mitschnitt.ts auswerten   <datei>
 *   node core/bin/mitschnitt.ts vergleichen <vorher> <nachher>
 *
 * Für den Dauerbetrieb ist `aufzeichnen` nicht der richtige Weg: Es öffnet den
 * Port selbst und verlangt deshalb, dass der Analyzer-Dienst steht. Wer ohne
 * Unterbrechung mitschneiden will, schaltet es im Dienst frei (config.json,
 * Abschnitt `mitschnitt`) — dann läuft alles weiter.
 */

import { readFileSync } from 'node:fs';
import { argv, exit, stdout } from 'node:process';

import { SerialIngest } from '../src/ingest/ingest.ts';
import { DEFAULT_BAUD, DEFAULT_DEVICE, sttyPortOpener } from '../src/ingest/sttyPort.ts';
import { MitschnittSchreiber } from '../src/mitschnitt/schreiber.ts';
import { vergleiche, werteAus } from '../src/mitschnitt/auswertung.ts';
import type { Auswertung } from '../src/mitschnitt/auswertung.ts';

function hilfe(): never {
  stdout.write(`mitschnitt — Grundlinie aufzeichnen und vergleichen

  aufzeichnen <datei> [--dauer <minuten>] [--port <gerät>] [--baud <rate>]
      Zeichnet den rohen Zeilenstrom auf. Vorgabe: 60 Minuten.
      Achtung: Der Analyzer-Dienst muss dafür gestoppt sein —
      zwei Leser an einer seriellen Schnittstelle vertragen sich nicht.
          sudo systemctl stop asksin-analyzer

  auswerten <datei>
      Zeigt die Kennzahlen eines Mitschnitts.

  vergleichen <vorher> <nachher>
      Stellt zwei Mitschnitte gegenüber und bewertet, was sich verändert hat.

Empfohlene Dauer für eine Grundlinie: mindestens 60 Minuten. Der Rauschtakt
zeigt sich schon nach Sekunden, seltene Aussetzer aber erst über die Zeit.
`);
  exit(0);
}

function zahlArg(name: string, vorgabe: number): number {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return vorgabe;
  const wert = Number(argv[i + 1]);
  if (!Number.isFinite(wert) || wert <= 0) {
    stdout.write(`--${name} braucht eine positive Zahl.\n`);
    exit(2);
  }
  return wert;
}

function textArg(name: string, vorgabe: string): string {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? (argv[i + 1] as string) : vorgabe;
}

// --- Ausgabe ---------------------------------------------------------------

function ms(v: number): string {
  if (v < 1000) return `${Math.round(v)} ms`;
  if (v < 60_000) return `${(v / 1000).toFixed(1)} s`;
  return `${(v / 60_000).toFixed(1)} min`;
}

function zeigeAuswertung(a: Auswertung): void {
  const z: string[] = [];
  z.push(`Mitschnitt: ${a.quelle}`);
  if (a.zeilen === 0) {
    z.push('');
    z.push('Keine verwertbaren Zeilen. Entweder ist die Datei leer, oder es');
    z.push('kam während der Aufzeichnung nichts an — beides ist ein Befund.');
    stdout.write(`${z.join('\n')}\n`);
    return;
  }
  z.push(`Gerät:      ${a.geraet ?? 'unbekannt'}${a.baud ? `, ${a.baud} Baud` : ''}`);
  z.push(`Zeitraum:   ${new Date(a.von).toISOString()} … ${new Date(a.bis).toISOString()}`);
  z.push(`Dauer:      ${ms(a.dauerMs)}`);
  z.push('');
  z.push(`Zeilen:          ${a.zeilen}  (${a.zeilenProMinute.toFixed(1)}/min)`);
  z.push(`  Telegramme:    ${a.telegramme}  von ${a.absender} Absendern`);
  z.push(`  Rauschzeilen:  ${a.rauschzeilen}`);
  z.push(`  verworfen:     ${a.verworfen}`);
  for (const [grund, anzahl] of Object.entries(a.verworfenNachGrund)) {
    z.push(`      ${grund.padEnd(18)} ${anzahl}`);
  }
  if (a.unlesbar > 0) {
    z.push(`  Formatfehler in der Mitschnittdatei: ${a.unlesbar}`);
  }
  z.push('');

  if (a.rauschTakt) {
    const t = a.rauschTakt;
    z.push('Rauschtakt (Soll 750 ms — hängt nur an der Firmware):');
    z.push(
      `  Median ${Math.round(t.median)} ms   p95 ${Math.round(t.p95)} ms   ` +
        `min ${Math.round(t.min)} ms   max ${Math.round(t.max)} ms`,
    );
    const anteil = t.n > 0 ? (a.taktAusreisser / t.n) * 100 : 0;
    z.push(
      `  Ausreißer (>50 % daneben): ${a.taktAusreisser} von ${t.n}  ` +
        `(${anteil.toFixed(2)} %)`,
    );
    if (anteil > 1) {
      z.push('  → auffällig. Der Takt hängt an nichts als der Firmware;');
      z.push('    Unruhe hier deutet auf blockierende Stellen im Programm.');
    }
    z.push('');
  }

  if (a.luecken.length > 0) {
    z.push(
      `Lücken (Stille über ${ms(2250)}): ${a.lueckenAnzahl}, ` +
        `zusammen ${ms(a.lueckenGesamtMs)}`,
    );
    for (const l of a.luecken.slice(0, 5)) {
      z.push(`  ${new Date(l.von).toISOString()}  ${ms(l.dauerMs)}`);
    }
    if (a.lueckenAnzahl > 5) z.push(`  … und ${a.lueckenAnzahl - 5} weitere`);
    z.push('');
    z.push('  Achtung bei der Deutung: Eine Lücke heißt NICHT zwingend, dass');
    z.push('  etwas verloren ging. Heute lässt sich beides nicht unterscheiden —');
    z.push('  genau dafür ist die laufende Nummer in der neuen Firmware gedacht.');
  } else {
    z.push('Lücken: keine.');
  }
  z.push('');

  if (a.rssi) {
    z.push(
      `Pegel: Median ${Math.round(a.rssi.median)} dBm  ` +
        `(${Math.round(a.rssi.min)} … ${Math.round(a.rssi.max)})`,
    );
  }
  if (a.zeilenlaenge) {
    z.push(
      `Zeilenlänge: Median ${a.zeilenlaenge.median}  max ${a.zeilenlaenge.max} Zeichen`,
    );
  }
  stdout.write(`${z.join('\n')}\n`);
}

function zeigeVergleich(vorher: Auswertung, nachher: Auswertung): void {
  const zeilen = vergleiche(vorher, nachher);
  const b1 = Math.max(30, ...zeilen.map((z) => z.groesse.length));
  const b2 = Math.max(8, ...zeilen.map((z) => z.vorher.length));
  const b3 = Math.max(8, ...zeilen.map((z) => z.nachher.length));

  const aus: string[] = [];
  aus.push(`vorher:  ${vorher.quelle}`);
  aus.push(`nachher: ${nachher.quelle}`);
  aus.push('');
  aus.push(
    `${'Größe'.padEnd(b1)}  ${'vorher'.padStart(b2)}  ${'nachher'.padStart(b3)}`,
  );
  aus.push('-'.repeat(b1 + b2 + b3 + 6));

  for (const z of zeilen) {
    const marke =
      z.richtung === '+' ? ' besser'
      : z.richtung === '-' ? ' SCHLECHTER'
      : z.richtung === '=' ? ''
      : '';
    const stern = z.aussagekraeftig ? '' : ' *';
    aus.push(
      `${z.groesse.padEnd(b1)}  ${z.vorher.padStart(b2)}  ` +
        `${z.nachher.padStart(b3)}${marke}${stern}`,
    );
  }

  aus.push('');
  aus.push('* Hängt vom Funkverkehr zur Aufzeichnungszeit ab und ist zwischen');
  aus.push('  zwei Mitschnitten NICHT vergleichbar. Steht hier nur, damit man');
  aus.push('  sieht, ob die beiden überhaupt ähnlich belebt waren.');

  const schlechter = zeilen.filter((z) => z.richtung === '-').length;
  aus.push('');
  aus.push(
    schlechter === 0
      ? 'Keine der belastbaren Größen hat sich verschlechtert.'
      : `${schlechter} Größe(n) haben sich verschlechtert — vor einer Freigabe klären.`,
  );
  stdout.write(`${aus.join('\n')}\n`);
  if (schlechter > 0) exit(1);
}

// --- Aufzeichnen -----------------------------------------------------------

async function aufzeichnen(pfad: string): Promise<void> {
  const minuten = zahlArg('dauer', 60);
  const geraet = textArg('port', DEFAULT_DEVICE);
  const baud = zahlArg('baud', DEFAULT_BAUD);

  const schreiber = new MitschnittSchreiber({
    pfad,
    geraet,
    baud,
    onFehler: (f) => stdout.write(`Schreibfehler: ${String(f)}\n`),
  });

  const ingest = new SerialIngest({
    openPort: sttyPortOpener(geraet, baud),
    onRawLine: (zeile, ts) => schreiber.zeile(zeile, ts),
    onStateChange: (w) => {
      stdout.write(
        w.connected
          ? 'verbunden\n'
          : `getrennt (${w.reason})${w.retryInMs ? `, neuer Versuch in ${w.retryInMs} ms` : ''}\n`,
      );
    },
  });

  stdout.write(`Zeichne ${minuten} Minuten nach ${pfad} auf.\n`);
  stdout.write('Abbruch mit Strg+C — das Aufgezeichnete bleibt erhalten.\n\n');

  let beendet = false;
  const beenden = (): void => {
    if (beendet) return;
    beendet = true;
    void ingest.stop().then(() => {
      schreiber.stop();
      const s = schreiber.stats();
      const i = ingest.stats;
      stdout.write(
        `\nGeschrieben: ${s.geschrieben} Zeilen, ${(s.bytes / 1024).toFixed(1)} KiB\n`,
      );
      if (s.verworfen > 0) {
        stdout.write(`Im Puffer verworfen: ${s.verworfen} — die Platte kam nicht mit.\n`);
      }
      if (i.droppedLines > 0) {
        stdout.write(`Vor dem Mitschnitt verloren: ${i.droppedLines} (Queue-Überlauf)\n`);
      }
      stdout.write(`\nAuswerten mit:\n  node core/bin/mitschnitt.ts auswerten ${pfad}\n`);
      exit(0);
    });
  };

  process.on('SIGINT', beenden);
  process.on('SIGTERM', beenden);
  const uhr = setTimeout(beenden, minuten * 60_000);
  uhr.unref?.();

  await ingest.start();
}

// --- Einstieg --------------------------------------------------------------

const befehl = argv[2];
const datei = argv[3];

if (befehl === undefined || befehl === '--help' || befehl === '-h') hilfe();

if (datei === undefined) {
  stdout.write(`Es fehlt die Datei. Aufruf:\n  mitschnitt ${befehl} <datei>\n`);
  exit(2);
}

function lies(p: string): Auswertung {
  try {
    return werteAus(readFileSync(p, 'utf8'), p);
  } catch (fehler) {
    stdout.write(`Kann ${p} nicht lesen: ${String(fehler)}\n`);
    exit(2);
  }
}

switch (befehl) {
  case 'aufzeichnen':
    await aufzeichnen(datei);
    break;
  case 'auswerten':
    zeigeAuswertung(lies(datei));
    break;
  case 'vergleichen': {
    const zweite = argv[4];
    if (zweite === undefined) {
      stdout.write('vergleichen braucht zwei Dateien: <vorher> <nachher>\n');
      exit(2);
    }
    zeigeVergleich(lies(datei), lies(zweite));
    break;
  }
  default:
    stdout.write(`Unbekannter Befehl: ${befehl}\n\n`);
    hilfe();
}
