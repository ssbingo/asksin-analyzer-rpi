#!/usr/bin/env bash
#
# Richtet den OLED-Anzeigedienst ein — Bibliotheken, venv, systemd-Unit.
#
# Eigenes Skript, damit sich eine misslungene Einrichtung reparieren laesst,
# ohne den ganzen Installer erneut laufen zu lassen:
#
#     sudo /opt/asksin-analyzer/deploy/oled-einrichten.sh [32|64]
#
# Warum der Aufwand mit den apt-Paketen
# -------------------------------------
# `pip install adafruit-blinka` zieht **lgpio** nach. Das Rad dafuer wird aus
# dem Quellcode gebaut und braucht `swig` und die Python-Header — fehlen sie,
# bricht die Installation ab:
#
#     error: command 'swig' failed: No such file or directory
#     ERROR: Failed building wheel for lgpio
#
# Raspberry Pi OS liefert lgpio aber als fertiges Paket `python3-lgpio`.
# Deshalb: erst die apt-Pakete, dann ein venv **mit** Zugriff auf die
# System-Pakete (--system-site-packages) — so findet pip das fertige lgpio und
# baut nichts mehr. `swig` und die Header kommen trotzdem mit, damit ein Bau
# gelingt, falls das Paket auf einer Ausgabe fehlt.
set -euo pipefail

INSTALL_DIR="/opt/asksin-analyzer"
SERVICE_USER="asksin"
VENV="$INSTALL_DIR/oled-venv"
UNIT="/etc/systemd/system/asksin-analyzer-oled.service"
HOEHE="${1:-32}"

c_info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
c_ok()   { printf '\033[1;32m  ok\033[0m %s\n' "$*"; }
c_warn() { printf '\033[1;33m  !!\033[0m %s\n' "$*"; }
c_err()  { printf '\033[1;31mFEHLER:\033[0m %s\n' "$*" >&2; }

if [ "$(id -u)" -ne 0 ]; then
    c_err "Bitte mit Root-Rechten ausfuehren (sudo)."
    exit 1
fi

export DEBIAN_FRONTEND=noninteractive

# Pflichtpakete — ohne die geht es nicht.
c_info "Installiere Systempakete fuer die OLED-Anzeige..."
apt-get install -y -qq python3-venv python3-dev fonts-dejavu-core i2c-tools

# Kuerpakete: vorhanden -> kein Bau noetig. Fehlt eines, ist das kein Fehler;
# pip baut dann selbst, wofuer swig und die Header da sind.
# liblgpio-dev liefert die C-Bibliothek, gegen die pip linkt, falls es lgpio
# doch selbst baut. Ohne sie bricht der Linker ab: "cannot find -llgpio".
for paket in python3-lgpio liblgpio-dev python3-pil swig build-essential \
             libjpeg-dev zlib1g-dev; do
    if apt-get install -y -qq "$paket" 2>/dev/null; then
        c_ok "$paket"
    else
        c_warn "$paket nicht verfuegbar - wird uebersprungen."
    fi
done

# venv mit Zugriff auf die Systempakete: damit sieht pip das fertige
# python3-lgpio und python3-pil und baut sie nicht erneut.
# Entscheidend ist nicht nur, DASS ein venv da ist, sondern dass es die
# Systempakete sieht. Ein Lauf ohne --system-site-packages hinterlaesst ein
# gueltiges, aber abgeschottetes venv; pip baut darin lgpio erneut aus dem
# Quellcode und scheitert am fehlenden Linker-Ziel. Genau das ist beim ersten
# Versuch passiert — deshalb wird hier der Schalter geprueft, nicht bloss die
# Existenz.
sieht_systempakete() {
    [ -f "$VENV/pyvenv.cfg" ] &&
        grep -qiE '^include-system-site-packages[[:space:]]*=[[:space:]]*true' \
            "$VENV/pyvenv.cfg"
}

if [ ! -x "$VENV/bin/python" ]; then
    c_info "Lege virtuelle Umgebung an ($VENV)..."
    python3 -m venv --system-site-packages "$VENV"
elif ! sieht_systempakete; then
    c_warn "Vorhandene Umgebung sieht die Systempakete nicht - lege sie neu an."
    rm -rf "$VENV"
    python3 -m venv --system-site-packages "$VENV"
else
    c_ok "Virtuelle Umgebung vorhanden und mit Zugriff auf die Systempakete."
fi

if "$VENV/bin/python" -c 'import lgpio' 2>/dev/null; then
    c_ok "lgpio kommt aus dem Systempaket - pip muss nichts bauen."
else
    c_warn "lgpio ist nicht als Systempaket da - pip baut es selbst."
fi

c_info "Installiere adafruit_ssd1306, Blinka und Pillow..."
PAKETE="adafruit-circuitpython-ssd1306 adafruit-blinka pillow"
if ! "$VENV/bin/pip" install --quiet --upgrade --prefer-binary $PAKETE; then
    # Beim ersten Versuch war die Ausgabe unterdrueckt — jetzt zeigen, woran
    # es wirklich liegt, statt den Nutzer den Befehl selbst wiederholen zu
    # lassen. Der zweite Lauf kostet nichts: Was geklappt hat, bleibt liegen.
    c_warn "Fehlgeschlagen - hier die vollstaendige Ausgabe:"
    echo "----------------------------------------------------------------"
    "$VENV/bin/pip" install --upgrade --prefer-binary $PAKETE || true
    echo "----------------------------------------------------------------"
    c_err "Die Bibliotheken liessen sich nicht installieren."
    c_err "Haeufigste Ursache: lgpio wird aus dem Quellcode gebaut, weil"
    c_err "python3-lgpio fehlt oder die Umgebung die Systempakete nicht sieht."
    exit 1
fi
c_ok "Bibliotheken installiert."

# Kurzer Selbsttest: laesst sich der Treiber ueberhaupt laden?
if "$VENV/bin/python" -c 'import adafruit_ssd1306, PIL' 2>/dev/null; then
    c_ok "adafruit_ssd1306 und Pillow sind ladbar."
else
    c_warn "Die Bibliotheken sind installiert, lassen sich aber nicht laden."
    c_warn "Pruefen: sudo $VENV/bin/python -c 'import adafruit_ssd1306'"
fi

chown -R "$SERVICE_USER:$SERVICE_USER" "$VENV" 2>/dev/null || true
chmod +x "$INSTALL_DIR/deploy/oled.py"

c_info "Richte den Dienst ein (Panel 128x${HOEHE})..."
install -m 0644 "$INSTALL_DIR/deploy/asksin-analyzer-oled.service" "$UNIT"
sed -i "s|deploy/oled.py.*|deploy/oled.py --hoehe ${HOEHE}|" "$UNIT"
systemctl daemon-reload
if systemctl enable --now asksin-analyzer-oled.service; then
    c_ok "Anzeigedienst laeuft."
else
    c_warn "Dienst startete nicht - 'journalctl -u asksin-analyzer-oled -n 30'."
fi

# Meldet sich ueberhaupt ein Display?
if command -v i2cdetect >/dev/null 2>&1; then
    if i2cdetect -y 1 2>/dev/null | grep -qiE ' 3c| 3d'; then
        c_ok "OLED auf dem I2C-Bus gefunden (0x3C/0x3D)."
    else
        c_warn "Auf dem I2C-Bus meldet sich kein Display."
        c_warn "I2C eingeschaltet? sudo raspi-config nonint do_i2c 0 && sudo reboot"
    fi
fi
