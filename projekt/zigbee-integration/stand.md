# Verlauf — Zigbee-Integration

Laufendes Tagebuch. Neueste Einträge oben. Der Plan steht in
[`README.md`](README.md) und bleibt möglichst stabil; was sich beim Bauen
herausstellt, kommt hierher.

Format eines Eintrags: Datum, Phase, **was gemessen wurde** — nicht, was
vermutet wird.

**PAN-IDs stehen hier nicht.** Eine PAN-ID ist die Kennung eines Funknetzes;
wer in Reichweite ist, kann damit gezielt zuordnen. Dieses Repo ist
öffentlich, deshalb erscheinen sie als `0x⟨PAN⟩`, `0x⟨PAN-A⟩`, `0x⟨PAN-B⟩`.
Die Kurzadressen einzelner Geräte bleiben stehen: Sie werden beim
Neuanmelden neu vergeben und sind ohne die PAN wertlos.

---

## 18.08.2026 — M16.5, erster Teil: Konfiguration, Dienst, Assistent

Der Leser hängt jetzt im Dienst. Was dazugekommen ist:

**Konfigurationsblock** `zigbee` mit `aktiv`, `device`, `kanal`,
`bestaetigungen`, `paketeTage`, `stundenTage`. Eine Konfiguration **ohne**
diesen Block bleibt unverändert gültig — das war E2 und ist so umgesetzt,
dass kein Vorgabewert nachträglich hineinwandert.

**Im Dienst** (`bin/analyzerd.ts`): eigener Leser, eigener Speicher, Spülen
alle 30 s, Aufräumen täglich. Fehlt der Stick, versucht der Leser weiter —
**kein Startabbruch**. Beim Herunterfahren zählt die Reihenfolge: erst den
Leser anhalten, dann den letzten Schub schreiben. Umgekehrt fehlten die
Pakete der letzten Sekunden.

Im **Demo-Modus bleibt Zigbee aus**. Erfundene Funktelegramme gibt es dort
mit Absicht; erfundene Zigbee-Pakete wären etwas anderes — sie sollen zeigen,
was wirklich in der Luft ist.

**Im Einrichtungsassistenten** eine Frage, deren Vorgabe davon abhängt, ob
ein Stick steckt (`/dev/serial/by-id/` nach `Sonoff_Zigbee` durchsucht):
steckt einer, lautet sie „(J/n)", sonst „(j/N)". Bei Ja folgt die Kanalfrage
mit Prüfung auf 11 bis 26.

### Ein Platzierungsfehler, gefunden bevor er wirkte

Ich hatte den Abschnitt hinter die Status-LED gesetzt — also **hinter**
`schreibe_konfig`. Die Antwort wäre nie in der Datei gelandet, `aktiv` immer
`false`, und die Fehlersuche hätte im Dienst begonnen statt im Assistenten.
Aufgefallen beim Nachsehen, in welcher Reihenfolge der Assistent arbeitet;
die Frage steht jetzt **vor** dem Schreiben.

Die naheliegende Alternative — die fertige Datei nachträglich mit `sed`
flicken, wie es der LED-Abschnitt tut — habe ich verworfen. JSON mit
Zeilenwerkzeugen zu bearbeiten geht so lange gut, bis jemand die
Formatierung ändert.

`npm run check`: **344 Tests, 0 Fehler.** `tools/pruefe-alles.sh`: bestanden.

**Noch offen an M16.5:** der Schalter in der Weboberfläche und die
API-Zweige — das ist M16.6. Und der Dauerlast-Nachweis auf dem Pi 3, der
jetzt technisch möglich wäre: Dafür müssten die Änderungen auf Analyzer 04
ausgerollt werden.

---

## 18.08.2026 — M16.4 fertig: Speicherung, und eine unbequeme Zahl

Schema-Version **2**, zwei neue Tabellen, `core/src/zigbee/speicher.ts`.
Gepuffert, eine Transaktion je Schub, Stundensummen additiv über
`ON CONFLICT … DO UPDATE` — wie im BidCoS-Recorder, aber getrennt davon.

**Adressen als TEXT**, nicht als Zahl: Eine Kurzadresse hat vier Hexstellen,
eine IEEE-Adresse sechzehn. Als INTEGER wäre die IEEE-Adresse ein
Vorzeichenproblem und die führende Null einer Kurzadresse verloren.

### Die unbequeme Zahl

Eine Stunde echten Verkehrs in die Datenbank geschrieben und nachgemessen:

| | |
| --- | --- |
| 47 827 Pakete | **3,56 MB** = 78 Byte je Paket |
| hochgerechnet | **85 MB am Tag** |
| bei 14 Tagen Aufbewahrung | 1,17 GB |

Zum Vergleich: **Die gesamte BidCoS-Datenbank auf Analyzer 04 ist 4,5 MB
gross.** Zigbee würde das Neunzehnfache davon *pro Tag* schreiben — auf eine
SD-Karte. Platz ist da (53 GB frei), aber Schreiblast auf Karten ist in
`db.ts` ausdrücklich ein Entwurfsthema.

**Davon waren 41 % Bestätigungen.** Eine Bestätigung trägt weder Absender
noch Empfänger noch Netz — nur Rahmenkopf, Folgenummer und Prüfsumme. Einer
Geräteauswertung ist sie nicht zuzuordnen; gespeichert wäre sie eine Zeile,
die keine Frage beantwortet.

Voreinstellung ist deshalb **zählen statt speichern**:

| | mit Bestätigungen | ohne |
| --- | --- | --- |
| je Paket | 78 Byte | **50 Byte** |
| am Tag | 85 MB | **55 MB** |
| 14 Tage | 1,17 GB | **0,75 GB** |

Umstellbar über `bestaetigungen: 'speichern'`, falls sie später über die
Folgenummer zugeordnet werden sollen.

### `schwach` statt Mittelwert allein

Die Stundentabelle führt neben Summen und Extremwerten eine Spalte
`schwach`: Pakete mit LQI unter 50. Das ist keine geraten Grenze, sondern die
am 18.08. an 47 827 Paketen gemessene Kante. Ein Median liesse sich aus
Summen nicht bilden — dieser Zähler liefert stattdessen den Anteil, auf den
es ankommt.

### Zwei Testbefunde

**Mein Migrationstest war hohl.** Er legte eine Version-1-Datenbank im
Speicher an, schloss sie und öffnete danach eine frische — die Migration
lief dabei überhaupt nicht. Grün und wertlos. Jetzt mit einer echten Datei,
mit Bestandsdaten, und gegengeprüft: Nimmt man Migration 2 heraus, schlägt
der Test fehl.

**Die bestehende Persistenzprüfung hat zugeschlagen** und die neuen Tabellen
als unerwartet gemeldet — sie vergleicht die Tabellenliste vollständig, nicht
auf „enthält". Genau richtig: Eine Tabelle, die unbemerkt dazukommt, ist ein
Schemawechsel. Erwartung nachgezogen.

`npm run check`: **344 Tests, 0 Fehler.**

---

## 18.08.2026 — Stundenmitschnitt: 47 827 Pakete, und zwei eigene Messfehler

Eine Stunde an Analyzer 04, `~/zigbee-1h.jsonl`, 5,1 MB.

| | |
| --- | --- |
| Pakete / **unlesbare Zeilen** | 47 827 / **0** |
| Rate | 13,3 Pakete/s |
| Rahmentypen | 28 017 Daten, 19 804 Bestätigungen, 6 Beacons |
| Netze in Hörweite | eigenes 24 775, Nachbar A 3 221, Nachbar B 27 |
| Geräte im eigenen Netz | **33** (32 + Koordinator) |

Die deCONZ-Liste kennt 35 Geräte. Ein einzelner Standort hört davon 32 —
der „nie gehört"-Abgleich ist damit im Kleinen vorgeführt, bevor eine Zeile
Verbundcode geschrieben ist.

### Zwei Fehler in meiner eigenen Auswertung

**1. Extremwerte statt Median.** Die erste Fassung bewertete Geräte nach dem
*schwächsten je empfangenen* Paket. Wer eine Stunde misst, sieht bei jedem
Gerät irgendwann einen Ausreisser — `0x837E` mit 1300 Paketen und LQI 252
galt deshalb als grenzwertig, obwohl sein Median bei −74 dBm liegt. **Elf
Geräte waren falsch eingestuft.** Bewertet wird jetzt der Median; Spanne
steht daneben als Zusatz.

**2. Bestätigungen haben die Wiederholungszählung zerstört.** Gemeldet
waren 45 % Wiederholungen. Nachgezählt: Eine Bestätigung besteht aus
Rahmenkopf, Folgenummer und Prüfsumme — es gibt nur **267 mögliche Muster**.
Bei 19 804 Bestätigungen sind Doppelte zwangsläufig, ohne dass irgendetwas
wiederholt wurde. 19 537 der 21 806 „Wiederholungen" waren dieser Artefakt.

**Der wahre Wert: 2 269 von 18 081 gezielten Sendungen = 12,5 %.**
Rundrufe: 9 942 Pakete, 9 942 verschiedene, **null** Wiederholungen.

Eine Kennzahl, die eine Bauarteigenschaft als Netzproblem ausweist, ist
schlimmer als gar keine.

### Die LQI-Kante ist jetzt an 47 827 Paketen belegt

| Median-RSSI | Median-LQI |
| --- | --- |
| −22 bis −85 dBm | 77 bis 255 |
| −87 dBm und schlechter | 0 bis 20 |

Elf Geräte des eigenen Netzes liegen unterhalb der Kante. Für die spätere
Bewertung ist −87 dBm damit keine geschätzte, sondern eine gemessene
Schwelle.

### Quervergleich: sechs Pakete Unterschied, restlos erklärt

TypeScript zählte 6 Pakete mehr je PAN als Python. Nachgesehen statt
weggewunken: **genau die sechs Beacons** (4x Nachbar-PAN, 2x eigene). Ein
Beacon trägt keine Ziel-PAN, aber eine Quell-PAN; der TypeScript-Decoder
ordnet es seinem Netz zu, das Python-Werkzeug wertete nur Ziel-PANs.
Python nachgezogen — beide liefern jetzt **24 775 / 3 221 / 27 und
40 Geräte**, Zeichen für Zeichen gleich.

### Die Pi-3-Frage ist beantwortet

Decoder auf dem Pi 3 Model B Plus, über dieselben 47 827 Zeilen:

| | |
| --- | --- |
| Durchsatz | **18 652 Pakete/s** |
| je Paket | 53,6 Mikrosekunden |
| Haldenzuwachs über den ganzen Lauf | **+1 MB** |
| **Bedarf bei den gemessenen 13,3 Paketen/s** | **0,071 % eines Kerns** |

Der Decoder ist rund **1400-fach schneller als nötig**. Die Sorge um
1 MBaud auf dem Pi 3 ist damit erledigt — was bleibt, ist der Nachweis im
Dauerbetrieb, und der geht erst mit M16.5.

---

## 18.08.2026 — M16.2 auf dem Gerät abgenommen. Die Kollision war real

Ausgerollt auf Analyzer 04 (Pi 3 Model B Plus, 905 MB, vier Kerne).

**Der Ausgangszustand hat die Vorhersage bestätigt**, und zwar wörtlich:

```text
/dev/asksin-hat  -> ttyAMA0
/dev/asksin-usb  -> ttyUSB0      <-- der ZIGBEE-STICK
```

Der Zigbee-Stick trug den Namen des Sniffers. Auf diesem Analyzer folgenlos,
weil er über `asksin-hat` läuft — auf einem mit USB-Platine wäre es der
Fehler gewesen, den niemand in einer udev-Regel gesucht hätte. **Keine
Theorie mehr, sondern ein Fund am Gerät.**

Nach dem Ausrollen, geprüft mit `udevadm test` (nur Zeile 47 greift, die
Auffangregel bleibt stumm) und **nach einem Neustart**:

| | |
| --- | --- |
| `/dev/asksin-zigbee` | → `ttyUSB0` |
| `/dev/asksin-hat` | → `ttyAMA0`, unverändert |
| `/dev/asksin-usb` | **nicht mehr vorhanden** |
| `asksin-analyzer` | `active` |

Die alte Regel liegt als `99-asksin-analyzer.rules.vor-zigbee` daneben.

### Ausgangswerte für den Lasttest (M16.3)

Der Stundenmitschnitt läuft seit 10:10 Uhr. Gleichzeitig der Referenzwert
des Analyzers **ohne** Zigbee, auf demselben Pi 3:

| | |
| --- | --- |
| CPU | **6,6 bis 7,9 %** eines Kerns |
| Arbeitsspeicher | **124 bis 125 MB**, stabil |
| Zigbee-Verkehr nebenher | 5,5 bis 14,7 Zeilen/s |

**`ps %cpu` war dafür untauglich** — das ist der Mittelwert seit
Prozessstart, und zwei Minuten nach einem Neustart misst man damit die
Startlast. Erst die Differenz aus `/proc/PID/stat` über je zehn Sekunden
ergibt brauchbare Zahlen. Erste Messung deshalb verworfen.

124 MB von 905 MB heißt: reichlich Luft. Damit ist die Frage, ob der Pi 3
mitkommt, nicht mehr offen, sondern nur noch zu belegen — der Vergleichswert
**mit** Zigbee folgt, sobald der Leser im Dienst hängt (M16.5).

---

## 18.08.2026 — M16.3 Datenpfad fertig: Leser, Warteschlange, Zähler

`core/src/zigbee/leser.ts`. **Kein Umbau von `SerialIngest`** — der ist auf
BidCoS zugeschnitten (Freischaltung `:?;`, Folgenummern, Rausch- und
Telegrammzähler, Firmwareauskunft). Ihn für ein zweites Protokoll
umzubauen hieße, den Pfad anzufassen, der nie ausfallen darf (E1).
Mitbenutzt werden nur die protokollneutralen Teile: `LineSplitter`,
`BoundedQueue`, `sttyPortOpener`.

### Eine Messung erspart einen Helfer

`GENORMTE_RATEN` in `sttyPort.ts` endete bei 460 800 — 1 MBaud wäre über
`deploy/baudrate.py` gegangen, mit dem bekannten Warnpfad „Zeichenfehler
wahrscheinlich". Nachgesehen statt vermutet: **B500000 bis B1152000 sind
Kernkonstanten** in `<asm-generic/termbits.h>`, stty nimmt sie entgegen.
Liste erweitert. Nachgerechnet, dass die BidCoS-Zuordnung unberührt bleibt:
58 824 → 57 600, vorher wie nachher.

### Was der Leser zusichert

| Zusicherung | Prüfung |
| --- | --- |
| Wirft nie in die Ereignisschleife | werfender Verbraucher: 6 Pakete gelesen, 6 Fehler gezählt |
| Wächst nicht | Kapazität 4, 20 Pakete → **16 als Überlauf gezählt**, nicht geschluckt |
| Verwirft nie stillschweigend | vier Müllzeilen, vier verschiedene Gründe, jeder einzeln gezählt |
| Kanal ist ein bewusster Vorgang | 10 und 27 werden abgewiesen; gültiger Kanal wird als `{"C":15}` gesendet |
| Fehlendes Schreibrecht ist kein Fehler | Port ohne `schreibe`: liest weiter |

Der Überlaufzähler ist kein Beiwerk. Eine stille Kürzung sähe aus wie
Funkstille — genau die Verwechslung, vor der `folge.ts` im BidCoS-Pfad
warnt, und die dort einmal eine Stunde Suche gekostet hat.

`npm run check`: **335 Tests, 0 Fehler.** `tools/pruefe-alles.sh`: alle
Prüfungen bestanden.

### Stand von M16.3

Fertig: Decoder, Leser, Warteschlange, Zähler.
Offen: der **24-Stunden-Lasttest auf dem Pi 3** — dafür fehlt noch der
Stundenmitschnitt. Danach M16.4 (Speicherung).

---

## 18.08.2026 — M16.2 fertig, Decoder steht (M16.3, erster Teil)

### M16.2 — udev

`/dev/asksin-zigbee` über Hersteller und Produkt, nicht über die
Seriennummer: Die Regel gilt damit für jeden Stick dieses Typs und muss beim
Gerätetausch nicht angefasst werden. Die Auffangregel für `asksin-usb`
schließt den Dongle jetzt aus — **nachgemessen: der ZBDongle-E benutzt
denselben CP2102N**, Itead programmiert nur eigene Zeichenketten hinein.

**Mein erster Prüfansatz war wirkungslos.** `tools/pruefe-udev.py` verglich
Bedingungsmengen auf Teilmengen. Genau diesen Fall erkennt das nicht: Die
beiden Regeln greifen auf **verschiedenen Merkmalen desselben Geräts** zu
(`manufacturer`/`product` gegen `idVendor`/`idProduct`) — da ist keine Menge
Teilmenge der anderen. Die Gegenprobe bestand, obwohl der Fehler drin war.
Ohne Gegenprobe wäre eine wirkungslose Prüfung eingecheckt worden.

Zweite Fassung: Die Regeln werden gegen einen **Katalog bekannter Geräte**
ausgewertet. Beide Gegenproben schlagen an — Ausschluss entfernt → „bekommt
zusätzlich asksin-usb"; Zigbee-Regel entfernt → „bekommt asksin-zigbee
NICHT". In `tools/pruefe-alles.sh` eingehängt.

Beinahe-Unfall: In den Katalog hatte ich die **echte Seriennummer** des
Sticks geschrieben. Entfernt, `pruefe-keine-echtdaten.sh` grün.

### M16.3 — Decoder

`core/src/zigbee/{types,parse}.ts`. Zeilenweises JSON → geprüftes Paket mit
Kanal, RSSI, LQI, Rahmenart, Folgenummer, PAN, Absender, Empfänger,
Rundruf-Kennzeichen. Nutzdaten werden nicht angefasst.

`LineSplitter` und `BoundedQueue` sind protokollneutral und werden
mitbenutzt statt verdoppelt.

**Vor dem Bauen gemessen statt angenommen:** `L === S.length / 2` galt in
allen 68 geprüften Zeilen — wird trotzdem geprüft, ein Widerspruch heißt
beschädigte Zeile. Adressierung ist durchgängig kurz (2/2 bei Daten, 0/0 bei
Bestätigungen), Rahmenversion 0.

**Testdaten:** echte Rahmen, aber bereinigt. In den Nutzdaten stehen
**IEEE-Adressen** — weltweit eindeutig, mit Herstellerpräfix (hier Telink,
`A4:C1:38`). Dieselbe Klasse Daten wie eine MAC-Adresse, gehört nicht ins
öffentliche Repo. Ersetzt wurden PAN, Kurzadressen und Nutzdaten; **der
Aufbau der Rahmen blieb unverändert**, denn genau den kann ein Decoder
falsch machen. Die Erwartungswerte stammen aus der Ersetzung, nicht aus
einem Lauf des Parsers.

**Die eigentliche Abnahme war ein Quervergleich:** Der TypeScript-Decoder
und das unabhängig geschriebene Python-Werkzeug wurden auf dieselben echten,
unveränderten Daten losgelassen.

| | TypeScript | Python |
| --- | --- | --- |
| Pakete / verworfen | 68 / 0 | 68 / 0 |
| Bestätigungen / Daten | 25 / 43 | 25 / 43 |
| PAN 0x⟨PAN⟩ / 0x⟨PAN-A⟩ | 41 / 2 | 41 / 2 |
| Geräte | 19 | 18 + 1 |

Zwei Implementierungen, zwei Sprachen, dieselben Zahlen. Das ist mehr wert
als jede Zusicherung.

`npm run check`: **329 Tests, 0 Fehler.**

**Als Nächstes:** Leser und Warteschlange (`leser.ts`), dann Persistenz
(M16.4). Für den Lasttest fehlt noch der Stundenmitschnitt.

---

## 18.08.2026 — Voller Mitschnitt: 32 Geräte, und ein Fehler in meinem Werkzeug

Auswertung über alle 962 Pakete. Zuerst der Fehler, weil er die Zahlen
verzerrt hat:

**Meine Geräteliste warf beide PAN-Netze in einen Topf.** Dadurch tauchten
Nachbargeräte in der Liste des eigenen Netzes auf. Belegt an `0xA137`:
in der Liste mit 14 Paketen und LQI 0 — laut MAC-Kopf aber PAN 0x⟨PAN-A⟩,
also **das Netz des Nachbarn**. Behoben: `werkzeuge/auswerten.py` führt
Geräte jetzt je PAN.

Das ist genau der Fehlertyp, den das Projekt schon kennt: zwei Dinge, die
gleich aussehen, in einen Topf geworfen, und niemand meldet etwas.

### Was gesichert ist

| | |
| --- | --- |
| Pakete / unlesbar | 962 / **0** |
| Rahmentypen | 537 Daten, 425 Bestätigungen |
| Adressierte Rahmen nach PAN | **508 eigenes + 29 fremdes = 537** |

Die letzte Zeile ist eine Selbstkontrolle: Bestätigungen tragen keine
Adressen, alle übrigen 537 tragen genau eine PAN — und die Summe stimmt
auf das Paket. **Der Decoder liest den MAC-Kopf richtig.**

### Zwei Befunde von Gewicht

**1. LQI bricht unterhalb von etwa −85 dBm ein.** Kein weicher Übergang,
sondern eine Kante: Geräte über −85 dBm liegen bei LQI 245–255, Geräte
unter −87 dBm bei LQI 0–28. Damit ist die Bewertungstabelle aus
Handbuch 8.1 nicht mehr geschätzt, sondern gemessen. Als Schwelle für die
spätere Auswertung brauchbar.

**2. Der Koordinator liegt bei −23 dBm** und macht mit 134 von 962 Paketen
14 % des Verkehrs aus. Er steht sehr nah an Analyzer 04. Das ist im Auge
zu behalten: Auf 868 MHz war ein starker Sender in unmittelbarer Nähe
genau der Verdacht bei den Empfangsaussetzern von Analyzer 01. Ob ein
EFR32 darauf ebenso empfindlich reagiert wie der CC1101, weiß ich nicht —
es ist eine Beobachtung, keine Behauptung.

### Wiederholungen: 246 von 962 (26 %)

Nicht vorschnell als Netzproblem lesen. **Zigbee wiederholt Rundrufe
bauartbedingt mehrfach**, und ein großer Teil des Verkehrs sind
Link-Status-Rundrufe. Erst die Trennung nach Rundruf und gezielter
Sendung sagt, ob es echte Fehlversuche sind. Das Werkzeug schlüsselt das
jetzt auf; Ergebnis steht aus.

---

## 18.08.2026 — **M16.1 abgenommen.** Der Mithörer hört das eigene Netz

Firmware aufgespielt, Stick an Analyzer 04. Ergebnis eines
60-Sekunden-Mitschnitts:

| Abnahmekriterium | Ergebnis |
| --- | --- |
| Sauberes JSON je Paket | **962 Pakete, 0 unlesbare Zeilen** |
| Kanal | **11 durchgängig**, kein Ausreißer |
| RSSI vorhanden und plausibel | **−23 bis −94 dBm**, Mittel −61 |
| LQI vorhanden und plausibel | **0 bis 255**, Mittel 195 |
| Eigenes Netz wiedererkannt | **ja — siehe unten** |

**Die eigentliche Abnahme ist die PAN-ID.** Ein MAC-Decoder über eine
Stichprobe von 68 Zeilen ergab:

```text
PAN 0x⟨PAN⟩ (eigenes Netz)   41 Pakete   ← eigenes Netz
PAN 0x⟨PAN-A⟩ (Nachbarnetz A)    2 Pakete   ← fremdes Netz
```

**⟨PAN⟩ ist genau die PAN-ID, die am 16.08. aus deCONZ ausgelesen wurde.**
Damit ist bewiesen, dass der Stick das eigene Netz hört und nicht das des
Nachbarn — das war das Kriterium, das „es kommen Zeilen" nicht erfüllt.

Nebenbei fällt ein **zweites Netz in Hörweite** an: 0x⟨PAN-A⟩, schwach
(−87 bis −93 dBm). Für die spätere Störbild-Auswertung ist das genau die
Art von Beobachtung, die der Koordinator nie liefern könnte.

Weitere Befunde aus der Stichprobe:

- **19 verschiedene Absender** in nur 68 Zeilen.
- Der **Koordinator (0x0000) liegt bei −31 dBm** — er steht sehr nah an
  Analyzer 04.
- Rahmentypen: 43 Daten, 25 Bestätigungen. Die `L:5`-Pakete sind
  Bestätigungen, wie im Handbuch (Kapitel 8.3) behauptet — hiermit belegt.
- **RSSI und LQI verhalten sich stimmig zueinander:** starke Pakete haben
  LQI 255, Pakete unter −85 dBm fallen auf LQI 0 bis 40.

**Für die Pi-3-Frage (M16.3):** 962 Pakete/Minute sind rund **16 Pakete je
Sekunde**. Das ist für den Decoder unkritisch — die Sorge um 1 MBaud
entschärft sich damit deutlich. Der 24-Stunden-Lasttest bleibt trotzdem
stehen, denn Spitzenlast ist etwas anderes als Mittelwert.

Der Decoder aus dieser Auswertung liegt als
`werkzeuge/auswerten.py` im Projekt und ist der **Entwurf für M16.3**.

**Offen geblieben:** Ob `-hupcl` nötig ist, ist unbewiesen — der erste
Mitschnitt lief auch ohne. Möglich, dass die Firmware ohnehin auf Kanal 11
startet. Zu prüfen mit `{"C":15}`: Hört der Verkehr auf, wirkt der Befehl.

---

## 18.08.2026 — `--bootloader-reset rts_dtr` greift; Platzhalter-Falle beseitigt

Der Befehlszeilenweg funktioniert: Das Werkzeug meldet
`Triggering rts_dtr bootloader`. Damit ist der Schalter **am Gerät bestätigt**
und nicht mehr „ungeprüft" — der Bootloader wird erzwungen, das Erkennen der
laufenden Firmware entfällt.

Abgebrochen ist es an etwas anderem, und das war mein Fehler:

```text
FileNotFoundError: No such file or directory: '/dev/serial/by-id/usb-…'
```

Ich hatte einen **Platzhalter geschrieben, der wie ein echter Wert aussieht**.
Im Handbuch stand dieselbe Falle dreimal: ein erfundener, plausibel wirkender
Gerätename mit Seriennummer. So etwas wird kopiert, nicht ersetzt — und der
Fehler sieht danach aus wie ein defekter Stick.

Behoben, und zwar an der Wurzel: Kapitel 5 **ermittelt** den Namen jetzt, statt
ihn vorzuzeigen —

```bash
STICK="/dev/serial/by-id/$(ls -1 /dev/serial/by-id/ | head -1)"
```

— und alle folgenden Kapitel benutzen nur noch `$STICK`. Der erfundene Name
steht nur noch an einer einzigen Stelle: in einem als **Ausgabe** ausgezeichneten
Block, wo er hingehört. Kapitel 11 hat eine Zeile zu `FileNotFoundError`
bekommen mit dem Merksatz „Namen nie abtippen".

**Regel für alle künftigen Anleitungen:** Ein Platzhalter, der wie ein gültiger
Wert aussieht, ist kein Platzhalter, sondern eine Fehlerquelle. Entweder
ermitteln lassen oder unübersehbar als Lücke kennzeichnen.

23 Seiten, 111 interne Verweise, Sprungmarken geprüft.

---

## 18.08.2026 — Stick da, Web-Flasher scheitert am Erkennen

Erstes Protokoll vom Windows-Rechner. **Der Stick ist in Ordnung** — belegt
durch eine einzige Zeile:

```text
08:03:47 bellows.ash Received frame RStackFrame(version=2,
         reset_code=<NcpResetCode.RESET_POWER_ON: 2>)
```

Das ist eine gültige ASH-Antwort. USB, Windows-Treiber, COM-Port und die
Werksfirmware arbeiten. Der Stick läuft ab Werk mit **EmberZNet-NCP (EZSP)
bei 115200 Baud** — damit ist nebenbei bestätigt, dass der `bellows`-Rückfall
aus M16.1 überhaupt in Frage kommt.

Was scheitert, ist das **Erkennen** durch den Web-Flasher: Nach dem RSTACK
kommt vier Sekunden nichts, dann bricht er ab und probiert weiter. Am Ende
meldet er „Failed to probe running application type". Die anderen Versuche
(CPC, Spinel) lesen nur dieselben ASH-Daten bei falscher Baudrate — daher das
scheinbare Kauderwelsch im Protokoll.

Der erste Versuch, `GECKO_BOOTLOADER` bei 115200, bekommt **gar keine
Antwort**. Genau das ist der Kern: Der Stick ist nicht im Bootloader, und der
Browser bringt ihn nicht hinein, weil er die Steuerleitungen (RTS/DTR) nicht
in der Hand hat.

Zwei Wege daraus, beide ins Handbuch eingearbeitet:

- **Befehlszeile am Pi** mit `--bootloader-reset rts_dtr` — erzwingt den
  Bootloader, ohne die laufende Firmware erkennen zu müssen (Kapitel 6.3).
- **BOOT-Knopf** — Gehäuse öffnen (zwei Kreuzschlitzschrauben), BOOT halten
  und dabei einstecken; dann greift der erste Versuch des Web-Flashers sofort
  (Kapitel 6.4).

Handbuch dazu umgebaut: Kapitel 6 hat jetzt einen Abschnitt „Erst in den
Bootloader" mit dem Fehlerbild im Klartext, und Kapitel 11 zwei neue Zeilen.
Der Web-Flasher ist vom Hauptweg zum zweiten Weg geworden. **21 Seiten.**
---

## 17.08.2026 — Handbuch: Sprungmarken nachgerüstet, Prüfung dazu gebaut

Vier Beanstandungen des Users, alle berechtigt:

1. **Abbildung in Kapitel 8 abgeschnitten.** Die Beschriftungen hingen als
   rechtsbündige Fahnen links neben der Zeile und liefen aus dem Bild.
   Ersetzt durch eine Legende darunter — die kann baulich nicht überlaufen.
2. **Keine Sprungmarken.** 14 Kapitelüberschriften ohne `id`.
3. **Inhaltsverzeichnis sprang nicht.** Jetzt ist die ganze Zeile der
   Verweis, nicht nur die Kapitelnummer.
4. **Kein Rücksprung in der Fußzeile.** Ursache war mein Entwurf: Ich hatte
   den Rücksprung in einen CSS-Seitenrandbereich (`@bottom-center`) gelegt.
   **WeasyPrint erzeugt dafür keine Verweis-Annotation** — der Text stand da
   und tat nichts. Jetzt ein fest positioniertes Element, wie es das große
   Handbuch schon immer macht. Dessen CSS sagt das sogar ausdrücklich; ich
   hatte es gelesen und trotzdem den anderen Weg genommen.

Gemessen, nicht behauptet: **108 interne Verweise, Rücksprung auf allen 20
Seiten, 22 Lesezeichen.**

**Das große Handbuch war nie betroffen** — 182 interne Verweise, Rücksprung
auf allen 130 Seiten. Nachgemessen, nicht angenommen.

Damit es nicht wieder passieren kann: `tools/pruefe-sprungmarken.py` prüft am
**fertigen PDF** (nicht am HTML, dort ist der Fehler unsichtbar) interne
Verweise, Rücksprung je Seite und Lesezeichen — für jedes Handbuch des
Projekts. Läuft bei jedem Handbuch-Bau und in `tools/pruefe-alles.sh`.
Gegengeprüft: an einer absichtlich kaputten Fassung schlägt sie an.

---

## 17.08.2026 — Anwenderhandbuch angelegt (Entwurf 1)

`handbuch/` enthält jetzt ein eigenständiges Buch für den Anwender: 14 Kapitel,
20 Seiten A4, vom Auspacken des Sticks bis zum ersten gelesenen Funkpaket.
Gebaut mit `bash handbuch/build.sh` (WeasyPrint aus eigener Umgebung).

Bewusst anders als das große Handbuch:

- **Indigo statt Petrol.** Zwei Bücher, die nebeneinander liegen, dürfen sich
  nicht ähnlich sehen — das eine gehört zu 868 MHz, das andere zu 2,4 GHz.
- **Echte CSS-Seitenrandbereiche** (`@bottom-*`) statt eines fest
  positionierten Fußstegs. Das große Handbuch stammt noch aus der
  Chromium-Zeit, wo es die nicht gab; dort ist eine eigene Prüfung nötig,
  damit der Steg keinen Text verdeckt. Hier kann er es baulich nicht.
- **Alles Unbestätigte trägt sichtbar den Vermerk `ungeprüft`.** Der Stick ist
  noch nicht da; ein Handbuch, das so tut, als wäre alles nachgemessen, wäre
  eine Lüge auf Hochglanz.

Zu ersetzen, sobald der Stick läuft: Adresse und Bedienung des Web-Flashers
(6.2), Schreibweise der `universal-silabs-flasher`-Schalter (6.3), USB-Kennung
(Kapitel 5), ob die Antenne abnehmbar ist (Kapitel 3), Wireshark-Einrichtung
(Kapitel 10).

---

## 17.08.2026 — Stickwechsel vollzogen

**-P storniert, -E kommt heute abend.** Der Plan ist entsprechend umgebaut:
M16.1 führt jetzt über den -E und die fertige Sniffer-Firmware, der Weg über
`bellows` steht als Rückfall darunter. TI-Werkzeugkette und `cc2538-bsl` sind
aus dem Plan verschwunden — sie werden nicht mehr gebraucht.

Zwei Risiken sind neu in der Tabelle, weil sie mit dem -E dazukommen: Die
Firmware hat **einen** Betreuer, und **1 MBaud** muss der Pi 3 aushalten. Beides
ist beherrschbar, aber beides gehört aufgeschrieben statt beschwiegen.

Was heute abend dran ist, sobald der Stick da ist — Schritt 1 bis 5 aus M16.1:
Kennung festhalten, Firmware aufspielen, 1 MBaud öffnen, `{"C":11}` senden,
zehn Minuten mitschneiden, eine bekannte Leuchte wiedererkennen.

---

## 17.08.2026 — ZBDongle-E angeboten, geprüft, empfohlen

Für den **ZBDongle-E** (EFR32MG21) gibt es fertige Sniffer-Firmware:
[ErkSponge/Sniffer_802.15.4_SONOFF_USB_Dongle_Plus_E](https://github.com/ErkSponge/Sniffer_802.15.4_SONOFF_USB_Dongle_Plus_E).
Nachgesehen, was sie ausgibt — und das ist der Grund für die Empfehlung:

```json
{"L":50,"Q":255,"R":-94,"C":11,"S":"4188a31e48ffff0000..."}
```

**Zeilenweises JSON über den seriellen Anschluss, 1 MBaud.** `L` Länge,
`Q` LQI, `R` RSSI, `C` Kanal, `S` das Paket in Hex. Kanalwechsel durch
Senden von `{"C":11}`.

Das ist derselbe Bauplan wie unser BidCoS-Protokoll: eine Zeile je Ereignis,
lesbar, mit Empfangsstärke. `core/src/ingest/lineSplitter.ts` steht schon da,
der Decoder wird ein `JSON.parse` je Zeile. **Kein TI-SDK, kein Python im
Betriebspfad, keine Fremdabhängigkeit im Core.**

Aufspielen als `.gbl` über den Web-Flasher (darkxst.github.io, WebSerial im
Browser) oder XModem — **ohne Konsole**, passend zur Projektregel.

**Damit ändert sich der eingeschlagene Weg.** Der -E wird der vorgesehene
Stick; der -P bleibt als Reserve-Koordinator liegen und ist nicht verloren.
Die Werkbankprobe mit dem -P (M16.1, Schritt 2) wird zum Rückfall, falls der
-E enttäuscht.

**Meine Empfehlung vom 16.08. ist damit überholt.** Der Vergleich lief
gegen den CC2674P10 und war für dieses Paar richtig — den -E hatte ich nicht
angesehen und dabei übersehen, dass die Mithör-Lage sich je Hersteller völlig
unterscheidet: Bei Silabs liegt fertige Firmware herum, bei TI muss man sie
bauen.

Offen bleibt: Wie verhält sich 1 MBaud auf dem Pi 3 unter Last (M16.3), und
wie tragfähig ist ein Firmware-Projekt mit einem Betreuer. Das Format ist
einfach genug, um notfalls selbst gepflegt zu werden.

---

## 17.08.2026 — Bezugsquellen geprüft, M16.1 überarbeitet

Nachgesehen, woher die Software kommt. Zwei Ergebnisse, beide belegt:

**`zigpy-cli packet-capture` scheidet für den -P aus.** Im Quelltext
nachgeschlagen: `bellows` (Silabs/EZSP) hat `_packet_capture` über die
mfglib-Funktionen, `zigpy-znp` (TI/CC2652) hat es **nicht**. In der ersten
Planfassung stand es als gleichwertiger zweiter Weg — gestrichen.

**TI liefert `sniffer_fw.hex` nur für seine LaunchPads.** Der ZBDongle-P ist
keins. Der Chip passt (CC2652P und CC1352P1 sind dieselbe Familie), die
UART-Beinchen zum CP2102N liegen auf dem Dongle aber möglicherweise anders.
Ob das Abbild trotzdem redet, ist **die** offene Frage von M16.1 und in einer
halben Stunde beantwortet.

M16.1 hat dafür jetzt eine Bezugsquellen-Tabelle, einen Ablauf in sechs
Schritten und eine Entscheidungstabelle für den Fall, dass der Stick stumm
bleibt.

**Nachtrag zur Stickwahl:** Zum reinen Mithören wäre der ZBDongle-**E**
(EFR32) der kürzere Weg gewesen — `bellows` schnüffelt dort mit der
Werksfirmware, ohne jedes Umflashen. Mein Vergleich am 16.08. lief gegen den
CC2674P10, nicht gegen den -E; für dieses Paar war die Begründung richtig, den
-E hatte ich nicht angesehen. Kein Grund, jetzt etwas nachzukaufen — erst
Schritt 2, dann entscheiden.

---

## 17.08.2026 — Planung abgeschlossen

Plan angelegt, Phasen M16.1 bis M16.9 festgelegt, acht Leitentscheidungen
festgehalten.

Vorgaben aus dem Auftrag eingearbeitet:

- Der Verbund läuft auf **Pi 3, Pi 4 und Pi 5**. Der Pi 3 ist die Messlatte
  für jede Abnahme, die Laufzeitcode betrifft.
- Zigbee ist **im Setup-Assistenten und in der Oberfläche** wählbar und
  aktivierbar (M16.5).
- Zigbee bekommt eine **eigene Einstellungsseite** unter `/zigbee` (M16.6).
- Die Platinenlösung ist Fernziel, kein Auftrag. Einziger Einfluss auf den
  Plan: Der Decoder bleibt von der Herkunft der Daten unabhängig.

**Eine Warnung wieder eingezogen.** Ich hatte die udev-Regel als Gefahr für
den Sniffer-Empfang beschrieben — das ist falsch und war ungeprüft. Nachgesehen:

- `DEFAULT_DEVICE` in `core/src/ingest/sttyPort.ts` steht fest auf
  `/dev/asksin-hat`,
- der Assistent schreibt denselben Namen in die Konfiguration,
- **einen Rückfall auf `asksin-usb` gibt es im Code nirgends.**

Alle fünf Analyzer laufen über den GPIO-Header (`ttyAMA0`), die USB-Anschlüsse
sind bis auf die SSD frei. Ein zusätzlicher USB-Stick kann dem Sniffer nichts
wegnehmen. M16.2 bleibt im Plan, aber als Routine: Der Zigbee-Stick braucht
einen festen eigenen Namen, damit er nicht zwischen `ttyUSB0` und `ttyUSB1`
wandert. Die zu enge Auffangregel betrifft nur die USB-Variante der Platine,
also andere Anwender des öffentlichen Repos.

**Nächster Schritt:** Warten auf den Stick. Bis dahin wird nichts gebaut.

---

## 16.08.2026 — Voruntersuchung, Ergebnis

deCONZ 2.32.5 / REST-API 1.16.0 abgefragt. Ergebnis:

| Vorhanden | Nicht vorhanden |
| --- | --- |
| IEEE- und Kurzadresse, Hersteller, Modell, Name | **LQI** |
| `lastseen`, `lastannounced` je Gerät | **RSSI** |
| `reachable` je Teilgerät mit Zeitstempel | Nachbarschaftstabellen, Routen |
| Kanal 11, eigene PAN-ID, Websocket | Sendezeiten, Wiederholungen |

**Schluss daraus:** Der Weg allein über die Koordinator-Schnittstelle liefert
eine Bestandsaufnahme, aber keine Empfangsbewertung — also nicht das, wofür
dieses Projekt da ist. Ein zweiter Stick ist keine Bequemlichkeit, sondern die
Voraussetzung.

Stichprobe nebenbei: Alle 33 Leuchten innerhalb von sechs Minuten gehört,
keine über 24 Stunden stumm, keine unerreichbar. **Das Netz läuft.** Es gibt
gerade nichts zu finden — der Ertrag liegt in der Standortmessung und im
Störbild, nicht in der Fehlersuche.

Stick entschieden und bestellt: **SONOFF ZBDongle-P (CC2652P)**, nicht der
CC2674P10. Grund: TI dokumentiert den Packet Sniffer 2 ausdrücklich für
CC26x2, den CC2674 nicht. Bei einem Werkzeug, dessen einziger Zweck diese
Firmware ist, war das ausschlaggebend — dazu die abnehmbare Antenne und die
Verwendbarkeit als Reserve-Koordinator, falls das Vorhaben im Sande verläuft.

**Der API-Schlüssel aus dem Test ist nirgends gespeichert** und darf nirgends
gespeichert werden. Das Repository ist öffentlich.
