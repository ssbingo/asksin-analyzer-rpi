#!/usr/bin/env bash
#
# Update des AskSin-Analyzers — atomar und rueckrollbar (M7.5).
#
# Aufrufwege:
#   sudo asksin-analyzer update          (CLI, Ausgabe auf der Konsole)
#   ueber die Weboberflaeche / API:      analyzerd legt eine Trigger-Datei an,
#                                        die systemd-Path-Unit startet dieses
#                                        Skript mit --hintergrund
#
# Ablauf: neuen Stand holen -> Web-UI nach dist-neu bauen -> atomar tauschen
# -> Dienst neu starten -> Health-Check. Schlaegt irgendetwas fehl, wird auf
# den vorherigen Git-Stand UND das vorherige UI zurueckgerollt.
# Der Fortschritt steht fortlaufend in /var/lib/asksin-analyzer/
# update-status.json — auch ueber den Dienst-Neustart hinweg.
#
set -euo pipefail

INSTALL_DIR="/opt/asksin-analyzer"
BRANCH="main"
DATA_DIR="/var/lib/asksin-analyzer"
CONFIG_FILE="/etc/asksin-analyzer/config.json"
STATUS_DATEI="$DATA_DIR/update-status.json"
LOG_DATEI="$DATA_DIR/update.log"
TRIGGER="$DATA_DIR/update-anstoss"
DIST="$INSTALL_DIR/webui/dist"
export npm_config_update_notifier=false

c_info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
c_ok()   { printf '\033[1;32m  ok\033[0m %s\n' "$*"; }

if [ "$(id -u)" -ne 0 ]; then
    printf '\033[1;31mFEHLER:\033[0m Bitte mit Root-Rechten ausfuehren (sudo).\n' >&2
    exit 1
fi

mkdir -p "$DATA_DIR"
rm -f "$TRIGGER"

# Im Hintergrundmodus (API-Ausloesung) alles ins Log statt auf die Konsole:
if [ "${1:-}" = "--hintergrund" ]; then
    exec >>"$LOG_DATEI" 2>&1
    echo "===== Update gestartet: $(date -Is) ====="
fi

START_MS="$(date +%s%3N)"
VORHER="$(git -C "$INSTALL_DIR" rev-parse --short HEAD)"
NACHHER=""

schreibe_status() {  # running step ok(null|true|false)
    printf '{"running":%s,"step":"%s","ok":%s,"from":"%s","to":"%s","startedAt":%s,"updatedAt":%s}\n' \
        "$1" "$2" "$3" "$VORHER" "$NACHHER" "$START_MS" "$(date +%s%3N)" \
        > "$STATUS_DATEI.tmp" && mv "$STATUS_DATEI.tmp" "$STATUS_DATEI"
}

port() {
    grep -o '"port": *[0-9]*' "$CONFIG_FILE" 2>/dev/null | grep -o '[0-9]*' || echo 8080
}

gesund() {
    curl -fsS --max-time 2 "http://127.0.0.1:$(port)/api/health" 2>/dev/null \
        | grep -q '"ok":true'
}

rollback() {
    schreibe_status true "rollback" null
    c_info "Fehler — rolle zurueck auf $VORHER..."
    git -C "$INSTALL_DIR" reset --hard --quiet "$VORHER" || true
    if [ -d "$DIST.alt" ]; then
        rm -rf "$DIST"
        mv "$DIST.alt" "$DIST"
    fi
    systemctl restart asksin-analyzer.service || true
    schreibe_status false "rollback" false
    exit 1
}
trap rollback ERR

# --- 1. Neuen Stand holen -----------------------------------------------------
schreibe_status true "hole" null
c_info "Hole neuen Stand..."
git -C "$INSTALL_DIR" fetch --quiet origin "$BRANCH"
git -C "$INSTALL_DIR" reset --hard --quiet "origin/$BRANCH"
NACHHER="$(git -C "$INSTALL_DIR" rev-parse --short HEAD)"

if [ "$VORHER" = "$NACHHER" ]; then
    c_ok "Bereits aktuell ($NACHHER)."
    schreibe_status false "aktuell" true
    exit 0
fi
c_ok "Aktualisiert: $VORHER -> $NACHHER"

# --- 2. Web-UI bauen — in ein NEUES Verzeichnis, dann atomar tauschen ---------
schreibe_status true "baue-ui" null
c_info "Baue Web-UI..."
cd "$INSTALL_DIR/webui"
npm ci --no-audit --no-fund --loglevel=error
npx --no-install vite build --outDir dist-neu --emptyOutDir --logLevel error
rm -rf "$DIST.alt"
[ -d "$DIST" ] && mv "$DIST" "$DIST.alt"
mv "$INSTALL_DIR/webui/dist-neu" "$DIST"
c_ok "Web-UI gebaut und getauscht."

# --- 3. Unit/Wrapper nachziehen, Dienst neu starten ---------------------------
schreibe_status true "neustart" null
install -m 0644 "$INSTALL_DIR/deploy/asksin-analyzer.service" /etc/systemd/system/asksin-analyzer.service
install -m 0644 "$INSTALL_DIR/deploy/asksin-analyzer-update.service" /etc/systemd/system/ 2>/dev/null || true
install -m 0644 "$INSTALL_DIR/deploy/asksin-analyzer-update.path" /etc/systemd/system/ 2>/dev/null || true
install -m 0755 "$INSTALL_DIR/deploy/asksin-analyzer" /usr/local/bin/asksin-analyzer
systemctl daemon-reload
# Web-Ausloeser scharf schalten (idempotent; noetig beim ersten Update auf M7.5):
systemctl enable --now asksin-analyzer-update.path >/dev/null 2>&1 || true
systemctl restart asksin-analyzer.service

# --- 4. Health-Check: kommt der Dienst mit dem neuen Stand hoch? --------------
schreibe_status true "pruefe" null
c_info "Warte auf den Dienst..."
GESUND=0
for _ in $(seq 1 30); do
    if gesund; then GESUND=1; break; fi
    sleep 1
done
if [ "$GESUND" -ne 1 ]; then
    rollback
fi

rm -rf "$DIST.alt"
schreibe_status false "fertig" true
c_ok "Fertig — laeuft auf $NACHHER."
