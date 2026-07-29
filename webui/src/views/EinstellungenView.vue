<script setup lang="ts">
import { onMounted, onUnmounted, reactive, ref } from 'vue';
import {
  authToken,
  bestaetigeNetzwerk,
  holeKonfiguration,
  holeNetzwerk,
  holeNetzwerkStatus,
  sende,
  sendeNetzwerk,
  setzeAuthToken,
} from '../api.ts';
import type { NetzwerkStatus, NetzwerkZustand } from '../api.ts';

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
  void netzLaden();
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

// ---- Netzwerk (M7.6) -----------------------------------------------------

const netz = ref<NetzwerkZustand | null>(null);
const netzFehlt = ref(false);
const netzStatus = ref<NetzwerkStatus | null>(null);
const netzMeldung = ref('');
const restSekunden = ref(0);
const netzForm = reactive({
  methode: 'dhcp' as 'dhcp' | 'statisch',
  address: '',
  prefix: 24,
  gateway: '',
  dns: '',
  hostname: '',
  ntp: '',
});
let netzTakt: number | undefined;

onUnmounted(() => window.clearInterval(netzTakt));

async function netzLaden(): Promise<void> {
  try {
    const z = await holeNetzwerk();
    netz.value = z;
    netzForm.methode = z.methode === 'statisch' ? 'statisch' : 'dhcp';
    netzForm.address = z.adressen[0]?.address ?? '';
    netzForm.prefix = z.adressen[0]?.prefix ?? 24;
    netzForm.gateway = z.gateway ?? '';
    netzForm.dns = z.dns.join(', ');
    netzForm.hostname = z.hostname;
    netzForm.ntp = z.ntp.server ?? '';
    const s = await holeNetzwerkStatus();
    if (s.running) {
      netzStatus.value = s;
      netzStatusVerfolgen();
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('501')) netzFehlt.value = true;
  }
}

function netzStatusVerfolgen(): void {
  window.clearInterval(netzTakt);
  netzTakt = window.setInterval(() => {
    void (async () => {
      try {
        const s = await holeNetzwerkStatus();
        netzStatus.value = s;
        if (s.step === 'probe' && typeof s.deadline === 'number') {
          restSekunden.value = Math.max(0, Math.round((s.deadline - Date.now()) / 1000));
        }
        if (!s.running && s.step !== undefined) {
          window.clearInterval(netzTakt);
          netzMeldung.value =
            s.ok === true
              ? 'Netzwerkeinstellungen dauerhaft übernommen.'
              : s.step === 'rollback'
                ? 'Nicht bestätigt — der vorherige Zustand wurde wiederhergestellt.'
                : `Fehlgeschlagen (${s.step}).`;
          await netzLaden();
        }
      } catch {
        // Adresse wechselt gerade / Dienst kurz weg — weiter versuchen.
      }
    })();
  }, 1500);
}

const netzUebernehmen = (): Promise<void> | undefined => {
  const warnung =
    'Netzwerkeinstellungen jetzt übernehmen?\n\n' +
    'Sie gelten zunächst 90 Sekunden AUF PROBE. Wird in dieser Zeit nicht ' +
    'bestätigt (Knopf „Einstellungen behalten"), stellt der Pi den vorherigen ' +
    'Zustand automatisch wieder her.\n\n' +
    'Bei geänderter IP-Adresse musst du die Weboberfläche unter der NEUEN ' +
    'Adresse öffnen und dort bestätigen.';
  if (!window.confirm(warnung)) return undefined;
  return aktion('Auftrag übermittelt — Probezeit läuft', async () => {
    await sendeNetzwerk({
      method: netzForm.methode,
      ...(netzForm.methode === 'statisch'
        ? {
            address: netzForm.address.trim(),
            prefix: Number(netzForm.prefix),
            gateway: netzForm.gateway.trim(),
            dns: netzForm.dns.split(',').map((d) => d.trim()).filter((d) => d !== ''),
          }
        : {}),
      ...(netzForm.hostname.trim() !== (netz.value?.hostname ?? '')
        ? { hostname: netzForm.hostname.trim() }
        : {}),
      ...(netzForm.ntp.trim() !== (netz.value?.ntp.server ?? '')
        ? { ntp: netzForm.ntp.trim() }
        : {}),
    });
    netzStatus.value = { running: true, step: 'probe' };
    netzStatusVerfolgen();
  });
};

const netzBestaetigen = (): Promise<void> =>
  aktion('Bestätigt', async () => {
    await bestaetigeNetzwerk();
  });

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
      <span class="name">Standortname — reines Anzeige-Etikett für den Verbund; ändert den Hostnamen des Pi NICHT</span>
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

  <div class="panel" v-if="!netzFehlt">
    <h3 style="margin-top: 0">Netzwerk</h3>

    <div class="scrollbar" v-if="netz !== null">
      <table class="daten" style="max-width: 34rem; margin-bottom: 0.9rem">
        <tbody>
          <tr>
            <td class="gedimmt">Methode</td>
            <td>{{ netz.methode === 'dhcp' ? 'DHCP' : netz.methode === 'statisch' ? 'Statisch' : 'unbekannt' }}</td>
          </tr>
          <tr>
            <td class="gedimmt">Adresse{{ netz.methode === 'dhcp' ? ' (per DHCP zugewiesen)' : '' }}</td>
            <td>{{ netz.adressen.map((a) => `${a.address}/${a.prefix}`).join(', ') || '—' }}</td>
          </tr>
          <tr>
            <td class="gedimmt">Gateway{{ netz.methode === 'dhcp' ? ' (per DHCP)' : '' }}</td>
            <td>{{ netz.gateway ?? '—' }}</td>
          </tr>
          <tr>
            <td class="gedimmt">DNS{{ netz.methode === 'dhcp' ? ' (per DHCP)' : '' }}</td>
            <td>{{ netz.dns.join(', ') || '—' }}</td>
          </tr>
          <tr><td class="gedimmt">Hostname</td><td>{{ netz.hostname }}</td></tr>
          <tr>
            <td class="gedimmt">NTP</td>
            <td>
              {{ netz.ntp.server ?? 'Systemvorgabe' }}
              <span :class="netz.ntp.sync === true ? 'gut' : 'mittel'">
                {{ netz.ntp.sync === true ? '· synchron' : netz.ntp.sync === false ? '· NICHT synchron' : '' }}
              </span>
            </td>
          </tr>
          <tr><td class="gedimmt">Schnittstelle</td><td>{{ netz.iface ?? '—' }} <span class="gedimmt">{{ netz.verbindung ? `(${netz.verbindung})` : '' }}</span></td></tr>
        </tbody>
      </table>
    </div>

    <div class="meldung fehler" v-if="netz !== null && !netz.aenderbar">
      Ändern hier nicht möglich: {{ netz.grund }}
    </div>

    <template v-if="netz !== null && netz.aenderbar && netzStatus?.running !== true">
      <div class="zeile" style="margin-bottom: 0.6rem">
        <label><input type="radio" value="dhcp" v-model="netzForm.methode" /> DHCP</label>
        <label><input type="radio" value="statisch" v-model="netzForm.methode" /> Statisch</label>
      </div>
      <template v-if="netzForm.methode === 'statisch'">
        <div class="zeile">
          <label class="feld" style="flex: 2">
            <span class="name">IP-Adresse</span>
            <input type="text" v-model="netzForm.address" placeholder="192.168.1.71" />
          </label>
          <label class="feld" style="width: 6rem">
            <span class="name">Präfix</span>
            <input type="text" v-model.number="netzForm.prefix" placeholder="24" />
          </label>
        </div>
        <label class="feld">
          <span class="name">Gateway</span>
          <input type="text" v-model="netzForm.gateway" placeholder="192.168.1.1" />
        </label>
        <label class="feld">
          <span class="name">DNS (kommagetrennt)</span>
          <input type="text" v-model="netzForm.dns" placeholder="192.168.1.1, 9.9.9.9" />
        </label>
      </template>
      <label class="feld">
        <span class="name">Hostname (Netzwerkname des Pi — bewusste Änderung)</span>
        <input type="text" v-model="netzForm.hostname" />
      </label>
      <label class="feld">
        <span class="name">NTP-Server (leer = Systemvorgabe)</span>
        <input type="text" v-model="netzForm.ntp" placeholder="z. B. pool.ntp.org" />
      </label>
      <button class="gefahr" :disabled="beschaeftigt" @click="netzUebernehmen">
        Netzwerk übernehmen … (90 s Probezeit)
      </button>
    </template>

    <div class="meldung ok" v-if="netzStatus?.running === true">
      <template v-if="netzStatus.step === 'probe'">
        <strong>Probezeit läuft — noch {{ restSekunden }} s.</strong>
        Funktioniert die Verbindung (ggf. unter der neuen Adresse)?
        <button class="primaer" style="margin-left: 0.6rem" @click="netzBestaetigen">
          Einstellungen behalten
        </button>
      </template>
      <template v-else>Netzwerk-Auftrag läuft — Schritt: {{ netzStatus.step ?? '…' }}</template>
    </div>
    <div class="meldung" :class="netzMeldung.includes('wiederhergestellt') || netzMeldung.includes('Fehlgeschlagen') ? 'fehler' : 'ok'" v-if="netzMeldung !== ''">
      {{ netzMeldung }}
    </div>
    <div class="fussnote">
      Änderungen gelten erst nach Bestätigung dauerhaft — ohne Bestätigung
      stellt der Pi nach 90 s automatisch den vorherigen Zustand wieder her
      (Schutz vor dem Aussperren). Details: docs/netzwerkeinstellungen.md.
    </div>
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
