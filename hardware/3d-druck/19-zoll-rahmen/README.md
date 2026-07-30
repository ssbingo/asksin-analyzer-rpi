# 3D-Druck: 19″-Einbaurahmen

Druckvorlagen für den 19-Zoll-Rahmen, mit dem der Analyzer in den
Datenschrank einzieht.

> **Der Front-Einsatz gibt es in zwei Varianten** — `_RPI4` und `_RPI5`.
> Sie unterscheiden sich in der Frontplatte, weil Pi 4 und Pi 5 ihre
> Anschlüsse unterschiedlich anordnen. Rahmen und SSD-Einsatz sind für
> beide gleich. Silvios eigener Aufbau nutzt den **Pi 5** mit dem dazu
> passenden PoE-HAT.

## Herkunft und Lizenz

Die Vorlagen sind **abgeleitete Versionen** (Remixe) aus zwei Projekten:

- **Rahmen (Links/Mitte/Rechts) und Tray-Einsätze:** „19″ 1U Rack with
  Moduler trays for Raspberry Pis" von **Robert** (auf Thingiverse:
  Rob_Z71) —
  <https://www.printables.com/model/69176-19-1u-rack-with-moduler-trays-for-raspberry-pis>
  (auch auf Thingiverse: <https://www.thingiverse.com/thing:4886186>)
- **SSD-Einsatz:** „2.5 SSD/HDD Hot swap holder for Modular trays"
  von **balazsgrill** —
  <https://www.printables.com/model/1433279-25-ssdhdd-hot-swap-holder-for-modular-trays>

Beide Originale stehen unter **CC BY-NC-SA 4.0** (Namensnennung — nicht
kommerziell — Weitergabe unter gleichen Bedingungen). Wegen der
Share-Alike-Bedingung gilt für alle abgeleiteten Dateien in diesem
Verzeichnis dieselbe Lizenz: **CC BY-NC-SA 4.0** —
<https://creativecommons.org/licenses/by-nc-sa/4.0/>

Das fügt sich nahtlos in die Lizenzstrategie des Projekts: die
Analyzer-Hardware steht ohnehin unter CC BY-NC-SA 4.0.

## Die Teile

| Datei | Teil | Maße (BBox) |
| --- | --- | --- |
| `Asksin-Analyzer Rahmen 19Zoll-Links.stl` | Rahmen, linkes Segment | 169 × 50 × 76 mm |
| `Asksin-Analyzer Rahmen 19Zoll-Mitte.stl` | Rahmen, mittleres Segment | 149 × 50 × 76 mm |
| `Asksin-Analyzer Rahmen 19Zoll-Rechts.stl` | Rahmen, rechtes Segment | 169 × 50 × 76 mm |
| `Asksin-Analyzer Rahmen 19Zoll-SSD.stl` | Einsatz für den 2,5″-SSD-Wechselrahmen | 140 × 144 × 69 mm |
| `Asksin-Analyzer Rahmen 19Zoll-OLED-LED-SWITCH_RPI4.stl` | Front-Einsatz für OLED, Status-LED und Taster — **Raspberry Pi 4** | 140 × 40 × 69 mm |
| `Asksin-Analyzer Rahmen 19Zoll-OLED-LED-SWITCH_RPI5.stl` | dasselbe für den **Raspberry Pi 5** | 140 × 40 × 69 mm |

**Der reine Rahmen besteht aus drei Dateien:** Links + Mitte + Rechts —
zusammengesetzt ergeben sie die 19″-Front (169 + 149 + 169 mm ergeben mit
den Überlappungen die 482,6 mm eines 19-Zoll-Einschubs). SSD- und
OLED-LED-SWITCH-Einsatz kommen je nach Ausstattung dazu — vom
Front-Einsatz **genau eine** der beiden Varianten, passend zum verbauten Pi.

Die beiden Varianten sind außen maßgleich und unterscheiden sich fast
ausschließlich in der **Frontplatte**: 87 % der Geometrieunterschiede liegen
in den vordersten 6 mm, also bei den Ausschnitten. Innen sind sie bis auf
Kleinigkeiten identisch (Materialvolumen 36,2 gegen 36,3 cm³).

## Montage

### Einsatz OLED-LED-SWITCH — rechts im Rahmen

1. **Vor dem Einsetzen** OLED, WS2812B und Taster einbauen. OLED und
   WS2812B am besten mit etwas Heißkleber arretieren.
2. Der **Raspberry Pi 5 mit seinem PoE-HAT und der Analyzer-Platine**
   wird mit **M2-Schrauben von unten** an die Halterung geschraubt.
3. Im **oberen Teil** des Drucks sitzen **zwei Keystone-Module**:
   - 1 × **USB3/USB3**
   - 1 × **Antenne** — SMA oder RP-SMA, je nachdem, welchem Standard
     IPEX-Kabel und Antenne folgen
4. Verkabelung über die Keystones:
   - hinterer USB3-Anschluss ← SATA-USB-Kabel von der SSD;
     vorderer USB3-Anschluss → **15-cm-USB-Brückenkabel** zum Pi
   - Antenne genauso: hinten das IPEX-auf-SMA(RP-SMA)-Kabel,
     vorn die externe Antenne

### Einsatz SSD — mittig im Rahmen

1. Am **hinteren Ende** den **SATA-SATA-Adapter** befestigen.
2. Das **SATA-USB-Kabel** verbindet die SSD über den hinteren
   Keystone-Anschluss mit dem Pi.
3. Passende **2,5″-SSD-Wechselrahmen** kommen als Beispiel in den
   [Einkaufsführer](../../../docs/einkaufsfuehrer.md) — am schnellsten
   findet man sie bei AliExpress.

## Noch offen

- `druckhinweise.md` — Material, Schichthöhe, Ausrichtung, Stützen,
  Toleranzen (folgt aus den Erfahrungen der Testdrucke)
- Austausch-/Quellformate (`*.step`, bearbeitbares Original), falls
  vorhanden

## Prüfstand der Dateien

Geprüft am 30.07.2026 (binäres STL, Dreieckszahl gegen Dateigröße,
Kantenpaarung, Materialvolumen):

| Datei | Dreiecke | Volumen | Netz |
| --- | ---: | ---: | --- |
| Links | 1 200 | 95,9 cm³ | geschlossen |
| Mitte | 1 392 | 87,6 cm³ | geschlossen |
| Rechts | 1 480 | 96,0 cm³ | geschlossen¹ |
| SSD | 3 880 | 59,4 cm³ | geschlossen |
| OLED-LED-SWITCH RPI4 | 6 658 | 36,2 cm³ | geschlossen¹ |
| OLED-LED-SWITCH RPI5 | 7 226 | 36,3 cm³ | geschlossen¹ |

¹ Diese Dateien enthalten drei bis vier **entartete Dreiecke** (drei Punkte
auf einer Linie, Fläche null). Jeder Slicer verwirft sie stillschweigend;
sie sind kein Loch im Netz und kein Grund, etwas zu ändern. Nur der Vollständigkeit
halber vermerkt, damit eine entsprechende Meldung im Slicer niemanden beunruhigt.

Gesamtmaterial für einen kompletten Analyzer (Rahmen + SSD- +
Front-Einsatz): rund 375 cm³ Vollkörper, also je nach Füllgrad grob
150–250 g Filament.

## Rahmenbedingungen

- Befestigung der Platine über die vier Bohrungen MH1–MH4 (M2,5,
  Lochabstände in [`../../README.md`](../../README.md), Abschnitt Platine)
- Antennenbuchse (SMA-Einbau), Zugentlastung und SSD brauchen Platz im
  Rahmen — Maße siehe Hardware-Spezifikation
- Zubehör wie SSD-Wechselrahmen und Keystone-Module sind im
  Einkaufsführer beschrieben: [`../../../docs/einkaufsfuehrer.md`](../../../docs/einkaufsfuehrer.md)
