<script setup lang="ts">
import { ref } from 'vue';
import { holeHealth } from './api.ts';
import { rolle, zigbeeAktiv } from './zustand.ts';
import { nutzeTakt } from './takt.ts';

const verbunden = ref(false);
const zigbeeVerbunden = ref(false);
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
    throw new Error('Core nicht erreichbar');
  }
}, 5000);
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
      {{ !erreichbar ? 'Core nicht erreichbar'
         : verbunden ? 'BidCoS verbunden' : 'BidCoS getrennt' }}
    </span>
    <span
      v-if="erreichbar && zigbeeAktiv"
      class="status-punkt"
      :class="{ verbunden: zigbeeVerbunden }"
      title="Zigbee-Mithörer am USB-Anschluss"
    >
      {{ zigbeeVerbunden ? 'Zigbee verbunden' : 'Zigbee getrennt' }}
    </span>
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
