#!/usr/bin/env python3
"""Jedes Handbuch-PDF muss anklickbar sein — Inhalt, Kapitel, Rücksprung.

    python3 tools/pruefe-sprungmarken.py [PDF ...]

Ohne Argumente werden alle Handbuch-PDFs des Projekts geprüft.

Warum es diese Prüfung gibt
---------------------------
Am 17.08.2026 kam das Zigbee-Handbuch dazu. Es sah gedruckt tadellos aus:
Inhaltsverzeichnis, Kapitelnummern, Fußzeile. Anklicken konnte man nichts —
kein Sprung vom Inhalt ins Kapitel, kein Rücksprung zum Inhalt. Aufgefallen
ist es erst, weil jemand das PDF benutzt hat statt es anzusehen.

Der Fehler ist besonders heimtückisch, weil er im Quelltext nicht auffällt.
Zwei Fallen, in die man dabei tritt:

  1. `<h2>Kapitel</h2>` ohne `id` — es gibt kein Sprungziel, und ein
     `href="#k3"` zeigt ins Leere. Beim Drucken merkt man davon nichts.
  2. Ein Verweis in einem CSS-Seitenrandbereich (`@bottom-center`).
     WeasyPrint erzeugt dafür KEINE Verweis-Annotation. Der Text steht da,
     unterstrichen und blau, und tut nichts. Für einen Rücksprung auf jeder
     Seite braucht es ein fest positioniertes Element.

Geprüft wird deshalb am fertigen PDF, nicht am HTML — nur dort steht, ob ein
Verweis tatsächlich existiert:

  A. Es gibt überhaupt interne Verweise.
  B. Der Rücksprung steht auf (fast) jeder Seite.
  C. Es gibt Lesezeichen für die Gliederung des PDF-Betrachters.
"""

from __future__ import annotations

import sys
from pathlib import Path

WURZEL = Path(__file__).resolve().parent.parent

# Reihenfolge: das grosse Handbuch zuerst, danach die Bücher der laufenden
# Vorhaben unter projekt/.
STANDARD = [
    WURZEL / "docs/handbuch/AskSin-Analyzer-Handbuch.pdf",
    *sorted(WURZEL.glob("projekt/*/handbuch/*.pdf")),
]

# Deckblatt und moeglicherweise eine Schlussseite duerfen ohne Ruecksprung
# bleiben — auf dem Deckblatt waere er sinnlos.
SEITEN_OHNE_ERLAUBT = 2


def lade_pypdf():
    try:
        from pypdf import PdfReader  # noqa: PLC0415
        return PdfReader
    except ImportError:
        return None


def pruefe(pdf: Path, PdfReader) -> list[str]:
    fehler: list[str] = []
    leser = PdfReader(str(pdf))
    seiten = len(leser.pages)

    intern = 0
    seiten_mit_verweis = 0
    for seite in leser.pages:
        auf_dieser = 0
        for ann in seite.get("/Annots") or []:
            obj = ann.get_object()
            if obj.get("/Subtype") != "/Link":
                continue
            ziel_intern = "/Dest" in obj or (obj.get("/A") or {}).get("/S") == "/GoTo"
            if ziel_intern:
                intern += 1
                auf_dieser += 1
        if auf_dieser:
            seiten_mit_verweis += 1

    # A — ueberhaupt Verweise
    if intern == 0:
        fehler.append(
            "keine internen Verweise — Inhaltsverzeichnis und Kapitel sind "
            "nicht verknuepft (fehlen die id-Attribute an den Ueberschriften?)"
        )

    # B — Ruecksprung auf jeder Seite
    ohne = seiten - seiten_mit_verweis
    if ohne > SEITEN_OHNE_ERLAUBT:
        fehler.append(
            f"{ohne} von {seiten} Seiten ohne jeden Verweis — der Ruecksprung "
            "zum Inhalt fehlt. Ein Verweis in @bottom-center erzeugt KEINE "
            "Annotation; dafuer braucht es ein fest positioniertes Element"
        )

    # C — Lesezeichen
    try:
        lesezeichen = len(leser.outline)
    except Exception:  # noqa: BLE001 — kaputte Gliederung zaehlt als keine
        lesezeichen = 0
    if lesezeichen == 0:
        fehler.append(
            "keine Lesezeichen — im PDF-Betrachter gibt es keine Gliederung "
            "(bookmark-level in der CSS fehlt?)"
        )

    if not fehler:
        print(
            f"  {pdf.name}: {seiten} Seiten, {intern} interne Verweise, "
            f"Ruecksprung auf {seiten_mit_verweis} Seiten, "
            f"{lesezeichen} Lesezeichen"
        )
    return fehler


def main(argv: list[str]) -> int:
    PdfReader = lade_pypdf()
    if PdfReader is None:
        print(
            "pypdf fehlt — Pruefung uebersprungen.\n"
            "  Nachruesten:  pip install pypdf\n"
            "  Beim Bauen eines Handbuchs laeuft sie ohnehin, dort liegt "
            "pypdf in der Umgebung des Buches."
        )
        return 2

    pdfs = [Path(a) for a in argv] or STANDARD
    vorhanden = [p for p in pdfs if p.exists()]
    if not vorhanden:
        print("Kein Handbuch-PDF gefunden — nichts zu pruefen.")
        return 0

    alle: list[str] = []
    for pdf in vorhanden:
        for f in pruefe(pdf, PdfReader):
            alle.append(f"{pdf.relative_to(WURZEL) if WURZEL in pdf.parents else pdf}: {f}")

    if alle:
        print("\nSprungmarken fehlen:")
        for f in alle:
            print(f"  - {f}")
        return 1

    print(f"Sprungmarken in Ordnung — {len(vorhanden)} Handbuch-PDF(s) geprueft.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
