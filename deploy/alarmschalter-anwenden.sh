#!/usr/bin/env bash
# Legt die vom Analyzer erzeugte Alarmregel-Datei an ihren Platz.
#
# Bewusst SCHMAL, wie alarmziel-anwenden.sh: Der Inhalt entsteht im Core und
# ist dort getestet (src/langzeit/alarmschalter.ts). Hier wird nur kopiert und
# neu gestartet — je weniger im privilegierten Teil passiert, desto besser.
#
# Anlass (21.08.2026): Die Meldung "Geraet seit 24 Stunden stumm" kam jeden
# Abend, weil nicht jeden Tag jedes Fenster geoeffnet und jeder Schalter
# gedrueckt wird. Wer eine Meldung gewohnheitsmaessig wegklickt, klickt auch
# die weg, die zaehlt. Also muss sie einzeln abschaltbar sein.
#
# Aufruf ueber die Path-Unit; von Hand:
#   sudo bash alarmschalter-anwenden.sh

set -euo pipefail

DATEN_DIR="${DATEN_DIR:-/var/lib/asksin-analyzer}"
QUELLE="$DATEN_DIR/grafana-alarme.yaml"
ANSTOSS="$DATEN_DIR/alarmschalter-anstoss"
ZIEL="/etc/grafana/provisioning/alerting/asksin-alarme.yaml"

aufraeumen() { rm -f "$ANSTOSS"; }
trap aufraeumen EXIT

[ "$(id -u)" -eq 0 ] || { echo "Bitte mit sudo starten." >&2; exit 1; }

if [ ! -d /etc/grafana ]; then
    echo "Grafana ist nicht installiert — nichts zu tun." >&2
    exit 0
fi
[ -f "$QUELLE" ] || { echo "Keine Vorlage unter $QUELLE." >&2; exit 1; }

# Keine Zugangsdaten darin — im Gegensatz zum Alarmziel. 0644 genuegt.
install -d -m 0755 "$(dirname "$ZIEL")"
install -m 0644 "$QUELLE" "$ZIEL"

systemctl restart grafana-server
echo "Alarmschalter angewendet."
