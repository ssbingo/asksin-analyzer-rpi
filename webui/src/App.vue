<script setup lang="ts">
import { ref } from 'vue';
import { holeHealth } from './api.ts';
import { nutzeTakt } from './takt.ts';

const verbunden = ref(false);
const erreichbar = ref(false);
const demo = ref(false);

nutzeTakt(async () => {
  try {
    const h = await holeHealth();
    erreichbar.value = true;
    verbunden.value = h.connected;
    demo.value = h.demo;
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
  </header>
  <main class="inhalt">
    <RouterView />
  </main>
</template>
