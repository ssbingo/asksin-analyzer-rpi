<script setup lang="ts">
import { onUnmounted, ref } from 'vue';

import HandbuchFuss from '../components/HandbuchFuss.vue';
import {
  flasheFirmware,
  holeHealth,
  holeKonfiguration,
  holeSnapshot,
  holeUpdateStatus,
  holeUpdateVersionen,
  starteCoreUpdate,
} from '../api.ts';
import type { Health, Konfiguration, Snapshot, UpdateStatus, UpdateVersionen } from '../api.ts';
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

// ---- Software-Update -----------------------------------------------------

const versionen = ref<UpdateVersionen | null>(null);
const updateStatus = ref<UpdateStatus | null>(null);
const updateMeldung = ref('');
const sucht = ref(false);
let statusTakt: number | undefined;

onUnmounted(() => window.clearInterval(statusTakt));

async function updateSuchen(): Promise<void> {
  sucht.value = true;
  updateMeldung.value = '';
  try {
    const v = await holeUpdateVersionen();
    versionen.value = v;
    if (v.fehler !== undefined) updateMeldung.value = v.fehler;
  } catch (err) {
    updateMeldung.value = err instanceof Error ? err.message : String(err);
  } finally {
    sucht.value = false;
  }
}

function statusVerfolgen(): void {
  window.clearInterval(statusTakt);
  statusTakt = window.setInterval(() => {
    void (async () => {
      try {
        const s = await holeUpdateStatus();
        updateStatus.value = s;
        if (!s.running && s.step !== undefined) {
          window.clearInterval(statusTakt);
          updateMeldung.value =
            s.ok === true
              ? s.step === 'aktuell'
                ? 'Bereits aktuell.'
                : `Update fertig (${s.from} → ${s.to}).`
              : 'Update fehlgeschlagen — auf den vorherigen Stand zurückgerollt.';
          versionen.value = null;
        }
      } catch {
        // Dienst startet gerade neu — weiter versuchen.
      }
    })();
  }, 2000);
}

async function updateInstallieren(): Promise<void> {
  if (!window.confirm('Update installieren? Der Dienst startet dabei neu; bei Problemen wird automatisch zurückgerollt.')) return;
  updateMeldung.value = '';
  try {
    await starteCoreUpdate();
    updateStatus.value = { running: true, step: 'angestoßen' };
    statusVerfolgen();
  } catch (err) {
    updateMeldung.value = err instanceof Error ? err.message : String(err);
  }
}

// ---- Sniffer-Firmware ----------------------------------------------------

const hexDatei = ref<File | null>(null);
const flashLog = ref('');
const flasht = ref(false);

function dateiGewaehlt(e: Event): void {
  hexDatei.value = (e.target as HTMLInputElement).files?.[0] ?? null;
}

async function firmwareFlashen(): Promise<void> {
  const datei = hexDatei.value;
  if (datei === null) return;
  if (!window.confirm(`„${datei.name}" auf den 328P flashen? Die Aufzeichnung pausiert währenddessen.`)) return;
  flasht.value = true;
  flashLog.value = 'Flashe …';
  try {
    const erg = await flasheFirmware(datei);
    flashLog.value = (erg.ok ? '✔ Erfolgreich\n\n' : '✖ Fehlgeschlagen\n\n') + erg.log;
  } catch (err) {
    flashLog.value = `✖ ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    flasht.value = false;
  }
}
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
    <h3 style="margin-top: 0">Software-Update</h3>
    <div class="zeile">
      <button :disabled="sucht" @click="updateSuchen">Nach Update suchen</button>
      <template v-if="versionen !== null && versionen.fehler === undefined">
        <span class="gedimmt">installiert: {{ versionen.version }} ({{ versionen.commit ?? '?' }})</span>
        <span v-if="versionen.updateVerfuegbar" class="mittel">
          Update verfügbar ({{ versionen.verfuegbarCommit }})
        </span>
        <span v-else-if="versionen.verfuegbarCommit !== null" class="gut">aktuell</span>
        <span v-else class="gedimmt">Gegenstelle nicht erreichbar</span>
        <button
          v-if="versionen.updateVerfuegbar"
          class="primaer"
          :disabled="updateStatus?.running === true"
          @click="updateInstallieren"
        >Update installieren …</button>
      </template>
    </div>
    <div class="meldung ok" v-if="updateStatus?.running === true">
      Update läuft — Schritt: {{ updateStatus.step ?? '…' }}. Der Dienst startet
      dabei neu; diese Seite verbindet sich automatisch wieder.
    </div>
    <div class="meldung" :class="updateMeldung.includes('fehlgeschlagen') || updateMeldung.includes('Nicht erlaubt') || updateMeldung.includes('git') ? 'fehler' : 'ok'" v-if="updateMeldung !== ''">
      {{ updateMeldung }}
    </div>
    <div class="fussnote">
      Atomar mit automatischem Rollback: Kommt der Dienst nach dem Update nicht
      gesund hoch, wird der vorherige Stand wiederhergestellt.
    </div>
  </div>

  <div class="panel">
    <h3 style="margin-top: 0">Sniffer-Firmware (328P)</h3>

    <template v-if="health?.sniffer">
      <div
        class="meldung"
        :class="health.sniffer.befund.art === 'passt' ? 'ok' : 'fehler'"
      >{{ health.sniffer.befund.text }}</div>

      <div class="daten" v-if="health.sniffer.firmware">
        <div class="zeile">
          <span class="name">Fassung</span>
          <span class="wert">
            Firmware {{ health.sniffer.firmware.firmware }},
            Protokoll {{ health.sniffer.firmware.protokoll }},
            {{ health.sniffer.firmware.taktMHz }} MHz
          </span>
        </div>
        <div class="zeile">
          <span class="name">Funkmodul</span>
          <span class="wert" v-if="health.sniffer.firmware.cc1101 !== null">
            antwortet (CC1101 0x{{ health.sniffer.firmware.cc1101.toString(16).toUpperCase() }})
          </span>
          <span class="wert" v-else><strong>antwortet nicht</strong></span>
        </div>
      </div>

      <div class="daten" v-if="health.sniffer.erweitert">
        <div class="zeile">
          <span class="name">Zeilen geprüft</span>
          <span class="wert num">{{ health.sniffer.folge.gesehen }}</span>
        </div>
        <div class="zeile">
          <span class="name">davon verloren</span>
          <span class="wert num">
            {{ health.sniffer.folge.verloren }}
            <template v-if="health.sniffer.folge.verlustProzent !== null">
              ({{ health.sniffer.folge.verlustProzent.toFixed(2) }} %)
            </template>
          </span>
        </div>
        <div class="zeile" v-if="health.sniffer.folge.neuanfaenge > 0">
          <span class="name">Firmware-Neustarts</span>
          <span class="wert num">{{ health.sniffer.folge.neuanfaenge }}</span>
        </div>
      </div>

      <div class="fussnote" v-if="health.sniffer.erweitert">
        Verlorene Zeilen werden aus den Folgenummern errechnet, nicht
        geschätzt: Fehlt zwischen 0041 und 0045 etwas, sind es genau drei.
        Die Zähler beginnen bei jedem Verbindungsaufbau neu.
      </div>
    </template>

    <div class="zeile">
      <input type="file" accept=".hex" @change="dateiGewaehlt" />
      <button :disabled="flasht || hexDatei === null" @click="firmwareFlashen">
        Firmware flashen …
      </button>
    </div>
    <pre v-if="flashLog !== ''" style="white-space: pre-wrap; font-size: 0.8rem; color: var(--muted); margin-bottom: 0">{{ flashLog }}</pre>
    <div class="fussnote">
      Intel-HEX-Datei (z. B. AskSinSniffer328P.hex). Die Aufzeichnung pausiert
      während des Flashens; der Reset läuft am HAT über GPIO4, am USB-Port
      über DTR. Im Demo-Modus nicht verfügbar.
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

  <HandbuchFuss hinweis="Kapitel 20 beschreibt Update und Firmware-Flash, Kapitel 23 die Fehlersuche." />
</template>
