import { ref } from 'vue';

/**
 * Was die Kopfzeile über diesen Analyzer weiß — einmal geholt, überall lesbar.
 *
 * Ohne diesen gemeinsamen Ort müsste jede Ansicht `/api/health` selbst abrufen,
 * nur um zu erfahren, ob sie überhaupt angezeigt werden darf. Die Kopfzeile
 * holt health ohnehin im Sekundentakt; sie schreibt das Ergebnis hierher.
 */
export const rolle = ref<'master' | 'client'>('master');
export const zigbeeAktiv = ref(false);


/** Ansichten, die es nur auf dem Master gibt. */
export const NUR_MASTER = ['/verbund', '/verbund-zigbee'];

export function istMaster(): boolean {
  return rolle.value === 'master';
}
