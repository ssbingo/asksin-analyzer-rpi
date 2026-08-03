<script setup lang="ts">
import { reactive, ref } from 'vue';

import HandbuchFuss from '../components/HandbuchFuss.vue';

import {
  holeMitschnitt,
  holeProtokoll,
  protokollDateiUrl,
  sendeMitschnitt,
  sendeProtokoll,
} from '../api.ts';
import type {
  MitschnittZustand,
  ProtokollStufe,
  ProtokollZustand,
} from '../api.ts';
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

// --- Mitschnitt ----------------------------------------------------------

const mitschnitt = ref<MitschnittZustand | null>(null);
const mitschnittBeschaeftigt = ref(false);

async function mitschnittLaden(): Promise<void> {
  try {
    mitschnitt.value = await holeMitschnitt();
  } catch {
    // Ältere Core-Fassungen kennen den Endpunkt nicht. Das ist kein Fehler,
    // den der Anwender sehen muss — der Abschnitt bleibt dann einfach leer.
    mitschnitt.value = null;
  }
}

async function mitschnittSchalten(aktiv: boolean): Promise<void> {
  mitschnittBeschaeftigt.value = true;
  meldung.value = null;
  try {
    mitschnitt.value = await sendeMitschnitt({ aktiv });
    meldung.value = {
      art: 'ok',
      text: aktiv
        ? 'Mitschnitt läuft. Der Analyzer arbeitet dabei normal weiter.'
        : 'Mitschnitt beendet. Die Datei bleibt erhalten.',
    };
  } catch (err) {
    meldung.value = {
      art: 'fehler',
      text: err instanceof Error ? err.message : String(err),
    };
  } finally {
    mitschnittBeschaeftigt.value = false;
  }
}

async function mitschnittLeeren(): Promise<void> {
  // Zweifache Rückfrage wäre zu viel, keine wäre zu wenig: Eine Grundlinie
  // lässt sich nach dem Flashen der Firmware nicht nachholen.
  if (
    !window.confirm(
      'Mitschnitt wirklich löschen?\n\n' +
        'Eine Aufzeichnung mit der alten Firmware lässt sich später nicht ' +
        'nachholen — nach dem Aufspielen der neuen ist sie unwiederbringlich weg.',
    )
  ) {
    return;
  }
  mitschnittBeschaeftigt.value = true;
  try {
    mitschnitt.value = await sendeMitschnitt({ aktiv: false, loeschen: true });
    meldung.value = { art: 'ok', text: 'Mitschnitt gelöscht.' };
  } catch (err) {
    meldung.value = {
      art: 'fehler',
      text: err instanceof Error ? err.message : String(err),
    };
  } finally {
    mitschnittBeschaeftigt.value = false;
  }
}

nutzeTakt(async () => {
  await laden();
  await mitschnittLaden();
}, 15_000);
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
      — auch bei der sparsamsten Stufe. Zusätzlich werden die Meldungen des
      <strong>Systemjournals</strong> übernommen (OOM-Killer, USB-Resets,
      Dateisystemfehler, Kernel-Unterspannung) und nach jedem Start bewertet,
      ob der vorherige Systemlauf sauber endete — daran erkennt man, ob eine
      Störung aus dem System kam und nicht aus dieser Anwendung.
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

  <div class="panel" v-if="mitschnitt !== null">
    <h3>Mitschnitt der Funkstrecke</h3>
    <p class="gedimmt">
      Zeichnet auf, was der Sniffer <em>wörtlich</em> auf die Leitung schreibt —
      mit Zeitstempel, vor jeder Auswertung. Gedacht ist das für eine Sache:
      festzuhalten, wie sich die Firmware <strong>heute</strong> verhält, bevor
      eine neue aufgespielt wird. Ohne dieses Vorher lässt sich hinterher nicht
      belegen, dass es besser geworden ist.
    </p>

    <div class="meldung fehler" v-if="mitschnitt.demo">
      <strong>Demo-Modus:</strong> Diese Daten sind simuliert. Für eine
      Grundlinie taugen sie <strong>nicht</strong> — der Takt ist künstlich
      sauber, es gibt keine Übertragungsfehler und keine Aussetzer. Zum
      Ausprobieren des Ablaufs ist es dagegen genau richtig. Die Aufzeichnung
      merkt sich ihre Herkunft; ein späterer Vergleich mit echten Daten wird
      abgelehnt statt gerechnet.
    </div>

    <p>
      <button
        v-if="!mitschnitt.aktiv"
        class="primaer"
        :disabled="mitschnittBeschaeftigt"
        @click="mitschnittSchalten(true)"
      >Aufzeichnung starten</button>
      <button
        v-else
        :disabled="mitschnittBeschaeftigt"
        @click="mitschnittSchalten(false)"
      >Aufzeichnung beenden</button>

      <button
        v-if="mitschnitt.vorhanden && !mitschnitt.aktiv"
        class="gefahr"
        :disabled="mitschnittBeschaeftigt"
        @click="mitschnittLeeren()"
      >Mitschnitt löschen</button>
    </p>

    <p class="gedimmt" v-if="mitschnitt.aktiv">
      <strong>Läuft.</strong> {{ mitschnitt.geschrieben }} Zeilen,
      {{ groesse(mitschnitt.bytes) }}. Der Analyzer arbeitet dabei ganz normal
      weiter. Für eine Grundlinie genügt eine Stunde — dauerhaft braucht sie
      niemand, sie kostet nur Schreibvorgänge auf dem Bootmedium.
      <span v-if="mitschnitt.verworfen > 0">
        <br /><strong>{{ mitschnitt.verworfen }} Zeilen verworfen</strong> — die
        Platte kam nicht mit. Die Lücke ist ausgewiesen, nicht verschwiegen.
      </span>
      <span v-if="mitschnitt.fehler > 0">
        <br /><strong>{{ mitschnitt.fehler }} Schreibfehler.</strong>
      </span>
    </p>

    <p class="gedimmt" v-else-if="mitschnitt.vorhanden">
      Aufzeichnung beendet. Vorhandene Datei: {{ groesse(mitschnitt.bytes) }}.
      Ein erneuter Start hängt hinten an, statt sie zu überschreiben.
    </p>

    <p class="gedimmt" v-if="mitschnitt.vorhanden">
      Ablage auf dem Gerät: <code>{{ mitschnitt.pfad }}</code><br />
      Auswerten auf dem Pi:
      <code>node core/bin/mitschnitt.ts auswerten {{ mitschnitt.pfad }}</code>
    </p>
  </div>

  <HandbuchFuss hinweis="Kapitel 22 erklärt das Protokoll, Kapitel 11.4 den Mitschnitt." />
</template>
