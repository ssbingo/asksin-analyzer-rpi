<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { holeNoise, holeSnapshot, holeTelegramme } from '../api.ts';
import type { Snapshot, Telegramm } from '../api.ts';
import { echarts, zeitChartOption } from '../chart.ts';
import { dbm, vorZeit } from '../format.ts';
import { nutzeTakt } from '../takt.ts';

const snapshot = ref<Snapshot | null>(null);
const chartEl = ref<HTMLDivElement | null>(null);

let chart: ReturnType<typeof echarts.init> | undefined;
let telegramme: Telegramm[] = [];
let lastId = 0;

function anpassen(): void {
  chart?.resize();
}

onMounted(() => {
  if (chartEl.value !== null) chart = echarts.init(chartEl.value);
  window.addEventListener('resize', anpassen);
});
onUnmounted(() => {
  window.removeEventListener('resize', anpassen);
  chart?.dispose();
});

nutzeTakt(async () => {
  const [s, n, t] = await Promise.all([
    holeSnapshot(),
    holeNoise(180),
    lastId === 0 ? holeTelegramme(undefined, 500) : holeTelegramme(lastId, 500),
  ]);
  snapshot.value = s;
  if (t.telegrams.length > 0) {
    telegramme = [...telegramme, ...t.telegrams].slice(-1000);
    lastId = t.lastId;
  }
  const grenze = Date.now() - 180 * 60_000;
  chart?.setOption(
    zeitChartOption(
      n.noise.map((m) => [m.ts, m.avg]),
      telegramme.filter((x) => x.ts >= grenze).map((x) => [x.ts, x.rssi]),
    ),
  );
}, 3000);
</script>

<template>
  <h2>Übersicht</h2>

  <div class="kacheln" v-if="snapshot !== null">
    <div class="kachel">
      <div class="titel">Verbindung</div>
      <div class="wert" :class="snapshot.ingest.connected ? 'gut' : 'schwach'">
        {{ snapshot.ingest.connected ? 'verbunden' : 'getrennt' }}
      </div>
      <div class="zusatz" v-if="snapshot.ingest.connectedSince !== null">
        seit {{ vorZeit(snapshot.ingest.connectedSince, snapshot.ts).replace('vor ', '') }}
      </div>
    </div>
    <div class="kachel">
      <div class="titel">Grundrauschen</div>
      <div class="wert">{{ dbm(snapshot.noiseFloor.last) }}</div>
      <div class="zusatz">geglättet {{ dbm(snapshot.noiseFloor.ewma) }}</div>
    </div>
    <div class="kachel">
      <div class="titel">Telegramme / min</div>
      <div class="wert">{{ snapshot.telegramsPerMinute }}</div>
      <div class="zusatz">{{ snapshot.ingest.telegrams }} seit Start</div>
    </div>
    <div class="kachel">
      <div class="titel">Geräte (aktiv)</div>
      <div class="wert">{{ snapshot.devices.length }}</div>
      <div class="zusatz" v-if="snapshot.devList !== null">
        Namen: {{ snapshot.devList.source === 'ccu' ? 'von der CCU' :
                  snapshot.devList.source === 'cache' ? 'aus dem Cache' : 'noch keine' }}
      </div>
    </div>
  </div>

  <div class="panel">
    <div ref="chartEl" id="chart"></div>
    <div class="fussnote">
      Grundrauschen als Minutenmittel, Telegramme als Einzelpunkte — letzte 3 Stunden.
    </div>
  </div>

  <div class="panel" v-if="snapshot !== null && snapshot.devices.length > 0">
    <h3 style="margin-top: 0">Duty-Cycle (gleitende Stunde, Top 10)</h3>
    <div class="scrollbar">
      <table class="daten">
        <thead>
          <tr>
            <th>Gerät</th><th>Adresse</th>
            <th class="num">Duty-Cycle</th><th class="num">RSSI</th>
            <th class="num">Telegramme</th><th>zuletzt</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="g in [...snapshot.devices].sort((a, b) => b.dutyCyclePercent - a.dutyCyclePercent).slice(0, 10)"
            :key="g.addr"
          >
            <td>{{ g.name }}</td>
            <td class="gedimmt">{{ g.address }}</td>
            <td class="num" :class="g.dutyCyclePercent >= 80 ? 'schwach' : g.dutyCyclePercent >= 50 ? 'mittel' : ''">
              {{ g.dutyCyclePercent.toFixed(1) }} %
            </td>
            <td class="num">{{ g.rssi.last }} dBm</td>
            <td class="num">{{ g.telegrams }}</td>
            <td class="gedimmt">{{ vorZeit(g.lastSeen, snapshot.ts) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <div class="fussnote">
      100 % = erlaubte Sendezeit (36 s/h) ausgeschöpft. Schätzung aus Telegrammlänge, gegen die CCU kalibrieren.
    </div>
  </div>
</template>
