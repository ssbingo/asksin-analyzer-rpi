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

echo
if [ "$fehlt" -gt 0 ]; then
    echo "$fehlt fehlende Zuordnung(en) bei $gesamt Units." >&2
    echo "Eine Unit, die nicht ausgerollt wird, altert auf dem Geraet vor sich" >&2
    echo "hin — ihre Aenderungen kommen nie an." >&2
    exit 1
fi
echo "$gesamt Units, alle werden von install.sh und update.sh ausgerollt."
