<script setup lang="ts">
/**
 * Fußblock mit dem Weg zum Handbuch.
 *
 * Steht am Ende der Seiten, auf denen man etwas einstellt oder nachsieht —
 * Info, Einstellungen, Wartung. Wer dort landet, sucht meistens eine
 * Erklärung; dann soll das Handbuch nicht erst gesucht werden müssen.
 *
 * Das PDF liefert der Core unter `/handbuch.pdf` aus. Bewusst **lokal** und
 * nicht als Verweis auf GitHub: Das Gerät steht im Schrank und hat womöglich
 * keinen Weg ins Internet — das Handbuch aber liegt neben der Software.
 */
defineProps<{
  /** Kapitelhinweis, z. B. „Kapitel 22 erklärt das Protokoll". */
  hinweis?: string;
}>();
</script>

<template>
  <div class="handbuch-fuss">
    <a href="/handbuch.pdf" target="_blank" rel="noopener">
      <!-- Aufgeschlagenes Buch: zwei Seiten, ein Bund in der Mitte.
           Selbst gezeichnet — keine Icon-Bibliothek, keine fremde Lizenz. -->
      <svg
        viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"
        fill="none" stroke="currentColor" stroke-width="1.7"
        stroke-linecap="round" stroke-linejoin="round"
      >
        <path d="M12 6.5 C 9.5 4.5, 6 4.5, 3 5.5 L 3 19 C 6 18, 9.5 18, 12 20" />
        <path d="M12 6.5 C 14.5 4.5, 18 4.5, 21 5.5 L 21 19 C 18 18, 14.5 18, 12 20" />
        <line x1="12" y1="6.5" x2="12" y2="20" />
      </svg>
      <span>Handbuch öffnen</span>
    </a>
    <p v-if="hinweis !== undefined" class="hinweis">{{ hinweis }}</p>
    <p class="hinweis">
      Das vollständige Handbuch als PDF — Schritt für Schritt vom Bestellen der
      Platine bis zum laufenden Gerät.
    </p>
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
.handbuch-fuss a {
  display: inline-flex;
  align-items: center;
  gap: 0.6rem;
  font-size: 1.05rem;
  font-weight: 600;
  color: var(--akzent);
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
