# 3D-Druck: 19″-Einbaurahmen

Hier kommen die Druckvorlagen für den 19-Zoll-Rahmen hin, mit dem der
Analyzer (Raspberry Pi 4 + HAT, Boot-SSD) in den Datenschrank einzieht.

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
| `Asksin-Analyzer Rahmen 19Zoll-OLED-LED-SWITCH.stl` | Front-Einsatz für OLED, Status-LED und Taster | 140 × 40 × 69 mm |

**Der reine Rahmen besteht aus drei Dateien:** Links + Mitte + Rechts —
zusammengesetzt ergeben sie die 19″-Front. SSD- und OLED-LED-SWITCH-Einsatz
kommen je nach Ausstattung des Analyzers dazu.

## Montage

### Einsatz OLED-LED-SWITCH — rechts im Rahmen

1. **Vor dem Einsetzen** OLED, WS2812B und Taster einbauen. OLED und
   WS2812B am besten mit etwas Heißkleber arretieren.
2. Der **Raspberry Pi 5 mit PoE-HAT und der Analyzer-Platine** wird mit
   **M2-Schrauben von unten** an die Halterung geschraubt.
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

## Rahmenbedingungen

- Befestigung der Platine über die vier Bohrungen MH1–MH4 (M2,5,
  Lochabstände in [`../../README.md`](../../README.md), Abschnitt Platine)
- Antennenbuchse (SMA-Einbau), Zugentlastung und SSD brauchen Platz im
  Rahmen — Maße siehe Hardware-Spezifikation
- Zubehör wie SSD-Wechselrahmen und Keystone-Module sind im
  Einkaufsführer beschrieben: [`../../../docs/einkaufsfuehrer.md`](../../../docs/einkaufsfuehrer.md)
