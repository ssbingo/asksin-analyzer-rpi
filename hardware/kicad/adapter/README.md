# J1-Rettungsadapter (für Platinen der Hardware v0.0.1)

> ⚠️ **Warum es dieses Bauteil gibt:** Auf allen 2026 gefertigten Platinen
> (Bestückungsdruck „HW v0.0.1") ist die 2×20-Buchse J1 gespiegelt. Direkt auf
> den Pi gesteckt landet jedes Pad auf dem falschen Pi-Pin — 5 V auf 3,3 V,
> Masse auf GPIOs. **Diese Platinen niemals ohne Adapter aufstecken und
> einschalten.** Mit dem Adapter sind sie voll funktionsfähig.

## Das Fehlerbild, ausgemessen

Alle Maße ab der vorderen Platinenkante (der Kante, die beim Pi zur
Platinenkante zeigt):

| | gerade Pins (2, 4, 6 …) | ungerade Pins (1, 3, 5 …) |
| --- | --- | --- |
| Raspberry Pi / PoE-HAT | **2,23 mm** | 4,77 mm |
| Analyzer-Platine v0.0.1 | **7,31 mm** | 4,77 mm |

Die ungerade Reihe sitzt richtig; die gerade liegt nicht *zwischen* ungerader
Reihe und Kante, sondern dahinter. Kein einziger Pin trifft.

## Wie der Adapter das löst

Nicht durch Umsortieren einzelner Reihen, sondern indem das **ganze Steckbild
um 2,54 mm nach hinten versetzt** wird — dann stimmt die Reihenfolge wieder:

```text
    ┌───────────────────────────┐  Analyzer-Platine (v0.0.1)
    │  Buchse 2x20 (unten dran) │
    └──┬───────────────────────┬┘
       │ Stiftleiste 2x20      │     ← Adapter oben, Reihen 7,31 / 9,85 mm
    ┌──┴───────────────────────┴──┐
    │        A D A P T E R        │  65 × 14 mm, 2 Lagen
    └──┬───────────────────────┬──┘
       │ Buchsenleiste 2x20    │     ← Adapter unten, Reihen 2,23 / 4,77 mm
    ┌──┴───────────────────────┴──┐
    │  Stiftleiste des PoE-HAT    │
    └─────────────────────────────┘
```

Jeder Pin geht schnurstracks von unten nach oben: Pin n der Buchse auf Pin n
der Stiftleiste. Die ungeraden Bahnen laufen 2,54 mm auf der Oberseite, die
geraden 7,62 mm auf der Unterseite an den Pads vorbei. Keine Durchkontaktierung
nötig — bedrahtete Pads liegen ohnehin auf beiden Lagen.

## Stückliste — zwei Standardteile

| Ref | Bauteil | Lage |
| --- | --- | --- |
| **J1** | Buchsenleiste **2×20**, RM 2,54, gerade | **unten** montieren (Körper zeigt zum PoE-HAT), oben verlöten |
| **J2** | Stiftleiste **2×20**, RM 2,54, gerade | **oben** montieren, unten verlöten |

Beides gewöhnliche Massenware. Ausdrücklich **keine Stapelbuchsen**, keine
besonderen Pinlängen — es gibt nichts, was in der Höhe zueinander passen
müsste.

## Was der Adapter kostet

- **Bauhöhe:** rund 10 mm zusätzlich im Stapel. Bei der Tray-Höhe im
  19-Zoll-Rahmen berücksichtigen.
- **Versatz:** Die Analyzer-Platine sitzt **2,54 mm weiter hinten** als
  vorgesehen; ihre Bohrungen MH1/MH2 fluchten dann nicht mehr mit den
  Abstandsbolzen des Pi. Im 19-Zoll-Rahmen wird sie ohnehin an der
  Druckhalterung verschraubt; ansonsten helfen Nylon-Distanzstücke.

## Fertigung

2 Lagen, 65 × 14 mm — die einfachste Platine, die ein Hersteller anbietet.
Upload-Paket: [`fab/AskSin-Adapter-J1-fertigung.zip`](fab/AskSin-Adapter-J1-fertigung.zip),
Einzeldateien in [`fab/gerber/`](fab/gerber/), Lagenbild zur Kontrolle in
[`fab/adapter-layout.pdf`](fab/adapter-layout.pdf).

Die Bestückungsseite ist im Druck beschriftet: oben „Analyzer-Platine hier
oben aufstecken", unten „Diese Seite auf den PoE-HAT".

## Prüfung

Erzeugt von [`generate_adapter.py`](generate_adapter.py). Die Netze werden dort
**nach gemessener Pad-Position** vergeben, nicht nach Pad-Nummer — genau die
Verwechslung, an der die Platine v0.0.1 gescheitert ist, kann so nicht mehr
passieren.

Unabhängig davon prüft [`verify_adapter.py`](verify_adapter.py) das fertige
Layout gegen die beiden Gegenstücke und verlangt, dass sich beide Steckbilder
mit **einem einzigen** Versatz decken (jeder abweichende Pin wäre ein falsches
Signal):

```console
$ python3 verify_adapter.py
  A) Unterseite gegen Pi/PoE-HAT: PASST — einheitlicher Versatz +0.00 / +0.00 mm über alle 40 Pins
  B) Oberseite gegen die gefertigte Platine v0.0.1: PASST — einheitlicher Versatz +0.00 / +2.54 mm über alle 40 Pins

Der Adapter passt auf beiden Seiten.
```

Verglichen wird gegen die **offizielle KiCad-Vorlage `RaspberryPi-HAT`** und
gegen den Platinenstand aus dem Git-Tag `hardware-v0.0.1` — also gegen das,
was tatsächlich beim Fertiger lag, nicht gegen den heutigen Entwurf.
DRC: 0 Fehler, 0 Warnungen, 0 unverbundene Elemente.

Vor dem ersten Einschalten trotzdem mit dem Multimeter gegenprüfen (Adapter
gesteckt, Analyzer-Platine gesteckt, Pi **aus**): Durchgang von Pi-Pin 2 (5 V)
zum Eingang von U1 auf der Analyzer-Platine, und **kein** Durchgang zwischen
Pi-Pin 1 (3,3 V) und Masse.
