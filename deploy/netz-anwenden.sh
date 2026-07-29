#!/usr/bin/env bash
#
# Netzwerkeinstellungen anwenden (M7.6) — laeuft als root, gestartet von der
# systemd-Path-Unit asksin-analyzer-netz.path. Konzept:
# docs/netzwerkeinstellungen.md — insbesondere die PROBEZEIT: neue
# Einstellungen gelten 90 s auf Probe; ohne Bestaetigung wird der vorherige
# Zustand automatisch wiederhergestellt (Aussperr-Schutz).
#
set -euo pipefail

DATA_DIR="/var/lib/asksin-analyzer"
AUFTRAG="$DATA_DIR/netz-auftrag.json"
AKTIV="$DATA_DIR/netz-auftrag-aktiv.json"
BESTAETIGEN="$DATA_DIR/netz-bestaetigen"
BEST_FLAG="$DATA_DIR/netz-bestaetigt"
VORHER="$DATA_DIR/netz-vorher"
STATUS="$DATA_DIR/netz-status.json"
LOG="$DATA_DIR/netz.log"
PROBE_S=90

exec >>"$LOG" 2>&1

schreibe_status() {  # running step ok(null|true|false) [deadlineMs]
    printf '{"running":%s,"step":"%s","ok":%s,"deadline":%s,"updatedAt":%s}\n' \
        "$1" "$2" "$3" "${4:-null}" "$(date +%s%3N)" \
        > "$STATUS.tmp" && mv "$STATUS.tmp" "$STATUS"
    chmod 0644 "$STATUS"
}

j() { jq -r "$1" "$AKTIV"; }   # Feld aus dem aktiven Auftrag

# Aktive Verbindung/Schnittstelle ueber die Standardroute finden:
iface_ermitteln() { ip -j route show default | jq -r '.[0].dev // empty'; }
verbindung_ermitteln() {
    local dev="$1"
    nmcli -t -f NAME,DEVICE connection show --active \
        | awk -F: -v d="$dev" '$2==d {print $1; exit}'
}

sichere_vorher() {
    rm -rf "$VORHER"; mkdir -p "$VORHER"
    nmcli -t -f ipv4.method,ipv4.addresses,ipv4.gateway,ipv4.dns \
        connection show "$CON" > "$VORHER/nm.txt"
    hostname > "$VORHER/hostname.txt"
    if [ -f /etc/systemd/timesyncd.conf.d/asksin.conf ]; then
        cp /etc/systemd/timesyncd.conf.d/asksin.conf "$VORHER/ntp.conf"
    fi
}

nm_feld_vorher() { awk -F: -v k="$1" '$1==k {print $2}' "$VORHER/nm.txt"; }

hostname_setzen() {
    local neu="$1" alt
    alt="$(hostname)"
    [ -z "$neu" ] || [ "$neu" = "$alt" ] && return 0
    hostnamectl set-hostname "$neu"
    sed -i "s/\b$alt\b/$neu/g" /etc/hosts || true
    echo "Hostname: $alt -> $neu"
}

ntp_setzen() {
    local server="$1"
    if [ -n "$server" ]; then
        mkdir -p /etc/systemd/timesyncd.conf.d
        printf '[Time]\nNTP=%s\n' "$server" > /etc/systemd/timesyncd.conf.d/asksin.conf
    else
        rm -f /etc/systemd/timesyncd.conf.d/asksin.conf
    fi
    timedatectl set-ntp true 2>/dev/null || true
    systemctl try-restart systemd-timesyncd 2>/dev/null || true
}

wende_an() {
    local methode; methode="$(j '.method')"
    if [ "$methode" = "statisch" ]; then
        nmcli connection modify "$CON" \
            ipv4.method manual \
            ipv4.addresses "$(j '.address')/$(j '.prefix')" \
            ipv4.gateway "$(j '.gateway')" \
            ipv4.dns "$(j '.dns | join(" ")')"
    else
        nmcli connection modify "$CON" \
            ipv4.method auto ipv4.addresses "" ipv4.gateway "" ipv4.dns ""
    fi
    hostname_setzen "$(j '.hostname // ""')"
    [ "$(j 'has("ntp")')" = "true" ] && ntp_setzen "$(j '.ntp // ""')"
    nmcli connection up "$CON" >/dev/null
}

stelle_wieder_her() {
    echo "=== Rollback: $(date -Is) ==="
    local methode; methode="$(nm_feld_vorher ipv4.method)"
    if [ "$methode" = "manual" ]; then
        nmcli connection modify "$CON" \
            ipv4.method manual \
            ipv4.addresses "$(nm_feld_vorher ipv4.addresses)" \
            ipv4.gateway "$(nm_feld_vorher ipv4.gateway | sed 's/^--$//')" \
            ipv4.dns "$(nm_feld_vorher ipv4.dns | sed 's/^--$//')"
    else
        nmcli connection modify "$CON" \
            ipv4.method auto ipv4.addresses "" ipv4.gateway "" ipv4.dns ""
    fi
    hostname_setzen "$(cat "$VORHER/hostname.txt")"
    if [ -f "$VORHER/ntp.conf" ]; then
        mkdir -p /etc/systemd/timesyncd.conf.d
        cp "$VORHER/ntp.conf" /etc/systemd/timesyncd.conf.d/asksin.conf
    else
        rm -f /etc/systemd/timesyncd.conf.d/asksin.conf
    fi
    systemctl try-restart systemd-timesyncd 2>/dev/null || true
    nmcli connection up "$CON" >/dev/null
}

# ---------------------------------------------------------------- Ablauf

case "${1:-}" in
    --rollback-check)
        # 95 s nach der Uebernahme: wurde bestaetigt?
        if [ -f "$BEST_FLAG" ]; then
            echo "Bestaetigt — Einstellungen bleiben."
            exit 0
        fi
        DEV="$(iface_ermitteln)"; CON="$(verbindung_ermitteln "$DEV")"
        schreibe_status true "rollback" null
        stelle_wieder_her
        schreibe_status false "rollback" false
        echo "Nicht bestaetigt — vorheriger Zustand wiederhergestellt."
        exit 0
        ;;
esac

# Normalstart durch die Path-Unit: erst Bestaetigung, dann neuer Auftrag.
if [ -f "$BESTAETIGEN" ]; then
    rm -f "$BESTAETIGEN"
    touch "$BEST_FLAG"
    schreibe_status false "fertig" true
    echo "=== Bestaetigt: $(date -Is) ==="
    exit 0
fi

[ -f "$AUFTRAG" ] || exit 0
echo "=== Netzwerk-Auftrag: $(date -Is) ==="
mv "$AUFTRAG" "$AKTIV"
rm -f "$BEST_FLAG"

DEV="$(iface_ermitteln)"
[ -n "$DEV" ] || { schreibe_status false "fehler-keine-schnittstelle" false; exit 1; }
CON="$(verbindung_ermitteln "$DEV")"
[ -n "$CON" ] || { schreibe_status false "fehler-keine-verbindung" false; exit 1; }
echo "Schnittstelle $DEV, Verbindung '$CON'"

schreibe_status true "sichere" null
sichere_vorher

schreibe_status true "wende-an" null
if ! wende_an; then
    stelle_wieder_her
    schreibe_status false "fehler-rollback" false
    exit 1
fi

DEADLINE=$(( $(date +%s%3N) + PROBE_S * 1000 ))
schreibe_status true "probe" null "$DEADLINE"
echo "Probezeit ${PROBE_S}s laeuft — Rollback-Pruefung geplant."
systemd-run --quiet --on-active="$(( PROBE_S + 5 ))" "$0" --rollback-check
