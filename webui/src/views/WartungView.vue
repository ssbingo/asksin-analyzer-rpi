<script setup lang="ts">
import { computed, onUnmounted, reactive, ref } from 'vue';

import HandbuchFuss from '../components/HandbuchFuss.vue';
import Schiebeschalter from '../components/Schiebeschalter.vue';

import {
  holeSystemupdate,
  starteSystemupdate,
  starteNeustart,
  sendeZeitplan,
  holeMitschnitt,
  holeProtokoll,
  mitschnittDateiUrl,
  protokollDateiUrl,
  sendeMitschnitt,
  sendeProtokoll,
} from '../api.ts';
import type {
  SystemupdateZustand,
  Zeitplan,
  MitschnittZustand,
  ProtokollStufe,
  ProtokollZustand,
} from '../api.ts';
import { nutzeTakt } from '../takt.ts';
import { datumZeit } from '../format.ts';

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

// --- Systemaktualisierung (M17) -------------------------------------------
//
// Der Analyzer laeuft dauerhaft, haengt am Netz und traegt einen Webserver.
// Ein Geraet mit diesen drei Eigenschaften braucht seine
// Sicherheitsaktualisierungen — und den Weg dorthin ueber die Konsole soll
// niemand gehen muessen.

const sysupd = ref<SystemupdateZustand | null>(null);
const sysupdBeschaeftigt = ref(false);
/** Schneller Takt, solange etwas laeuft — der 15-Sekunden-Takt waere zaeh. */
let sysupdTakt: ReturnType<typeof setInterval> | null = null;

const SCHRITTE: Record<string, string> = {
  start: 'wird gestartet …',
  paketlisten: 'Paketlisten werden geholt …',
  aufruesten: 'Pakete werden aufgerüstet — das kann dauern …',
  aufraeumen: 'Alte Pakete werden aufgeräumt …',
  fertig: 'fertig',
  abgebrochen: 'abgebrochen',
};

async function sysupdLaden(): Promise<void> {
  try {
    const z = await holeSystemupdate();
    sysupd.value = z;
    planUebernehmen(z);
    // Waehrend eines Laufs haeufiger nachfragen. Ohne das stuende die
    // Fortschrittsanzeige bis zu 15 Sekunden still, und der Anwender haelt
    // einen laufenden Vorgang fuer haengengeblieben.
    if (z.laeuft && sysupdTakt === null) {
      sysupdTakt = setInterval(() => void sysupdLaden(), 2000);
    } else if (!z.laeuft && sysupdTakt !== null) {
      clearInterval(sysupdTakt);
      sysupdTakt = null;
    }
  } catch {
    /* aeltere Core-Fassung — der Abschnitt bleibt dann ausgeblendet */
  }
}

onUnmounted(() => {
  if (sysupdTakt !== null) clearInterval(sysupdTakt);
});

async function sysupdStarten(): Promise<void> {
  sysupdBeschaeftigt.value = true;
  meldung.value = null;
  try {
    await starteSystemupdate();
    meldung.value = {
      art: 'ok',
      text: 'Aktualisierung läuft. Sie können die Seite verlassen — '
        + 'der Vorgang läuft auf dem Gerät weiter.',
    };
    await sysupdLaden();
  } catch (err) {
    meldung.value = { art: 'fehler', text: err instanceof Error ? err.message : String(err) };
  } finally {
    sysupdBeschaeftigt.value = false;
  }
}

async function sysupdNeustart(): Promise<void> {
  if (
    !window.confirm(
      'Den Rechner jetzt neu starten?\n\n'
        + 'Der Analyzer ist für etwa eine Minute nicht erreichbar und '
        + 'zeichnet in dieser Zeit keine Telegramme auf.',
    )
  ) {
    return;
  }
  sysupdBeschaeftigt.value = true;
  try {
    await starteNeustart();
    meldung.value = { art: 'ok', text: 'Neustart angefordert — bis gleich.' };
  } catch (err) {
    meldung.value = { art: 'fehler', text: err instanceof Error ? err.message : String(err) };
  } finally {
    sysupdBeschaeftigt.value = false;
  }
}

// --- Zeitplan (M17.1) ------------------------------------------------------

/** Der Stand in der Maske; wird beim Laden aus dem Gerät gefüllt. */
const plan = reactive<Zeitplan>({
  aktiv: false,
  rhythmus: 'woechentlich',
  wochentag: 6,
  monatstag: 1,
  stunde: 3,
  minute: 0,
  neustarten: false,
  melden: false,
});
/** Nicht überschreiben, während jemand daran arbeitet. */
const planBearbeitet = ref(false);
const planGespeichert = ref(false);

const MELDEWEG: Record<string, string> = {
  iobroker: 'ioBroker-Adapter',
  email: 'E-Mail',
  telegram: 'Telegram',
};

const WOCHENTAGE = [
  { wert: 1, text: 'Montag' }, { wert: 2, text: 'Dienstag' },
  { wert: 3, text: 'Mittwoch' }, { wert: 4, text: 'Donnerstag' },
  { wert: 5, text: 'Freitag' }, { wert: 6, text: 'Samstag' },
  { wert: 7, text: 'Sonntag' },
];

/** Uhrzeit als „03:00" für das <input type="time"> und zurück. */
const uhrzeit = computed({
  get: () =>
    `${String(plan.stunde).padStart(2, '0')}:${String(plan.minute).padStart(2, '0')}`,
  set: (wert: string) => {
    const [h, m] = wert.split(':');
    plan.stunde = Number(h ?? 3);
    plan.minute = Number(m ?? 0);
    planBearbeitet.value = true;
  },
});

/**
 * In welchen Monaten der gewählte Tag fehlt.
 *
 * Gerechnet auch hier, nicht nur im Core: Der Hinweis soll beim Tippen
 * erscheinen und nicht erst nach dem Speichern — sonst erführe man vom
 * Ausfall genau dann, wenn er schon eingestellt ist.
 */
const ausfall = computed<string[]>(() => {
  if (plan.rhythmus !== 'monatlich' || plan.monatstag <= 28) return [];
  if (plan.monatstag === 29) return ['Februar (außer in Schaltjahren)'];
  if (plan.monatstag === 30) return ['Februar'];
  return ['Februar', 'April', 'Juni', 'September', 'November'];
});

/** Der Plan in einem Satz — dieselbe Formulierung wie im Core. */
const planText = computed(() => {
  const u = uhrzeit.value;
  if (plan.rhythmus === 'taeglich') return `Läuft täglich um ${u} Uhr`;
  if (plan.rhythmus === 'woechentlich') {
    const tag = WOCHENTAGE.find((w) => w.wert === plan.wochentag)?.text ?? '';
    return `Läuft jeden ${tag} um ${u} Uhr`;
  }
  return `Läuft am ${plan.monatstag}. jedes Monats um ${u} Uhr`;
});

function planUebernehmen(z: SystemupdateZustand): void {
  if (planBearbeitet.value) return;
  Object.assign(plan, z.plan);
}

async function planSpeichern(): Promise<void> {
  sysupdBeschaeftigt.value = true;
  meldung.value = null;
  try {
    await sendeZeitplan({ ...plan });
    planBearbeitet.value = false;
    planGespeichert.value = true;
    meldung.value = {
      art: 'ok',
      text: plan.aktiv
        ? 'Zeitplan gespeichert und an systemd übergeben.'
        : 'Zeitplan abgeschaltet.',
    };
    await sysupdLaden();
  } catch (err) {
    meldung.value = { art: 'fehler', text: err instanceof Error ? err.message : String(err) };
  } finally {
    sysupdBeschaeftigt.value = false;
  }
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
  await sysupdLaden();
}, 15_000);
</script>

<template>
  <h2>Wartung</h2>

  <div
    class="meldung"
    v-if="meldung !== null"
    :class="meldung.art"
  >{{ meldung.text }}</div>

  <!-- Zuoberst, noch vor dem Protokoll: Das ist die Sache, die man in dieser
       Ansicht regelmäßig tun soll — alles andere sieht man sich nur an, wenn
       etwas nicht stimmt. -->
  <div class="panel" v-if="sysupd !== null">
    <h3>Systemaktualisierung</h3>
    <p class="gedimmt">
      Holt die Paketlisten und spielt alle verfügbaren Aktualisierungen des
      Betriebssystems ein — <code>apt-get update</code> und
      <code>apt-get full-upgrade</code>, ohne Rückfragen und ohne Konsole.
      Geänderte Konfigurationsdateien bleiben dabei unangetastet. Der Analyzer
      zeichnet währenddessen weiter auf.
    </p>

    <!-- Der Befund steht ganz oben und ist farbig, wenn es Zeit wird. Er ist
         der Grund, warum jemand diese Ansicht überhaupt öffnet. -->
    <div
      class="meldung"
      :class="sysupd.befund.stufe === 'frisch' ? 'ok' : 'warnung'"
    >
      <strong>{{ sysupd.befund.text }}</strong>
      <template v-if="sysupd.letzterErfolg !== null">
        <br />
        Zuletzt erfolgreich: {{ datumZeit(sysupd.letzterErfolg.zeit) }}<template
          v-if="sysupd.letzterErfolg.pakete !== null"
        >, {{ sysupd.letzterErfolg.pakete }}
          {{ sysupd.letzterErfolg.pakete === 1 ? 'Paket' : 'Pakete' }}
          aufgerüstet</template>.
      </template>
      <template v-else-if="sysupd.befund.stufe === 'nie'">
        <br />
        Das ist bei einem neu aufgesetzten Gerät normal — einmal auf
        <em>Jetzt aktualisieren</em>, dann steht hier ein Datum.
      </template>
    </div>

    <div class="zeile" style="margin-bottom: 0.6rem; align-items: center">
      <button
        class="primaer"
        :disabled="sysupdBeschaeftigt || sysupd.laeuft"
        @click="sysupdStarten"
      >
        Jetzt aktualisieren
      </button>
      <span class="chip" v-if="sysupd.laeuft">
        {{ SCHRITTE[sysupd.status?.schritt ?? ''] ?? 'läuft …' }}
      </span>
      <span
        class="chip"
        v-else-if="sysupd.status?.ok === true"
      >abgeschlossen</span>
    </div>

    <!-- Was gerade passiert, wörtlich. „Es läuft" allein hält niemand zehn
         Minuten lang aus — und im Fehlerfall ist apts eigene Meldung die
         eigentliche Auskunft, nicht unsere Deutung davon. -->
    <div v-if="sysupd.ausgabe !== ''" class="scrollbar" style="margin-bottom: 0.6rem">
      <pre class="apt-ausgabe">{{ sysupd.ausgabe }}</pre>
    </div>

    <div class="meldung fehler" v-if="sysupd.status?.ok === false">
      <strong>Die Aktualisierung ist fehlgeschlagen.</strong>
      {{ sysupd.status.fehler }}
    </div>

    <div class="meldung warnung" v-if="sysupd.neustartNoetig">
      <strong>Das System verlangt einen Neustart.</strong>
      Meist wurde ein neuer Kernel eingespielt — er wird erst nach dem Neustart
      benutzt. Bis dahin läuft alles normal weiter.
      <div style="margin-top: 0.5rem">
        <button :disabled="sysupdBeschaeftigt" @click="sysupdNeustart">
          Rechner jetzt neu starten
        </button>
      </div>
    </div>

    <!-- Zeitplan. Steht unter dem Knopf, weil man ihn einmal einstellt und
         danach nie wieder ansieht — der Knopf dagegen wird benutzt. -->
    <fieldset class="schalterfeld" style="margin-bottom: 0.9rem">
      <legend>Automatisch aktualisieren</legend>
      <Schiebeschalter
        v-model="plan.aktiv"
        name="Nach Zeitplan aktualisieren"
        zweck="Ein systemd-Timer stößt die Aktualisierung selbsttätig an — auch
               dann, wenn niemand die Weboberfläche öffnet."
        :gesperrt="sysupdBeschaeftigt"
        @update:model-value="planBearbeitet = true"
      />

      <template v-if="plan.aktiv">
        <div class="zeile" style="margin: 0.7rem 0 0; flex-wrap: wrap; align-items: flex-end">
          <label class="feld" style="width: 11rem">
            <span class="name">Rhythmus</span>
            <select v-model="plan.rhythmus" @change="planBearbeitet = true">
              <option value="taeglich">täglich</option>
              <option value="woechentlich">wöchentlich</option>
              <option value="monatlich">monatlich</option>
            </select>
          </label>

          <label class="feld" style="width: 11rem" v-if="plan.rhythmus === 'woechentlich'">
            <span class="name">Wochentag</span>
            <select v-model.number="plan.wochentag" @change="planBearbeitet = true">
              <option v-for="w in WOCHENTAGE" :key="w.wert" :value="w.wert">
                {{ w.text }}
              </option>
            </select>
          </label>

          <label class="feld" style="width: 8rem" v-if="plan.rhythmus === 'monatlich'">
            <span class="name">Tag im Monat</span>
            <select v-model.number="plan.monatstag" @change="planBearbeitet = true">
              <option v-for="n in 31" :key="n" :value="n">{{ n }}.</option>
            </select>
          </label>

          <label class="feld" style="width: 8rem">
            <span class="name">Uhrzeit</span>
            <input type="time" v-model="uhrzeit" />
          </label>
        </div>

        <!-- Der wichtigste Zusatz: was eingestellt ist, in einem Satz, plus
             der nächste Termin. Ohne ihn bleibt bei „monatlich, 31." genau
             die Unsicherheit, die der Hinweis darunter benennt. -->
        <div class="meldung neutral" style="margin: 0.7rem 0 0">
          <strong>{{ planText }}</strong>
          <template v-if="sysupd.streuungMinuten > 0">
            (± bis zu {{ sysupd.streuungMinuten }} Minuten)</template>.
          <template v-if="sysupd.naechsterLauf !== null && !planBearbeitet">
            <br />
            Nächster Lauf: {{ datumZeit(sysupd.naechsterLauf) }}
            <template v-if="sysupd.timerAktiv">— von systemd bestätigt.</template>
            <template v-else>
              <br />
              <span style="color: var(--warn)">Der Timer ist bei systemd noch
              nicht aktiv. Einmal speichern.</span>
            </template>
          </template>
          <template v-else-if="planBearbeitet">
            <br />Noch nicht gespeichert.
          </template>
        </div>

        <!-- Die Ausfallmonate: Der 31. läuft nachweislich nur in 7 von 12
             Monaten, und systemd meldet das nicht. Die Wahl bleibt frei, aber
             sie wird benannt. -->
        <div class="meldung warnung" v-if="ausfall.length > 0" style="margin: 0.5rem 0 0">
          <strong>Den {{ plan.monatstag }}. gibt es nicht in jedem Monat.</strong>
          Der Lauf fällt aus in: {{ ausfall.join(', ') }} — ersatzlos, ohne
          Meldung. Bei 28 oder weniger passiert das nie.
        </div>

        <div style="margin-top: 0.7rem">
          <Schiebeschalter
            v-model="plan.neustarten"
            name="Danach neu starten, falls nötig"
            zweck="Nur bei geplanten Läufen und nur, wenn ein Kernel-Update es
                   verlangt. Ein Klick auf „Jetzt aktualisieren“ startet nie von
                   selbst neu — wer davorsitzt, soll nicht überrascht werden."
            :gesperrt="sysupdBeschaeftigt"
            @update:model-value="planBearbeitet = true"
          />
        </div>
      </template>

      <!-- Steht ausserhalb von v-if="plan.aktiv": Eine Aktualisierung von
           Hand soll sich genauso melden koennen, und ein Fehlschlag ist dort
           genauso wichtig. -->
      <div style="margin-top: 0.7rem">
        <Schiebeschalter
          v-model="plan.melden"
          name="Nach der Aktualisierung benachrichtigen"
          zweck="Schickt eine Nachricht, sobald ein Lauf beendet ist —
                 mit Anzahl der Pakete, Dauer und ob ein Neustart nötig ist.
                 Ein Fehlschlag wird ebenso gemeldet."
          :gesperrt="sysupdBeschaeftigt || sysupd.meldeziel?.aktiv !== true"
          @update:model-value="planBearbeitet = true"
        />
        <p class="fussnote" v-if="sysupd.meldeziel?.aktiv !== true" style="margin: 0.3rem 0 0">
          Dafür muss unter <em>Einstellungen → Alarme: wohin melden?</em> ein
          Ziel eingerichtet und eingeschaltet sein — ioBroker-Adapter, E-Mail
          oder Telegram. Ohne Ziel gäbe es keinen Weg für die Nachricht,
          deshalb ist der Schalter ausgegraut.
        </p>
        <p class="fussnote" v-else style="margin: 0.3rem 0 0">
          Geht über den eingerichteten Weg:
          <strong>{{ MELDEWEG[sysupd.meldeziel.kanal] ?? sysupd.meldeziel.kanal }}</strong>.
          Beim ioBroker-Adapter kommt die Meldung im Kanal <code>alarm</code>
          an und wird von dort wie ein Alarm weitergereicht.
        </p>
      </div>

      <div style="margin-top: 0.8rem">
        <button
          class="primaer"
          :disabled="sysupdBeschaeftigt || !planBearbeitet"
          @click="planSpeichern"
        >
          Zeitplan speichern
        </button>
        <span class="chip" v-if="!planBearbeitet && planGespeichert" style="margin-left: 0.6rem">
          gespeichert
        </span>
      </div>
    </fieldset>

    <p class="fussnote">
      Der Hinweis wird farbig, sobald die letzte Aktualisierung
      {{ sysupd.warnungAbTagen }} Tage her ist. Ausgeführt wird sie von einem
      eng begrenzten Hilfsdienst mit Wurzelrechten; der Analyzer selbst legt
      nur den Auftrag ab. Die vollständige Ausgabe steht auf dem Gerät in
      <code>/var/lib/asksin-analyzer/systemupdate.log</code>.
    </p>
  </div>

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

    <p v-if="mitschnitt.vorhanden">
      <a class="knopf" :href="mitschnittDateiUrl()" download="mitschnitt.txt">
        Aufzeichnung herunterladen
      </a>
    </p>

    <p class="gedimmt" v-if="mitschnitt.vorhanden">
      Die Datei liegt auf dem Gerät unter <code>{{ mitschnitt.pfad }}</code>.
      Ausgewertet wird sie am PC:<br />
      <code>node core/bin/mitschnitt.ts auswerten mitschnitt.txt</code><br />
      Zwei Aufzeichnungen vergleichen:<br />
      <code>node core/bin/mitschnitt.ts vergleichen vorher.txt nachher.txt</code>
    </p>
  </div>

  <HandbuchFuss hinweis="Kapitel 22 erklärt das Protokoll, Kapitel 11.4 den Mitschnitt." />
</template>
