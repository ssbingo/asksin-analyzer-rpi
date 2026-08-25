<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import {
  holeNoise,
  holeSnapshot,
  holeLangzeit,
  holeStatusAnzeige,
  holeTelegramme,
  holeZigbee,
  holeZigbeeGeraete,
  statusSeiteWeiter,
} from '../api.ts';
import type {
  LangzeitZustand, Snapshot, StatusAnzeigeZustand, Telegramm,
  ZigbeeGeraet, ZigbeeVermisst, ZigbeeZustand,
} from '../api.ts';
import { zigbeeAktiv } from '../zustand.ts';
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

/**
 * Die Zeile „Sammlung": Wer liefert gerade in die Langzeitdatenbank?
 *
 * Der Strich stand hier monatelang, ohne zu sagen warum — die Abfrage lief
 * seit der Trennung der InfluxDB-Token ins Leere und wurde stillschweigend
 * verschluckt. Jetzt gibt es drei Fälle, und jeder benennt sich.
 */
const sammlungText = computed<string>(() => {
  const s = langzeit.value?.sammlung ?? null;
  if (s === null) return '—';
  const zahl = s.liefern.length;
  const gesamt = zahl + s.stumm.length;
  const wort = (n: number): string => (n === 1 ? '1 Standort' : `${n} Standorte`);
  // „2 von 3" nur, wenn wirklich etwas fehlt. Sonst stünde bei gesundem
  // Verbund dauerhaft eine Bruchzahl da, und die liest sich wie ein Mangel.
  return s.stumm.length === 0 ? wort(zahl) : `${zahl} von ${gesamt} Standorten`;
});

const sammlungTitel = computed<string>(() => {
  const s = langzeit.value?.sammlung ?? null;
  if (s === null) {
    return 'Noch keine Auskunft — kein Analyzer hat auf die Nachfrage geantwortet.';
  }
  const liefern = s.liefern.length === 0 ? 'keiner' : s.liefern.join(', ');
  return s.stumm.length === 0
    ? `Liefern in die Datenbank: ${liefern}`
    // „Liefert gerade nicht" und nicht „still": Direkt nach einem Neustart
    // steht hier für ein paar Sekunden auch ein völlig gesunder Analyzer, der
    // seinen ersten Schreibvorgang noch vor sich hat.
    : `Liefern: ${liefern}\nLiefert gerade nicht: ${s.stumm.join(', ')}`;
});

// ---- Zigbee-Kachelreihe (M16) -------------------------------------------
//
// Zweite Reihe unter den vier BidCoS-Kacheln, und nur wenn der Mithörer
// läuft. Sie beantwortet für Zigbee dieselben vier Fragen: Hört er? Wo?
// Wie viel? Und wen hört er NICHT — die letzte ist auch hier die wichtigste.
const zigbee = ref<ZigbeeZustand | null>(null);
const zigbeeGeraete = ref<ZigbeeGeraet[]>([]);
const zigbeeVermisst = ref<ZigbeeVermisst[]>([]);
/** Zeitraum der Gerätezählung — wie auf der Zigbee-Seite. */
const ZIGBEE_STUNDEN = 24;

/**
 * Das eigene Netz: dasjenige mit den meisten Paketen.
 *
 * Der Mithörer steht mittendrin, Nachbarnetze kommen nur von weit her
 * herein. Dieselbe Regel wie auf der Zigbee-Seite — und sie ist hier nicht
 * bloss Kosmetik: Ohne sie zählte die Kachel die Geräte der Nachbarn mit und
 * meldete mehr gehörte Geräte, als deCONZ überhaupt kennt.
 */
const zigbeeEigenesNetz = computed<number | null>(() => {
  const summen = new Map<number, number>();
  for (const g of zigbeeGeraete.value) summen.set(g.pan, (summen.get(g.pan) ?? 0) + g.pakete);
  let beste: number | null = null;
  let max = -1;
  for (const [pan, anzahl] of summen) if (anzahl > max) { max = anzahl; beste = pan; }
  return beste;
});
const zigbeeEigene = computed(
  () => zigbeeGeraete.value.filter((g) => g.pan === zigbeeEigenesNetz.value));
const zigbeeFremde = computed(
  () => zigbeeGeraete.value.filter((g) => g.pan !== zigbeeEigenesNetz.value));
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

// Der Zustand des Mithörers ist billig und darf mit der Seite mittakten.
nutzeTakt(async () => {
  if (!zigbeeAktiv.value) { zigbee.value = null; return; }
  try {
    zigbee.value = await holeZigbee();
  } catch {
    zigbee.value = null;               // kein Mithörer auf diesem Analyzer
  }
}, 3000);

// Die Geräteliste NICHT: Sie fasst 24 Stunden Stundensummen zusammen. Alle
// drei Sekunden wäre das auf einem Pi 3 spürbar — und die Zahlen ändern sich
// stündlich. Einmal je Minute genügt vollauf.
nutzeTakt(async () => {
  if (!zigbeeAktiv.value) { zigbeeGeraete.value = []; zigbeeVermisst.value = []; return; }
  try {
    const g = await holeZigbeeGeraete(ZIGBEE_STUNDEN);
    zigbeeGeraete.value = g.geraete;
    zigbeeVermisst.value = g.nieGehoert;
  } catch {
    zigbeeGeraete.value = [];
    zigbeeVermisst.value = [];
  }
}, 60000);

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

  <!--
    Zweite Reihe: dasselbe für Zigbee, und nur wo ein Mithörer läuft.

    Bewusst dieselben vier Fragen in derselben Reihenfolge wie oben — hört er,
    wo, wie viel, und wen hört er NICHT. Wer die obere Reihe gelesen hat,
    findet sich in der unteren ohne Nachdenken zurecht. Ein Grundrauschen
    fehlt hier und wird auch nicht erfunden: Die Sniffer-Firmware liefert RSSI
    nur je Paket, nicht zwischen den Paketen.
  -->
  <template v-if="zigbeeAktiv && zigbee !== null">
    <div class="reihen-titel">
      <RouterLink to="/zigbee">Zigbee-Mithörer</RouterLink>
      <span class="gedimmt">— 2,4 GHz, Kanal {{ zigbee.kanal }}</span>
    </div>
    <div class="kacheln">
      <div class="kachel">
        <div class="titel">Mithörer</div>
        <div class="wert" :class="zigbee.verbunden ? 'gut' : 'schwach'">
          {{ zigbee.verbunden ? 'verbunden' : 'getrennt' }}
        </div>
        <div class="zusatz" v-if="zigbee.verbundenSeit !== null">
          seit {{ vorZeit(zigbee.verbundenSeit, Date.now()).replace('vor ', '') }}
        </div>
        <div class="zusatz" v-else>Stick antwortet nicht</div>
      </div>
      <div class="kachel">
        <div class="titel">Kanal</div>
        <div class="wert">{{ zigbee.kanal }}</div>
        <div class="zusatz">von 11 bis 26</div>
      </div>
      <div class="kachel">
        <div class="titel">Pakete</div>
        <div class="wert">{{ zigbee.pakete.toLocaleString('de-DE') }}</div>
        <!-- Gespeichert ist weniger als empfangen, und das ist Absicht:
             Bestätigungen werden gezählt, nicht abgelegt. Stünde nur eine
             der beiden Zahlen da, sähe die Lücke wie ein Verlust aus. -->
        <div class="zusatz">
          {{ zigbee.gespeichert.toLocaleString('de-DE') }} gespeichert,
          {{ zigbee.bestaetigungen.toLocaleString('de-DE') }} Bestätigungen
        </div>
      </div>
      <div class="kachel">
        <div class="titel">Geräte ({{ ZIGBEE_STUNDEN }} h)</div>
        <div class="wert">
          {{ zigbeeEigene.length }}<span
            class="von" v-if="zigbee.namen?.aktiv"
          >&thinsp;/&thinsp;{{ zigbee.namen.anzahl }}</span>
        </div>
        <!-- Dieselbe Aussage wie beim CCU-Abgleich darüber: Was die Steuerung
             kennt und niemand hört, ist die eigentlich interessante Zahl. -->
        <div class="zusatz" v-if="zigbee.namen?.aktiv">
          <span :class="zigbeeVermisst.length > 0 ? 'schwach' : 'gut'">
            {{ zigbeeVermisst.length }} nie gehört</span>,
          {{ zigbee.namen.anzahl }} in deCONZ<span
            v-if="zigbeeFremde.length > 0"
          >, {{ zigbeeFremde.length }} fremde</span>
        </div>
        <div class="zusatz" v-else>
          ohne Namen — deCONZ nicht eingerichtet<span
            v-if="zigbeeFremde.length > 0"
          >, {{ zigbeeFremde.length }} fremde</span>
        </div>
      </div>
    </div>
  </template>

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
            <!-- „Sammlung" beantwortet die Frage, die man sich im
                 Vorbeigehen stellt: Liefern alle meine Analyzer? Deshalb steht
                 hier nicht nur eine Zahl, sondern bei Lücken auch „von wie
                 vielen" — und wer fehlt, steht im Tooltip. -->
            <tr>
              <td class="gedimmt">Sammlung</td>
              <td class="num" :title="sammlungTitel">{{ sammlungText }}</td>
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
