#!/usr/bin/env bash
# Legt den Zeitplan fuer die Systemaktualisierung an seinen Platz.
#
# Bewusst SCHMAL, wie alarmziel-anwenden.sh: Der Inhalt der Timer-Unit entsteht
# im Core und ist dort getestet (src/update/systemupdate.ts). Hier wird nur
# kopiert, ein- oder ausgeschaltet.
#
# Der Core signalisiert "Plan aus", indem er die Timer-Datei LOESCHT. Damit
# braucht dieses Skript kein JSON zu lesen — die Anwesenheit der Datei ist die
# ganze Auskunft.
#
# Aufruf ueber die Path-Unit; von Hand:
#   sudo bash zeitplan-anwenden.sh

set -euo pipefail

DATEN_DIR="${DATEN_DIR:-/var/lib/asksin-analyzer}"
QUELLE="$DATEN_DIR/systemupdate.timer"
ANSTOSS="$DATEN_DIR/zeitplan-anstoss"
TIMER="asksin-analyzer-systemupdate.timer"
ZIEL="/etc/systemd/system/$TIMER"

aufraeumen() { rm -f "$ANSTOSS"; }
trap aufraeumen EXIT

[ "$(id -u)" -eq 0 ] || { echo "Bitte mit sudo starten." >&2; exit 1; }

if [ ! -f "$QUELLE" ]; then
    # Plan abgeschaltet: Timer stilllegen UND die Unit entfernen. Nur
    # "disable" liesse die Datei liegen; ein spaeteres `enable` von Hand
    # brachte dann einen Plan zurueck, den niemand mehr eingestellt hat.
    systemctl disable --now "$TIMER" >/dev/null 2>&1 || true
    rm -f "$ZIEL"
    systemctl daemon-reload
    echo "Zeitplan abgeschaltet."
    exit 0
fi

install -m 0644 "$QUELLE" "$ZIEL"
systemctl daemon-reload
systemctl enable --now "$TIMER"
# Die tatsaechliche naechste Zuendung ins Journal — damit im Zweifel belegbar
# ist, was systemd aus dem Ausdruck gemacht hat, und nicht nur, was die
# Oberflaeche vorgerechnet hat.
systemctl show "$TIMER" -p NextElapseUSecRealtime --value
echo "Zeitplan angewendet."
