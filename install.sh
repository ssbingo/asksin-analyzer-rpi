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
VERBUND_MASTER=0
LANGZEITDATEN=0
STATUSANZEIGE=0
OLED_HOEHE=32          # Adafruit PiOLED; 64 fuer 0,96-Zoll-Module

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
# Generation bestimmt, wie die WS2812 angesteuert wird (siehe LED_METHODE unten)
case "$MODEL" in
    *"Raspberry Pi 5"*|*"Compute Module 5"*) PI_GEN=5 ;;
    *"Raspberry Pi 4"*|*"Pi 400"*|*"Compute Module 4"*) PI_GEN=4 ;;
    *"Raspberry Pi 3"*) PI_GEN=3 ;;
    *) PI_GEN=0 ;;
esac
# Der Pi 3 gehoert auf eine SD-Karte, nicht auf eine SSD am USB: Seine
# Netzwerkbuchse haengt selbst am USB-Bus, es gibt nur USB 2.0, und das Starten
# von USB ist wacklig. Wer es trotzdem so aufbaut, merkt das erst im Betrieb —
# als zaehes Netzwerk und gelegentliche Aussetzer. Deshalb hier ein Wort dazu,
# solange noch jemand davor sitzt.
pruefe_bootmedium() {
    [ "$PI_GEN" -eq 3 ] || return 0
    local wurzel
    wurzel="$(findmnt -no SOURCE / 2>/dev/null || echo '')"
    case "$wurzel" in
        /dev/mmcblk*) return 0 ;;   # SD-Karte, genau richtig
        "") return 0 ;;
    esac
    echo
    c_warn "Dieser Pi 3 startet offenbar NICHT von SD-Karte ($wurzel)."
    c_warn "Empfohlen ist beim Pi 3 die SD-Karte:"
    c_warn "  - Netzwerk und USB teilen sich hier einen Anschluss; eine dauernd"
    c_warn "    schreibende SSD nimmt dem Netzwerk Bandbreite weg."
    c_warn "  - Nur USB 2.0: statt 400 MB/s bleiben hoechstens 40."
    c_warn "  - Das Starten von USB ist beim Pi 3 wacklig."
    c_warn "Der Analyzer laeuft trotzdem — nur eben mit diesen Nachteilen."
    c_warn "Einzelheiten: Handbuch Kapitel 9.1."
    echo
}

case "$MODEL" in
    *Raspberry*) c_ok "Erkannt: $MODEL"; pruefe_bootmedium ;;
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
# gnupg fuer --dearmor der Paketquellen-Schluessel: Ohne es scheitert die
# Node.js-Installation gleich darauf, und zwar auf einem frischen System
# immer.
apt-get install -y -qq git curl ca-certificates gnupg gpiod avrdude jq
c_ok "System-Pakete installiert."

# --- Node.js ------------------------------------------------------------------
node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
if command -v node >/dev/null 2>&1 && [ "$(node_major)" -ge "$NODE_MAJOR_MIN" ]; then
    c_ok "Node.js $(node --version) vorhanden."
else
    c_info "Installiere Node.js ${NODE_MAJOR_MIN} (NodeSource)..."
    # Die Paketquelle selbst eintragen, statt das Einrichtungsskript von
    # NodeSource per "curl | bash" als root auszufuehren. Zwei Gruende:
    #
    #  - Jenes Skript benutzt intern das Kommando 'apt' und erzeugt damit die
    #    Warnung "apt does not have a stable CLI interface". Sie ist harmlos,
    #    aber sie sieht nach einem Fehler aus, und niemand kann sie einordnen.
    #  - Ein fremdes Skript ungesehen mit Root-Rechten laufen zu lassen, ist
    #    eine Gewohnheit, die man sich nicht antrainieren sollte. Was hier
    #    passiert, steht jetzt in vier nachvollziehbaren Zeilen.
    install -d -m 0755 /etc/apt/keyrings
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
        | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
        || { c_err "Schluessel von deb.nodesource.com nicht erreichbar."; exit 1; }
    chmod 0644 /etc/apt/keyrings/nodesource.gpg
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR_MIN}.x nodistro main" \
        > /etc/apt/sources.list.d/nodesource.list
    apt-get update -qq
    apt-get install -y -qq nodejs
    c_ok "Node.js $(node --version) installiert."
fi

# --- Repository holen / aktualisieren -----------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-/}")" 2>/dev/null && pwd || echo '')"
if [ -d "$INSTALL_DIR/.git" ]; then
    c_info "Aktualisiere vorhandene Installation in $INSTALL_DIR..."
    # --tags ist noetig: Ohne sie bleiben die Versions-Tags auf dem Pi
    # stehen, und die Versionsanzeige zeigt jahrelang eine alte Nummer.
    #
    # Scheitert das Aktualisieren, wird neu geklont statt abgebrochen.
    #
    # Anlass (04.08.2026, Analyzer 05 auf einem Pi 3): Die Git-Ablage unter
    # /opt war beschaedigt — leere Objektdateien, "fatal: cannot read
    # existing object info". Auf einem Geraet, das von SD-Karte laeuft und
    # gelegentlich hart ausgeht, ist das ein zu erwartender Zustand.
    #
    # Der Abbruch war dabei das eigentliche Aergernis: In /opt liegt nur
    # ausgecheckter Quelltext. Konfiguration (/etc/asksin-analyzer) und
    # Daten (/var/lib/asksin-analyzer) sind davon nicht beruehrt, ein
    # Neuklonen kostet also nichts als Bandbreite.
    if ! git -C "$INSTALL_DIR" fetch --quiet --tags --force origin "$BRANCH" 2>/dev/null \
       || ! git -C "$INSTALL_DIR" reset --hard --quiet "origin/$BRANCH" 2>/dev/null; then
        c_warn "Die Git-Ablage in $INSTALL_DIR ist beschaedigt — sie wird neu geholt."
        c_warn "Konfiguration und Aufzeichnungen bleiben unberuehrt."
        rm -rf "$INSTALL_DIR"
        if ! git clone --quiet --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"; then
            c_err "Auch das Neuklonen ist fehlgeschlagen."
            c_err "Besteht eine Internetverbindung? Ist die SD-Karte noch beschreibbar?"
            c_err "  dmesg | grep -i 'mmc\\|i/o error'   zeigt Kartenfehler"
            exit 1
        fi
        c_ok "Neu geklont."
    fi
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
c_ok "Quellcode bereit ($(git -C "$INSTALL_DIR" describe --tags --always \
    --match "v[0-9]*" 2>/dev/null || echo unbekannt))."

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
# Geraetegruppen. Fehlt eine davon, laeuft der Dienst zwar, aber die
# betroffene Funktion meldet "Permission denied":
#   dialout  serieller Port zum Sniffer
#   gpio     328P-Reset ueber GPIO4 (Firmware-Flash) und Taster an GPIO17
#   spi      /dev/spidev0.0 fuer die WS2812-Status-LED
#   i2c      /dev/i2c-1 fuer das OLED
#   systemd-journal  Systemjournal lesen (Absturzsuche, M13)
usermod -aG dialout "$SERVICE_USER"
for g in gpio spi i2c systemd-journal; do
    if getent group "$g" >/dev/null 2>&1; then
        usermod -aG "$g" "$SERVICE_USER"
    else
        c_warn "Gruppe '$g' existiert nicht — Zugriff auf die zugehoerigen Geraete fehlt."
    fi
done
mkdir -p "$DATA_DIR" "$CONFIG_DIR"
chown -R "$SERVICE_USER:$SERVICE_USER" "$DATA_DIR"

# --- Konfigurations-Assistent -------------------------------------------------
# Ansteuerung der WS2812 nach Pi-Generation:
#   Pi 5  -> SPI. PWM scheidet aus, weil die PWM/DMA-Bibliotheken den
#            RP1-Chip nicht bedienen; der SPI-Takt ist dort stabil.
#   Pi 3/4 -> PWM. Dort leitet sich der SPI-Takt vom Kerntakt ab und wandert
#            mit dessen Skalierung — das zerreisst das WS2812-Timing.
#   unbekannt -> SPI, weil dieser Weg ohne Root-Hilfsdienst auskommt.
case "$PI_GEN" in
    3|4) LED_METHODE="ws2812-pwm" ;;
    *)   LED_METHODE="ws2812-spi" ;;
esac

schreibe_konfig() {
    local ccu="$1" port="$2" host="$3" token="$4" standort="$5" statusanzeige="$6"
    local led="aus" oled="false"
    if [ "$statusanzeige" = "1" ]; then led="$LED_METHODE"; oled="true"; fi
    cat > "$CONFIG_FILE" <<EOF
{
  "standort": "$standort",
  "statusanzeige": { "led": "$led", "oled": $oled, "helligkeit": 40, "oledHoehe": ${OLED_HOEHE:-32} },
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
  },
  "verbund": {
    "rolle": "$(if [ "$VERBUND_MASTER" -eq 1 ]; then echo master; else echo client; fi)"
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
        printf '\n  \033[1m1. Dieser Analyzer\033[0m\n'
        STANDORT="$(ask_tty "  Standortname (reine Anzeige, aendert den Hostnamen NICHT), z. B. Keller [$(hostname)]: ")"
        STANDORT="${STANDORT:-$(hostname)}"

        printf '\n  \033[1m2. Verbindung zur CCU / RaspberryMatic\033[0m\n'
        printf '     Nur fuer die Geraetenamen. Der Port ist dort fest 80 und wird nicht gefragt.\n'
        CCU="$(ask_tty '  IP/Hostname der CCU (leer = keine Namensaufloesung): ')"

        printf '\n  \033[1m3. Weboberflaeche DIESES Analyzers\033[0m\n'
        printf '     Unter diesem Port erreichst du spaeter die Oberflaeche im Browser.\n'
        printf '     Das hat mit der CCU nichts zu tun.\n'
        PORT="$(ask_tty "  Port der Analyzer-Weboberflaeche [8080] -> http://$(hostname):PORT : ")"
        PORT="${PORT:-8080}"
        case "$PORT" in
            ''|*[!0-9]*)
                c_warn "'$PORT' ist keine Portnummer — nehme 8080."
                PORT=8080 ;;
            *) if [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
                   c_warn "Port $PORT liegt ausserhalb 1-65535 — nehme 8080."
                   PORT=8080
               elif [ "$PORT" -lt 1024 ]; then
                   # Die Unit bringt dafuer CAP_NET_BIND_SERVICE mit; ohne die
                   # Faehigkeit scheiterte der Dienst frueher mit EACCES.
                   c_info "Port $PORT ist privilegiert — die Unit erhaelt CAP_NET_BIND_SERVICE."
               fi ;;
        esac
        a="$(ask_tty '  Weboberflaeche im LAN erreichbar machen? (J/n): ')"
        case "${a,,}" in n|nein|no) HOST="127.0.0.1" ;; *) HOST="0.0.0.0" ;; esac
        a="$(ask_tty '  Schreibzugriffe (Einstellungen, Loeschen) mit Token schuetzen? (J/n): ')"
        case "${a,,}" in
            n|nein|no) TOKEN="" ;;
            *) TOKEN="$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"; NEUES_TOKEN="$TOKEN" ;;
        esac
        a="$(ask_tty '  Soll DIESER Analyzer die Verbund-Gesamtuebersicht fuehren (Master)? (j/N): ')"
        case "${a,,}" in j|ja|y|yes) VERBUND_MASTER=1 ;; *) VERBUND_MASTER=0 ;; esac
        # Langzeitdaten gehoeren auf den Master und nur auf Hardware, die sie
        # traegt. Die Frage gar nicht erst zu stellen ist ehrlicher, als sie
        # zu stellen und hinterher abzulehnen.
        if [ "$VERBUND_MASTER" -eq 1 ]; then
            RAM_KB="$(awk '/MemTotal/{print $2}' /proc/meminfo)"
            BAUREIHE="$(sed -nE 's/.*Raspberry Pi ([0-9]+).*/\1/p' <<<"$MODEL")"
            if { [ -z "$BAUREIHE" ] || [ "$BAUREIHE" -ge 4 ]; } && [ "$RAM_KB" -ge 1887436 ]; then
                c_info '  InfluxDB und Grafana koennen gleich mit auf dieses Geraet.'
                c_info '  Dann bleiben die Langzeitdaten im Haus, und acht fertige'
                c_info '  Grafana-Ansichten liegen bereit. Das laedt rund 400 MB nach.'
                a="$(ask_tty '  Langzeitdaten (InfluxDB + Grafana) jetzt einrichten? (j/N): ')"
                case "${a,,}" in j|ja|y|yes) LANGZEITDATEN=1 ;; *) LANGZEITDATEN=0 ;; esac
            else
                c_warn "  Langzeitdaten uebersprungen: ${MODEL:-dieses Geraet} mit $((RAM_KB/1024)) MB"
                c_warn '  reicht dafuer nicht (noetig: ab Pi 4 mit 2 GB). Spaeter nachruestbar,'
                c_warn '  sobald staerkere Hardware zur Verfuegung steht.'
            fi
        fi
        a="$(ask_tty '  Status-LED und OLED-Anzeige (Zubehoer an J5-J7) einrichten? (j/N): ')"
        case "${a,,}" in j|ja|y|yes) STATUSANZEIGE=1 ;; *) STATUSANZEIGE=0 ;; esac
        if [ "$STATUSANZEIGE" -eq 1 ]; then
            # Bauhoehe des Panels. Multiplex-Verhaeltnis und COM-Pin-Lage der
            # Init-Sequenz haengen daran; mit den falschen Werten zeigt das
            # Display ein verdoppeltes, unleserliches Bild.
            a="$(ask_tty '  OLED-Bauhoehe - [1] 128x32 (Adafruit PiOLED) oder [2] 128x64? [1]: ')"
            case "$a" in 2) OLED_HOEHE=64 ;; *) OLED_HOEHE=32 ;; esac
        fi
    else
        c_warn "Kein Terminal - schreibe Vorgabe-Konfiguration (nur 127.0.0.1, ohne CCU)."
        CCU=""; PORT=8080; HOST="127.0.0.1"; TOKEN=""; STANDORT="$(hostname)"
    fi
    schreibe_konfig "$CCU" "$PORT" "$HOST" "$TOKEN" "$STANDORT" "$STATUSANZEIGE"
    c_ok "Konfiguration geschrieben: $CONFIG_FILE"
else
    # Bestehende Konfiguration behalten: Statusanzeige und Methode von dort
    # uebernehmen, damit ein erneuter Lauf den LED-Hilfsdienst nicht verliert.
    VORHANDEN="$(grep -o '"led"[[:space:]]*:[[:space:]]*"[a-z0-9-]*"' "$CONFIG_FILE" \
                 | grep -o '"[a-z0-9-]*"$' | tr -d '"' || true)"
    case "$VORHANDEN" in
        ws2812-pwm|ws2812-spi)
            STATUSANZEIGE=1
            LED_METHODE="$VORHANDEN"
            c_ok "Statusanzeige aus der Konfiguration uebernommen: $LED_METHODE"
            ;;
    esac
fi

# Die Konfiguration darf die Hardware nicht ueberstimmen. Auf dem Pi 5 sitzt
# die Peripherie hinter dem RP1-Chip; die PWM/DMA-Ansteuerung von rpi_ws281x
# zielt weiterhin auf die alte Speicherlage. Im guenstigen Fall startet sie
# gar nicht erst, im unguenstigen schreibt ein DMA-Kanal in fremden Speicher -
# und das haengt den Rechner hart auf, ohne eine Zeile zu hinterlassen.
# Eine aus einem Pi 3/4 uebernommene Konfiguration darf das nie ausloesen.
if [ "$PI_GEN" = "5" ] && [ "$LED_METHODE" = "ws2812-pwm" ]; then
    c_warn "PWM ist auf dem Pi 5 nicht moeglich (RP1) - stelle auf SPI um."
    LED_METHODE="ws2812-spi"
    if [ -f "$CONFIG_FILE" ]; then
        sed -i 's/"led"[[:space:]]*:[[:space:]]*"ws2812-pwm"/"led": "ws2812-spi"/' \
            "$CONFIG_FILE"
    fi
    systemctl disable --now asksin-analyzer-led.service 2>/dev/null || true
fi

# --- Status-LED / OLED (M11) --------------------------------------------------
if [ "$STATUSANZEIGE" -eq 1 ]; then
    c_info "Richte Status-LED/OLED ein (Methode: $LED_METHODE)..."
    # Das OLED wird direkt ueber den I2C-Bus angesprochen (i2ctransfer aus
    # i2c-tools). Eine Python-Bibliothek wie Adafruit-CircuitPython-SSD1306
    # wird dafuer NICHT gebraucht: Der Analyzer bringt seinen eigenen
    # SSD1306-Treiber mit und schiebt den Framebuffer selbst auf den Bus.
    # Gebraucht werden nur diese beiden Pakete und ein eingeschalteter Bus.
    apt-get install -y -qq i2c-tools spi-tools
    if command -v raspi-config >/dev/null 2>&1; then
        raspi-config nonint do_i2c 0 || c_warn "I2C konnte nicht aktiviert werden."
        REBOOT_NEEDED=1
    else
        c_warn "raspi-config fehlt - I2C ggf. manuell aktivieren."
    fi

    c_ok "Panel: 128x${OLED_HOEHE}"

    # --- Anzeigedienst mit den Bibliotheken des Vorbilds ------------------
    # Gezeichnet wird nicht im Core, sondern in deploy/oled.py — mit demselben
    # Stapel wie das Status-LED-OLED-Projekt: adafruit_ssd1306 als Treiber,
    # Pillow zum Zeichnen und DejaVuSans-Bold als grosse Schrift.
    # Die Einrichtung steht in einem eigenen Skript, damit sie sich nach einem
    # Fehlschlag einzeln wiederholen laesst, ohne den ganzen Installer.
    if ! "$INSTALL_DIR/deploy/oled-einrichten.sh" "$OLED_HOEHE"; then
        c_warn "OLED-Anzeigedienst nicht eingerichtet - Display bleibt dunkel."
        c_warn "Einzeln nachholen:"
        c_warn "  sudo $INSTALL_DIR/deploy/oled-einrichten.sh $OLED_HOEHE"
    fi

    # Antwortet das Display? Direkt nach dem Einschalten von I2C oft noch
    # nicht - dann ist der Hinweis wichtiger als eine Fehlermeldung.
    if command -v i2cdetect >/dev/null 2>&1; then
        if i2cdetect -y 1 2>/dev/null | grep -qiE ' 3c| 3d'; then
            c_ok "OLED auf dem I2C-Bus gefunden."
        else
            c_warn "Auf dem I2C-Bus meldet sich kein Display (Adresse 0x3C/0x3D)."
            c_warn "Nach dem Neustart pruefen: sudo i2cdetect -y 1"
        fi
    fi

    if [ "$LED_METHODE" = "ws2812-spi" ]; then
        if command -v raspi-config >/dev/null 2>&1; then
            raspi-config nonint do_spi 0 || c_warn "SPI konnte nicht aktiviert werden."
        fi
        systemctl disable --now asksin-analyzer-led.service 2>/dev/null || true
        c_ok "LED ueber SPI (GPIO10) - der Analyzer-Dienst treibt sie selbst."
        c_warn "Schiebeschalter SW1 auf der Platine auf Stellung SPI schieben."
    else
        # PWM braucht die PWM-Hardware exklusiv -> Onboard-Audio abschalten,
        # und rpi_ws281x braucht Root. Beides erledigt der Hilfsdienst.
        BOOTCFG=/boot/firmware/config.txt
        [ -f "$BOOTCFG" ] || BOOTCFG=/boot/config.txt
        if [ -f "$BOOTCFG" ]; then
            if grep -q '^dtparam=audio=on' "$BOOTCFG"; then
                sed -i 's/^dtparam=audio=on/dtparam=audio=off/' "$BOOTCFG"
                c_ok "Onboard-Audio abgeschaltet (PWM-Voraussetzung)."
                REBOOT_NEEDED=1
            elif ! grep -q '^dtparam=audio=off' "$BOOTCFG"; then
                echo 'dtparam=audio=off' >> "$BOOTCFG"
                c_ok "Onboard-Audio abgeschaltet (PWM-Voraussetzung)."
                REBOOT_NEEDED=1
            fi
        else
            c_warn "config.txt nicht gefunden - Onboard-Audio bitte selbst abschalten."
        fi

        c_info "Installiere rpi_ws281x fuer den LED-Hilfsdienst..."
        apt-get install -y -qq python3-venv python3-dev
        if [ ! -x "$INSTALL_DIR/led-venv/bin/python" ]; then
            python3 -m venv "$INSTALL_DIR/led-venv"
        fi
        if "$INSTALL_DIR/led-venv/bin/pip" install --quiet --upgrade rpi_ws281x; then
            install -m 0644 "$INSTALL_DIR/deploy/asksin-analyzer-led.service" \
                /etc/systemd/system/asksin-analyzer-led.service
            systemctl daemon-reload
            systemctl enable --now asksin-analyzer-led.service \
                || c_warn "LED-Hilfsdienst startete nicht - 'journalctl -u asksin-analyzer-led'."
            c_ok "LED ueber PWM (GPIO18), Hilfsdienst asksin-analyzer-led laeuft."
            c_warn "Schiebeschalter SW1 auf der Platine auf Stellung PWM schieben."
        else
            c_warn "rpi_ws281x liess sich nicht installieren - LED bleibt dunkel."
            c_warn "Alternative: in den Einstellungen auf SPI umstellen (SW1 auf SPI)."
        fi
    fi
    c_ok "Status-LED/OLED vorbereitet."
fi


# --- Systemjournal: lesbar und dauerhaft --------------------------------------
# Zwei Voraussetzungen, damit sich nach einem Absturz feststellen laesst, ob er
# aus dem System kam:
#   1. Der Dienstbenutzer muss das Journal lesen duerfen (Gruppe systemd-journal).
#   2. Das Journal muss einen Neustart ueberleben. Auf Raspberry Pi OS ist es ab
#      Werk fluechtig (/run/log/journal) — nach einem harten Absturz ist dann
#      genau der interessante Teil verloren.
if [ ! -f /etc/systemd/journald.conf.d/asksin.conf ]; then
    mkdir -p /etc/systemd/journald.conf.d
    cat > /etc/systemd/journald.conf.d/asksin.conf <<'JCONF'
# AskSin-Analyzer: Journal ueber Neustarts hinweg aufheben, aber gedeckelt,
# damit es die SSD nicht vollschreibt.
[Journal]
Storage=persistent
SystemMaxUse=200M
MaxRetentionSec=1month
JCONF
    systemctl restart systemd-journald 2>/dev/null || true
    c_ok "Systemjournal wird jetzt dauerhaft gespeichert (max. 200 MB)."
fi

# --- Zeitbasis: NTP-Vorgabe de.pool.ntp.org -----------------------------------
# Der Verbund braucht synchrone Uhren. Ist nirgends ein NTP-Server
# konfiguriert (auch keiner per DHCP/Netzwerkseite gesetzt), gilt die
# Projektvorgabe. Idempotent - vorhandene Konfiguration bleibt unberuehrt.
if [ ! -f /etc/systemd/timesyncd.conf.d/asksin.conf ] \
   && ! grep -q '^NTP=' /etc/systemd/timesyncd.conf 2>/dev/null; then
    mkdir -p /etc/systemd/timesyncd.conf.d
    printf '[Time]\nNTP=de.pool.ntp.org\n' > /etc/systemd/timesyncd.conf.d/asksin.conf
    timedatectl set-ntp true 2>/dev/null || true
    systemctl try-restart systemd-timesyncd 2>/dev/null || true
    c_ok "NTP-Vorgabe gesetzt: de.pool.ntp.org"
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
# Ausfuehrungsrecht der Root-Helfer sicherstellen. Fehlt es, scheitert die
# zugehoerige Unit mit "Permission denied", und weil die Auftragsdatei dann
# liegen bleibt, feuert die Path-Unit endlos nach (31.07.2026 beobachtet).
chmod +x "$INSTALL_DIR/deploy/netz-anwenden.sh" "$INSTALL_DIR/deploy/led-pwm.py" \
    "$INSTALL_DIR/deploy/oled.py" \
    "$INSTALL_DIR/update.sh" 2>/dev/null || true

install -m 0644 "$INSTALL_DIR/deploy/asksin-analyzer.service" "$SERVICE_FILE"
install -m 0644 "$INSTALL_DIR/deploy/asksin-analyzer-update.service" /etc/systemd/system/
install -m 0644 "$INSTALL_DIR/deploy/asksin-analyzer-update.path" /etc/systemd/system/
install -m 0644 "$INSTALL_DIR/deploy/asksin-analyzer-netz.service" /etc/systemd/system/
install -m 0644 "$INSTALL_DIR/deploy/asksin-analyzer-netz.path" /etc/systemd/system/
install -m 0644 "$INSTALL_DIR/deploy/asksin-analyzer-neustart.path" /etc/systemd/system/
install -m 0644 "$INSTALL_DIR/deploy/asksin-analyzer-neustart.service" /etc/systemd/system/
install -m 0644 "$INSTALL_DIR/deploy/asksin-analyzer-langzeit.path" /etc/systemd/system/
install -m 0644 "$INSTALL_DIR/deploy/asksin-analyzer-langzeit.service" /etc/systemd/system/
install -m 0644 "$INSTALL_DIR/deploy/asksin-analyzer-alarmziel.path" /etc/systemd/system/
install -m 0644 "$INSTALL_DIR/deploy/asksin-analyzer-alarmziel.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable asksin-analyzer.service >/dev/null 2>&1 || true
systemctl enable --now asksin-analyzer-update.path >/dev/null 2>&1 || true
systemctl enable --now asksin-analyzer-neustart.path >/dev/null 2>&1 || true
systemctl enable --now asksin-analyzer-langzeit.path >/dev/null 2>&1 || true
systemctl enable --now asksin-analyzer-alarmziel.path >/dev/null 2>&1 || true
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
if [ "$LANGZEITDATEN" -eq 1 ]; then
    echo
    c_info "Richte InfluxDB und Grafana ein - das dauert einige Minuten..."
    # Direkt aufrufen statt ueber die Ausloeserdatei: Hier laeuft der Installer
    # ohnehin als root, und der Anwender sitzt davor und soll den Fortschritt
    # sehen. Schlaegt es fehl, ist der Analyzer trotzdem fertig eingerichtet —
    # deshalb bricht der Installer daran nicht ab.
    if bash "$INSTALL_DIR/deploy/langzeitdaten-einrichten.sh"; then
        c_ok "Langzeitdaten eingerichtet."
    else
        c_warn "Langzeitdaten liessen sich nicht einrichten - der Analyzer laeuft trotzdem."
        c_warn "Nachholen in der Weboberflaeche unter Einstellungen -> Langzeitdaten."
    fi
fi

if [ "$VERBUND_MASTER" -eq 1 ]; then
    c_info "Verbund-Master: Die anderen Analyzer verknuepfst du bequem in der"
    c_info "Weboberflaeche unter Einstellungen -> Verbund (Adresse eintragen,"
    c_info "fertig - keine Konsole noetig)."
else
    c_info "Verbund-Client: Hier ist nichts weiter zu tun - der Master traegt"
    c_info "diesen Analyzer in SEINER Weboberflaeche unter Einstellungen ->"
    c_info "Verbund ein. Adresse dieses Analyzers: http://${IP:-<pi-ip>}:${PORT_ANZEIGE}"
fi
echo
c_info "Solange der Sniffer-HAT noch nicht steckt, meldet die Oberflaeche"
c_info "'Sniffer getrennt' und der Dienst versucht es ruhig weiter - normal."
if [ "$REBOOT_NEEDED" -eq 1 ]; then
    echo
    c_warn "Die UART-Einrichtung braucht einen Neustart."
    a="$(ask_tty 'Jetzt neu starten? (j/N): ')"
    case "${a,,}" in j|ja|y|yes) c_info "Starte neu..."; reboot ;; *) c_warn "Bitte spaeter: sudo reboot" ;; esac
fi
