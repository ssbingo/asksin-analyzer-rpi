<script setup lang="ts">
import { ref } from 'vue';
import { holeHealth } from './api.ts';
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
      <RouterLink to="/list">Telegramme</RouterLink>
      <RouterLink to="/settings">Einstellungen</RouterLink>
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
