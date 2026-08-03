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

### 6b. Der Nachbau gelingt — bit-identisch

Mit den geklärten Fassungen ist der Befund vom Vortag erledigt.
`firmware/nachbauen.sh` holt `arduino-cli` 1.5.1, MiniCore 3.1.2 und
AskSinPP 5.0.3, übersetzt mit LTO und vergleicht:

| | |
| --- | --- |
| Gebaut (Linux, arduino-cli) | 6 922 Byte, `064de4ad…0848c8` |
| Mitgeliefert (Windows, Arduino IDE) | 6 922 Byte, `064de4ad…0848c8` |
| | **identisch** |

Zwei Betriebssysteme, zwei Oberflächen, dieselbe Datei. Der Bau ist damit
**reproduzierbar** — das war die Voraussetzung für alles Weitere, denn ohne
sie ließe sich später nicht belegen, dass eine Änderung an der Firmware
wirklich die Wirkung hatte, die wir ihr zuschreiben.

Zwei Gegenproben belegen, dass das Skript auch wirklich prüft und nicht nur
zustimmt:

* Erwartete Prüfsumme verfälscht → erkannt, Abbruch mit Erklärung.
* AskSinPP auf 5.0.2 heruntergesetzt → 6 886 Byte, andere Prüfsumme, erkannt.
  Danach stellt das Skript die festgelegte Fassung selbst wieder her.

Die zweite Probe ist der eigentliche Beleg: **eine Nebenversion einer
Bibliothek genügt für eine andere Binärdatei.** Genau deshalb steht jede
Fassung ausgeschrieben im Skript und nicht nur in einer Beschreibung, die beim
Abschreiben schrumpft.

## 7. Projektplan (Weg A + ausgewählte Teile)

Vorschlag in vier Phasen, jede für sich abgeschlossen und nutzbar.

### Phase F1 — Grundlage (2–3 Tage)

Stand 03.08.2026: **weitgehend erledigt**, siehe Abschnitte 6a und 6b.

| | |
| --- | --- |
| ✅ | **Umgebung festgenagelt** — `firmware/nachbauen.sh` bindet `arduino-cli` 1.5.1, MiniCore 3.1.2, AskSinPP 5.0.3 und LTO. Nötig war das, weil drei plausible Umgebungen drei verschiedene Binärdateien ergaben |
| ✅ | **Reproduzierbarer Bau** — die mitgelieferte HEX-Datei entsteht bit-identisch neu, unter Linux wie unter Windows. Zwei Gegenproben belegen, dass die Prüfung auch anschlägt |
| ✅ | **Anleitung und Beilage stimmen überein** — Handbuch 7.4/11.3 und `firmware/README.md` nennen dieselben Fassungen, maschinell geprüft durch `firmware/pruefe-fqbn.py` |
| ✅ | **Prüfstand für die Grundlinie** — `core/bin/mitschnitt.ts` zeichnet den rohen Zeilenstrom auf und wertet ihn aus; Handbuch 11.4 |
| ⬜ | Eigenes Repository `asksin-sniffer-firmware` mit CI — steht noch aus. Der Nachbau ist als Skript im Hauptrepo vorhanden, das genügt bis zur ersten eigenen Änderung |

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
**Erfüllt** — sie ist bit-identisch, also verhält sie sich zwangsläufig gleich.

**Vor dem Eintreffen der Platine** ist damit nur noch eines zu tun: eine
Stunde Grundlinie am laufenden Gerät aufzeichnen und wegsichern. Ohne dieses
Vorher gibt es später kein Nachher.

### Phase F2 — Prüfbares Protokoll (3–4 Tage)

* Verbesserungen 1, 2, 3, 9
* Analyzer-Seite: Anhang erkennen, Lücken zählen, in der Oberfläche zeigen
* Versionsabhängigkeit Firmware ↔ Analyzer nach derselben Regel wie beim
  Adapter

*Abnahme: Der Analyzer zeigt verlorene Zeilen an. Alte Firmware läuft
unverändert weiter.*

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
