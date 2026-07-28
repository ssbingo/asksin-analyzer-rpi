<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { authToken, holeKonfiguration, sende, setzeAuthToken } from '../api.ts';

const ccuip = ref('');
const ntp = ref('');
const token = ref(authToken());
const meldung = ref<{ art: 'ok' | 'fehler'; text: string } | null>(null);
const beschaeftigt = ref(false);

onMounted(async () => {
  try {
    const c = await holeKonfiguration();
    ccuip.value = c.ccuip;
    ntp.value = c.ntp;
  } catch {
    meldung.value = { art: 'fehler', text: 'Konfiguration nicht abrufbar — Core erreichbar?' };
  }
});

async function aktion(name: string, fn: () => Promise<unknown>): Promise<void> {
  beschaeftigt.value = true;
  meldung.value = null;
  try {
    await fn();
    meldung.value = { art: 'ok', text: `${name} — erledigt.` };
  } catch (err) {
    meldung.value = { art: 'fehler', text: `${name}: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    beschaeftigt.value = false;
  }
}

const speichern = (): Promise<void> =>
  aktion('Gespeichert', () => sende('/setConfig', { ccuip: ccuip.value, ntp: ntp.value }));

function tokenSpeichern(): void {
  setzeAuthToken(token.value.trim());
  meldung.value = { art: 'ok', text: 'Auth-Token lokal gespeichert (nur in diesem Browser).' };
}

const dbLeeren = (): Promise<void> | undefined =>
  window.confirm('Wirklich ALLE aufgezeichneten Daten löschen? Das ist endgültig.')
    ? aktion('Datenbank geleert', () => sende('/formatspiffs'))
    : undefined;

const neustart = (): Promise<void> | undefined =>
  window.confirm('Core-Dienst neu starten?')
    ? aktion('Neustart ausgelöst', () => sende('/reboot'))
    : undefined;
</script>

<template>
  <h2>Einstellungen</h2>

  <div class="meldung" v-if="meldung !== null" :class="meldung.art">{{ meldung.text }}</div>

  <div class="panel">
    <h3 style="margin-top: 0">Zentrale</h3>
    <label class="feld">
      <span class="name">CCU / RaspberryMatic (IP oder Hostname) — Quelle der Gerätenamen</span>
      <input type="text" v-model="ccuip" placeholder="z. B. 192.168.1.50" />
    </label>
    <label class="feld">
      <span class="name">NTP-Server (optional, sonst Systemvorgabe)</span>
      <input type="text" v-model="ntp" placeholder="z. B. pool.ntp.org" />
    </label>
    <button class="primaer" :disabled="beschaeftigt" @click="speichern">Speichern</button>
    <div class="fussnote">
      Netzwerk und Hostname des Raspberry Pi werden bewusst nicht über die
      Weboberfläche verändert — dafür ist das Betriebssystem zuständig.
    </div>
  </div>

  <div class="panel">
    <h3 style="margin-top: 0">Zugriff</h3>
    <label class="feld">
      <span class="name">Auth-Token (nötig, wenn der Core mit Token-Pflicht läuft)</span>
      <input type="password" v-model="token" autocomplete="off" />
    </label>
    <button :disabled="beschaeftigt" @click="tokenSpeichern">Token speichern</button>
  </div>

  <div class="panel">
    <h3 style="margin-top: 0">Daten</h3>
    <div class="zeile">
      <a class="knopf" href="/downloadcsv">Tages-CSV herunterladen</a>
      <button class="gefahr" :disabled="beschaeftigt" @click="dbLeeren">Datenbank leeren …</button>
      <button class="gefahr" :disabled="beschaeftigt" @click="neustart">Dienst neu starten …</button>
    </div>
  </div>
</template>
