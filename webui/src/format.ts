/** Anzeige-Formatierungen, überall gleich. */

export function uhrzeit(ts: number): string {
  return new Date(ts).toLocaleTimeString('de-DE');
}

export function datumZeit(ts: number): string {
  return new Date(ts).toLocaleString('de-DE');
}

export function dbm(wert: number | null | undefined): string {
  return wert === null || wert === undefined ? '—' : `${wert} dBm`;
}

/** „vor 12 s" / „vor 3 min" — für lastSeen-Spalten. */
export function vorZeit(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `vor ${s} s`;
  const min = Math.round(s / 60);
  if (min < 60) return `vor ${min} min`;
  const h = Math.round(min / 60);
  if (h < 48) return `vor ${h} h`;
  return `vor ${Math.round(h / 24)} d`;
}

export function dauer(ms: number): string {
  const s = Math.floor(ms / 1000);
  const tage = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const min = Math.floor((s % 3600) / 60);
  if (tage > 0) return `${tage} d ${h} h`;
  if (h > 0) return `${h} h ${min} min`;
  return `${min} min`;
}

/** Farbklasse für einen Empfangspegel — grob wie eine Balkenanzeige. */
export function rssiKlasse(rssi: number): string {
  if (rssi >= -65) return 'gut';
  if (rssi >= -85) return 'mittel';
  return 'schwach';
}
