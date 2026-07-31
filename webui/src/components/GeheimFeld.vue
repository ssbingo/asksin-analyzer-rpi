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
        :title="sichtbar ? 'Wieder verbergen' : 'Zum Prüfen lesbar anzeigen'"
        @click="sichtbar = !sichtbar"
      >
        {{ sichtbar ? 'verbergen' : 'anzeigen' }}
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
  padding: 0.45rem 0.7rem;
  font-size: 0.8rem;
  white-space: nowrap;
}
</style>
