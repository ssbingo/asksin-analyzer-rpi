<script setup lang="ts">
import { computed, ref } from 'vue';
import {
  holeFlottenStatus,
  holeVerbund,
  holeVerbundMatrix,
  holeVerbundTelegramme,
  starteFlottenUpdate,
} from '../api.ts';
import type {
  FlottenStatus,
  VerbundMatrix,
  VerbundTelegramm,
  VerbundUebersicht,
} from '../api.ts';
import { dbm, rssiKlasse, uhrzeit } from '../format.ts';
import { nutzeTakt } from '../takt.ts';

const uebersicht = ref<VerbundUebersicht | null>(null);
const matrix = ref<VerbundMatrix | null>(null);
const telegramme = ref<VerbundTelegramm[]>([]);
const flotte = ref<FlottenStatus | null>(null);
const flottenMeldung = ref('');
const filter = ref('');
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
  const [m, t, f] = await Promise.all([
    holeVerbundMatrix(),
    holeVerbundTelegramme(),
    holeFlottenStatus().catch(() => null),
  ]);
  matrix.value = m;
  telegramme.value = t.telegramme;
  if (f !== null) flotte.value = f;
}, 5000);

const updateFaellig = computed(() =>
  (uebersicht.value?.peers ?? []).some((p) => p.updateVerfuegbar === true),
);

async function flotteStarten(): Promise<void> {
  if (
    !window.confirm(
      'Alle Analyzer nacheinander aktualisieren?\n\n' +
        'Jeder Analyzer wird erst nach erfolgreichem Gesundheits-Check des ' +
        'vorherigen aktualisiert; bei einem Fehler stoppt der Lauf. Dieser ' +
        'Analyzer (Master) kommt zum Schluss — die Seite verbindet sich danach neu.',
    )
  )
    return;
  flottenMeldung.value = '';
  try {
    await starteFlottenUpdate();
    flotte.value = { running: true };
  } catch (err) {
    flottenMeldung.value = err instanceof Error ? err.message : String(err);
  }
}

function schrittKlasse(status: string): string {
  if (status === 'fehler') return 'schwach';
  if (status === 'aktualisiert' || status === 'aktuell' || status === 'angestoßen') return 'gut';
  if (status === 'läuft') return 'mittel';
  return 'gedimmt';
}

const gefiltert = computed(() => {
  const f = filter.value.trim().toLowerCase();
  if (f === '') return telegramme.value.slice(0, 100);
  return telegramme.value
    .filter((t) =>
      [t.fromName, t.toName, t.fromHex, t.typeName]
        .some((s) => s.toLowerCase().includes(f)),
    )
    .slice(0, 100);
});
</script>

<template>
  <h2>Verbund</h2>

  <div class="panel" v-if="keineRolle">
    <p style="margin-top: 0">
      Dieser Core-Stand kennt die Verbund-Ansicht noch nicht —
      bitte zuerst aktualisieren (Info → Software-Update).
    </p>
  </div>

  <template v-else-if="uebersicht !== null">
    <div class="meldung ok" v-if="uebersicht.peers.length === 1">
      Bisher nur der eigene Standort — weitere Analyzer verknüpfst du unter
      <RouterLink to="/settings">Einstellungen → Verbund</RouterLink>
      (Adresse eintragen, fertig — ganz ohne Konsole).
    </div>
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

    <div class="panel" v-if="uebersicht.peers.length > 1 || flotte?.schritte !== undefined">
      <div class="zeile" style="justify-content: space-between">
        <h3 style="margin: 0">Flotten-Update</h3>
        <button
          class="primaer"
          :disabled="flotte?.running === true"
          @click="flotteStarten"
        >
          Alle Analyzer aktualisieren …
          <template v-if="updateFaellig"> 🔔</template>
        </button>
      </div>
      <div class="meldung fehler" v-if="flottenMeldung !== ''">{{ flottenMeldung }}</div>
      <table class="daten" style="max-width: 44rem; margin-top: 0.8rem" v-if="flotte?.schritte !== undefined">
        <tbody>
          <tr v-for="s in flotte.schritte" :key="s.url">
            <td>{{ s.name }}</td>
            <td :class="schrittKlasse(s.status)">
              {{ s.status === 'läuft' ? '⟳ läuft …' : s.status }}
            </td>
            <td class="gedimmt">{{ s.detail ?? '' }}</td>
          </tr>
        </tbody>
      </table>
      <div class="meldung" :class="flotte.ok === true ? 'ok' : 'fehler'"
           v-if="flotte !== null && flotte.running === false && flotte.ok !== null && flotte.ok !== undefined">
        {{ flotte.ok ? 'Flotten-Update abgeschlossen.' : 'Flotten-Update abgebrochen — Details in der Liste; der betroffene Analyzer hat automatisch zurückgerollt.' }}
      </div>
      <div class="fussnote">
        Nacheinander mit Gesundheits-Prüfung nach jedem Schritt; bei einem
        Fehler stoppt der Lauf. Peers mit Token-Pflicht brauchen ihr
        hinterlegtes Token (Einstellungen → Verbund).
      </div>
    </div>

    <div class="panel" v-if="matrix !== null && matrix.geraete.length > 0">
      <div class="zeile" style="justify-content: space-between">
        <h3 style="margin: 0">Empfangsmatrix — Gerät × Standort (RSSI, geglättet)</h3>
        <a class="knopf" href="/api/verbund/matrix.csv">CSV herunterladen</a>
      </div>
      <div class="scrollbar" style="margin-top: 0.8rem">
        <table class="daten">
          <thead>
            <tr>
              <th>Gerät</th><th>Adresse</th>
              <th class="num" v-for="s in matrix.standorte" :key="s">{{ s }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="g in matrix.geraete" :key="g.addr">
              <td>{{ g.name }}</td>
              <td class="gedimmt">{{ g.address }}</td>
              <td class="num" v-for="s in matrix.standorte" :key="s"
                  :class="g.rssi[s] === null ? 'gedimmt' : rssiKlasse(g.rssi[s]!)">
                <template v-if="g.rssi[s] !== null">
                  {{ g.rssi[s] }}<span v-if="g.beste === s" title="bester Empfang"> ★</span>
                </template>
                <template v-else>—</template>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="fussnote">
        ★ = bester Empfang. „—" heißt: an diesem Standort seit Dienststart
        nicht gehört — das ist die Funkloch-Karte des Hauses.
      </div>
    </div>

    <div class="panel">
      <div class="zeile" style="margin-bottom: 0.8rem">
        <h3 style="margin: 0; flex: 0 0 auto">Telegramme (zusammengeführt)</h3>
        <input type="search" v-model="filter" placeholder="Filtern nach Name, Adresse oder Typ …" />
      </div>
      <div class="scrollbar">
        <table class="daten">
          <thead>
            <tr>
              <th>Zeit</th><th>Von</th><th>An</th><th>Typ</th>
              <th>gehört von</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="t in gefiltert" :key="`${t.fromAddr}-${t.cnt}-${t.ts}`">
              <td class="gedimmt">{{ uhrzeit(t.ts) }}</td>
              <td>
                {{ t.fromName }}
                <span class="gedimmt" v-if="t.fromName !== t.fromHex">({{ t.fromHex }})</span>
              </td>
              <td>{{ t.toName }}</td>
              <td><span class="chip" :class="{ hmip: t.isHmIp }">{{ t.typeName }}</span></td>
              <td>
                <span class="chip" v-for="g in t.gehoertVon" :key="g.standort"
                      :class="rssiKlasse(g.rssi)">
                  {{ g.standort }} ({{ g.rssi }})
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="fussnote" v-if="telegramme.length === 0">
        Noch keine Telegramme zusammengeführt — die Liste füllt sich von selbst.
      </div>
      <div class="fussnote" v-else>
        Gleicher Absender + Zähler + Typ + Länge innerhalb ±1,5 s = ein
        Telegramm; die Chips zeigen jeden Standort mit seinem Empfangspegel.
      </div>
    </div>
  </template>
</template>
