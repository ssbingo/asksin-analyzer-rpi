#!/usr/bin/env bash
# Schaltet UAS für eine USB-SATA-Brücke ab.
#
# Anlass: Auf dem Testgerät meldete sich die SSD im Leerlauf spontan vom Bus
# ab — mitten in der Nacht, bei Last 0,28 und 45 °C:
#
#   usb 1-1: USB disconnect, device number 2
#   device offline error, dev sda, sector 13914304 op 0x1:(WRITE)
#
# Sie kam 0,8 s später zurück, aber als *neues* Gerät (sdb). Das
# Wurzeldateisystem hing weiter am verschwundenen sda und war damit tot. Der
# Pi lief noch stundenlang weiter, konnte aber nichts mehr lesen — von außen
# sieht das aus wie ein Absturz.
#
# Viele billige USB-SATA-Brücken sind mit UAS (USB Attached SCSI) instabil,
# besonders an einem USB-2.0-Anschluss. Ohne UAS fallen sie auf den älteren,
# langsameren, aber robusten Bulk-Only-Transport zurück. Bei einer Brücke, die
# ohnehin nur USB 2.0 aushandelt, kostet das kaum Geschwindigkeit — und ist
# allemal besser als ein Gerät, das ohne Vorwarnung stehenbleibt.
#
# Das hier ist eine Notmaßnahme, keine Reparatur. Die eigentliche Lösung ist
# ein besseres Gehäuse (JMicron JMS578/583, ASMedia ASM1153E) oder beim Pi 5
# eine NVMe-Platine.
#
# Aufruf:
#   sudo bash usb-quirk-setzen.sh            # Brücke automatisch erkennen
#   sudo bash usb-quirk-setzen.sh 14b0:0206  # Kennung von Hand
#   sudo bash usb-quirk-setzen.sh --aus
#
# Wirkt erst nach einem Neustart.

set -euo pipefail

CMDLINE=/boot/firmware/cmdline.txt
[ -f "$CMDLINE" ] || CMDLINE=/boot/cmdline.txt

if [ "$(id -u)" -ne 0 ]; then
    echo "Bitte mit sudo starten." >&2
    exit 1
fi

if [ ! -f "$CMDLINE" ]; then
    echo "Keine cmdline.txt gefunden (weder /boot/firmware noch /boot)." >&2
    exit 1
fi

# cmdline.txt ist EINE Zeile. Wird daraus versehentlich mehr, startet der Pi
# nicht mehr — deshalb wird hier ausschliesslich in dieser einen Zeile
# gearbeitet und vorher eine Sicherung abgelegt.
ZEILE="$(head -1 "$CMDLINE")"

entferne_quirk() {
    # Alte quirks-Angabe herausnehmen, egal wo sie steht.
    sed -E 's/[[:space:]]*usb-storage\.quirks=[^[:space:]]*//g' <<<"$1" \
        | sed -E 's/[[:space:]]+/ /g; s/^ //; s/ $//'
}

if [ "${1:-}" = "--aus" ]; then
    NEU="$(entferne_quirk "$ZEILE")"
    if [ "$NEU" = "$ZEILE" ]; then
        echo "Es war kein Quirk gesetzt — nichts zu tun."
        exit 0
    fi
    cp -a "$CMDLINE" "${CMDLINE}.vor-quirk"
    printf '%s\n' "$NEU" >"$CMDLINE"
    echo "Quirk entfernt. Sicherung: ${CMDLINE}.vor-quirk"
    echo "Wirkt nach dem naechsten Neustart."
    exit 0
fi

KENNUNG="${1:-}"

if [ -z "$KENNUNG" ]; then
    # Die Brücke ist das USB-Gerät, hinter dem ein SCSI-Datenträger haengt.
    for d in /sys/bus/usb/devices/*/; do
        [ -f "$d/idVendor" ] && [ -f "$d/idProduct" ] || continue
        # Haengt an diesem Geraet ein Blockgeraet?
        if compgen -G "$d"*/host*/target*/*/block/* >/dev/null 2>&1; then
            KENNUNG="$(cat "$d/idVendor"):$(cat "$d/idProduct")"
            NAME="$(cat "$d/product" 2>/dev/null || echo "USB-Datenträger")"
            echo "Gefunden: $NAME  [$KENNUNG]"
            break
        fi
    done
fi

if ! [[ "$KENNUNG" =~ ^[0-9a-fA-F]{4}:[0-9a-fA-F]{4}$ ]]; then
    echo "Keine USB-Brücke erkannt. Kennung von Hand angeben:" >&2
    echo "  lsusb   →   z. B. 'ID 14b0:0206'" >&2
    echo "  sudo bash $0 14b0:0206" >&2
    exit 1
fi

# 'u' heisst: UAS fuer dieses Geraet nicht benutzen.
QUIRK="usb-storage.quirks=${KENNUNG}:u"

if grep -qF "$QUIRK" <<<"$ZEILE"; then
    echo "Quirk steht bereits in $CMDLINE — nichts zu tun."
    exit 0
fi

NEU="$(entferne_quirk "$ZEILE") ${QUIRK}"
cp -a "$CMDLINE" "${CMDLINE}.vor-quirk"
printf '%s\n' "$NEU" >"$CMDLINE"

# Gegenprobe: eine Zeile, Quirk drin, Wurzeldateisystem noch benannt.
if [ "$(wc -l <"$CMDLINE")" -ne 1 ] || ! grep -q "root=" "$CMDLINE"; then
    cp -a "${CMDLINE}.vor-quirk" "$CMDLINE"
    echo "Ergebnis sah falsch aus — Sicherung zurueckgespielt, nichts geaendert." >&2
    exit 1
fi

echo "Quirk gesetzt: $QUIRK"
echo "Sicherung:     ${CMDLINE}.vor-quirk"
echo
echo "Neue Startzeile:"
sed 's/^/  /' "$CMDLINE"
echo
echo "Wirkt nach: sudo reboot"
echo "Danach pruefen — 'usb-storage' statt 'uas' muss dastehen:"
echo "  dmesg | grep -E 'scsi host|usb-storage|uas'"
