<script setup lang="ts">
import { ref } from 'vue';
import { holeHealth, holeLangzeit } from './api.ts';
import { rolle, zigbeeAktiv } from './zustand.ts';
import Empfangsbalken from './components/Empfangsbalken.vue';
import GrafanaKnopf from './components/GrafanaKnopf.vue';
import type { Health } from './api.ts';
import { nutzeTakt } from './takt.ts';

const verbunden = ref(false);
const zigbeeVerbunden = ref(false);
const empfang = ref<Health['empfang'] | null>(null);
/**
 * Weg zur Grafana-Oberfläche — leer, solange es keinen gibt.
 *
 * Der Knopf steht nur da, wo Grafana auch läuft: auf dem Master, und nur
 * wenn es dort installiert ist. Ein Knopf, der auf eine Seite führt, die es
 * nicht gibt, ist schlechter als keiner.
 */
const grafanaUrl = ref('');

/** Der Tooltip nennt die Zahlen, aus denen die Stufe entstanden ist. */
function bidcosTitel(): string {
  const e = empfang.value?.bidcos;
  if (e === undefined || e.stoerabstand === null) return 'Empfang noch nicht gemessen';
  return `Störabstand ${e.stoerabstand} dB `
    + `(Median ${e.rssiMedian} dBm über dem Rauschen von ${e.rauschen} dBm)`;
}
function zigbeeTitel(): string {
  const e = empfang.value?.zigbee;
  if (e === undefined || e.lqiMedian === null) return 'Noch keine Zigbee-Messung';
  return `Verbindungsgüte ${e.lqiMedian} von 255 (Median über die Geräte des eigenen Netzes)`;
}
const erreichbar = ref(false);
const demo = ref(false);
const updateVerfuegbar = ref(false);
const standort = ref('');


nutzeTakt(async () => {
  try {
    const h = await holeHealth();
    erreichbar.value = true;
    verbunden.value = h.connected;
    demo.value = h.demo;
    updateVerfuegbar.value = h.updateVerfuegbar === true;
    zigbeeAktiv.value = h.zigbee === true;
    zigbeeVerbunden.value = h.zigbeeVerbunden === true;
    empfang.value = h.empfang ?? null;
    rolle.value = h.rolle ?? 'master';
    if (h.standort !== standort.value) {
      standort.value = h.standort;
      // Browser-Tabs mehrerer Analyzer bleiben so unterscheidbar:
      document.title =
        h.standort === '' ? 'AskSin-Analyzer' : `AskSin-Analyzer · ${h.standort}`;
    }
  } catch {
    erreichbar.value = false;
    verbunden.value = false;
    // Nicht auch `zigbeeAktiv` zurücksetzen: Ein kurzer Aussetzer des Cores
    // würde sonst die Zigbee-Menüpunkte wegblinken lassen. Der Punkt in der
    // Kopfzeile sagt ohnehin schon, dass gerade nichts zu holen ist.
    zigbeeVerbunden.value = false;
    empfang.value = null;
    throw new Error('Core nicht erreichbar');
  }
}, 5000);

/**
 * Eigener, sehr langsamer Takt: Ob Grafana installiert ist, ändert sich beim
 * Einrichten und sonst nie. Diese Auskunft im Fünfsekundentakt zu holen wäre
 * Verschwendung — sie liest Verzeichnisse und fragt die Datenbank nach den
 * Standorten.
 */
nutzeTakt(async () => {
  if (rolle.value !== 'master') { grafanaUrl.value = ''; return; }
  try {
    const l = await holeLangzeit();
    grafanaUrl.value = l.installiert.grafana ? l.grafanaUrl : '';
  } catch {
    // Ältere Core-Fassung oder gerade nicht erreichbar — dann eben kein
    // Knopf. Das ist kein Fehler, der jemanden zu interessieren hätte.
    grafanaUrl.value = '';
  }
}, 60000);
</script>

<template>
  <header class="kopf">
    <h1>AskSin-<span>Analyzer</span></h1>
    <span v-if="standort !== ''" class="standort-badge" title="Standort dieses Analyzers">
      {{ standort }}
    </span>
    <nav class="haupt">
      <RouterLink to="/home">Übersicht</RouterLink>
      <RouterLink to="/list"><span class="oben">Telegramme</span><span class="unten">BidCoS</span></RouterLink>
      <!-- Nur wenn ein Mithörer läuft: Vier von fünf Analyzern haben keinen,
           und ein toter Menüpunkt ist schlechter als keiner. -->
      <RouterLink v-if="zigbeeAktiv" to="/zigbee"><span class="oben">Meldungen</span><span class="unten">Zigbee</span></RouterLink>
      <!-- Verbund-Ansichten gibt es nur auf dem Master. Ein Client liefert zu,
           er verwaltet nicht — und ein Tab, der nur erklärt, warum er leer ist,
           ist kein Tab. -->
      <RouterLink v-if="rolle === 'master'" to="/verbund"><span class="oben">Verbund</span><span class="unten">BidCoS</span></RouterLink>
      <RouterLink v-if="rolle === 'master' && zigbeeAktiv" to="/verbund-zigbee"><span class="oben">Verbund</span><span class="unten">Zigbee</span></RouterLink>
      <RouterLink to="/settings"><span class="oben">Einstellungen</span><span class="unten">BidCoS</span></RouterLink>
      <!-- Bewusst OHNE Bedingung, anders als die drei Reiter darueber.
           Hier sitzt der Schalter, mit dem Zigbee ueberhaupt erst
           eingeschaltet wird. Haengt der Reiter an `zigbeeAktiv`, gibt es
           bei ausgeschaltetem Zigbee keinen Weg mehr dorthin — man muesste
           die Adresse von Hand eintippen oder an die config.json. Genau das
           soll dem Anwender erspart bleiben. -->
      <RouterLink to="/settings-zigbee"><span class="oben">Einstellungen</span><span class="unten">Zigbee</span></RouterLink>
      <RouterLink to="/wartung">Wartung</RouterLink>
      <RouterLink to="/info">Info</RouterLink>
    </nav>
    <span v-if="demo" class="demo-badge">DEMO</span>
    <!-- Zwei Punkte, wo zwei Funknetze mitgehört werden. Der Zigbee-Punkt
         erscheint nur bei eingeschaltetem Mithörer: Ein Analyzer ohne Stick
         soll keine dauerhaft rote Anzeige tragen für etwas, das er gar nicht
         können soll. Beschriftet sind beide, weil ein Punkt allein nicht
         sagt, WELCHES Funknetz er meint. -->
    <span class="status-punkt" :class="{ verbunden }" title="BidCoS-Sniffer auf der Analyzer-Platine">
      <Empfangsbalken
        v-if="erreichbar && verbunden"
        :balken="empfang?.bidcos.balken ?? 0"
        :titel="bidcosTitel()"
      />
      {{ !erreichbar ? 'Core nicht erreichbar'
         : verbunden ? 'BidCoS verbunden' : 'BidCoS getrennt' }}
    </span>
    <span
      v-if="erreichbar && zigbeeAktiv"
      class="status-punkt"
      :class="{ verbunden: zigbeeVerbunden }"
      title="Zigbee-Mithörer am USB-Anschluss"
    >
      <Empfangsbalken
        v-if="zigbeeVerbunden"
        :balken="empfang?.zigbee.balken ?? 0"
        :titel="zigbeeTitel()"
      />
      {{ zigbeeVerbunden ? 'Zigbee verbunden' : 'Zigbee getrennt' }}
    </span>
    <GrafanaKnopf v-if="grafanaUrl !== ''" :url="grafanaUrl" />
    <RouterLink
      v-if="updateVerfuegbar"
      to="/info"
      class="update-glocke"
      title="Neue Version verfügbar — klicken für Details und Installation"
    >🔔 Update</RouterLink>
  </header>
  <main class="inhalt">
    <RouterView />
  </main>
</template>
