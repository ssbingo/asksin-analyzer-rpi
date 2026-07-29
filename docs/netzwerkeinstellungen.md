# Netzwerkeinstellungen über die Web-UI (M7.6)

Anforderung (29.07.2026): Die Netzwerkeinstellungen des Raspberry Pi sollen
über die Weboberfläche anpassbar sein — **DHCP/Statisch**, die statischen
Werte (IP/Präfix, Gateway, DNS), **NTP** und der **Hostname**. Bestehende
Installationen bleiben unberührt, bis der Anwender aktiv ändert. Bei DHCP
werden die zugewiesenen Werte angezeigt.

## Grundsätze

1. **Anzeigen ≠ Ändern.** Die Seite öffnet als Live-Anzeige des Ist-Zustands
   (bei DHCP inklusive der zugewiesenen Adresse, Gateway, DNS, Lease).
   Nichts wird angewendet, bevor „Übernehmen" gedrückt und bestätigt wurde.
2. **Aussperr-Schutz mit Probezeit.** Wer die IP ändert, sägt am Ast, auf dem
   die Verbindung sitzt. Deshalb gelten neue Netzwerkeinstellungen zunächst
   **auf Probe (90 s)**: Die UI leitet auf die neue Adresse um; kommt dort
   innerhalb der Frist keine Bestätigung an, stellt der Pi den vorherigen
   Zustand automatisch wieder her — dasselbe Muster wie der Update-Rollback.
3. **Hostname nur hier, nur ausdrücklich.** Der Standortname (M9.1) bleibt
   ein reines Anzeige-Etikett; die Hostname-Änderung ist eine bewusste
   Administrations-Aktion auf dieser Seite (`hostnamectl`). Nichts ändert
   den Hostnamen implizit.
4. **Auth-Pflicht** wie bei `/api/update/*`; standardmäßig zusätzlich nur mit
   gesetztem Token nutzbar.
5. **Privilegien wie beim Update.** Der unprivilegierte Dienst schreibt eine
   Auftragsdatei (JSON) ins Datenverzeichnis; eine systemd-Path-Unit startet
   `netz-anwenden.sh` als root. `NoNewPrivileges` bleibt intakt.

## Technik (Raspberry Pi OS Bookworm/Trixie)

- **NetworkManager** (`nmcli`) für DHCP/Statisch/Gateway/DNS:
  `nmcli con mod <verbindung> ipv4.method auto|manual ipv4.addresses …
  ipv4.gateway … ipv4.dns …` + `nmcli con up`
- **Lesen** ohne Root: `ip -j addr` / `ip -j route`, `nmcli -t device show`,
  `resolvectl status`, `timedatectl show`, `hostnamectl status`
- **NTP**: `timedatectl set-ntp` bzw. `NTP=` in
  `/etc/systemd/timesyncd.conf` + Neustart von systemd-timesyncd;
  Anzeige inkl. Sync-Zustand (wichtig für die Verbund-Zeitbasis, M9.2)
- **Hostname**: `hostnamectl set-hostname` (+ `/etc/hosts`-Eintrag pflegen)
- **Fallback**: Systeme ohne NetworkManager (dhcpcd) → Anzeige funktioniert,
  Ändern ist mit klarem Hinweis deaktiviert statt halb zu funktionieren

## API

| Endpunkt | Zweck |
| --- | --- |
| `GET /api/netzwerk` | Ist-Zustand: Methode (dhcp/statisch), Adresse(n), Gateway, DNS, Hostname, NTP-Server + Sync-Status, DHCP-Lease-Infos |
| `POST /api/netzwerk` *(Auth)* | Auftrag `{method, address, prefix, gateway, dns[], hostname?, ntp?}` → 202, Probezeit läuft |
| `POST /api/netzwerk/bestaetigen` *(Auth)* | macht die Probe-Einstellungen dauerhaft |
| `GET /api/netzwerk/status` | Fortschritt/Ergebnis über die Statusdatei — übersteht Verbindungswechsel |

## UI

*Einstellungen → Netzwerk*: Live-Anzeige mit „per DHCP zugewiesen"-Kennzeichnung,
Umschalter DHCP/Statisch, Eingabefelder (nur bei Statisch aktiv), Hostname- und
NTP-Feld, deutliche Warnbox vor der Übernahme und Countdown der Probezeit mit
automatischer Weiterleitung auf die neue Adresse.

## Einordnung

Meilenstein **M7.6**, umgesetzt **zusammen mit M9.2** (Verbund-Dashboard) —
entschieden am 29.07.2026: Beide Bausteine teilen sich die Mechanik
(Auftragsdatei + Path-Unit, Statusdatei, auth-pflichtige API) und die
Einstellungen-Seite wird nur einmal umgebaut. Akzeptanz: (a) DHCP-Werte werden korrekt angezeigt,
(b) Wechsel DHCP→Statisch→DHCP übersteht die Probezeit-Mechanik inklusive
absichtlich provoziertem Rollback, (c) ohne Bestätigung ist nach 90 s der
alte Zustand wiederhergestellt, (d) bestehende Installationen verhalten sich
ohne Nutzung der Seite exakt wie bisher.
