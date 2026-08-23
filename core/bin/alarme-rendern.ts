#!/usr/bin/env node
/**
 * Erzeugt die Grafana-Alarmregeln mit den gespeicherten Schaltern.
 *
 * ## Wozu ein eigenes Programm
 *
 * `update.sh` und das Einrichtungsskript kopieren die Regeldatei aus dem
 * Projekt nach `/etc/grafana`. Täten sie das unverändert, würde **jede
 * Aktualisierung alle abgeschalteten Alarme wieder einschalten** — still, und
 * der Betreiber erführe es erst durch die Meldung, die er abbestellt hatte.
 *
 * Genau die Sorte Fehler, die dieses Projekt schon einmal teuer bezahlt hat:
 * Zwei Stellen beschreiben dasselbe, keine meldet sich, und es sieht aus wie
 * ein Gerätefehler. Deshalb kopiert kein Skript die Vorlage mehr direkt —
 * alle gehen hier durch.
 *
 * Aufruf:
 *
 *     node core/bin/alarme-rendern.ts [Zieldatei]
 *
 * Ohne Zieldatei geht das Ergebnis nach stdout. `DATEN_DIR` gibt an, wo
 * `alarme.json` liegt (Vorgabe: /var/lib/asksin-analyzer). Fehlt die Datei,
 * gilt die Vorgabe „alle Alarme an" — dann ist das Ergebnis inhaltlich die
 * Vorlage, nur mit ausgeschriebenem `isPaused: false`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { mitSchaltern, vollstaendig } from '../src/langzeit/alarmschalter.ts';
import type { Alarmschalter } from '../src/langzeit/alarmschalter.ts';

const datenDir = process.env['DATEN_DIR'] ?? '/var/lib/asksin-analyzer';
const vorlage = resolve(
  import.meta.dirname,
  '../../deploy/grafana/provisioning/alerting/asksin-alarme.yaml',
);

let schalter: Alarmschalter;
try {
  schalter = vollstaendig(
    JSON.parse(readFileSync(resolve(datenDir, 'alarme.json'), 'utf8')) as Partial<Alarmschalter>,
  );
} catch {
  // Kein Zustand gespeichert = noch nie etwas umgelegt. Das ist der Normalfall
  // bei einer frischen Installation und kein Fehler.
  schalter = vollstaendig(undefined);
}

const raus = mitSchaltern(readFileSync(vorlage, 'utf8'), schalter);
const ziel = process.argv[2];
if (ziel === undefined) process.stdout.write(raus);
else writeFileSync(ziel, raus, { mode: 0o644 });
