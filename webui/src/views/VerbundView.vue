<script setup lang="ts">
import { ref } from 'vue';
import { holeVerbund } from '../api.ts';
import type { VerbundUebersicht } from '../api.ts';
import { dbm } from '../format.ts';
import { nutzeTakt } from '../takt.ts';

const uebersicht = ref<VerbundUebersicht | null>(null);
const keineRolle = ref(false);

nutzeTakt(async () => {
  try {
    uebersicht.value = await holeVerbund();
    keineRolle.value = false;
  } catch (err) {
    if (err instanceof Error && err.message.includes('501')) {
      keineRolle.value = true;
      return;
    }
    throw err;
  }
}, 5000);
</script>

<template>
  <h2>Verbund</h2>

  <div class="panel" v-if="keineRolle">
    <p style="margin-top: 0">
      Auf diesem Analyzer ist <strong>keine Verbund-Rolle</strong> konfiguriert.
    </p>
    <p>
      Genau ein Analyzer des Hauses bekommt in seiner
      <code>/etc/asksin-analyzer/config.json</code> die anderen als Peers
      eingetragen und zeigt hier dann alle Standorte auf einen Blick:
    </p>
    <pre style="color: var(--muted); font-size: 0.85rem">"verbund": {
  "peers": [
    { "url": "http://192.168.1.72:8080", "token": "…" },
    { "url": "http://192.168.1.73:8080", "token": "…" }
  ]
}</pre>
    <p class="fussnote">
      Der eigene Standort wird automatisch ergänzt. Details:
      docs/verbund.md im Repository.
    </p>
  </div>

  <template v-else-if="uebersicht !== null">
    <div class="kacheln" style="grid-template-columns: repeat(auto-fit, minmax(260px, 1fr))">
      <div class="kachel" v-for="p in uebersicht.peers" :key="p.url">
        <div class="zeile" style="justify-content: space-between">
          <div class="titel" style="font-size: 0.95rem; color: var(--text); font-weight: 600">
            {{ p.name }}
            <span v-if="p.demo === true" class="chip hmip">DEMO</span>
            <span v-if="p.updateVerfuegbar === true" class="chip" style="color: var(--warn); border-color: var(--warn)">🔔 Update</span>
          </div>
          <a :href="p.url" target="_blank" rel="noopener" title="Weboberfläche dieses Analyzers öffnen">öffnen ↗</a>
        </div>

        <template v-if="p.erreichbar">
          <div class="wert" :class="p.connected === true ? 'gut' : 'schwach'" style="font-size: 1.05rem">
            {{ p.connected === true ? 'Sniffer verbunden' : 'Sniffer getrennt' }}
          </div>
          <table class="daten" style="margin-top: 0.4rem">
            <tbody>
              <tr><td class="gedimmt">Telegramme/min</td><td class="num">{{ p.telegramsPerMinute ?? '—' }}</td></tr>
              <tr><td class="gedimmt">Grundrauschen</td><td class="num">{{ dbm(p.noiseFloor) }}</td></tr>
              <tr><td class="gedimmt">Geräte aktiv</td><td class="num">{{ p.deviceCount ?? '—' }}</td></tr>
              <tr v-if="p.maxDutyCycle !== null">
                <td class="gedimmt">max. Duty-Cycle</td>
                <td class="num" :class="p.maxDutyCycle.percent >= 80 ? 'schwach' : p.maxDutyCycle.percent >= 50 ? 'mittel' : ''">
                  {{ p.maxDutyCycle.percent.toFixed(1) }} %
                </td>
              </tr>
              <tr><td class="gedimmt">Version</td><td class="num">{{ p.version ?? '—' }}</td></tr>
            </tbody>
          </table>
          <div
            v-if="p.zeitdriftMs !== null && Math.abs(p.zeitdriftMs) > uebersicht.driftWarnMs"
            class="meldung fehler"
            style="margin-bottom: 0"
          >
            ⚠ Uhr weicht {{ (p.zeitdriftMs / 1000).toFixed(1) }} s ab — NTP prüfen!
          </div>
        </template>

        <template v-else>
          <div class="wert schwach" style="font-size: 1.05rem">nicht erreichbar</div>
          <div class="fussnote">{{ p.fehler }}</div>
        </template>
      </div>
    </div>
    <div class="fussnote">
      Alle 5 Sekunden aktualisiert; Peer-Abfragen sind serverseitig kurz
      gecacht. Ein ausgefallener Standort stört die Übersicht nicht.
    </div>
  </template>
</template>
