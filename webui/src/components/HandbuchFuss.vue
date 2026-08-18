<script setup lang="ts">
/**
 * Fußblock mit dem Weg zu den Handbüchern.
 *
 * Steht am Ende der Seiten, auf denen man etwas einstellt oder nachsieht —
 * Info, Einstellungen, Wartung. Wer dort landet, sucht meistens eine
 * Erklärung; dann soll das Handbuch nicht erst gesucht werden müssen.
 *
 * Es gibt **zwei** Bücher, und sie haben verschiedene Leser: Das grosse
 * begleitet den Analyzer von der Platine an, das Zigbee-Buch nur den
 * Mithörer. Beide stehen hier, aber `haupt` entscheidet, welches oben steht:
 * Wer auf der Zigbee-Seite ist, soll nicht das BidCoS-Handbuch angeboten
 * bekommen und darin blättern müssen.
 *
 * Die PDFs liefert der Core unter `/handbuch.pdf` und `/handbuch-zigbee.pdf`
 * aus. Bewusst **lokal** und nicht als Verweis auf GitHub: Das Gerät steht im
 * Schrank und hat womöglich keinen Weg ins Internet — die Handbücher aber
 * liegen neben der Software.
 */
withDefaults(defineProps<{
  /** Kapitelhinweis, z. B. „Kapitel 22 erklärt das Protokoll". */
  hinweis?: string;
  /** Welches Buch zuerst? */
  haupt?: 'analyzer' | 'zigbee';
}>(), { haupt: 'analyzer' });

/** Aufgeschlagenes Buch, selbst gezeichnet — keine Icon-Bibliothek, keine fremde Lizenz. */
const BUCH_PFAD = [
  'M12 6.5 C 9.5 4.5, 6 4.5, 3 5.5 L 3 19 C 6 18, 9.5 18, 12 20',
  'M12 6.5 C 14.5 4.5, 18 4.5, 21 5.5 L 21 19 C 18 18, 14.5 18, 12 20',
];

const BUECHER = {
  analyzer: {
    url: '/handbuch.pdf',
    titel: 'Handbuch öffnen',
    text: 'Das vollständige Handbuch als PDF — Schritt für Schritt vom Bestellen '
      + 'der Platine bis zum laufenden Gerät.',
  },
  zigbee: {
    url: '/handbuch-zigbee.pdf',
    titel: 'Zigbee-Handbuch öffnen',
    text: 'Der Mithörer als eigenes Buch — vom Auspacken des USB-Sticks über das '
      + 'Aufspielen der Firmware bis zum ersten mitgeschnittenen Funkpaket.',
  },
} as const;
</script>

<template>
  <div class="handbuch-fuss">
    <template v-for="art in (haupt === 'zigbee'
      ? (['zigbee', 'analyzer'] as const)
      : (['analyzer', 'zigbee'] as const))" :key="art">
      <div class="buch" :class="{ zweit: art !== haupt }">
        <a :href="BUECHER[art].url" target="_blank" rel="noopener">
          <svg
            viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"
            fill="none" stroke="currentColor" stroke-width="1.7"
            stroke-linecap="round" stroke-linejoin="round"
          >
            <path v-for="d in BUCH_PFAD" :key="d" :d="d" />
            <line x1="12" y1="6.5" x2="12" y2="20" />
          </svg>
          <span>{{ BUECHER[art].titel }}</span>
        </a>
        <p v-if="art === haupt && hinweis !== undefined" class="hinweis">{{ hinweis }}</p>
        <p class="hinweis">{{ BUECHER[art].text }}</p>
      </div>
    </template>
  </div>
</template>

<style scoped>
.handbuch-fuss {
  margin: 2rem 0 0.5rem;
  padding: 1rem 1.1rem;
  background: var(--panel);
  border: 1px solid var(--border);
  /* Farbige Kante links: hebt den Block vom übrigen Inhalt ab, ohne laut zu
     werden — dasselbe Mittel wie in den Hinweiskästen des Handbuchs. */
  border-left: 4px solid var(--akzent);
  border-radius: 10px;
}
/* Das zweite Buch steht abgesetzt und eine Spur leiser: Es ist erreichbar,
   drängt sich aber nicht vor das, wonach der Leser hier gesucht hat. */
.buch.zweit {
  margin-top: 0.9rem;
  padding-top: 0.85rem;
  border-top: 1px solid var(--border);
}
.handbuch-fuss a {
  display: inline-flex;
  align-items: center;
  gap: 0.6rem;
  font-size: 1.05rem;
  font-weight: 600;
  color: var(--akzent);
}
.buch.zweit a {
  font-size: 0.98rem;
  font-weight: 500;
}
.handbuch-fuss a:hover {
  text-decoration: underline;
}
.handbuch-fuss a svg {
  flex: none;
}
.handbuch-fuss .hinweis {
  margin: 0.45rem 0 0;
  color: var(--muted);
  font-size: 0.85rem;
  max-width: 60ch;
}
</style>
