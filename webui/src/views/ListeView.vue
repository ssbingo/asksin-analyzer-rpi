<script setup lang="ts">
import { computed, ref } from 'vue';
import { holeTelegramme } from '../api.ts';
import type { Telegramm } from '../api.ts';
import { rssiKlasse, uhrzeit } from '../format.ts';
import { nutzeTakt } from '../takt.ts';

const MAX_ZEILEN = 500;

const zeilen = ref<Telegramm[]>([]);
const pause = ref(false);
const filter = ref('');
let lastId = 0;

nutzeTakt(async () => {
  if (pause.value) return;
  const res =
    lastId === 0
      ? await holeTelegramme(undefined, 200)
      : await holeTelegramme(lastId, 500);
  if (res.telegrams.length === 0) return;
  lastId = res.lastId;
  // Neueste oben; Puffer hart begrenzt.
  zeilen.value = [...res.telegrams.reverse(), ...zeilen.value].slice(0, MAX_ZEILEN);
}, 2000);

const gefiltert = computed(() => {
  const f = filter.value.trim().toLowerCase();
  if (f === '') return zeilen.value;
  return zeilen.value.filter((t) =>
    [t.fromName, t.toName, t.fromHex, t.toHex, t.typeName]
      .some((s) => s.toLowerCase().includes(f)),
  );
});

function leeren(): void {
  zeilen.value = [];
}
</script>

<template>
  <h2>Telegramme</h2>

  <div class="panel">
    <div class="zeile" style="margin-bottom: 0.8rem">
      <input
        type="search"
        v-model="filter"
        placeholder="Filtern nach Name, Adresse oder Typ …"
      />
      <button @click="pause = !pause">{{ pause ? '▶ Weiter' : '⏸ Pause' }}</button>
      <button @click="leeren">Leeren</button>
      <span class="gedimmt" style="font-size: 0.85rem">
        {{ gefiltert.length }} / {{ zeilen.length }} Zeilen
      </span>
    </div>

    <div class="scrollbar">
      <table class="daten">
        <thead>
          <tr>
            <th>Zeit</th><th class="num">RSSI</th>
            <th>Von</th><th>An</th>
            <th class="num">Len</th><th class="num">Cnt</th>
            <th>Typ</th><th>Flags</th><th>Payload</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="t in gefiltert" :key="t.id">
            <td class="gedimmt">{{ uhrzeit(t.ts) }}</td>
            <td class="num" :class="rssiKlasse(t.rssi)">{{ t.rssi }}</td>
            <td>
              {{ t.fromName }}
              <span class="gedimmt" v-if="t.fromName !== t.fromHex"> ({{ t.fromHex }})</span>
            </td>
            <td>
              {{ t.toAddr === 0 ? 'Broadcast' : t.toName }}
              <span class="gedimmt" v-if="t.toAddr !== 0 && t.toName !== t.toHex"> ({{ t.toHex }})</span>
            </td>
            <td class="num">{{ t.len }}</td>
            <td class="num">{{ t.cnt }}</td>
            <td>
              <span class="chip" :class="{ hmip: t.isHmIp }">{{ t.typeName }}</span>
            </td>
            <td>
              <span class="chip" v-for="f in t.flagNames" :key="f">{{ f }}</span>
            </td>
            <td class="gedimmt" style="font-family: ui-monospace, monospace; font-size: 0.8rem">
              {{ t.payload }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <div class="fussnote" v-if="zeilen.length === 0">
      Noch keine Telegramme empfangen — die Liste füllt sich von selbst.
    </div>
  </div>
</template>
