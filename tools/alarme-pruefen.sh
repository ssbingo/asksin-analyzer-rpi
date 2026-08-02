#!/usr/bin/env bash
# Führt die Abfragen der vier Alarme direkt gegen InfluxDB aus.
#
# Anlass: Scheitert eine Abfrage, meldet Grafana das als "DatasourceError" —
# ohne zu sagen, WORAN sie gescheitert ist. Man sieht nur, dass etwas kaputt
# ist, und muss raten. Dieses Skript stellt dieselben Fragen und gibt die
# Antwort der Datenbank wörtlich zurück.
#
# Aufruf (auf dem Master):
#   sudo bash /opt/asksin-analyzer/tools/alarme-pruefen.sh

set -uo pipefail

DATEN_DIR="${DATEN_DIR:-/var/lib/asksin-analyzer}"
KONF="$DATEN_DIR/influx.json"

[ -r "$KONF" ] || { echo "Keine Influx-Konfiguration unter $KONF." >&2; exit 1; }

lies() { python3 -c "import json,sys;print(json.load(open('$KONF')).get('$1',''))"; }
URL="$(lies url)"; ORG="$(lies org)"; BUCKET="$(lies bucket)"; TOKEN="$(lies token)"

echo "Datenbank : $URL"
echo "Organisation: $ORG   Bucket: $BUCKET"
echo "Token     : ${TOKEN:0:8}… (${#TOKEN} Zeichen)"
# Ein kopierter Zeilenumbruch im Token ist die haeufigste Ursache fuer 401 —
# er ist unsichtbar, deshalb hier ausdruecklich benannt.
case "$TOKEN" in
    *[[:space:]]*) echo "  !! Der Token enthaelt ein Leerzeichen oder einen Umbruch." ;;
esac
echo

frage() {                       # frage <name> <flux>
    local name="$1" flux="$2" antwort http
    antwort="$(curl -sS -w '\n%{http_code}' \
        -X POST "${URL%/}/api/v2/query?org=$(printf '%s' "$ORG" | jq -sRr @uri)" \
        -H "Authorization: Token $TOKEN" \
        -H 'Content-Type: application/vnd.flux' \
        -H 'Accept: application/csv' \
        --data-binary "$flux" 2>&1)"
    http="$(tail -1 <<<"$antwort")"
    antwort="$(sed '$d' <<<"$antwort")"
    local zeilen
    zeilen="$(grep -cvE '^(#|,|$)' <<<"$antwort" || true)"

    if [ "$http" = "200" ]; then
        printf '  ok   %-28s %s Ergebniszeile(n)\n' "$name" "$zeilen"
        [ "$zeilen" -eq 0 ] && printf '       %-28s (leer — dann meldet Grafana NoData, keinen Fehler)\n' ""
    else
        printf '  FEHLER %-26s HTTP %s\n' "$name" "$http"
        sed 's/^/         /' <<<"$antwort" | head -6
    fi
}

frage "Analyzer offline" '
from(bucket: "'"$BUCKET"'")
  |> range(start: -15m)
  |> filter(fn: (r) => r._measurement == "analyzer")
  |> filter(fn: (r) => r._field == "connected")
  |> group(columns: ["standort"])
  |> last()
  |> map(fn: (r) => ({ r with _value: if r._value then 1.0 else 0.0 }))'

frage "Duty-Cycle über 80 %" '
from(bucket: "'"$BUCKET"'")
  |> range(start: -30m)
  |> filter(fn: (r) => r._measurement == "geraet")
  |> filter(fn: (r) => r._field == "dutyCycle")
  |> group(columns: ["name"])
  |> max()'

frage "Gerät stumm" '
from(bucket: "'"$BUCKET"'")
  |> range(start: -1h)
  |> filter(fn: (r) => r._measurement == "geraet")
  |> filter(fn: (r) => r._field == "sekundenSeitEmpfang")
  |> group(columns: ["standort", "name"])
  |> last()
  |> group(columns: ["name"])
  |> min()'

frage "Grundrauschen" '
from(bucket: "'"$BUCKET"'")
  |> range(start: -1h)
  |> filter(fn: (r) => r._measurement == "analyzer")
  |> filter(fn: (r) => r._field == "grundrauschen")
  |> group(columns: ["standort"])
  |> mean()'

echo
echo "Welche Felder liegen ueberhaupt in der Datenbank?"
curl -sS -X POST "${URL%/}/api/v2/query?org=$(printf '%s' "$ORG" | jq -sRr @uri)" \
    -H "Authorization: Token $TOKEN" -H 'Content-Type: application/vnd.flux' \
    -H 'Accept: application/csv' --data-binary '
import "influxdata/influxdb/schema"
schema.fieldKeys(bucket: "'"$BUCKET"'")' \
  | grep -vE '^(#|,|$)' | awk -F, '{print "  "$4}' | sort -u | head -20
