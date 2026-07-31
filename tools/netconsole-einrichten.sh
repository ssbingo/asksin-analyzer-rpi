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

PULS_SERVICE=/etc/systemd/system/asksin-netconsole-puls.service
PULS_TIMER=/etc/systemd/system/asksin-netconsole-puls.timer

if [ "${1:-}" = "--aus" ]; then
    systemctl disable --now asksin-netconsole-puls.timer 2>/dev/null || true
    rm -f "$MODPROBE_CONF" "$LOAD_CONF" "$SYSCTL_CONF" \
          "$PULS_SERVICE" "$PULS_TIMER"
    systemctl daemon-reload
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

# ---------------------------------------------------------------- Pulsschlag
#
# Ohne das hier bleibt eine Luecke: Ein untaetiger Kernel sagt nichts. Faellt
# der Pi nachts um drei aus, waere die letzte empfangene Zeile womoeglich vom
# Vorabend — und man weiss weder, wann er starb, noch ob der Mitschnitt
# ueberhaupt noch lief. Eine Zeile pro Minute macht die Stille aussagekraeftig:
# Der letzte Puls datiert den Ausfall auf die Minute genau.
#
# Mitgeschickt wird, was im Ernstfall zaehlt — Laufzeit, Last, Temperatur und
# die Drossel-Meldung des Chips. Steigt eines davon vor dem Abriss auffaellig,
# steht die Ursache im Mitschnitt statt in einer Vermutung.
cat >"$PULS_SERVICE" <<'EOF'
[Unit]
Description=AskSin-Analyzer: Pulsschlag für den Kernel-Mitschnitt

[Service]
Type=oneshot
ExecStart=/bin/sh -c 'T=$(cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null || echo 0); \
  D=$(vcgencmd get_throttled 2>/dev/null || echo "throttled=?"); \
  echo "AskSin-Puls up=$(cut -d. -f1 /proc/uptime)s load=$(cut -d" " -f1-3 /proc/loadavg) temp=$((T/1000))C $D" > /dev/kmsg'
EOF

cat >"$PULS_TIMER" <<'EOF'
[Unit]
Description=AskSin-Analyzer: Pulsschlag jede Minute

[Timer]
OnBootSec=30s
OnUnitActiveSec=60s
AccuracySec=1s

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now asksin-netconsole-puls.timer >/dev/null 2>&1 || \
    echo "Hinweis: Pulsschlag liess sich nicht starten — Mitschnitt läuft trotzdem."

echo "netconsole aktiv:"
echo "  von  ${QUELL_IP} (${IFACE})"
echo "  an   ${ZIEL_IP}:${PORT} [${ZIEL_MAC}]"
echo "  bleibt auch nach einem Neustart aktiv."
echo "  Pulsschlag: jede Minute eine Zeile mit Laufzeit, Last und Temperatur."
echo
echo "Probe — die Zeile muss beim Empfänger ankommen:"
echo "  AskSin-Analyzer: netconsole-Probe $(date '+%Y-%m-%d %H:%M:%S')" \
    >/dev/kmsg
echo "  gesendet."
