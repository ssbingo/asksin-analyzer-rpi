# Firmware für den Sniffer-Mikrocontroller

Hier liegen die **Prüfwerkzeuge** für die HEX-Dateien des ATmega328P — nicht
mehr die Dateien selbst. Warum, steht gleich unten.

Der Quelltext der Firmware liegt in einem eigenen Projekt:
**[ssbingo/asksin-sniffer-firmware](https://github.com/ssbingo/asksin-sniffer-firmware)**.
Dort wird sie gebaut, dort liegen die Host-Tests, dort steht die Anleitung zum
Aufspielen. Das Handbuch führt in Kapitel 7 Schritt für Schritt durch den Weg
über Windows und die Arduino IDE.

## Warum hier keine fertige HEX-Datei mehr liegt

Bis zum 09.08.2026 lag hier `asksin-sniffer-20260803-8mhz.hex`, gebaut aus dem
Original-Sketch, byte-genau reproduzierbar, mit Prüfsumme in der
Dokumentation. Sie war **stumm**.

AskSinPP macht aus `DPRINT`, `DPRINTLN` und `DINIT` leere Makros, sobald
`NDEBUG` gesetzt ist. Für eine Bibliothek ist das richtig — dort ist `DPRINT`
Fehlersuche. Beim Sniffer ist es das Gegenteil: Telegramme, Rauschzeilen und
Versionsauskunft gehen **alle** über diese Makros. Und MiniCore setzt `NDEBUG`
fest, für jeden Übersetzungslauf:

```text
MiniCore/hardware/avr/3.1.2/platform.txt, Zeile 14
compiler.optimization_flags=-Os -DNDEBUG
```

Damit lief die Firmware einwandfrei und sendete nie ein Zeichen. Nicht einmal
`Serial.begin()` kam zustande, weil auch `DINIT` leer war; der Sendepin blieb
hochohmig, und von außen sah die Platine tot aus.

Aufgefallen ist es erst an Analyzer 05, der ersten echten Platine. Vorher lief
jeder Analyzer im Demo-Modus, und der öffnet gar keine serielle Schnittstelle
— der Fehler konnte neun Tage lang unbemerkt bleiben.

**Die Lehre:** Eine fertig gebaute Binärdatei auszuliefern, deren Bauumgebung
niemand nachvollzieht, ist die gefährlichere Bequemlichkeit. Größe, Adressen
und Prüfsumme stimmten alle — sie sagten nur nichts darüber, ob die Datei
funktioniert. Der Sketch hebt `NDEBUG` deshalb selbst auf, und `bauen.sh` im
Firmware-Projekt prüft nach jedem Bau, dass die Startkennung wirklich im
Ergebnis steht.

## Vor dem Aufspielen prüfen

Wer eine HEX-Datei irgendwoher bekommt — selbst gebaut, aus einem Repo, per
Mail —, prüft sie zuerst:

```bash
python3 firmware/pruefe-hex.py /pfad/zur/datei.hex
```

Das Skript erkennt vier Fallen, die alle gleich aussehen:

| Falle | Woran man sie sonst nicht erkennt |
| --- | --- |
| Variante **mit** Bootloader | Sieht identisch aus, überschreibt aber den Teil, der Updates entgegennimmt |
| Abgebrochener Download | Syntaktisch tadellos, nur zu kurz |
| Passt nicht in 32 KiB | Fällt erst beim Aufspielen auf |
| **Stumm gebaut** | Richtige Größe, richtige Adressen, läuft — und sendet nie etwas |

Die letzte ist die tückischste, und sie ist der Grund für dieses Verzeichnis.
Geprüft wird der **Inhalt**: Die Startkennung `AskSin++ v` muss als Text im
Programmabbild stehen. Fehlt sie, waren die Ausgabemakros leer.

## Board-Einstellungen prüfen

```bash
python3 firmware/pruefe-fqbn.py
```

Vergleicht jede FQBN in der Dokumentation gegen die Optionstabelle von
MiniCore 3.1.2 und besteht auf `clock=8MHz_external`, `variant=modelP` und
`LTO=Os_flto`. Die Tabelle ist mitgeliefert, das Skript braucht kein Netz.

Nötig geworden, weil im Handbuch monatelang `clock=external_8MHz` stand — eine
Schreibweise, die MiniCore nicht kennt und die nie funktioniert hat.

## Herkunft und Lizenz

Die Firmware ist eine abgewandelte Fassung von
[AskSinSniffer328P](https://github.com/jp112sdl/AskSinAnalyzer) von jp112sdl,
auf Basis von AskSin++ von papa.

**CC BY-NC-SA 3.0** — Weitergabe nur unter gleichen Bedingungen, und
ausdrücklich **nicht** für kommerzielle oder behördliche Nutzung. Das gilt
unverändert auch für unsere Fassung; Einzelheiten in `HERKUNFT.md` des
Firmware-Projekts.
