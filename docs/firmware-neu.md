# Die Sniffer-Firmware: Analyse und Projektplan

Stand 03.08.2026. Grundlage ist der Sketch `AskSinSniffer328P.ino` aus
[jp112sdl/AskSinAnalyzer](https://github.com/jp112sdl/AskSinAnalyzer),
88 Zeilen, zuletzt inhaltlich geändert am 04.10.2021.

Dieses Papier ist eine **Entscheidungsvorlage**, kein beschlossener Plan.

---

## 1. Was der Sketch tut

Er ist ein dünner Aufsatz auf der Bibliothek **AskSinPP**. Die eigentliche
Arbeit — CC1101 ansprechen, BidCoS-Rahmen erkennen, entschlüsseln, Prüfsumme
rechnen — macht die Bibliothek. Der Sketch selbst tut drei Dinge:

1. **Aufbau**: CC1101 an SPI (CS auf Pin 10, GDO0 auf Pin 2), Status-LED auf
   Pin 4, serielle Schnittstelle mit 57 600 Baud.
2. **Alle 750 ms** den Empfangspegel abfragen und als `:5A;` ausgeben.
3. **Bei jedem Telegramm** eine Zeile ausgeben:
   `:RRLLCCFFTTAAAAAABBBBBBP…P;`

Das war es. Es gibt keine Konfiguration, keine Rückfragemöglichkeit, keinen
Zustand.

**Das ist keine Kritik.** Für seinen Zweck ist der Sketch angemessen: Er
funktioniert seit Jahren, und seine Schlichtheit ist ein Wert. Die folgenden
Punkte sind Möglichkeiten, keine Fehler.

---

## 2. Schwachstellen — mit Belegen aus unserem Betrieb

### 2.1 Das Datenprotokoll ist der Debug-Kanal

Die Ausgabe entsteht mit `DPRINT` und `DHEX` — den **Debug**-Makros von
AskSinPP. Das Nutzdatenprotokoll ist also ein Nebenprodukt der
Fehlersuchausgabe.

Folge: Schaltet jemand in der Bibliothek eine Debugausgabe ein, mischt sie
sich in den Datenstrom. Unser Parser wirft solche Zeilen weg (`droppedLines`),
aber er kann sie nicht von echten Fehlern unterscheiden.

### 2.2 Keine Prüfsumme, keine laufende Nummer

Eine Zeile ist `:` … `;`. Kippt ein Zeichen, entsteht mit etwas Pech eine
syntaktisch gültige Zeile mit falschem Inhalt. Unser Parser fängt das nur
grob ab — er prüft den RSSI-Betrag auf ein plausibles Fenster (10…138) und
die Längenangabe. Ein verfälschtes Payload-Byte fällt nicht auf.

Schwerer wiegt: **Verlorene Zeilen sind unsichtbar.** Läuft der Puffer über
oder verschluckt die Leitung eine Zeile, merkt das niemand. Der Analyzer sieht
nur weniger Telegramme und hält das für Funkstille.

### 2.3 Die krumme Baudrate

Nominal 57 600, tatsächlich 58 824. Der 8-MHz-Takt kann 57 600 nicht exakt
erzeugen (2,1 % Abweichung), und das Projekt gleicht das auf der Pi-Seite aus.
Das funktioniert — aber es ist ein Symptom, kein Naturgesetz:

| Baudrate | Abweichung bei 8 MHz (U2X) |
| --- | --- |
| 38 400 | **0,2 %** |
| 57 600 | 2,1 % |
| 76 800 | **0,2 %** |
| 115 200 | 8,5 % |

Mit 38 400 oder 76 800 träfen beide Seiten dieselbe Rate exakt, und der ganze
58824-Sonderweg entfiele — samt der Fehlerquelle, die er darstellt (siehe
Handbuch 23, „Nur wirre Zeichen").

### 2.4 Keine Identifikation

Der Pi kann die Firmware nicht fragen, wer sie ist. Wir haben gerade die Regel
eingeführt, dass **Versionsabhängigkeiten ausgewiesen und geprüft** werden
(Analyzer ↔ ioBroker-Adapter). Zwischen Analyzer und Firmware fehlt diese
Möglichkeit vollständig.

Praktische Folge: Nach einem Firmware-Update weiß niemand, ob es gegriffen
hat, außer am veränderten Verhalten.

### 2.5 Nichts zur Laufzeit einstellbar

Die Frequenzkorrektur steht **auskommentiert im Quelltext**:

```cpp
//hal.radio.initReg(CC1101_FREQ2, 0x21);
```

Wer sie braucht — etwa weil sein CC1101-Modul daneben liegt — muss den Sketch
ändern und neu kompilieren. Dasselbe gilt für den 750-ms-Takt der
Pegelmessung.

### 2.6 Der Sniffer könnte senden

Das Gerät meldet sich als `DeviceType::Remote` mit der Kennung `FF:FF:FF`. Es
koppelt sich nicht, aber der Sender ist grundsätzlich einsatzbereit. Für ein
Gerät, das ausschließlich mithören soll, ist das mehr Möglichkeit als nötig —
und im 868-MHz-Band ist Senden rechtlich geregelt (Duty-Cycle).

Ein ausdrücklich **empfangsseitiges** Gerät wäre sauberer.

---

## 3. Die Lizenzfrage — sie entscheidet mit

Das ist kein Nebenaspekt, sondern der Kern der Wegentscheidung.

| Baustein | Lizenz |
| --- | --- |
| AskSinSniffer328P (der Sketch) | CC BY-NC-SA 3.0, © jp112sdl |
| **AskSinPP** (die Bibliothek darunter) | CC BY-NC-SA 3.0, © pa-pa |

**Jede Firmware, die AskSinPP benutzt, erbt die NC-Bedingung.** Auch eine
vollständig neu geschriebene. Das Projekt hat sich in der `LICENSE` genau
deshalb festgelegt: Der NC-Zwang bleibt an Hardware und Firmware, während
Web-UI und Adapter davon frei bleiben.

Wer die Firmware von NC lösen will, muss **ohne AskSinPP** auskommen — also
einen eigenen CC1101-Treiber und eine eigene BidCoS-Empfangsschicht schreiben.

Dazu zwei Klarstellungen:

* **Das Protokoll selbst ist nicht geschützt.** Rahmenaufbau, Sync-Wort,
  Whitening — das sind Tatsachen über ein Funkverfahren, keine schöpferische
  Leistung. Eine eigene Implementierung ist zulässig.
* **Register-Tabellen wörtlich zu übernehmen wäre riskant.** Die
  Initialisierungswerte aus AskSinPP abzuschreiben, wäre eine Übernahme fremden
  Codes. Sie müssten aus dem CC1101-Datenblatt und den Funkparametern neu
  hergeleitet werden — machbar, aber Arbeit, und ohne Messtechnik schwer zu
  verifizieren.

---

## 4. Was feststeht

**Die Platine ist in Produktion.** ATmega328P und CC1101 bleiben, ein Wechsel
auf ESP32 oder RP2040 steht nicht zur Debatte. Alles Folgende läuft auf der
vorhandenen Hardware.

**Rückwärtskompatibilität ist Pflicht.** Der Analyzer muss mit alter *und*
neuer Firmware laufen. Jede Erweiterung gehört deshalb hinter eine Erkennung,
und das bestehende Zeilenformat bleibt die Vorgabe.

---

## 5. Drei Wege

### Weg A — den vorhandenen Sketch ergänzen

Die bestehende Datei bleibt, wird um Kommandoschnittstelle, Prüfsumme und
laufende Nummer erweitert.

| | |
| --- | --- |
| Aufwand | klein (1–2 Tage) |
| Risiko | gering — die bewährte Empfangsschicht bleibt unangetastet |
| Lizenz | bleibt CC BY-NC-SA 3.0 |
| Haken | Wir pflegen dann eine abgewandelte Fassung fremden Codes. Das ist erlaubt (ShareAlike), muss aber sauber gekennzeichnet werden. |

### Weg B — eigene Firmware auf AskSinPP

Neu geschrieben, eigene Struktur, eigenes Protokoll — aber AskSinPP als
Funkschicht.

| | |
| --- | --- |
| Aufwand | mittel (1–2 Wochen) |
| Risiko | mittel |
| Lizenz | **bleibt NC**, weil AskSinPP NC ist |
| Gewinn | Sauberer Aufbau, ordentliches Protokoll, eigene Urheberschaft am Aufsatz — aber die NC-Bedingung bleibt |

### Weg C — eigene Firmware ohne AskSinPP

Eigener CC1101-Treiber, eigene BidCoS-Empfangsschicht.

| | |
| --- | --- |
| Aufwand | groß (4–8 Wochen, mit Messtechnik) |
| Risiko | **hoch** — ohne Spektrumanalysator ist die Funkschicht schwer zu verifizieren |
| Lizenz | frei wählbar (MIT), NC entfällt |
| Gewinn | Die Firmware wäre der letzte NC-Baustein, der fällt |

**Meine Einschätzung:** Weg C ist der einzige, der die Lizenzfrage löst — und
zugleich der einzige, bei dem ich nicht garantieren kann, dass das Ergebnis
zuverlässiger wird als das, was seit Jahren läuft. Die Empfangsschicht ist der
Teil, der wirklich schwierig ist, und ich kann sie hier nicht messen.

Weg A bringt **den größten Teil des praktischen Nutzens** für einen Bruchteil
des Aufwands.

---

## 6. Die Verbesserungen im Einzelnen

Bewertet nach Nutzen im Alltag, nicht nach technischer Eleganz.

| # | Verbesserung | Nutzen | Aufwand | Weg |
| --- | --- | --- | --- | --- |
| 1 | **Versionsauskunft** — `:?;` → `:!AS,2,0,8;` (Kennung, Fassung, Takt) | hoch | klein | A |
| 2 | **Laufende Nummer je Zeile** — Verluste werden sichtbar | hoch | klein | A |
| 3 | **Prüfsumme je Zeile** — verfälschte Zeilen fallen auf | hoch | klein | A |
| 4 | **Exakte Baudrate** (38 400) — der 58824-Sonderweg entfällt | hoch | klein | A |
| 5 | **Nur-Empfang erzwingen** — der Sender wird nie freigegeben | mittel | klein | A |
| 6 | **Frequenzkorrektur zur Laufzeit** — `:F210000;` statt neu kompilieren | mittel | mittel | A |
| 7 | **Pegeltakt einstellbar** — 750 ms sind nicht für jeden richtig | niedrig | klein | A |
| 8 | **Zähler abfragbar** — empfangen, CRC-Fehler, Pufferüberläufe | mittel | mittel | A |
| 9 | **CC1101-Selbsttest beim Start** — meldet ein totes Funkmodul sofort | hoch | klein | A |
| 10 | **Eigene Funkschicht** — löst die Lizenzfrage | (nur Lizenz) | groß | C |

### Zu 1 bis 3 im Detail

Diese drei zusammen ergeben ein Protokoll, das **prüfbar** ist:

```text
:5A0E011A2B3C…;A7          statt      :5A0E011A2B3C…;
        └ laufende Nummer und Prüfsumme, angehängt
```

Der Analyzer erkennt am Vorhandensein des Anhangs, dass eine neue Firmware
läuft — ganz ohne Handschlag. Alte Firmware liefert Zeilen ohne Anhang, und
alles läuft wie bisher. **Das ist der Grund, warum diese Erweiterung
rückwärtskompatibel sein kann.**

Mit der laufenden Nummer kann der Analyzer erstmals unterscheiden:

* *Es kam nichts* — Funkstille, alles in Ordnung
* *Es kam etwas nicht an* — Zeile 41 fehlt zwischen 40 und 42

Diese Unterscheidung fehlt heute vollständig, und sie ist bei der Suche nach
Empfangsproblemen genau die, auf die es ankommt.

### Zu 9

Ein CC1101, der nicht antwortet, äußert sich heute als „keine Telegramme" —
ununterscheidbar von einem ruhigen Funknetz. Ein Selbsttest beim Start (Chip
über SPI ansprechen, Teilnummer lesen) macht daraus eine klare Meldung.

---

## 6a. Erster Befund aus Phase F1 (03.08.2026)

Der Bau wurde sofort ausprobiert, bevor irgendetwas geändert wird. Ergebnis:

| Bauumgebung | Programmgröße |
| --- | --- |
| Arduino-Pro-Core + AskSinPP 5.0.3 (PlatformIO-Registrierung) | 7 490 Byte |
| **MiniCore** + AskSinPP 5.0.3 (Registrierung) | 7 416 Byte |
| **MiniCore** + AskSinPP aus `reference/` (Commit 21bab8b) | 7 734 Byte |
| **Die mitgelieferte Datei** | **6 922 Byte** |

> **Nachtrag 09.08.2026:** Diese 6 922-Byte-Datei ist inzwischen aus dem Repo
> entfernt. Sie war stumm gebaut — die Untersuchung unten dreht sich also um
> die Größe einer Datei, die ohnehin nicht funktioniert hat. Der Abschnitt
> bleibt stehen, weil die Erkenntnis über LTO und Bibliotheksfassungen
> weiterhin gilt; siehe Abschnitt 6b für den Rest.

**Die mitgelieferte HEX-Datei lässt sich mit den dokumentierten Einstellungen
nicht reproduzieren.** Sie ist 500 bis 800 Byte kleiner als jeder Bau, der
nach Handbuch 7.4 entsteht.

> **Nachtrag, wenige Stunden später:** erledigt. Es fehlte die Menüzeile
> *Compiler LTO* in der Anleitung — mit ihr stimmt die Datei bis aufs Byte.
> Der Ablauf steht in 6b; wer nur das Ergebnis braucht, springt dorthin. Der
> folgende Abschnitt bleibt stehen, weil die Beobachtung richtig war und der
> Weg dahin zeigt, wie leicht so etwas unbemerkt bleibt.

Das ist kein Fehler an der Datei — sie ist geprüft und funktioniert. Aber es
heißt: **Binärdatei und Bauanleitung gehören derzeit nicht zusammen.** Wer der
Anleitung folgt, bekommt etwas anderes als das, was beiliegt.

Zwei Nebenbefunde:

* Die `platformio.ini` des Quellprojekts nennt `pro8MHzatmega328` — den
  gewöhnlichen Arduino-Core. Unser Handbuch verlangt **MiniCore**. Beides
  läuft, aber es sind verschiedene Binärdateien.
* In der PlatformIO-Registrierung gibt es von AskSinPP nur **eine** Fassung
  (5.0.3). Die Kommentarzeile im Quellprojekt („use latest master until
  pollRSSI is available") deutet darauf hin, dass dort zeitweise direkt von
  GitHub gebaut wurde — dann hängt das Ergebnis am Tag des Baus.

**Was daraus folgt:** Phase F1 muss die Umgebung *festnageln* — Core,
Bibliotheksfassungen, Übersetzer — und die mitgelieferte Datei aus genau
dieser Umgebung neu erzeugen. Erst dann stimmen Anleitung und Beilage überein,
und erst dann ist ein Vorher-Nachher-Vergleich überhaupt aussagekräftig: Ohne
festgenagelte Umgebung wüsste man bei einem Unterschied nie, ob die Änderung
oder der Übersetzer ihn verursacht hat.

**Geklärt (03.08.2026).** Die Umgebung ist:

| | |
| --- | --- |
| Arduino IDE | 2.3.10 (arduino-cli 1.5.1) |
| MiniCore | 3.1.2 |
| AskSinPP | **5.0.3** — dieselbe Fassung, die auch die PlatformIO-Bauten nutzten |
| **Compiler LTO** | **enabled** |

Die AskSinPP-Fassung war also nie der Unterschied. Es ist **`Compiler LTO`** —
eine Menüeinstellung, die in keiner unserer Anleitungen stand. Sie fasst beim
Binden das ganze Programm zusammen und wirft heraus, was nicht erreichbar ist;
rund 500 Byte weniger sind dafür ein üblicher Betrag.

Ein Nachbauversuch mit PlatformIO und gesetzten LTO-Schaltern brachte
**keine** Änderung (7 416 Byte, unverändert) — PlatformIO reicht die Schalter
für AVR nicht durch. Damit steht auch fest: **PlatformIO ist für den Nachbau
ungeeignet.** Phase F1 nagelt die Umgebung stattdessen auf `arduino-cli` mit
MiniCore 3.1.2 fest, also auf dieselbe Werkzeugkette, die auch die IDE
benutzt.

Die Einstellung ist inzwischen in Handbuch 7.4 und in `firmware/README.md`
nachgetragen.

**Nebenbefund, unabhängig davon.** Beim Nachschlagen der Optionsnamen in
`boards.txt` fiel auf, dass der `arduino-cli`-Befehl im Handbuch seit jeher
`clock=external_8MHz` enthielt. MiniCore kennt nur `clock=8MHz_external`. Der
Befehl im Handbuch konnte also nie funktionieren — er bricht sofort mit einer
Fehlermeldung ab. Aufgefallen ist es nie, weil praktisch alle den Weg über die
IDE nehmen; getroffen hätte es ausgerechnet den, der sich wörtlich an die
Anleitung hält.

Korrigiert, und gegen eine Wiederholung abgesichert:
`firmware/pruefe-fqbn.py` hält jeden Optionsnamen in der Doku gegen die
Tabelle aus MiniCore 3.1.2 und besteht zusätzlich darauf, dass Takt, Variante
und LTO zu diesem Projekt passen. Die Tabelle liegt im Repo, damit die Prüfung
ohne Netz läuft — eine Prüfung, die bei fehlender Verbindung stillschweigend
durchwinkt, ist keine.

Alle fünf maschinellen Prüfungen des Projekts laufen jetzt über einen Aufruf:

```bash
bash tools/pruefe-alles.sh
```

### 6b. Der Nachbau gelang bit-identisch — und war trotzdem wertlos

**Nachtrag vom 09.08.2026. Dieser Abschnitt beschrieb bis dahin einen Erfolg.
Er war keiner, und die Begründung lohnt das Nachlesen.**

`firmware/nachbauen.sh` band `arduino-cli` 1.5.1, MiniCore 3.1.2 und
AskSinPP 5.0.3 fest, übersetzte mit LTO und erzeugte unter Linux dieselbe
6 922-Byte-Datei wie die Arduino IDE unter Windows, Prüfsumme
`064de4ad…0848c8`. Zwei Betriebssysteme, zwei Oberflächen, dieselbe Datei.
Zwei Gegenproben zeigten sogar, dass die Prüfung anschlägt: verfälschte
Prüfsumme erkannt, AskSinPP 5.0.2 an 6 886 Byte erkannt.

Nur war die so erzeugte Firmware **stumm**.

MiniCore setzt `-DNDEBUG` (`platform.txt` Zeile 14). AskSinPP macht daraus
leere Ausgabemakros, und der Sniffer schreibt alles über `DPRINT`. Die Datei
war also bit-genau reproduzierbar und funktionierte nicht. An der ersten
echten Platine kam kein einziges Byte an.

**Was daran lehrreich ist:** Reproduzierbarkeit belegt, dass zweimal dasselbe
herauskommt. Sie belegt nicht, dass das Ergebnis taugt. Wir haben eine
Eigenschaft gemessen, die leicht zu messen war, und sie für die Eigenschaft
gehalten, auf die es ankommt. Dieselbe Verwechslung wie beim `stty`-Test, der
unsere eigenen Argumente verglich statt ihrer Wirkung, und beim GPIO-Reset,
dessen Test die Aufrufe prüfte statt des Pegels.

Fehlen konnte der Beleg so lange, weil bis dahin **jeder Analyzer im
Demo-Modus lief** — und der öffnet gar keine serielle Schnittstelle. Es gab
schlicht keinen Anlass, an dem sich die Firmware hätte bewähren müssen.

Konsequenz: `firmware/nachbauen.sh` und die mitgelieferte HEX-Datei sind
entfernt. Die Firmware entsteht jetzt aus
[ssbingo/asksin-sniffer-firmware](https://github.com/ssbingo/asksin-sniffer-firmware);
der Sketch hebt `NDEBUG` selbst auf, `bauen.sh` prüft nach jedem Bau den
**Inhalt** des Ergebnisses, und `firmware/pruefe-hex.py` weist jede stumme
HEX-Datei zurück, egal woher sie kommt.

## 7. Projektplan (Weg A + ausgewählte Teile)

Vorschlag in vier Phasen, jede für sich abgeschlossen und nutzbar.

### Phase F1 — Grundlage (2–3 Tage)

Stand 03.08.2026: **weitgehend erledigt**, siehe Abschnitte 6a und 6b.

| | |
| --- | --- |
| ❌ | **Reproduzierbarer Bau** — zurückgenommen am 09.08.2026. Er gelang bit-identisch und erzeugte eine stumme Datei; siehe 6b. `nachbauen.sh` und die HEX-Datei sind entfernt |
| ✅ | **Board-Einstellungen maschinell geprüft** — `firmware/pruefe-fqbn.py` vergleicht jede FQBN in der Dokumentation gegen die Optionstabelle von MiniCore 3.1.2 |
| ✅ | **Firmware wird auf Stummheit geprüft** — `firmware/pruefe-hex.py` verlangt die Startkennung im Programmabbild; `bauen.sh` im Firmware-Projekt tut dasselbe nach jedem Bau |
| ✅ | **Prüfstand für den Zeilenstrom** — `core/bin/mitschnitt.ts` zeichnet auf und wertet aus; Handbuch 11.4. Die ursprünglich geplante Grundlinie *mit der Originalfirmware* ist hinfällig, weil die ausgelieferte Fassung selbst stumm war |
| ✅ | Eigenes Repository `asksin-sniffer-firmware` mit CI — vorhanden |

**Zum Bauweg:** Der Plan sah PlatformIO vor. Das hat sich als falsch erwiesen —
PlatformIO bringt eine eigene Werkzeugkette mit und reicht die LTO-Schalter für
AVR nicht durch; das Ergebnis weicht ab, ohne dass etwas fehlschlägt.
Festgelegt ist deshalb `arduino-cli` mit MiniCore, also dieselbe Kette, die
auch die Arduino IDE benutzt.

**Was der Prüfstand misst.** Nicht „läuft" oder „läuft nicht" — das sieht man
ohnehin. Sondern die drei Größen, die sich schleichend verschlechtern können
und **nur von der Firmware abhängen**:

* **Rauschtakt** (Soll 750 ms): der ehrlichste Gesundheitswert überhaupt, weil
  er nicht am Funkverkehr hängt. Unruhe hier zeigt blockierende Stellen im
  Programm, lange bevor Telegramme fehlen.
* **Lücken**: Zeiträume ohne jede Zeile. Heute nicht von Funkstille zu
  unterscheiden — genau das soll Verbesserung 2 (laufende Nummer) ändern. Der
  Mitschnitt beziffert vorher, wie oft es überhaupt vorkommt.
* **Verworfene je Minute**: die einzige Spur von Übertragungsfehlern, die wir
  heute haben. Je Minute, nicht absolut — sonst gewänne im Vergleich immer der
  kürzere Lauf.

Telegrammzahl und Pegel werden bewusst **nicht** bewertet: Sie hängen davon
ab, was im Haus gerade funkt. Eine höhere Telegrammzahl wäre kein Verdienst
der neuen Firmware, sondern womöglich nur ein Rollladen mehr.

*Abnahme: Die selbst gebaute HEX-Datei verhält sich wie die mitgelieferte.*
**Hinfällig seit 09.08.2026.** Die Abnahme war erfüllt — bit-identisch, also
zwangsläufig gleiches Verhalten. Beide schwiegen nämlich. Es gibt keine
mitgelieferte Datei mehr, und die Abnahme lautet jetzt: *Die gebaute Datei
enthält ihre Ausgabetexte*, maschinell geprüft durch `firmware/pruefe-hex.py`.

**Die Grundlinie mit der Originalfirmware ist entfallen.** Sie hätte den
Zeilenstrom der ausgelieferten Fassung festhalten sollen — die war aber stumm
gebaut (Abschnitt 6b), es gab also nie einen Strom zum Aufzeichnen. Seit dem
09.08.2026 sendet die erste echte Platine; ab dort wird gemessen, und der
Vergleichsmaßstab ist die heutige Fassung, nicht das Original.

Warum es so lange keinen Anlass gab, es zu bemerken: Der bisherige
Analyzer lief im Demo-Modus, weil es noch keine bestückte Platine gab.
Eine Aufzeichnung daraus wäre als Grundlinie nicht bloß nutzlos, sondern
irreführend: Die Simulation hält einen künstlich sauberen Takt, kennt keine
Übertragungsfehler und keine Aussetzer. Gegen eine spätere Messung an echter
Hardware gehalten, ergäbe sie eine Verbesserung, die allein der Simulation
gehört — in genau den drei Größen, auf die es ankommt.

Damit das nicht aus Versehen geschieht, trägt jeder Mitschnitt seine Herkunft
in der Datei (`# demo ja|nein`). Die Auswertung stellt einen Kasten darüber,
und der Vergleich zweier Mitschnitten unterschiedlicher Herkunft wird
**abgelehnt statt gerechnet**. Fehlt die Angabe — bei Dateien aus der Zeit vor
dieser Kennzeichnung —, gilt die Herkunft als *unbekannt* und nicht als
*echt*; die vorsichtige Richtung.

**Reihenfolge — überarbeitet am 09.08.2026.** Der ursprüngliche Plan sah vor,
zuerst eine Stunde *mit der mitgelieferten Originalfirmware* aufzuzeichnen und
diese Aufnahme als unwiederbringliche Grundlinie zu behandeln. Das ist
hinfällig: Die mitgelieferte Datei war stumm gebaut (Abschnitt 6b), es hätte
nie eine Zeile zum Aufzeichnen gegeben. Was jetzt gilt:

1. Platine anschließen, Demo-Modus aus, Analyzer läuft an echter Hardware
2. Eine Stunde mit der **heutigen** Firmware aufzeichnen. Das ist die
   Grundlinie; ein Vorher-Zustand existiert nicht
3. Bei jeder späteren Änderung erneut eine Stunde unter möglichst ähnlichen
   Bedingungen aufzeichnen
4. `mitschnitt.ts vergleichen vorher.txt nachher.txt`

Eine **Probeaufzeichnung im Demobetrieb** ist davon unbenommen sinnvoll: Sie
belegt, dass der Weg trägt — Konfigurationsschalter, Neustart, Datei am
erwarteten Ort, Auswertung läuft durch. Das will man wissen, bevor die Platine
da ist, nicht danach.

### Phase F2 — Prüfbares Protokoll

Stand 03.08.2026: **umgesetzt, wartet auf die Platine.**

| | |
| --- | --- |
| ✅ | Verbesserungen 1, 2, 3 und 9 — eigenes Repository [`asksin-sniffer-firmware`](https://github.com/ssbingo/asksin-sniffer-firmware) |
| ✅ | Analyzer-Seite: Anhang erkennen, Lücken zählen, in *Info → Sniffer-Firmware* zeigen |
| ✅ | Versionsabhängigkeit Firmware ↔ Analyzer (`core/src/decode/firmwarebefund.ts`) |
| ⬜ | Live-Prüfung an echter Hardware |

**Die Entscheidung, die alles trägt:** Die Erweiterungen sind **aus**, bis der
Analyzer sie mit `:E1;` anfordert. Im Auslieferungszustand verhält sich die
neue Firmware Zeichen für Zeichen wie das Original.

Das macht den Austausch gefahrlos. Andersherum — erweitert als Vorgabe —
hätte jeder Analyzer mit älterer Software nach dem Aufspielen schlagartig jede
Zeile verworfen, und zwar mit dem irreführendsten aller Fehlerbilder: „es
kommt nichts mehr an", bei tadelloser Funkstrecke.

**Was ohne Platine geprüft werden konnte,** ist geprüft:

* 130 Prüfungen der Firmware selbst, auf dem PC. `protokoll.h`/`.cpp` haben
  keine Arduino-Abhängigkeit und laufen mit `g++`.
* 273 Prüfungen im Analyzer, darunter Überlauf, Neustart, Rücksprung,
  verfälschte Prüfsumme und das Ausbleiben einer Antwort.
* Der Sketch übersetzt mit der festgenagelten Werkzeugkette:
  **8 540 Byte**, 26 % des Flash.

  *Nachtrag 09.08.2026:* Hier stand vorher 7 588 Byte. Diese Zahl galt vor der
  NDEBUG-Reparatur — und beschrieb damit eine stumme Firmware. Nachgemessen
  mit AskSinPP 5.0.3, EnableInterrupt 1.1.0 und Low-Power 1.81:

  | Bau | Größe | Startkennung im Abbild |
  | --- | --- | --- |
  | mit Aufhebung von `NDEBUG` | **8 540 Byte** | vorhanden |
  | ohne Aufhebung | 7 630 Byte | **fehlt** — stumm |
  | unverändertes Original | 6 922 Byte | fehlt — stumm |

  910 Byte Unterschied bei Zeichen für Zeichen demselben Quelltext: die
  Ausgabetexte und der Code, der sie verschickt. Die 7 630 Byte sind exakt die
  Größe, die am 09.08.2026 an Analyzer 05 aufgespielt wurde und schwieg.

Zwei Fehler hat das schon gefunden, bevor Hardware im Spiel war:

1. Im Kommentar stand, die Prüfsumme bemerke vertauschte Zeichen. Eine Summe
   ist kommutativ und bemerkt sie nicht. Der Test hat es nachgerechnet statt
   es zu glauben — sonst stünde die falsche Zusage bis heute in der
   Protokollbeschreibung.
2. Ein kleiner Rücksprung der Folgenummer wäre in der Sammelkategorie
   „Firmware-Neustart" verschwunden. Auf einer UART darf er nie vorkommen; er
   ist jetzt ein eigener Befund.

*Abnahme: Der Analyzer zeigt verlorene Zeilen an. Alte Firmware läuft
unverändert weiter.* — **Erfüllt, soweit ohne Hardware feststellbar.**

### Phase F3 — Betriebsverbesserungen (2–3 Tage)

* Verbesserungen 4, 5, 7
* Umstellung der Baudrate mit Übergangszeit: Die neue Firmware meldet ihre
  Rate in der Versionsauskunft, der Analyzer stellt sich darauf ein

*Abnahme: Der 58824-Sonderweg ist Geschichte, ohne dass ein Altgerät stehen
bleibt.*

### Phase F4 — Einstellbarkeit (3–4 Tage)

* Verbesserungen 6, 8
* Bedienung in der Weboberfläche, kein Terminal

*Abnahme: Frequenzkorrektur ohne Neukompilieren.*

**Weg C** wäre eine eigene Phase F5 und sollte erst beschlossen werden, wenn
F1 bis F4 laufen — dann ist die Prüfumgebung vorhanden, mit der sich eine
eigene Funkschicht überhaupt verantwortbar entwickeln lässt.

---

## 8. Was ich zusagen kann und was nicht

**Ich kann:** den Code schreiben, das Protokoll entwerfen, die Analyzer-Seite
mitziehen, alles gegen aufgezeichnete Daten prüfen, und die
Rückwärtskompatibilität durch Tests absichern.

**Ich kann nicht:** auf der Hardware messen. Ob eine geänderte Firmware
*wirklich* jedes Telegramm empfängt, zeigt sich erst auf dem Gerät — und den
Vergleich „vorher/nachher über 24 Stunden" musst du fahren. Die Aufzeichnung
aus Phase F1 ist genau dafür da.

**Ein Risiko benenne ich ausdrücklich:** Die vorhandene Firmware läuft seit
Jahren. Jede Änderung daran ist eine Wette gegen Bewährtes. Deshalb ist Phase
F1 kein Vorgeplänkel, sondern die Voraussetzung — ohne eine Aufzeichnung, die
als Vergleichsmaßstab dient, würden wir raten.

---

## 9. Zur Entscheidung

Drei Fragen:

1. **Weg A, B oder C?** Meine Empfehlung ist A — größter Nutzen je Aufwand,
   und die Lizenzfrage ist ohnehin nur mit C zu lösen, nicht mit B.
2. **Welche Verbesserungen?** Meine Empfehlung: 1, 2, 3, 9 (Phase F2) als
   erster Schritt. Sie machen den Empfang zum ersten Mal *überprüfbar*.
3. **Eigenes Repository oder hier?** Ich würde ein eigenes nehmen — die
   Firmware hat einen anderen Lebenszyklus, eine andere Lizenz und eine
   andere Werkzeugkette als der Rest.
