# Firmware für den Sniffer-Mikrocontroller

Hier liegen die fertig kompilierten HEX-Dateien für den ATmega328P auf der
Platine. Sie werden über die Weboberfläche des Analyzers aufgespielt
(*Info → Sniffer-Firmware*); wie man sie erzeugt, steht im Handbuch,
Abschnitt 11.3.

## Warum überhaupt hier?

Der Quelltext der Firmware liegt im Projekt, aus dem sie stammt — dort gibt es
aber nur die `.ino`. Eine HEX-Datei muss jeder selbst kompilieren, und zwar
mit **genau** den Board-Einstellungen aus Handbuch 7.4 (MiniCore, ATmega328,
External 8 MHz). Wer das einmal getan hat, will es nicht bei jedem Gerät
wiederholen.

Deshalb dieses Verzeichnis: **eine geprüfte Datei, fünfmal aufgespielt.** Bei
fünf Analyzern im Verbund ist das der Unterschied zwischen einer Viertelstunde
und einem Nachmittag.

## Was hier hineingehört

| | |
| --- | --- |
| Ja | Die Variante **ohne** `with_bootloader` im Namen |
| Nein | Die Variante **mit** Bootloader — sie überschreibt genau den Teil, der das Update entgegennimmt |
| Nein | `.ino`, `.elf`, `.bin` oder Zwischenstände des Compilers |

## Benennung

```
asksin-sniffer-<jahr><monat><tag>-8mhz.hex
```

Zum Beispiel `asksin-sniffer-20260803-8mhz.hex`. Das Datum ist die einzige
verlässliche Kennung: Die Firmware selbst trägt keine Versionsnummer, und
„neu.hex" sagt nach dem dritten Mal nichts mehr.

Der Takt gehört in den Namen, weil er **fest im Maschinencode steckt**. Eine
Datei für 16 MHz auf einem 8-MHz-Aufbau ergibt ein Gerät, das nur
Buchstabensalat sendet — und dieser Fehler ist von außen nicht zu sehen.

Zu jeder Datei gehört ein Eintrag in der Tabelle unten. Ohne ihn weiß in einem
halben Jahr niemand mehr, was drinsteckt.

## Vor dem Aufspielen prüfen

```bash
python3 firmware/pruefe-hex.py firmware/asksin-sniffer-20260803-8mhz.hex
```

Der Analyzer prüft beim Hochladen nur, ob die Datei überhaupt nach Intel-HEX
aussieht. Diese Prüfung geht weiter und fängt die beiden Fallen, die wirklich
weh tun:

- **Die Variante mit Bootloader.** Sie sieht genauso aus wie die richtige,
  reicht aber bis in den geschützten Speicherbereich. Über den Bootloader
  lässt sie sich nicht schreiben; der Versuch endet mit einer Fehlermeldung
  und einem halb beschriebenen Chip.
- **Ein abgebrochener Download.** Syntaktisch tadellos, nur eben zu kurz — und
  der Sniffer schweigt danach.

Zusätzlich werden alle Prüfsummen nachgerechnet, doppelt belegte Adressen
gemeldet und die Programmgröße gegen den verfügbaren Flash gehalten.

## Vorhandene Fassungen

| Datei | Stand | Programm | SHA-256 |
| --- | --- | --- | --- |
| `asksin-sniffer-20260803-8mhz.hex` | 03.08.2026 | 6 922 Byte, `0x0000`–`0x1b09` | `064de4ad…0848c8` |

Kompiliert aus dem **unveränderten** Sketch `AskSinSniffer328P` mit den
Board-Einstellungen aus Handbuch 7.4 (MiniCore, ATmega328, External 8 MHz).
Am Sketch selbst hat sich im Quellprojekt seit dem 04.10.2021 nichts geändert
(Commit `faa4c3e`).

Vollständige Prüfsumme:

```
064de4add8a84c79d2835120f5ac1b3ee4f250fc5c039ed44c937484ef0848c8
```

## Herkunft und Lizenz

Die Firmware stammt **nicht** aus diesem Projekt.

| | |
| --- | --- |
| Werk | `AskSinSniffer328P` aus [jp112sdl/AskSinAnalyzer](https://github.com/jp112sdl/AskSinAnalyzer) |
| Urheber | © jp112sdl |
| Lizenz | [CC BY-NC-SA 3.0](https://creativecommons.org/licenses/by-nc-sa/3.0/) |
| Änderungen | **keine** — der Sketch wurde unverändert kompiliert |

**Warum die Weitergabe erlaubt ist.** CC BY-NC-SA 3.0 gestattet ausdrücklich,
das Werk „in any medium or format" zu vervielfältigen und weiterzugeben. Eine
kompilierte Fassung ist genau das: dasselbe Werk in einem anderen Format. Die
drei Bedingungen der Lizenz sind erfüllt:

1. **Namensnennung** — Urheber, Quelle und Lizenz stehen in dieser Tabelle,
   in der `LICENSE` des Projekts und im Handbuch.
2. **Nicht kommerziell** — dieses Projekt steht selbst unter CC BY-NC-SA und
   wird nicht kommerziell verwertet.
3. **Weitergabe unter gleichen Bedingungen** — die HEX-Datei bleibt unter
   CC BY-NC-SA 3.0, also unter der Lizenz des Originals. Sie fällt
   **nicht** unter die MIT-Lizenz der Web-UI und auch nicht unter die
   CC BY-NC-SA 4.0 des übrigen Projekts.

Geprüft am 03.08.2026 gegen den Wortlaut der `LICENSE` im Quellprojekt:

> This software is licensed under CC BY-NC-SA 3.0.
> It is NOT free for commercial and governmental use!

Der zweite Satz ist zu beachten: **Für gewerbliche und behördliche Nutzung ist
diese Firmware nicht frei.** Wer den Analyzer in einem solchen Umfeld
einsetzen möchte, klärt das mit dem Urheber.
