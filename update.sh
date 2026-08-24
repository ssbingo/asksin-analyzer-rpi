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
# Dienstbenutzer wie in install.sh und in der systemd-Unit:
SERVICE_USER="asksin"
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

# Beide Werte ueberleben den Neustart des Skripts weiter unten — sonst hielte
# sich die zweite Fassung fuer "bereits aktuell" und baute das Web-UI nicht.
START_MS="${ASKSIN_UPDATE_START_MS:-$(date +%s%3N)}"
VORHER="${ASKSIN_UPDATE_VORHER:-$(git -C "$INSTALL_DIR" rev-parse --short HEAD)}"
NACHHER=""

schreibe_status() {  # running step ok(null|true|false)
    printf '{"running":%s,"step":"%s","ok":%s,"from":"%s","to":"%s","startedAt":%s,"updatedAt":%s}\n' \
        "$1" "$2" "$3" "$VORHER" "$NACHHER" "$START_MS" "$(date +%s%3N)" \
        > "$STATUS_DATEI.tmp" && mv "$STATUS_DATEI.tmp" "$STATUS_DATEI"
}

port() {
    grep -o '"port": *[0-9]*' "$CONFIG_FILE" 2>/dev/null | grep -o '[0-9]*' || echo 8080
}

# Units und Wrapper auf den Stand aus /opt bringen — idempotent; laeuft auch
# im „bereits aktuell"-Fall, damit neue Unit-Dateien nie liegenbleiben.
installiere_dateien() {
    # git-Kommandos des Dienstbenutzers im root-eigenen Repo erlauben
    # (sonst „dubious ownership" und /api/update/versions scheitert):
    git config --system --get-all safe.directory 2>/dev/null \
        | grep -qx "$INSTALL_DIR" \
        || git config --system --add safe.directory "$INSTALL_DIR"
    install -m 0644 "$INSTALL_DIR/deploy/asksin-analyzer.service" /etc/systemd/system/asksin-analyzer.service
    install -m 0644 "$INSTALL_DIR/deploy/asksin-analyzer-update.service" /etc/systemd/system/
    install -m 0644 "$INSTALL_DIR/deploy/asksin-analyzer-update.path" /etc/systemd/system/
    install -m 0644 "$INSTALL_DIR/deploy/asksin-analyzer-netz.service" /etc/systemd/system/ 2>/dev/null || true
    install -m 0644 "$INSTALL_DIR/deploy/asksin-analyzer-netz.path" /etc/systemd/system/ 2>/dev/null || true
    install -m 0644 "$INSTALL_DIR/deploy/asksin-analyzer-neustart.path" /etc/systemd/system/ 2>/dev/null || true
    install -m 0644 "$INSTALL_DIR/deploy/asksin-analyzer-neustart.service" /etc/systemd/system/ 2>/dev/null || true
    # Ausloeser fuer die Langzeitdaten-Einrichtung (M14). Genau hier fehlte
    # gestern die OLED-Unit — neue Units gehoeren mit in diese Liste, sonst
    # kommen Aenderungen daran nie auf dem Geraet an.
    install -m 0644 "$INSTALL_DIR/deploy/asksin-analyzer-langzeit.path" /etc/systemd/system/ 2>/dev/null || true
    install -m 0644 "$INSTALL_DIR/deploy/asksin-analyzer-langzeit.service" /etc/systemd/system/ 2>/dev/null || true
    install -m 0644 "$INSTALL_DIR/deploy/asksin-analyzer-zigbee-firmware.path" /etc/systemd/system/ 2>/dev/null || true
    install -m 0644 "$INSTALL_DIR/deploy/asksin-analyzer-zigbee-firmware.service" /etc/systemd/system/ 2>/dev/null || true
    install -m 0644 "$INSTALL_DIR/deploy/asksin-analyzer-alarmschalter.path" /etc/systemd/system/ 2>/dev/null || true
    install -m 0644 "$INSTALL_DIR/deploy/asksin-analyzer-alarmschalter.service" /etc/systemd/system/ 2>/dev/null || true
    install -m 0644 "$INSTALL_DIR/deploy/asksin-analyzer-systemupdate.path" /etc/systemd/system/ 2>/dev/null || true
    install -m 0644 "$INSTALL_DIR/deploy/asksin-analyzer-systemupdate.service" /etc/systemd/system/ 2>/dev/null || true
    install -m 0644 "$INSTALL_DIR/deploy/asksin-analyzer-alarmziel.path" /etc/systemd/system/ 2>/dev/null || true
    install -m 0644 "$INSTALL_DIR/deploy/asksin-analyzer-alarmziel.service" /etc/systemd/system/ 2>/dev/null || true
    systemctl enable asksin-analyzer-langzeit.path >/dev/null 2>&1 || true
    systemctl enable --now asksin-analyzer-zigbee-firmware.path >/dev/null 2>&1 || true
    systemctl enable --now asksin-analyzer-alarmschalter.path >/dev/null 2>&1 || true
    systemctl enable --now asksin-analyzer-systemupdate.path >/dev/null 2>&1 || true
    systemctl enable --now asksin-analyzer-alarmziel.path >/dev/null 2>&1 || true
    install -m 0755 "$INSTALL_DIR/deploy/asksin-analyzer" /usr/local/bin/asksin-analyzer
    # udev-Regeln nachziehen. Sie fehlten hier bis zum 18.08.2026 — und damit
    # waere die Regel fuer den Zigbee-Stick auf keiner bestehenden Anlage je
    # angekommen: /dev/asksin-zigbee gaebe es nicht, der Mithoerer faende sein
    # Geraet nicht, und die Suche begaenne beim Funk statt bei einer Datei, die
    # nie kopiert wurde.
    #
    # Dieselbe Falle wie bei den Units weiter oben: Was der Installer anlegt,
    # muss das Update nachziehen, sonst gilt es nur fuer Neuinstallationen.
    if ! cmp -s "$INSTALL_DIR/hardware/99-asksin-analyzer.rules" \
                /etc/udev/rules.d/99-asksin-analyzer.rules; then
        install -m 0644 "$INSTALL_DIR/hardware/99-asksin-analyzer.rules" \
            /etc/udev/rules.d/99-asksin-analyzer.rules
        udevadm control --reload >/dev/null 2>&1 || true
        udevadm trigger --subsystem-match=tty >/dev/null 2>&1 || true
        echo "  udev-Regeln aktualisiert."
    fi
    # Ausfuehrungsrecht der Root-Helfer sicherstellen. Fehlt es, scheitert die
    # Unit mit "Permission denied" und die Path-Unit feuert endlos nach.
    chmod +x "$INSTALL_DIR/deploy/netz-anwenden.sh" "$INSTALL_DIR/deploy/led-pwm.py" \
        "$INSTALL_DIR/deploy/oled.py" "$INSTALL_DIR/deploy/oled-einrichten.sh" \
        "$INSTALL_DIR/deploy/zigbee-firmware.sh" \
        "$INSTALL_DIR/update.sh" 2>/dev/null || true
    # OLED-Anzeigedienst nachziehen, wenn er eingerichtet ist:
    # OLED-Unit MIT nachziehen, nicht nur neu starten. Genau das fehlte:
    # Neue Einstellungen in der Unit (etwa RuntimeDirectory) kamen dadurch nie
    # auf dem Geraet an, Core und Anzeigedienst benutzten verschiedene
    # Verzeichnisse — und die Anzeige fiel auf die Notfall-Seitenzahl zurueck.
    if [ -f /etc/systemd/system/asksin-analyzer-oled.service ]; then
        # Die Bauhoehe steht als Argument in der vorhandenen Unit; sie darf
        # beim Ueberschreiben nicht verlorengehen.
        #
        # Das `|| true` ist nicht Zierde. Fehlt das Argument — etwa weil die
        # Unit von Hand ersetzt wurde —, liefert grep Rueckgabewert 1, und
        # mit `set -euo pipefail` bricht damit das GANZE Update ab: mitten im
        # Schritt "neustart", ohne Rollback, ohne verwertbare Meldung. Der
        # Ersatzwert `${HOEHE:-32}` zwei Zeilen tiefer wurde nie erreicht.
        # Am 18.08.2026 genau so passiert.
        HOEHE="$(grep -oE '\-\-hoehe [0-9]+' /etc/systemd/system/asksin-analyzer-oled.service \
                 | grep -oE '[0-9]+' | head -1 || true)"
        install -m 0644 "$INSTALL_DIR/deploy/asksin-analyzer-oled.service" \
            /etc/systemd/system/asksin-analyzer-oled.service
        sed -i "s|deploy/oled.py.*|deploy/oled.py --hoehe ${HOEHE:-32}|" \
            /etc/systemd/system/asksin-analyzer-oled.service
        systemctl daemon-reload
        systemctl restart asksin-analyzer-oled.service 2>/dev/null || true
    fi
    # LED-Hilfsdienst (PWM auf Pi 3/4) nur nachziehen, wenn er schon
    # eingerichtet ist — auf dem Pi 5 gibt es ihn bewusst nicht.
    if [ -f /etc/systemd/system/asksin-analyzer-led.service ]; then
        # Sicherheitsnetz: Ist der Dienst auf einem Pi 5 gelandet — etwa weil
        # eine vom Pi 3/4 uebernommene Konfiguration "ws2812-pwm" trug —, dann
        # hier abschalten und auf SPI stellen. PWM/DMA zielt dort auf eine
        # Speicherlage, die es hinter dem RP1 nicht gibt; im schlimmsten Fall
        # haengt das den Rechner hart auf, ohne Spur im Journal.
        MODELL="$( { tr -d '\0' < /proc/device-tree/model; } 2>/dev/null )"
        case "$MODELL" in
            *"Raspberry Pi 5"*|*"Compute Module 5"*)
                echo "  Pi 5 erkannt: LED-Hilfsdienst (PWM) wird abgeschaltet, LED laeuft ueber SPI."
                systemctl disable --now asksin-analyzer-led.service 2>/dev/null || true
                rm -f /etc/systemd/system/asksin-analyzer-led.service
                [ -f "$CONFIG_FILE" ] && sed -i \
                    's/"led"[[:space:]]*:[[:space:]]*"ws2812-pwm"/"led": "ws2812-spi"/' \
                    "$CONFIG_FILE"
                systemctl daemon-reload
                ;;
            *)
                install -m 0644 "$INSTALL_DIR/deploy/asksin-analyzer-led.service" \
                    /etc/systemd/system/asksin-analyzer-led.service
                ;;
        esac
    fi
    # jq braucht netz-anwenden.sh (M7.6); auf Bestandsanlagen nachziehen:
    command -v jq >/dev/null 2>&1 || apt-get install -y -qq jq || true
    # i2c-/spi-tools für die Statusanzeige (M11, per WebUI aktivierbar):
    command -v i2ctransfer >/dev/null 2>&1 || apt-get install -y -qq i2c-tools spi-tools || true
    # Gerätegruppen auf Bestandsanlagen nachziehen: ohne spi/i2c meldet die
    # Statusanzeige „Permission denied" auf /dev/spidev0.0 bzw. /dev/i2c-1;
    # ohne systemd-journal fehlen die Systemmeldungen in der Absturzsuche.
    for g in dialout gpio spi i2c systemd-journal; do
        getent group "$g" >/dev/null 2>&1 && usermod -aG "$g" "$SERVICE_USER" || true
    done
    # Journal dauerhaft speichern (M13) — auf Bestandsanlagen nachziehen:
    if [ ! -f /etc/systemd/journald.conf.d/asksin.conf ]; then
        mkdir -p /etc/systemd/journald.conf.d
        printf '[Journal]\nStorage=persistent\nSystemMaxUse=200M\nMaxRetentionSec=1month\n' \
            > /etc/systemd/journald.conf.d/asksin.conf
        systemctl restart systemd-journald 2>/dev/null || true
    fi
    # Grafana-Vorlagen und Alarmregeln mitziehen.
    #
    # Genau das fehlte: Beides wurde EINMAL beim Einrichten geschrieben und
    # danach nie wieder. Jede Verbesserung an den acht Ansichten und an den
    # vier Alarmen blieb damit im Repo liegen — auf dem Geraet lief weiter die
    # Fassung vom Installationstag. Silvio bekam deshalb naechtelang
    # Alarmtexte, die laengst berichtigt waren.
    #
    # NICHT angefasst werden zwei Dateien: die Datenquelle (sie enthaelt den
    # Zugangstoken, den nur das Einrichtungsskript kennt) und das vom Core
    # erzeugte Alarmziel.
    if [ -d /etc/grafana ]; then
        install -d -m 0755 /etc/grafana/provisioning/alerting \
                           /etc/grafana/provisioning/dashboards \
                           /var/lib/grafana/dashboards/asksin
        # Die Alarmregeln NICHT roh kopieren: Seit M14.3 lassen sich einzelne
        # Alarme in der Weboberflaeche abschalten, und ein rohes Kopieren
        # schaltete sie bei jeder Aktualisierung stillschweigend wieder ein.
        # Der Renderer legt die gespeicherten Schalter der frischen Vorlage
        # bei — so kommen Regelverbesserungen an, ohne die Wahl zu ueberfahren.
        #
        # Kein Rueckfall auf ein rohes Kopieren, auch nicht im Fehlerfall:
        # Misslingt das Erzeugen, bleibt die alte Datei liegen. Veraltete
        # Regeltexte sind aergerlich — Alarme, die von selbst wieder angehen,
        # sind schlimmer, weil niemand nach ihrer Ursache suchen wuerde.
        if ! node "$INSTALL_DIR/core/bin/alarme-rendern.ts" \
                  /etc/grafana/provisioning/alerting/asksin-alarme.yaml; then
            echo "  ACHTUNG Alarmregeln konnten nicht erzeugt werden — alte Fassung bleibt." >&2
        fi
        install -m 0644 "$INSTALL_DIR/deploy/grafana/provisioning/dashboards/asksin.yaml" \
            /etc/grafana/provisioning/dashboards/asksin.yaml
        install -m 0644 "$INSTALL_DIR"/deploy/grafana/dashboards/*.json \
            /var/lib/grafana/dashboards/asksin/
        chown -R grafana:grafana /var/lib/grafana/dashboards/asksin 2>/dev/null || true
        # Haelt den InfluxDB-Token aus dem Journal — Begruendung in der Datei.
        install -d -m 0755 /etc/systemd/system/grafana-server.service.d
        install -m 0644 "$INSTALL_DIR/deploy/grafana/systemd/asksin-kein-token-im-log.conf" \
            /etc/systemd/system/grafana-server.service.d/asksin-kein-token-im-log.conf
        systemctl daemon-reload 2>/dev/null || true
        systemctl restart grafana-server 2>/dev/null || true
        echo "  ok Grafana-Vorlagen und Alarmregeln aktualisiert."
    fi

    systemctl daemon-reload
    systemctl enable --now asksin-analyzer-update.path >/dev/null 2>&1 || true
    systemctl enable --now asksin-analyzer-neustart.path >/dev/null 2>&1 || true
    systemctl enable --now asksin-analyzer-netz.path >/dev/null 2>&1 || true
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
# --tags ist noetig: Ohne sie bleiben die Versions-Tags auf dem Pi
# stehen, und die Versionsanzeige zeigt jahrelang eine alte Nummer.
# Eine beschaedigte Git-Ablage bekommt hier eine eigene Meldung. Der Rollback
# unten koennte sie nicht reparieren — er benutzt dasselbe kaputte Repo.
#
# Anlass (04.08.2026, Pi 3 auf SD-Karte): leere Objektdateien nach einem
# harten Ausschalten. Ohne diese Meldung sieht der Anwender nur eine Wand aus
# "error: object file ... is empty" und weiss nicht, dass die Reparatur ein
# Einzeiler ist.
if ! git -C "$INSTALL_DIR" fetch --quiet --tags --force origin "$BRANCH" 2>/dev/null; then
    c_err "Die Git-Ablage in $INSTALL_DIR laesst sich nicht aktualisieren."
    c_err "Meist ist sie beschaedigt — typisch nach hartem Ausschalten auf SD-Karte."
    c_err ""
    c_err "Reparatur (holt den Quelltext neu, Konfiguration und Daten bleiben):"
    c_err "  curl -fsSL $REPO_URL/raw/$BRANCH/install.sh | sudo bash"
    c_err ""
    c_err "Wiederholt sich das, die Karte pruefen:  dmesg | grep -i 'mmc\\|i/o error'"
    exit 1
fi
git -C "$INSTALL_DIR" reset --hard --quiet "origin/$BRANCH"
NACHHER="$(git -C "$INSTALL_DIR" rev-parse --short HEAD)"

if [ "$VORHER" = "$NACHHER" ]; then
    c_ok "Bereits aktuell ($NACHHER)."
    installiere_dateien
    schreibe_status false "aktuell" true
    exit 0
fi
c_ok "Aktualisiert: $VORHER -> $NACHHER"

# --- 1b. Mit der NEUEN Fassung dieses Skripts weitermachen --------------------
#
# Ab hier liegt eine neue update.sh auf der Platte — die laufende stammt noch
# von vorher. Bash hat seine Funktionen laengst aus der alten Datei gelesen,
# `installiere_dateien` also auch. Alles, was die neue Fassung dort zusaetzlich
# tut, bliebe liegen und kaeme erst beim UEBERNAECHSTEN Update an.
#
# Gemessen am 23.08.2026: Nach dem Update auf v1.3.0 fehlten beide Units der
# Alarmschalter, obwohl sie in `installiere_dateien` stehen. Die Schalter in
# der Oberflaeche liessen sich umlegen, und nichts geschah — es sah aus wie ein
# Fehler in der neuen Funktion und war einer im Aktualisierungsweg.
#
# Genau der haeufigste Fehlertyp dieses Projekts: zwei Staende, eine Annahme,
# keine Meldung. Deshalb ab hier mit der neuen Fassung weiter; die Umgebung
# verhindert eine Schleife.
if [ "${ASKSIN_UPDATE_NEUSTART:-}" != "1" ]; then
    export ASKSIN_UPDATE_NEUSTART=1
    export ASKSIN_UPDATE_VORHER="$VORHER"
    export ASKSIN_UPDATE_START_MS="$START_MS"
    exec bash "$INSTALL_DIR/update.sh" "$@"
fi

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
installiere_dateien
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
