<script setup lang="ts">
/**
 * Schiebeschalter — an oder aus, wie am Telefon.
 *
 * Ein Häkchen sagt „ausgewählt", ein Schiebeschalter sagt „läuft" oder „läuft
 * nicht". Das ist hier der Unterschied, auf den es ankommt: Ein Alarm ist
 * kein Listeneintrag, den man ankreuzt, sondern etwas, das im Hintergrund
 * arbeitet oder eben stillsteht.
 *
 * Gebaut auf einem echten `<input type="checkbox">`, nur anders gezeichnet.
 * Damit bleibt alles erhalten, was ein Bedienelement können muss: Tabulator,
 * Leertaste, Vorlesehilfen, das Anklicken der Beschriftung. Ein aus `<div>`
 * gebauter Schalter sieht genauso aus und kann nichts davon.
 */
defineProps<{
  /** Beschriftung neben dem Schalter. */
  name: string;
  /** Erklärung darunter — wofür der Alarm da ist. */
  zweck?: string;
  /** Sperrt die Bedienung, etwa während eine Übernahme läuft. */
  gesperrt?: boolean;
}>();

// Vorgabe statt Pflicht: Vor dem ersten Laden steht noch kein Wert bereit,
// und eine Warnung in der Konsole waere dafuer die falsche Antwort.
const an = defineModel<boolean>({ default: false });
</script>

<template>
  <label class="schiebeschalter" :class="{ gesperrt }">
    <input type="checkbox" v-model="an" :disabled="gesperrt" />
    <span class="bahn" aria-hidden="true"><span class="knopf" /></span>
    <span class="text">
      <span class="name">{{ name }}</span>
      <!-- Der Zustand auch als Wort: Wer Farben schlecht unterscheidet, sieht
           sonst nur einen Knopf, der irgendwo steht. -->
      <span class="zustand">{{ an ? 'an' : 'aus' }}</span>
      <span v-if="zweck !== undefined" class="zweck">{{ zweck }}</span>
    </span>
  </label>
</template>

<style scoped>
.schiebeschalter {
  display: grid;
  grid-template-columns: auto 1fr;
  align-items: start;
  gap: 0.1rem 0.7rem;
  padding: 0.5rem 0;
  cursor: pointer;
}
.schiebeschalter.gesperrt {
  cursor: default;
  opacity: 0.55;
}

/* Das echte Bedienelement bleibt da, nur unsichtbar — sonst verlöre man
   Tastatur und Vorlesehilfe. */
.schiebeschalter input {
  position: absolute;
  opacity: 0;
  width: 0;
  height: 0;
}

.bahn {
  position: relative;
  display: block;
  width: 2.6rem;
  height: 1.4rem;
  margin-top: 0.1rem;
  border-radius: 99px;
  background: var(--border);
  transition: background 0.15s ease;
}
.knopf {
  position: absolute;
  top: 0.15rem;
  left: 0.15rem;
  width: 1.1rem;
  height: 1.1rem;
  border-radius: 50%;
  background: var(--panel);
  box-shadow: 0 1px 3px rgb(0 0 0 / 35%);
  transition: transform 0.15s ease;
}
.schiebeschalter input:checked ~ .bahn {
  background: var(--gut);
}
.schiebeschalter input:checked ~ .bahn .knopf {
  transform: translateX(1.2rem);
}
/* Sichtbarer Tastaturfokus — ohne ihn wäre der Schalter mit der Tabulatortaste
   zwar erreichbar, aber nicht auffindbar. */
.schiebeschalter input:focus-visible ~ .bahn {
  outline: 2px solid var(--akzent);
  outline-offset: 2px;
}

.text {
  display: block;
  line-height: 1.35;
}
.text .name {
  font-weight: 600;
}
.text .zustand {
  margin-left: 0.5rem;
  font-size: 0.8rem;
  color: var(--muted);
}
.text .zweck {
  display: block;
  margin-top: 0.15rem;
  color: var(--muted);
  font-size: 0.85rem;
  max-width: 62ch;
}
@media (prefers-reduced-motion: reduce) {
  .bahn, .knopf { transition: none; }
}
</style>
