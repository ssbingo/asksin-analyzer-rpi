#!/usr/bin/env bash
# Baut das Zigbee-Handbuch aus handbuch.html.
#
# Gebaut wird mit WeasyPrint, wie beim grossen Handbuch — aus demselben
# Grund: Es beherrscht CSS-Seitenraender. Dieses Buch nutzt sie sogar
# richtig (@bottom-left/-center/-right) statt eines fest positionierten
# Fussstegs. Damit KANN die Fusszeile keinen Text verdecken, und die
# Pruefung, die das grosse Handbuch dafuer braucht, eruebrigt sich hier.
#
# Die Umgebung liegt neben diesem Skript. Kein Systempaket, kein sudo:
# Pango und Cairo bringt jedes Desktop-Debian ohnehin mit.
#
# Aufruf:
#   bash projekt/zigbee-integration/handbuch/build.sh
set -euo pipefail
cd "$(dirname "$0")"

UMGEBUNG="$PWD/.venv"
if [ ! -x "$UMGEBUNG/bin/weasyprint" ]; then
  echo "==> Richte WeasyPrint ein (einmalig)..."
  python3 -m venv "$UMGEBUNG"
  "$UMGEBUNG/bin/pip" install --quiet --upgrade pip
  "$UMGEBUNG/bin/pip" install --quiet weasyprint pypdf \
    || { echo "WeasyPrint liess sich nicht einrichten (Netz?)." >&2; exit 1; }
fi
# pypdf kam spaeter dazu — bei einer schon vorhandenen Umgebung nachziehen.
"$UMGEBUNG/bin/python" -c "import pypdf" 2>/dev/null \
  || "$UMGEBUNG/bin/pip" install --quiet pypdf

"$UMGEBUNG/bin/weasyprint" handbuch.html Zigbee-Mithoerer-Handbuch.pdf \
  2>&1 | grep -vE "print-color-adjust|overflow-x" || true

if command -v pdfinfo >/dev/null; then
  pdfinfo Zigbee-Mithoerer-Handbuch.pdf | grep -E "Pages|Page size"
fi

# Anklickbar oder gar nicht. Ein Handbuch, dessen Inhaltsverzeichnis nicht
# springt und dessen Fusszeile nicht zurueckfuehrt, ist beim Benutzen
# unbrauchbar — und beim Ansehen faellt genau das nicht auf. Deshalb wird es
# bei JEDEM Bau am fertigen PDF nachgemessen, nicht am Quelltext.
"$UMGEBUNG/bin/python" ../../../tools/pruefe-sprungmarken.py \
    Zigbee-Mithoerer-Handbuch.pdf

echo "Fertig: $PWD/Zigbee-Mithoerer-Handbuch.pdf"
