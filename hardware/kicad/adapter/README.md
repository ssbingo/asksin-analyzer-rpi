# J1-Rettungsadapter (für Platinen-Chargen der Hardware v0.0.1)

> ⚠️ **Warum es dieses Bauteil gibt:** Auf allen 2026 gefertigten Platinen der
> Hardware v0.0.1 ist die 2×20-Buchse J1 **gespiegelt**. Direkt auf den Pi
> gesteckt verrutscht die Platine um eine Rasterposition — 5 V landet auf
> 3,3 V, Masse auf GPIOs. **Diese Chargen niemals ohne Adapter aufstecken
> und einschalten.** Mit dem Adapter sind die Platinen voll funktionsfähig.

## Wie er funktioniert

Der Fehler ist eine reine Reihenvertauschung: Die ungerade Pin-Reihe der
Platine sitzt exakt richtig, die gerade Reihe liegt 2,54 mm auf der falschen
Seite. Der Adapter korrigiert genau das:

- Unten eine 2×20-**Stapelbuchse** in korrekter HAT-Position → steckt normal
  auf dem durchgeschleiften Header des PoE-HAT.
- Die **ungeraden** Stifte (1–39) reichen unverändert nach oben durch.
- Die **geraden** Signale (2–40) laufen über kurze Leiterbahnen auf eine
  1×20-**Stiftleiste**, die 2,54 mm weiter innen sitzt — genau unter der
  gespiegelten geraden Reihe der Analyzer-Platine.

Die Analyzer-Platine steckt dann ganz normal (Bestückungsseite oben) auf dem
Adapter: Jedes Pad liegt auf seinem richtigen Pi-Pin, und die Montagelöcher
MH1/MH2 fluchten wieder exakt mit den Abstandsbolzen des Pi.
**Mehrhöhe des Stapels: rund 10 mm** (bei der Tray-Höhe im 19″-Rahmen
berücksichtigen).

## Fertigung und Bestückung

- **Platine:** 65 × 12 mm, 2 Lagen. Gerber + Bohrdaten in
  [`fab/gerber/`](fab/gerber/) — als einfachste 2-Lagen-Platine bei jedem
  Hersteller wenige Euro für alle fünf.
- **J1 (unten):** Stapelbuchse 2×20, RM 2,54 (z. B. „stacking header 2×20"
  mit langen Stiften, wie bei PoE-HATs üblich). **Kopfüber montieren:**
  Buchsenkörper zeigt nach unten (zum Pi), die langen Stifte ragen oben aus
  der Platine und werden oben verlötet.
- **J2 (oben):** normale Stiftleiste 1×20, RM 2,54, von oben bestücken,
  unten verlöten.
- Bestückungsseite ist eindeutig: der Bestückungsdruck oben sagt
  „Analyzer oben aufstecken", unten „Pi-Header unten".

## Prüfung

Erzeugt aus [`generate_adapter.py`](generate_adapter.py) (Maße aus der
offiziellen KiCad-Vorlage `RaspberryPi-HAT`, im Skript automatisch
gegengeprüft). DRC: 0 Fehler, 0 Warnungen, 0 offene Verbindungen.
Layout-Zeichnung: [`fab/adapter-layout.pdf`](fab/adapter-layout.pdf)

Vor dem ersten Einschalten mit Multimeter gegenprüfen (Adapter gesteckt,
Analyzer-Platine gesteckt, Pi **aus**): Durchgang von Pi-Pin 2 (5 V) zum
Eingang von U1 auf der Analyzer-Platine (TP-Belegung im Hardware-README)
und **kein** Durchgang von Pi-Pin 1 (3V3) nach Masse.
