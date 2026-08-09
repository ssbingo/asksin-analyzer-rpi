#!/usr/bin/env python3
"""Prueft, ob erzeugte Dateien noch zu ihren Quellen passen.

Warum es dieses Skript gibt
---------------------------
Am 07.08.2026 habe ich beim Fehlersuchen an Analyzer 05 auf
`hardware/kicad/AskSin-Analyzer-V3-layout.pdf` verwiesen. Das PDF stammte vom
27.07., die gefertigte Platine vom 31.07. — dazwischen lagen die Umformung auf
L-Form, die Verlaengerung nach hinten und der Wegfall der gesamten
USB-C-Baugruppe. Ich habe also auf ein Bild verwiesen, das ein anderes Geraet
zeigt, und daraus Messpunkte abgeleitet.

Dieselbe Falle lag daneben: `hardware/kicad/bom.csv` vom 27.07. fuehrte J4
(USB-C), U4 (CP2102N), U5 (ESD), JP1/JP2 und R5/R6 — Bauteile, die auf der
gefertigten Platine nicht existieren. Niemand erzeugte diese Datei, niemand
las sie, aber die README verlinkte sie als *die* Stueckliste.

Bei Hardware kostet so ein Verweis nicht Zeit, sondern eine Fertigungsrunde.

Was geprueft wird
-----------------
1. **Alter**: Kein Erzeugnis darf aelter sein als seine Quelle. Verglichen
   werden git-Commit-Zeitpunkte, nicht Dateidaten — nach einem frischen Clone
   haben alle Dateien dasselbe Dateidatum, git behaelt die Wahrheit.
2. **Inhalt**: Die Stueckliste in `hardware/README.md` muss dieselben
   Bauteile nennen wie die Datei, die in die Fertigung ging. Ein Datum sagt
   nur, dass jemand etwas angefasst hat — nicht, dass es stimmt.

Rueckgabewert 0, wenn alles passt; sonst 1 mit Bericht auf stdout.
"""

import re
import subprocess
import sys
from pathlib import Path

WURZEL = Path(__file__).resolve().parent.parent

# Erzeugnis -> Quellen, aus denen es hervorgeht.
ERZEUGNISSE: dict[str, list[str]] = {
    # Es gibt bewusst nur EINEN Satz Zeichnungen, naemlich den im
    # Fertigungspaket. Bis 09.08.2026 lagen Dubletten davon im Oberverzeichnis
    # (AskSin-Analyzer-V3.pdf, -layout.pdf); sie wurden von nichts erzeugt und
    # von nichts gelesen, standen aber im selben Ordner wie die Quellen und
    # luden zum Verwechseln ein. Genau so ist der Fehler entstanden, der dieses
    # Skript ausgeloest hat.
    "hardware/kicad/fab/schaltplan.pdf": [
        "hardware/kicad/AskSin-Analyzer-V3.kicad_sch",
    ],
    "hardware/kicad/fab/layout.pdf": [
        "hardware/kicad/AskSin-Analyzer-V3.kicad_pcb",
    ],
    "hardware/kicad/netlist.md": [
        "hardware/kicad/AskSin-Analyzer-V3.kicad_sch",
    ],
    "hardware/kicad/netlist.net": [
        "hardware/kicad/AskSin-Analyzer-V3.kicad_sch",
    ],
    "hardware/kicad/fab/bom.csv": [
        "hardware/kicad/AskSin-Analyzer-V3.kicad_sch",
    ],
    "hardware/kicad/AskSin-Analyzer-V3-fertigung.zip": [
        "hardware/kicad/AskSin-Analyzer-V3.kicad_pcb",
        "hardware/kicad/fab/bom.csv",
    ],
    "docs/handbuch/AskSin-Analyzer-Handbuch.pdf": [
        "docs/handbuch/handbuch.html",
    ],
}


def commit_zeit(pfad: str) -> int | None:
    """Zeitpunkt des letzten Commits, der diese Datei anfasste."""
    erg = subprocess.run(
        ["git", "log", "-1", "--format=%ct", "--", pfad],
        cwd=WURZEL, capture_output=True, text=True,
    )
    text = erg.stdout.strip()
    return int(text) if text else None


def pruefe_alter() -> list[str]:
    fehler: list[str] = []
    for erzeugnis, quellen in ERZEUGNISSE.items():
        if not (WURZEL / erzeugnis).exists():
            fehler.append(f"{erzeugnis} fehlt — in ERZEUGNISSE gelistet, aber nicht da")
            continue
        te = commit_zeit(erzeugnis)
        if te is None:
            fehler.append(f"{erzeugnis} ist nicht eingecheckt — Stand nicht nachvollziehbar")
            continue
        for quelle in quellen:
            tq = commit_zeit(quelle)
            if tq is not None and tq > te:
                tage = (tq - te) / 86400
                fehler.append(
                    f"{erzeugnis} ist {tage:.1f} Tage aelter als {quelle} "
                    f"— neu erzeugen, nicht verlinken"
                )
    return fehler


def pruefe_stueckliste() -> list[str]:
    """Nennt die README dieselben Bauteile wie die Fertigungs-BOM?"""
    bom = WURZEL / "hardware/kicad/fab/bom.csv"
    readme = WURZEL / "hardware/README.md"
    if not bom.exists() or not readme.exists():
        return ["fab/bom.csv oder hardware/README.md fehlt"]

    # Spalte "Designator" ist die zweite; Mehrfachangaben sind kommagetrennt.
    in_bom: set[str] = set()
    for zeile in bom.read_text(encoding="utf8").splitlines()[1:]:
        felder = next(csv_zeilen(zeile), None)
        if felder and len(felder) > 1:
            in_bom.update(t.strip() for t in felder[1].split(",") if t.strip())

    # Aus der README nur den Stuecklisten-Abschnitt lesen.
    text = readme.read_text(encoding="utf8")
    ab = text.find("## 6. Stückliste")
    bis = text.find("\n## ", ab + 1)
    abschnitt = text[ab:bis if bis > 0 else len(text)]

    in_readme: set[str] = set()
    for zeile in abschnitt.splitlines():
        if not zeile.startswith("|"):
            continue
        erste = zeile.split("|")[1].strip()
        # "TP1–TP8" und "KB1, KB2" sind Sammelangaben ohne eigene BOM-Zeile.
        for teil in erste.replace("–", "-").split(","):
            teil = teil.strip().strip("*")
            if re.fullmatch(r"[A-Z]+\d+", teil):
                in_readme.add(teil)

    # Prueffpads und Kabelbinderloecher stehen absichtlich nicht in der BOM.
    ohne_bom = {f"TP{i}" for i in range(1, 9)} | {"KB1", "KB2"}
    fehlt_in_readme = in_bom - in_readme
    zuviel_in_readme = in_readme - in_bom - ohne_bom

    fehler = []
    if fehlt_in_readme:
        fehler.append(
            "In der Fertigung, aber nicht in der README-Stueckliste: "
            + ", ".join(sorted(fehlt_in_readme))
        )
    if zuviel_in_readme:
        fehler.append(
            "In der README-Stueckliste, aber nicht in der Fertigung: "
            + ", ".join(sorted(zuviel_in_readme))
            + " — genau so sah die Leiche von 27.07. aus"
        )
    return fehler


def pruefe_keine_dubletten() -> list[str]:
    """In hardware/kicad gehoeren Zeichnungen ausschliesslich nach fab/.

    Bis 09.08.2026 lagen dort Zweitfassungen von Schaltplan und Layout. Sie
    wurden von nichts erzeugt und von nichts gelesen, standen aber neben den
    Quellen — und altern lautlos. Genau daraus ist der Fehler entstanden, der
    dieses Skript ausgeloest hat.
    """
    kicad = WURZEL / "hardware/kicad"
    streuner = [p for p in kicad.glob("*.pdf")]
    streuner += [p for p in kicad.glob("*.csv")]
    if not streuner:
        return []
    return [
        "Zeichnungen oder Stuecklisten liegen ausserhalb von fab/: "
        + ", ".join(sorted(p.name for p in streuner))
        + " — es gibt bewusst nur einen Satz, naemlich den im Fertigungspaket"
    ]


def pruefe_verweise() -> list[str]:
    """Zeigt jeder Markdown-Verweis auf eine Datei, die es gibt?

    Beim Aufraeumen am 09.08.2026 sind mehrere Dateien entfallen (die stumme
    HEX-Datei, nachbauen.sh, zwei PDF-Dubletten, zwei alte Planungs-PDFs). Ein
    Verweis, der ins Leere geht, ist schlimmer als gar keiner: Er behauptet,
    es gebe dort etwas.
    """
    fehler: list[str] = []
    muster = re.compile(r"\[[^\]]*\]\(([^)#][^)]*)\)")
    for md in sorted(WURZEL.rglob("*.md")):
        rel = md.relative_to(WURZEL).as_posix()
        if rel.startswith(("reference/", "node_modules", "docs/handbuch/.venv")):
            continue
        if "node_modules" in rel:
            continue
        for ziel in muster.findall(md.read_text(encoding="utf8", errors="replace")):
            ziel = ziel.split()[0].strip("<>")
            if ziel.startswith(("http://", "https://", "mailto:", "#")):
                continue
            pfad = (md.parent / ziel.split("#")[0]).resolve()
            if not pfad.exists():
                fehler.append(f"{rel}: Verweis auf {ziel} geht ins Leere")
    return fehler


def pruefe_changelog() -> list[str]:
    """Hat jede veroeffentlichte Fassung einen Changelog-Eintrag?

    Der Changelog endete bei v0.9.0, waehrend die Tags bis v0.13.0 reichten und
    die package.json auf 0.13.0 stand. Fuenf Fassungen waren veroeffentlicht
    und nirgends beschrieben — beim Nachtragen habe ich v0.12.2 dann prompt
    uebersehen. Genau dafuer ist das hier.
    """
    erg = subprocess.run(["git", "tag"], cwd=WURZEL, capture_output=True, text=True)
    tags = {t for t in erg.stdout.split() if re.fullmatch(r"v\d+\.\d+\.\d+", t)}
    if not tags:
        return []
    readme = (WURZEL / "README.md").read_text(encoding="utf8")
    # Die Nachschau verhindert, dass "v0.12.2" auch in "v0.12.2-alt" trifft —
    # sonst haelt die Pruefung eine umbenannte Ueberschrift fuer vorhanden.
    eintraege = set(re.findall(r"^### (v\d+\.\d+\.\d+)(?![\w.-])", readme, re.M))

    fehler = []
    ohne_eintrag = sorted(tags - eintraege)
    if ohne_eintrag:
        fehler.append("Tags ohne Changelog-Eintrag: " + ", ".join(ohne_eintrag))
    ohne_tag = sorted(eintraege - tags)
    if ohne_tag:
        fehler.append(
            "Changelog-Eintraege ohne Tag: " + ", ".join(ohne_tag)
            + " — entweder Tag nachholen oder Eintrag zurueckziehen"
        )
    return fehler


def csv_zeilen(zeile: str):
    """Winziger CSV-Leser: Kommas in Anfuehrungszeichen trennen nicht."""
    import csv
    import io
    yield from csv.reader(io.StringIO(zeile))


def main() -> int:
    fehler = (pruefe_alter() + pruefe_stueckliste()
              + pruefe_keine_dubletten() + pruefe_verweise()
              + pruefe_changelog())
    if fehler:
        print("Erzeugnisse passen nicht zu ihren Quellen:")
        for f in fehler:
            print(f"  - {f}")
        return 1
    print(
        f"Erzeugnisse aktuell — {len(ERZEUGNISSE)} Dateien juenger als ihre Quellen, "
        "README-Stueckliste deckungsgleich mit der Fertigung, keine Dubletten, "
        "alle Verweise gehen ins Ziel, jeder Tag hat einen Changelog-Eintrag."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
