import { onMounted, onUnmounted } from 'vue';

/**
 * Wiederkehrender Abruf im Lebenszyklus einer Ansicht: sofort einmal, dann
 * alle `ms`. Fehler (Core kurz weg) werden geschluckt — der nächste Takt
 * versucht es wieder; die Ansichten zeigen den letzten guten Stand.
 */
export function nutzeTakt(fn: () => void | Promise<void>, ms: number): void {
  let timer: number | undefined;
  const einmal = (): void => {
    void (async () => {
      try {
        await fn();
      } catch {
        /* nächster Takt versucht es erneut */
      }
    })();
  };
  onMounted(() => {
    einmal();
    timer = window.setInterval(einmal, ms);
  });
  onUnmounted(() => {
    window.clearInterval(timer);
  });
}
