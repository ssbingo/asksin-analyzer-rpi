#!/usr/bin/env bash
# Baut das Handbuch-PDF aus handbuch.html.
# Voraussetzungen: chromium (Druck), kicad-cli + pdftoppm (nur zum Erneuern der Bilder).
set -euo pipefail
cd "$(dirname "$0")"

if [[ "${1:-}" == "--bilder" ]]; then
  B=../../hardware/kicad/AskSin-Analyzer-V3.kicad_pcb
  kicad-cli pcb render --output img/platine-oben.png    --side top    --zoom 1.1  --width 1600 --height 760 --quality high "$B"
  kicad-cli pcb render --output img/platine-unten.png   --side bottom --zoom 1.1  --width 1600 --height 760 --quality high "$B"
  kicad-cli pcb render --output img/platine-schraeg.png --side top --rotate "'-35,0,25'" --zoom 0.95 --width 1600 --height 900 --quality high "$B"
  pdftoppm -r 130 -png -f 1 -l 1 ../../hardware/kicad/fab/schaltplan.pdf img/schaltplan
  pdftoppm -r 130 -png -f 1 -l 1 ../../hardware/kicad/fab/layout.pdf img/layout
fi

# Die Nummerierung muss stimmen, bevor gedruckt wird. Kapitel 14 und der
# Anhang trugen einmal die Unternummern von Kapitel 23 — dadurch gab es
# Sprungmarken doppelt, und Verweise landeten im falschen Kapitel. Das faellt
# beim Lesen kaum auf, im PDF aber sofort, sobald jemand klickt.
python3 pruefe_nummerierung.py

# Softwareversion aus der Quelle ziehen, statt sie an drei Stellen im HTML von
# Hand zu pflegen. Genau daher kam die Abweichung: Das Handbuch behauptete
# 0.9.0, waehrend der Core laengst weiter war.
VERSION="$(python3 -c "import json,pathlib; \
    print(json.loads(pathlib.Path('../../core/package.json').read_text())['version'])")"
# Nur Fusssteg, Deckblatt und Kolophon — NICHT jede Erwaehnung. Ein pauschales
# Ersetzen machte aus "Seit Software 0.0.4 flasht der Analyzer selbst" prompt
# eine falsche Aussage: Historische Angaben muessen stehen bleiben.
sed -i -E \
    -e "s/(Handbuch Ausgabe [0-9]+ · Software )[0-9]+\.[0-9]+\.[0-9]+/\1${VERSION}/g" \
    -e "s/(Hardware [0-9]+\.[0-9]+\.[0-9]+ · Software )[0-9]+\.[0-9]+\.[0-9]+/\1${VERSION}/g" \
    -e "s/(· Software )[0-9]+\.[0-9]+\.[0-9]+( · erzeugt aus)/\1${VERSION}\2/g" \
    handbuch.html
echo "Handbuch weist Software ${VERSION} aus."

# Gebaut wird mit WeasyPrint, nicht mit Chromium.
#
# Der Grund ist ein einziger, aber ein harter: Chromium setzt fest
# positionierte Elemente zwingend INNERHALB des Satzspiegels ab. Der Fusssteg
# landete damit im Textbereich und verdeckte Text — auf jeder Seite, an der
# der Text bis unten reichte. Ein negatives `bottom` liess ihn dort auf die
# naechste Seite umlaufen; es gab keinen Weg, ihn in den Seitenrand zu
# bringen. WeasyPrint beherrscht CSS-Seitenraender und kann das.
#
# WeasyPrint kommt aus einer eigenen Umgebung neben diesem Skript. Kein
# Systempaket, kein sudo: Die noetigen Bibliotheken (Pango, Cairo) bringt
# jedes Desktop-Debian ohnehin mit.
UMGEBUNG="$PWD/.venv"
if [ ! -x "$UMGEBUNG/bin/weasyprint" ]; then
  echo "==> Richte WeasyPrint ein (einmalig)..."
  python3 -m venv "$UMGEBUNG"
  "$UMGEBUNG/bin/pip" install --quiet --upgrade pip
  "$UMGEBUNG/bin/pip" install --quiet weasyprint \
    || { echo "WeasyPrint liess sich nicht einrichten." >&2; exit 1; }
fi

"$UMGEBUNG/bin/weasyprint" handbuch.html AskSin-Analyzer-Handbuch.pdf \
  2>&1 | grep -vE "print-color-adjust|overflow-x" || true

pdfinfo AskSin-Analyzer-Handbuch.pdf | grep -E "Pages|Page size"

# Der Fusssteg darf keinen Text verdecken. Das ist keine Kosmetik, sondern
# die Vorgabe, an der die vorige Fassung gescheitert ist — deshalb wird sie
# bei jedem Bau nachgerechnet.
python3 pruefe_fusssteg.py
