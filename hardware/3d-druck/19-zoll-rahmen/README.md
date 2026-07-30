# 3D-Druck: 19″-Einbaurahmen

Hier kommen die Druckvorlagen für den 19-Zoll-Rahmen hin, mit dem der
Analyzer (Raspberry Pi 4 + HAT, Boot-SSD) in den Datenschrank einzieht.

## Herkunft und Lizenz

Die Vorlagen sind **abgeleitete Versionen** (Remixe) aus zwei Projekten:

- **Rahmen und Trays:** „19″ 1U Rack with Moduler trays for Raspberry Pis"
  von **Robert** (auf Thingiverse: Rob_Z71) —
  <https://www.printables.com/model/69176-19-1u-rack-with-moduler-trays-for-raspberry-pis>
  (auch auf Thingiverse: <https://www.thingiverse.com/thing:4886186>)
- **SSD-Rahmen:** „2.5 SSD/HDD Hot swap holder for Modular trays"
  von **balazsgrill** —
  <https://www.printables.com/model/1433279-25-ssdhdd-hot-swap-holder-for-modular-trays>

Beide Originale stehen unter **CC BY-NC-SA 4.0** (Namensnennung — nicht
kommerziell — Weitergabe unter gleichen Bedingungen). Wegen der
Share-Alike-Bedingung gilt für alle abgeleiteten Dateien in diesem
Verzeichnis dieselbe Lizenz: **CC BY-NC-SA 4.0** —
<https://creativecommons.org/licenses/by-nc-sa/4.0/>

Das fügt sich nahtlos in die Lizenzstrategie des Projekts: die
Analyzer-Hardware steht ohnehin unter CC BY-NC-SA 4.0.

Die Vorlagen entstehen extern und werden eingecheckt, **sobald die ersten
Testdrucke erfolgreich waren** — bis dahin bleibt dieses Verzeichnis bis auf
diese Beschreibung leer.

## Geplante Ablage

| Datei | Inhalt |
| --- | --- |
| `*.stl` | druckfertige Teile, ein Teil je Datei |
| `*.step` | Austauschformat für eigene Anpassungen |
| Quelldatei (z. B. `*.FCStd`, `*.f3d`, `*.scad`) | das bearbeitbare Original |
| `druckhinweise.md` | Material, Schichthöhe, Ausrichtung, Stützen, Toleranzen |

Dazu je Teil eine kurze Notiz, was es ist und wie oft es gedruckt werden
muss (für den Verbund werden fünf Analyzer verbaut).

## Rahmenbedingungen

- Befestigung der Platine über die vier Bohrungen MH1–MH4 (M2,5,
  Lochabstände in [`../../README.md`](../../README.md), Abschnitt Platine)
- Antennenbuchse (SMA-Einbau), Zugentlastung und SSD brauchen Platz im
  Rahmen — Maße siehe Hardware-Spezifikation
- Zubehör wie SSD-Wechselrahmen und Keystone-Module sind im
  Einkaufsführer beschrieben: [`../../../docs/einkaufsfuehrer.md`](../../../docs/einkaufsfuehrer.md)
