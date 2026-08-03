#!/usr/bin/env bash
# Führt alle maschinellen Prüfungen des Projekts aus — einen Aufruf, alles.
#
# Anlass: Die Prüfungen sind einzeln entstanden, jede aus einem konkreten
# Fehler heraus, und lagen danach an vier verschiedenen Stellen. Genau so
# geht eine davon verloren: Wer sie nicht auswendig kennt, ruft sie nicht auf,
# und ein Skript, das niemand aufruft, prüft nichts.
#
# Das ist keine erfundene Sorge. Die Grafana-Vorlagen wurden wochenlang nicht
# ausgerollt, obwohl pruefe-units.sh das gemeldet hätte — es lief nur nie.
#
# Aufruf:
#   bash tools/pruefe-alles.sh     # 0 = alles in Ordnung, 1 = mindestens eine
#                                  #     Prüfung hat etwas beanstandet
#
# Vor jedem Commit, der Doku, Units, Grafana-Vorlagen oder Firmware berührt.

set -uo pipefail
cd "$(dirname "$0")/.."

blau=$'\033[1m'; aus=$'\033[0m'
durchgefallen=()
uebersprungen=()

lauf() {  # lauf <Beschreibung> <Befehl...>
    local titel="$1"; shift
    printf '\n%s== %s ==%s\n' "$blau" "$titel" "$aus"
    if "$@"; then
        return 0
    fi
    durchgefallen+=("$titel")
    return 1
}

# Prüfungen, die zusätzliche Software brauchen, werden übersprungen statt zu
# scheitern — sonst bleibt bei fehlendem WeasyPrint der ganze Durchlauf rot
# und man gewöhnt sich an ein rotes Ergebnis. Daran gewöhnt man sich schnell.
optional() {  # optional <Beschreibung> <Bedingung> <Befehl...>
    local titel="$1" pruefung="$2"; shift 2
    if ! eval "$pruefung" >/dev/null 2>&1; then
        uebersprungen+=("$titel")
        printf '\n%s== %s ==%s\n  übersprungen (nicht installiert)\n' \
            "$blau" "$titel" "$aus"
        return 0
    fi
    lauf "$titel" "$@"
}

lauf "systemd-Units und Grafana-Vorlagen werden ausgerollt" \
    bash tools/pruefe-units.sh

lauf "Firmware: FQBN in der Dokumentation" \
    python3 firmware/pruefe-fqbn.py

for hex in firmware/*.hex; do
    [ -e "$hex" ] || continue
    lauf "Firmware: $(basename "$hex")" python3 firmware/pruefe-hex.py "$hex"
done

optional "Handbuch: Fußsteg verdeckt keinen Text" \
    "[ -f docs/handbuch/AskSin-Analyzer-Handbuch.pdf ] && command -v pdftotext" \
    python3 docs/handbuch/pruefe_fusssteg.py

lauf "Handbuch: Nummerierung und Sprungmarken" \
    python3 docs/handbuch/pruefe_nummerierung.py

# ---------------------------------------------------------------------------
printf '\n%s== Ergebnis ==%s\n' "$blau" "$aus"

if [ "${#uebersprungen[@]}" -gt 0 ]; then
    printf 'Übersprungen: %s\n' "${uebersprungen[*]}"
    echo "  (Handbuch-PDF fehlt? bash docs/handbuch/build.sh)"
fi

if [ "${#durchgefallen[@]}" -gt 0 ]; then
    printf '\n%d Prüfung(en) mit Beanstandung:\n' "${#durchgefallen[@]}" >&2
    printf '  - %s\n' "${durchgefallen[@]}" >&2
    exit 1
fi

echo "Alle Prüfungen bestanden."
