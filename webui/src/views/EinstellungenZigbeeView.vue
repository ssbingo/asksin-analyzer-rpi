<script setup lang="ts">
import { ref } from 'vue';
import {
  holeZigbee, holeZigbeeFirmware, setzeZigbee,
  zigbeeFirmwareAufspielen, zigbeeSchluesselAnfordern,
} from '../api.ts';
import type { ZigbeeFirmwareStand, ZigbeeZustand } from '../api.ts';
import HandbuchFuss from '../components/HandbuchFuss.vue';

const zustand = ref<ZigbeeZustand | null>(null);
const firmware = ref<ZigbeeFirmwareStand | null>(null);
const nichtVorhanden = ref(false);
const deconzHost = ref('');
const beschaeftigt = ref(false);
const meldung = ref<{ art: 'ok' | 'fehler'; text: string } | null>(null);

async function laden(): Promise<void> {
  try {
    zustand.value = await holeZigbee();
    if (deconzHost.value === '') deconzHost.value = zustand.value.namen?.host ?? '';
    nichtVorhanden.value = false;
    firmware.value = await holeZigbeeFirmware();
  } catch (err) {
    if (err instanceof Error && err.message.includes('501')) nichtVorhanden.value = true;
  }
}
void laden();

/**
 * Ein Vorgang, eine Meldung — und beide an derselben Stelle.
 *
 * Die Einstellungsseite hat ihre Sammelmeldung ganz oben. Bei einem Knopf am
 * Seitenende sieht man sie nie und hält das Ergebnis für „es passiert nichts".
 * Genau das ist am 18.08.2026 passiert, während im Protokoll des Geräts
 * viermal ein erfolgreicher Vorgang stand.
 */
async function tun(fn: () => Promise<string>): Promise<void> {
  beschaeftigt.value = true;
  meldung.value = null;
  try {
    meldung.value = { art: 'ok', text: await fn() };
  } catch (err) {
    meldung.value = {
      art: 'fehler', text: err instanceof Error ? err.message : String(err),
    };
  } finally {
    beschaeftigt.value = false;
  }
  await laden();
}

const umschalten = (): Promise<void> => tun(async () => {
  const ziel = !(zustand.value?.aktiv ?? false);
  const a = await setzeZigbee({ aktiv: ziel });
  return a.neustartNoetig
    ? `Zigbee ${ziel ? 'eingeschaltet' : 'ausgeschaltet'} — wirkt nach dem Neustart des Dienstes.`
    : `Zigbee ${ziel ? 'eingeschaltet' : 'ausgeschaltet'}.`;
});

const kanalSetzen = (kanal: number): Promise<void> => tun(async () => {
  const a = await setzeZigbee({ kanal });
  return `Kanal ${a.kanal} eingestellt — sofort wirksam.`;
});

const schluesselHolen = (): Promise<void> => tun(async () => {
  const r = await zigbeeSchluesselAnfordern(deconzHost.value);
  if (!r.ok) throw new Error(r.meldung);
  return r.meldung;
});

const rechnerSpeichern = (): Promise<void> => tun(async () => {
  await setzeZigbee({ deconzHost: deconzHost.value });
  return 'Rechner gespeichert.';
});

/**
 * Aufspielen anstoßen — mit ausdrücklicher Rückfrage.
 *
 * Die einzige Stelle in dieser Oberfläche, die etwas unumkehrbar macht. Wer
 * hier danebengreift, legt sein Zigbee-Netz still; eine Rückfrage ist dafür
 * kein Misstrauen, sondern angemessen.
 */
async function firmwareAufspielen(): Promise<void> {
  const ok = window.confirm(
    'Die Sniffer-Firmware wird auf den Stick geschrieben.\n\n'
    + 'Danach ist er KEIN Zigbee-Koordinator mehr. Ist das der zusätzliche '
    + 'Stick — und nicht der, an dem dein Zigbee-Netz hängt?\n\n'
    + 'Der Analyzer-Dienst startet dabei einmal neu.',
  );
  if (!ok) return;
  await tun(async () => {
    const a = await zigbeeFirmwareAufspielen();
    return a.meldung;
  });
  await laden();
}
</script>

<template>
  <h2>Einstellungen · Zigbee</h2>

  <div class="panel" v-if="nichtVorhanden">
    <p style="margin: 0">
      Dieser Analyzer kennt keinen Zigbee-Mithörer. Nach einem Update auf einen
      aktuellen Stand erscheint hier die Einrichtung.
    </p>
  </div>

  <template v-else-if="zustand">
    <div class="meldung" v-if="meldung" :class="meldung.art">{{ meldung.text }}</div>

    <div class="panel">
      <h3 style="margin-top: 0">Mithörer</h3>
      <p style="margin-top: 0">
        Ein zweites Ohr auf 2,4 GHz — es braucht einen eigenen USB-Stick mit
        Sniffer-Firmware. Der Analyzer tritt dem Zigbee-Netz nicht bei, er hört
        nur zu; die Inhalte bleiben verschlüsselt.
      </p>
      <table class="daten" style="max-width: 32rem">
        <tbody>
          <tr><th>Zustand</th><td>
            <strong :class="zustand.aktiv ? 'mittel' : 'gedimmt'">
              {{ zustand.aktiv ? 'eingeschaltet' : 'aus' }}</strong>
            <template v-if="zustand.aktiv">
              —
              <strong :class="zustand.verbunden ? 'ok' : 'fehler'">
                {{ zustand.verbunden ? 'Stick antwortet' : 'Stick antwortet nicht' }}</strong>
            </template>
          </td></tr>
          <tr><th>Gerät</th><td><code>{{ zustand.device }}</code></td></tr>
          <tr><th>Kanal</th><td>
            {{ zustand.kanal }}
            <button class="klein" :disabled="beschaeftigt || zustand.kanal <= 11"
                    @click="kanalSetzen(zustand.kanal - 1)">−</button>
            <button class="klein" :disabled="beschaeftigt || zustand.kanal >= 26"
                    @click="kanalSetzen(zustand.kanal + 1)">+</button>
            <span class="gedimmt">Zigbee benutzt 11 bis 26; ein Wechsel wirkt sofort.</span>
          </td></tr>
        </tbody>
      </table>
      <div class="zeile">
        <button :disabled="beschaeftigt" @click="umschalten">
          {{ zustand.aktiv ? 'Zigbee ausschalten …' : 'Zigbee einschalten …' }}
        </button>
      </div>
      <div class="fussnote">
        Das Ein- und Ausschalten wirkt nach einem Neustart des Dienstes.
      </div>
    </div>

    <div class="panel">
      <h3 style="margin-top: 0">Firmware auf dem Stick</h3>
      <p style="margin-top: 0">
        Ein fabrikneuer SONOFF-Stick ist ein <em>Koordinator</em> und schweigt,
        wenn man ihn mithören lässt. Erst die Sniffer-Firmware macht aus ihm
        ein Ohr. Der Analyzer kann sie selbst aufspielen — kein Browser, keine
        Konsole, kein zweiter Rechner.
      </p>

      <div class="meldung fehler" v-if="firmware && firmware.sticks > 1">
        Es stecken <strong>{{ firmware.sticks }}</strong> SONOFF-Sticks an diesem
        Analyzer. Welcher der Mithörer werden soll, lässt sich von hier aus nicht
        entscheiden — bitte den anderen abziehen. Der Vorgang bleibt so lange
        gesperrt: Ein umgespielter Koordinator legt das ganze Zigbee-Netz still.
      </div>

      <table class="daten" style="max-width: 32rem" v-if="firmware">
        <tbody>
          <tr><th>SONOFF-Stick</th><td>
            <strong v-if="firmware.sticks === 0" class="fehler">steckt keiner</strong>
            <strong v-else-if="firmware.sticks === 1" class="ok">einer, erkannt</strong>
            <strong v-else class="fehler">{{ firmware.sticks }} Stück</strong>
          </td></tr>
          <tr v-if="firmware.geraet"><th>Name</th>
            <td><code style="font-size: .82em">{{ firmware.geraet }}</code></td></tr>
          <tr><th>Hört mit</th><td>
            <strong :class="firmware.hoert ? 'ok' : 'gedimmt'">
              {{ firmware.hoert ? 'ja — es kommen Zeilen' : 'noch nicht nachgewiesen' }}</strong>
          </td></tr>
          <tr v-if="firmware.letzterLauf"><th>Zuletzt</th><td>
            <strong :class="firmware.letzterLauf.ok === false ? 'fehler' : 'ok'">
              {{ firmware.letzterLauf.text }}</strong>
          </td></tr>
        </tbody>
      </table>

      <div class="zeile">
        <button :disabled="beschaeftigt || !firmware || firmware.sticks !== 1 || firmware.laeuft"
                @click="firmwareAufspielen">
          Sniffer-Firmware aufspielen …
        </button>
      </div>
      <div class="fussnote">
        <strong>Das ist der eine unumkehrbare Schritt.</strong> Danach ist der
        Stick kein Zigbee-Koordinator mehr. Nimm einen zusätzlichen Stick,
        niemals den, an dem dein Zigbee-Netz hängt. Der Vorgang dauert wenige
        Minuten, lädt die Firmware beim Urheber und startet den Analyzer-Dienst
        dabei einmal neu — die Seite verliert dann kurz die Verbindung.
        Steckt bereits die richtige Firmware, passiert nichts.
      </div>
    </div>

    <div class="panel">
      <h3 style="margin-top: 0">Gerätenamen aus deCONZ</h3>
      <p style="margin-top: 0">
        Der Mithörer sieht nur Kurzadressen wie <code>0x837E</code>. deCONZ kennt
        die Namen — die Verbindung entsteht über die IEEE-Adresse, die der
        Analyzer aus den Funkpaketen selbst lernt. Ohne diese Angaben bleibt
        alles anonym, aber messbar.
      </p>
      <p v-if="zustand.namen" class="fussnote" style="margin-top: 0">
        Zustand:
        <strong v-if="!zustand.namen.aktiv" class="gedimmt">nicht eingerichtet</strong>
        <template v-else>
          <strong>{{ zustand.namen.anzahl }} Namen</strong> von
          {{ zustand.namen.host }}
          <span v-if="zustand.namen.quelle === 'cache'" class="mittel">
            — aus dem Zwischenspeicher, deCONZ ist gerade nicht erreichbar</span>
        </template>
        <span v-if="zustand.namen.fehler" class="fehler">
          ({{ zustand.namen.fehler }})</span>
      </p>

      <label class="feld">
        <span class="name">deCONZ-Rechner (IP oder Hostname, bei Bedarf mit :Port)</span>
        <input type="text" v-model="deconzHost" placeholder="z. B. 192.168.1.60" />
      </label>

      <p class="fussnote" style="margin-top: .6rem">
        <strong>Den Schlüssel holt sich der Analyzer selbst.</strong> deCONZ zeigt
        bestehende Schlüssel nie an — es vergibt nur neue, und nur während des
        Anmeldefensters. Also:
      </p>
      <ol class="fussnote" style="margin: 0 0 .6rem 1.2rem">
        <li>In Phoscon: <em>Einstellungen → Gateway → Erweitert →
          „App verbinden“</em></li>
        <li>Innerhalb einer Minute hier auf <em>Schlüssel anfordern</em> klicken</li>
      </ol>
      <div class="zeile">
        <button class="primaer" :disabled="beschaeftigt" @click="schluesselHolen">
          Schlüssel anfordern
        </button>
        <button :disabled="beschaeftigt" @click="rechnerSpeichern">
          Nur Rechner speichern
        </button>
      </div>
      <div class="fussnote" v-if="zustand.namen?.aktiv">
        Ein Schlüssel ist hinterlegt. Ein neuer ersetzt ihn und widerruft den
        alten bei deCONZ.
      </div>
    </div>
  </template>

  <!-- haupt="zigbee": Wer hier steht, sucht das Zigbee-Buch. Bis zum
       18.08.2026 stand hier der Hinweis auf das Zigbee-Handbuch — der
       Verweis darunter öffnete aber das grosse. -->
  <HandbuchFuss
    haupt="zigbee"
    hinweis="Kapitel 6 erklärt das Aufspielen der Firmware, Kapitel 8 die Zahlen, Kapitel 14 diese Seite."
  />
</template>

<style scoped>
.klein { padding: 0 .5rem; margin-left: .3rem; }
</style>
