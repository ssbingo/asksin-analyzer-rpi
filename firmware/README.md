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

| Datei | Stand | Quelle | Bemerkung |
| --- | --- | --- | --- |
| _(noch keine)_ | | | |

## Zur Lizenz

Die Firmware stammt nicht aus diesem Projekt. Bevor eine kompilierte Fassung
hier **eingecheckt** und damit öffentlich verbreitet wird, gehört geklärt, ob
ihre Lizenz das erlaubt und welche Hinweise mitzuliefern sind. Bis dahin
bleibt das Verzeichnis der Ablageort für den eigenen Gebrauch — die
`.gitignore` daneben hält HEX-Dateien deshalb vorerst aus der Versionierung
heraus.

Soll eine Datei mitgeliefert werden, wird die Zeile in der `.gitignore`
entfernt und hier der Lizenzhinweis der Quelle ergänzt.
