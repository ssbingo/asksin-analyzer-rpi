# Das Skript für die CCU

Damit der Analyzer statt `1A2B3C` den Namen `Wohnzimmer Fenster` anzeigen
kann, braucht er die Geräteliste Ihrer Zentrale. Die CCU gibt sie nicht von
sich aus heraus — sie muss dazu einmal aufgefordert werden.

Genau das tut [`geraeteliste-erzeugen.txt`](geraeteliste-erzeugen.txt).

## Was das Skript macht

1. Es legt auf der CCU eine **Systemvariable** `AskSinAnalyzerDevList` an
   (falls sie noch nicht existiert).
2. Es geht alle angelernten Geräte durch und schreibt Funkadresse,
   Seriennummer und Namen als Liste in diese Variable.
3. Der Analyzer liest diese Variable ab und ordnet damit den Telegrammen
   Namen zu.

**Es ändert nichts an Ihrer Anlage.** Keine Geräte, keine Programme, keine
Kanäle — es liest und legt eine einzige Variable an.

## Schritt für Schritt

Ausführlich und bebildert steht das im Handbuch, Kapitel 12.2. In Kürze:

| | |
| --- | --- |
| 1 | In der CCU-Oberfläche: **Einstellungen → Systemsteuerung → Zentralenwartung → Skript testen** |
| 2 | Den vollständigen Inhalt von `geraeteliste-erzeugen.txt` hineinkopieren |
| 3 | **Ausführen** — unten erscheint die erzeugte Liste |
| 4 | Im Analyzer: *Einstellungen → Standort & Zentrale* → **CCU-Verbindung testen** |

Der Test sagt Ihnen dann, wie viele Geräte gefunden wurden.

## Einmal genügt nicht

Die Liste ist eine Momentaufnahme. Lernen Sie später ein Gerät an, fehlt es
im Analyzer, bis das Skript erneut läuft.

Deshalb: auf der CCU ein **Programm** anlegen, das täglich läuft
(*Programme und Verknüpfungen → Neu*, Auslöser „Zeitsteuerung, täglich",
Aktivität „Skript" mit demselben Inhalt). Der Verbindungstest im Analyzer
warnt, wenn die Liste älter als einen Tag ist — dann fehlt genau dieses
Programm.

## Herkunft und Lizenz

Das Skript stammt **nicht** aus diesem Projekt.

| | |
| --- | --- |
| Werk | `additional/ccu_create_devlist.txt` aus [jp112sdl/AskSinAnalyzer](https://github.com/jp112sdl/AskSinAnalyzer) |
| Urheber | © jp112sdl |
| Lizenz | [CC BY-NC-SA 3.0](https://creativecommons.org/licenses/by-nc-sa/3.0/) |
| Änderungen | **keine** — Wort für Wort übernommen, nur die Datei umbenannt |

Es liegt hier bei, weil die Einrichtung sonst an einer toten Verweisstelle
hängt: Das Handbuch nannte „CCU-Skript im Repo", und im Repo war keines.

Wie bei der Firmware gilt: **Für gewerbliche und behördliche Nutzung ist
dieses Werk nicht frei.** Es steht unter CC BY-NC-SA 3.0 und damit **nicht**
unter der MIT-Lizenz der Web-UI oder der CC BY-NC-SA 4.0 des übrigen
Projekts.
