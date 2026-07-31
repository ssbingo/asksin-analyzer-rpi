#!/usr/bin/env bash
# Schickt die Kernel-Meldungen dieses Analyzers zusätzlich ins Netz.
#
# Hintergrund: Bricht der Pi hart weg, schafft er es nicht mehr, seine letzten
# Zeilen auf die Platte zu schreiben — das Journal endet mitten im Satz oder
# ist beschädigt. netconsole schickt jede Kernel-Meldung parallel als
# UDP-Paket an einen zweiten Rechner, ohne Umweg über ein Dateisystem. Damit
# ist auch der letzte Moment vor dem Ausfall lesbar.
#
# Das hier ändert NICHTS an der Netzwerkeinrichtung des Geräts: keine Adresse,
# kein Name, keine Route. Es kommt nur ein zusätzliches Ziel für die
# Kernel-Ausgabe dazu. Rückgängig mit "--aus".
#
# Aufruf:
#   sudo bash netconsole-einrichten.sh <ziel-ip> [port]
#   sudo bash netconsole-einrichten.sh --aus
#
# Auf dem Zielrechner läuft dazu:
#   python3 tools/netconsole-empfaenger.py --port 6666 --datei kernel.log

set -euo pipefail

MODPROBE_CONF=/etc/modprobe.d/asksin-netconsole.conf
LOAD_CONF=/etc/modules-load.d/asksin-netconsole.conf
SYSCTL_CONF=/etc/sysctl.d/99-asksin-netconsole.conf

if [ "$(id -u)" -ne 0 ]; then
    echo "Bitte mit sudo starten." >&2
    exit 1
fi

if [ "${1:-}" = "--aus" ]; then
    rm -f "$MODPROBE_CONF" "$LOAD_CONF" "$SYSCTL_CONF"
    modprobe -r netconsole 2>/dev/null || true
    echo "netconsole entfernt. Die Netzwerkeinrichtung war nie betroffen."
    exit 0
fi

ZIEL_IP="${1:-}"
PORT="${2:-6666}"

if ! [[ "$ZIEL_IP" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]; then
    echo "Aufruf: sudo bash $0 <ziel-ip> [port]   |   sudo bash $0 --aus" >&2
    exit 1
fi

# Über welche Schnittstelle und mit welcher Absenderadresse das Ziel erreicht
# wird, weiß der Kernel selbst am besten.
ROUTE="$(ip -o route get "$ZIEL_IP" 2>/dev/null || true)"
IFACE="$(awk '{for(i=1;i<=NF;i++) if($i=="dev") print $(i+1)}' <<<"$ROUTE")"
QUELL_IP="$(awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}' <<<"$ROUTE")"

if [ -z "$IFACE" ] || [ -z "$QUELL_IP" ]; then
    echo "Kein Weg zu $ZIEL_IP gefunden." >&2
    exit 1
fi

# netconsole braucht die MAC des Ziels — es baut die Pakete selbst und fragt
# nicht per ARP nach. Ein Ping füllt den Nachbar-Zwischenspeicher.
ping -c 2 -W 1 "$ZIEL_IP" >/dev/null 2>&1 || true
ZIEL_MAC="$(ip neigh show "$ZIEL_IP" 2>/dev/null \
            | awk '{for(i=1;i<=NF;i++) if($i=="lladdr") print $(i+1)}' | head -1)"

if [ -z "$ZIEL_MAC" ]; then
    # Ohne bekannte MAC an alle: Der Switch verteilt es, der Empfänger hört
    # trotzdem mit. Unschön, aber besser als gar keine Meldungen.
    ZIEL_MAC="ff:ff:ff:ff:ff:ff"
    echo "Hinweis: MAC von $ZIEL_IP nicht ermittelbar — sende an alle."
fi

PARAM="netconsole=${PORT}@${QUELL_IP}/${IFACE},${PORT}@${ZIEL_IP}/${ZIEL_MAC}"

cat >"$MODPROBE_CONF" <<EOF
# Erzeugt von tools/netconsole-einrichten.sh — Kernel-Meldungen zusätzlich an
# ${ZIEL_IP}:${PORT}. Ändert nichts an der Netzwerkeinrichtung des Geräts.
# Entfernen mit: sudo bash tools/netconsole-einrichten.sh --aus
options netconsole ${PARAM}
EOF

echo netconsole >"$LOAD_CONF"

# Höhere Ausführlichkeit auf der Konsole, damit auch Warnungen mitgehen und
# nicht nur harte Fehler. Reihenfolge: aktuell, Vorgabe, Minimum, Start.
cat >"$SYSCTL_CONF" <<'EOF'
# Damit auch Warnungen über netconsole gehen, nicht nur harte Fehler.
kernel.printk = 7 4 1 7
EOF
sysctl -q -p "$SYSCTL_CONF" 2>/dev/null || true

modprobe -r netconsole 2>/dev/null || true
if ! modprobe netconsole "$PARAM"; then
    echo "netconsole liess sich nicht laden — steht im Journal, warum." >&2
    exit 1
fi

echo "netconsole aktiv:"
echo "  von  ${QUELL_IP} (${IFACE})"
echo "  an   ${ZIEL_IP}:${PORT} [${ZIEL_MAC}]"
echo "  bleibt auch nach einem Neustart aktiv."
echo
echo "Probe — die Zeile muss beim Empfänger ankommen:"
echo "  AskSin-Analyzer: netconsole-Probe $(date '+%Y-%m-%d %H:%M:%S')" \
    >/dev/kmsg
echo "  gesendet."
