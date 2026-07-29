# Installation auf dem Raspberry Pi

Ein Aufruf genügt — der Installer ([`../install.sh`](../install.sh)) ist
idempotent, erneutes Ausführen aktualisiert die Installation.

**Solange das Repo privat ist** (SSH-Deploy-Key auf dem Pi vorausgesetzt):

```bash
sudo git clone git@github.com:ssbingo/asksin-analyzer-rpi.git /opt/asksin-analyzer
sudo /opt/asksin-analyzer/install.sh
```

**Sobald das Repo öffentlich ist**, reicht die eine Zeile:

```bash
curl -fsSL https://raw.githubusercontent.com/ssbingo/asksin-analyzer-rpi/main/install.sh | sudo bash
```

## Was der Installer tut

1. System-Pakete: `git`, `curl`, `gpiod` (328P-Reset), `avrdude` (Firmware-Flash)
2. Node.js 24 über NodeSource, falls nicht vorhanden — der Core läuft ohne
   Buildschritt direkt auf den TypeScript-Quellen (natives Type-Stripping)
3. Repo nach `/opt/asksin-analyzer` klonen bzw. aktualisieren
4. Web-UI bauen (`webui/dist`)
5. Dienstbenutzer `asksin` (Gruppe `dialout`), Verzeichnisse
   `/var/lib/asksin-analyzer` und `/etc/asksin-analyzer`
6. **Konfigurations-Assistent**: CCU-Adresse, HTTP-Port, LAN-Bindung,
   optional ein zufälliges Auth-Token für Schreibzugriffe
7. udev-Regel (fester Gerätename `/dev/asksin-hat`) und auf Wunsch die
   UART-Einrichtung (`hardware/setup-uart.sh`, braucht danach einen Neustart)
8. systemd-Dienst [`asksin-analyzer.service`](asksin-analyzer.service)
   aktivieren und starten — mit Neustart-bei-Absturz und Sandbox-Härtung
9. Verwaltungsbefehl [`asksin-analyzer`](asksin-analyzer) nach
   `/usr/local/bin`

Danach läuft die Weboberfläche auf `http://<pi>:8080`. Ohne gesteckten
Sniffer-HAT meldet sie „Sniffer getrennt" und der Dienst versucht es mit
Backoff weiter — der HAT kann jederzeit später dazukommen.

**Ohne Hardware ausprobieren:** Der Schalter *Einstellungen → Demo-Modus*
startet den Dienst mit einer simulierten Anlage (~15 Geräte, eigene
Demo-Datenbank) — läuft ganz ohne Homematic-Zentrale und ohne Platine.

## Dateien und Pfade

| Pfad | Inhalt |
| --- | --- |
| `/opt/asksin-analyzer` | Quellcode (Git-Checkout) |
| `/etc/asksin-analyzer/config.json` | Konfiguration ([Vorlage](config.example.json)) |
| `/var/lib/asksin-analyzer/` | SQLite-Datenbank + DevList-Cache |
| `/etc/systemd/system/asksin-analyzer.service` | Dienstdefinition |
| `/usr/local/bin/asksin-analyzer` | Verwaltungsbefehl |

## Verwaltung

```bash
asksin-analyzer status     # Dienststatus
asksin-analyzer logs       # Live-Log (journald)
asksin-analyzer health     # Kurzcheck der API
asksin-analyzer config     # Konfiguration bearbeiten (+ restart)
sudo asksin-analyzer update  # neuer Stand + UI-Build + Neustart
```

`/reboot` aus der Weboberfläche beendet den Prozess kontrolliert;
systemd (`Restart=always`) startet ihn sofort neu.

## Updates aus der Weboberfläche

*Info → Software-Update* sucht nach neuen Ständen und installiert sie:
Der Dienst legt eine Trigger-Datei an, die Path-Unit
[`asksin-analyzer-update.path`](asksin-analyzer-update.path) startet
`update.sh` als root — atomar, mit Health-Check und automatischem
Rollback. Fortschritt: `/var/lib/asksin-analyzer/update-status.json`,
Protokoll: `update.log` daneben. *Info → Sniffer-Firmware* flasht eine
hochgeladene HEX-Datei auf den 328P (Ingest pausiert, Reset über GPIO4
bzw. DTR, avrdude mit 58 824 Baud).
