#!/usr/bin/env bash
#
# Installer fuer den AskSin-Analyzer auf dem Raspberry Pi.
#
# Schnellinstallation (eine Zeile, sobald das Repo oeffentlich ist):
#   curl -fsSL https://raw.githubusercontent.com/ssbingo/asksin-analyzer-rpi/main/install.sh | sudo bash
#
# Solange das Repo privat ist (SSH-Deploy-Key auf dem Pi vorausgesetzt):
#   sudo git clone git@github.com:ssbingo/asksin-analyzer-rpi.git /opt/asksin-analyzer
#   sudo /opt/asksin-analyzer/install.sh
#
# Der Installer ist idempotent: erneutes Ausfuehren aktualisiert die
# Installation. Update spaeter:  sudo asksin-analyzer update
#
set -euo pipefail

REPO_URL="https://github.com/ssbingo/asksin-analyzer-rpi.git"
BRANCH="main"
INSTALL_DIR="/opt/asksin-analyzer"
CONFIG_DIR="/etc/asksin-analyzer"
CONFIG_FILE="$CONFIG_DIR/config.json"
DATA_DIR="/var/lib/asksin-analyzer"
SERVICE_FILE="/etc/systemd/system/asksin-analyzer.service"
WRAPPER="/usr/local/bin/asksin-analyzer"
SERVICE_USER="asksin"
# analyzerd laeuft ohne Buildschritt direkt auf den TypeScript-Quellen —
# das braucht Nodes eingebautes Type-Stripping, standardmaessig ab 23.6.
NODE_MAJOR_MIN=24

REBOOT_NEEDED=0
NEUES_TOKEN=""

c_info()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
c_ok()    { printf '\033[1;32m  ok\033[0m %s\n' "$*"; }
c_warn()  { printf '\033[1;33m  !!\033[0m %s\n' "$*"; }
c_err()   { printf '\033[1;31mFEHLER:\033[0m %s\n' "$*" >&2; }

# --- Eingaben gehen ueber das Terminal, auch bei 'curl | sudo bash' -----------
TTY="/dev/tty"
have_tty() { [ -e "$TTY" ] && [ -r "$TTY" ]; }
ask_tty() {  # ask_tty "Frage (J/n): " -> echo Antwort
    local prompt="$1" ans=""
    if have_tty; then read -r -p "$prompt" ans <"$TTY" || true; fi
    echo "$ans"
}

# --- Vorpruefungen ------------------------------------------------------------
if [ "$(id -u)" -ne 0 ]; then
    c_err "Bitte mit Root-Rechten ausfuehren (sudo)."
    exit 1
fi

MODEL="$(tr -d '\0' < /proc/device-tree/model 2>/dev/null || echo '')"
case "$MODEL" in
    *Raspberry*) c_ok "Erkannt: $MODEL" ;;
    *)
        c_warn "Kein Raspberry Pi erkannt (${MODEL:-unbekannt})."
        a="$(ask_tty 'Trotzdem fortfahren? (j/N): ')"
        case "${a,,}" in j|ja|y|yes) ;; *) echo "Abgebrochen."; exit 1 ;; esac
        ;;
esac

# --- System-Pakete ------------------------------------------------------------
c_info "Installiere System-Pakete (apt)..."
export DEBIAN_FRONTEND=noninteractive
# npm soll nicht bei jedem Lauf fuer seine eigene neue Version werben:
export npm_config_update_notifier=false
apt-get update -qq
# gpiod: 328P-Reset ueber GPIO4; avrdude: Firmware-Flash; jq: netz-anwenden.sh
apt-get install -y -qq git curl ca-certificates gpiod avrdude jq
c_ok "System-Pakete installiert."

# --- Node.js ------------------------------------------------------------------
node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
if command -v node >/dev/null 2>&1 && [ "$(node_major)" -ge "$NODE_MAJOR_MIN" ]; then
    c_ok "Node.js $(node --version) vorhanden."
else
    c_info "Installiere Node.js ${NODE_MAJOR_MIN} (NodeSource)..."
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR_MIN}.x" | bash - >/dev/null
    apt-get install -y -qq nodejs
    c_ok "Node.js $(node --version) installiert."
fi

# --- Repository holen / aktualisieren -----------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-/}")" 2>/dev/null && pwd || echo '')"
if [ -d "$INSTALL_DIR/.git" ]; then
    c_info "Aktualisiere vorhandene Installation in $INSTALL_DIR..."
    git -C "$INSTALL_DIR" fetch --quiet origin "$BRANCH"
    git -C "$INSTALL_DIR" reset --hard --quiet "origin/$BRANCH"
elif [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/core/bin/analyzerd.ts" ] && [ -d "$SCRIPT_DIR/.git" ]; then
    # install.sh wurde aus einem lokalen Checkout gestartet -> von dort klonen
    c_info "Uebernehme lokalen Checkout $SCRIPT_DIR nach $INSTALL_DIR..."
    git clone --quiet "$SCRIPT_DIR" "$INSTALL_DIR"
    git -C "$INSTALL_DIR" remote set-url origin "$REPO_URL"
else
    c_info "Klone Repository nach $INSTALL_DIR..."
    rm -rf "$INSTALL_DIR"
    if ! git clone --quiet --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"; then
        c_err "Klonen fehlgeschlagen. Ist das Repo noch privat?"
        c_err "Dann zuerst einen SSH-Deploy-Key einrichten und manuell klonen:"
        c_err "  sudo git clone git@github.com:ssbingo/asksin-analyzer-rpi.git $INSTALL_DIR"
        c_err "  sudo $INSTALL_DIR/install.sh"
        exit 1
    fi
fi
c_ok "Quellcode bereit ($(git -C "$INSTALL_DIR" describe --tags --always 2>/dev/null || echo unbekannt))."

# --- Web-UI bauen -------------------------------------------------------------
c_info "Baue Web-UI (auf dem Pi dauert das ein paar Minuten)..."
cd "$INSTALL_DIR/webui"
npm ci --no-audit --no-fund --loglevel=error
# vite direkt statt 'npm run build': der vue-tsc-Typcheck ist Entwicklersache
# und auf dem Pi nur verlorene Zeit/RAM.
npx --no-install vite build --logLevel error
c_ok "Web-UI gebaut ($INSTALL_DIR/webui/dist)."

# git-Kommandos des Dienstbenutzers im root-eigenen Repo erlauben:
git config --system --get-all safe.directory 2>/dev/null \
    | grep -qx "$INSTALL_DIR" \
    || git config --system --add safe.directory "$INSTALL_DIR"

# --- Dienstbenutzer und Verzeichnisse -----------------------------------------
if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
    useradd -r -s /usr/sbin/nologin "$SERVICE_USER"
    c_ok "Benutzer '$SERVICE_USER' angelegt."
fi
# dialout: serieller Port; gpio: 328P-Reset ueber GPIO4 beim Firmware-Flash
usermod -aG dialout "$SERVICE_USER"
getent group gpio >/dev/null 2>&1 && usermod -aG gpio "$SERVICE_USER"
mkdir -p "$DATA_DIR" "$CONFIG_DIR"
chown -R "$SERVICE_USER:$SERVICE_USER" "$DATA_DIR"

# --- Konfigurations-Assistent -------------------------------------------------
schreibe_konfig() {
    local ccu="$1" port="$2" host="$3" token="$4" standort="$5"
    cat > "$CONFIG_FILE" <<EOF
{
  "standort": "$standort",
  "device": "/dev/asksin-hat",
  "baud": 58824,
  "db": "$DATA_DIR/analyzer.db",
  "http": {
    "host": "$host",
    "port": $port,
    "authToken": "$token"
  },
  "ccu": {
    "host": "$ccu",
    "cachePath": "$DATA_DIR/devlist.json"
  },
  "retention": {
    "telegramsDays": 30,
    "noiseDays": 90,
    "deviceHoursDays": 365
  }
}
EOF
    chmod 0640 "$CONFIG_FILE"
    chown "root:$SERVICE_USER" "$CONFIG_FILE"
}

KONFIGURIEREN=1
if [ -f "$CONFIG_FILE" ]; then
    a="$(ask_tty 'Konfiguration existiert bereits - neu erzeugen? (j/N): ')"
    case "${a,,}" in j|ja|y|yes) ;; *) KONFIGURIEREN=0; c_ok "Bestehende Konfiguration bleibt." ;; esac
fi

if [ "$KONFIGURIEREN" -eq 1 ]; then
    if have_tty; then
        c_info "Konfigurations-Assistent (Enter = Vorgabe uebernehmen)"
        STANDORT="$(ask_tty "  Standortname (reine Anzeige, aendert den Hostnamen NICHT), z. B. Keller [$(hostname)]: ")"
        STANDORT="${STANDORT:-$(hostname)}"
        CCU="$(ask_tty '  IP/Hostname der CCU/RaspberryMatic (leer = keine Namensaufloesung): ')"
        PORT="$(ask_tty '  HTTP-Port [8080]: ')"; PORT="${PORT:-8080}"
        a="$(ask_tty '  Weboberflaeche im LAN erreichbar machen? (J/n): ')"
        case "${a,,}" in n|nein|no) HOST="127.0.0.1" ;; *) HOST="0.0.0.0" ;; esac
        a="$(ask_tty '  Schreibzugriffe (Einstellungen, Loeschen) mit Token schuetzen? (J/n): ')"
        case "${a,,}" in
            n|nein|no) TOKEN="" ;;
            *) TOKEN="$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"; NEUES_TOKEN="$TOKEN" ;;
        esac
    else
        c_warn "Kein Terminal - schreibe Vorgabe-Konfiguration (nur 127.0.0.1, ohne CCU)."
        CCU=""; PORT=8080; HOST="127.0.0.1"; TOKEN=""; STANDORT="$(hostname)"
    fi
    schreibe_konfig "$CCU" "$PORT" "$HOST" "$TOKEN" "$STANDORT"
    c_ok "Konfiguration geschrieben: $CONFIG_FILE"
fi

# --- udev-Regel (fester Geraetename /dev/asksin-hat) --------------------------
install -m 0644 "$INSTALL_DIR/hardware/99-asksin-analyzer.rules" /etc/udev/rules.d/
udevadm control --reload && udevadm trigger || true
c_ok "udev-Regel installiert (/dev/asksin-hat bzw. /dev/asksin-usb)."

# --- UART fuer den Sniffer-HAT ------------------------------------------------
a="$(ask_tty 'UART fuer den Sniffer-HAT jetzt einrichten (GPIO14/15)? (J/n): ')"
case "${a,,}" in
    n|nein|no) c_info "UART-Einrichtung uebersprungen (spaeter: sudo $INSTALL_DIR/hardware/setup-uart.sh)" ;;
    *)
        UART_LOG="$(bash "$INSTALL_DIR/hardware/setup-uart.sh" 2>&1 || true)"
        echo "$UART_LOG"
        if echo "$UART_LOG" | grep -q "Neustart erforderlich"; then REBOOT_NEEDED=1; fi
        ;;
esac

# --- systemd-Dienst + Update-Ausloeser ----------------------------------------
c_info "Richte systemd-Dienste ein..."
install -m 0644 "$INSTALL_DIR/deploy/asksin-analyzer.service" "$SERVICE_FILE"
install -m 0644 "$INSTALL_DIR/deploy/asksin-analyzer-update.service" /etc/systemd/system/
install -m 0644 "$INSTALL_DIR/deploy/asksin-analyzer-update.path" /etc/systemd/system/
install -m 0644 "$INSTALL_DIR/deploy/asksin-analyzer-netz.service" /etc/systemd/system/
install -m 0644 "$INSTALL_DIR/deploy/asksin-analyzer-netz.path" /etc/systemd/system/
systemctl daemon-reload
systemctl enable asksin-analyzer.service >/dev/null 2>&1 || true
systemctl enable --now asksin-analyzer-update.path >/dev/null 2>&1 || true
systemctl enable --now asksin-analyzer-netz.path >/dev/null 2>&1 || true
systemctl restart asksin-analyzer.service
c_ok "Dienst aktiviert und gestartet (Updates aus der Weboberflaeche moeglich)."

# --- CLI-Wrapper --------------------------------------------------------------
install -m 0755 "$INSTALL_DIR/deploy/asksin-analyzer" "$WRAPPER"
c_ok "Befehl 'asksin-analyzer' installiert."

# --- Abschluss ----------------------------------------------------------------
IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
PORT_ANZEIGE="$(grep -o '"port": *[0-9]*' "$CONFIG_FILE" | grep -o '[0-9]*' || echo 8080)"
echo
c_info "Fertig. Die Weboberflaeche laeuft auf:  http://${IP:-<pi-ip>}:${PORT_ANZEIGE}"
if [ -n "$NEUES_TOKEN" ]; then
    echo
    c_warn "Auth-Token (jetzt notieren, steht auch in $CONFIG_FILE):"
    echo "        $NEUES_TOKEN"
    echo "        In der Weboberflaeche unter Einstellungen -> Zugriff eintragen."
fi
echo
echo "    asksin-analyzer status    # Dienststatus"
echo "    asksin-analyzer logs      # Live-Log"
echo "    asksin-analyzer config    # Konfiguration aendern"
echo "    asksin-analyzer update    # auf neue Version aktualisieren"
echo
c_info "Solange der Sniffer-HAT noch nicht steckt, meldet die Oberflaeche"
c_info "'Sniffer getrennt' und der Dienst versucht es ruhig weiter - normal."
if [ "$REBOOT_NEEDED" -eq 1 ]; then
    echo
    c_warn "Die UART-Einrichtung braucht einen Neustart."
    a="$(ask_tty 'Jetzt neu starten? (j/N): ')"
    case "${a,,}" in j|ja|y|yes) c_info "Starte neu..."; reboot ;; *) c_warn "Bitte spaeter: sudo reboot" ;; esac
fi
