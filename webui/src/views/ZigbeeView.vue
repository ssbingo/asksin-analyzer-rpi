<script setup lang="ts">
import { computed, ref } from 'vue';
import {
  holeZigbee,
  holeZigbeeGeraete,
  holeZigbeePakete,
  setzeZigbee,
} from '../api.ts';
import type { ZigbeeGeraet, ZigbeePaket, ZigbeeZustand } from '../api.ts';
import { dbm, uhrzeit, vorZeit } from '../format.ts';
import { nutzeTakt } from '../takt.ts';

const zustand = ref<ZigbeeZustand | null>(null);
const geraete = ref<ZigbeeGeraet[]>([]);
const pakete = ref<ZigbeePaket[]>([]);
const gekuerzt = ref(false);
const stunden = ref(24);
const nichtVorhanden = ref(false);
const meldung = ref('');
const jetzt = ref(Date.now());

/** Rahmenarten, wie sie im FCF stehen. */
const ART = ['Beacon', 'Daten', 'Bestätigung', 'Kommando'];

nutzeTakt(async () => {
  try {
    zustand.value = await holeZigbee();
    nichtVorhanden.value = false;
  } catch (err) {
    if (err instanceof Error && err.message.includes('501')) {
      nichtVorhanden.value = true;
      return;
    }
    throw err;
  }
  const [g, p] = await Promise.all([
    holeZigbeeGeraete(stunden.value),
    holeZigbeePakete(10, 300),
  ]);
  geraete.value = g.geraete;
  pakete.value = p.pakete;
  gekuerzt.value = p.gekuerzt;
  jetzt.value = Date.now();
// 3 s: Die Paketliste soll sich lebendig anfuehlen, ohne dass ein Tablet
// dabei ins Schwitzen kommt. Der BidCoS-Kopf taktet mit 5 s.
}, 3000);

/**
 * Bewertet wird der Mittelwert, nicht der schwächste je empfangene Wert.
 *
 * Wer eine Stunde misst, sieht bei jedem Gerät irgendwann einen Ausreißer —
 * ein Gerät mit 1300 Paketen und LQI 252 als „grenzwertig" auszuweisen, nur
 * weil ein einziges Paket schwach ankam, wäre eine Eigenschaft der Messdauer
 * und keine Aussage über das Gerät.
 */
function mittel(summe: number, anzahl: number): number {
  return anzahl > 0 ? Math.round(summe / anzahl) : 0;
}

function bewertung(g: ZigbeeGeraet): { text: string; klasse: string } {
  const rssi = mittel(g.sum_rssi, g.pakete);
  const lqi = mittel(g.sum_lqi, g.pakete);
  if (lqi < 50 || rssi < -88) return { text: 'grenzwertig', klasse: 'schlecht' };
  if (lqi < 200 || rssi < -80) return { text: 'knapp', klasse: 'mittel' };
  return { text: 'gut', klasse: 'gut' };
}

const eigenesNetz = computed<number | null>(() => {
  // Das Netz mit den meisten Paketen ist das eigene — der Mithörer steht
  // mitten darin, Nachbarnetze kommen nur von weit her herein.
  const summen = new Map<number, number>();
  for (const g of geraete.value) summen.set(g.pan, (summen.get(g.pan) ?? 0) + g.pakete);
  let beste: number | null = null;
  let max = -1;
  for (const [pan, n] of summen) if (n > max) { max = n; beste = pan; }
  return beste;
});

const eigene = computed(() => geraete.value.filter((g) => g.pan === eigenesNetz.value));
const fremde = computed(() => geraete.value.filter((g) => g.pan !== eigenesNetz.value));
const grenzwertig = computed(() =>
  eigene.value.filter((g) => bewertung(g).klasse === 'schlecht').length);

async function kanalSetzen(neu: number): Promise<void> {
  meldung.value = '';
  try {
    const a = await setzeZigbee({ kanal: neu });
    meldung.value = `Kanal ${a.kanal} eingestellt.`;
  } catch (err) {
    meldung.value = err instanceof Error ? err.message : String(err);
  }
}

async function umschalten(): Promise<void> {
  meldung.value = '';
  try {
    const a = await setzeZigbee({ aktiv: !(zustand.value?.aktiv ?? false) });
    meldung.value = a.neustartNoetig
      ? `Zigbee ${a.aktiv ? 'eingeschaltet' : 'ausgeschaltet'} — wirkt nach dem Neustart des Dienstes.`
      : `Zigbee ${a.aktiv ? 'eingeschaltet' : 'ausgeschaltet'}.`;
  } catch (err) {
    meldung.value = err instanceof Error ? err.message : String(err);
  }
}

function hex(n: number | null): string {
  return n === null ? '—' : `0x${n.toString(16).toUpperCase().padStart(4, '0')}`;
}
</script>

<template>
  <section v-if="nichtVorhanden" class="karte">
    <h2>Zigbee</h2>
    <p>
      Dieser Analyzer hat keinen Zigbee-Mithörer. Er braucht einen eigenen
      USB-Stick; die Einrichtung steht im Handbuch.
    </p>
  </section>

  <template v-else-if="zustand">
    <section class="karte">
      <h2>Zigbee-Mithörer</h2>

      <p v-if="!zustand.aktiv" class="hinweis">
        Ausgeschaltet. Solange er aus ist, wird nichts aufgezeichnet.
      </p>
      <p v-else-if="!zustand.verbunden" class="hinweis warnung">
        Eingeschaltet, aber der Stick antwortet nicht.
        Erwartet wird er unter <code>{{ zustand.device }}</code> —
        steckt er, und heißt er dort auch so?
      </p>

      <table class="daten" style="max-width: 34rem">
        <tbody>
          <tr><th>Zustand</th><td>
            <span :class="zustand.verbunden ? 'gut' : 'schlecht'">
              {{ zustand.verbunden ? 'hört' : 'still' }}</span>
            <span v-if="zustand.verbundenSeit" class="leise">
              seit {{ uhrzeit(zustand.verbundenSeit) }}</span>
          </td></tr>
          <tr><th>Kanal</th><td>
            {{ zustand.kanal }}
            <button v-if="zustand.kanal > 11" class="klein"
                    @click="kanalSetzen(zustand.kanal - 1)">−</button>
            <button v-if="zustand.kanal < 26" class="klein"
                    @click="kanalSetzen(zustand.kanal + 1)">+</button>
          </td></tr>
          <tr><th>Pakete gelesen</th><td>{{ zustand.pakete.toLocaleString('de') }}</td></tr>
          <tr><th>davon gespeichert</th><td>
            {{ zustand.gespeichert.toLocaleString('de') }}
            <span class="leise">
              — {{ zustand.bestaetigungen.toLocaleString('de') }} Bestätigungen
              gezählt statt gespeichert (sie tragen keine Adressen)
            </span>
          </td></tr>
          <tr v-if="zustand.ueberlauf > 0"><th>verloren</th><td class="schlecht">
            {{ zustand.ueberlauf.toLocaleString('de') }} durch Überlauf
          </td></tr>
          <tr v-if="zustand.neuverbindungen > 0"><th>Neuverbindungen</th>
            <td>{{ zustand.neuverbindungen }}</td></tr>
          <tr v-if="zustand.schreibfehler > 0"><th>Schreibfehler</th>
            <td class="schlecht">{{ zustand.schreibfehler }}</td></tr>
          <tr><th>letzte Zeile</th><td>
            {{ zustand.letzteZeileAm ? vorZeit(zustand.letzteZeileAm, jetzt) : '—' }}
          </td></tr>
        </tbody>
      </table>

      <p>
        <button @click="umschalten">
          {{ zustand.aktiv ? 'Ausschalten' : 'Einschalten' }}
        </button>
        <span v-if="meldung" class="meldung">{{ meldung }}</span>
      </p>
    </section>

    <section class="karte">
      <h2>Geräte</h2>
      <p>
        <label>Zeitraum
          <select v-model.number="stunden">
            <option :value="1">letzte Stunde</option>
            <option :value="24">letzte 24 Stunden</option>
            <option :value="168">letzte 7 Tage</option>
            <option :value="720">letzte 30 Tage</option>
          </select>
        </label>
        <span class="leise" style="margin-left: 1rem">
          {{ eigene.length }} im eigenen Netz,
          <strong v-if="grenzwertig > 0" class="schlecht">{{ grenzwertig }} grenzwertig</strong>
          <span v-else>keines grenzwertig</span>
        </span>
      </p>

      <table class="daten">
        <thead>
          <tr>
            <th>Adresse</th><th>Pakete</th><th>RSSI</th><th>LQI</th>
            <th>schwach</th><th>Spanne</th><th>Bewertung</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="g in eigene" :key="g.addr">
            <td><code>0x{{ g.addr }}</code>
              <span v-if="g.addr === '0000'" class="leise">Koordinator</span></td>
            <td>{{ g.pakete.toLocaleString('de') }}</td>
            <td>{{ dbm(mittel(g.sum_rssi, g.pakete)) }}</td>
            <td>{{ mittel(g.sum_lqi, g.pakete) }}</td>
            <td :class="g.schwach > 0 ? 'mittel' : ''">
              {{ g.schwach > 0 ? Math.round(g.schwach * 100 / g.pakete) + ' %' : '—' }}
            </td>
            <td class="leise">{{ g.max_rssi }} … {{ g.min_rssi }}</td>
            <td :class="bewertung(g).klasse">{{ bewertung(g).text }}</td>
          </tr>
        </tbody>
      </table>
      <p v-if="eigene.length === 0" class="leise">
        Noch keine Geräte in diesem Zeitraum.
      </p>

      <template v-if="fremde.length > 0">
        <h3>Fremde Netze in Hörweite</h3>
        <p class="leise">
          Nicht deine Geräte — sie stehen hier, weil sie denselben Kanal
          benutzen und damit deinen Empfang mitbelegen.
        </p>
        <table class="daten" style="max-width: 32rem">
          <thead><tr><th>Netz</th><th>Adresse</th><th>Pakete</th><th>RSSI</th></tr></thead>
          <tbody>
            <tr v-for="g in fremde" :key="`${g.pan}-${g.addr}`">
              <td><code>{{ hex(g.pan) }}</code></td>
              <td><code>0x{{ g.addr }}</code></td>
              <td>{{ g.pakete.toLocaleString('de') }}</td>
              <td>{{ dbm(mittel(g.sum_rssi, g.pakete)) }}</td>
            </tr>
          </tbody>
        </table>
      </template>
    </section>

    <section class="karte">
      <h2>Pakete <span class="leise">letzte 10 Minuten</span></h2>
      <p v-if="gekuerzt" class="hinweis">
        Gekürzt — es kamen mehr Pakete an, als hier gezeigt werden.
      </p>
      <table class="daten">
        <thead>
          <tr><th>Zeit</th><th>Art</th><th>von</th><th>an</th>
              <th>RSSI</th><th>LQI</th><th>Länge</th></tr>
        </thead>
        <tbody>
          <tr v-for="(p, i) in pakete" :key="`${p.ts}-${p.seq}-${i}`">
            <td>{{ uhrzeit(p.ts) }}</td>
            <td>{{ ART[p.typ] ?? p.typ }}</td>
            <td><code>{{ p.von ? '0x' + p.von : '—' }}</code></td>
            <td>
              <code v-if="p.rundruf">Rundruf</code>
              <code v-else>{{ p.an ? '0x' + p.an : '—' }}</code>
            </td>
            <td>{{ dbm(p.rssi) }}</td>
            <td>{{ p.lqi }}</td>
            <td class="leise">{{ p.laenge }}</td>
          </tr>
        </tbody>
      </table>
      <p v-if="pakete.length === 0" class="leise">
        Nichts empfangen. Auf einem stillen Kanal kann eine Minute vergehen —
        schalte zur Probe eine Zigbee-Lampe.
      </p>
    </section>
  </template>
</template>

<style scoped>
.klein { padding: 0 .5rem; margin-left: .3rem; }
.meldung { margin-left: 1rem; }
.hinweis { padding: .5rem .8rem; border-left: 3px solid #888; background: #0001; }
.hinweis.warnung { border-left-color: #b45309; }
h3 { margin-top: 1.4rem; }
</style>
