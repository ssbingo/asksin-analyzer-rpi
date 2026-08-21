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
optional() {  # optional <Beschreibung> <Bedingung> <Hinweis> <Befehl...>
    local titel="$1" pruefung="$2" hinweis="$3"; shift 3
    if ! eval "$pruefung" >/dev/null 2>&1; then
        uebersprungen+=("$titel — $hinweis")
        printf '\n%s== %s ==%s\n  übersprungen — %s\n' \
            "$blau" "$titel" "$aus" "$hinweis"
        return 0
    fi
    lauf "$titel" "$@"
}

lauf "systemd-Units und Grafana-Vorlagen werden ausgerollt" \
    bash tools/pruefe-units.sh

lauf "udev: kein Gerät bekommt zwei Namen" \
    python3 tools/pruefe-udev.py

lauf "Austauschdateien: Core und Helfer meinen denselben Ort" \
    python3 tools/pruefe-austauschdateien.py

lauf "Kindprozesse: jeder benutzte Strom hat einen Fehler-Zuhörer" \
    python3 tools/pruefe-stroeme.py

lauf "HTTP: fetch nur über holen(), damit der Körper gelesen wird" \
    python3 tools/pruefe-fetch.py

lauf "Empfang: Liste und Diagramm bewerten gleich" \
    python3 tools/pruefe-rssi-stufen.py

lauf "Grafana-Vorlagen: jede Ansicht ist im Handbuch erklärt" \
    python3 tools/pruefe-dashboards.py

lauf "Grafana-Vorlagen: kein Dashboard ueberfaehrt die Datenbank" \
    python3 tools/pruefe-dashboard-last.py

lauf "Grafana-Abfragen: hineinschiebbar statt contains()" \
    python3 tools/pruefe-flux-pushdown.py

lauf "Grafana-Abfragen: uebersetzbar (kein '#' in Flux)" \
    python3 tools/pruefe-flux-syntax.py

lauf "Alarmabfragen: wide series statt long" \
    python3 tools/pruefe-alarm-form.py

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
    "PDF bauen mit: bash docs/handbuch/build.sh" \
    python3 docs/handbuch/pruefe_fusssteg.py

# Anklickbar oder gar nicht. Ein Handbuch, dessen Inhaltsverzeichnis nicht
# springt und dessen Fußzeile nicht zum Inhalt zurückführt, ist beim Benutzen
# unbrauchbar — und beim Ansehen fällt genau das nicht auf. Gilt für JEDES
# Handbuch des Projekts, auch für die der laufenden Vorhaben unter projekt/.
optional "Handbücher: Inhaltsverzeichnis und Rücksprung sind anklickbar" \
    "python3 -c 'import pypdf'" \
    "pypdf fehlt (pip install pypdf) — beim Bauen eines Handbuchs läuft die Prüfung ohnehin" \
    python3 tools/pruefe-sprungmarken.py

lauf "Handbuch: Nummerierung und Sprungmarken" \
    python3 docs/handbuch/pruefe_nummerierung.py

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
