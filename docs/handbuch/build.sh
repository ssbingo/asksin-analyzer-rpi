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

chromium --headless=new --disable-gpu --no-pdf-header-footer \
  --generate-pdf-document-outline \
  --print-to-pdf=AskSin-Analyzer-Handbuch.pdf \
  "file://$PWD/handbuch.html"
pdfinfo AskSin-Analyzer-Handbuch.pdf | grep -E "Pages|Page size"
