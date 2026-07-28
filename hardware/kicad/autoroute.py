#!/usr/bin/env python3
"""
Routet die Platine mit Freerouting.

Ablauf: Specctra-DSN aus KiCad exportieren → Freerouting laufen lassen → die
erzeugte Sitzung (SES) zurück in die Platine importieren → Flächen füllen.

Zwei Eingriffe am DSN sind nötig, sonst macht der Autorouter das Layout kaputt:

1. **Innenlagen als Versorgungslagen markieren.** In1.Cu und In2.Cu tragen
   beide durchgehende Masse. KiCad exportiert sie als `signal`; Freerouting
   würde dort munter Signale hindurchlegen und genau die Eigenschaft zerstören,
   für die die Lagen da sind.
2. **Die Vorgaben aus der Projektdatei übernehmen** — Freerouting liest die
   Netzklassen aus dem DSN, und die müssen zu dem passen, was der DRC später
   prüft.

Voraussetzung ist eine Java-Laufzeitumgebung. Freerouting 2.x braucht Java 25
und läuft dann headless; 1.9.0 kommt mit Java 21 aus, verlangt aber einen
Bildschirm und muss deshalb unter `xvfb-run` gestartet werden.

Aufruf:
    python3 generate_pcb.py && python3 autoroute.py
    kicad-cli pcb drc --output drc.rpt --severity-error AskSin-Analyzer-V3.kicad_pcb
"""

from __future__ import annotations

import pathlib
import re
import shutil
import subprocess
import sys

import pcbnew

import generate_pcb as G
from generate_schematic import PROJECT

HERE = pathlib.Path(__file__).resolve().parent
BOARD_FILE = HERE / f"{PROJECT}.kicad_pcb"
DSN = HERE / "board.dsn"
SES = HERE / "board.ses"

JAR_DIR = pathlib.Path.home() / ".local/share/freerouting"
PLANE_LAYERS = ("In1.Cu", "In2.Cu")
MAX_PASSES = 100
EDGE_CLEARANCE = 0.55   # etwas über der DRC-Vorgabe von 0,5 mm


def java_ok(jar: pathlib.Path) -> bool:
    """Passt die installierte Laufzeitumgebung zur Klassenversion des JAR?"""
    probe = subprocess.run(["java", "-jar", str(jar), "--version"],
                           capture_output=True, text=True, timeout=120)
    return "UnsupportedClassVersionError" not in (probe.stdout + probe.stderr)


def find_jar() -> tuple[pathlib.Path, int]:
    """Bestes **lauffähiges** Freerouting-JAR.

    Sortiert nach Hauptversion absteigend und nimmt das erste, das mit der
    installierten Java-Laufzeitumgebung überhaupt startet. Ein JAR ohne
    Versionsnummer im Dateinamen wird als „vermutlich neu" behandelt und
    deshalb zuerst probiert.
    """
    jars = sorted(JAR_DIR.glob("freerouting*.jar"))
    if not jars:
        raise SystemExit(
            f"Kein Freerouting-JAR in {JAR_DIR}.\n"
            "  curl -L -o ~/.local/share/freerouting/freerouting-2.2.4.jar \\\n"
            "    https://github.com/freerouting/freerouting/releases/"
            "download/v2.2.4/freerouting-2.2.4.jar")

    def major_of(path: pathlib.Path) -> int:
        m = re.search(r"-(\d+)\.\d+\.\d+", path.name)
        return int(m.group(1)) if m else 99

    candidates = sorted(jars, key=major_of, reverse=True)
    rejected = []
    for jar in candidates:
        if java_ok(jar):
            return jar, min(major_of(jar), 9)
        rejected.append(jar.name)

    raise SystemExit(
        "Keines der vorhandenen JAR läuft mit der installierten "
        f"Java-Version:\n  {', '.join(rejected)}\n"
        "  sudo apt install openjdk-25-jre-headless")


def export_dsn(board_file: pathlib.Path, dsn: pathlib.Path) -> None:
    board = pcbnew.LoadBoard(str(board_file))
    if not pcbnew.ExportSpecctraDSN(board, str(dsn)):
        raise SystemExit("Specctra-Export fehlgeschlagen")

    text = dsn.read_text()
    for layer in PLANE_LAYERS:
        text, n = re.subn(rf"(\(layer {re.escape(layer)}\s*\n\s*\(type )signal",
                          r"\1power", text)
        if n != 1:
            raise SystemExit(f"Lage {layer} im DSN nicht gefunden — "
                             "Lagenaufbau geändert?")
    # KiCad exportiert die Umrandung mit Breite 0 — Freerouting darf dann bis
    # an die Platinenkante routen und verletzt hinterher den Kupfer-Kanten-
    # Abstand. Die Breite einfach zu erhöhen hilft nicht: Freerouting liest die
    # Umrandung dann als Linie statt als geschlossene Grenze und routet quer
    # durch die Aussparung des L. Stattdessen wird der Umriss selbst um den
    # geforderten Abstand nach innen geschrumpft.
    inset = EDGE_CLEARANCE
    ring = [
        (G.BODY_X1 - inset, G.BODY_H - inset),
        (G.BODY_X0 + inset, G.BODY_H - inset),
        (G.BODY_X0 + inset, G.ARM_H - inset),
        (inset, G.ARM_H - inset),
        (inset, inset),
        (G.BODY_X1 - inset, inset),
    ]
    coords = " ".join(
        f"{int(round((G.ORIGIN_X + x) * 1000))} {int(round(-(G.ORIGIN_Y + y) * 1000))}"
        for x, y in ring + [ring[0]])
    text, n = re.subn(r"\(path pcb 0 [^)]*\)", f"(path pcb 0 {coords})", text)
    if n != 1:
        raise SystemExit("Umrandung im DSN nicht gefunden")
    dsn.write_text(text)


def run_freerouting(jar: pathlib.Path, major: int) -> None:
    cmd = ["java", "-Djava.awt.headless=true", "-jar", str(jar),
           "-de", str(DSN), "-do", str(SES), "-mp", str(MAX_PASSES)]
    if major >= 2:
        # 2.x startet sonst eine Oberfläche und bricht ohne Bildschirm ab.
        cmd.append("--gui.enabled=false")
    if major < 2:
        # 1.9.0 baut auch im Stapelbetrieb intern eine Oberfläche auf und
        # braucht deshalb einen Bildschirm.
        if not shutil.which("xvfb-run"):
            raise SystemExit(
                "Freerouting 1.x braucht einen Bildschirm.\n"
                "  sudo apt install xvfb\n"
                "Besser: Java 25 installieren und Freerouting 2.x nutzen —\n"
                "  sudo apt install openjdk-25-jre-headless")
        cmd = ["xvfb-run", "-a"] + cmd

    print("  " + " ".join(cmd[:4]) + " …")
    res = subprocess.run(cmd, capture_output=True, text=True, timeout=3600)
    noise = ("analytics", "Segment", "trackAnonymous", "multi-release")
    for line in (res.stdout + res.stderr).splitlines():
        if line.strip() and not any(n in line for n in noise) \
                and not line.startswith(("\tat ", "  at ")):
            print("  " + line)
    if not SES.exists():
        raise SystemExit("Freerouting hat keine Sitzungsdatei erzeugt")


def stitch_planes(board) -> dict[str, tuple[int, int]]:
    """Versorgungspads über Durchkontaktierungen an ihre Innenlage binden.

    Freerouting behandelt In1.Cu und In2.Cu als Versorgungslagen und lässt sie
    unangetastet — es setzt dorthin aber auch keine Durchkontaktierungen. Die
    Pads von +3V3 und GND blieben sonst unverbunden.

    Die Hinderniskarte enthält hier zusätzlich die eben importierten Bahnen und
    Vias, damit die Stützvias nicht in fertige Verdrahtung gesetzt werden.
    """
    import route_pcb as R

    stack = board.GetEnabledLayers().CuStack()
    layers = [stack[0], stack[-1]]
    obs = R.collect_geometry(board, layers)

    for item in board.GetTracks():
        net = item.GetNetname() or "__anon"
        if item.Type() == pcbnew.PCB_VIA_T:
            pos = item.GetPosition()
            x = pcbnew.ToMM(pos.x) - R.ORIGIN_X
            y = pcbnew.ToMM(pos.y) - R.ORIGIN_Y
            for layer in layers:
                obs.add_rect(layer, x, y, x, y, net, R.INFLATE_VIA)
        else:
            s, e = item.GetStart(), item.GetEnd()
            x0, x1 = sorted((pcbnew.ToMM(s.x) - R.ORIGIN_X,
                             pcbnew.ToMM(e.x) - R.ORIGIN_X))
            y0, y1 = sorted((pcbnew.ToMM(s.y) - R.ORIGIN_Y,
                             pcbnew.ToMM(e.y) - R.ORIGIN_Y))
            obs.add_rect(item.GetLayer(), x0, y0, x1, y1, net, R.INFLATE_TRACK)

    pads_by_net: dict[str, list] = {}
    for fp in board.GetFootprints():
        for pad in fp.Pads():
            if pad.GetNetname():
                pads_by_net.setdefault(pad.GetNetname(), []).append(pad)

    result = {}
    # Nur noch Masse: +3V3 wird seit dem Wegfall der 3,3-V-Fläche wie jedes
    # andere Netz geroutet.
    for net_name in ("GND",):
        pads = pads_by_net.get(net_name, [])
        result[net_name] = R.stitch_plane_net(board, obs, net_name, pads, layers)

    grid = R.stitch_ground_grid(board, obs, layers)
    result["Raster"] = (grid, 0)
    return result


def anchor_islands(board, layers, rounds: int = 8) -> int:
    """Teilflächen ohne eigene Durchkontaktierung nachträglich anbinden.

    Die Auffüllung auf den Außenlagen zerfällt durch die Leiterbahnen in
    Teilflächen. Enthält eine davon weder einen Pad noch eine
    Durchkontaktierung, hängt sie an nichts — der DRC meldet sie als fehlende
    Verbindung. Ein gleichmäßiges Via-Raster erwischt nicht jede; hier wird
    deshalb gezielt in jede verwaiste Fläche eine gesetzt.

    Erst nach dem Füllen möglich, weil die Teilflächen vorher nicht existieren.
    Mehrere Runden, weil jede neue Durchkontaktierung die Auffüllung verändert.
    """
    import route_pcb as R
    net_obj = board.FindNet("GND")
    added = 0

    for _ in range(rounds):
        pcbnew.ZONE_FILLER(board).Fill(board.Zones())
        anchors = [t.GetPosition() for t in board.GetTracks()
                   if t.Type() == pcbnew.PCB_VIA_T and t.GetNetname() == "GND"]
        anchors += [pad.GetPosition() for fp in board.GetFootprints()
                    for pad in fp.Pads() if pad.GetNetname() == "GND"]

        obs = R.collect_geometry(board, layers)
        for item in board.GetTracks():
            name = item.GetNetname() or "__anon"
            if item.Type() == pcbnew.PCB_VIA_T:
                pos = item.GetPosition()
                x = pcbnew.ToMM(pos.x) - R.ORIGIN_X
                y = pcbnew.ToMM(pos.y) - R.ORIGIN_Y
                for layer in layers:
                    obs.add_rect(layer, x, y, x, y, name, R.INFLATE_VIA)
            else:
                s, e = item.GetStart(), item.GetEnd()
                x0, x1 = sorted((pcbnew.ToMM(s.x) - R.ORIGIN_X,
                                 pcbnew.ToMM(e.x) - R.ORIGIN_X))
                y0, y1 = sorted((pcbnew.ToMM(s.y) - R.ORIGIN_Y,
                                 pcbnew.ToMM(e.y) - R.ORIGIN_Y))
                obs.add_rect(item.GetLayer(), x0, y0, x1, y1, name,
                             R.INFLATE_TRACK)

        orphans = 0
        for zone in board.Zones():
            layer = zone.GetLayer()
            if zone.GetNetname() != "GND" or layer not in layers:
                continue
            poly = zone.GetFilledPolysList(layer)
            for i in range(poly.OutlineCount()):
                if any(poly.Contains(a, i) for a in anchors):
                    continue
                orphans += 1
                bb = poly.Outline(i).BBox()
                placed = False
                x0 = pcbnew.ToMM(bb.GetLeft()) - R.ORIGIN_X
                y0 = pcbnew.ToMM(bb.GetTop()) - R.ORIGIN_Y
                x1 = pcbnew.ToMM(bb.GetRight()) - R.ORIGIN_X
                y1 = pcbnew.ToMM(bb.GetBottom()) - R.ORIGIN_Y
                cx0, cy0 = R.to_cell(x0, y0)
                cx1, cy1 = R.to_cell(x1, y1)
                for cx in range(cx0, cx1 + 1, 2):
                    for cy in range(cy0, cy1 + 1, 2):
                        vx, vy = R.to_mm(cx, cy)
                        pt = pcbnew.VECTOR2I(pcbnew.FromMM(R.ORIGIN_X + vx),
                                             pcbnew.FromMM(R.ORIGIN_Y + vy))
                        if not poly.Contains(pt, i):
                            continue
                        if obs.via_blocked(cx, cy, "GND", R.STITCH_VIA_D):
                            continue
                        R.add_via(board, net_obj, vx, vy, layers,
                                  R.STITCH_VIA_D, R.STITCH_VIA_DRILL)
                        inflate = (R.STITCH_VIA_D / 2 + R.CLEARANCE
                                   + R.TRACK_W / 2 + R.MARGIN)
                        for lay in layers:
                            obs.add_rect(lay, vx, vy, vx, vy, "GND", inflate)
                        added += 1
                        placed = True
                        break
                    if placed:
                        break
        if orphans == 0:
            break
    return added


def import_ses(board_file: pathlib.Path, ses: pathlib.Path) -> tuple[int, int]:
    board = pcbnew.LoadBoard(str(board_file))
    if not pcbnew.ImportSpecctraSES(board, str(ses)):
        raise SystemExit("Import der Sitzungsdatei fehlgeschlagen")

    for net_name, (done, failed) in stitch_planes(board).items():
        state = "alle" if not failed else f"{failed} ohne Platz"
        print(f"  Fläche {net_name:<6} {done:3d} Pads angebunden ({state})")

    stack = board.GetEnabledLayers().CuStack()
    # Jede neue Durchkontaktierung verändert die Auffüllung und kann neue
    # Teilflächen erzeugen — deshalb wiederholt, bis nichts mehr übrig ist.
    extra = anchor_islands(board, [stack[0], stack[-1]])
    print(f"  Teilflächen nachträglich angebunden: {extra}")

    # Konnektivität neu aufbauen, bevor gefüllt wird: die eben eingefügten
    # Durchkontaktierungen sind dem Verbindungsmodell sonst unbekannt, und die
    # Flächen werden dann als voneinander getrennt gefüllt.
    board.BuildListOfNets()
    board.BuildConnectivity()
    pcbnew.ZONE_FILLER(board).Fill(board.Zones())
    board.BuildConnectivity()
    board.Save(str(board_file))

    tracks = sum(1 for t in board.GetTracks() if t.Type() == pcbnew.PCB_TRACE_T)
    vias = sum(1 for t in board.GetTracks() if t.Type() == pcbnew.PCB_VIA_T)
    return tracks, vias


def main() -> int:
    jar, major = find_jar()
    print(f"Freerouting: {jar.name} (Hauptversion {major})")
    if not java_ok(jar):
        raise SystemExit(
            f"{jar.name} ist gegen eine neuere Java-Version übersetzt als die "
            "installierte.\n  sudo apt install openjdk-25-jre-headless")

    print("Exportiere Specctra-DSN …")
    export_dsn(BOARD_FILE, DSN)
    print(f"  {DSN.name}, Innenlagen als Versorgungslagen markiert")

    print(f"Route (bis zu {MAX_PASSES} Durchläufe) …")
    run_freerouting(jar, major)

    print("Importiere Sitzung und fülle Flächen …")
    tracks, vias = import_ses(BOARD_FILE, SES)
    print(f"  {tracks} Leiterbahnen, {vias} Durchkontaktierungen")
    print(f"\ngespeichert: {BOARD_FILE.name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
