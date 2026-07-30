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
