<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { authToken, holeKonfiguration, sende, setzeAuthToken } from '../api.ts';

const standort = ref('');
const ccuip = ref('');
const ntp = ref('');
const token = ref(authToken());
const demoAktiv = ref(false);
const meldung = ref<{ art: 'ok' | 'fehler'; text: string } | null>(null);
const beschaeftigt = ref(false);

onMounted(async () => {
  try {
    const c = await holeKonfiguration();
    standort.value = c.standort;
    ccuip.value = c.ccuip;
    ntp.value = c.ntp;
    demoAktiv.value = c.demo === 1;
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
  aktion('Gespeichert', () =>
    sende('/setConfig', {
      standort: standort.value,
      ccuip: ccuip.value,
      ntp: ntp.value,
    }));

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

const demoUmschalten = (): Promise<void> | undefined => {
  const frage = demoAktiv.value
    ? 'Demo-Modus ausschalten? Der Dienst startet neu und liest wieder die echte Hardware.'
    : 'Demo-Modus einschalten? Der Dienst startet neu und zeigt simulierte Daten ' +
      '(eigene Demo-Datenbank — echte Aufzeichnungen bleiben unberührt).';
  if (!window.confirm(frage)) return undefined;
  return aktion(
    'Umgeschaltet — der Dienst startet neu, die Seite verbindet sich gleich wieder',
    async () => {
      await sende('/setConfig', { demo: demoAktiv.value ? '0' : '1' });
      demoAktiv.value = !demoAktiv.value;
    },
  );
};
</script>

<template>
  <h2>Einstellungen</h2>

  <div class="meldung" v-if="meldung !== null" :class="meldung.art">{{ meldung.text }}</div>

  <div class="panel">
    <h3 style="margin-top: 0">Standort &amp; Zentrale</h3>
    <label class="feld">
      <span class="name">Standortname dieses Analyzers — unterscheidet mehrere Geräte im Verbund</span>
      <input type="text" v-model="standort" placeholder="z. B. Keller, DG-Ost" />
    </label>
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
    <h3 style="margin-top: 0">Demo-Modus</h3>
    <p style="margin-top: 0">
      Simulierte Anlage mit rund 15 Geräten — läuft ohne Homematic-Zentrale
      und ohne gesteckte Platine durch die komplette echte Kette (Parser,
      Statistik, Datenbank). Ideal zum Ausprobieren und Vorführen.
      Zustand: <strong :class="demoAktiv ? 'mittel' : 'gedimmt'">
        {{ demoAktiv ? 'aktiv' : 'aus' }}</strong>
    </p>
    <button :disabled="beschaeftigt" @click="demoUmschalten">
      {{ demoAktiv ? 'Demo-Modus ausschalten …' : 'Demo-Modus einschalten …' }}
    </button>
    <div class="fussnote">
      Beim Umschalten startet der Dienst neu. Die Simulation schreibt in eine
      eigene Demo-Datenbank; echte Aufzeichnungen bleiben unberührt.
    </div>
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
