<script setup lang="ts">
import { ref } from 'vue';
import { holeHealth } from './api.ts';
import { rolle, zigbeeAktiv, zigbeeImVerbund } from './zustand.ts';
import { nutzeTakt } from './takt.ts';

const verbunden = ref(false);
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
    rolle.value = h.rolle ?? 'master';
    zigbeeImVerbund.value = h.zigbeeImVerbund === true;
    if (h.standort !== standort.value) {
      standort.value = h.standort;
      // Browser-Tabs mehrerer Analyzer bleiben so unterscheidbar:
      document.title =
        h.standort === '' ? 'AskSin-Analyzer' : `AskSin-Analyzer · ${h.standort}`;
    }
  } catch {
    erreichbar.value = false;
    verbunden.value = false;
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
      <RouterLink v-if="rolle === 'master' && zigbeeImVerbund" to="/verbund-zigbee"><span class="oben">Verbund</span><span class="unten">Zigbee</span></RouterLink>
      <RouterLink to="/settings"><span class="oben">Einstellungen</span><span class="unten">BidCoS</span></RouterLink>
      <RouterLink v-if="zigbeeAktiv" to="/settings-zigbee"><span class="oben">Einstellungen</span><span class="unten">Zigbee</span></RouterLink>
      <RouterLink to="/wartung">Wartung</RouterLink>
      <RouterLink to="/info">Info</RouterLink>
    </nav>
    <span v-if="demo" class="demo-badge">DEMO</span>
    <span class="status-punkt" :class="{ verbunden }">
      {{ !erreichbar ? 'Core nicht erreichbar' : verbunden ? 'Sniffer verbunden' : 'Sniffer getrennt' }}
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
