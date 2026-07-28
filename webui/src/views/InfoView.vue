<script setup lang="ts">
import { ref } from 'vue';
import { holeHealth, holeKonfiguration, holeSnapshot } from '../api.ts';
import type { Health, Konfiguration, Snapshot } from '../api.ts';
import { datumZeit, dauer } from '../format.ts';
import { nutzeTakt } from '../takt.ts';

const health = ref<Health | null>(null);
const konfig = ref<Konfiguration | null>(null);
const snapshot = ref<Snapshot | null>(null);

nutzeTakt(async () => {
  const [h, s] = await Promise.all([holeHealth(), holeSnapshot()]);
  health.value = h;
  snapshot.value = s;
  if (konfig.value === null) konfig.value = await holeKonfiguration();
}, 5000);
</script>

<template>
  <h2>Info</h2>

  <div class="kacheln" v-if="health !== null">
    <div class="kachel">
      <div class="titel">Core-Version</div>
      <div class="wert">{{ health.version }}</div>
    </div>
    <div class="kachel">
      <div class="titel">Laufzeit</div>
      <div class="wert">{{ dauer(health.now - health.boottime) }}</div>
      <div class="zusatz">gestartet {{ datumZeit(health.boottime) }}</div>
    </div>
    <div class="kachel" v-if="konfig !== null">
      <div class="titel">Datenbank</div>
      <div class="wert">{{ (konfig.spiffssizekb / 1024).toFixed(1) }} MB</div>
      <div class="zusatz">SQLite, WAL-Modus</div>
    </div>
    <div class="kachel" v-if="konfig !== null">
      <div class="titel">Host</div>
      <div class="wert" style="font-size: 1.05rem">{{ konfig.hostname }}</div>
      <div class="zusatz">{{ konfig.ip }} · {{ konfig.macaddress }}</div>
    </div>
  </div>

  <div class="panel" v-if="snapshot !== null">
    <h3 style="margin-top: 0">Empfang seit Dienststart</h3>
    <div class="scrollbar">
      <table class="daten">
        <tbody>
          <tr><td>Zeilen gesamt</td><td class="num">{{ snapshot.ingest.lines }}</td></tr>
          <tr><td>Telegramme</td><td class="num">{{ snapshot.ingest.telegrams }}</td></tr>
          <tr><td>Rauschproben</td><td class="num">{{ snapshot.ingest.noise }}</td></tr>
          <tr><td>verworfen (kein Rahmen, Prüf-Fehler …)</td>
              <td class="num">{{ Object.values(snapshot.ingest.ignored).reduce((a, b) => a + b, 0) }}</td></tr>
          <tr><td>durch Überlauf verloren</td><td class="num">{{ snapshot.ingest.droppedLines }}</td></tr>
          <tr><td>Neuverbindungen</td><td class="num">{{ snapshot.ingest.reconnects }}</td></tr>
          <tr><td>in Datenbank geschrieben</td><td class="num">{{ snapshot.recorder.writtenTelegrams }}</td></tr>
          <tr><td>Persistenz-Fehler</td><td class="num">{{ snapshot.persistErrors }}</td></tr>
          <tr v-if="snapshot.devList !== null">
            <td>Geräteliste ({{ snapshot.devList.entries ?? 0 }} Einträge)</td>
            <td class="num">
              {{ snapshot.devList.source === 'ccu' ? 'live von der CCU'
                 : snapshot.devList.source === 'cache' ? 'aus dem Datei-Cache' : 'noch nicht geladen' }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>

  <div class="panel">
    <h3 style="margin-top: 0">Herkunft und Dank</h3>
    <p>
      Der AskSin-Analyzer steht auf den Schultern dieser Projekte — die
      Namensnennung ist Lizenzbestandteil und Ehrensache:
    </p>
    <ul>
      <li>
        <a href="https://github.com/jp112sdl/AskSinAnalyzer" target="_blank" rel="noopener">AskSinAnalyzer</a>
        (jp112sdl) — Idee, Sniffer-Firmware und die originale Weboberfläche (CC BY-NC-SA 3.0)
      </li>
      <li>
        <a href="https://github.com/psi-4ward/AskSinAnalyzerXS" target="_blank" rel="noopener">AskSinAnalyzerXS</a>
        (psi-4ward) — Referenz für Telegramm-Parser und Duty-Cycle-Formel (CC BY-NC-SA 4.0)
      </li>
      <li>
        <a href="https://github.com/pa-pa/AskSinPP" target="_blank" rel="noopener">AskSinPP</a>
        (pa-pa) — die Funkbibliothek der Sniffer-Firmware (CC BY-NC-SA)
      </li>
      <li>der-pw — Vorarbeit zur Raspberry-Pi-Platine (CC BY-NC-SA 4.0)</li>
    </ul>
    <p class="fussnote">
      Diese Oberfläche ist ein funktionaler Nachbau mit eigenem Code (MIT);
      Diagramme: Apache ECharts (Apache-2.0). Platine und Firmware des
      Projekts bleiben CC BY-NC-SA.
    </p>
  </div>
</template>
