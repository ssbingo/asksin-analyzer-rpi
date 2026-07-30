# J1-Rettungsadapter (für Platinen-Chargen der Hardware v0.0.1)

> ⚠️ **Warum es dieses Bauteil gibt:** Auf allen 2026 gefertigten Platinen der
> Hardware v0.0.1 ist die 2×20-Buchse J1 **gespiegelt**. Direkt auf den Pi
> gesteckt verrutscht die Platine um eine Rasterposition — 5 V landet auf
> 3,3 V, Masse auf GPIOs. **Diese Chargen niemals ohne Adapter aufstecken
> und einschalten.** Mit dem Adapter sind die Platinen voll funktionsfähig.

## Wie er funktioniert

Der Fehler ist eine reine Reihenvertauschung: Die **ungerade** Pin-Reihe
(1, 3, 5 …) der Platine sitzt exakt richtig, nur die **gerade** Reihe
(2, 4, 6 …) liegt 2,54 mm auf der falschen Seite. Der Adapter versetzt
deshalb auch nur die gerade Reihe — die ungerade reicht er unverändert
durch. Daraus ergeben sich **drei einreihige** Leisten statt einer
zweireihigen:

| Ref | Reihe | Bauteil | Aufgabe |
| --- | --- | --- | --- |
| **J1** | 4,77 mm | Stapelbuchse 1×20 (lange Pins) | steckt unten auf den ungeraden Pi-Pins; dieselben Pins ragen oben durch und tragen dort die ungerade Reihe der Analyzer-Platine |
| **J2** | 2,23 mm | Buchsenleiste 1×20, **nicht** stapelbar | steckt auf den geraden Pi-Pins, oben bündig |
| **J3** | 7,31 mm | Stiftleiste 1×20 nach oben | bekommt die geraden Signale von J2 über kurze Leiterbahnen — dort erwartet die Analyzer-Platine ihre (verrutschte) gerade Reihe |

> ⚠️ **J2 darf keine Stapelbuchse sein.** Ragten ihre Pins nach oben, träfen
> sie auf der Analyzer-Platine auf blankes Basismaterial — dort ist kein
> Loch — und die Platine könnte nicht aufsitzen.

Die Analyzer-Platine steckt dann ganz normal (Bestückungsseite oben) auf dem
Adapter: Jedes Pad liegt auf seinem richtigen Pi-Pin, und die Montagelöcher
MH1/MH2 fluchten wieder exakt mit den Abstandsbolzen des Pi.
**Mehrhöhe des Stapels: rund 10 mm** (bei der Tray-Höhe im 19″-Rahmen
berücksichtigen).

## Fertigung und Bestückung

- **Platine:** 65 × 12 mm, 2 Lagen. Gerber + Bohrdaten in
  [`fab/gerber/`](fab/gerber/), fertiges Upload-Paket:
  [`fab/AskSin-Adapter-J1-fertigung.zip`](fab/AskSin-Adapter-J1-fertigung.zip)
  — als einfachste 2-Lagen-Platine bei jedem Hersteller wenige Euro für
  alle fünf.
- **Bestückung von unten (Pi-Seite):** J1 und J2 werden so eingesetzt, dass
  ihre Buchsenkörper **nach unten** zeigen. Bei J1 (Stapelbuchse) ragen die
  langen Pins oben heraus und werden oben verlötet; bei J2 wird von oben
  verlötet, oben bleibt nichts stehen.
- **Bestückung von oben:** J3 von oben einsetzen, unten verlöten.
- Die drei Leisten stehen im 2,54-Raster unmittelbar nebeneinander, ihre
  Kunststoffkörper stoßen aneinander — genau wie bei einer zweireihigen
  Leiste. Das ist so gewollt.
- Bestückungsseite ist eindeutig beschriftet: oben „Analyzer oben
  aufstecken", unten „Pi-Header unten".

## Prüfung

Erzeugt aus [`generate_adapter.py`](generate_adapter.py) (Maße aus der
offiziellen KiCad-Vorlage `RaspberryPi-HAT`, im Skript automatisch
gegengeprüft). DRC: 0 Fehler, 0 Warnungen, 0 offene Verbindungen.
Layout-Zeichnung: [`fab/adapter-layout.pdf`](fab/adapter-layout.pdf)

Vor dem ersten Einschalten mit Multimeter gegenprüfen (Adapter gesteckt,
Analyzer-Platine gesteckt, Pi **aus**): Durchgang von Pi-Pin 2 (5 V) zum
Eingang von U1 auf der Analyzer-Platine (TP-Belegung im Hardware-README)
und **kein** Durchgang von Pi-Pin 1 (3V3) nach Masse.
