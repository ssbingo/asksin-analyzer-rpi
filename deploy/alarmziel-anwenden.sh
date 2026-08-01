#!/usr/bin/env bash
# Legt die vom Analyzer erzeugten Grafana-Dateien an ihren Platz.
#
# Bewusst SCHMAL gehalten: Der Inhalt beider Dateien entsteht im Core und ist
# dort getestet (src/langzeit/alarmziel.ts). Hier wird nur kopiert und neu
# gestartet — je weniger im privilegierten Teil passiert, desto besser.
#
# Aufruf ueber die Path-Unit; von Hand:
#   sudo bash alarmziel-anwenden.sh

set -euo pipefail

DATEN_DIR="${DATEN_DIR:-/var/lib/asksin-analyzer}"
QUELLE_YAML="$DATEN_DIR/grafana-alarmziel.yaml"
QUELLE_SMTP="$DATEN_DIR/grafana-smtp.conf"
ANSTOSS="$DATEN_DIR/alarmziel-anstoss"

ZIEL_YAML="/etc/grafana/provisioning/alerting/asksin-alarmziel.yaml"
DROPIN_DIR="/etc/systemd/system/grafana-server.service.d"

aufraeumen() { rm -f "$ANSTOSS"; }
trap aufraeumen EXIT

[ "$(id -u)" -eq 0 ] || { echo "Bitte mit sudo starten." >&2; exit 1; }

if [ ! -d /etc/grafana ]; then
    echo "Grafana ist nicht installiert — nichts zu tun." >&2
    exit 0
fi
[ -f "$QUELLE_YAML" ] || { echo "Keine Vorlage unter $QUELLE_YAML." >&2; exit 1; }

# Beide Dateien enthalten Zugangsdaten (Bot-Token bzw. SMTP-Passwort).
# 0640 mit Gruppe grafana: lesbar fuer den Dienst, sonst fuer niemanden.
install -d -m 0755 "$(dirname "$ZIEL_YAML")"
install -m 0640 "$QUELLE_YAML" "$ZIEL_YAML"
chown root:grafana "$ZIEL_YAML" 2>/dev/null || true

install -d -m 0755 "$DROPIN_DIR"
install -m 0600 "$QUELLE_SMTP" "$DROPIN_DIR/asksin-smtp.conf"

systemctl daemon-reload
systemctl restart grafana-server

# Warten und melden: Ein "restart" kehrt sofort zurueck, auch wenn Grafana
# gleich darauf an einer fehlerhaften Provisionierung scheitert.
for _ in $(seq 1 60); do
    if curl -fsS http://127.0.0.1:3000/api/health >/dev/null 2>&1; then
        echo "Alarmziel angewendet, Grafana laeuft."
        exit 0
    fi
    sleep 1
done
echo "Grafana antwortet nach 60 s nicht — journalctl -u grafana-server." >&2
exit 1
