<script setup lang="ts">
/**
 * Eingabefeld für ein Geheimnis (Token, Passwort) mit Umschalter
 * „anzeigen / verbergen".
 *
 * Warum: Tokens sind lang, zufällig und werden von Hand übertragen. Ein
 * verdecktes Feld verhindert zwar Mitlesen über die Schulter, macht aber jeden
 * Tippfehler unsichtbar — und ein falsch eingetragener Token äußert sich nur
 * als „nicht berechtigt", ohne Hinweis auf die Ursache. Deshalb bleibt das Feld
 * standardmäßig verdeckt und lässt sich für die Kontrolle kurz aufdecken.
 *
 * Der Umschalter steht bewusst **außerhalb** des <label>: Ein Knopf innerhalb
 * eines Labels erbt dessen Klickverhalten und würde beim Betätigen zusätzlich
 * den Fokus ins Eingabefeld werfen.
 */
import { ref } from 'vue';

defineProps<{
  modelValue: string;
  /** Beschriftung über dem Feld. */
  name: string;
  platzhalter?: string;
}>();

defineEmits<{ 'update:modelValue': [wert: string] }>();

// Eigene Kennung statt useId(): funktioniert in jeder Vue-3-Fassung. Der Code
// in <script setup> läuft je Instanz, ein Modulzähler wäre hier also keiner.
const id = `geheim-${Math.random().toString(36).slice(2, 10)}`;

const sichtbar = ref(false);
</script>

<template>
  <div class="feld-geheim">
    <label class="name" :for="id">{{ name }}</label>
    <div class="zeile-geheim">
      <input
        :id="id"
        :type="sichtbar ? 'text' : 'password'"
        :value="modelValue"
        :placeholder="platzhalter"
        autocomplete="off"
        autocapitalize="off"
        autocorrect="off"
        spellcheck="false"
        @input="$emit('update:modelValue', ($event.target as HTMLInputElement).value)"
      />
      <button
        type="button"
        class="umschalter"
        :aria-pressed="sichtbar"
        :aria-label="sichtbar ? 'Eingabe wieder verbergen' : 'Eingabe lesbar anzeigen'"
        :title="sichtbar ? 'Wieder verbergen' : 'Zum Prüfen lesbar anzeigen'"
        @click="sichtbar = !sichtbar"
      >
        <!-- Selbst gezeichnet statt aus einer Icon-Bibliothek: keine weitere
             Abhaengigkeit, keine fremde Lizenz, und ueber currentColor folgt
             das Auge dem Farbschema. aria-hidden, weil der Knopf seinen Namen
             schon aus aria-label bezieht. -->
        <svg
          viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"
          fill="none" stroke="currentColor" stroke-width="1.8"
          stroke-linecap="round" stroke-linejoin="round"
        >
          <!-- Mandelform aus zwei quadratischen Kurven: 18 x 11 Einheiten,
               Verhaeltnis 1,64 — flacher wirkt es wie ein Schlitz, runder
               wie ein Kreis. Die Iris (r 3,2) liegt sicher darin. -->
          <path d="M 3 12 Q 12 1 21 12 Q 12 23 3 12 Z" />
          <circle cx="12" cy="12" r="3.2" />
          <!-- Durchgestrichen, solange die Eingabe offen liegt. -->
          <line v-if="sichtbar" x1="3.5" y1="3.5" x2="20.5" y2="20.5" />
        </svg>
      </button>
    </div>
  </div>
</template>

<style scoped>
/* Entspricht label.feld / .name aus style.css — dort greift der Selektor nur
   innerhalb eines <label>, hier ist die Beschriftung ein eigenes Element. */
.feld-geheim {
  margin-bottom: 0.8rem;
}
.feld-geheim .name {
  display: block;
  color: var(--muted);
  font-size: 0.8rem;
  margin-bottom: 0.25rem;
}
.zeile-geheim {
  display: flex;
  gap: 0.4rem;
  align-items: center;
  max-width: 26rem;
}
/* Das Feld füllt die Zeile, der Knopf behält seine Breite. */
.zeile-geheim input {
  flex: 1;
  min-width: 0;
  max-width: none;
}
.umschalter {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  /* Quadratisch und so hoch wie das Eingabefeld. */
  padding: 0.45rem 0.55rem;
  line-height: 0;
  color: var(--muted);
}
.umschalter svg {
  display: block;
}
.umschalter:hover {
  color: var(--text);
}
/* Offen liegende Eingabe ist der ungewoehnliche Zustand — hervorheben, damit
   niemand den Token versehentlich sichtbar stehen laesst. */
.umschalter[aria-pressed='true'] {
  color: var(--akzent);
  border-color: var(--akzent);
}
</style>
