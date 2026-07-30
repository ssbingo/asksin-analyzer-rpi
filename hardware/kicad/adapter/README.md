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

| Ref | Bauteil | Lage | JLCPCB |
| --- | --- | --- | --- |
| **J1** | Buchsenleiste **2×20**, RM 2,54, gerade, Höhe 8,5 mm | **unten** (Körper zeigt zum PoE-HAT) | **C2977589** (ZHOURI), Extended |
| **J2** | Stiftleiste **2×20**, RM 2,54, gerade, Steckstift 6 mm | **oben** (Körper zeigt zur Analyzer-Platine) | **C50980** (BOOMELE), Extended |

Beides gewöhnliche Massenware. Ausdrücklich **keine Stapelbuchsen**, keine
besonderen Pinlängen — es gibt nichts, was in der Höhe zueinander passen
müsste.

> **Zur Teileauswahl (Stand 30.07.2026):** Die naheliegende Buchsenleiste
> C50982 führt LCSC derzeit als „not available"; deshalb C2977589 mit rund
> 47 000 Stück auf Lager. Beide Positionen sind bei JLCPCB als *Extended*
> geführt (einmalige Einrichtungsgebühr je Teil) und laut Teileseite per
> **Wellenlöten** in Economic *und* Standard PCBA bestückbar.

## Komplettbestückung bei JLCPCB

Möglich — aber es gibt eine Bedingung, die man kennen muss: Die beiden
Leisten sind bedrahtet und sitzen auf **verschiedenen Seiten** der Platine.
Das geht nur mit **Standard PCBA**, das laut Fähigkeitsübersicht „single &
double sided placement (SMT/Thru-hole)" beherrscht; die günstigere
Economic-Variante bestückt nur eine Seite.

Hochladen:

| Schritt | Datei |
| --- | --- |
| Platine | Inhalt von [`fab/gerber/`](fab/gerber/) bzw. das komplette [Fertigungspaket](fab/AskSin-Adapter-J1-fertigung.zip) |
| BOM | [`fab/jlcpcb_bom.csv`](fab/jlcpcb_bom.csv) |
| CPL | [`fab/jlcpcb_cpl.csv`](fab/jlcpcb_cpl.csv) |

Die CPL nennt für J1 ausdrücklich `bottom` und für J2 `top` — beides muss in
der Bestückungsvorschau so ankommen. Weil beide Leisten symmetrische Blöcke
sind, wäre ein Drehfehler um 180° folgenlos; entscheidend ist nur, dass jede
Leiste längs auf ihrer Padreihe liegt und auf der richtigen Seite sitzt.
Pin 1 ist auf beiden Seiten im Bestückungsdruck markiert.

**Die Alternative:** nur die nackte Platine bestellen (ein paar Euro für
fünf Stück) und die zwei Leisten selbst löten. 80 Lötstellen je Platine, aber
ohne Einrichtungsgebühren und ohne Rückfragen zur beidseitigen Bestückung.

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
