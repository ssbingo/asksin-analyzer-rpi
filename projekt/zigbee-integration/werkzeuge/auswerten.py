#!/usr/bin/env python3
"""Wertet einen Mitschnitt des Zigbee-Mithoerers aus.

    python3 auswerten.py mitschnitt.jsonl [sekunden]

Erwartet zeilenweises JSON, wie es die Sniffer-Firmware ausgibt:

    {"L":74,"Q":255,"R":-85,"C":11,"S":"4188..."}

    L Laenge  Q LQI  R RSSI in dBm  C Kanal  S Paket in Hex

Wozu das gut ist
----------------
Die Rohzeilen beantworten nur „kommt etwas an". Interessant ist aber:
Ist es das EIGENE Netz? Wie viele Geraete sind zu hoeren? Wie stark?
Dafuer muss der MAC-Kopf nach IEEE 802.15.4 entschluesselt werden — und
genau dieser Decoder ist der Entwurf fuer M16.3 im Core.

Die Nutzdaten bleiben verschlossen (AES-CCM*); dieses Werkzeug liest
ausschliesslich den unverschluesselten Kopf. Ein Netzschluessel wird
weder gebraucht noch unterstuetzt.
"""

from __future__ import annotations

import json
import sys
from collections import Counter, defaultdict

TYP = {0: "Beacon", 1: "Daten", 2: "Bestätigung", 3: "Kommando"}
BROADCAST = 0xFFFF


def le(b: bytes) -> int:
    return int.from_bytes(b, "little")


def mac_kopf(roh: bytes) -> dict:
    """Entschluesselt den MAC-Kopf. Nur die Felder, die wir brauchen."""
    fcf = le(roh[0:2])
    d = {
        "typ": fcf & 7,
        "pan_komprimiert": (fcf >> 6) & 1,
        "ziel_modus": (fcf >> 10) & 3,
        "quell_modus": (fcf >> 14) & 3,
        "seq": roh[2],
    }
    i = 3
    if d["ziel_modus"] in (2, 3):
        d["pan"] = le(roh[i:i + 2]); i += 2
        n = 2 if d["ziel_modus"] == 2 else 8
        d["ziel"] = le(roh[i:i + n]); i += n
    if d["quell_modus"] in (2, 3):
        if not d["pan_komprimiert"]:
            d["quell_pan"] = le(roh[i:i + 2]); i += 2
        n = 2 if d["quell_modus"] == 2 else 8
        d["quell"] = le(roh[i:i + n]); i += n
    return d


def adr(a: int) -> str:
    return "Rundruf" if a == BROADCAST else f"0x{a:04X}"


def median(werte: list[int]) -> int:
    """Der mittlere Wert — unempfindlich gegen einzelne Ausreisser.

    Warum nicht Minimum und Maximum: Wer eine Stunde lang misst, sieht bei
    JEDEM Gerät irgendwann einen Ausreisser nach unten. Am 18.08.2026 stufte
    die erste Fassung dieses Werkzeugs ein Gerät mit 1300 Paketen und LQI 252
    als grenzwertig ein — weil ein einziges Paket mit −90 dBm ankam. Das ist
    keine Bewertung, das ist eine Eigenschaft der Messdauer.
    """
    s = sorted(werte)
    n = len(s)
    return s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) // 2


def main(argv: list[str]) -> int:
    if not argv:
        print(__doc__)
        return 1
    datei = argv[0]
    dauer = float(argv[1]) if len(argv) > 1 else 0.0

    rssi_alle: list[int] = []
    lqi_alle: list[int] = []
    kanaele: Counter = Counter()
    typen: Counter = Counter()
    pans: Counter = Counter()
    geraete: dict = defaultdict(lambda: {"n": 0, "rssi": [], "lqi": [], "rundruf": 0})
    dop_rundruf: Counter = Counter()
    dop_gezielt: Counter = Counter()
    ok = kaputt = kurz = 0

    for zeile in open(datei, errors="replace"):
        zeile = zeile.strip()
        if not zeile:
            continue
        try:
            d = json.loads(zeile)
            roh = bytes.fromhex(d["S"])
        except Exception:
            kaputt += 1
            continue
        ok += 1
        rssi_alle.append(d["R"]); lqi_alle.append(d["Q"]); kanaele[d["C"]] += 1

        if len(roh) < 5:
            kurz += 1
            continue
        try:
            m = mac_kopf(roh)
        except Exception:
            kaputt += 1
            continue
        typen[TYP.get(m["typ"], "?")] += 1
        # Bestaetigungen zaehlen hier NICHT mit. Eine Bestaetigung besteht aus
        # Rahmenkopf, Folgenummer und Pruefsumme — es gibt also nur rund 256
        # moegliche Muster. Bei 19 804 Bestaetigungen sind Doppelte damit
        # zwangslaeufig, ohne dass irgendetwas wiederholt wurde. Die erste
        # Fassung zaehlte sie mit und meldete 45 % Wiederholungen; tatsaechlich
        # waren es 12,5 %. Eine Kennzahl, die eine Bauarteigenschaft als
        # Netzproblem ausweist, ist schlimmer als gar keine.
        if m["typ"] != 2:
            (dop_rundruf if m.get("ziel") == BROADCAST else dop_gezielt)[d["S"]] += 1
        # Ein Beacon traegt keine Ziel-PAN, aber eine Quell-PAN — es gehoert
        # trotzdem zu einem Netz. Ohne die zweite Zeile fehlten hier genau die
        # sechs Beacons, die der TypeScript-Decoder zusaetzlich zaehlte
        # (4x 0x⟨PAN-A⟩, 2x 0x⟨PAN⟩). Der Quervergleich hat es sichtbar gemacht.
        pan = m.get("pan", m.get("quell_pan"))
        if pan is not None:
            pans[pan] += 1
        if "quell" in m:
            # Nach PAN getrennt fuehren. Die erste Fassung warf beide Netze
            # in einen Topf — dadurch tauchten Nachbargeraete in der Liste
            # des eigenen Netzes auf, und die Anzahl war zu hoch.
            g = geraete[(pan, m["quell"])]
            g["n"] += 1; g["rssi"].append(d["R"]); g["lqi"].append(d["Q"])
            if m.get("ziel") == BROADCAST:
                g["rundruf"] += 1

    if not ok:
        print("Keine lesbare Zeile gefunden.")
        return 1

    print("=" * 62)
    print(f"  Pakete lesbar        {ok}")
    print(f"  Zeilen unlesbar      {kaputt}")
    if dauer:
        print(f"  Rate                 {ok / dauer:.1f} Pakete/s")
    print(f"  Kanal                {', '.join(f'{k} ({v}x)' for k, v in kanaele.items())}")
    print(f"  RSSI                 {max(rssi_alle)} bis {min(rssi_alle)} dBm, "
          f"Mittel {round(sum(rssi_alle) / len(rssi_alle))}")
    print(f"  LQI                  {min(lqi_alle)} bis {max(lqi_alle)}, "
          f"Mittel {round(sum(lqi_alle) / len(lqi_alle))}")
    print(f"  Rahmentypen          {', '.join(f'{k} {v}' for k, v in sorted(typen.items()))}")

    # Wiederholungen getrennt zaehlen. Zigbee sendet Rundrufe bauartbedingt
    # mehrfach — die als Netzproblem zu lesen waere schlicht falsch. Nur die
    # Wiederholung einer GEZIELTEN Sendung ist ein Fehlversuch.
    wdh = lambda c: sum(n - 1 for n in c.values() if n > 1)  # noqa: E731
    r, gz = wdh(dop_rundruf), wdh(dop_gezielt)
    n_gezielt = sum(dop_gezielt.values())
    anteil = gz * 100 / n_gezielt if n_gezielt else 0.0
    print(f"  Wiederholungen       {gz} von {n_gezielt} gezielten Sendungen "
          f"({anteil:.1f} %) — echte Fehlversuche")
    print(f"                       {r} bei Rundrufen (ohne Bestätigungen "
          f"gerechnet, siehe Quelltext)")

    print()
    print("  PAN-Netze in Hörweite")
    haupt = pans.most_common(1)[0][0] if pans else None
    for p, n in pans.most_common():
        etikett = "  ← eigenes Netz" if p == haupt else "  ← fremdes Netz"
        print(f"    0x{p:04X} ({p:>5})  {n:>5} Pakete{etikett}")

    for pan, _ in pans.most_common():
        eigen = pan == haupt
        dazu = [(a, g) for (p, a), g in geraete.items() if p == pan]
        print()
        print(f"  Geräte in PAN 0x{pan:04X}"
              f"{' (eigenes Netz)' if eigen else ' (fremdes Netz)'}: {len(dazu)}")
        print(f"    {'Adresse':>9}  {'Pakete':>6}  {'RSSI':>6}  {'LQI':>4}"
              f"  {'Spanne':>12}  Bewertung")
        for a, g in sorted(dazu, key=lambda kv: -kv[1]["n"]):
            # Bewertet wird der Median, nicht der Ausreisser (siehe median()).
            rssi = median(g["rssi"])
            lqi = median(g["lqi"])
            if a == 0:
                note = "Koordinator"
            elif lqi < 50 or rssi < -88:
                note = "GRENZWERTIG"
            elif lqi < 200 or rssi < -80:
                note = "knapp"
            else:
                note = "gut"
            spanne = f"{max(g['rssi'])}..{min(g['rssi'])}"
            print(f"    {adr(a):>9}  {g['n']:>6}  {rssi:>6}  {lqi:>4}"
                  f"  {spanne:>12}  {note}")
    print("=" * 62)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
