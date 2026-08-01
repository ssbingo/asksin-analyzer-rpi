#!/usr/bin/env bash
# Misst, wie viel Luft die Stromversorgung des Pi noch hat.
#
# Anlass: Auf dem Testgerät meldete die Firmware ein 3-A-Netzteil, worauf der
# Pi 5 den Strom aller USB-Geräte zusammen auf 600 mA begrenzt. Weil eine
# 2,5-Zoll-SATA-SSD damit nicht anläuft, war die Grenze per
# usb_max_current_enable=1 aufgehoben — und aus einer sauberen Abschaltung
# wurde ein unkontrollierter Einbruch der 5-Volt-Schiene. Die Folge:
#
#   usb 1-1: USB disconnect, device number 2
#
# Der Rechenkern merkt davon nichts, er hat seine eigene Regelung. Deshalb
# steht in get_throttled unbeirrt 0x0, und man sucht wochenlang an der
# falschen Stelle. Dieses Skript macht den Einbruch sichtbar: Es belastet die
# Platte und tastet dabei die Schiene ab.
#
# Aufruf:
#   sudo bash strombudget-messen.sh [sekunden]      # Vorgabe: 30
#
# Gemessen wird nur gelesen — es wird nichts geschrieben und nichts geändert.

set -euo pipefail

DAUER="${1:-30}"

if ! command -v vcgencmd >/dev/null 2>&1; then
    echo "vcgencmd fehlt — dieses Skript braucht Raspberry-Pi-OS." >&2
    exit 1
fi

PLATTE="$(findmnt -no SOURCE / | sed -E 's/p?[0-9]+$//')"
if [ ! -b "$PLATTE" ]; then
    echo "Wurzel-Datenträger nicht gefunden." >&2
    exit 1
fi

echo "=== Ausgangslage ==="
BUDGET="$(python3 -c "print(int.from_bytes(open('/proc/device-tree/chosen/power/max_current','rb').read(),'big'))" 2>/dev/null || echo "?")"
echo "  gemeldetes Netzteil : ${BUDGET} mA $([ "$BUDGET" = "5000" ] && echo '(gut)' || echo '(zu wenig fuer eine USB-SSD)')"
echo "  USB-Grenze aufgehoben: $(vcgencmd get_config usb_max_current_enable)"
echo "  Drosselung          : $(vcgencmd get_throttled)"
if [ -f /proc/device-tree/hat/product ]; then
    echo "  aufgestecktes HAT   : $(tr -d '\0' </proc/device-tree/hat/product)"
fi
echo "  Datenträger         : $PLATTE"
echo

# Messwert aus "EXT5V_V volt(24)=5.14560000V" holen. Vorsicht: Der Name
# enthaelt selbst ein "5V" — ein Suchmuster auf Ziffern gefolgt von V trifft
# zweimal. Deshalb ausdruecklich das, was hinter dem Gleichheitszeichen steht.
lies_5v() {
    vcgencmd pmic_read_adc EXT5V_V 2>/dev/null \
        | sed -nE 's/.*=([0-9]+\.[0-9]+)V.*/\1/p'
}

LEER="$(lies_5v)"
echo "=== Messung ueber ${DAUER} s unter Last ==="
echo "  5V im Leerlauf: ${LEER:-nicht lesbar}"

# Last erzeugen: nur lesen, mit direktem Zugriff am Zwischenspeicher vorbei.
dd if="$PLATTE" of=/dev/null bs=1M iflag=direct status=none &
LAST=$!
# shellcheck disable=SC2064
trap "kill $LAST 2>/dev/null || true" EXIT INT TERM

printf "  messe"
MIN=99; MAX=0; N=0
ENDE=$(( $(cut -d. -f1 /proc/uptime) + DAUER ))
while [ "$(cut -d. -f1 /proc/uptime)" -lt "$ENDE" ]; do
    V="$(lies_5v)"
    [ -n "$V" ] || continue
    N=$((N + 1))
    # bc ist nicht ueberall da; awk rechnet zuverlaessig mit Kommazahlen.
    MIN="$(awk -v a="$MIN" -v b="$V" 'BEGIN{print (b<a)?b:a}')"
    MAX="$(awk -v a="$MAX" -v b="$V" 'BEGIN{print (b>a)?b:a}')"
    [ $((N % 10)) -eq 0 ] && printf "."
done
printf "\n"

kill $LAST 2>/dev/null || true
wait $LAST 2>/dev/null || true

echo "  Messwerte     : $N"
echo "  5V Minimum    : ${MIN} V"
echo "  5V Maximum    : ${MAX} V"
echo "  Drosselung    : $(vcgencmd get_throttled)"
echo

# Bewertung. Die USB-Spezifikation erlaubt am Geraet 4,75 V; darunter wird es
# unzuverlaessig, und eine USB-Bruecke startet irgendwann neu.
awk -v min="$MIN" 'BEGIN {
  if (min >= 4.95) print "  Bewertung: gut — die Schiene bleibt unter Last stabil.";
  else if (min >= 4.85) print "  Bewertung: knapp — sichtbarer Einbruch, aber noch im Rahmen.";
  else if (min >= 4.75) print "  Bewertung: grenzwertig — hier faellt eine USB-Bruecke gelegentlich aus.";
  else print "  Bewertung: ZU WENIG — unterhalb der USB-Spezifikation von 4,75 V.";
}'
echo
echo "=== Alle PMIC-Werte nach der Messung (fuers Protokoll) ==="
vcgencmd pmic_read_adc 2>/dev/null | sed 's/^/  /'
echo

echo "Hinweis: Ein einzelner Durchlauf beweist nichts, wenn der Ausfall selten"
echo "ist. Fuer den Dauerblick auf die Schiene laeuft der Puls des"
echo "Kernel-Mitschnitts weiter (siehe tools/netconsole-einrichten.sh)."
