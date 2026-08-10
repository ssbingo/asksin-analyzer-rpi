#!/usr/bin/env bash
# Brennt den Bootloader urboot auf den 328P — vom Raspberry Pi aus, ohne PC.
#
#   sudo bash deploy/bootloader-brennen.sh urboot_atmega328p.hex
#
# Danach die Firmware **über die Weboberfläche** aufspielen. Das ist keine
# Bequemlichkeit, sondern Bedingung — Begründung weiter unten.
#
# Warum es dieses Skript gibt
# ---------------------------
# Der Bootloader ist die Voraussetzung dafür, dass Firmware-Updates ohne
# Programmiergerät laufen. Er wird genau einmal je Platine gebraucht, und der
# Weg dahin steckt voller Fallen, die alle gleich aussehen: Die Platine
# schweigt, und man sucht am falschen Ende. Am 10.08.2026 hat das einen ganzen
# Tag gekostet.
#
# Die drei Fallen, in dieser Reihenfolge:
#
#  1. „Hochladen mit Programmer" in der Arduino IDE ruft avrdude ohne -D auf.
#     -D schaltet das automatische Löschen AB, ist also die Voreinstellung —
#     der Chip wird vollständig gelöscht, Bootloader eingeschlossen. Ein
#     ausgeschriebenes -e steht nirgends; wer danach sucht, findet nichts.
#
#  2. MiniCore lässt BOOTRST unprogrammiert (hfuse 0xd7). urboot ist ein
#     Vektor-Bootloader: Erreichbar wird er erst, wenn beim Aufspielen der
#     Anwendung der Reset-Vektor auf ihn umgebogen wird. Das macht avrdude
#     mit -c urclock — also nur beim Weg über die serielle Schnittstelle.
#     Ein ISP-Upload lässt den Vektor ungebogen zurück.
#
#  3. Daraus folgt: Wer nach dem Brennen den Sketch per ISP aufspielt, hat
#     den Bootloader zweimal verloren — gelöscht UND unerreichbar.
#
# Deshalb macht dieses Skript ausdrücklich NUR den Bootloader und sagt am
# Ende, wie es weitergeht.

set -euo pipefail

BITCLOCK="${ASKSIN_ISP_BITCLOCK:-8}"   # -B 8; bei zickigem USBasp: 32
MCU=m328p
PROGRAMMER=usbasp

rot=$'\e[1;31m'; gruen=$'\e[1;32m'; gelb=$'\e[1;33m'; fett=$'\e[1m'; aus=$'\e[0m'
meldung() { printf '\n%s== %s ==%s\n' "$fett" "$1" "$aus"; }
abbruch() { printf '\n%sAbbruch:%s %s\n' "$rot" "$aus" "$1" >&2; exit 1; }
ok()      { printf '  %sOK%s      %s\n' "$gruen" "$aus" "$1"; }
warnung() { printf '  %sAchtung%s %s\n' "$gelb" "$aus" "$1"; }

HEX="${1:-}"
[ -n "$HEX" ] || abbruch "Aufruf: sudo bash $0 <urboot-....hex>

Die Datei liegt in der Arduino-Installation unter
  MiniCore/hardware/avr/<fassung>/bootloaders/urboot/atmega328p/
  watchdog_1_s/autobaud/uart0_rxd0_txd1/no-led/urboot_atmega328p_pr_ee_ce.hex

Sie wird hier nicht mitgeliefert: urboot steht unter der GPL und gehört
seinem Urheber (Stefan Rueger), nicht diesem Projekt."

[ -f "$HEX" ] || abbruch "Datei nicht gefunden: $HEX"

# --- Die Datei prüfen, bevor irgendetwas gelöscht wird -----------------------
#
# Ein Chip-Erase ist nicht rückgängig zu machen. Eine verwechselte Datei —
# etwa die Firmware statt des Bootloaders — würde den Chip leeren und nichts
# Brauchbares hinterlassen.
meldung "Datei prüfen"
BEREICH="$(python3 - "$HEX" <<'PY'
import sys, pathlib
lo, hi, anz = 1 << 30, 0, 0
for z in pathlib.Path(sys.argv[1]).read_text(errors="replace").splitlines():
    z = z.strip()
    if not z.startswith(":"):
        continue
    b = bytes.fromhex(z[1:])
    if b[3] == 0:                      # Datensatz
        adr = (b[1] << 8) | b[2]
        lo, hi, anz = min(lo, adr), max(hi, adr + b[0]), anz + b[0]
print(f"{lo} {hi} {anz}")
PY
)"
read -r LO HI ANZ <<< "$BEREICH"

# Der Bootbereich des ATmega328P beginnt frühestens bei 0x7C00 (2 KiB) und
# reicht bis 0x7FFF. Alles darunter ist Anwendung — dann ist die Datei falsch.
if [ "$LO" -lt 31744 ]; then
    abbruch "Diese Datei beginnt bei $(printf '0x%04X' "$LO") und liegt damit im
  Anwendungsbereich. Ein Bootloader gehört nach 0x7C00 oder höher.
  Verwechselt? Die Firmware ist NICHT gemeint."
fi
[ "$HI" -le 32768 ] || abbruch "Die Datei reicht über das Ende des Flash hinaus."
ok "$ANZ Byte im Bootbereich $(printf '0x%04X–0x%04X' "$LO" $((HI - 1)))"
printf '  SHA-256 %s\n' "$(sha256sum "$HEX" | cut -d' ' -f1)"

# --- Chip ansprechen und Fuses zeigen ---------------------------------------
meldung "Chip ansprechen"
command -v avrdude >/dev/null || abbruch "avrdude fehlt: sudo apt install avrdude"

FUSES="$(avrdude -c "$PROGRAMMER" -p "$MCU" -B "$BITCLOCK" \
           -U lfuse:r:-:h -U hfuse:r:-:h -U efuse:r:-:h 2>/dev/null | tr '\n' ' ')" \
  || abbruch "Der Chip antwortet nicht über den USBasp.

  - Steckt die Platine noch auf dem Pi? Dann abziehen: Zwei Quellen auf
    derselben 3,3-V-Schiene, und der Pi hält Pegel auf GPIO4 und GPIO14.
  - Sitzt der ISP-Stecker auf J2 richtig herum?
  - Fabrikneuer Chip läuft auf 1 MHz — dann ASKSIN_ISP_BITCLOCK=32 setzen."

read -r LFUSE HFUSE EFUSE <<< "$FUSES"
ok "Signatur gelesen, Fuses: lfuse=$LFUSE hfuse=$HFUSE efuse=$EFUSE"

# BOOTRST ist bei MiniCore ABSICHTLICH unprogrammiert (hfuse 0xd7). urboot ist
# ein Vektor-Bootloader. Wer hier ein programmiertes BOOTRST erwartet, sucht
# am falschen Ende — deshalb steht es hier statt in einer Prüfung.
[ "$LFUSE" = "0xf7" ] || warnung "lfuse ist $LFUSE, erwartet 0xf7 (externer 8-MHz-Takt).
          Die Fuses werden hier NICHT verändert — das macht die Arduino IDE
          beim „Bootloader brennen\". Bei falschem Takt läuft der Bootloader
          mit falscher Baudrate."

# --- Brennen ----------------------------------------------------------------
meldung "Bootloader brennen"
warnung "Der Chip wird dabei vollständig gelöscht."
avrdude -c "$PROGRAMMER" -p "$MCU" -B "$BITCLOCK" -U "flash:w:${HEX}:i"

meldung "Fertig — und jetzt der entscheidende Schritt"
cat <<'ENDE'
  Der Bootloader liegt im Flash, die Anwendung ist gelöscht. Die Platine ist
  jetzt still; das ist richtig so.

  1. Platine stromlos auf den Pi stecken
  2. Firmware ÜBER DIE WEBOBERFLÄCHE aufspielen:
     Info → Sniffer-Firmware → asksin-sniffer.ino.hex → Firmware flashen

  Dieser eine Flash biegt den Reset-Vektor auf den Bootloader um. Erst danach
  ist er dauerhaft erreichbar, und jedes weitere Update läuft ohne
  Programmiergerät.

  Ab dann für diese Platine NIE WIEDER "Hochladen mit Programmer" in der
  Arduino IDE — das löscht den Bootloader und lässt den Vektor ungebogen.
ENDE
