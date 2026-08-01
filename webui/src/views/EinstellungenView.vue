<script setup lang="ts">
import { onBeforeUnmount, onMounted, onUnmounted, reactive, ref } from 'vue';

import HandbuchFuss from '../components/HandbuchFuss.vue';

import GeheimFeld from '../components/GeheimFeld.vue';
import {
  aenderePeer,
  authToken,
  bestaetigeNetzwerk,
  holeKonfiguration,
  holeNetzwerk,
  holeNetzwerkStatus,
  holeInflux,
  holeAlarmziel,
  holeLangzeit,
  holeStatusAnzeige,
  holeVerbundPeers,
  sende,
  sendeInflux,
  sendeAlarmziel,
  testeAlarmziel,
  sendeLangzeit,
  sendeNetzwerk,
  sendeStatusAnzeige,
  setzeAuthToken,
} from '../api.ts';
import type {
  Alarmkanal,
  AlarmzielZustand,
  LangzeitZustand,
  LedMethode,
  NetzwerkStatus,
  NetzwerkZustand,
  VerbundPeerEintrag,
} from '../api.ts';

const standort = ref('');
const ccuip = ref('');
const token = ref(authToken());
const demoAktiv = ref(false);
const meldung = ref<{ art: 'ok' | 'fehler'; text: string } | null>(null);
const beschaeftigt = ref(false);

onMounted(async () => {
  try {
    const c = await holeKonfiguration();
    standort.value = c.standort;
    ccuip.value = c.ccuip;
    demoAktiv.value = c.demo === 1;
  } catch {
    meldung.value = { art: 'fehler', text: 'Konfiguration nicht abrufbar — Core erreichbar?' };
  }
  void netzLaden();
  void peersLaden();
  void anzeigeLaden();
  void influxLaden();
  void langzeitLaden();
  void alarmLaden();
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

// ---- Verbund-Peers -------------------------------------------------------

const peers = ref<VerbundPeerEintrag[]>([]);
const neuerPeer = reactive({ url: '', name: '', token: '' });

async function peersLaden(): Promise<void> {
  try {
    peers.value = (await holeVerbundPeers()).peers;
  } catch {
    /* ältere Core-Version ohne Peer-Verwaltung */
  }
}

const peerHinzufuegen = (): Promise<void> =>
  aktion('Analyzer verknüpft', async () => {
    await aenderePeer({
      aktion: 'hinzufuegen',
      url: neuerPeer.url.trim(),
      ...(neuerPeer.name.trim() === '' ? {} : { name: neuerPeer.name.trim() }),
      ...(neuerPeer.token === '' ? {} : { token: neuerPeer.token }),
    });
    neuerPeer.url = '';
    neuerPeer.name = '';
    neuerPeer.token = '';
    await peersLaden();
  });

const peerEntfernen = (url: string): Promise<void> | undefined =>
  window.confirm(`„${url}" aus dem Verbund entfernen?`)
    ? aktion('Analyzer entfernt', async () => {
        await aenderePeer({ aktion: 'entfernen', url });
        await peersLaden();
      })
    : undefined;

// ---- Status-LED / OLED (M11) ---------------------------------------------

const anzeige = reactive({
  led: false,
  // Methode wird aus der Konfiguration übernommen und beim Speichern
  // zurückgeschrieben — sonst würde ein Pi 4 (PWM) still auf SPI kippen.
  methode: 'ws2812-spi' as LedMethode,
  oled: false,
  helligkeit: 40,
});
const anzeigeVerfuegbar = ref(false);

async function anzeigeLaden(): Promise<void> {
  try {
    const z = await holeStatusAnzeige();
    anzeige.led = z.konfig.led !== 'aus';
    if (z.konfig.led !== 'aus') anzeige.methode = z.konfig.led;
    anzeige.oled = z.konfig.oled;
    anzeige.helligkeit = z.konfig.helligkeit;
    anzeigeVerfuegbar.value = true;
  } catch {
    /* ältere Core-Version */
  }
}

const anzeigeSpeichern = (): Promise<void> =>
  aktion('Statusanzeige umkonfiguriert — sofort wirksam', () =>
    sendeStatusAnzeige({
      led: anzeige.led ? anzeige.methode : 'aus',
      oled: anzeige.oled,
      helligkeit: Number(anzeige.helligkeit),
    }));

// ---- Alarmziele (M14.2) --------------------------------------------------

const alarm = reactive({
  aktiv: false,
  kanal: 'iobroker' as Alarmkanal,
  iobrokerUrl: '',
  iobrokerToken: '',
  empfaenger: '',
  smtpHost: '',
  smtpPort: 587,
  benutzer: '',
  passwort: '',
  absender: '',
  botToken: '',
  chatId: '',
});
const alarmZustand = ref<AlarmzielZustand | null>(null);
const alarmTestText = ref('');
const alarmTestFehler = ref(false);
let alarmTakt: ReturnType<typeof setInterval> | null = null;

async function alarmLaden(): Promise<void> {
  try {
    const z = await holeAlarmziel();
    alarmZustand.value = z;
    // Solange die Uebernahme laeuft, nachfragen. Ohne das blieb "wird
    // uebernommen" stehen, bis jemand die Seite neu lud — auch dann, wenn
    // laengst alles fertig war.
    if (z.laeuft && alarmTakt === null) {
      alarmTakt = setInterval(() => void alarmLaden(), 2000);
    } else if (!z.laeuft && alarmTakt !== null) {
      clearInterval(alarmTakt);
      alarmTakt = null;
    }
    alarm.aktiv = z.aktiv;
    alarm.kanal = z.kanal;
    alarm.iobrokerUrl = z.iobroker.url;
    alarm.iobrokerToken = z.iobroker.token;
    alarm.empfaenger = z.email.empfaenger;
    alarm.smtpHost = z.email.smtpHost;
    alarm.smtpPort = z.email.smtpPort;
    alarm.benutzer = z.email.benutzer;
    alarm.absender = z.email.absender;
    alarm.chatId = z.telegram.chatId;
    // Die Geheimnisse kommen mit und werden eingetragen: Wer sein Passwort
    // sucht, soll es hier nachsehen koennen. Das Augensymbol daneben schaltet
    // zwischen versteckt und lesbar um.
    alarm.passwort = z.email.passwort;
    alarm.botToken = z.telegram.botToken;
  } catch {
    /* ältere Core-Version */
  }
}

async function alarmTesten(): Promise<void> {
  alarmTestText.value = 'Verbinde mit dem Postausgangsserver …';
  alarmTestFehler.value = false;
  try {
    alarmTestText.value = await testeAlarmziel({
      email: {
        empfaenger: alarm.empfaenger.trim(),
        smtpHost: alarm.smtpHost.trim(),
        smtpPort: Number(alarm.smtpPort),
        benutzer: alarm.benutzer.trim(),
        passwort: alarm.passwort,
        absender: alarm.absender.trim(),
      },
    });
  } catch (e) {
    alarmTestFehler.value = true;
    // Die Serverantwort woertlich stehen lassen — sie ist die eigentliche
    // Auskunft. "535 Authentication credentials invalid" sagt einem Menschen,
    // was zu tun ist; ein rotes Kreuz sagt nichts.
    alarmTestText.value = e instanceof Error ? e.message : String(e);
  }
}

const alarmSpeichern = (): Promise<void> =>
  aktion('Alarmziel gespeichert — Grafana übernimmt es gleich', async () => {
    await sendeAlarmziel({
      aktiv: alarm.aktiv,
      kanal: alarm.kanal,
      iobroker: { url: alarm.iobrokerUrl.trim(), token: alarm.iobrokerToken },
      email: {
        empfaenger: alarm.empfaenger.trim(),
        smtpHost: alarm.smtpHost.trim(),
        smtpPort: Number(alarm.smtpPort),
        benutzer: alarm.benutzer.trim(),
        passwort: alarm.passwort,
        absender: alarm.absender.trim(),
      },
      telegram: { botToken: alarm.botToken.trim(), chatId: alarm.chatId.trim() },
    });
    await alarmLaden();
  });

// ---- Langzeitdaten vor Ort (M14) -----------------------------------------
//
// Der ganze Abschnitt erscheint nur auf dem Master. Beim Client wird er
// ausgeblendet — die eigentliche Zusicherung gibt aber der Server, der
// entsprechende Auftraege ablehnt.

const langzeit = ref<LangzeitZustand | null>(null);
let langzeitTakt: ReturnType<typeof setInterval> | null = null;

async function langzeitLaden(): Promise<void> {
  try {
    langzeit.value = await holeLangzeit();
    // Waehrend einer Installation haeufiger nachsehen: Sie dauert Minuten,
    // und ohne Rueckmeldung sieht die Seite aus, als sei nichts passiert.
    if (langzeit.value.laeuft && langzeitTakt === null) {
      langzeitTakt = setInterval(() => void langzeitLaden(), 3000);
    } else if (!langzeit.value.laeuft && langzeitTakt !== null) {
      clearInterval(langzeitTakt);
      langzeitTakt = null;
    }
  } catch {
    /* ältere Core-Version — Abschnitt bleibt dann weg */
  }
}

onBeforeUnmount(() => {
  if (langzeitTakt !== null) clearInterval(langzeitTakt);
  if (alarmTakt !== null) clearInterval(alarmTakt);
});

const rolleSetzen = (rolle: 'master' | 'client'): Promise<void> =>
  aktion(`Rolle auf „${rolle}“ gesetzt`, async () => {
    await sendeLangzeit({ rolle });
    await langzeitLaden();
  });

const langzeitInstallieren = (): Promise<void> =>
  aktion('Einrichtung gestartet — das dauert einige Minuten', async () => {
    await sendeLangzeit({ aktion: 'installieren' });
    await langzeitLaden();
  });

// ---- Langzeitdaten / InfluxDB (M9.5) -------------------------------------

const influx = reactive({
  aktiv: false,
  url: '',
  org: '',
  bucket: 'asksin',
  token: '',
  intervallSekunden: 30,
  hatToken: false,
});
const influxVerfuegbar = ref(false);
const influxStatusText = ref('');

async function influxLaden(): Promise<void> {
  try {
    const z = await holeInflux();
    influx.aktiv = z.konfig.aktiv;
    influx.url = z.konfig.url;
    influx.org = z.konfig.org;
    influx.bucket = z.konfig.bucket;
    influx.intervallSekunden = z.konfig.intervallSekunden;
    influx.hatToken = z.konfig.hatToken;
    // Der Token kommt jetzt mit zurueck — nachschlagbar statt versteckt.
    influx.token = z.konfig.token;
    influxVerfuegbar.value = true;
    const s = z.status;
    if (s.aktiv) {
      influxStatusText.value =
        `${s.schreibvorgaenge ?? 0} Schreibvorgänge, ${s.fehler ?? 0} Fehler` +
        (s.letzterFehlerText ? ` — zuletzt: ${s.letzterFehlerText}` : '');
    } else {
      influxStatusText.value = '';
    }
  } catch {
    /* ältere Core-Version */
  }
}

const influxSpeichern = (): Promise<void> =>
  aktion('Langzeitdaten umkonfiguriert — sofort wirksam', async () => {
    await sendeInflux({
      aktiv: influx.aktiv,
      url: influx.url.trim(),
      org: influx.org.trim(),
      bucket: influx.bucket.trim(),
      token: influx.token,
      intervallSekunden: Number(influx.intervallSekunden),
    });
    influx.token = '';
    await influxLaden();
  });

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
    <button class="primaer" :disabled="beschaeftigt" @click="speichern">Speichern</button>
    <div class="fussnote">
      Netzwerk und Hostname des Raspberry Pi werden bewusst nicht über die
      Weboberfläche verändert — dafür ist das Betriebssystem zuständig.
    </div>
  </div>

  <div class="panel">
    <h3 style="margin-top: 0">Zugriff</h3>
    <GeheimFeld
      v-model="token"
      name="Auth-Token (nötig, wenn der Core mit Token-Pflicht läuft)" />
    <button :disabled="beschaeftigt" @click="tokenSpeichern">Token speichern</button>
  </div>

  <div class="panel">
    <h3 style="margin-top: 0">Verbund — weitere Analyzer verknüpfen</h3>
    <p style="margin-top: 0">
      Trage hier die anderen Analyzer des Hauses ein — dieser Analyzer zeigt
      dann unter <RouterLink to="/verbund">Verbund</RouterLink> alle Standorte,
      die Empfangsmatrix und die zusammengeführte Telegrammliste. Auf den
      übrigen Analyzern ist nichts einzutragen.
    </p>

    <table class="daten" style="max-width: 40rem; margin-bottom: 0.9rem" v-if="peers.length > 0">
      <tbody>
        <tr v-for="p in peers" :key="p.url">
          <td>{{ p.name ?? '—' }}</td>
          <td class="gedimmt">{{ p.url }}</td>
          <td><span class="chip" v-if="p.hatToken">Token</span>
              <span class="chip" v-if="p.quelle === 'config'" title="fest in der Konfigurationsdatei">fest</span></td>
          <td class="num">
            <button class="gefahr" v-if="p.quelle === 'ui'" :disabled="beschaeftigt"
                    @click="peerEntfernen(p.url)">Entfernen</button>
          </td>
        </tr>
      </tbody>
    </table>
    <p class="fussnote" v-else>Noch keine Analyzer verknüpft.</p>

    <div class="zeile">
      <label class="feld" style="flex: 2; margin-bottom: 0">
        <span class="name">Adresse des Analyzers</span>
        <input type="text" v-model="neuerPeer.url" placeholder="http://192.168.1.72:8080" />
      </label>
      <label class="feld" style="flex: 1; margin-bottom: 0">
        <span class="name">Name (optional)</span>
        <input type="text" v-model="neuerPeer.name" placeholder="z. B. OG" />
      </label>
      <GeheimFeld
        v-model="neuerPeer.token"
        name="Dessen Auth-Token (optional)"
        style="flex: 1; margin-bottom: 0" />
      <button class="primaer" style="align-self: flex-end"
              :disabled="beschaeftigt || neuerPeer.url.trim() === ''"
              @click="peerHinzufuegen">Verknüpfen</button>
    </div>
    <div class="fussnote">
      Sofort wirksam, kein Neustart. Der Name wird sonst automatisch vom
      Standort des anderen Analyzers übernommen; das Token wird nur für
      spätere Fernwartung (Flotten-Update) gebraucht und nie angezeigt.
    </div>
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
            <td class="gedimmt">NTP aktuell</td>
            <td>
              {{ netz.ntp.aktiv ?? netz.ntp.server ?? 'de.pool.ntp.org (Vorgabe)' }}
              <span :class="netz.ntp.sync === true ? 'gut' : 'mittel'">
                {{ netz.ntp.sync === true ? '· synchron' : netz.ntp.sync === false ? '· NICHT synchron' : '' }}
              </span>
              <span class="gedimmt" v-if="netz.ntp.server !== null && netz.ntp.aktiv !== null && netz.ntp.server !== netz.ntp.aktiv">
                (konfiguriert: {{ netz.ntp.server }})
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
        <span class="name">NTP-Server (leer = de.pool.ntp.org)</span>
        <input type="text" v-model="netzForm.ntp" placeholder="de.pool.ntp.org" />
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

  <div class="panel" v-if="anzeigeVerfuegbar">
    <h3 style="margin-top: 0">Status-LED &amp; OLED</h3>
    <p style="margin-top: 0">
      Zubehör an den Steckern J5–J7 der Platine: RGB-Status-LED (WS2812) und
      OLED-Anzeige mit Taster. Änderungen wirken sofort, ohne Neustart — die
      Live-Vorschau erscheint auf der <RouterLink to="/home">Übersicht</RouterLink>.
    </p>
    <div class="zeile" style="margin-bottom: 0.8rem">
      <label><input type="checkbox" v-model="anzeige.led" /> Status-LED (WS2812)</label>
      <label v-if="anzeige.led" class="zeile" style="gap: 0.4rem">
        Ansteuerung
        <select v-model="anzeige.methode">
          <option value="ws2812-spi">SPI / GPIO10 — Pi 5, Schalter SW1 auf SPI</option>
          <option value="ws2812-pwm">PWM / GPIO18 — Pi 3/4, Schalter SW1 auf PWM</option>
        </select>
      </label>
      <label><input type="checkbox" v-model="anzeige.oled" /> OLED-Anzeige</label>
      <label class="zeile" style="gap: 0.4rem">
        Helligkeit
        <input type="range" min="5" max="100" v-model.number="anzeige.helligkeit" />
        <span class="gedimmt">{{ anzeige.helligkeit }} %</span>
      </label>
    </div>
    <button class="primaer" :disabled="beschaeftigt" @click="anzeigeSpeichern">Speichern</button>
    <div class="fussnote">
      Voraussetzungen: I²C/SPI aktiviert (macht der Installer bei „Status-LED
      einrichten? Ja"; nachträglich: <code>sudo raspi-config</code> →
      Interface Options). Für die LED gilt: <strong>SPI</strong> läuft ohne
      Root und ist auf dem <strong>Pi 5</strong> der einzige Weg.
      <strong>PWM</strong> braucht abgeschaltetes Onboard-Audio und den Hilfsdienst
      <code>asksin-analyzer-led</code>; auf <strong>Pi 3/4</strong> ist das der
      stabile Weg, weil dort der SPI-Takt mit dem Kerntakt wandert. Wichtig:
      Der <strong>Schiebeschalter SW1</strong> auf der Platine muss zur hier
      gewählten Betriebsart passen. Gestörte Teile meldet die Übersicht.
    </div>
  </div>

  <div class="panel" v-if="langzeit !== null">
    <h3 style="margin-top: 0">Langzeitdaten vor Ort</h3>
    <p style="margin-top: 0">
      InfluxDB und Grafana auf diesem Gerät — dann bleiben die Daten im Haus
      und es braucht keinen zweiten Rechner. Das ist eine
      <strong>Zusatzoption</strong>; der Weg über eine externe Datenbank
      bleibt daneben bestehen.
    </p>

    <div class="zeile" style="margin-bottom: 0.6rem">
      <label class="feld" style="max-width: 18rem">
        <span class="name">Rolle im Verbund</span>
        <select
          :value="langzeit.gewuenscht"
          :disabled="beschaeftigt || !langzeit.masterFaehig.faehig"
          @change="rolleSetzen((($event.target as HTMLSelectElement).value) as 'master' | 'client')"
        >
          <option value="master">Master — speichert die Langzeitdaten</option>
          <option value="client">Client — liefert nur zu</option>
        </select>
      </label>
      <span class="chip" :class="langzeit.rolle === 'master' ? '' : 'schwach'">
        {{ langzeit.hardware.modell }} · {{ langzeit.hardware.ramGb }} GB
      </span>
    </div>

    <div class="meldung fehler" v-if="!langzeit.masterFaehig.faehig">
      {{ langzeit.masterFaehig.grund }}
    </div>

    <div class="fussnote" v-else-if="langzeit.rolle === 'client'">
      Als Client speichert dieses Gerät keine Langzeitdaten. Es schickt seine
      Kennzahlen an die Datenbank des Masters — einzustellen weiter unten
      unter „Langzeitdaten (InfluxDB)“.
    </div>

    <template v-else>
      <div class="zeile" style="margin: 0.8rem 0">
        <span class="chip" :class="langzeit.installiert.influxdb ? '' : 'schwach'">
          InfluxDB {{ langzeit.installiert.influxdb ? 'installiert' : 'fehlt' }}
        </span>
        <span class="chip" :class="langzeit.installiert.grafana ? '' : 'schwach'">
          Grafana {{ langzeit.installiert.grafana ? 'installiert' : 'fehlt' }}
        </span>
      </div>

      <div class="meldung ok" v-if="langzeit.laeuft">
        Einrichtung läuft — {{ langzeit.installation?.schritt ?? 'wird vorbereitet' }} …
        <br />
        <span class="fussnote">
          Das dauert einige Minuten: Zwei Pakete werden geladen und
          eingerichtet. Die Seite darf dabei geschlossen werden.
        </span>
      </div>
      <div class="meldung fehler" v-else-if="langzeit.installation?.fehler">
        Einrichtung abgebrochen: {{ langzeit.installation.fehler }}
      </div>

      <button
        class="primaer"
        v-if="!langzeit.laeuft && !(langzeit.installiert.influxdb && langzeit.installiert.grafana)"
        :disabled="beschaeftigt"
        @click="langzeitInstallieren"
      >
        InfluxDB und Grafana einrichten …
      </button>

      <template v-if="langzeit.installiert.grafana">
        <p style="margin-bottom: 0.4rem">
          <a :href="langzeit.grafanaUrl" target="_blank" rel="noopener">
            Grafana öffnen ({{ langzeit.grafanaUrl }})
          </a>
        </p>
        <div class="fussnote">
          Erste Anmeldung mit <code>admin</code> / <code>admin</code>; Grafana
          verlangt dann ein eigenes Passwort. Im Ordner „AskSin-Analyzer“
          liegen acht fertige Ansichten — Leitstand, Funkqualität,
          Duty-Cycle-Wächter, Gerätedetail, Störungssuche, Batteriewächter,
          Verbund-Vergleich und Gerätezustand. Dazu vier Alarme; wohin sie
          melden sollen, wird einmalig unter <em>Alerting → Contact points</em>
          eingetragen.
        </div>
      </template>
    </template>
  </div>

  <div class="panel" v-if="alarmZustand !== null && langzeit?.rolle === 'master'">
    <h3 style="margin-top: 0">Alarme: wohin melden?</h3>
    <p style="margin-top: 0">
      Die vier mitgelieferten Alarme — Analyzer offline, Duty-Cycle über 80 %,
      Gerät seit 24 Stunden stumm, Grundrauschen erhöht — brauchen ein Ziel.
      Grafana kann das selbst, verlangt dafür aber Einträge an drei Stellen;
      hier genügt eine Auswahl.
    </p>

    <div class="zeile" style="margin-bottom: 0.6rem">
      <label><input type="checkbox" v-model="alarm.aktiv" /> Alarme verschicken</label>
    </div>

    <div class="zeile">
      <label class="feld" style="max-width: 22rem">
        <span class="name">Weg</span>
        <select v-model="alarm.kanal">
          <option value="iobroker">ioBroker-Adapter (empfohlen)</option>
          <option value="email">E-Mail</option>
          <option value="telegram">Telegram</option>
        </select>
      </label>
    </div>

    <!-- ioBroker: der empfohlene Weg, aber der Endpunkt fehlt noch -->
    <template v-if="alarm.kanal === 'iobroker'">
      <div class="fussnote" style="margin-bottom: 0.6rem">
        Grafana ruft den ioBroker-Adapter auf, der die Meldung über die dort
        ohnehin eingerichteten Messaging-Adapter verteilt — Telegram, Signal,
        Pushover, E-Mail. Der Vorteil: Man richtet das <strong>einmal im
        ioBroker</strong> ein und nicht ein zweites Mal in Grafana.
      </div>
      <div class="meldung ok" v-if="alarmZustand.iobrokerBereit">
        Im ioBroker-Adapter muss der Alarm-Empfang eingeschaltet sein:
        <em>Instanz-Einstellungen → Alarme vom Analyzer</em>. Dort stehen Port
        und Pfad, aus denen sich die Adresse unten zusammensetzt — und dort
        wird auch eingetragen, an welchen Messaging-Adapter weitergereicht
        werden soll.
      </div>
      <div class="zeile">
        <label class="feld" style="flex: 2">
          <span class="name">Adresse des Adapters</span>
          <input type="text" v-model="alarm.iobrokerUrl"
                 placeholder="http://192.168.1.20:8095/asksin/alarm" />
        </label>
        <GeheimFeld
          v-model="alarm.iobrokerToken"
          :name="`Verbindungspasswort ${alarmZustand.iobroker.hatToken ? '(gesetzt)' : '(falls im Adapter eines gesetzt ist)'}`"
          style="flex: 1" />
      </div>
      <div class="fussnote">
        Das Verbindungspasswort denkt man sich nicht hier aus — es steht im
        <strong>Adapter</strong> unter <em>Alarme vom Analyzer</em>, wo ein
        Knopf auch eines erzeugt. Hier wird <strong>dasselbe</strong>
        eingetragen; beide Seiten müssen übereinstimmen. Ist dort keins
        gesetzt, bleibt dieses Feld leer.
        <br />
        Ob der Weg steht, lässt sich vorab prüfen: die Adresse im Browser
        öffnen. Der Adapter antwortet auf einen gewöhnlichen Aufruf mit einem
        Hinweistext — kommt der, ist alles bereit.
      </div>
    </template>

    <!-- E-Mail -->
    <template v-else-if="alarm.kanal === 'email'">
      <div class="zeile">
        <label class="feld" style="flex: 2">
          <span class="name">Empfänger</span>
          <input type="text" v-model="alarm.empfaenger" placeholder="name@beispiel.de" />
        </label>
        <label class="feld" style="flex: 2">
          <span class="name">Absender</span>
          <input type="text" v-model="alarm.absender" placeholder="dieselbe wie der Benutzer" />
        </label>
      </div>
      <div class="zeile">
        <label class="feld" style="flex: 2">
          <span class="name">SMTP-Server</span>
          <input type="text" v-model="alarm.smtpHost" placeholder="securesmtp.t-online.de" />
        </label>
        <label class="feld" style="width: 8rem">
          <span class="name">Port</span>
          <input type="text" v-model.number="alarm.smtpPort" />
        </label>
      </div>
      <div class="zeile">
        <label class="feld" style="flex: 2">
          <span class="name">Benutzer</span>
          <input type="text" v-model="alarm.benutzer" />
        </label>
        <GeheimFeld
          v-model="alarm.passwort"
          :name="`Passwort ${alarmZustand.email.hatPasswort ? '(gesetzt — leer lassen zum Behalten)' : ''}`"
          style="flex: 2" />
      </div>
      <div class="zeile" style="margin: 0.6rem 0">
        <button :disabled="beschaeftigt" @click="alarmTesten">Testmail senden</button>
        <span class="fussnote" style="margin: 0">
          Schickt sofort eine Nachricht — ohne Umweg über Grafana und ohne
          vorher zu speichern.
        </span>
      </div>
      <div class="meldung" :class="alarmTestFehler ? 'fehler' : 'ok'"
           v-if="alarmTestText !== ''">
        {{ alarmTestText }}
      </div>
      <div class="fussnote">
        Port 587 mit STARTTLS ist der zuverlässigste Weg. Zwei Stolpersteine,
        die fast jeden treffen:
        <strong>Absender und Benutzer müssen übereinstimmen</strong> — die
        meisten Anbieter lehnen fremde Absenderadressen ab. Und viele
        verlangen ein <strong>eigenes E-Mail-Passwort</strong> statt des
        Kundenkennworts; bei IONOS und T-Online wird es im Kundencenter
        vergeben, bei Google ist es ein App-Passwort.
      </div>
    </template>

    <!-- Telegram -->
    <template v-else>
      <div class="zeile">
        <GeheimFeld
          v-model="alarm.botToken"
          :name="`Bot-Token ${alarmZustand.telegram.hatBotToken ? '(gesetzt — leer lassen zum Behalten)' : ''}`"
          style="flex: 2" />
        <label class="feld" style="flex: 1">
          <span class="name">Chat-Kennung</span>
          <input type="text" v-model="alarm.chatId" placeholder="-1001234567890" />
        </label>
      </div>
      <div class="fussnote">
        Den Token gibt der <em>BotFather</em> in Telegram aus; er sieht aus wie
        <code>123456789:AA…</code> — nicht der Name des Bots. Die Chat-Kennung
        ist eine Zahl, bei Gruppen mit Minuszeichen davor.
      </div>
    </template>

    <div class="zeile" style="margin-top: 0.8rem">
      <button class="primaer" :disabled="beschaeftigt" @click="alarmSpeichern">
        Speichern und übernehmen
      </button>
      <span class="chip" v-if="alarmZustand.laeuft">wird übernommen …</span>
      <span class="chip" v-else-if="alarmZustand.angewendet">in Grafana eingetragen</span>
    </div>
    <div class="meldung fehler" v-if="alarmZustand.haengtSeitMinuten !== null">
      Der Auftrag liegt seit {{ alarmZustand.haengtSeitMinuten }} Minuten
      unbearbeitet. Vermutlich fehlt der Helfer, der ihn nach Grafana
      übernimmt — ein <code>sudo /opt/asksin-analyzer/update.sh</code> holt ihn
      nach. Die Einstellungen selbst sind gespeichert.
    </div>
    <div class="fussnote">
      Gespeichert wird beides zusammen: der Kontaktpunkt <em>und</em> die
      Benachrichtigungsrichtlinie. Genau daran scheitert die Einrichtung von
      Hand am häufigsten — der Kontaktpunkt steht da und ist „Unused", während
      die Standardrichtlinie weiter ins Leere zeigt.
    </div>
  </div>

  <div class="panel" v-if="influxVerfuegbar">
    <h3 style="margin-top: 0">Langzeitdaten (InfluxDB)</h3>
    <p style="margin-top: 0">
      Schreibt die Kennzahlen dieses Analyzers (mit Standort-Kennung) in eine
      zentrale InfluxDB v2 — Grafana wertet dann alle Standorte gemeinsam aus.
    </p>
    <div class="zeile" style="margin-bottom: 0.6rem">
      <label><input type="checkbox" v-model="influx.aktiv" /> aktiv</label>
    </div>
    <div class="zeile">
      <label class="feld" style="flex: 2">
        <span class="name">InfluxDB-URL</span>
        <input type="text" v-model="influx.url" placeholder="http://192.168.1.10:8086" />
      </label>
      <label class="feld" style="flex: 1">
        <span class="name">Organisation</span>
        <input type="text" v-model="influx.org" />
      </label>
      <label class="feld" style="flex: 1">
        <span class="name">Bucket</span>
        <input type="text" v-model="influx.bucket" />
      </label>
    </div>
    <div class="zeile">
      <GeheimFeld
        v-model="influx.token"
        :name="`API-Token ${influx.hatToken ? '(gesetzt — leer lassen zum Behalten)' : ''}`"
        style="flex: 2" />
      <label class="feld" style="width: 10rem">
        <span class="name">Intervall (s)</span>
        <input type="text" v-model.number="influx.intervallSekunden" />
      </label>
    </div>
    <button class="primaer" :disabled="beschaeftigt" @click="influxSpeichern">Speichern</button>
    <div class="meldung" :class="influxStatusText.includes('zuletzt:') ? 'fehler' : 'ok'" v-if="influxStatusText !== ''">
      {{ influxStatusText }}
    </div>
    <div class="fussnote">
      Measurements: <code>analyzer</code> (Verbindung, Telegramme/min,
      Grundrauschen, Geräte) und <code>geraet</code> (RSSI, Duty-Cycle je
      Funkgerät), Tag <code>standort</code>. Ausfälle der InfluxDB stören den
      Analyzer nicht — die lokale Datenbank bleibt die primäre Aufzeichnung.
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

  <HandbuchFuss hinweis="Kapitel 13.4 führt durch die Einstellungen, Kapitel 18 durch Status-LED und OLED." />
</template>
