<script setup lang="ts">
import { ref } from 'vue';

/**
 * Weg zur Grafana-Oberfläche — nur auf dem Master, nur wenn sie dort läuft.
 *
 * ## Warum hier kein echtes Grafana-Logo liegt
 *
 * Das Logo ist eine Marke von Grafana Labs. Es in ein **öffentliches**
 * Repository zu kopieren, hiesse, fremdes Markenmaterial unter unserer Lizenz
 * mitzuverteilen — dieselbe Überlegung, aus der dieses Projekt auch sonst
 * keine fremden Symbolsätze und keine Produktfotos mitliefert.
 *
 * Gezeichnet ist deshalb ein **eigenes** Zeichen in Grafanas Orange, zusammen
 * mit dem Namen. In dieser Umgebung — ein Knopf, der eine Grafana-Instanz
 * öffnet — ist damit keine Verwechslung möglich.
 *
 * **Wer das echte Logo will, braucht keine Codeänderung:** Eine Datei
 * `webui/public/grafana-logo.svg` ablegen, fertig. Sie wird bevorzugt und
 * ersetzt das eigene Zeichen; fehlt sie, bleibt es beim gezeichneten. Der
 * Bezug der Datei und die Einhaltung der Markenrichtlinien liegen dann beim
 * Betreiber, und das ist die richtige Stelle dafür.
 */
defineProps<{ url: string }>();

/** Liegt kein Logo im Verzeichnis, springt das gezeichnete Zeichen ein. */
const eigenesZeichen = ref(false);

/**
 * Als Variable und nicht als fester `src`: Vite loest einen festen Pfad beim
 * Bauen auf und bricht ab, wenn die Datei fehlt. Sie soll aber fehlen duerfen
 * — genau das ist der Regelfall.
 */
const LOGO_PFAD = '/grafana-logo.svg';
</script>

<template>
  <a
    class="grafana-knopf"
    :href="url"
    target="_blank"
    rel="noopener noreferrer"
    :title="`Grafana öffnen — ${url}`"
  >
    <img
      v-if="!eigenesZeichen"
      :src="LOGO_PFAD"
      alt=""
      width="18"
      height="18"
      @error="eigenesZeichen = true"
    >
    <!-- Eigenes Zeichen: eine steigende Messkurve über einer Grundlinie.
         Das ist es, wofür man Grafana aufruft, und es kopiert nichts. -->
    <svg
      v-else viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"
      fill="none" stroke="currentColor" stroke-width="1.8"
      stroke-linecap="round" stroke-linejoin="round"
    >
      <path d="M2.5 16.5 L2.5 3" />
      <path d="M2.5 16.5 L17.5 16.5" />
      <path d="M4.5 13 L8 8.5 L11 11 L16.5 4.5" />
      <circle cx="8" cy="8.5" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="16.5" cy="4.5" r="1.4" fill="currentColor" stroke="none" />
    </svg>
    <span>Grafana</span>
  </a>
</template>

<style scoped>
.grafana-knopf {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.15rem 0.6rem 0.15rem 0.45rem;
  border-radius: 99px;
  border: 1px solid color-mix(in srgb, #f46800 45%, transparent);
  /* Grafanas Orange — als Farbwert keine Marke, sondern eine Zahl. Es macht
     den Knopf ohne Logo auf einen Blick zuordenbar. */
  color: #f46800;
  background: color-mix(in srgb, #f46800 12%, transparent);
  font-size: 0.8rem;
  font-weight: 600;
  white-space: nowrap;
}
.grafana-knopf:hover {
  background: color-mix(in srgb, #f46800 22%, transparent);
  text-decoration: none;
}
.grafana-knopf img { display: block; }
</style>
