# Protokoll und Absturzsuche (Phase M13)

Anlass (31.07.2026): Ein Analyzer wurde nach einigen Stunden unerreichbar und
musste hart neu gestartet werden. Ohne Aufzeichnung ist so etwas nicht zu
finden — das Journal von systemd hilft nur, solange der Dienst selbst noch
schreibt, und überlebt ein hartes Einfrieren nur teilweise.

## Was mitgeschrieben wird

Neben den Dienstmeldungen erhebt der Analyzer **jede Minute** die Größen, an
denen sich ein Absturz im Nachhinein festmachen lässt:

| Größe | Warum sie zählt |
| --- | --- |
| **Unterspannung und Drosselung** (`vcgencmd get_throttled`) | Mit PoE-HAT und SSD am USB die häufigste Ursache für Einfrieren und harte Neustarts. Das Bitfeld unterscheidet „tritt gerade auf" von „ist seit dem Start schon einmal aufgetreten" — beides wird ausgewertet. |
| **Temperatur** | Ab etwa 80 °C drosselt der Pi, ab 85 °C hart. |
| **Arbeitsspeicher**, inkl. verfügbarem Speicher und Auslagerung | Wird der Speicher knapp, greift der OOM-Killer und der Dienst verschwindet ohne eigene Fehlermeldung. |
| **Freier Plattenplatz** | Eine volle Systempartition legt Dienste still. |
| **Systemlast und Laufzeit** | Ein Sprung der Laufzeit auf Sekunden beweist einen Neustart. |

Geschrieben wird sparsam: **alle 15 Minuten** eine Zeile, solange nichts
auffällt. Wird etwas auffällig, landet es **sofort und als Fehler** in der
Datei — also selbst bei der sparsamsten Stufe.

Zusätzlich hält der Dienst fest, was ihn selbst beendet: unbehandelte
Ausnahmen und Zusagen, sowie die Signale SIGHUP, SIGQUIT und SIGABRT.

## Einstellungen (Weboberfläche → **Wartung**)

| Einstellung | Bedeutung |
| --- | --- |
| **Fehler** | Nur Störungen. Kleinste Datei. |
| **Info** | Störungen und wichtige Ereignisse. Vorgabe. |
| **Debug** | Zusätzlich Abläufe im Inneren — für die Fehlersuche. |
| **Alles** | Auch Einzeltelegramme. Wächst schnell. |
| **Aufbewahrung** | 1–365 Tage; ältere Dateien werden beim Tageswechsel gelöscht. |

Beides wirkt sofort und wird dienst-schreibbar in
`/var/lib/asksin-analyzer/protokoll.json` abgelegt; `config.json` bleibt der
Experten-Weg (Abschnitt `"protokoll": { "stufe": …, "tage": … }`).

## Dateien

Eine Datei je Tag, `asksin-JJJJ-MM-TT.log`, in
`/var/lib/asksin-analyzer/protokoll/`. Umgeschaltet wird beim ersten Eintrag
nach Mitternacht — ohne eigenen Zeitgeber. Format mit festen Spalten, damit
`grep` und Auge gleichermaßen zurechtkommen:

```text
2026-07-31 08:12:33.123  FEHLER  [ingest]     Port weg (EIO)
2026-07-31 08:12:34.001  INFO    [system]     Temperatur 62,3 °C · Speicher frei 940 MB …
```

Heruntergeladen wird über **Wartung → Dateien**; der Endpunkt ist
`GET /api/protokoll/datei/<name>`. Der Name wird streng geprüft (nur
`asksin-JJJJ-MM-TT.log`) — sonst wäre der Download ein Pfad-Ausbruch.

## Wenn der Pi wieder aussteigt

1. **Wartung** öffnen, Stufe auf **Debug** stellen.
2. Nach dem nächsten Ausfall die Datei des Tages herunterladen.
3. Nach `FEHLER` und `[system]` suchen. Steht dort *Unterspannung*, ist die
   Stromversorgung die Ursache — dann hilft kein Software-Update, sondern ein
   kräftigeres Netzteil bzw. ein PoE-Injektor mit mehr Reserve.
4. Bricht das Protokoll **mitten im Betrieb** ab, ohne Fehlerzeile davor, war
   es kein Programmfehler: Dann hat das System selbst ausgesetzt (Kernel-Panik,
   Spannungseinbruch, Hardwaredefekt). Die letzten Systemzeilen davor zeigen,
   wie die Lage kurz vorher war.
