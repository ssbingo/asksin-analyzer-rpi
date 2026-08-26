<script setup lang="ts">
/**
 * Funklast — wer verbraucht die Sendezeit, und wie viel davon ist vergeblich?
 *
 * Diese Seite ist die Antwort auf eine Frage vom 26.08.2026: Die CCU meldete
 * für ein LAN-Gateway einen Duty-Cycle über 100 %, und die Ursache zu finden
 * kostete eine Stunde Handarbeit an der Datenbank. Die Kette war am Ende immer
 * dieselbe — deshalb steht sie hier in genau dieser Reihenfolge:
 *
 *   Sendezeit → Bursts → Wiederholungen → vergebliche Wiederholungen
 *
 * Die letzte Spalte ist die, die nur ein Mithörer füllen kann: Wiederholungen,
 * obwohl das Gerät längst geantwortet hat. Eine Zentrale sieht nur, dass sie
 * wiederholen muss; sie kann nicht wissen, ob die Antwort unterwegs verloren
 * ging. Steht dort eine hohe Zahl, ist der **Rückweg** das Nadelöhr — und man
 * sucht am Empfänger und nicht am Sender.
 */
import { computed, ref } from 'vue';

import HandbuchFuss from '../components/HandbuchFuss.vue';
import { holeFunklast } from '../api.ts';
import type { FunklastZustand, FunklastAbsender } from '../api.ts';
import { nutzeTakt } from '../takt.ts';

const daten = ref<FunklastZustand | null>(null);
const fehler = ref('');
const stunden = ref(6);
/** Aufgeklappte Absender — Adresse als Schlüssel. */
const offen = ref<Record<string, boolean>>({});

async function laden(): Promise<void> {
  try {
    daten.value = await holeFunklast(stunden.value);
    fehler.value = '';
  } catch (err) {
    fehler.value = err instanceof Error ? err.message : String(err);
  }
}
nutzeTakt(laden, 30_000);

/** Nur Absender, die überhaupt ins Gewicht fallen. */
const liste = computed<FunklastAbsender[]>(() =>
  (daten.value?.absender ?? []).filter((a) => a.prozentJeStunde >= 0.1).slice(0, 40));

function sekunden(ms: number): string {
  return ms < 1000 ? `${ms.toFixed(0)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/**
 * Wie dringend ist das?
 *
 * Die Schwellen sind dieselben, die auch die Status-LED und der Grafana-Alarm
 * benutzen — zwei verschiedene Zahlen für dieselbe Frage wären nur verwirrend.
 */
function stufe(prozent: number): string {
  // Dieselben Farbklassen wie in der Telegrammliste (gut/mittel/schwach) —
  // zwei Farbsysteme fuer dieselbe Frage waeren nur verwirrend.
  if (prozent >= 80) return 'schwach';
  if (prozent >= 40) return 'mittel';
  return '';
}

/** Ein Satz, der sagt, was zu tun ist — nicht nur, was gemessen wurde. */
function befund(a: FunklastAbsender): string {
  if (a.sendungen === 0) return '';
  const quote = a.wiederholungen / a.sendungen;
  if (a.vergeblich >= 3 && a.vergeblich >= a.wiederholungen * 0.5) {
    return 'Wiederholt, obwohl der Empfänger geantwortet hat — der Rückweg zum '
      + 'Absender kommt nicht durch. Am Standort des Absenders ansetzen: Antenne, '
      + 'Aufstellort, oder das Gerät einer anderen Schnittstelle zuweisen.';
  }
  if (a.ohneAntwort >= 3 && quote > 0.3) {
    return 'Wiederholt, weil gar keine Antwort kommt — der Empfänger hört den '
      + 'Absender nicht oder ist abgeschaltet.';
  }
  if (a.bursts >= 10) {
    return 'Viele Bursts. Jeder kostet 360 ms Dauerträger, also einen vollen '
      + 'Prozentpunkt des Stundenkontingents.';
  }
  if (quote > 0.3) return 'Auffällig viele Wiederholungen.';
  return '';
}
</script>

<template>
  <h2>Funklast</h2>

  <div class="zeile" style="margin-bottom: 0.8rem; align-items: center">
    <label class="zeile" style="gap: 0.4rem">
      Zeitraum
      <select v-model.number="stunden" @change="laden">
        <option :value="1">1 Stunde</option>
        <option :value="6">6 Stunden</option>
        <option :value="24">24 Stunden</option>
        <option :value="48">48 Stunden</option>
      </select>
    </label>
    <span class="gedimmt" v-if="daten !== null">
      {{ daten.zeilen.toLocaleString('de-DE') }} Telegramme ausgewertet
    </span>
  </div>

  <div class="meldung fehler" v-if="fehler !== ''">{{ fehler }}</div>

  <p class="gedimmt" style="max-width: 74ch">
    Wer belegt das Band — und <strong>wie viel davon war umsonst?</strong> Die
    Reihenfolge der Spalten ist die Reihenfolge der Ursachen: Ein Absender
    fällt durch <em>Sendezeit</em> auf, nicht durch die Zahl der Telegramme.
    Sendezeit entsteht durch <em>Bursts</em> (360 ms Dauerträger statt rund
    10 ms). Bursts entstehen durch <em>Wiederholungen</em>. Und wiederholt wird,
    wenn die Quittung nicht ankommt.
  </p>

  <table class="daten" v-if="liste.length > 0">
    <thead>
      <tr>
        <th></th>
        <th>Absender</th>
        <th class="num" title="Verbrauch am gesetzlichen 1-%-Kontingent, im Mittel je Stunde">% je Stunde</th>
        <th class="num">Sendezeit</th>
        <th class="num" title="Befehle und Meldungen, Wiederholungen nicht mitgezählt">Vorgänge</th>
        <th class="num">Sendungen</th>
        <th class="num">Bursts</th>
        <th class="num" title="Wiederholungen, obwohl der Analyzer die Antwort bereits gehört hatte">vergeblich</th>
      </tr>
    </thead>
    <tbody>
      <template v-for="a in liste" :key="a.address">
        <tr class="anklickbar" @click="offen[a.address] = !offen[a.address]">
          <td class="gedimmt">{{ offen[a.address] ? '▾' : '▸' }}</td>
          <td><strong>{{ a.name }}</strong> <span class="gedimmt">{{ a.address }}</span></td>
          <td class="num" :class="stufe(a.prozentJeStunde)">{{ a.prozentJeStunde.toFixed(1) }} %</td>
          <td class="num">{{ sekunden(a.sendezeitMs) }}</td>
          <td class="num">{{ a.vorgaenge }}</td>
          <td class="num">
            {{ a.sendungen }}
            <span class="gedimmt" v-if="a.wiederholungen > 0">(+{{ a.wiederholungen }})</span>
          </td>
          <td class="num">{{ a.bursts }}</td>
          <td class="num" :class="a.vergeblich >= 3 ? 'schwach' : ''">{{ a.vergeblich }}</td>
        </tr>

        <tr v-if="offen[a.address]" class="aufklapp">
          <td></td>
          <td colspan="7">
            <p class="meldung warnung" v-if="befund(a) !== ''" style="margin: 0 0 0.6rem">
              {{ befund(a) }}
            </p>

            <!-- Mehrere Geräte unter einer Adresse. Genau das hat den Fall
                 vom 26.08.2026 entschieden: Alle LAN-Gateways einer CCU senden
                 mit deren Adresse, und nur die Empfangsstärke trennt sie. -->
            <template v-if="a.gruppen.length > 1">
              <h4 style="margin: 0 0 0.3rem">
                Achtung: {{ a.gruppen.length }} verschiedene Sender unter dieser Adresse
              </h4>
              <p class="fussnote" style="margin: 0 0 0.5rem">
                Unterschiedlich laut empfangen — typisch für eine Zentrale mit
                mehreren LAN-Gateways. Sie senden alle mit der Adresse der
                Zentrale; auseinanderhalten lässt sie nur die Empfangsstärke.
                Die Zeile mit den meisten Bursts ist die, um die es geht.
              </p>
              <table class="daten" style="max-width: 34rem; margin-bottom: 0.8rem">
                <thead>
                  <tr><th class="num">empfangen mit</th><th class="num">Sendungen</th>
                    <th class="num">Bursts</th><th class="num">Sendezeit</th></tr>
                </thead>
                <tbody>
                  <tr v-for="g in a.gruppen" :key="g.rssi">
                    <td class="num">{{ g.rssi }} dBm</td>
                    <td class="num">{{ g.sendungen }}</td>
                    <td class="num">{{ g.bursts }}</td>
                    <td class="num">{{ sekunden(g.sendezeitMs) }}</td>
                  </tr>
                </tbody>
              </table>
            </template>

            <h4 style="margin: 0 0 0.3rem">An welche Gegenstelle?</h4>
            <table class="daten" style="max-width: 56rem">
              <thead>
                <tr>
                  <th>Gegenstelle</th>
                  <th class="num">Vorgänge</th>
                  <th class="num">Sendungen</th>
                  <th class="num" title="Sendungen je Vorgang">je Vorgang</th>
                  <th class="num">Bursts</th>
                  <th class="num">ohne Antwort</th>
                  <th class="num">vergeblich</th>
                  <th class="num" title="So laut hört DIESER Analyzer die Antworten">Antwort</th>
                  <th class="num">Sendezeit</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="p in a.paare.slice(0, 12)" :key="p.address">
                  <td>{{ p.name }} <span class="gedimmt">{{ p.address }}</span></td>
                  <td class="num">{{ p.vorgaenge }}</td>
                  <td class="num">{{ p.sendungen }}</td>
                  <td class="num" :class="p.vorgaenge > 0 && p.sendungen / p.vorgaenge >= 2 ? 'mittel' : ''">
                    {{ p.vorgaenge > 0 ? (p.sendungen / p.vorgaenge).toFixed(1) : '—' }}
                  </td>
                  <td class="num">{{ p.bursts }}</td>
                  <td class="num">{{ p.ohneAntwort }}</td>
                  <td class="num" :class="p.vergeblich >= 3 ? 'schwach' : ''">{{ p.vergeblich }}</td>
                  <td class="num">{{ p.rssiAntwort === null ? '—' : `${p.rssiAntwort} dBm` }}</td>
                  <td class="num">{{ sekunden(p.sendezeitMs) }}</td>
                </tr>
              </tbody>
            </table>
          </td>
        </tr>
      </template>
    </tbody>
  </table>

  <p class="gedimmt" v-else-if="daten !== null">
    In diesem Zeitraum hat kein Absender nennenswert Sendezeit verbraucht.
  </p>

  <div class="fussnote" style="max-width: 74ch">
    <strong>Wie die Zahlen zu lesen sind.</strong>
    <em>Vorgang</em> ist ein Befehl oder eine Meldung; mehrere Sendungen mit
    demselben Zähler gehören zu einem Vorgang. <em>Sendungen je Vorgang</em>
    liegt im Normalfall bei 1,0 — alles darüber sind Wiederholungen.
    <em>Vergeblich</em> zählt die Wiederholungen, bei denen dieser Analyzer die
    Antwort der Gegenstelle <strong>bereits gehört hatte</strong>: Dann ist
    nicht der Empfänger stumm, sondern die Antwort kommt beim Absender nicht an.
    <br />
    Die Sendezeit ist aus Länge und Datenrate <strong>gerechnet</strong>, nicht
    gemessen (Kapitel 13.6). Für die Frage „wer verbraucht das Kontingent" ist
    sie belastbar; als Absolutwert gehört sie gegen die Anzeige der Zentrale
    gehalten.
  </div>

  <HandbuchFuss hinweis="Kapitel 13.6 erklärt die Auswertung an einem echten Fall." />
</template>

<style scoped>
.anklickbar { cursor: pointer; }
.anklickbar:hover { background: var(--panel2); }
.aufklapp > td { background: var(--panel2); padding: 0.8rem 0.9rem; }
.aufklapp h4 { font-size: 0.9rem; color: var(--muted); font-weight: 600; }
</style>
