# Zigbee-Integration (M16)

**Stand: 17.08.2026 — Planung. Es ist noch nichts gebaut.**

Dieser Ordner ist ein Arbeitsplatz, kein Erzeugnis.

| Datei | Wofür |
| --- | --- |
| `README.md` (hier) | Der Plan: was gebaut wird, in welcher Reihenfolge, mit welchen Entscheidungen |
| [`stand.md`](stand.md) | Tagebuch — was tatsächlich gemessen wurde, neueste Einträge oben |
| [`handbuch/`](handbuch/) | **Eigenständiges Handbuch für den Anwender**, vom Auspacken des Sticks an. Wird separat gepflegt und erst nach Abschluss als Kapitel ins große Handbuch übernommen. Bauen mit `bash handbuch/build.sh` |

Plan und Handbuch haben verschiedene Leser: Der Plan richtet sich an den, der
baut, das Handbuch an den, der es hinterher benutzt. Was im Handbuch als
**ungeprüft** markiert ist, entspricht den offenen Fragen in Abschnitt 8
dieses Plans.

---

## 1. Zweck

Der Analyzer misst heute die **Empfangsqualität eines BidCoS-Funknetzes**:
Wer sendet, wie stark kommt es an, wo ist ein Funkloch, welches Gerät hört
niemand. Genau diese Fragen sollen für **Zigbee** ebenfalls beantwortbar
werden — mit denselben Ansichten, demselben Verbund und derselben
Langzeitauswertung.

Was Zigbee dabei **nicht** wird: eine Steuerung. Der Analyzer schaltet nichts,
koppelt nichts und tritt dem Netz nicht bei. Er hört zu. Das ist bei BidCoS so
und bleibt bei Zigbee so.

### Warum das überhaupt lohnt

Aus der Voruntersuchung vom 16.08.2026 (siehe Abschnitt 2) blieb ein einziges,
aber tragfähiges Argument übrig:

> Der Koordinator kann prinzipiell nicht sagen, **mit wie viel Reserve** ein
> Gerät empfangen wird. Er weiß nur, ob eine Antwort kam. Ein Mithörer weiß es.

Dazu kommt ein zweiter Punkt, der sich bei der Bestandsaufnahme ergeben hat:
Das Netz funkt auf **Kanal 11** — dem untersten Zigbee-Kanal, der genau unter
WLAN-Kanal 1 liegt. Ob sich dort etwas ins Gehege kommt, ist mit den Mitteln
des Koordinators nicht feststellbar.

---

## 2. Ausgangslage (gemessen, nicht vermutet)

| | |
| --- | --- |
| Koordinator | ConBee III an einem eigenen Rechner, deCONZ 2.32.5, REST-API 1.16.0 |
| Netz | Kanal 11, eigene PAN-ID, rund 35 Geräte (überwiegend Leuchten) |
| Zustand des Netzes | unauffällig — alle Geräte innerhalb von Minuten gehört, keines dauerhaft stumm |
| REST-API liefert | IEEE- und Kurzadresse, Hersteller, Modell, Name, `lastseen`, `reachable` |
| REST-API liefert **nicht** | **LQI, RSSI, Nachbarschaftstabellen, Routen, Sendezeiten** |
| Mithör-Hardware | **SONOFF ZBDongle-E (EFR32MG21)**, kommt am 17.08.2026 abends. Der zuvor bestellte ZBDongle-P (CC2652P) ist storniert |

**Die entscheidende Zeile ist die vierte.** Sie ist der Grund, warum der Weg
über die deCONZ-Schnittstelle allein nicht genügt und ein zweiter Stick
tatsächlich gebraucht wird: Ohne LQI und RSSI gäbe es eine Geräteliste zu
einem Netz, das ohnehin läuft — aber keine Empfangsbewertung.

**Der ConBee III bleibt unangetastet.** Er kann nicht gleichzeitig Koordinator
und Mithörer sein. Wer ihn umflasht, legt sein Zigbee-Netz still.

---

## 3. Leitentscheidungen

Diese acht Punkte stehen vor der ersten Zeile Code fest. Wer sie später
umwirft, wirft den Plan um — das ist erlaubt, soll aber bewusst geschehen.

### E1 — Der BidCoS-Pfad wird nicht angefasst

Zigbee bekommt einen **eigenen Datenpfad**: eigenes Modul unter
`core/src/zigbee/`, eigene Tabellen, eigene API-Zweige, eigene Seite. Geteilt
wird nur die Grundausstattung (Persistenz, Protokoll, Verbund, Status,
InfluxDB).

*Warum:* Der Analyzer hat eine Aufgabe, die er nie verfehlen darf — Telegramme
mitschreiben. Ein zweiter Empfänger im selben Prozess ist ein Risiko für genau
diese Aufgabe. Getrennte Pfade heißt: Ein Fehler in Zigbee kostet Zigbee, nicht
den Analyzer.

### E2 — Standardmäßig aus

Ohne ausdrückliche Aktivierung ändert sich für eine bestehende Installation
**nichts**: kein Menüpunkt, kein Prozess, keine Tabelle, kein Fehler im
Protokoll. Eine Konfiguration ohne `zigbee`-Block ist gültig.

*Warum:* Vier der fünf Analyzer werden Zigbee vermutlich nie brauchen. Eine
Erweiterung, die sich bei allen bemerkbar macht, ist keine Option, sondern eine
Zumutung.

### E3 — Fehlt der Stick, läuft der Analyzer trotzdem

Ist Zigbee aktiviert und der Stick nicht da (abgezogen, defekt, falscher
Gerätename), meldet die Oberfläche das ruhig und deutlich. Der Dienst startet,
BidCoS läuft weiter. Kein Startabbruch, keine Neustartschleife.

### E3b — Zigbee im Verbund setzt einen Mithörer **auf dem Master** voraus

Festgelegt am 18.08.2026. Ohne eigenen Mithörer gibt es auf dem Master keine
Verbund-Auswertung für Zigbee — der Reiter erscheint nicht, und der API-Zweig
antwortet mit 501 samt Begründung.

*Warum:* Wer zusammenführt, soll selbst messen. Ein Master, der nur fremde
Zahlen weiterreicht, hätte keine eigene Zeile in der Matrix — und dann könnte
niemand sagen, ob ein „nirgends gehört" an den Standorten liegt oder daran,
dass der Master gar nicht hinhört.

**Clients dürfen Zigbee unabhängig davon lokal betreiben.** Sie sehen ihre
eigenen Daten unter *Meldungen · Zigbee*. Ob sie im Verbund erscheinen,
entscheidet der Master über seine Gegenstellenliste — dieselbe Liste wie bei
BidCoS, keine zweite.

### E4 — Ein Kanal zur Zeit, und zwar der des eigenen Netzes

Der Sniffer hört auf **einem** Kanal. Voreinstellung ist der Kanal des eigenen
Netzes (hier 11), einstellbar in der Oberfläche. Ein Kanalwechsel ist ein
bewusster Vorgang mit Neustart des Empfängers, kein Hin- und Herspringen.

*Warum:* Ein hüpfender Sniffer verpasst auf jedem Kanal das meiste. Eine
Kanalübersicht („wo ist am wenigsten los") ist ein eigener Betriebsmodus für
später — ausdrücklich **nicht** gleichzeitig mit dem Mitschnitt.

### E5 — Kein Grundrauschen, solange es nicht ehrlich messbar ist

Die BidCoS-Seite hat einen Rauschpegel, weil die Firmware ihn dauerhaft
ausliest. Die Sniffer-Firmware liefert RSSI **je Paket**, nicht zwischen den
Paketen. Bis geklärt ist, ob ein Energiescan sinnvoll dazwischenpasst, gibt es
für Zigbee **keinen** Rauschwert — und schon gar keinen erfundenen.

### E6 — Inhalte bleiben verschlossen

Zigbee-Nutzdaten sind AES-128-CCM* verschlüsselt. Ohne Netzschlüssel bleibt
sichtbar: Adressen, Rahmentyp, Zähler, Kanal, **RSSI und LQI**. Das genügt für
den Zweck vollständig. **Der Netzschlüssel wird nicht abgefragt, nicht
gespeichert und nicht unterstützt.**

*Warum:* Er wird für die Empfangsmessung nicht gebraucht, und ein Werkzeug, das
ihn speichert, wird zu etwas anderem als einem Messgerät.

### E7 — Fremde Firmware wird nicht mitgeliefert

Die TI-Sniffer-Firmware hat eigene Lizenzbedingungen. Sie kommt **nicht** ins
Repository. Der Einrichtungsweg beschreibt, woher sie stammt und wie sie
aufgespielt wird; heruntergeladen wird sie zur Laufzeit oder vom Anwender.

### E8 — Netzwerkkonfiguration bleibt tabu

Der 2,4-GHz-Empfang leidet, wenn das WLAN des Pi direkt daneben sendet. Das
gehört in die Aufbauhinweise als **Empfehlung an den Anwender** (Kabel statt
WLAN, 5 GHz statt 2,4 GHz). Die Software fasst die Netzwerkeinstellungen des
Rechners nicht an — das gilt hier wie überall im Projekt.

---

## 4. Hardware und die drei Pi-Modelle

Im Verbund laufen **Pi 3, Pi 4 und Pi 5**. Der Stick hängt an USB, also
grundsätzlich an allen dreien — die Unterschiede liegen woanders:

| | Pi 3 | Pi 4 | Pi 5 |
| --- | --- | --- | --- |
| USB | 4× USB 2.0, **gemeinsam mit dem Ethernet an einem Hub** | 2× USB 3.0, 2× USB 2.0, Ethernet getrennt | 2× USB 3.0, 2× USB 2.0, Ethernet getrennt |
| Strombudget USB | ca. 1,2 A gesamt | 1,2 A | 1,6 A |
| Rechenleistung | 4× 1,2 GHz — **der Engpassfall** | 4× 1,5 GHz | 4× 2,4 GHz |
| Arbeitsspeicher | 1 GB — **der zweite Engpassfall** | ab 2 GB | ab 4 GB |

Der Stick zieht rund 100 mA; das ist an keinem Modell ein Problem. Die
Prüfsteine sind Rechenleistung und Speicher auf dem Pi 3, und deshalb gilt:

> **Der Pi 3 ist die Messlatte, nicht der Pi 5.** Jede Phase, die Laufzeitcode
> hinzufügt, wird auf dem Pi 3 abgenommen. Was dort nicht mitkommt, ist nicht
> fertig.

Zwei Aufbauhinweise, die sich aus dem Zweck ergeben:

- **USB-Verlängerung (0,5–1 m) einplanen.** Sie bringt die 2,4-GHz-Antenne weg
  vom Rechner und weg von der 868-MHz-Antenne. Bei einem Gerät, dessen Zweck
  das Messen ist, ist das kein Zubehör.
- **Abnehmbare Antenne nutzen**, falls der Stick eine hat (beim Auspacken
  prüfen). Damit lassen sich
  Antennen vergleichen oder eine Störquelle mit einer Richtantenne einkreisen.

---

## 5. Phasen

Jede Phase hat ein **Ergebnis**, das man ansehen kann, und eine **Abnahme**,
die man messen kann. Keine Phase gilt als fertig, weil der Code geschrieben
ist.

---

### M16.1 — Stick in Betrieb nehmen *(Werkbank, kein Analyzer-Code)*

**Ziel:** Wissen, ob und wie der Stick das liefert, was wir brauchen — bevor
irgendetwas im Analyzer entsteht.

**Der Stick ist der SONOFF ZBDongle-E (EFR32MG21).** Der zunächst bestellte
ZBDongle-P (CC2652P) wurde am 17.08.2026 storniert — Begründung in
[`stand.md`](stand.md).

#### Woher die Software kommt

| Teil | Quelle | Hinweis |
| --- | --- | --- |
| **Sniffer-Firmware** (`.gbl`) | [ErkSponge/Sniffer_802.15.4_SONOFF_USB_Dongle_Plus_E](https://github.com/ErkSponge/Sniffer_802.15.4_SONOFF_USB_Dongle_Plus_E) | Fertig gebaut für genau diesen Stick. **Nicht ins Repo** (E7) — verlinken, nicht mitliefern |
| **Flashen im Browser** | Web-Flasher (WebSerial, Chrome/Edge) | Ohne Konsole, vom Windows-Rechner aus |
| **Flashen auf dem Pi** | `pip install universal-silabs-flasher` | Für den späteren Einrichtungsweg der Anwender |
| **Erstprüfung** | Wireshark + das Extcap aus demselben Projekt | Windows-`.exe` und Python-Fassung für Linux — nur zur Erstprüfung, danach nie wieder |
| Rücksicherung Koordinator-Firmware | [itead/Sonoff_Zigbee_Dongle_Firmware](https://github.com/itead/Sonoff_Zigbee_Dongle_Firmware) | Macht den Stick wieder zum Koordinator |

#### Das Ausgabeformat — der Grund für die Stickwahl

```json
{"L":50,"Q":255,"R":-94,"C":11,"S":"4188a31e48ffff0000..."}
```

Zeilenweises JSON über den seriellen Anschluss, **1 MBaud**: `L` Länge,
`Q` LQI, `R` RSSI, `C` Kanal, `S` das Paket in Hex. Kanalwechsel durch Senden
von `{"C":11}` — passt zu E4, ein bewusster Vorgang.

**Das ist derselbe Bauplan wie unser BidCoS-Protokoll**: eine Zeile je
Ereignis, lesbar, mit Empfangsstärke. `core/src/ingest/lineSplitter.ts` steht
schon da; der Decoder aus M16.3 wird ein `JSON.parse` je Zeile. Kein SDK, kein
Python im Betriebspfad, keine neue Abhängigkeit im Core.

#### Ablauf

1. Anstecken, `lsusb` und `udevadm info` festhalten: **VID, PID, Seriennummer,
   Produktname**. Der -E benutzt vermutlich einen CH9102F statt eines CP2102N —
   das entscheidet die Regel in M16.2.
2. Sniffer-Firmware aufspielen. **Danach ist der Stick kein Koordinator mehr**;
   der Rückweg steht in der Tabelle oben.
3. Seriellen Anschluss mit 1 MBaud öffnen, `{"C":11}` senden, mitlesen.
4. Rohausgabe auf Kanal 11 mitschneiden, **mindestens eine bekannte Leuchte
   wiedererkennen** (Kurzadresse aus deCONZ gegen die Aufnahme halten).
5. Aufnahme als Testmaterial für M16.3 zur Seite legen.

#### Rückfall, falls die Firmware enttäuscht

Auf demselben Stick liegt ein zweiter, unabhängiger Weg: `bellows` (Silabs,
EZSP) hat `_packet_capture` über die mfglib-Funktionen, also

```text
zigpy radio ezsp /dev/asksin-zigbee packet-capture -c 11 -o -
```

Das arbeitet **mit der Koordinator-Firmware ab Werk**, verlangt aber Python im
Betriebspfad (Helfer schreibt pcap, Core liest pcap — Muster wie beim
SPI-Helfer) und setzt voraus, dass die mitgelieferte Firmware mfglib
tatsächlich freigibt. Ungeprüft. Deshalb Rückfall, nicht Hauptweg.

Für TI/CC2652 gäbe es diesen Rückfall übrigens nicht: `zigpy-znp` hat kein
`packet_capture`. Das war einer der Gründe für den Wechsel auf den -E.

**Abnahme:** Eine Aufnahme von 10 Minuten liegt vor; darin sind Adressen,
RSSI und LQI erkennbar; ein Gerät ist zweifelsfrei zugeordnet. Das serielle
Format ist so weit verstanden, dass ein Decoder dafür schreibbar ist.

**Ergebnis in `stand.md` festhalten** — Firmwareweg, Version, Formatnotizen.

---

### M16.2 — Gerätename und udev *(klein, Routine)*

**Ergebnis:** Eine Regel in `hardware/99-asksin-analyzer.rules`, die dem
Zigbee-Stick anhand seiner **Seriennummer** den festen Namen
`/dev/asksin-zigbee` gibt — nach demselben Muster wie beim Sniffer, damit
`ttyUSB0` nirgends im Klartext auftaucht.

**Für unsere Analyzer ist das unkritisch**, und das ist geprüft: Alle fünf
laufen über den GPIO-Header, also `ttyAMA0` → `/dev/asksin-hat`.
`DEFAULT_DEVICE` in [`core/src/ingest/sttyPort.ts`](../../core/src/ingest/sttyPort.ts)
steht fest darauf, der Assistent schreibt denselben Namen in die
Konfiguration, und **einen Rückfall auf `asksin-usb` gibt es nirgends im
Code**. Der Core sucht sich seinen Anschluss nicht, er bekommt ihn vorgegeben.
Ein zusätzlicher USB-Stick kann ihm deshalb nichts wegnehmen.

Eine Kleinigkeit bleibt trotzdem zu erledigen, allerdings für andere: Die
Auffangregel vergibt `/dev/asksin-usb` an **jeden** CP2102N. Wer das Projekt
mit der **USB-Variante der Platine** betreibt — im öffentlichen Repo eine
vorgesehene Betriebsart — bekäme den Namen unter Umständen am Zigbee-Stick.
Also: Regel um die Seriennummer oder die Produktzeichenkette einengen.

Möglicherweise erübrigt sich das: Benutzt der -E einen **CH9102F**, hat er eine
andere Kennung und kann die CP2102N-Regel gar nicht auslösen. Steht nach
Schritt 1 von M16.1 fest — und die Regel wird trotzdem eingeengt, weil sich
sonst niemand darauf verlassen kann.

**Abnahme:** Stick gesteckt, dreimal neu gestartet, zwischendurch abgezogen und
in anderer Reihenfolge wieder angesteckt — `/dev/asksin-zigbee` zeigt jedes Mal
richtig, `/dev/asksin-hat` bleibt unverändert. Auf einem Pi 3 und einem Pi 5
geprüft.

---

### M16.3 — Empfang und Decoder im Core *(ohne Oberfläche)*

**Ergebnis:** `core/src/zigbee/` — Leser, Rahmentrenner, Decoder, Warteschlange.
Gebaut nach dem Vorbild von `core/src/ingest/` und `core/src/decode/`, aber
getrennt davon (E1).

Inhalte:

- **Leser** auf `/dev/asksin-zigbee`, Wiederanlauf bei Abzug (E3).
- **Rahmentrenner** für das serielle Format aus M16.1.
- **Decoder**: Kanal, RSSI, LQI, Rahmentyp (Beacon / Daten / Bestätigung /
  Kommando), MAC-Quelle und -Ziel, NWK-Quelle und -Ziel, Zähler. Nutzdaten
  bleiben verschlossen (E6).
- **Begrenzte Warteschlange mit Verwurfzähler.** Läuft sie voll, wird verworfen
  und **gezählt** — nicht gepuffert, bis der Speicher voll ist. Der Zähler
  gehört in die Oberfläche; eine stille Kürzung wäre eine Lüge.

**Abnahme:**

- Einheitentests gegen die echten Aufnahmen aus M16.1 — so wie beim
  BidCoS-Parser. **Keine Testdaten, die aus derselben Formel stammen wie der
  Code**; dieser Fehler ist im Projekt schon einmal passiert und hat einen
  kaputten Parser grün aussehen lassen.
- Mülleingabe (halbe Rahmen, Bitfehler, Abbruch mitten im Paket) führt zu
  „verworfen", nicht zum Absturz.
- **Pi-3-Lasttest, 24 Stunden:** Speicher- und CPU-Verlauf von BidCoS **mit**
  und **ohne** Zigbee. Die BidCoS-Telegrammrate darf sich nicht messbar ändern,
  der Speicher nicht wachsen.

---

### M16.4 — Speicherung und Aufbewahrung

**Ergebnis:** Eigene Tabellen neben den bestehenden:

| Tabelle | Inhalt | Vorbild |
| --- | --- | --- |
| `zigbee_packets` | Zeit, Kanal, RSSI, LQI, Typ, Quelle, Ziel, Länge | `telegrams` |
| `zigbee_device_hours` | Gerät je Stunde: Anzahl, RSSI min/max/mittel, LQI | `device_hours` |

Eigene Aufbewahrungsfristen im `retention`-Block. Adressen werden **nicht** mit
BidCoS-Adressen vermischt — 2-Byte-Kurzadressen und 3-Byte-HM-Adressen sähen
sonst gleich aus und wären es nicht.

**Abnahme:** 24 Stunden Dauerlauf; Datenbankzuwachs gemessen und in `stand.md`
notiert; die Aufräumung greift nachweislich (Fristen kurz stellen, Zeilen
zählen).

---

### M16.5 — Konfiguration, Setup-Assistent und Aktivierung

**Ergebnis:** Zigbee ist **beim Einrichten** und **in der Oberfläche**
wählbar — beides, wie gefordert.

Konfigurationsblock (Voreinstellung: aus, E2):

```json
"zigbee": {
  "aktiv": false,
  "device": "/dev/asksin-zigbee",
  "kanal": 11,
  "baud": 921600
}
```

**Im Setup-Assistenten** (`install.sh`, im Abschnitt nach der Status-LED):

- Erst nachsehen, ob ein passender Stick steckt. Steckt einer, lautet die Frage
  „Zigbee-Mithörer einrichten? (J/n)"; steckt keiner, „(j/N)" mit einem Satz
  dazu, was fehlt.
- Bei Ja: Kanal abfragen (Vorgabe 11), udev prüfen, Firmwarestand melden.
- Bei Nein: Block wird gar nicht erst geschrieben.

**In der Oberfläche:** ein Schalter unter *Einstellungen*, der dasselbe tut —
mit Neustart des Zigbee-Empfängers, ohne Neustart des Dienstes.

**Abnahme:** Vier Durchläufe, alle geprüft:

1. Neuinstallation **ohne** Stick → kein Zigbee, keine Fehlermeldung.
2. Neuinstallation **mit** Stick und Ja → läuft nach dem Neustart.
3. **Bestehende** Installation ohne `zigbee`-Block → unverändert lauffähig.
4. Aktivierung über die Oberfläche → wirkt ohne Neustart des Dienstes.

Und der Weg zurück: Abschalten in der Oberfläche → Empfänger hält an, Menüpunkt
verschwindet, Daten bleiben.

> **Kein Weg über die Konsole.** Alles, was hier geht, muss über den
> Assistenten und die Oberfläche gehen; `config.json` bleibt der
> Notnagel für Fachleute.

---

### M16.6 — API und eigene Zigbee-Seite

**Ergebnis:** Neue Route `/zigbee` mit `ZigbeeView.vue`, Menüpunkt **nur wenn
aktiviert**, dazu die passenden API-Zweige:

| Zweig | Zweck |
| --- | --- |
| `GET /api/zigbee/status` | Stick da, Kanal, Pakete/min, Verwurfzähler, Firmwarestand |
| `GET/PUT /api/zigbee/config` | Aktiv, Kanal, Gerätename |
| `GET /api/zigbee/devices` | Geräte mit Zählern, RSSI, LQI, zuletzt gehört |
| `GET /api/zigbee/packets` | Paketliste, nach Zeit gefiltert — wie `/api/telegrams`, **nach Zeit, nicht nach Anzahl** |

Die Seite zeigt in dieser Reihenfolge: **Zustand** (hört er? worauf? seit
wann?), **Geräte** (mit Empfangsgüte, absteigend), **Pakete** (laufend).

Ist Zigbee aktiviert, aber der Stick fehlt, sagt die Seite genau das — welcher
Gerätename erwartet wurde und was zu tun ist. Keine leere Tabelle ohne Erklärung.

**Abnahme:** Alle drei Zustände von Hand durchgespielt (aus / an mit Stick /
an ohne Stick). Auf einem Pi 3 bedient — die Seite muss auch dort flüssig sein.

---

### M16.7 — Verbund, Langzeitdaten und Grafana

**Ergebnis:** Zigbee ordnet sich in das ein, was für BidCoS schon steht.

- InfluxDB-Messwerte `zigbee_geraet` und `zigbee_paket` mit dem **Standort** als
  Etikett — dieselbe Mechanik wie bei `geraeteliste`.
- **Empfangsmatrix**: welcher Standort hört welches Zigbee-Gerät wie gut. Das
  ist der eigentliche Ertrag des ganzen Vorhabens.
- Abgleich gegen die **deCONZ-Geräteliste** als Sollmenge — dasselbe Muster wie
  der CCU-Abgleich, damit „nie gehört" auch für Zigbee funktioniert. Die
  Zugangsdaten für deCONZ gehören in die Konfiguration, **nicht** ins
  Repository.
- Neue Grafana-Vorlagen — Anzahl beim Bauen festlegen.

**Abnahme:** `python3 tools/pruefe-dashboards.py` grün. Das heißt: Zu jeder
neuen Vorlage gibt es eine Abbildung **und** einen Handbuchabschnitt, und die
im Text genannte Anzahl stimmt. Genau daran ist es beim neunten Dashboard schon
einmal gescheitert.

---

### M16.8 — Handbuch und Einkaufsführer

- Eigenes Handbuchkapitel: Was Zigbee im Analyzer ist und was **nicht**
  (E6 gehört ausdrücklich hinein), Stick beschaffen, flashen, einrichten,
  Kanal wählen, Aufbau der Antenne, Grenzen.
- Einkaufsführer (M12) um Stick, USB-Verlängerung und Antenne ergänzen —
  ohne fremde Produktfotos.
- Seitenumbrüche nach Projektregel setzen.

---

### M16.9 — Abschluss

- `bash tools/pruefe-alles.sh` vollständig grün, einschließlich der neuen
  Prüfungen aus M16.2 und M16.7.
- Alle fünf Analyzer laufen unverändert weiter — bei vieren ist Zigbee aus, und
  das muss man ihnen nicht ansehen.
- `README.md` und Meilensteintabelle ergänzt.

---

## 6. Was ausdrücklich **nicht** dazugehört

- **Steuern, koppeln, dem Netz beitreten.** Der Analyzer bleibt passiv.
- **Netzschlüssel und entschlüsselte Inhalte** (E6).
- **Den ConBee III umflashen.** Er bleibt Koordinator.
- **Mehrere Kanäle gleichzeitig** (E4).
- **Zigbee im Demo-Modus mit erfundenen Paketen** — im Demo-Modus sind nur die
  Funktelegramme erfunden; erfundene Zigbee-Pakete kämen nur dazu, wenn Zigbee
  ohne Stick etwas zeigen soll. Vorerst: Seite bleibt leer und sagt warum.
- **Thread und Matter.** Gleiches Funkband, anderes Thema.

---

## 7. Fernziel: eigene Platine *(reines Zukunftsdenken, nichts davon jetzt)*

Langfristig soll das Ganze in einer geänderten Platine stecken statt am USB.
Das ist heute **kein Auftrag** und beeinflusst den Plan nur an einer Stelle:
Der Decoder aus M16.3 darf nicht an den USB-Stick gefesselt werden. Er bekommt
Rahmen von einem Strom — woher der kommt, geht ihn nichts an.

Was dann irgendwann zu klären wäre: 2,4-GHz-Funkteil auf der Platine, zwei
Antennen mit ausreichender Entkopplung, ob der ATmega das überhaupt bedienen
kann oder ob ein zweiter Chip nötig wird. Alles offen, alles später.

**Die Platine ist in Produktion. Am Entwurf wird nichts geändert, solange es
nicht ausdrücklich beauftragt ist.**

---

## 8. Offene Fragen

| # | Frage | Klärung in |
| --- | --- | --- |
| 1 | Liefert die Sniffer-Firmware tatsächlich sauberes JSON mit RSSI und LQI, und hält sie den Verkehr aus? **Die Frage, an der die Phase hängt.** | M16.1 |
| 2 | Welchen USB-Baustein (CH9102F oder CP2102N), welche Seriennummer und welche Produktzeichenkette meldet der Stick? Danach richtet sich die udev-Regel. | M16.1 / M16.2 |
| 3 | Wie viele Pakete je Minute liefert ein Netz dieser Größe wirklich? Davon hängt ab, ob der Pi 3 mitkommt. | M16.3 |
| 4 | Lässt sich zwischen den Paketen ein Energiescan einschieben, ohne zu viel zu verpassen? Erst dann gibt es ein Grundrauschen (E5). | nach M16.4 |
| 5 | Verträgt sich der Stick mit dem WLAN des Pi, oder braucht es zwingend Kabel? | M16.3, im Lasttest mitmessen |
| 6 | Reicht die Kurzadresse zur Wiedererkennung, oder muss über `lastseen` gegen deCONZ abgeglichen werden? Kurzadressen können sich beim Neuanmelden ändern. | M16.7 |

---

## 9. Risiken

| Risiko | Wirkung | Gegenmaßnahme |
| --- | --- | --- |
| Zigbee-Last verdrängt BidCoS | Der Analyzer verfehlt seine Hauptaufgabe | Getrennte Pfade (E1), begrenzte Warteschlange, Pi-3-Abnahme in M16.3 |
| Zigbee-Stick wandert zwischen `ttyUSB0` und `ttyUSB1` | Zigbee empfängt nach einem Neustart nichts mehr | Fester Name über die Seriennummer (M16.2). Der Sniffer ist nicht betroffen — er hängt am `ttyAMA0` des Headers |
| Sniffer-Firmware liefert weniger als erhofft | Ganzes Vorhaben ohne Nutzen | M16.1 ist eine Werkbankphase — **hier abbrechen ist erlaubt und billig** |
| Die Sniffer-Firmware hat **einen** Betreuer | Bei Aufgabe des Projekts steht der Hauptweg still | Das Format ist eine Zeile JSON — notfalls selbst pflegbar. Zusätzlich der Rückfall über `bellows` (Ende M16.1) |
| 1 MBaud überfordert den Pi 3 | Verworfene Pakete, im schlimmsten Fall Rückwirkung auf BidCoS | Verwurfzähler und 24-Stunden-Lasttest in M16.3 |
| Kurzadressen ändern sich | Geräte tauchen als „neu" auf, Langzeitdaten zerfasern | Offene Frage 6, Abgleich über IEEE-Adresse |
| Erweiterung stört die vier Analyzer ohne Zigbee | Rückschritt für den Verbund | E2 und E3, Abnahme 3 in M16.5 |

---

## 10. Reihenfolge und Abhängigkeiten

```text
M16.1 Werkbank ──► M16.2 udev ──► M16.3 Decoder ──► M16.4 Speicherung
   (Abbruch                            │
    erlaubt)                           └──► M16.5 Konfiguration ──► M16.6 Oberfläche
                                                                        │
                                             M16.7 Verbund/Grafana ◄────┘
                                                     │
                                             M16.8 Handbuch ──► M16.9 Abschluss
```

**M16.1 ist die Sollbruchstelle.** Sie kostet einen Nachmittag und einen
15-€-Stick. Liefert sie nicht, was sie soll, endet das Vorhaben dort — und
zwar bevor eine Zeile Analyzer-Code entstanden ist. Das ist Absicht.
