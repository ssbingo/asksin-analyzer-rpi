#!/usr/bin/env bash
# Prueft, dass der Core nicht aus InfluxDB LIEST.
#
# ## Anlass
#
# Bis zum 25.08.2026 zaehlte die Uebersichtsseite die Standorte mit einer
# Flux-Abfrage (`schema.tagValues`). Die war richtig — bis die InfluxDB-Token
# getrennt wurden: Grafana bekam einen Lese-, die Analyzer einen Schreib-Token.
#
# Seither sieht ein Analyzer den Bucket nicht mehr. InfluxDB antwortet darauf
# nicht mit "verboten", sondern mit
#
#     HTTP 404  could not find bucket "..."
#
# Ein `catch` machte daraus ein stilles "nicht ermittelbar", und in der
# Uebersicht stand monatelang ein Strich. Niemand meldete etwas.
#
# Der Schreib-Token ist richtig so: Ein Analyzer im Gartenhaus soll die
# Datenbank fuettern und nicht ausleseren koennen. Falsch war, eine Anzeige an
# einen Zugriff zu haengen, den das Geraet gar nicht mehr haben soll. Diese
# Pruefung haelt fest, dass so etwas nicht zurueckkommt.
#
# Aufruf:
#   bash tools/pruefe-influx-lesezugriff.sh    # 0 = sauber, 1 = Fund

set -uo pipefail
cd "$(dirname "$0")/.."

fehlt=0

# Der Weg zum Lesen ist bei InfluxDB 2 immer /api/v2/query bzw. der
# Flux-Inhaltstyp. Schreiben laeuft ueber /api/v2/write.
treffer="$(grep -rn "api/v2/query\|vnd\.flux" core/src core/bin \
    --include='*.ts' 2>/dev/null | grep -v "sammlung\.ts" || true)"

if [ -n "$treffer" ]; then
    echo "Der Core liest aus InfluxDB — mit einem Schreib-Token kann das nicht gehen:" >&2
    echo "$treffer" >&2
    echo >&2
    echo "InfluxDB antwortet einem Schreib-Token mit HTTP 404 'could not find" >&2
    echo "bucket', nicht mit einem Rechtefehler. Wer das faengt und still" >&2
    echo "wegwirft, baut genau den Strich, der uns das eingebrockt hat." >&2
    echo "Hintergrund: core/src/influx/sammlung.ts, Kopf der Datei." >&2
    fehlt=1
fi

# Gegenprobe in die andere Richtung: Der Schreibweg MUSS es noch geben.
if ! grep -rq "api/v2/write" core/src --include='*.ts'; then
    echo "Der Schreibweg /api/v2/write fehlt — dann schreibt niemand mehr." >&2
    fehlt=1
fi

[ "$fehlt" -ne 0 ] && exit 1
echo "Core liest nicht aus InfluxDB; der Schreibweg ist vorhanden."
