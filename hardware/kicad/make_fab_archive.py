#!/usr/bin/env python3
"""
Packt das vollständige Fertigungspaket als AskSin-Analyzer-V3-fertigung.zip.

Arbeitet ausschließlich lesend — die Platine ist in Produktion, hier wird
nichts erzeugt oder verändert, nur eingesammelt, was in `fab/` liegt.

Aufbau des Archivs:

    gerber/       Gerber, Bohrdaten, Jobfile — das Paket für den
                  Platinenhersteller. Falls ein Bestellportal keine
                  Unterordner mag: nur den Inhalt dieses Ordners hochladen.
    bestueckung/  BOM, Pick-&-Place (CPL) und die rohe KiCad-Stückliste
    doku/         Layout- und Schaltplan-PDF
    LIESMICH.txt  Inhaltsverzeichnis mit Kurzbeschreibung

Aufruf:
    python3 make_fab_archive.py
"""

from __future__ import annotations

import datetime
import pathlib
import sys
import zipfile

from generate_schematic import PROJECT

HERE = pathlib.Path(__file__).resolve().parent
FAB_DIR = HERE / "fab"
ARCHIVE = HERE / f"{PROJECT}-fertigung.zip"

GERBER_SUFFIXES = (".gbl", ".gbo", ".gbs", ".gm1", ".gtl", ".gto",
                   ".gtp", ".gts", ".g1", ".g2", ".gbrjob", ".drl")

LAYOUT = {
    "gerber": lambda p: p.suffix.lower() in GERBER_SUFFIXES,
    "bestueckung": lambda p: p.name in ("bom.csv", "cpl.csv",
                                        "stueckliste.csv",
                                        "jlcpcb_bom.csv", "jlcpcb_cpl.csv"),
    "doku": lambda p: p.name in ("layout.pdf", "schaltplan.pdf"),
}

LIESMICH = """\
AskSin-Analyzer — Fertigungspaket Hardware v0.1.0
Erzeugt am {datum} aus AskSin-Analyzer-V3.kicad_pcb.

WICHTIG — Unterschied zu v0.0.1:
    In v0.0.1 war die 2x20-Buchse J1 gespiegelt (die gerade Pinreihe lag
    auf der falschen Seite). Platinen dieser Charge duerfen NUR ueber den
    J1-Adapter (kicad/adapter/) betrieben werden. In v0.1.0 ist J1
    korrigiert -- geprueft gegen die offizielle KiCad-Vorlage
    RaspberryPi-HAT -- und die Platine liegt jetzt PARALLEL neben dem Pi
    an der Header-Seite statt ueber dessen Buchsen.

gerber/
    Kupfer F.Cu / In1.Cu / In2.Cu / B.Cu (4 Lagen, 1,6 mm,
    beide Innenlagen durchgehend Masse -- die Aussenlagen tragen
    keine Massefläche, jedes Massepad haengt ueber ein eigenes
    Stuetzvia an den Innenlagen; keine Impedanzvorgabe noetig),
    Loetstopplack beidseitig, Bestueckungsdruck beidseitig,
    Loetpastenmaske oben, Umriss, Bohrdaten (PTH/NPTH getrennt),
    Gerber-Jobfile mit Lagenaufbau.
    -> Das ist das Upload-Paket fuer den Platinenhersteller.
       Portale ohne Unterordner-Unterstuetzung: nur diesen
       Ordnerinhalt hochladen.

bestueckung/
    bom.csv          Stueckliste, gruppiert, mit Bezugsquellen.
                     R4 ist als DNP ausgewiesen: bestueckt wird
                     R5 (0 Ohm, SPI/GPIO10) ODER R4 (PWM/GPIO18),
                     nie beide. Vorgabe seit 30.07.2026 ist R5.
    cpl.csv          Pick-&-Place: Designator, Mid X, Mid Y, Layer,
                     Rotation. Ursprung linke untere Platinenecke,
                     X nach rechts, Y nach oben, Millimeter.
                     Drehwinkel in KiCad-Konvention.
    stueckliste.csv  Rohe KiCad-Stueckliste (Referenz).
    jlcpcb_bom.csv   BOM fuer die JLCPCB-Bestueckung, mit LCSC-Nummern.
                     SMD plus eine THT-Ausnahme: Y1 (Resonator
                     CSTLS8M00G53-B0, C83707) loetet JLCPCB in der
                     Welle mit. U3 (Funkmodul) fehlt dort bewusst —
                     nicht im JLCPCB-Katalog, wird von Hand geloetet.
                     U1 ist als XC6206P332MR-G (C5446) eingetragen,
                     pinkompatibler Ersatz fuer den MCP1754S.
                     S1 ist C231329 (B3U-1000P ohne Zentrierstift,
                     gleiche Pads — die Stiftbohrung bleibt leer).
    jlcpcb_cpl.csv   Pick-&-Place passend zur jlcpcb_bom.csv.
                     Nach dem Upload die Bauteilvorschau pruefen:
                     Drehlage von U1/U2/S1 und Polung von D1.

doku/
    layout.pdf       Bestueckungsseite mit Umriss und Druck
    schaltplan.pdf   vollstaendiger Schaltplan

Pruefstand bei Erstellung: ERC 0 Fehler / 0 Warnungen,
DRC 0 Fehler / 0 Warnungen / 0 unverbundene Elemente, Netzliste
maschinell gegen die Spezifikation geprueft, J1-Pad-Geometrie
maschinell gegen die KiCad-Vorlage RaspberryPi-HAT geprueft
(hardware/README.md im Projekt).
"""


def main() -> int:
    missing = []
    plan: list[tuple[pathlib.Path, str]] = []
    for folder, matches in LAYOUT.items():
        found = [p for p in sorted(FAB_DIR.iterdir()) if matches(p)]
        if not found:
            missing.append(folder)
        plan.extend((p, f"{folder}/{p.name}") for p in found)

    if missing:
        print(f"FEHLER: keine Dateien für {', '.join(missing)} in {FAB_DIR}")
        return 1

    datum = datetime.date.today().isoformat()
    with zipfile.ZipFile(ARCHIVE, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("LIESMICH.txt", LIESMICH.format(datum=datum))
        for src, arcname in plan:
            zf.write(src, arcname)

    size = ARCHIVE.stat().st_size // 1024
    print(f"{ARCHIVE.name}: {len(plan) + 1} Dateien, {size} KB")
    for folder in LAYOUT:
        n = sum(1 for _, a in plan if a.startswith(folder + "/"))
        print(f"  {folder + '/':<14} {n} Dateien")
    return 0


if __name__ == "__main__":
    sys.exit(main())
