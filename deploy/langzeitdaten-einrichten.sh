#!/usr/bin/env bash
# Richtet InfluxDB und Grafana auf diesem Analyzer ein (M14).
#
# Das ist eine ZUSATZOPTION. Der bisherige Weg — Daten an eine externe
# InfluxDB schicken — bleibt davon unberührt und ist weiter wählbar. Hier
# entsteht lediglich ein Ziel auf demselben Gerät.
#
# Nur auf dem Master: Ein Verbund braucht genau eine Datenhaltung, nicht fünf.
# Und nur auf Hardware, die es trägt — ab Raspberry Pi 4 mit mindestens 2 GB.
# Beides wird hier geprüft, nicht nur in der Weboberfläche.
#
# Aufruf:
#   sudo bash langzeitdaten-einrichten.sh              # einrichten
#   sudo bash langzeitdaten-einrichten.sh --pruefen    # nur Voraussetzungen
#   sudo bash langzeitdaten-einrichten.sh --status     # was ist installiert
#
# Mehrfaches Ausführen ist unschädlich: Jeder Schritt prüft zuerst, ob er
# schon erledigt ist. Ein abgebrochener Lauf lässt sich einfach wiederholen.

set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-/opt/asksin-analyzer}"
DATEN_DIR="${DATEN_DIR:-/var/lib/asksin-analyzer}"
CONFIG_DIR="${CONFIG_DIR:-/etc/asksin-analyzer}"
DIENST_BENUTZER="${DIENST_BENUTZER:-asksin}"

STATUS_DATEI="$DATEN_DIR/langzeit-status.json"
ANSTOSS="$DATEN_DIR/langzeit-anstoss"
ZUGANG="$CONFIG_DIR/influx-zugang.txt"

ORG="asksin"
BUCKET="asksin"
# Zwei Jahre. Bei rund 5-10 MB je Tag und Analyzer sind das etwa 10-15 GB —
# auf der SSD kein Thema, und zwei Jahre reichen für jeden Jahresvergleich.
AUFBEWAHRUNG="${AUFBEWAHRUNG:-730d}"

GRAFANA_DASHBOARDS="/var/lib/grafana/dashboards/asksin"
GRAFANA_PROV="/etc/grafana/provisioning"

# --------------------------------------------------------------- Meldungen

SCHRITT=""

melde() {
    # Fortschritt für die Weboberfläche. Sie fragt die Datei im Sekundentakt
    # ab — ohne sie stünde dort minutenlang nur "läuft".
    SCHRITT="$1"
    local fertig="${2:-false}" fehler="${3:-}"
    printf '{\n  "schritt": %s,\n  "fertig": %s,\n  "fehler": %s,\n  "zeit": "%s"\n}\n' \
        "$(json_text "$SCHRITT")" "$fertig" "$(json_text "$fehler")" \
        "$(date -Is)" > "$STATUS_DATEI"
    chown "$DIENST_BENUTZER": "$STATUS_DATEI" 2>/dev/null || true
    echo "==> $SCHRITT"
}

json_text() {
    # Anführungszeichen und Backslashes müssen escaped werden, sonst zerlegt
    # eine Fehlermeldung mit Pfadangabe die ganze Datei.
    [ -z "${1:-}" ] && { printf 'null'; return; }
    printf '%s' "$1" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'
}

scheitern() {
    melde "$SCHRITT" false "$1"
    echo "FEHLER: $1" >&2
    rm -f "$ANSTOSS"
    exit 1
}

# ------------------------------------------------------------ Voraussetzungen

pruefe_voraussetzungen() {
    [ "$(id -u)" -eq 0 ] || scheitern "Bitte mit sudo starten."

    local modell ram_kb ram_gb baureihe
    modell="$(tr -d '\0' < /proc/device-tree/model 2>/dev/null || echo '')"
    ram_kb="$(awk '/MemTotal/{print $2}' /proc/meminfo)"
    ram_gb="$(awk -v k="$ram_kb" 'BEGIN{printf "%.1f", k/1048576}')"

    # Dieselbe Regel wie im Core (src/langzeit/rolle.ts): ab Baureihe 4 und
    # ab 2 GB. Geprueft wird die NUMMER, nicht eine Liste aus 4 und 5 — sonst
    # muesste beim naechsten Modell an zwei Stellen nachgezogen werden.
    baureihe="$(sed -nE 's/.*Raspberry Pi ([0-9]+).*/\1/p' <<<"$modell")"
    if [ -n "$baureihe" ] && [ "$baureihe" -lt 4 ]; then
        scheitern "Raspberry Pi $baureihe ist als Master zu schwach — nötig ist mindestens ein Pi 4. Dieses Gerät kann als Client mitlaufen."
    fi
    # 1,8 GiB statt glatter 2: Ein echter 2-GB-Pi meldet nie die vollen
    # 2*1024^2 kB, weil Firmware und Grafikspeicher vorher abgehen.
    if [ "$ram_kb" -lt 1887436 ]; then
        scheitern "$ram_gb GB Arbeitsspeicher reichen nicht — nötig sind mindestens 2 GB. InfluxDB und Grafana belegen zusammen rund 700 MB."
    fi

    # Rolle: Was die Weboberflaeche gesetzt hat, schlaegt config.json.
    local rolle="master"
    if [ -f "$DATEN_DIR/verbund-rolle.json" ]; then
        rolle="$(python3 -c "
import json,sys
try: print(json.load(open('$DATEN_DIR/verbund-rolle.json')).get('rolle','master'))
except Exception: print('master')")"
    elif [ -f "$CONFIG_DIR/config.json" ]; then
        rolle="$(python3 -c "
import json,sys
try: print(json.load(open('$CONFIG_DIR/config.json')).get('verbund',{}).get('rolle','master'))
except Exception: print('master')")"
    fi
    [ "$rolle" = "master" ] || scheitern "Dieses Gerät ist als Client eingetragen. Langzeitdaten gehören auf den Master."

    local frei_gb
    frei_gb="$(df --output=avail -BG "$DATEN_DIR" | tail -1 | tr -dc '0-9')"
    if [ "${frei_gb:-0}" -lt 20 ]; then
        scheitern "Nur ${frei_gb} GB frei — für zwei Jahre Langzeitdaten sollten es mindestens 20 GB sein."
    fi

    getent group grafana >/dev/null 2>&1 || true
    echo "  Modell        : ${modell:-unbekannt}"
    echo "  Arbeitsspeicher: $ram_gb GB"
    echo "  Rolle         : $rolle"
    echo "  Frei auf $DATEN_DIR: ${frei_gb} GB"
}

# ------------------------------------------------------------------ Pakete

paketquellen() {
    apt-get install -y -qq ca-certificates curl gnupg >/dev/null

    if [ ! -f /etc/apt/keyrings/influxdata-archive.gpg ]; then
        install -d -m 0755 /etc/apt/keyrings
        curl -fsSL https://repos.influxdata.com/influxdata-archive.key \
            | gpg --dearmor -o /etc/apt/keyrings/influxdata-archive.gpg \
            || scheitern "Schlüssel von repos.influxdata.com nicht erreichbar — hat das Gerät Internet?"
        chmod 0644 /etc/apt/keyrings/influxdata-archive.gpg
    fi
    echo "deb [signed-by=/etc/apt/keyrings/influxdata-archive.gpg] https://repos.influxdata.com/debian stable main" \
        > /etc/apt/sources.list.d/influxdata.list

    if [ ! -f /etc/apt/keyrings/grafana.gpg ]; then
        curl -fsSL https://apt.grafana.com/gpg.key \
            | gpg --dearmor -o /etc/apt/keyrings/grafana.gpg \
            || scheitern "Schlüssel von apt.grafana.com nicht erreichbar — hat das Gerät Internet?"
        chmod 0644 /etc/apt/keyrings/grafana.gpg
    fi
    echo "deb [signed-by=/etc/apt/keyrings/grafana.gpg] https://apt.grafana.com stable main" \
        > /etc/apt/sources.list.d/grafana.list

    apt-get update -qq || scheitern "apt-get update fehlgeschlagen — siehe journalctl."
}

# ---------------------------------------------------------------- InfluxDB

richte_influx_ein() {
    if ! command -v influxd >/dev/null 2>&1; then
        DEBIAN_FRONTEND=noninteractive apt-get install -y -qq influxdb2 influxdb2-cli \
            || scheitern "InfluxDB liess sich nicht installieren."
    fi
    systemctl enable --now influxdb >/dev/null 2>&1 || true

    # Auf den Dienst warten, bevor eingerichtet wird — er braucht ein paar
    # Sekunden, und 'influx setup' scheitert sonst mit "connection refused".
    local versuche=0
    until curl -fsS http://127.0.0.1:8086/health >/dev/null 2>&1; do
        versuche=$((versuche + 1))
        [ "$versuche" -gt 60 ] && scheitern "InfluxDB antwortet nach 60 s nicht auf 127.0.0.1:8086."
        sleep 1
    done

    if [ -f "$ZUGANG" ]; then
        echo "  InfluxDB ist bereits eingerichtet — Zugangsdaten bleiben."
        return
    fi

    # Token und Passwort selbst erzeugen, statt sie aus der Ausgabe zu
    # fischen: Das ist verlaesslich und macht den Lauf wiederholbar.
    local admin_pw token
    admin_pw="$(openssl rand -base64 24 | tr -d '/+=' | head -c 24)"
    token="$(openssl rand -hex 32)"

    influx setup --skip-verify --force \
        --host http://127.0.0.1:8086 \
        --username asksin-admin \
        --password "$admin_pw" \
        --org "$ORG" \
        --bucket "$BUCKET" \
        --retention "$AUFBEWAHRUNG" \
        --token "$token" >/dev/null \
        || scheitern "InfluxDB-Ersteinrichtung fehlgeschlagen."

    # Root-only: Hier steht das Passwort im Klartext. In die Weboberflaeche
    # gehoert es nicht — sie braucht es auch nicht, Grafana arbeitet mit dem
    # Token.
    install -m 0600 /dev/null "$ZUGANG"
    cat > "$ZUGANG" <<EOF
# Zugangsdaten der lokalen InfluxDB — erzeugt am $(date -Is)
# Diese Datei ist nur für root lesbar. Die Weboberfläche zeigt sie nie an.
Oberfläche : http://$(hostname -I | awk '{print $1}'):8086
Benutzer   : asksin-admin
Passwort   : $admin_pw
Organisation: $ORG
Bucket     : $BUCKET
Token      : $token
Aufbewahrung: $AUFBEWAHRUNG

# Der Token oben ist der ALLZWECK-Token aus der Ersteinrichtung. Er kann
# alles und wird deshalb nur noch fuer die Verwaltung gebraucht — nicht im
# Betrieb. Analyzer und Grafana bekommen eigene, eng geschnittene Tokens
# (siehe unten), und die stehen absichtlich nicht hier: Sie liegen dort, wo
# sie gebraucht werden, und nirgends sonst.
EOF
}

# Zwei eng geschnittene Tokens statt eines, der alles darf.
#
# Anlass, 20.08.2026: Ein einziger Allzweck-Token bediente drei Analyzer UND
# Grafana. Das Grafana-Plugin protokolliert ihn bei jeder Abfrage ins Journal
# (siehe deploy/grafana/systemd/asksin-kein-token-im-log.conf) — damit lag ein
# Token mit vollen Rechten tausendfach lesbar herum.
#
# Getrennt ist der Schaden begrenzt: Grafana LIEST nur, die Analyzer SCHREIBEN
# nur. Keiner der beiden kann Daten loeschen oder Buckets anlegen.
#
# Ausgabe: der erzeugte Token, oder leer bei Fehlschlag.
erzeuge_token() {  # erzeuge_token <beschreibung> <read|write>
    local besch="$1" aktion="$2" op org_id bucket_id
    op="$(influx_token)"
    org_id="$(curl -s "http://127.0.0.1:8086/api/v2/orgs?org=$ORG" \
        -H "Authorization: Token $op" \
        | sed -nE 's/.*"orgs":\[\{"links".*?"id":"([0-9a-f]+)".*/\1/p' | head -1)"
    [ -n "$org_id" ] || org_id="$(curl -s "http://127.0.0.1:8086/api/v2/orgs?org=$ORG" \
        -H "Authorization: Token $op" | python3 -c \
        'import sys,json;print(json.load(sys.stdin)["orgs"][0]["id"])' 2>/dev/null)"
    bucket_id="$(curl -s "http://127.0.0.1:8086/api/v2/buckets?name=$BUCKET" \
        -H "Authorization: Token $op" | python3 -c \
        'import sys,json;print(json.load(sys.stdin)["buckets"][0]["id"])' 2>/dev/null)"
    [ -n "$org_id" ] && [ -n "$bucket_id" ] || return 1
    curl -s -XPOST "http://127.0.0.1:8086/api/v2/authorizations" \
        -H "Authorization: Token $op" -H "Content-Type: application/json" \
        -d "{\"orgID\":\"$org_id\",\"description\":\"$besch\",\"permissions\":[{\"action\":\"$aktion\",\"resource\":{\"type\":\"buckets\",\"id\":\"$bucket_id\",\"orgID\":\"$org_id\"}}]}" \
        | python3 -c 'import sys,json;print(json.load(sys.stdin).get("token",""))' 2>/dev/null
}

influx_token() {
    sed -nE 's/^Token      : (.*)$/\1/p' "$ZUGANG"
}

# ----------------------------------------------------------------- Grafana

richte_grafana_ein() {
    if [ ! -d /etc/grafana ]; then
        DEBIAN_FRONTEND=noninteractive apt-get install -y -qq grafana \
            || scheitern "Grafana liess sich nicht installieren."
    fi

    # Grafana bekommt einen Token, der NUR LESEN darf. Es fragt ab, es
    # schreibt nie — und was es nicht kann, kann auch niemand missbrauchen,
    # der den Token aus einem Protokoll fischt.
    local token
    token="$(erzeuge_token 'AskSin: Grafana (nur lesen)' read)"
    if [ -z "$token" ]; then
        c_warn "Lese-Token liess sich nicht erzeugen — nehme den Allzweck-Token."
        c_warn "Bitte spaeter unter InfluxDB > API Tokens nachholen."
        token="$(influx_token)"
    fi
    [ -n "$token" ] || scheitern "Kein InfluxDB-Token gefunden — $ZUGANG unvollständig?"

    # Datenquelle aus der Vorlage: Der Token darf nicht im Repo stehen.
    install -d -m 0755 "$GRAFANA_PROV/datasources" "$GRAFANA_PROV/alerting"
    sed -e "s|__URL__|http://127.0.0.1:8086|" \
        -e "s|__ORG__|$ORG|" \
        -e "s|__BUCKET__|$BUCKET|" \
        -e "s|__TOKEN__|$token|" \
        "$INSTALL_DIR/deploy/grafana/provisioning/datasources/asksin-influx.yaml.vorlage" \
        > "$GRAFANA_PROV/datasources/asksin-influx.yaml"
    chmod 0640 "$GRAFANA_PROV/datasources/asksin-influx.yaml"
    chown root:grafana "$GRAFANA_PROV/datasources/asksin-influx.yaml" 2>/dev/null || true

    # Ueber den Renderer statt roh — Begruendung in core/bin/alarme-rendern.ts.
    # Beim Ersteinrichten sind ohnehin alle Alarme an; der Weg ist derselbe,
    # damit es spaeter keine zweite Stelle gibt, die es anders macht.
    node "$INSTALL_DIR/core/bin/alarme-rendern.ts" \
        "$GRAFANA_PROV/alerting/asksin-alarme.yaml"
    install -d -m 0755 "$GRAFANA_PROV/dashboards"
    install -m 0644 "$INSTALL_DIR/deploy/grafana/provisioning/dashboards/asksin.yaml" \
        "$GRAFANA_PROV/dashboards/asksin.yaml"

    install -d -m 0755 "$GRAFANA_DASHBOARDS"
    install -m 0644 "$INSTALL_DIR"/deploy/grafana/dashboards/*.json "$GRAFANA_DASHBOARDS/"
    chown -R grafana:grafana "$GRAFANA_DASHBOARDS" 2>/dev/null || true

    # Bevor Grafana zum ersten Mal startet: Das InfluxDB-Plugin schriebe
    # sonst ab der ersten Abfrage den entschluesselten Token ins Journal.
    install -d -m 0755 /etc/systemd/system/grafana-server.service.d
    install -m 0644 "$INSTALL_DIR/deploy/grafana/systemd/asksin-kein-token-im-log.conf" \
        /etc/systemd/system/grafana-server.service.d/asksin-kein-token-im-log.conf
    systemctl daemon-reload >/dev/null 2>&1 || true

    systemctl enable grafana-server >/dev/null 2>&1 || true
    # Neustart statt Start: Bei einer Wiederholung muessen die geaenderten
    # Provisionierungsdateien neu eingelesen werden.
    systemctl restart grafana-server || scheitern "Grafana startet nicht — journalctl -u grafana-server."

    local versuche=0
    until curl -fsS http://127.0.0.1:3000/api/health >/dev/null 2>&1; do
        versuche=$((versuche + 1))
        [ "$versuche" -gt 90 ] && scheitern "Grafana antwortet nach 90 s nicht auf 127.0.0.1:3000."
        sleep 1
    done
}

# --------------------------------------------------- Analyzer umschalten

schalte_analyzer_um() {
    local konf="$DATEN_DIR/influx.json" token
    # Der Analyzer SCHREIBT nur. Ein Token, der auch lesen und loeschen darf,
    # ist dafuer zu viel — und er liegt auf jedem Client des Verbunds.
    token="$(erzeuge_token 'AskSin: Analyzer (nur schreiben)' write)"
    if [ -z "$token" ]; then
        c_warn "Schreib-Token liess sich nicht erzeugen — nehme den Allzweck-Token."
        token="$(influx_token)"
    fi

    # Eine bestehende EXTERNE Anbindung wird nicht angetastet. Sie war
    # ausdruecklich gewuenscht, und sie hier stillschweigend zu ersetzen
    # hiesse, Daten in eine andere Datenbank umzuleiten, ohne zu fragen.
    if [ -f "$konf" ] && python3 -c "
import json,sys
k=json.load(open('$konf'))
sys.exit(0 if k.get('aktiv') and '127.0.0.1' not in k.get('url','') and 'localhost' not in k.get('url','') else 1)
" 2>/dev/null; then
        EXTERN_BELASSEN=1
        echo "  Externe InfluxDB bleibt eingestellt — Umschalten im WebUI."
        return
    fi

    python3 - "$konf" "$token" "$ORG" "$BUCKET" <<'PY'
import json, sys, pathlib
konf, token, org, bucket = sys.argv[1:5]
p = pathlib.Path(konf)
alt = {}
if p.exists():
    try:
        alt = json.loads(p.read_text(encoding="utf8"))
    except ValueError:
        alt = {}
alt.update({
    "aktiv": True,
    "url": "http://127.0.0.1:8086",
    "org": org,
    "bucket": bucket,
    "token": token,
    # 30 s wie die Vorgabe: haeufiger bringt bei diesen Kennzahlen nichts
    # und laesst die Datenbank schneller wachsen.
    "intervallSekunden": alt.get("intervallSekunden", 30),
})
p.write_text(json.dumps(alt, indent=2, ensure_ascii=False) + "\n", encoding="utf8")
PY
    chown "$DIENST_BENUTZER": "$konf"
    chmod 0600 "$konf"
    systemctl restart asksin-analyzer.service || true
}

# -------------------------------------------------------------------- Lauf

zeige_status() {
    echo "InfluxDB : $(systemctl is-active influxdb 2>/dev/null || echo 'nicht installiert')"
    echo "Grafana  : $(systemctl is-active grafana-server 2>/dev/null || echo 'nicht installiert')"
    [ -f "$ZUGANG" ] && echo "Zugangsdaten: $ZUGANG (nur für root lesbar)"
    [ -d "$GRAFANA_DASHBOARDS" ] && \
        echo "Vorlagen : $(find "$GRAFANA_DASHBOARDS" -name '*.json' | wc -l) Dashboards"
}

case "${1:-}" in
    --status) zeige_status; exit 0 ;;
    --pruefen) pruefe_voraussetzungen; echo "Voraussetzungen erfüllt."; exit 0 ;;
esac

EXTERN_BELASSEN=0

melde "Voraussetzungen prüfen"
pruefe_voraussetzungen

melde "Paketquellen einrichten"
paketquellen

melde "InfluxDB installieren und einrichten"
richte_influx_ein

melde "Grafana installieren, Vorlagen und Alarme ausrollen"
richte_grafana_ein

melde "Analyzer auf die lokale Datenbank umstellen"
schalte_analyzer_um

melde "Fertig" true
rm -f "$ANSTOSS"

IP="$(hostname -I | awk '{print $1}')"
cat <<EOF

Langzeitdaten sind eingerichtet.

  Grafana   : http://$IP:3000   (Anmeldung admin / admin, Passwort wird beim
              ersten Anmelden abgefragt)
  InfluxDB  : http://$IP:8086
  Zugangsdaten der Datenbank: $ZUGANG  (nur für root lesbar)

Acht Vorlagen liegen in Grafana im Ordner "AskSin-Analyzer" bereit, dazu vier
Alarme. Wohin die Alarme melden sollen, wird einmalig unter
Alerting -> Contact points eingetragen.
EOF

if [ "$EXTERN_BELASSEN" = "1" ]; then
    cat <<'EOF'

Hinweis: Es war bereits eine externe InfluxDB eingestellt. Sie wurde NICHT
angetastet — der Analyzer schreibt weiterhin dorthin. Umschalten auf die
lokale Datenbank geht im WebUI unter Einstellungen -> Langzeitdaten.
EOF
fi
