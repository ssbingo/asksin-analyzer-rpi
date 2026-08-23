#!/usr/bin/env bash
# Prüft, dass jede systemd-Unit aus deploy/ auch ausgerollt wird.
#
# Anlass: Die OLED-Unit wurde von update.sh nur neu gestartet, nie ersetzt.
# Eine Änderung darin — RuntimeDirectory — kam dadurch nie auf dem Gerät an,
# Core und Anzeigedienst landeten in verschiedenen Verzeichnissen, und die
# Anzeige fiel wortlos auf ihre Notfall-Seitenzahl zurück. Der Fehler lag
# nicht im Code, sondern in einer vergessenen Zeile in einer Liste.
#
# Solche Listen laufen still auseinander. Deshalb prüft das hier maschinell:
# Für jede Unit in deploy/ muss es in install.sh UND update.sh eine Zeile
# geben, die sie nach /etc/systemd/system kopiert.
#
# Aufruf:
#   bash tools/pruefe-units.sh      # 0 = vollständig, 1 = etwas fehlt

set -euo pipefail
cd "$(dirname "$0")/.."

# Units mit eigenem Einrichtungsweg. Wer hier etwas einträgt, muss den Grund
# dazuschreiben — sonst wird die Ausnahmeliste zur Ausrede.
AUSNAHMEN=(
    # Wird von deploy/oled-einrichten.sh installiert, weil dort die Bauhöhe
    # als Argument in die Unit geschrieben wird. update.sh ersetzt sie
    # trotzdem — deshalb steht sie nur für install.sh hier drin.
    "asksin-analyzer-oled.service:install.sh"
    # Die LED-Unit entsteht nur, wenn die Statusanzeige gewählt wurde.
    "asksin-analyzer-led.service:update.sh"
)

ausgenommen() {  # ausgenommen <unit> <skript>
    local eintrag
    for eintrag in "${AUSNAHMEN[@]}"; do
        [ "$eintrag" = "$1:$2" ] && return 0
    done
    return 1
}

fehlt=0
gesamt=0

for pfad in deploy/*.service deploy/*.path; do
    unit="$(basename "$pfad")"
    gesamt=$((gesamt + 1))
    for skript in install.sh update.sh; do
        if grep -q "deploy/$unit" "$skript"; then
            continue
        fi
        if ausgenommen "$unit" "$skript"; then
            printf '  ~  %-38s %s (Ausnahme)\n' "$unit" "$skript"
            continue
        fi
        printf '  FEHLT  %-34s wird von %s nicht ausgerollt\n' "$unit" "$skript"
        fehlt=$((fehlt + 1))
    done
done

# ---------------------------------------------------------------------------
# Dieselbe Frage fuer die udev-Regeln.
#
# Am 18.08.2026 kam die Regel fuer den Zigbee-Stick dazu — und update.sh rollte
# udev-Regeln ueberhaupt nicht aus. Auf jeder bestehenden Anlage waere sie nie
# angekommen: /dev/asksin-zigbee gaebe es nicht, der Mithoerer faende sein
# Geraet nicht, und die Suche begaenne beim Funk statt bei einer Datei, die nie
# kopiert wurde. Gefunden wurde das nur, weil jemand vor dem Ausrollen
# nachgesehen hat — nicht durch eine Pruefung. Jetzt durch eine.

echo
for pfad in hardware/*.rules; do
    [ -e "$pfad" ] || continue
    regel="$(basename "$pfad")"
    gesamt=$((gesamt + 1))
    for skript in install.sh update.sh; do
        if grep -q "hardware/$regel" "$skript"; then
            continue
        fi
        printf '  FEHLT  %-34s wird von %s nicht ausgerollt\n' "$regel" "$skript"
        fehlt=$((fehlt + 1))
    done
done

# ---------------------------------------------------------------------------
# Dieselbe Frage fuer die Grafana-Vorlagen.
#
# Sie sind auf denselben Fehler hereingefallen wie die OLED-Unit: einmal beim
# Einrichten geschrieben, danach nie wieder. Verbesserte Alarmtexte lagen
# wochenlang im Repo, waehrend auf dem Geraet die alten liefen — und niemand
# konnte das ahnen, weil nichts fehlschlug.
#
# Zwei Dateien sind ausgenommen, mit Grund:
#   asksin-influx.yaml.vorlage  enthaelt den Zugangstoken, den nur das
#                               Einrichtungsskript kennt
VORLAGEN_AUSNAHMEN=("asksin-influx.yaml.vorlage")

vorlage_ausgenommen() {
    local e
    for e in "${VORLAGEN_AUSNAHMEN[@]}"; do
        [ "$e" = "$1" ] && return 0
    done
    return 1
}

echo
for pfad in deploy/grafana/provisioning/*/*.yaml* deploy/grafana/dashboards/*.json; do
    [ -e "$pfad" ] || continue
    datei="$(basename "$pfad")"
    gesamt=$((gesamt + 1))
    if vorlage_ausgenommen "$datei"; then
        printf '  ~  %-38s nur beim Einrichten (Ausnahme)\n' "$datei"
        continue
    fi
    # Die acht Dashboards werden als Gruppe kopiert (dashboards/*.json),
    # deshalb genuegt der Nachweis des Verzeichnisses.
    if grep -q "deploy/grafana/dashboards/\*.json" update.sh && \
       [ "${pfad#deploy/grafana/dashboards/}" != "$pfad" ]; then
        continue
    fi
    if grep -q "$datei" update.sh; then
        continue
    fi
    printf '  FEHLT  %-34s wird von update.sh nicht ausgerollt\n' "$datei"
    fehlt=$((fehlt + 1))
done

echo
if [ "$fehlt" -gt 0 ]; then
    echo "$fehlt fehlende Zuordnung(en) bei $gesamt Dateien." >&2
    echo "Was nicht ausgerollt wird, altert auf dem Geraet vor sich hin —" >&2
    echo "seine Aenderungen kommen nie an, und nichts schlaegt fehl." >&2
    exit 1
fi
# Reicht nicht: In der Liste stehen heisst noch nicht, beim ERSTEN Update
# anzukommen. `installiere_dateien` wird nach dem Pull aufgerufen, ihr Rumpf
# stammt aber aus der Fassung davor — ohne Neustart des Skripts kaeme jede neu
# eingetragene Unit erst beim uebernaechsten Update an. Gemessen am 23.08.2026
# an den Units der Alarmschalter.
if ! grep -q 'exec bash "$INSTALL_DIR/update.sh"' update.sh; then
    echo "update.sh startet sich nach dem Pull nicht mit der neuen Fassung neu." >&2
    echo "Neue Units kaemen dann erst beim uebernaechsten Update an." >&2
    exit 1
fi

echo "$gesamt Dateien (Units und Grafana-Vorlagen), alle werden ausgerollt;"
echo "update.sh laeuft nach dem Pull mit der neuen Fassung weiter."
