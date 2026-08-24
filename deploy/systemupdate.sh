#!/usr/bin/env bash
#
# Systemaktualisierung: apt-get update + apt-get full-upgrade.
#
# Aufrufwege:
#   sudo bash /opt/asksin-analyzer/deploy/systemupdate.sh
#   ueber die Weboberflaeche: analyzerd legt eine Ausloeserdatei an, die
#   systemd-Path-Unit startet dieses Skript.
#
# Der Fortschritt steht fortlaufend in $DATEN_DIR/systemupdate-status.json,
# die vollstaendige Ausgabe in $DATEN_DIR/systemupdate.log. Beides ueberlebt
# einen Neustart des Analyzer-Dienstes — apt kann durchaus Pakete aufruesten,
# die ihn mitnehmen, und dann muss die Oberflaeche hinterher trotzdem sagen
# koennen, wie es ausgegangen ist.
#
# Warum ein eigenes Skript und nicht unattended-upgrades: Das laeuft ohne
# Zutun und ohne Rueckmeldung. Hier soll der Anwender *sehen*, dass etwas
# passiert, und hinterher, wann es zuletzt geklappt hat.

set -uo pipefail

DATEN_DIR="${DATEN_DIR:-/var/lib/asksin-analyzer}"
STATUS="$DATEN_DIR/systemupdate-status.json"
ERFOLG="$DATEN_DIR/systemupdate-erfolg.json"
LOG="$DATEN_DIR/systemupdate.log"
ANSTOSS="$DATEN_DIR/systemupdate-anstoss"

[ "$(id -u)" -eq 0 ] || { echo "Bitte mit sudo starten." >&2; exit 1; }
mkdir -p "$DATEN_DIR"

# Der Ausloeser wird ZUERST entfernt: Bliebe er liegen und das Skript stuerzte
# ab, feuerte die Path-Unit sofort wieder — eine Schleife aus apt-Laeufen.
rm -f "$ANSTOSS"

START_MS="$(date +%s%3N)"
PAKETE="null"
NEUSTART="false"
FEHLER="null"

# JSON-Zeichenkette: Anfuehrungszeichen und Backslashes maskieren, Zeilenumbrueche
# raus. apt-Meldungen enthalten beides, und eine kaputte Statusdatei waere
# schlimmer als eine unvollstaendige Meldung.
json_text() {
    printf '%s' "$1" | tr '\n' ' ' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

schreibe_status() {   # running schritt ok
    local fehler_feld="$FEHLER"
    [ "$fehler_feld" != "null" ] && fehler_feld="\"$(json_text "$FEHLER")\""
    printf '{"running":%s,"schritt":"%s","ok":%s,"startedAt":%s,"updatedAt":%s,"pakete":%s,"neustartNoetig":%s,"fehler":%s}\n' \
        "$1" "$2" "$3" "$START_MS" "$(date +%s%3N)" "$PAKETE" "$NEUSTART" "$fehler_feld" \
        > "$STATUS.tmp" && mv "$STATUS.tmp" "$STATUS"
}

# Ein Abbruch aus jedem Grund — auch SIGTERM durch systemd — hinterlaesst
# einen sauberen Endzustand. Ohne das bliebe "running": true stehen, und die
# Oberflaeche zeigte ewig einen laufenden Vorgang.
abbruch() {
    if [ "$(grep -c '"running":true' "$STATUS" 2>/dev/null || echo 0)" -gt 0 ]; then
        [ "$FEHLER" = "null" ] && FEHLER="Vorgang wurde abgebrochen."
        schreibe_status false abgebrochen false
    fi
}
trap abbruch EXIT

: > "$LOG"
exec 3>&1
protokoll() { tee -a "$LOG" >&3; }

echo "===== Systemaktualisierung $(date -Is) =====" | protokoll
schreibe_status true start null

# LC_ALL=C: Die Ausgabe soll unabhaengig von der Spracheinstellung des Geraets
# sein — der Core liest die Zusammenfassung aus und braucht dafuer eine feste
# Form.
export LC_ALL=C
export DEBIAN_FRONTEND=noninteractive
# Sperre abwarten statt sofort scheitern: Der taegliche apt-Timer von Debian
# oder unattended-upgrades halten sie gelegentlich. Zehn Minuten reichen dafuer
# weit; ohne diese Option waere die haeufigste Fehlermeldung "Could not get
# lock" — und das klaenge nach einem Defekt, obwohl es nur schlechtes Timing
# ist. Braucht apt >= 2.2 (Debian 11); aeltere ignorieren die Option.
APT_OPTS=(
    -o "DPkg::Lock::Timeout=600"
    -o "Dpkg::Options::=--force-confdef"
    -o "Dpkg::Options::=--force-confold"
)
# --force-conf*: Geaenderte Konfigurationsdateien bleiben stehen, neue werden
# ohne Rueckfrage uebernommen. Ein Geraet, das im Schrank steht, kann die Frage
# "Paketbetreuer-Version installieren?" niemandem stellen — es bliebe stehen,
# bis das Zeitlimit zuschlaegt.

# --- 1. Paketlisten holen ----------------------------------------------------
schreibe_status true paketlisten null
echo "--- apt-get update ---" | protokoll
if ! apt-get "${APT_OPTS[@]}" update 2>&1 | protokoll; then
    FEHLER="apt-get update fehlgeschlagen — Netzverbindung und /etc/apt/sources.list pruefen. Einzelheiten im Protokoll."
    schreibe_status false paketlisten false
    trap - EXIT
    exit 1
fi

# --- 2. Aufruesten -----------------------------------------------------------
schreibe_status true aufruesten null
echo "--- apt-get full-upgrade ---" | protokoll
AUSGABE="$(apt-get "${APT_OPTS[@]}" -y full-upgrade 2>&1)"
RC=$?
printf '%s\n' "$AUSGABE" | protokoll
if [ "$RC" -ne 0 ]; then
    FEHLER="apt-get full-upgrade fehlgeschlagen (Code $RC). Einzelheiten im Protokoll."
    schreibe_status false aufruesten false
    trap - EXIT
    exit 1
fi

# Wie viele Pakete es waren — dieselbe Zeile, die der Core auswertet.
ZAHL="$(printf '%s' "$AUSGABE" | sed -n 's/^\([0-9]\+\) upgraded, .*/\1/p' | head -1)"
[ -n "$ZAHL" ] && PAKETE="$ZAHL"

# --- 3. Aufraeumen -----------------------------------------------------------
# autoremove haelt die SD-Karte frei: Alte Kernel sind der groesste Posten, und
# eine volle Karte ist auf diesem Geraet ein realer Ausfallgrund.
# Kein --purge: Es soll nichts entfernen, was jemand konfiguriert hat.
schreibe_status true aufraeumen null
echo "--- apt-get autoremove ---" | protokoll
apt-get "${APT_OPTS[@]}" -y autoremove 2>&1 | protokoll
apt-get clean 2>&1 | protokoll

[ -f /var/run/reboot-required ] && NEUSTART="true"

# --- 4. Erfolg festhalten ----------------------------------------------------
# Eigene Datei, nicht die Statusdatei: Der naechste — womoeglich gescheiterte —
# Lauf ueberschreibt den Status. Wann es zuletzt GEKLAPPT hat, muss das
# ueberleben, sonst steht nach einem Fehlversuch "noch nie aktualisiert" da.
printf '{"zeit":%s,"pakete":%s,"neustartNoetig":%s}\n' \
    "$(date +%s%3N)" "$PAKETE" "$NEUSTART" > "$ERFOLG.tmp" && mv "$ERFOLG.tmp" "$ERFOLG"

schreibe_status false fertig true
trap - EXIT
echo "===== fertig: $PAKETE Paket(e), Neustart noetig: $NEUSTART =====" | protokoll
exit 0
