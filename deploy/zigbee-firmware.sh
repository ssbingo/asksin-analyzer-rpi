#!/usr/bin/env bash
# Spielt die Mithoer-Firmware auf den Zigbee-Stick — auf dem Pi, ohne Browser.
#
# Anlass: Der Weg ueber den Web-Flasher scheitert beim ZBDongle-E regelmaessig
# mit "Failed to probe running application type". Der Browser hat die
# Steuerleitungen RTS/DTR nicht in der Hand und kann den Stick deshalb nicht in
# den Bootloader zwingen; er muss die laufende Firmware erkennen, und genau das
# geht schief. Auf dem Pi entfaellt dieser Schritt vollstaendig.
#
# Aufrufwege:
#   sudo bash zigbee-firmware.sh --pruefen    # nur nachsehen, nichts aendern
#   sudo bash zigbee-firmware.sh              # aufspielen
#   sudo bash zigbee-firmware.sh --status     # letzten Lauf ausgeben
#   ueber die Weboberflaeche:                 # analyzerd legt die Ausloeserdatei
#                                             # an, die Path-Unit startet dies
#
# ## Die Gefahr, um die es hier geht
#
# Ein umgespielter Stick ist KEIN Zigbee-Koordinator mehr. Wer den falschen
# erwischt, legt sein ganzes Zigbee-Netz still. Deshalb faehrt dieses Skript
# einen engen Kurs:
#
#   * Es nimmt ausschliesslich Sticks, die sich als Sonoff/Itead melden.
#   * Es weigert sich, wenn mehr als einer dasteht — dann ist nicht
#     entscheidbar, welcher gemeint ist, und Raten waere hier teuer.
#   * Es fasst /dev/asksin-hat nie an, auch nicht mittelbar.
#   * Es prueft vorher, ob die Mithoer-Firmware schon drauf ist, und tut in
#     dem Fall nichts.
#
# Die Firmware wird zur Laufzeit geholt und NICHT mitgeliefert: Sie hat eigene
# Nutzungsbedingungen (Leitentscheidung E7 im Projektplan).

set -uo pipefail

DATEN_DIR="${DATEN_DIR:-/var/lib/asksin-analyzer}"
STATUS_DATEI="$DATEN_DIR/zigbee-firmware-status.json"
ANSTOSS="$DATEN_DIR/zigbee-firmware-anstoss"
LOG_DATEI="$DATEN_DIR/zigbee-firmware.log"
# Bewusst im Datenverzeichnis und NICHT unter /opt/asksin-analyzer: Dort
# liegt das Git-Arbeitsverzeichnis, und update.sh holt den neuen Stand mit
# "git reset --hard". Eine Python-Umgebung daneben waere entweder staendig
# als unversionierter Ballast sichtbar oder eines Tages weg.
FLASHER_DIR="${FLASHER_DIR:-/var/lib/asksin-analyzer/flasher}"
DIENST="asksin-analyzer.service"

# Bezugsquelle der Mithoer-Firmware. Steht als Variable hier oben, damit ein
# Wechsel der Quelle eine Zeile ist und keine Suche.
FIRMWARE_URL="${FIRMWARE_URL:-https://raw.githubusercontent.com/ErkSponge/Sniffer_802.15.4_SONOFF_USB_Dongle_Plus_E/main/Output/Sniffer_802.15.4_SONOFF_USB_Dongle_Plus_E/Sniffer_802.15.4_SONOFF_USB_Dongle_Plus_E.gbl}"

# Kleinste plausible Groesse. Die echte Datei ist rund 40 kB; kommt eine
# Fehlerseite statt der Firmware, sind es ein paar hundert Byte HTML — und die
# wuerde der Flasher als "Firmware" annehmen.
MINDESTGROESSE=10000

c_info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
c_ok()   { printf '\033[1;32m  ok\033[0m %s\n' "$*"; }
c_warn() { printf '\033[1;33m  !!\033[0m %s\n' "$*"; }
c_err()  { printf '\033[1;31mFEHLER:\033[0m %s\n' "$*" >&2; }

json_escape() { printf '%s' "${1//\"/\\\"}" | tr -d '\n'; }

schreibe_status() {  # schreibe_status <laeuft> <schritt> <ok|null|true|false> <text>
    mkdir -p "$DATEN_DIR"
    printf '{"laeuft":%s,"schritt":"%s","ok":%s,"text":"%s","stand":%s}\n' \
        "$1" "$(json_escape "$2")" "$3" "$(json_escape "${4:-}")" "$(date +%s%3N)" \
        > "$STATUS_DATEI.tmp" && mv "$STATUS_DATEI.tmp" "$STATUS_DATEI"
}

if [ "${1:-}" = "--status" ]; then
    cat "$STATUS_DATEI" 2>/dev/null || echo '{"laeuft":false,"schritt":"nie gelaufen","ok":null}'
    exit 0
fi

if [ "$(id -u)" -ne 0 ]; then
    c_err 'Bitte mit Root-Rechten ausfuehren (sudo).'
    exit 1
fi

# ---------------------------------------------------------------------------
# Den Stick finden — und nur ihn.
# ---------------------------------------------------------------------------

# Ausgabe: die by-id-Pfade aller Sticks, die sich als Sonoff/Itead melden.
# Bewusst ueber by-id und nicht ueber /dev/ttyUSB*: Dort stuende auch jedes
# andere serielle Geraet, und ein falscher Treffer waere hier teuer.
kandidaten() {
    local d
    for d in /dev/serial/by-id/*; do
        [ -e "$d" ] || continue
        case "$(basename "$d")" in
            *Sonoff_Zigbee*|*sonoff_zigbee*) printf '%s\n' "$d" ;;
        esac
    done
}

# Haelt schon jemand den Anschluss offen? 0 = ja.
#
# Wichtig fuer --pruefen im laufenden Betrieb: Wer den Anschluss aufmacht,
# waehrend der Analyzer daran lauscht, nimmt ihm die Bytes weg. Die Probe
# unten darf deshalb nur laufen, wenn niemand sonst liest.
#
# Ohne fuser/lsof — beide sind auf einem schlanken Raspberry-OS nicht
# selbstverstaendlich. /proc kennt die Wahrheit ohnehin.
belegt() {  # belegt <geraet>
    local echt fd
    echt="$(readlink -f "$1")" || return 1
    for fd in /proc/[0-9]*/fd/*; do
        [ -e "$fd" ] || continue
        [ "$(readlink -f "$fd" 2>/dev/null)" = "$echt" ] && return 0
    done
    return 1
}

# Antwortet der Stick mit Mithoer-Zeilen? 0 = ja, 1 = nein.
#
# Die Probe ist zugleich die ehrlichste Aussage darueber, ob die Firmware schon
# sitzt: Die Mithoer-Firmware gibt auf 1 MBaud Zeilen aus, die mit {"L": be-
# ginnen. Die Koordinator-Firmware tut das nicht.
hoert_mit() {  # hoert_mit <geraet>
    local dev="$1" ausgabe
    stty -F "$dev" 1000000 raw -echo -hupcl 2>/dev/null || return 1
    # Kanal setzen und lauschen ueber DIESELBE offene Verbindung: Zwei
    # getrennte Oeffnungen wuerden den Stick dazwischen neu starten.
    ausgabe="$(timeout 6 bash -c '
        exec 3<>"$1"
        printf "{\"C\":11}\n" >&3
        timeout 5 head -c 400 <&3
    ' _ "$dev" 2>/dev/null)"
    case "$ausgabe" in *'{"L":'*) return 0 ;; esac
    return 1
}

WERKZEUG="$FLASHER_DIR/bin/universal-silabs-flasher"

bericht() {  # bericht <als-json>
    local liste anzahl geraet zustand
    liste="$(kandidaten)"
    anzahl="$(printf '%s' "$liste" | grep -c . || true)"
    geraet="$(printf '%s\n' "$liste" | head -1)"
    if [ "$anzahl" -eq 0 ]; then
        zustand="kein-stick"
    elif [ "$anzahl" -gt 1 ]; then
        zustand="mehrdeutig"
    elif belegt "$geraet"; then
        # Der Analyzer lauscht gerade selbst. Was der Stick kann, sagt dann
        # die Zigbee-Seite besser als eine Probe, die ihm Bytes wegnimmt.
        zustand="belegt"
    elif hoert_mit "$geraet"; then
        zustand="mithoerer"
    else
        zustand="fremde-firmware"
    fi
    if [ "$1" = "json" ]; then
        printf '{"zustand":"%s","anzahl":%s,"geraet":"%s","werkzeug":%s}\n' \
            "$zustand" "$anzahl" "$(json_escape "${geraet:-}")" \
            "$([ -x "$WERKZEUG" ] && echo true || echo false)"
    else
        printf '%s\n' "$zustand"
    fi
}

if [ "${1:-}" = "--pruefen" ]; then
    bericht json
    exit 0
fi

# ---------------------------------------------------------------------------
# Aufspielen
# ---------------------------------------------------------------------------

# Im Hintergrundmodus (Ausloesung ueber die Weboberflaeche) alles ins Log.
if [ "${1:-}" = "--hintergrund" ]; then
    exec >>"$LOG_DATEI" 2>&1
    echo "===== Zigbee-Firmware: $(date -Is) ====="
fi

aufraeumen() { rm -f "$ANSTOSS"; }
trap aufraeumen EXIT

abbruch() {  # abbruch <schritt> <text>
    c_err "$2"
    schreibe_status false "$1" false "$2"
    exit 1
}

schreibe_status true "pruefen" null "Stick suchen"
c_info 'Zigbee-Stick suchen...'

LISTE="$(kandidaten)"
ANZAHL="$(printf '%s' "$LISTE" | grep -c . || true)"

if [ "$ANZAHL" -eq 0 ]; then
    abbruch "pruefen" "Kein SONOFF-Zigbee-Stick gefunden. Steckt er, und ist es ein ZBDongle-E?"
fi
if [ "$ANZAHL" -gt 1 ]; then
    # Hier wird bewusst NICHT geraten. Zwei Sonoff-Sticks an einem Rechner
    # heisst mit einiger Wahrscheinlichkeit: einer davon ist der Koordinator.
    abbruch "pruefen" \
        "Es stecken $ANZAHL SONOFF-Sticks. Welcher der Mithoerer werden soll, ist von hier aus nicht entscheidbar — bitte den anderen abziehen."
fi

STICK="$LISTE"
c_ok "Gefunden: $(basename "$STICK")"

if hoert_mit "$STICK"; then
    c_ok 'Die Mithoer-Firmware ist bereits aufgespielt — es gibt nichts zu tun.'
    schreibe_status false "fertig" true "Die Mithoer-Firmware war bereits aufgespielt."
    exit 0
fi

c_info 'Der Stick antwortet nicht als Mithoerer — Firmware wird aufgespielt.'

# Werkzeug bereitstellen (einmalig, in eigener Umgebung).
if [ ! -x "$WERKZEUG" ]; then
    schreibe_status true "werkzeug" null "Flash-Werkzeug einrichten"
    c_info 'Flash-Werkzeug einrichten (einmalig)...'
    python3 -m venv "$FLASHER_DIR" \
        || abbruch "werkzeug" "Python-Umgebung liess sich nicht anlegen (python3-venv installiert?)"
    "$FLASHER_DIR/bin/pip" install --quiet --upgrade pip \
        || c_warn 'pip liess sich nicht aktualisieren — weiter mit der vorhandenen Fassung.'
    "$FLASHER_DIR/bin/pip" install --quiet universal-silabs-flasher \
        || abbruch "werkzeug" "universal-silabs-flasher liess sich nicht installieren (Internetverbindung?)"
    c_ok 'Werkzeug eingerichtet.'
fi

# Firmware holen.
schreibe_status true "firmware" null "Firmware herunterladen"
c_info 'Firmware herunterladen...'
GBL="$(mktemp /tmp/zigbee-sniffer.XXXXXX.gbl)"
trap 'rm -f "$GBL"; aufraeumen' EXIT
curl -fsSL -o "$GBL" "$FIRMWARE_URL" \
    || abbruch "firmware" "Firmware liess sich nicht herunterladen. Internetverbindung? Quelle: $FIRMWARE_URL"
GROESSE="$(stat -c %s "$GBL" 2>/dev/null || echo 0)"
if [ "$GROESSE" -lt "$MINDESTGROESSE" ]; then
    abbruch "firmware" \
        "Die heruntergeladene Datei ist nur $GROESSE Byte gross — das ist keine Firmware, sondern vermutlich eine Fehlerseite."
fi
c_ok "Firmware geladen ($GROESSE Byte)."

# Den Dienst anhalten: Laeuft der Mithoerer, haelt er den Anschluss offen, und
# der Flasher kaeme nicht heran. Er wird am Ende wieder gestartet, auch wenn
# das Aufspielen scheitert.
DIENST_LIEF=0
if systemctl is-active --quiet "$DIENST"; then
    DIENST_LIEF=1
    c_info 'Analyzer-Dienst anhalten...'
    systemctl stop "$DIENST"
fi
dienst_zurueck() {
    if [ "$DIENST_LIEF" -eq 1 ]; then
        c_info 'Analyzer-Dienst wieder starten...'
        systemctl start "$DIENST" || c_warn 'Der Dienst liess sich nicht starten — bitte nachsehen.'
    fi
}
trap 'dienst_zurueck; rm -f "$GBL"; aufraeumen' EXIT

schreibe_status true "aufspielen" null "Firmware aufspielen"
c_info 'Firmware aufspielen (dauert weniger als eine Minute)...'
if ! "$WERKZEUG" --device "$STICK" --bootloader-reset rts_dtr \
        flash --firmware "$GBL"; then
    abbruch "aufspielen" \
        "Das Aufspielen ist fehlgeschlagen. Der Stick ist dadurch nicht kaputt — meist hilft: abziehen, wieder anstecken, erneut versuchen."
fi
c_ok 'Aufgespielt.'

# Nachsehen, ob es gewirkt hat. Der Stick braucht nach dem Aufspielen einen
# Moment, bis er sich neu am USB gemeldet hat.
schreibe_status true "nachsehen" null "Ergebnis pruefen"
c_info 'Nachsehen, ob Zeilen herauskommen...'
ERFOLG=0
for _ in 1 2 3 4 5 6 7 8 9 10; do
    sleep 2
    STICK_NEU="$(kandidaten | head -1)"
    [ -n "$STICK_NEU" ] || continue
    if hoert_mit "$STICK_NEU"; then ERFOLG=1; STICK="$STICK_NEU"; break; fi
done

if [ "$ERFOLG" -eq 1 ]; then
    c_ok 'Der Stick liefert Mithoer-Zeilen. Fertig.'
    schreibe_status false "fertig" true "Die Mithoer-Firmware ist aufgespielt und der Stick antwortet."
    exit 0
fi

# Aufgespielt, aber keine Zeilen: Das ist keine Erfolgsmeldung. Haeufigster
# Grund ist, dass der Stick nach dem Aufspielen einmal stromlos werden muss.
c_warn 'Aufgespielt, aber es kommen noch keine Zeilen.'
schreibe_status false "fertig" false \
    "Die Firmware wurde aufgespielt, aber der Stick antwortet noch nicht. Bitte einmal abziehen und wieder anstecken — danach erneut pruefen."
exit 1
