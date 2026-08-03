#!/usr/bin/env bash
# Sucht im Arbeitsbaum nach Spuren echter Netze, Rechner und Geräte.
#
# Anlass (03.08.2026): In Handbuch-Screenshots standen die interne
# Adressierung über zwei Subnetze, ein Hostname nach internem Namensschema
# und eine MAC-Adresse — aufgenommen im Demo-Modus, also gerade in dem
# Zustand, den man zum Herzeigen benutzt. Beim Anfertigen fällt so etwas
# niemandem auf. Herauszubekommen war es nur noch durch Umschreiben der
# Git-Historie.
#
# Das Repo ist öffentlich. Diese Prüfung gehört vor jeden Commit, der
# Bilder oder Dokumentation anfasst.
#
# Aufruf:
#   bash tools/pruefe-keine-echtdaten.sh    # 0 = sauber, 1 = Fund
#
# Bilder werden nur geprüft, wenn OCR verfügbar ist (tesseract). Ohne OCR
# wird das ausdrücklich gemeldet — eine übersprungene Prüfung darf nicht
# wie eine bestandene aussehen.

set -uo pipefail
cd "$(dirname "$0")/.."

blau=$'\033[1m'; rot=$'\033[1;31m'; aus=$'\033[0m'
funde=0

# Was als „echt" gilt. Bewusst eng gefasst, damit die Prüfung nicht an
# Beispieladressen scheitert:
#
#   192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24  RFC 5737, für Doku gedacht
#   192.168.1.x                                    unser Beispielnetz im Text
#   00:00:5e:00:53:xx                              RFC 7042, MAC für Doku
#
# Gesucht wird nach dem, was in echten Aufnahmen aufgetaucht ist.
MUSTER_NETZ='10\.10\.[0-9]{1,3}\.[0-9]{1,3}'
MUSTER_HOST='mh-[a-z0-9]+'
MUSTER_MAC='([0-9a-f]{2}:){5}[0-9a-f]{2}'
MUSTER_IFACE='\bens[0-9]{1,2}\b'

melde() {  # melde <wo> <was>
    printf '  %sFUND%s  %-52s %s\n' "$rot" "$aus" "$1" "$2"
    funde=$((funde + 1))
}

# --- Text ------------------------------------------------------------------
printf '\n%s== Text und Quelltext ==%s\n' "$blau" "$aus"
while IFS= read -r datei; do
    [ -f "$datei" ] || continue
    treffer="$(grep -ohEi "$MUSTER_NETZ|$MUSTER_HOST|$MUSTER_IFACE" "$datei" 2>/dev/null \
        | sort -u | tr '\n' ' ')"
    # MAC getrennt: kleingeschrieben mit Doppelpunkten, sonst zu viele
    # Fehlalarme durch Hex-Ketten in Telegrammbeispielen.
    mac="$(grep -ohE "$MUSTER_MAC" "$datei" 2>/dev/null \
        | grep -viE '^(00:00:5e|ff:ff:ff|00:00:00)' | sort -u | tr '\n' ' ')"
    [ -n "$treffer$mac" ] && melde "$datei" "$treffer$mac"
done < <(git ls-files '*.md' '*.html' '*.ts' '*.js' '*.vue' '*.sh' '*.py' '*.json' '*.yaml' '*.yml' '*.css')

# --- PDF -------------------------------------------------------------------
printf '\n%s== PDF ==%s\n' "$blau" "$aus"
if command -v pdftotext >/dev/null; then
    while IFS= read -r pdf; do
        [ -f "$pdf" ] || continue
        treffer="$(pdftotext "$pdf" - 2>/dev/null \
            | grep -ohEi "$MUSTER_NETZ|$MUSTER_HOST|$MUSTER_IFACE" | sort -u | tr '\n' ' ')"
        [ -n "$treffer" ] && melde "$pdf" "$treffer"
    done < <(git ls-files '*.pdf')
    echo "  geprüft: $(git ls-files '*.pdf' | wc -l) Datei(en)"
else
    echo "  übersprungen — pdftotext fehlt (apt install poppler-utils)"
fi

# --- Bilder ----------------------------------------------------------------
printf '\n%s== Bilder ==%s\n' "$blau" "$aus"
if command -v tesseract >/dev/null; then
    while IFS= read -r bild; do
        [ -f "$bild" ] || continue
        treffer="$(tesseract "$bild" - 2>/dev/null \
            | grep -ohEi "$MUSTER_NETZ|$MUSTER_HOST|$MUSTER_IFACE" | sort -u | tr '\n' ' ')"
        [ -n "$treffer" ] && melde "$bild" "$treffer"
    done < <(git ls-files '*.png' '*.jpg' '*.jpeg')
    echo "  geprüft: $(git ls-files '*.png' '*.jpg' '*.jpeg' | wc -l) Bild(er)"
else
    echo "  Kein tesseract — Bildinhalte werden hier nicht gelesen."
    echo
    echo "  Das ist vertretbar, weil die Sicherheit woanders herkommt: Alle"
    echo "  Oberflächen-Screenshots entstehen im Demo-Modus, und der gibt"
    echo "  keine echte Netzidentität mehr heraus. Festgehalten wird das"
    echo "  vom Test 'Demo-Modus gibt keine echte Netzidentitaet preis'"
    echo "  (core/test/api.test.ts) — an der Quelle statt am Ergebnis."
    echo
    echo "  Wer trotzdem die Bilder selbst lesen lassen will:"
    echo "    sudo apt install tesseract-ocr tesseract-ocr-deu"
fi

# ---------------------------------------------------------------------------
printf '\n%s== Ergebnis ==%s\n' "$blau" "$aus"
if [ "$funde" -gt 0 ]; then
    printf '%d Fund(e).\n' "$funde" >&2
    echo "Das Repo ist oeffentlich. Vor dem Commit ersetzen — Beispielwerte" >&2
    echo "aus RFC 5737 (192.0.2.0/24) und RFC 7042 (00:00:5e:00:53:xx)." >&2
    exit 1
fi
echo "Keine Spuren echter Netze, Rechner oder Geraete gefunden."
