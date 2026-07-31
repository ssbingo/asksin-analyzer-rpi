<script setup lang="ts">
import { reactive, ref } from 'vue';

import {
  holeProtokoll,
  protokollDateiUrl,
  sendeProtokoll,
} from '../api.ts';
import type { ProtokollStufe, ProtokollZustand } from '../api.ts';
import { nutzeTakt } from '../takt.ts';

const zustand = ref<ProtokollZustand | null>(null);
const meldung = ref<{ art: 'ok' | 'fehler'; text: string } | null>(null);
const beschaeftigt = ref(false);
const form = reactive({ stufe: 'info' as ProtokollStufe, tage: 14 });

/** Stufen mit Erklärung — die Auswahl soll ohne Handbuch verständlich sein. */
const STUFEN: Array<{ wert: ProtokollStufe; text: string; hinweis: string }> = [
  { wert: 'fehler', text: 'Fehler', hinweis: 'Nur Störungen. Kleinste Datei.' },
  { wert: 'info', text: 'Info', hinweis: 'Störungen und wichtige Ereignisse. Vorgabe.' },
  { wert: 'debug', text: 'Debug', hinweis: 'Zusätzlich Abläufe im Inneren — für die Fehlersuche.' },
  { wert: 'alles', text: 'Alles', hinweis: 'Auch Einzeltelegramme. Wächst schnell.' },
];

async function laden(): Promise<void> {
  try {
    const z = await holeProtokoll();
    zustand.value = z;
    if (!beschaeftigt.value) {
      form.stufe = z.stufe;
      form.tage = z.tage;
    }
  } catch (err) {
    meldung.value = { art: 'fehler', text: `Protokoll nicht abrufbar: ${String(err)}` };
  }
}

async function speichern(): Promise<void> {
  beschaeftigt.value = true;
  meldung.value = null;
  try {
    await sendeProtokoll({ stufe: form.stufe, tage: Number(form.tage) });
    meldung.value = { art: 'ok', text: 'Gespeichert — sofort wirksam.' };
    await laden();
  } catch (err) {
    meldung.value = {
      art: 'fehler',
      text: err instanceof Error ? err.message : String(err),
    };
  } finally {
    beschaeftigt.value = false;
  }
}

function groesse(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

nutzeTakt(laden, 15_000);
</script>

<template>
  <h2>Wartung</h2>

  <div
    class="meldung"
    v-if="meldung !== null"
    :class="meldung.art"
  >{{ meldung.text }}</div>

  <div class="panel">
    <h3>Protokoll</h3>
    <p class="gedimmt">
      Der Dienst schreibt fortlaufend eine Logdatei — eine je Tag. Sie hilft bei
      Störungen, die sich erst nach Stunden zeigen: Das Protokoll hält
      regelmäßig Temperatur, Speicher, Systemlast und vor allem die
      <strong>Unterspannungs- und Drosselungsmeldungen</strong> des Raspberry Pi
      fest. Wird eine davon auffällig, landet sie sofort als Fehler in der Datei
      — auch bei der sparsamsten Stufe.
    </p>

    <template v-if="zustand?.verfuegbar">
      <div class="zeile" style="margin-bottom: 0.8rem; flex-wrap: wrap">
        <label class="zeile" style="gap: 0.4rem">
          Ausführlichkeit
          <select v-model="form.stufe">
            <option v-for="s in STUFEN" :key="s.wert" :value="s.wert">
              {{ s.text }}
            </option>
          </select>
        </label>
        <label class="zeile" style="gap: 0.4rem">
          Aufbewahrung
          <input
            type="number"
            min="1"
            max="365"
            v-model.number="form.tage"
            style="width: 5rem"
          />
          Tage
        </label>
        <button class="primaer" :disabled="beschaeftigt" @click="speichern">
          Speichern
        </button>
      </div>
      <p class="fussnote">
        {{ STUFEN.find((s) => s.wert === form.stufe)?.hinweis }}
        Ältere Dateien werden beim Tageswechsel gelöscht.
      </p>

      <div v-if="zustand.schreibfehler" class="meldung fehler">
        Das Protokoll kann nicht schreiben: {{ zustand.schreibfehler }}
      </div>

      <h4>Dateien</h4>
      <p v-if="zustand.dateien.length === 0" class="gedimmt">
        Noch keine Datei — sie entsteht mit dem ersten Eintrag.
      </p>
      <table v-else class="daten" style="max-width: 34rem; margin-bottom: 0.9rem">
        <thead>
          <tr><th>Tag</th><th>Größe</th><th></th></tr>
        </thead>
        <tbody>
          <tr v-for="d in zustand.dateien" :key="d.name">
            <td>{{ d.datum }}</td>
            <td>{{ groesse(d.groesse) }}</td>
            <td>
              <a :href="protokollDateiUrl(d.name)" :download="d.name">
                Herunterladen
              </a>
            </td>
          </tr>
        </tbody>
      </table>
      <p class="fussnote">
        Ablage auf dem Gerät: <code>{{ zustand.verzeichnis }}</code> ·
        {{ zustand.eintraege }} Einträge seit dem letzten Dienststart.
      </p>
    </template>

    <p v-else-if="zustand" class="gedimmt">
      Diese Core-Version führt noch kein Protokoll.
    </p>
  </div>
</template>
