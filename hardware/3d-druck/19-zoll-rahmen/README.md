# 3D-Druck: 19″-Einbaurahmen

Hier kommen die Druckvorlagen für den 19-Zoll-Rahmen hin, mit dem der
Analyzer (Raspberry Pi 4 + HAT, Boot-SSD) in den Datenschrank einzieht.

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
