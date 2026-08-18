<script setup lang="ts">
import { computed, ref } from 'vue';
import { holeZigbeeMatrix } from '../api.ts';
import type { ZigbeeMatrix } from '../api.ts';
import { dbm, rssiKlasse, uhrzeit } from '../format.ts';
import { nutzeTakt } from '../takt.ts';

const matrix = ref<ZigbeeMatrix | null>(null);
const stunden = ref(24);
const nichtVorhanden = ref(false);

nutzeTakt(async () => {
  try {
    matrix.value = await holeZigbeeMatrix(stunden.value);
    nichtVorhanden.value = false;
  } catch (err) {
    if (err instanceof Error && err.message.includes('501')) {
      nichtVorhanden.value = true;
      matrix.value = null;
      return;
    }
    throw err;
  }
}, 30_000);

/** Nur die Zeilen, die eine Frage aufwerfen — der Rest ist Beiwerk. */
const auffaellig = computed(() => matrix.value?.geraete.filter(
  (g) => g.nirgends || Object.keys(g.empfang).length === 1) ?? []);
</script>

<template>
  <h2>Verbund · Zigbee</h2>

  <div class="panel" v-if="nichtVorhanden">
    <p style="margin: 0">
      <strong>Der Master braucht einen eigenen Mithörer.</strong> Erst dann
      entsteht die Verbund-Auswertung für Zigbee — wer zusammenführt, soll
      selbst messen: Sonst hätte der Master keine eigene Zeile, und niemand
      könnte sagen, ob ein „nirgends gehört“ an den Standorten liegt oder
      daran, dass er gar nicht hinhört.
    </p>
    <p style="margin: .6rem 0 0" class="fussnote">
      Clients dürfen Zigbee unabhängig davon lokal betreiben; sie sehen ihre
      Daten unter <em>Meldungen · Zigbee</em>. Ob sie hier erscheinen,
      entscheidet die Gegenstellenliste unter
      <RouterLink to="/settings">Einstellungen · BidCoS</RouterLink> — wie bei
      BidCoS auch.
    </p>
  </div>

  <template v-else-if="matrix">
    <div class="panel">
      <h3 style="margin-top: 0">Wer hört wen</h3>
      <p style="margin-top: 0">
        {{ matrix.zusammenfassung.gesamt }} Geräte, davon
        <strong :class="matrix.zusammenfassung.nirgends > 0 ? 'fehler' : 'ok'">
          {{ matrix.zusammenfassung.nirgends }} von niemandem gehört</strong>
        und
        <strong :class="matrix.zusammenfassung.nurEinStandort > 0 ? 'mittel' : ''">
          {{ matrix.zusammenfassung.nurEinStandort }} nur an einem Standort</strong>.
        <label style="margin-left: 1rem">Zeitraum
          <select v-model.number="stunden">
            <option :value="1">1 h</option>
            <option :value="24">24 h</option>
            <option :value="168">7 Tage</option>
            <option :value="720">30 Tage</option>
          </select>
        </label>
        <span class="gedimmt" style="margin-left: 1rem">
          Stand {{ uhrzeit(matrix.ts) }}</span>
      </p>

      <div class="fussnote" v-if="matrix.ohneMithoerer.length > 0"
           style="margin-bottom: .4rem">
        <strong>Ohne Mithörer:</strong> {{ matrix.ohneMithoerer.join(', ') }} —
        diese Standorte laufen, hören Zigbee aber nicht mit. Ein Stick dort
        würde die Matrix um eine Spalte erweitern.
      </div>
      <div class="fussnote" v-if="matrix.nichtErreichbar.length > 0"
           style="margin-bottom: .6rem">
        <strong>Nicht erreichbar:</strong> {{ matrix.nichtErreichbar.join(', ') }} —
        hier wissen wir es nicht. Deren Spalten stehen auf <em>?</em>, nicht
        auf <em>—</em>.
      </div>

      <div class="tabelle-scroll">
        <table>
          <thead>
            <tr>
              <th>Gerät</th>
              <th v-for="s in matrix.standorte" :key="s">{{ s }}</th>
              <th>bester Standort</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="g in matrix.geraete" :key="g.ieee ?? `${g.pan}-${g.addr}`">
              <td>
                {{ g.name || '—' }}
                <span class="gedimmt" v-if="g.addr">0x{{ g.addr }}</span>
                <span class="gedimmt" v-if="!g.ieee"
                      title="Noch kein Paket trug die IEEE-Adresse — diese Zeile lässt sich nicht standortübergreifend zusammenführen">
                  (nicht zusammenführbar)</span>
              </td>
              <td v-for="s in matrix.standorte" :key="s">
                <span v-if="matrix.nichtErreichbar.includes(s)" class="gedimmt"
                      title="Dieser Standort antwortet gerade nicht — unbekannt, nicht null">?</span>
                <span v-else-if="matrix.ohneMithoerer.includes(s)" class="gedimmt"
                      title="Dieser Standort hört Zigbee nicht mit">kein Stick</span>
                <span v-else-if="g.empfang[s]" :class="rssiKlasse(g.empfang[s]!.rssi)">
                  {{ dbm(g.empfang[s]!.rssi) }}
                </span>
                <span v-else class="gedimmt">—</span>
              </td>
              <td>
                <strong v-if="g.beste">{{ g.beste }}</strong>
                <span v-else class="fehler">niemand</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="panel" v-if="auffaellig.length > 0">
      <h3 style="margin-top: 0">Worauf es hinausläuft</h3>
      <p style="margin-top: 0">
        Diese Geräte hängen an einem einzigen Standort — oder an keinem.
        <strong>Genau dafür ist der Verbund da:</strong> Ein einzelner Analyzer
        kann „das Gerät ist still“ und „ich höre es nur nicht“ nicht
        unterscheiden. Zwei können es.
      </p>
      <table class="daten" style="max-width: 44rem">
        <thead><tr><th>Gerät</th><th>gehört von</th><th>Bedeutung</th></tr></thead>
        <tbody>
          <tr v-for="g in auffaellig" :key="g.ieee ?? `${g.pan}-${g.addr}`">
            <td>{{ g.name || `0x${g.addr}` }}</td>
            <td>
              <span v-if="g.beste">{{ g.beste }}</span>
              <span v-else class="fehler">niemand</span>
            </td>
            <td class="gedimmt">
              <template v-if="g.nirgends">
                Steht in der Zigbee-Steuerung, aber kein Standort hört es.
              </template>
              <template v-else>
                Fällt dieser Standort aus, ist das Gerät unbeobachtet.
              </template>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </template>
</template>
