#!/usr/bin/env bash
#
# Update des AskSin-Analyzers: Quellcode aktualisieren, Web-UI neu bauen,
# Dienst neu starten. Wird normalerweise ueber 'sudo asksin-analyzer update'
# aufgerufen.
#
set -euo pipefail

INSTALL_DIR="/opt/asksin-analyzer"
BRANCH="main"
export npm_config_update_notifier=false

c_info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
c_ok()   { printf '\033[1;32m  ok\033[0m %s\n' "$*"; }

if [ "$(id -u)" -ne 0 ]; then
    printf '\033[1;31mFEHLER:\033[0m Bitte mit Root-Rechten ausfuehren (sudo).\n' >&2
    exit 1
fi

VORHER="$(git -C "$INSTALL_DIR" rev-parse --short HEAD)"
c_info "Hole neuen Stand..."
git -C "$INSTALL_DIR" fetch --quiet origin "$BRANCH"
git -C "$INSTALL_DIR" reset --hard --quiet "origin/$BRANCH"
NACHHER="$(git -C "$INSTALL_DIR" rev-parse --short HEAD)"

if [ "$VORHER" = "$NACHHER" ]; then
    c_ok "Bereits aktuell ($NACHHER)."
else
    c_ok "Aktualisiert: $VORHER -> $NACHHER"
fi

c_info "Baue Web-UI..."
cd "$INSTALL_DIR/webui"
npm ci --no-audit --no-fund --loglevel=error
npx --no-install vite build --logLevel error
c_ok "Web-UI gebaut."

c_info "Starte Dienst neu..."
install -m 0644 "$INSTALL_DIR/deploy/asksin-analyzer.service" /etc/systemd/system/asksin-analyzer.service
install -m 0755 "$INSTALL_DIR/deploy/asksin-analyzer" /usr/local/bin/asksin-analyzer
systemctl daemon-reload
systemctl restart asksin-analyzer.service
c_ok "Fertig — laufende Version: $(systemctl is-active asksin-analyzer.service)"
