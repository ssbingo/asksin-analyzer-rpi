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
