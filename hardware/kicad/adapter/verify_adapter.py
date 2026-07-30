#!/usr/bin/env python3
"""
Prüft den J1-Adapter unabhängig vom Erzeuger-Skript: Passt er wirklich?

Zwei Fragen, beide rein geometrisch beantwortet — für **alle 40 Pins**:

  A) Deckt sich die Adapter-Unterseite mit dem Steckbild des Raspberry Pi
     (also dem durchgeschleiften Header des PoE-HAT)?
     Quelle: offizielle KiCad-Vorlage `RaspberryPi-HAT`.

  B) Deckt sich die Adapter-Oberseite mit dem Steckbild der **gefertigten**
     Platine v0.0.1?
     Quelle: der Platinenstand aus dem Git-Tag `hardware-v0.0.1` — also
     genau das, was beim Fertiger lag, nicht der heutige Entwurf.

Bestanden ist die Prüfung nur, wenn sich beide Steckbilder durch **einen
einzigen** Versatz zur Deckung bringen lassen. Gäbe es mehr als einen, säße
mindestens ein Pin auf dem falschen Signal — genau der Fehler, um den es
hier geht.

Aufruf:
    python3 verify_adapter.py
"""

from __future__ import annotations

import pathlib
import subprocess
import sys
import tempfile

import pcbnew

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parents[2]
ADAPTER = HERE / "AskSin-Adapter-J1.kicad_pcb"
VORLAGE = pathlib.Path(
    "/usr/share/kicad/template/RaspberryPi-HAT/RaspberryPi-HAT.kicad_pcb")
ALT_TAG = "hardware-v0.0.1"
ALT_PFAD = "hardware/kicad/AskSin-Analyzer-V3.kicad_pcb"


def steckbild(board: pcbnew.BOARD, ref: str, nach_netz: bool) -> dict[int, tuple[float, float]]:
    """Pin-Nummer → Position, bezogen auf die vordere linke Platinenecke.

    `nach_netz`: Beim Adapter steht die Pin-Nummer im Netznamen (P1…P40),
    weil die Netze dort **nach Position** vergeben werden; bei Pi-Vorlage und
    Analyzer-Platine ist es die Pad-Nummer.
    """
    bb = board.GetBoardEdgesBoundingBox()
    ox, oy = pcbnew.ToMM(bb.GetLeft()), pcbnew.ToMM(bb.GetTop())
    fp = board.FindFootprintByReference(ref)
    if fp is None:
        raise SystemExit(f"{ref} nicht gefunden")
    bild = {}
    for pad in fp.Pads():
        nummer = int(pad.GetNetname()[1:]) if nach_netz else int(pad.GetNumber())
        pos = pad.GetPosition()
        bild[nummer] = (round(pcbnew.ToMM(pos.x) - ox, 2),
                        round(pcbnew.ToMM(pos.y) - oy, 2))
    if sorted(bild) != list(range(1, 41)):
        raise SystemExit(f"{ref}: unvollständiges Steckbild ({len(bild)} Pins)")
    return bild


def vergleiche(titel: str, a: dict, b: dict) -> bool:
    versatz = {(round(a[n][0] - b[n][0], 2), round(a[n][1] - b[n][1], 2))
               for n in range(1, 41)}
    if len(versatz) == 1:
        dx, dy = versatz.pop()
        print(f"  {titel}: PASST — einheitlicher Versatz "
              f"{dx:+.2f} / {dy:+.2f} mm über alle 40 Pins")
        return True
    print(f"  {titel}: **FEHLER** — {len(versatz)} verschiedene Versätze:")
    for n in range(1, 41):
        d = (round(a[n][0] - b[n][0], 2), round(a[n][1] - b[n][1], 2))
        if d != min(versatz):
            print(f"      Pin {n:>2}: {a[n]} gegen {b[n]}  →  {d}")
    return False


def alte_platine() -> pcbnew.BOARD:
    roh = subprocess.run(["git", "show", f"{ALT_TAG}:{ALT_PFAD}"],
                         cwd=REPO, capture_output=True, timeout=120)
    if roh.returncode != 0:
        raise SystemExit(f"Git-Tag {ALT_TAG} nicht lesbar: "
                         f"{roh.stderr.decode(errors='replace').strip()}")
    tmp = pathlib.Path(tempfile.mkdtemp()) / "v001.kicad_pcb"
    tmp.write_bytes(roh.stdout)
    return pcbnew.LoadBoard(str(tmp))


def main() -> int:
    if not VORLAGE.exists():
        raise SystemExit(f"KiCad-Vorlage fehlt: {VORLAGE}")

    adapter = pcbnew.LoadBoard(str(ADAPTER))
    print(f"Adapter : {ADAPTER.name}")
    print(f"Pi      : {VORLAGE.name} (offizielle KiCad-Vorlage)")
    print(f"Platine : {ALT_PFAD} aus Tag {ALT_TAG}\n")

    ok_a = vergleiche("A) Unterseite gegen Pi/PoE-HAT",
                      steckbild(adapter, "J1", nach_netz=True),
                      steckbild(pcbnew.LoadBoard(str(VORLAGE)), "J1", nach_netz=False))
    ok_b = vergleiche("B) Oberseite gegen die gefertigte Platine v0.0.1",
                      steckbild(adapter, "J2", nach_netz=True),
                      steckbild(alte_platine(), "J1", nach_netz=False))

    print()
    if ok_a and ok_b:
        print("Der Adapter passt auf beiden Seiten.")
        return 0
    print("Der Adapter passt NICHT. Nicht fertigen lassen.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
