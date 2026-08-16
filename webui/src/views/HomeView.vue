<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import {
  holeNoise,
  holeSnapshot,
  holeLangzeit,
  holeStatusAnzeige,
  holeTelegramme,
  statusSeiteWeiter,
} from '../api.ts';
import type { LangzeitZustand, Snapshot, StatusAnzeigeZustand, Telegramm } from '../api.ts';
import { echarts, tortenOption, zeitChartOption } from '../chart.ts';
import type { TortenStueck } from '../chart.ts';
import { dbm, vorZeit } from '../format.ts';
import { nutzeTakt } from '../takt.ts';

const snapshot = ref<Snapshot | null>(null);
const chartEl = ref<HTMLDivElement | null>(null);
const tortenEl = ref<HTMLDivElement | null>(null);

let chart: ReturnType<typeof echarts.init> | undefined;
let torte: ReturnType<typeof echarts.init> | undefined;
let telegramme: Telegramm[] = [];
let lastId = 0;

/** Zeitspanne des Diagramms — fuer BEIDE Reihen dieselbe. */
const FENSTER_MIN = 180;
/** Obergrenze der Schnittstelle; darueber meldet sie `gekuerzt`. */
const MAX_PUNKTE = 5000;
const gekuerzt = ref(false);

function anpassen(): void {
  chart?.resize();
  torte?.resize();
}

// ---- Status-LED / OLED (M11) --------------------------------------------

const status = ref<StatusAnzeigeZustand | null>(null);
const langzeit = ref<LangzeitZustand | null>(null);
const oledCanvas = ref<HTMLCanvasElement | null>(null);

const statusAktiv = (): boolean => {
  const k = status.value?.konfig;
  return k !== undefined && (k.led !== 'aus' || k.oled);
};

function zeichneOledVorschau(): void {
  const z = status.value;
  const canvas = oledCanvas.value;
  if (z === null || canvas === null) return;
  const ctx = canvas.getContext('2d');
  if (ctx === null) return;
  const bytes = Uint8Array.from(atob(z.oledBild), (c) => c.charCodeAt(0));
  // Die Bauhöhe kommt vom Core: Ein Adafruit PiOLED hat 32 Zeilen, ein
  // 0,96-Zoll-Modul 64. Fest verdrahtete 8 Speicherseiten zeichneten für das
  // kleinere Panel die doppelte Höhe.
  const hoehe = z.oledHoehe ?? 32;
  canvas.height = hoehe * 2;
  ctx.fillStyle = '#001018';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#9fdcff';
  for (let seite8 = 0; seite8 < hoehe / 8; seite8++) {
    for (let x = 0; x < 128; x++) {
      const byte = bytes[seite8 * 128 + x] ?? 0;
      for (let bit = 0; bit < 8; bit++) {
        if (((byte >> bit) & 1) === 1) {
          ctx.fillRect(x * 2, (seite8 * 8 + bit) * 2, 2, 2);
        }
      }
    }
  }
}

nutzeTakt(async () => {
  try {
    status.value = await holeStatusAnzeige();
    if (statusAktiv()) zeichneOledVorschau();
  } catch {
    status.value = null;               // ältere Core-Version ohne den Endpunkt
  }
}, 2000);

// Eigener, langsamerer Takt: Diese Werte ändern sich höchstens beim Umbauen,
// und die Standortzahl kommt aus einer Abfrage an die Datenbank. Sie im
// Zweisekundentakt zu holen wäre Verschwendung.
nutzeTakt(async () => {
  try {
    langzeit.value = await holeLangzeit();
  } catch {
    langzeit.value = null;             // ältere Core-Version ohne den Endpunkt
  }
}, 30_000);

async function blaettern(): Promise<void> {
  await statusSeiteWeiter().catch(() => {});
  // Zweimal abfragen: Das Bild zeichnet der Anzeigedienst auf dem Gerät, und
  // das dauert einen Wimpernschlag. Die erste Abfrage liefert oft noch die
  // alte Seite; ohne die zweite wirkte der Knopf träge und man klickte
  // versehentlich weiter.
  for (const wartezeit of [0, 250]) {
    if (wartezeit > 0) await new Promise((f) => setTimeout(f, wartezeit));
    try {
      status.value = await holeStatusAnzeige();
      zeichneOledVorschau();
    } catch {
      /* nächster Takt */
    }
  }
}

const ledCss = (): string => {
  const f = status.value?.ledMuster.farbe;
  return f === undefined ? '#555' : `rgb(${f[0]},${f[1]},${f[2]})`;
};

onMounted(() => {
  if (chartEl.value !== null) chart = echarts.init(chartEl.value);
  if (tortenEl.value !== null) torte = echarts.init(tortenEl.value);
  window.addEventListener('resize', anpassen);
});
onUnmounted(() => {
  window.removeEventListener('resize', anpassen);
  chart?.dispose();
  torte?.dispose();
});

/** Alle Geräte als eigenes Tortenstück, wie im Original — größte zuerst. */
function tortenStuecke(s: Snapshot): TortenStueck[] {
  const gesamt = s.devices.reduce((sum, g) => sum + g.telegrams, 0);
  if (gesamt === 0) return [];
  return [...s.devices]
    .sort((a, b) => b.telegrams - a.telegrams)
    .map((g) => ({
      name: g.name,
      value: g.telegrams,
      anteil: (g.telegrams / gesamt) * 100,
      address: g.address,
      rssi: g.rssi.last,
      dutyCycle: g.dutyCyclePercent,
    }));
}

nutzeTakt(async () => {
  const [s, n, t] = await Promise.all([
    holeSnapshot(),
    holeNoise(FENSTER_MIN),
    // Erster Abruf: dasselbe Zeitfenster wie das Grundrauschen. Vorher waren
    // es „die neuesten 500" — bei 16 Telegrammen je Minute eine halbe Stunde,
    // waehrend die Unterschrift drei Stunden versprach.
    lastId === 0
      ? holeTelegramme(undefined, MAX_PUNKTE, FENSTER_MIN)
      : holeTelegramme(lastId, MAX_PUNKTE),
  ]);
  snapshot.value = s;
  gekuerzt.value = t.gekuerzt === true;
  const grenze = Date.now() - FENSTER_MIN * 60_000;
  if (t.telegrams.length > 0) {
    // Nach Zeit beschneiden, nicht nach Anzahl — sonst wandert die Grenze mit
    // dem Verkehr, und das Diagramm zeigt bei viel Funk weniger Zeit.
    telegramme = [...telegramme, ...t.telegrams].filter((x) => x.ts >= grenze);
    lastId = t.lastId;
  }
  chart?.setOption(
    zeitChartOption(
      n.noise.map((m) => [m.ts, m.avg]),
      telegramme.filter((x) => x.ts >= grenze).map((x) => [x.ts, x.rssi]),
    ),
  );
  torte?.setOption(tortenOption(tortenStuecke(s)));
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
      <div class="wert">
        {{ snapshot.devices.length }}<span
          class="von" v-if="snapshot.ccuAbgleich !== null"
        >&thinsp;/&thinsp;{{ snapshot.ccuAbgleich.inListe }}</span>
      </div>
      <!--
        Die zweite Zahl ist der eigentliche Zweck: Ein Gerät, das in der
        Zentrale steht und nie zu hören war, hat entweder keinen Empfang, ist
        ausgefallen oder wurde ausgebaut, ohne dass es jemand aus der CCU
        genommen hat. Vorher zeigte die Kachel nur, was sie hört — nie, was
        fehlt.
      -->
      <div class="zusatz" v-if="snapshot.ccuAbgleich !== null">
        <span :class="snapshot.ccuAbgleich.nieGehoert > 0 ? 'schwach' : 'gut'">
          {{ snapshot.ccuAbgleich.nieGehoert }} nie gehört</span>,
        {{ snapshot.ccuAbgleich.jeGehoert }} von
        {{ snapshot.ccuAbgleich.inListe }} aus der CCU-Liste<span
          v-if="snapshot.ccuAbgleich.fremde > 0"
        >, {{ snapshot.ccuAbgleich.fremde }} fremde</span>
      </div>
      <div class="zusatz" v-else-if="snapshot.devList !== null">
        Namen: {{ snapshot.devList.source === 'ccu' ? 'von der CCU' :
                  snapshot.devList.source === 'cache' ? 'aus dem Cache' : 'noch keine' }}
      </div>
    </div>
  </div>

  <div class="panel">
    <div ref="chartEl" id="chart"></div>
    <div class="fussnote">
      Grundrauschen als Minutenmittel, Telegramme als Einzelpunkte — letzte 3 Stunden.
      <span v-if="gekuerzt"><strong>Gekürzt:</strong> Es gab mehr Telegramme, als
      das Diagramm zeigt — die ältesten fehlen.</span>
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

  <div class="panel" v-if="status !== null && statusAktiv()">
    <h3 style="margin-top: 0">Status-LED &amp; OLED</h3>
    <div class="zeile" style="align-items: flex-start; gap: 1.5rem">
      <div class="block">
        <h4>Gerät</h4>
        <div class="zeile" style="margin-bottom: 0.6rem">
          <span
            :style="`display:inline-block;width:1.1rem;height:1.1rem;border-radius:50%;background:${ledCss()};box-shadow:0 0 10px ${ledCss()}`"
          ></span>
          <strong>{{ status.ledMuster.grund }}</strong>
          <span class="chip" v-if="status.ledMuster.blinken !== 'aus'">{{ status.ledMuster.blinken }}</span>
          <span class="chip schwach" v-if="status.konfig.led !== 'aus' && !status.aktiv.led">LED gestört</span>
          <span class="chip schwach" v-if="status.konfig.oled && !status.aktiv.oled">OLED gestört</span>
        </div>
        <table class="daten" style="max-width: 22rem">
          <tbody>
            <tr><td class="gedimmt">CPU-Last</td><td class="num">{{ status.system.cpuLast.toFixed(2) }}</td></tr>
            <tr v-if="status.system.luefterUpm !== null && status.system.luefterUpm !== undefined"><td class="gedimmt">Lüfter</td><td class="num">{{ status.system.luefterUpm }} U/min</td></tr>
            <tr v-if="status.system.tempC !== null"><td class="gedimmt">Temperatur</td><td class="num">{{ status.system.tempC.toFixed(1) }} °C</td></tr>
            <tr><td class="gedimmt">RAM frei</td><td class="num">{{ status.system.ramFreiProzent.toFixed(0) }} %</td></tr>
            <tr v-if="status.system.diskFreiProzent !== null"><td class="gedimmt">SSD frei</td><td class="num">{{ status.system.diskFreiProzent.toFixed(0) }} %</td></tr>
          </tbody>
        </table>
        <div class="fussnote" v-for="(text, kontext) in status.fehler" :key="kontext">
          ⚠ {{ kontext }}: {{ text }}
        </div>
      </div>
      <!-- Mittlerer Block: Was tut die Langzeitaufzeichnung gerade? Diese
           Fragen stellt man sich im Vorbeigehen, nicht in den Einstellungen —
           deshalb stehen sie hier und nicht dort. -->
      <div class="block" v-if="langzeit !== null && langzeit.rolle === 'master'"
           style="min-width: 15rem">
        <h4>Langzeitdaten</h4>
        <table class="daten" style="max-width: 20rem">
          <tbody>
            <tr>
              <td class="gedimmt">Influx</td>
              <td><span class="chip" :class="langzeit.influxAktiv ? '' : 'schwach'">
                {{ langzeit.influxAktiv ? (langzeit.influxLokal ? 'aktiv (lokal)' : 'aktiv (extern)') : 'inaktiv' }}
              </span></td>
            </tr>
            <tr>
              <td class="gedimmt">Grafana</td>
              <td><span class="chip" :class="langzeit.installiert.grafana ? '' : 'schwach'">
                {{ langzeit.installiert.grafana ? 'aktiv' : 'inaktiv' }}
              </span></td>
            </tr>
            <tr>
              <td class="gedimmt">Sammlung</td>
              <td class="num">
                {{ langzeit.standorte === null ? '—'
                   : langzeit.standorte === 1 ? '1 Standort'
                   : `${langzeit.standorte} Standorte` }}
              </td>
            </tr>
            <tr>
              <td class="gedimmt">Alarmierung</td>
              <td><span class="chip" :class="langzeit.alarmierung !== null ? '' : 'schwach'">
                {{ langzeit.alarmierung === 'iobroker' ? 'ioBroker'
                   : langzeit.alarmierung === 'email' ? 'E-Mail'
                   : langzeit.alarmierung === 'telegram' ? 'Telegram'
                   : 'keine' }}
              </span></td>
            </tr>
          </tbody>
        </table>
        <div class="fussnote" style="max-width: 20rem">
          <a href="#/einstellungen">Einstellungen → Langzeitdaten</a>
        </div>
      </div>

      <!-- Schiebt die Vorschau an den rechten Rand; die Kennzahlen bleiben
           links stehen. Auf schmalen Anzeigen hebt style.css das wieder auf,
           weil die Zeile dort umbricht und ein rechtsbuendiger Block sonst
           allein in der Gegend steht. -->
      <div class="oled-vorschau block">
        <h4>Anzeige</h4>
        <canvas ref="oledCanvas" width="256" height="64"
                style="border: 1px solid var(--border); border-radius: 6px; image-rendering: pixelated"></canvas>
        <div class="zeile" style="margin-top: 0.4rem">
          <button @click="blaettern">Blättern (Seite {{ status.seite + 1 }}/{{ status.seitenGesamt ?? status.seiten }})</button>
        </div>
        <!-- Eigene Zeile statt neben dem Knopf: Der Satz drueckte die
             Vorschau sonst in die Breite. -->
        <div class="fussnote" style="margin-top: 0.4rem; max-width: 16rem">
          Live-Vorschau des OLED —<br />
          pixelgenau dasselbe Bild wie am Gerät.
        </div>
      </div>
    </div>
  </div>

  <div class="panel">
    <h3 style="margin-top: 0">Telegramme pro Gerät</h3>
    <div ref="tortenEl" id="torte"></div>
    <div class="fussnote">
      Anteil an allen empfangenen Telegrammen seit Dienststart. Ein Tortenstück
      antippen oder ansteuern zeigt Name und Daten des Geräts; die Legende
      blättert durch alle Geräte.
    </div>
  </div>
</template>
