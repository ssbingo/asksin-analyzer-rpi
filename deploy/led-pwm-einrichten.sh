#!/usr/bin/env bash
# Richtet die WS2812-Status-LED über PWM ein — für Pi 3 und Pi 4.
#
#   sudo bash /opt/asksin-analyzer/deploy/led-pwm-einrichten.sh
#
# Warum es dieses Skript gibt
# ---------------------------
# Die Betriebsart der LED lässt sich in der Weboberfläche umstellen. Dabei
# wird aber nur die Einstellung geschrieben — die Voraussetzungen für PWM
# schafft bisher nur der Installer:
#
#   * rpi_ws281x (Python, braucht Root für DMA)
#   * der Hilfsdienst asksin-analyzer-led
#   * abgeschaltetes Onboard-Audio (belegt sonst die PWM-Hardware)
#
# Wer also nachträglich von SPI auf PWM umstellt, bekommt eine Einstellung,
# die aussieht als wirke sie, und eine dunkle LED. Am 10.08.2026 an
# Analyzer 01 genau so passiert: Der Core schrieb die Farbe korrekt nach
# /run/asksin-analyzer/led-farbe, aber niemand las sie.
#
# Auf dem Pi 5 wird dieses Skript nicht gebraucht — dort läuft die LED über
# SPI, und der Analyzer treibt sie selbst.

set -euo pipefail

INSTALL_DIR="${ASKSIN_INSTALL_DIR:-/opt/asksin-analyzer}"

rot=$'\e[1;31m'; gruen=$'\e[1;32m'; gelb=$'\e[1;33m'; fett=$'\e[1m'; aus=$'\e[0m'
meldung() { printf '\n%s== %s ==%s\n' "$fett" "$1" "$aus"; }
abbruch() { printf '\n%sAbbruch:%s %s\n' "$rot" "$aus" "$1" >&2; exit 1; }
ok()      { printf '  %sOK%s      %s\n' "$gruen" "$aus" "$1"; }
hinweis() { printf '  %sHinweis%s %s\n' "$gelb" "$aus" "$1"; }

[ "$(id -u)" = "0" ] || abbruch "Bitte mit sudo starten."
[ -d "$INSTALL_DIR" ] || abbruch "$INSTALL_DIR nicht gefunden."

NEUSTART_NOETIG=0

# --- Onboard-Audio abschalten -----------------------------------------------
#
# PWM braucht die Hardware exklusiv. Bleibt Audio an, ist die LED dunkel,
# egal wie richtig alles andere eingestellt ist — und nichts sagt es einem.
meldung "Onboard-Audio"
BOOTCFG=/boot/firmware/config.txt
[ -f "$BOOTCFG" ] || BOOTCFG=/boot/config.txt
if [ -f "$BOOTCFG" ]; then
    if grep -q '^dtparam=audio=on' "$BOOTCFG"; then
        sed -i 's/^dtparam=audio=on/dtparam=audio=off/' "$BOOTCFG"
        ok "abgeschaltet ($BOOTCFG)"
        NEUSTART_NOETIG=1
    elif grep -q '^dtparam=audio=off' "$BOOTCFG"; then
        ok "war schon abgeschaltet"
    else
        echo 'dtparam=audio=off' >> "$BOOTCFG"
        ok "abgeschaltet ($BOOTCFG)"
        NEUSTART_NOETIG=1
    fi
else
    hinweis "config.txt nicht gefunden — Onboard-Audio bitte selbst abschalten."
fi

# --- rpi_ws281x -------------------------------------------------------------
meldung "rpi_ws281x"
if [ -x "$INSTALL_DIR/led-venv/bin/python" ] \
   && "$INSTALL_DIR/led-venv/bin/python" -c "import rpi_ws281x" 2>/dev/null; then
    ok "bereits vorhanden"
else
    apt-get install -y -qq python3-venv python3-dev
    [ -x "$INSTALL_DIR/led-venv/bin/python" ] || python3 -m venv "$INSTALL_DIR/led-venv"
    "$INSTALL_DIR/led-venv/bin/pip" install --quiet --upgrade rpi_ws281x \
        || abbruch "rpi_ws281x liess sich nicht installieren.
  Ohne die Bibliothek geht PWM nicht. Alternative: in den Einstellungen auf
  SPI umstellen und den Schiebeschalter SW1 auf SPI schieben."
    ok "installiert"
fi

# --- Hilfsdienst ------------------------------------------------------------
meldung "Hilfsdienst"
install -m 0644 "$INSTALL_DIR/deploy/asksin-analyzer-led.service" \
        /etc/systemd/system/asksin-analyzer-led.service
systemctl daemon-reload
systemctl enable --now asksin-analyzer-led.service \
    || abbruch "Der Dienst startete nicht: journalctl -u asksin-analyzer-led"
ok "asksin-analyzer-led ist eingerichtet und läuft"

# --- Ergebnis ---------------------------------------------------------------
meldung "Fertig"
if [ "$NEUSTART_NOETIG" = "1" ]; then
    printf '  %sEin Neustart ist nötig%s — das Abschalten des Onboard-Audio\n' "$gelb" "$aus"
    printf '  wirkt erst danach:  sudo reboot\n\n'
fi
cat <<'ENDE'
  Danach muss der Schiebeschalter SW1 auf der Platine auf Stellung PWM
  stehen. Steht er auf SPI, ist die Datenleitung schlicht nicht
  durchgeschaltet — die LED bleibt dunkel, obwohl alles andere stimmt.

  Prüfen, ob der Core die Farbe schreibt:
    cat /run/asksin-analyzer/led-farbe

  Prüfen, ob der Helfer sie liest:
    journalctl -u asksin-analyzer-led -n 20
ENDE
