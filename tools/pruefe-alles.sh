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
        uebersprungen+=("$titel — PDF bauen mit: bash docs/handbuch/build.sh")
        printf '\n%s== %s ==%s\n  übersprungen (PDF oder pdftotext fehlt)\n' \
            "$blau" "$titel" "$aus"
        return 0
    fi
    lauf "$titel" "$@"
}

lauf "systemd-Units und Grafana-Vorlagen werden ausgerollt" \
    bash tools/pruefe-units.sh

lauf "Keine Spuren echter Netze und Rechner" \
    bash tools/pruefe-keine-echtdaten.sh

lauf "Erzeugnisse jünger als ihre Quellen" \
    python3 tools/pruefe-erzeugnisse.py

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

# Der Nachbau der Firmware braucht Netz und beim ersten Mal rund 200 MB.
# Deshalb läuft er nur auf Verlangen — eine Prüfung, die jeden Durchlauf
# minutenlang aufhält, wird sonst bald mit --skip umgangen, und dann ist sie
# weg. Vor jedem Release gehört sie aber gelaufen:
#   ASKSIN_NACHBAU=1 bash tools/pruefe-alles.sh
if [ "${ASKSIN_NACHBAU:-0}" = "1" ]; then
    lauf "Firmware: Nachbau stimmt mit der Auslieferung überein" \
        bash firmware/nachbauen.sh
else
    uebersprungen+=("Firmware-Nachbau (ASKSIN_NACHBAU=1 zum Ausführen)")
fi

# ---------------------------------------------------------------------------
printf '\n%s== Ergebnis ==%s\n' "$blau" "$aus"

if [ "${#uebersprungen[@]}" -gt 0 ]; then
    echo "Übersprungen:"
    printf '  - %s\n' "${uebersprungen[@]}"
fi

if [ "${#durchgefallen[@]}" -gt 0 ]; then
    printf '\n%d Prüfung(en) mit Beanstandung:\n' "${#durchgefallen[@]}" >&2
    printf '  - %s\n' "${durchgefallen[@]}" >&2
    exit 1
fi

echo "Alle Prüfungen bestanden."
