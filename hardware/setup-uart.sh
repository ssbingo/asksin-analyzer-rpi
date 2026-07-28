#!/usr/bin/env bash
#
# setup-uart.sh — richtet GPIO14/15 auf Raspberry Pi 3, 4 und 5 als /dev/ttyAMA0 ein.
#
# Ziel auf allen Modellen: echte PL011/RP1-UART an GPIO14/15, keine miniUART,
# keine serielle Konsole. Details: ../docs/raspberry-pi-uart.md
#
# Aufruf:
#   sudo ./setup-uart.sh            anwenden
#   sudo ./setup-uart.sh --check    nur prüfen, nichts ändern
#
set -euo pipefail

CHECK_ONLY=0
[[ "${1:-}" == "--check" ]] && CHECK_ONLY=1

MARKER="# --- asksin-analyzer ---"
CHANGED=0

die()  { printf '\e[31mFEHLER\e[0m  %s\n' "$*" >&2; exit 1; }
ok()   { printf '\e[32m  ok\e[0m    %s\n' "$*"; }
warn() { printf '\e[33m  !\e[0m     %s\n' "$*"; }
act()  { printf '\e[36m  →\e[0m     %s\n' "$*"; }

# ---------------------------------------------------------------- Vorbedingungen

[[ -r /proc/device-tree/model ]] || die "Kein Raspberry Pi (kein /proc/device-tree/model)."
MODEL="$(tr -d '\0' < /proc/device-tree/model)"

if (( ! CHECK_ONLY )) && [[ "$(id -u)" -ne 0 ]]; then
  die "Bitte mit sudo aufrufen."
fi

# config.txt/cmdline.txt liegen ab Bookworm unter /boot/firmware/
if [[ -f /boot/firmware/config.txt ]]; then
  BOOTDIR=/boot/firmware
elif [[ -f /boot/config.txt ]]; then
  BOOTDIR=/boot
else
  die "Weder /boot/firmware/config.txt noch /boot/config.txt gefunden."
fi
CONFIG="$BOOTDIR/config.txt"
CMDLINE="$BOOTDIR/cmdline.txt"

# ---------------------------------------------------------------- Modellerkennung

case "$MODEL" in
  *"Raspberry Pi 5"*)              GEN=5 ;;
  *"Raspberry Pi 4"*|*"Pi 400"*)   GEN=4 ;;
  *"Raspberry Pi 3"*)              GEN=3 ;;
  *"Compute Module 4"*)            GEN=4 ;;
  *"Compute Module 5"*)            GEN=5 ;;
  *)
    warn "Unbekanntes Modell: $MODEL"
    warn "Behandle es wie einen Pi 4. Ergebnis nach dem Neustart prüfen."
    GEN=4
    ;;
esac

printf '\nModell   : %s\n' "$MODEL"
printf 'Generation: Pi %s\n' "$GEN"
printf 'Bootpfad : %s\n\n' "$BOOTDIR"

# ---------------------------------------------------------------- config.txt

case "$GEN" in
  5) WANTED=( "dtparam=uart0=on" ) ;;
  *) WANTED=( "enable_uart=1" "dtoverlay=disable-bt" ) ;;
esac

backup_once() {
  local f="$1"
  [[ -f "$f.asksin.bak" ]] && return 0
  cp -a "$f" "$f.asksin.bak"
  act "Sicherung angelegt: $f.asksin.bak"
}

MISSING=()
for line in "${WANTED[@]}"; do
  if grep -qxF "$line" "$CONFIG"; then
    ok "config.txt: $line"
  else
    MISSING+=("$line")
    warn "config.txt: fehlt — $line"
  fi
done

# uart0_console würde die Konsole auf GPIO14/15 legen — genau das wollen wir nicht.
if grep -qE '^\s*dtparam=uart0_console' "$CONFIG"; then
  warn "config.txt: dtparam=uart0_console ist gesetzt und muss entfernt werden."
  (( CHECK_ONLY )) || {
    backup_once "$CONFIG"
    sed -i -E 's/^(\s*dtparam=uart0_console.*)$/# \1  # deaktiviert durch setup-uart.sh/' "$CONFIG"
    act "config.txt: dtparam=uart0_console auskommentiert"
    CHANGED=1
  }
fi

# 1-Wire legt sich standardmäßig auf GPIO4 — dort sitzt unsere Reset-Leitung
# zum ATmega328P. I²C (GPIO2/3) ist dagegen frei und wird vom OLED genutzt.
if grep -qE '^\s*dtoverlay=w1-gpio(\s|$)' "$CONFIG"; then
  warn "config.txt: dtoverlay=w1-gpio belegt GPIO4 — dort liegt der Reset des 328P."
  warn "            1-Wire mit  dtoverlay=w1-gpio,gpiopin=<n>  auf einen anderen Pin legen."
fi

if (( ${#MISSING[@]} > 0 )) && (( ! CHECK_ONLY )); then
  backup_once "$CONFIG"
  { printf '\n%s\n' "$MARKER"
    printf '%s\n' "${MISSING[@]}"
  } >> "$CONFIG"
  act "config.txt: ${#MISSING[@]} Zeile(n) ergänzt"
  CHANGED=1
fi

# ---------------------------------------------------------------- cmdline.txt

if [[ -f "$CMDLINE" ]]; then
  if grep -qE 'console=(serial0|ttyAMA0|ttyS0)[^ ]*' "$CMDLINE"; then
    warn "cmdline.txt: serielle Konsole aktiv"
    if (( ! CHECK_ONLY )); then
      backup_once "$CMDLINE"
      sed -i -E 's/console=(serial0|ttyAMA0|ttyS0)[^ ]*\s*//g; s/\s+$//' "$CMDLINE"
      act "cmdline.txt: console=… entfernt"
      CHANGED=1
    fi
  else
    ok "cmdline.txt: keine serielle Konsole"
  fi
else
  warn "cmdline.txt nicht gefunden ($CMDLINE) — übersprungen"
fi

# ---------------------------------------------------------------- Dienste

disable_unit() {
  local unit="$1" label="$2"
  systemctl list-unit-files --no-legend 2>/dev/null | grep -q "^$unit" || return 0
  if systemctl is-enabled --quiet "$unit" 2>/dev/null; then
    warn "$label ist aktiviert"
    if (( ! CHECK_ONLY )); then
      systemctl disable --now "$unit" >/dev/null 2>&1 || true
      act "$label deaktiviert"
      CHANGED=1
    fi
  else
    ok "$label ist deaktiviert"
  fi
}

disable_unit "serial-getty@ttyAMA0.service" "serial-getty@ttyAMA0"
(( GEN < 5 )) && disable_unit "hciuart.service" "hciuart (Bluetooth an der UART)"

if (( ! CHECK_ONLY )) && systemctl list-unit-files --no-legend 2>/dev/null \
     | grep -q '^serial-getty@ttyAMA0'; then
  systemctl mask serial-getty@ttyAMA0.service >/dev/null 2>&1 || true
fi

# ---------------------------------------------------------------- libgpiod

if command -v gpioset >/dev/null 2>&1; then
  # v2 kennt --version mit "gpioset (libgpiod) 2.x"
  GPIOD_VER="$(gpioset --version 2>/dev/null | head -1 || true)"
  ok "libgpiod vorhanden: ${GPIOD_VER:-unbekannte Version}"
else
  warn "gpioset fehlt — für den Reset des 328P nötig:  sudo apt install gpiod"
  warn "RPi.GPIO und pigpio funktionieren auf dem Pi 5 nicht, libgpiod ist Pflicht."
fi

# ---------------------------------------------------------------- Ergebnis

printf '\n'
if [[ -e /dev/ttyAMA0 ]]; then
  ok "/dev/ttyAMA0 ist vorhanden"
else
  warn "/dev/ttyAMA0 fehlt noch — erscheint nach dem Neustart"
fi

if (( CHECK_ONLY )); then
  printf '\nNur geprüft, nichts geändert.\n'
elif (( CHANGED )); then
  printf '\n\e[33mNeustart erforderlich:\e[0m sudo reboot\n'
  printf 'Danach prüfen:  ls -l /dev/ttyAMA*\n'
  printf 'Rohdaten sehen: stty -F /dev/ttyAMA0 58824 raw -echo && cat -v /dev/ttyAMA0\n'
else
  printf '\nAlles bereits korrekt konfiguriert.\n'
fi

printf '\nNicht vergessen: Dienstbenutzer in die Gruppe dialout aufnehmen —\n'
printf '  sudo usermod -aG dialout <benutzer>\n\n'
