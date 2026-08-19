<script setup lang="ts">
/**
 * Empfangsbalken — fünf Stufen, wie man sie vom Mobiltelefon kennt.
 *
 * Die Stufe rechnet der Core aus (`core/src/analytics/balken.ts`), damit
 * Kopfzeile, Adapter und alles Spätere dieselbe Skala benutzen. Hier steht
 * nur das Zeichnen.
 *
 * Gezeichnet, nicht als Zeichen aus einer Schrift: Die Balkenzeichen aus
 * Unicode sehen in jeder Schrift anders aus, und auf manchen Systemen fehlen
 * sie ganz. Fünf Rechtecke tun immer dasselbe.
 */
const eigenschaften = withDefaults(defineProps<{
  /** 0 bis 5. 0 heisst „keine Aussage" und wird als leere Balken gezeichnet. */
  balken: number;
  /** Was im Tooltip steht — die Begründung zur Stufe. */
  titel?: string;
}>(), { balken: 0, titel: '' });

/** Höhe je Balken in Prozent — ansteigend wie beim Vorbild. */
const HOEHEN = [34, 50, 66, 82, 100];

function aktiv(i: number): boolean {
  return i < eigenschaften.balken;
}
</script>

<template>
  <span
    class="empfangsbalken"
    :class="{ leer: balken === 0, schwach: balken > 0 && balken <= 2 }"
    :title="titel"
    role="img"
    :aria-label="balken === 0 ? 'Empfang unbekannt' : `Empfang ${balken} von 5`"
  >
    <span
      v-for="(h, i) in HOEHEN"
      :key="i"
      class="stab"
      :class="{ an: aktiv(i) }"
      :style="{ height: `${h}%` }"
    />
  </span>
</template>

<style scoped>
.empfangsbalken {
  display: inline-flex;
  align-items: flex-end;
  gap: 1px;
  /* Feste Höhe: Sonst springt die Kopfzeile, sobald ein Balken erscheint. */
  height: 0.85rem;
  vertical-align: -0.1rem;
}
.stab {
  width: 3px;
  border-radius: 1px;
  /* Der nicht erreichte Teil bleibt sichtbar, aber blass — so sieht man auf
     einen Blick, wie viel Luft nach oben ist. Ein Balken, dessen unerreichte
     Stufen fehlen, wirkt bei zwei von fünf wie „vollständig, nur klein". */
  background: var(--border);
}
.stab.an { background: var(--gut); }
.schwach .stab.an { background: var(--warn); }
.leer .stab { background: var(--border); opacity: 0.5; }
</style>
