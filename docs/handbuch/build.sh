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

chromium --headless=new --disable-gpu --no-pdf-header-footer \
  --generate-pdf-document-outline \
  --print-to-pdf=AskSin-Analyzer-Handbuch.pdf \
  "file://$PWD/handbuch.html"
pdfinfo AskSin-Analyzer-Handbuch.pdf | grep -E "Pages|Page size"
