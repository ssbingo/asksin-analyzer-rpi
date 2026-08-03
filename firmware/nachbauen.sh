#!/usr/bin/env bash
# Baut die mitgelieferte HEX-Datei nach und prüft sie gegen ihre Prüfsumme.
#
# Warum es dieses Skript gibt
# ---------------------------
# Eine mitgelieferte Binärdatei ist eine Zumutung, solange niemand nachprüfen
# kann, was drinsteckt. Man muss demjenigen glauben, der sie hochgeladen hat.
# Bei Software, die dauerhaft auf fremden Geräten läuft, ist das zu wenig.
#
# Der Anlass war handfester: Die Datei ließ sich zunächst NICHT nachbauen.
# Drei plausible Versuche ergaben 7416, 7490 und 7734 Byte gegen 6922 der
# Auslieferung. Die Ursache war eine einzige Menüzeile — Compiler LTO —, die
# in keiner Anleitung stand. Mit ihr stimmt die Datei bis aufs Byte.
#
# Genau davor schützt dieses Skript: Es hält jede Fassung fest, statt sich auf
# eine Beschreibung zu verlassen, die man beim Abschreiben verkürzt.
#
# Beleg (03.08.2026): Arduino IDE 2.3.10 unter Windows und arduino-cli 1.5.1
# unter Linux ergeben dieselbe Datei. Der Bau ist also nicht an ein System
# gebunden.
#
# Aufruf
# ------
#   bash firmware/nachbauen.sh
#
# Beim ersten Mal lädt es rund 200 MB (AVR-Werkzeugkette). Danach liegt alles
# im Zwischenspeicher und ein Durchlauf dauert Sekunden.
#
#   ASKSIN_FW_CACHE=/pfad   eigener Zwischenspeicher (Vorgabe: ~/.cache/…)
#
# Rückgabewert: 0 = Prüfsumme stimmt, 1 = weicht ab oder Bau fehlgeschlagen.

set -euo pipefail
cd "$(dirname "$0")/.."
WURZEL="$PWD"

# --- Alles, was den Bau bestimmt. Eine Zeile ändern heißt: andere Datei. ----
CLI_VERSION="1.5.1"
CORE="MiniCore:avr@3.1.2"
MINICORE_INDEX="https://mcudude.github.io/MiniCore/package_MCUdude_MiniCore_index.json"

# Fassungen ohne "@" nagelt der Bibliotheksverwalter nicht fest — deshalb
# stehen sie hier ausgeschrieben. AskSinPP ist die Bibliothek, die den Inhalt
# bestimmt; die beiden anderen liefern nur Hilfsfunktionen.
declare -a LIBS=(
    "AskSinPP@5.0.3"
    "EnableInterrupt@1.1.0"
    "Low-Power@1.81.0"
)

# LTO=Os_flto ist die Menüzeile aus der Vorgeschichte. Ohne sie: 7750 Byte.
FQBN="MiniCore:avr:328:variant=modelP,bootloader=uart0,clock=8MHz_external,BOD=2v7,eeprom=keep,LTO=Os_flto"

SKETCH="$WURZEL/reference/AskSinAnalyzer/AskSinSniffer328P"
ZIEL="$WURZEL/firmware/asksin-sniffer-20260803-8mhz.hex"
ERWARTET="064de4add8a84c79d2835120f5ac1b3ee4f250fc5c039ed44c937484ef0848c8"

CACHE="${ASKSIN_FW_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/asksin-firmware}"

# ---------------------------------------------------------------------------
meldung() { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }
abbruch() { printf '\n\033[1;31mAbbruch:\033[0m %s\n' "$1" >&2; exit 1; }

[ -f "$SKETCH/AskSinSniffer328P.ino" ] || abbruch \
"Der Quelltext fehlt: $SKETCH/AskSinSniffer328P.ino

Er gehört nicht uns und liegt deshalb nicht im Repo. Holen mit:
  git clone --depth 1 https://github.com/jp112sdl/AskSinAnalyzer \\
      reference/AskSinAnalyzer"

command -v curl >/dev/null || abbruch "curl wird gebraucht."
command -v sha256sum >/dev/null || abbruch "sha256sum wird gebraucht."

mkdir -p "$CACHE"
export ARDUINO_DIRECTORIES_DATA="$CACHE/data"
export ARDUINO_DIRECTORIES_USER="$CACHE/user"
export ARDUINO_DIRECTORIES_DOWNLOADS="$CACHE/dl"
CLI="$CACHE/arduino-cli"

# --- 1. arduino-cli --------------------------------------------------------
# Bewusst ein eigenes Exemplar im Zwischenspeicher: Eine im System
# installierte Fassung wäre irgendeine, und "irgendeine" ist genau das, was
# hier nicht sein darf.
if [ ! -x "$CLI" ] || ! "$CLI" version 2>/dev/null | grep -q "$CLI_VERSION"; then
    meldung "arduino-cli $CLI_VERSION holen"
    case "$(uname -m)" in
        x86_64)          BOGEN="64bit" ;;
        aarch64|arm64)   BOGEN="ARM64" ;;
        armv7l|armv6l)   BOGEN="ARMv7" ;;
        *) abbruch "Unbekannte Architektur: $(uname -m)" ;;
    esac
    URL="https://github.com/arduino/arduino-cli/releases/download/v${CLI_VERSION}/arduino-cli_${CLI_VERSION}_Linux_${BOGEN}.tar.gz"
    curl -sfL --max-time 300 "$URL" | tar -xz -C "$CACHE" arduino-cli \
        || abbruch "Download fehlgeschlagen: $URL"
    chmod +x "$CLI"
fi
"$CLI" version

# --- 2. Board-Paket --------------------------------------------------------
if ! "$CLI" core list 2>/dev/null | grep -q "MiniCore:avr *3.1.2"; then
    meldung "$CORE einrichten (beim ersten Mal rund 200 MB)"
    "$CLI" config init --overwrite >/dev/null
    "$CLI" config add board_manager.additional_urls "$MINICORE_INDEX"
    "$CLI" core update-index >/dev/null 2>&1
    "$CLI" core install "$CORE" 2>&1 | grep -vE "^\S+ .*/.*(B|KiB|MiB) " || true
fi

# --- 3. Bibliotheken -------------------------------------------------------
meldung "Bibliotheken"
FEHLT=0
for lib in "${LIBS[@]}"; do
    name="${lib%@*}"; fassung="${lib#*@}"
    # "1.81.0" meldet der Verwalter als "1.81" zurück — deshalb der Vergleich
    # auf die führenden Stellen statt auf die Zeichenkette.
    if "$CLI" lib list 2>/dev/null \
        | awk -v n="$name" '$1==n {print $2}' \
        | grep -q "^${fassung%.0}\(\.0\)\?$"; then
        printf '  vorhanden  %s\n' "$lib"
        continue
    fi
    "$CLI" lib update-index >/dev/null 2>&1
    "$CLI" lib install "$lib" >/dev/null 2>&1 || FEHLT=1
    printf '  installiert %s\n' "$lib"
done
[ "$FEHLT" -eq 0 ] || abbruch "Mindestens eine Bibliothek ließ sich nicht in der geforderten Fassung installieren."
"$CLI" lib list

# --- 4. Bauen --------------------------------------------------------------
meldung "Übersetzen"
AUS="$CACHE/out"
rm -rf "$AUS"
"$CLI" compile --fqbn "$FQBN" --output-dir "$AUS" "$SKETCH" 2>&1 \
    | grep -E "verwendet|uses|error" || abbruch "Übersetzen fehlgeschlagen."

GEBAUT="$AUS/AskSinSniffer328P.ino.hex"
[ -f "$GEBAUT" ] || abbruch "Keine HEX-Datei entstanden."

# --- 5. Vergleichen --------------------------------------------------------
meldung "Vergleich"
IST="$(sha256sum "$GEBAUT" | cut -d' ' -f1)"
printf '  gebaut       %s\n  erwartet     %s\n' "$IST" "$ERWARTET"

if [ "$IST" != "$ERWARTET" ]; then
    printf '\n\033[1;31mDie Prüfsummen weichen ab.\033[0m\n' >&2
    cat >&2 <<'HINWEIS'

Das heißt nicht zwingend, dass etwas kaputt ist — es heißt, dass sich eine
Zutat geändert hat. Der Reihe nach:

  1. Wurde eine Fassung oben im Skript angehoben? Dann ist die Abweichung
     gewollt, und die Prüfsumme in ERWARTET und in firmware/README.md gehört
     nachgezogen.
  2. Hat sich der Quelltext in reference/ geändert? (git -C reference status)
  3. Alles unverändert? Dann ist es ein echter Befund und gehört untersucht,
     bevor die Datei irgendwo aufgespielt wird.

HINWEIS
    exit 1
fi

if [ -f "$ZIEL" ] && ! cmp -s "$GEBAUT" "$ZIEL"; then
    abbruch "Prüfsumme stimmt, aber die Dateien unterscheiden sich — das darf nicht sein."
fi

printf '\n\033[1;32mNachgebaut und identisch.\033[0m\n'
printf 'Die mitgelieferte Datei entspricht genau diesem Quelltext mit diesen Fassungen.\n'
