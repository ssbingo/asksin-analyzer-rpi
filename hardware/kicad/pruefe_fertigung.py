#!/usr/bin/env python3
"""
Fertigungsprüfung — beantwortet die Frage „kann das so in Produktion?"

Der DRC prüft Geometrie, `verify_netlist.py` die Verdrahtung. Was beide nicht
prüfen, ist das Drumherum, an dem eine Bestellung tatsächlich scheitert:
fehlende Gerber-Lagen, Bohrer unter dem Herstellermindestmaß, Bauteile ohne
LCSC-Nummer, eine CPL, die nicht zur Platine passt, Löcher, die nicht auf das
Bohrbild des Raspberry Pi treffen.

Jede Prüfung meldet OK oder FEHLER; der Rückgabewert ist die Zahl der Fehler.

Aufruf:
    python3 pruefe_fertigung.py
"""

from __future__ import annotations

import csv
import pathlib
import re
import sys
import zipfile

import pcbnew

import generate_pcb as G
from generate_schematic import NETS, PROJECT

HERE = pathlib.Path(__file__).resolve().parent
BOARD_FILE = HERE / f"{PROJECT}.kicad_pcb"
FAB = HERE / "fab"

# JLCPCB-Mindestwerte für die Standardfertigung (2 Lagen ebenso wie 4 Lagen),
# Stand 07/2026 — bewusst mit Reserve verglichen, nicht auf Kante.
MIN_BOHRER = 0.30          # mm
MIN_BAHN = 0.127           # mm (5 mil)
MIN_ABSTAND = 0.127        # mm
MIN_RINGBREITE = 0.13      # mm

fehler: list[str] = []
hinweise: list[str] = []


def ok(text: str) -> None:
    print(f"  \033[32mOK\033[0m      {text}")


def fail(text: str) -> None:
    fehler.append(text)
    print(f"  \033[31mFEHLER\033[0m  {text}")


def hint(text: str) -> None:
    hinweise.append(text)
    print(f"  \033[33mHinweis\033[0m {text}")


def mm(v: int) -> float:
    return pcbnew.ToMM(v)


def umriss(board: pcbnew.BOARD) -> tuple[float, float, float, float]:
    """Wahre Umrissgrenzen aus den Edge.Cuts-Segmenten.

    Bewusst **nicht** GetBoardEdgesBoundingBox(): die zählt die halbe
    Linienbreite der Umrisskante mit (0,05 mm) und verschiebt damit jeden
    Vergleich mit den Fertigungsdaten, die vom Konstruktionsursprung ausgehen.
    """
    xs, ys = [], []
    for d in board.GetDrawings():
        if d.GetLayerName() != "Edge.Cuts" or d.GetClass() != "PCB_SHAPE":
            continue
        for pt in (d.GetStart(), d.GetEnd()):
            xs.append(mm(pt.x))
            ys.append(mm(pt.y))
    return min(xs), min(ys), max(xs), max(ys)


# --------------------------------------------------------------- 1. Platine


def pruefe_lagen(board: pcbnew.BOARD) -> None:
    n = board.GetCopperLayerCount()
    if n == 4:
        ok(f"Lagenaufbau: {n} Kupferlagen")
    else:
        fail(f"Lagenaufbau: {n} Kupferlagen, erwartet 4")


def pruefe_umriss(board: pcbnew.BOARD) -> None:
    """Ist der Umriss geschlossen? Ein offener Umriss ist der häufigste Grund
    für eine Rückfrage des Herstellers."""
    punkte: list[tuple[float, float]] = []
    for d in board.GetDrawings():
        if d.GetLayerName() != "Edge.Cuts" or d.GetClass() != "PCB_SHAPE":
            continue
        punkte.append((round(mm(d.GetStart().x), 3), round(mm(d.GetStart().y), 3)))
        punkte.append((round(mm(d.GetEnd().x), 3), round(mm(d.GetEnd().y), 3)))
    if not punkte:
        fail("Umriss: keine Edge.Cuts-Segmente gefunden")
        return
    einzeln = [p for p in set(punkte) if punkte.count(p) != 2]
    if einzeln:
        fail(f"Umriss ist offen — {len(einzeln)} Endpunkt(e) ohne Partner: {einzeln[:3]}")
    else:
        x0, y0, x1, y1 = umriss(board)
        ok(f"Umriss geschlossen, {len(punkte)//2} Segmente, "
           f"{x1 - x0:.1f} × {y1 - y0:.1f} mm")


def pruefe_bohrer(board: pcbnew.BOARD) -> None:
    kleinste = None
    for fp in board.GetFootprints():
        for pad in fp.Pads():
            d = pad.GetDrillSize().x
            if d and (kleinste is None or d < kleinste):
                kleinste = d
    for t in board.GetTracks():
        if t.Type() == pcbnew.PCB_VIA_T:
            d = t.GetDrillValue()
            if d and (kleinste is None or d < kleinste):
                kleinste = d
    if kleinste is None:
        fail("Bohrer: keine gefunden")
    elif mm(kleinste) + 1e-9 < MIN_BOHRER:
        fail(f"Kleinster Bohrer {mm(kleinste):.2f} mm < Minimum {MIN_BOHRER} mm")
    else:
        ok(f"Kleinster Bohrer {mm(kleinste):.2f} mm (Minimum {MIN_BOHRER} mm)")


def pruefe_bahnen(board: pcbnew.BOARD) -> None:
    breiten = [mm(t.GetWidth()) for t in board.GetTracks()
               if t.Type() == pcbnew.PCB_TRACE_T]
    if not breiten:
        fail("Keine Leiterbahnen gefunden")
        return
    if min(breiten) + 1e-9 < MIN_BAHN:
        fail(f"Schmalste Bahn {min(breiten):.3f} mm < Minimum {MIN_BAHN} mm")
    else:
        ok(f"Schmalste Bahn {min(breiten):.3f} mm, breiteste {max(breiten):.3f} mm")


def pruefe_ringbreite(board: pcbnew.BOARD) -> None:
    schmalste = None
    for t in board.GetTracks():
        if t.Type() != pcbnew.PCB_VIA_T:
            continue
        ring = (mm(t.GetWidth()) - mm(t.GetDrillValue())) / 2
        if schmalste is None or ring < schmalste:
            schmalste = ring
    if schmalste is None:
        hint("Keine Durchkontaktierungen — Ringbreite nicht prüfbar")
    elif schmalste + 1e-9 < MIN_RINGBREITE:
        fail(f"Schmalster Via-Ring {schmalste:.3f} mm < Minimum {MIN_RINGBREITE} mm")
    else:
        ok(f"Schmalster Via-Ring {schmalste:.3f} mm (Minimum {MIN_RINGBREITE} mm)")


def pruefe_pi_bohrbild(board: pcbnew.BOARD) -> None:
    """Treffen die Befestigungslöcher das Bohrbild des Pi?

    Sollwerte aus den amtlichen Zeichnungen (rpi3-b-plus/rpi4/rpi5, identisch):
    Raster 58 × 49 mm, je 3,5 mm von den Kanten.
    """
    soll = {
        "MH1": (G.PI_X0 + 3.5, G.PI_Y0 + 3.5),
        "MH2": (G.PI_X0 + 61.5, G.PI_Y0 + 3.5),
        "MH3": (G.PI_X0 + 3.5, G.PI_Y0 + 52.5),
    }
    ox, oy, _, _ = umriss(board)
    schlecht = []
    for ref, (sx, sy) in soll.items():
        fp = board.FindFootprintByReference(ref)
        if fp is None:
            schlecht.append(f"{ref} fehlt")
            continue
        p = fp.GetPosition()
        dx, dy = mm(p.x) - ox - sx, mm(p.y) - oy - sy
        if abs(dx) > 0.05 or abs(dy) > 0.05:
            schlecht.append(f"{ref} um ({dx:+.2f}, {dy:+.2f}) mm daneben")
    if schlecht:
        fail("Pi-Bohrbild: " + "; ".join(schlecht))
    else:
        ok("Befestigungslöcher treffen das Pi-Raster 58 × 49 mm (MH1–MH3)")
    # Der Abstand zweier Löcher muss exakt 58 bzw. 49 mm ergeben.
    m1 = board.FindFootprintByReference("MH1").GetPosition()
    m2 = board.FindFootprintByReference("MH2").GetPosition()
    m3 = board.FindFootprintByReference("MH3").GetPosition()
    dx = abs(mm(m2.x) - mm(m1.x))
    dy = abs(mm(m3.y) - mm(m1.y))
    if abs(dx - 58.0) > 0.05 or abs(dy - 49.0) > 0.05:
        fail(f"Lochraster {dx:.2f} × {dy:.2f} mm, erwartet 58,00 × 49,00 mm")
    else:
        ok(f"Lochraster gemessen: {dx:.2f} × {dy:.2f} mm")


def pruefe_j1(board: pcbnew.BOARD) -> None:
    """Die 2×20-Buchse gegen das Pi-Raster — der Fehler der ersten Charge."""
    fp = board.FindFootprintByReference("J1")
    if fp is None:
        fail("J1 fehlt")
        return
    if not fp.IsFlipped():
        fail("J1 liegt nicht auf der Unterseite (Flip fehlt — Fehler von v0.0.1!)")
        return
    ox, oy, _, _ = umriss(board)
    soll = {
        "1": (G.PI_X0 + 8.37, G.PI_Y0 + 4.77),
        "2": (G.PI_X0 + 8.37, G.PI_Y0 + 2.23),
        "39": (G.PI_X0 + 8.37 + 19 * 2.54, G.PI_Y0 + 4.77),
        "40": (G.PI_X0 + 8.37 + 19 * 2.54, G.PI_Y0 + 2.23),
    }
    schlecht = []
    for nr, (sx, sy) in soll.items():
        p = fp.FindPadByNumber(nr).GetPosition()
        if abs(mm(p.x) - ox - sx) > 0.02 or abs(mm(p.y) - oy - sy) > 0.02:
            schlecht.append(nr)
    if schlecht:
        fail(f"J1: Pads {schlecht} nicht auf dem Pi-Raster")
    else:
        ok("J1: Unterseite, alle Eckpads exakt auf dem Pi-Raster")


def pruefe_unverbunden(board: pcbnew.BOARD) -> None:
    board.BuildConnectivity()
    conn = board.GetConnectivity()
    n = conn.GetUnconnectedCount(True)
    if n:
        fail(f"{n} unverbundene Verbindung(en)")
    else:
        ok("Keine unverbundenen Verbindungen")


def pruefe_led_polung(board: pcbnew.BOARD) -> None:
    """Kathode an Masse, Anode über R1 zum Treiber — der Fehler von v0.0.1."""
    d1 = board.FindFootprintByReference("D1")
    r1 = board.FindFootprintByReference("R1")
    if d1 is None or r1 is None:
        fail("D1 oder R1 fehlt")
        return
    kathode = d1.FindPadByNumber("1").GetNetname()
    anode = d1.FindPadByNumber("2").GetNetname()
    if kathode != "GND":
        fail(f"D1 verpolt: Kathode (Pin 1) an {kathode!r} statt an GND")
    elif anode != r1.FindPadByNumber("2").GetNetname():
        fail("D1: Anode hängt nicht an R1")
    else:
        ok("Status-LED richtig gepolt (Anode über R1, Kathode an GND)")


def pruefe_schalter(board: pcbnew.BOARD) -> None:
    sw = board.FindFootprintByReference("SW1")
    if sw is None:
        fail("SW1 fehlt")
        return
    p1 = sw.FindPadByNumber("1").GetNetname()
    p2 = sw.FindPadByNumber("2").GetNetname()
    p3 = sw.FindPadByNumber("3").GetNetname()
    r4 = board.FindFootprintByReference("R4")
    if (p1, p3) != ("LED_PWM", "LED_SPI"):
        fail(f"SW1 falsch verdrahtet: Pin1={p1}, Pin3={p3}")
    elif p2 != r4.FindPadByNumber("1").GetNetname():
        fail("SW1: Mittelpin hängt nicht am Serienwiderstand R4")
    else:
        ok("SW1: Pin1=PWM/GPIO18, Pin3=SPI/GPIO10, Mitte über R4 zur LED")
    # Beschriftung vorhanden und auf der richtigen Seite?
    texte = {t.GetText(): t.GetPosition() for t in board.GetDrawings()
             if t.GetClass() == "PCB_TEXT" and t.GetText() in ("PWM", "SPI")}
    if set(texte) != {"PWM", "SPI"}:
        fail(f"Beschriftung des Schalters unvollständig: {sorted(texte)}")
    else:
        px1 = sw.FindPadByNumber("1").GetPosition().x
        px3 = sw.FindPadByNumber("3").GetPosition().x
        if abs(texte["PWM"].x - px1) > pcbnew.FromMM(0.6) or \
           abs(texte["SPI"].x - px3) > pcbnew.FromMM(0.6):
            fail("Beschriftung PWM/SPI steht nicht bei den zugehörigen Pins")
        else:
            ok("Beschriftung PWM/SPI steht bei den richtigen Anschluessen")


# ----------------------------------------------------------- 2. Fertigungsdaten


ERWARTETE_GERBER = {
    "F_Cu.gtl", "In1_Cu.g1", "In2_Cu.g2", "B_Cu.gbl",
    "F_Mask.gts", "B_Mask.gbs", "F_Silkscreen.gto", "B_Silkscreen.gbo",
    "F_Paste.gtp", "Edge_Cuts.gm1", "PTH.drl", "NPTH.drl", "job.gbrjob",
}


def pruefe_archiv() -> None:
    zpfad = HERE / f"{PROJECT}-fertigung.zip"
    if not zpfad.exists():
        fail("Fertigungsarchiv fehlt")
        return
    with zipfile.ZipFile(zpfad) as z:
        namen = z.namelist()
    fehlend = {e for e in ERWARTETE_GERBER
               if not any(n.endswith(e) for n in namen)}
    if fehlend:
        fail(f"Im Archiv fehlen: {sorted(fehlend)}")
    else:
        ok(f"Archiv vollständig: {len(namen)} Dateien, alle 13 Fertigungslagen")
    for pflicht in ("bestueckung/jlcpcb_bom.csv", "bestueckung/jlcpcb_cpl.csv",
                    "LIESMICH.txt"):
        if pflicht not in namen:
            fail(f"Im Archiv fehlt {pflicht}")


def pruefe_bom_cpl(board: pcbnew.BOARD) -> None:
    bom = FAB / "jlcpcb_bom.csv"
    cpl = FAB / "jlcpcb_cpl.csv"
    if not bom.exists() or not cpl.exists():
        fail("jlcpcb_bom.csv oder jlcpcb_cpl.csv fehlt")
        return

    with bom.open(encoding="utf8") as f:
        bom_refs, nummern = set(), {}
        for row in csv.DictReader(f):
            for r in row["Designator"].split(","):
                bom_refs.add(r.strip())
                nummern[r.strip()] = row["JLCPCB Part #"]
    with cpl.open(encoding="utf8") as f:
        cpl_zeilen = list(csv.DictReader(f))
    cpl_refs = {r["Designator"] for r in cpl_zeilen}

    if bom_refs != cpl_refs:
        fail(f"BOM und CPL uneins: nur BOM {sorted(bom_refs - cpl_refs)}, "
             f"nur CPL {sorted(cpl_refs - bom_refs)}")
    else:
        ok(f"BOM und CPL decken sich: {len(bom_refs)} Bauteile")

    falsch = [r for r, n in nummern.items() if not re.fullmatch(r"C\d+", n)]
    if falsch:
        fail(f"Ungültige LCSC-Nummern: {falsch}")
    else:
        ok(f"Alle {len(nummern)} LCSC-Nummern haben die Form C…")

    # Stimmen die CPL-Koordinaten mit der Platine überein? Ursprung der CPL ist
    # die linke UNTERE Ecke, Y zeigt nach oben.
    links, _, _, unten = umriss(board)
    daneben = []
    for zeile in cpl_zeilen:
        fp = board.FindFootprintByReference(zeile["Designator"])
        if fp is None:
            daneben.append(f"{zeile['Designator']} nicht auf der Platine")
            continue
        p = fp.GetPosition()
        soll_x = mm(p.x) - links
        soll_y = unten - mm(p.y)
        ist_x = float(zeile["Mid X"].removesuffix("mm"))
        ist_y = float(zeile["Mid Y"].removesuffix("mm"))
        if abs(ist_x - soll_x) > 0.02 or abs(ist_y - soll_y) > 0.02:
            daneben.append(f"{zeile['Designator']} ({ist_x:.2f},{ist_y:.2f}) "
                           f"statt ({soll_x:.2f},{soll_y:.2f})")
    if daneben:
        fail("CPL passt nicht zur Platine: " + "; ".join(daneben[:4]))
    else:
        ok("CPL-Koordinaten stimmen mit der Platine überein (Ursprung unten links)")

    # Jedes bestückte SMD-Bauteil muss entweder in der BOM stehen oder
    # ausdrücklich als Handbestückung geführt sein.
    import generate_bom_cpl as B
    offen = []
    for fp in board.GetFootprints():
        ref = fp.GetReference()
        if ref.startswith(("MH", "KB", "TP")) or ref in B.DNP:
            continue
        durchsteck = any(p.GetAttribute() == pcbnew.PAD_ATTRIB_PTH
                         for p in fp.Pads())
        if ref in bom_refs or ref in B.JLC_HAND:
            continue
        if durchsteck and ref not in B.JLC:
            continue                      # bedrahtet, von Hand — dokumentiert
        offen.append(ref)
    if offen:
        fail(f"Bauteile ohne LCSC-Nummer und ohne Handbestückungs-Vermerk: {offen}")
    else:
        ok("Jedes Bauteil ist entweder bestückt oder als Handarbeit vermerkt")


def pruefe_netzliste() -> None:
    """Die Platine gegen die Soll-Netzliste aus generate_schematic.py."""
    board = pcbnew.LoadBoard(str(BOARD_FILE))
    ist: dict[str, set[str]] = {}
    for fp in board.GetFootprints():
        for pad in fp.Pads():
            n = pad.GetNetname()
            if n:
                ist.setdefault(n, set()).add(f"{fp.GetReference()}.{pad.GetNumber()}")
    soll = {name: {f"{r}.{p}" for r, p in pins} for name, pins in NETS.items()}
    abweichung = []
    for name, pins in soll.items():
        if ist.get(name, set()) != pins:
            abweichung.append(name)
    for name in ist:
        if name not in soll:
            abweichung.append(f"{name} (unerwartet)")
    if abweichung:
        fail(f"Netzliste weicht ab: {abweichung}")
    else:
        ok(f"Netzliste der Platine deckt sich mit der Spezifikation ({len(soll)} Netze)")


def main() -> int:
    board = pcbnew.LoadBoard(str(BOARD_FILE))

    print("\n\033[1mPlatine\033[0m")
    pruefe_lagen(board)
    pruefe_umriss(board)
    pruefe_bohrer(board)
    pruefe_bahnen(board)
    pruefe_ringbreite(board)
    pruefe_unverbunden(board)

    print("\n\033[1mAnschluss an den Raspberry Pi\033[0m")
    pruefe_j1(board)
    pruefe_pi_bohrbild(board)

    print("\n\033[1mSchaltung\033[0m")
    pruefe_netzliste()
    pruefe_led_polung(board)
    pruefe_schalter(board)

    print("\n\033[1mFertigungsdaten\033[0m")
    pruefe_archiv()
    pruefe_bom_cpl(board)

    print()
    if fehler:
        print(f"\033[31m{len(fehler)} Fehler\033[0m — so nicht in Produktion geben.")
        for f in fehler:
            print(f"   · {f}")
    else:
        print("\033[32mAlle Prüfungen bestanden.\033[0m")
    if hinweise:
        print(f"{len(hinweise)} Hinweis(e):")
        for h in hinweise:
            print(f"   · {h}")
    return len(fehler)


if __name__ == "__main__":
    sys.exit(main())
