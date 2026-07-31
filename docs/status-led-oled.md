# Status-LED und OLED am Analyzer (Phase M11)

Die Funktionen des Projekts **Status-LED-OLED** (`ssbingo/Status-LED-OLED`)
sind in den Analyzer integriert — mit Ausnahme der restic-Backup-Funktion, die
Sache des eigenständigen Projekts bleibt.

Die Analyzer-Platine ist dafür vorbereitet:

| Stecker | Zweck | Pins |
| --- | --- | --- |
| **J5** | OLED (I²C, SSD1306) | GPIO2/3 — deshalb liegt der 328P-Reset auf GPIO4 |
| **J6** | Taster | GPIO17, schaltet gegen Masse |
| **J7** | WS2812-Status-LED | SPI/GPIO10 **oder** PWM/GPIO18 — Schiebeschalter SW1 |

---

## 1. Warum das OLED übernommen und nicht nachgebaut ist

Der erste Anlauf hat das Display **in TypeScript nachgebaut**: eigener
SSD1306-Treiber, eigene 5×7-Pixelschrift, eigenes Seitenraster, alles ohne
Fremdbibliothek. Auf dem Gerät war das Ergebnis deutlich schlechter lesbar als
das Vorbild — aus einem Grund, der sich nicht wegoptimieren lässt:

> Das Original zeichnet mit **DejaVuSans-Bold** und sucht die Schriftgröße je
> Wert automatisch: `_fit_font()` probiert von **28 px** abwärts, bis der Text
> in die Breite passt. Eine 5×7-Pixelschrift, ganzzahlig hochskaliert, bleibt
> auch bei 21 px sichtbar grob.

Seit **v0.9.0** kommt deshalb derselbe Stapel zum Einsatz wie im Vorbild:

| Baustein | Wofür |
| --- | --- |
| `board` / `busio` (Blinka) | Zugriff auf den I²C-Bus |
| `adafruit_ssd1306` | Treiber für das Display |
| `PIL` (Pillow) | Zeichnen und Schriften |
| `DejaVuSans-Bold.ttf` | die große Schrift (Paket `fonts-dejavu-core`) |

Übernommen sind Seitenaufbau, Schriftwahl, `_fit_font`, die Feldliste, die
Übersichtsseite und die Zeiten der Tasterauswertung. Ergänzt sind nur die
Werte, die es beim Analyzer zusätzlich gibt.

### Arbeitsteilung zwischen Core und Anzeigedienst

```text
asksin-analyzer (Node, unprivilegiert)
    │  schreibt bei jeder Änderung
    ▼
/var/lib/asksin-analyzer/oled-state.json
    │  wird alle 0,1 s gelesen
    ▼
asksin-analyzer-oled (Python, venv)   ──zeichnet──►  SSD1306 über I²C
    │  legt den fertigen Framebuffer daneben
    ▼
/var/lib/asksin-analyzer/oled-bild.b64
    │
    ▼
Weboberfläche: Live-Vorschau zeigt EXAKT das Bild vom Gerät
```

Der Core liefert nur seine eigenen Werte. Die Systemwerte — IP, MAC, Hostname,
CPU, RAM, Laufzeit, Lüfter, Plattenplatz — liest der Anzeigedienst selbst,
genau wie im Original.

Die Bilddatei ist zugleich das **Lebenszeichen**: Nur wenn sie existiert, gilt
der Anzeigedienst als zeichnend — und nur dann wird der Taster überwacht
(Begründung in Abschnitt 4).

---

## 2. Die Seiten

Reihenfolge: **Standort zuerst**, dann alles zum Analyzer, dann die
Systemwerte des Originals, zuletzt dessen vierzeilige Übersicht.

| # | Label | Wert | Herkunft |
| --- | --- | --- | --- |
| 1 | `Standort` | Anzeigename dieses Analyzers | Analyzer |
| 2 | `Sniffer` | `BEREIT` / `GETRENNT` / `DEMO` | Analyzer |
| 3 | `Telegramme` | z. B. `137/min` | Analyzer |
| 4 | `Rauschen` | z. B. `-91dBm` | Analyzer |
| 5 | `Geräte` | aktive Funkgeräte | Analyzer |
| 6 | `Duty-Cycle` | Spitzenwert in Prozent | Analyzer |
| 7 … | `! <Gerätename>` | Prozent — **je Dauersender eine Seite** | Analyzer |
| … | `Version` | Softwarestand | Analyzer |
| … | `IP`, `MAC`, `Host` | Netzwerk | System |
| … | `CPU` | z. B. `51C L0.42` | System |
| … | `RAM` | z. B. `512/2048MB` | System |
| … | `Up` | Laufzeit, z. B. `21d22h` | System |
| … | `Disk` | freier Platz | System, nur wenn ermittelbar |
| … | `Fan` | Drehzahl in U/min | System, nur wenn ein Lüfter meldet |
| letzte | — | Übersicht: IP, CPU, RAM, Sniffer | wie im Original |

### Dauersender bekommen eigene Seiten

Ein einzelnes defektes Gerät kann das Funknetz zustopfen. Die
Duty-Cycle-Seite zeigt nur den höchsten Wert — **welches** Gerät es ist, sah
man dort nicht. Deshalb bekommt jedes Gerät ab **80 % Duty-Cycle** eine eigene
Seite: Name als Beschriftung oben (mit vorangestelltem `!`), Prozentwert groß
darunter.

Die Schwelle ist `DUTY_ALARM_PROZENT = 80` — dieselbe, die auch die Status-LED
rot blinken lässt. Höchstens **fünf** solcher Seiten, sonst wird das
Durchblättern am Gerät zur Zumutung. Beruhigt sich ein Gerät, verschwindet
seine Seite von selbst.

### Aufbau einer Seite

Kurze Beschriftung oben links, darunter **ein** Wert, waagerecht zentriert und
in der größten Schrift, die in die Breite passt. Kopf- und Fußzeilen gibt es
bewusst nicht — sie müssten in der kleinen Schrift stehen und wären auf einem
0,96-Zoll-Panel nicht mehr zu entziffern.

Die Grenze zwischen Beschriftung und Wert wird **gemessen**, nicht gesetzt:
Wie hoch die Glyphen sind, hängt von der Pillow-Fassung ab. Mit festen
Positionen ragte das eine ins andere. Lange Gerätenamen werden ebenfalls
gemessen gekürzt (mit `…`), nicht nach Zeichenzahl — ein `i` braucht weniger
Platz als ein `W`.

---

## 3. Die Bauhöhe muss stimmen

**128 × 32** (Adafruit PiOLED) ist die Vorgabe und die Einstellung des
Vorbilds. 0,96-Zoll-Module sind meist **128 × 64**.

Der Unterschied ist nicht kosmetisch:

| | 128 × 32 | 128 × 64 |
| --- | --- | --- |
| Multiplex (`0xa8`) | `0x1f` | `0x3f` |
| COM-Pin-Lage (`0xda`) | `0x02` | `0x12` |
| Speicherseiten | 4 | 8 |

Mit den falschen Werten zeigt das Panel ein **verdoppeltes, unleserliches
Bild**. Die Bedingung für die COM-Pins (`Breite > 2 × Höhe`) ist wörtlich aus
`Adafruit_CircuitPython_SSD1306` übernommen, ebenso die Reihenfolge der
Init-Sequenz und `0xad, 0x30` (interne Referenzstromquelle — ohne sie bleiben
viele SSD1315-Nachbauten auffällig dunkel).

Eingestellt wird die Höhe beim Installieren; ändern lässt sie sich später über
`statusanzeige.oledHoehe` in der Konfiguration.

---

## 4. Der Taster an J6

Zeiten wörtlich aus der Konfiguration des Vorbilds:

| Haltedauer | Wirkung | Vorbild-Schlüssel |
| --- | --- | --- |
| ab **50 ms** | eine Seite weiter | `button_debounce_s` |
| ab **5 s** | `Neustart…` auf dem Display | `button_long_press_s` |
| + weitere **3 s** | `systemctl reboot` | `button_reboot_message_s` |

Die drei Sekunden Anzeige sind Absicht: Wer versehentlich zu lange drückt,
sieht noch, was gleich passiert.

**Gemessen wird der Pegel, nicht die Flanke.** Die Ausgabe von `gpiomon`
unterscheidet sich zwischen libgpiod 1 und 2, der über `gpioget` abgefragte
Pegel nicht.

**Neustarten darf der Dienst nicht selbst** — er läuft unprivilegiert. Er
schreibt `/var/lib/asksin-analyzer/neustart-anstoss`; darauf wartet
`asksin-analyzer-neustart.path` und startet einen eng begrenzten Root-Helfer.
Dasselbe Muster wie bei Update und Netzwerkeinstellungen. Die Auslöserdatei
wird **vor** dem Neustart gelöscht — sonst käme der Pi in eine
Neustartschleife.

### Drei Vorkehrungen gegen den offenen Eingang

Der Taster schaltet GPIO17 gegen Masse; einen Pull-up gibt es auf der Platine
nicht. Ohne definierten Ruhepegel **schwebt** der Eingang und erzeugt aus
Einstreuung fortlaufend Flanken — jede davon eine Unterbrechung im Kernel.

1. `gpiomon` läuft mit `--bias=pull-up`. Das betrifft auch den Normalbetrieb
   **mit** Taster: Ohne Ruhepegel blätterte die Anzeige von selbst weiter.
2. Der Taster wird **nur überwacht, wenn der Anzeigedienst zeichnet**. Wer
   kein Zubehör angeschlossen hat, bekommt davon nichts ab. Sonst steht im
   Protokoll: „Anzeigedienst meldet kein Bild — Taster bleibt inaktiv".
3. Kommen dennoch mehr als **50 Flanken je Sekunde**, wird das Lauschen
   eingestellt und gemeldet. Ein Mensch drückt nicht 50-mal je Sekunde.

---

## 5. Die Status-LED (WS2812)

| Farbe | Muster | Bedeutung |
| --- | --- | --- |
| Rot | schnell blinkend | Duty-Cycle-Alarm (≥ 80 %) |
| Rot | dauerhaft | Sniffer getrennt |
| Gelb | langsam blinkend | Persistenz-Fehler |
| Orange | dauerhaft | Demo-Modus |
| Blau | pulsierend | Update verfügbar |
| Grün | dauerhaft | alles in Ordnung |

Prioritätsleiter: Alarm > getrennt > Persistenzfehler > Demo > Update > ok.

### Welche Ansteuerung auf welchem Pi

| | **SPI** (GPIO10) | **PWM** (GPIO18) |
| --- | --- | --- |
| Schalter SW1 | Stellung **SPI** | Stellung **PWM** |
| Vorgabe auf | **Pi 5** | **Pi 3 und Pi 4** |
| Rechte | im Analyzer-Dienst, ohne Root | Root — Dienst `asksin-analyzer-led` |
| Onboard-Audio | egal | muss aus (`dtparam=audio=off`) |
| Bibliothek | keine, eigener Bitstrom (2,4 MHz, 1→110 / 0→100) | `rpi_ws281x` im venv `led-venv` |

Auf **Pi 3 und Pi 4** leitet sich der SPI-Takt vom Kerntakt ab und wandert mit
dessen Skalierung — das zerreißt das WS2812-Timing (Flackern, Farbsprünge).
Auf dem **Pi 5** hängen die GPIOs am RP1; die PWM/DMA-Bibliotheken sprechen
die alte BCM-Hardware an und funktionieren dort nicht. Der PWM-Weg ist auf dem
Pi 5 deshalb **dreifach gesperrt** (Installer, Update, Skript selbst): Im
ungünstigen Fall schreibt ein DMA-Kanal in fremden Speicher und hängt den
Rechner auf, ohne eine Zeile im Journal zu hinterlassen.

Im PWM-Betrieb bleibt der Analyzer-Dienst unprivilegiert und schreibt die
fertige Farbe als `r,g,b` nach `/var/lib/asksin-analyzer/led-farbe`; der kleine
Root-Dienst [`deploy/led-pwm.py`](../deploy/led-pwm.py) setzt sie.

**Umschalten ohne Lötkolben:** Seit Hardware v0.2.0 wählt der
SMD-Schiebeschalter **SW1** zwischen GPIO18 (PWM) und GPIO10 (SPI); dahinter
liegt ein gemeinsamer 330-Ω-Serienwiderstand R4. Die frühere
Bestückungsvariante „R4 **oder** R5" entfällt.

**Die LED ist immer eine WS2812B**, versorgt mit **3,3 V** vom Pi (J7 Pin 1).
Das ist Absicht: Bei 5 V Versorgung erwartet die LED rund 3,5 V für „High", die
der Pi mit 3,3 V nicht liefert. Mit 3,3-V-Versorgung passt der Pegel.

⚠️ Der Schiebeschalter **SW1** muss zur gewählten Betriebsart passen.

---

## 6. Einrichtung

Der Installer fragt „Status-LED und OLED-Anzeige einrichten?" und danach die
Bauhöhe. Die eigentliche Einrichtung steht in einem eigenen Skript, damit sie
sich nach einem Fehlschlag einzeln wiederholen lässt:

```bash
sudo /opt/asksin-analyzer/deploy/oled-einrichten.sh 32     # oder 64
```

Es installiert die Systempakete, legt das venv an, installiert die
Bibliotheken, richtet den Dienst ein und prüft zum Schluss, ob sich auf dem
I²C-Bus überhaupt ein Display meldet.

### Warum die apt-Pakete vorher kommen

`pip install adafruit-blinka` zieht **lgpio** nach und baut es aus dem
Quellcode. Fehlt `swig`, bricht es ab:

```text
error: command 'swig' failed: No such file or directory
```

Fehlt die C-Bibliothek, scheitert der Linker:

```text
/usr/bin/ld: cannot find -llgpio
```

Raspberry Pi OS liefert lgpio längst als fertiges Paket **`python3-lgpio`** —
gebaut werden muss also gar nichts. Deshalb: erst die apt-Pakete, dann ein
venv **mit** `--system-site-packages`, damit pip die fertigen Pakete sieht.
`swig`, die Header und `liblgpio-dev` kommen trotzdem mit, falls das Paket auf
einer Ausgabe fehlt.

> **Achtung nach einem Fehlschlag:** Ein venv **ohne**
> `--system-site-packages` bleibt sonst liegen und ist von außen nicht von
> einem guten zu unterscheiden. Das Skript prüft deshalb
> `include-system-site-packages` in `pyvenv.cfg` und legt die Umgebung neu an,
> wenn der Schalter fehlt.

### Warum die Unit ein Arbeitsverzeichnis braucht

lgpio legt Benachrichtigungs-Pipes im Arbeitsverzeichnis an — erst `$LG_WD`,
ersatzweise `$HOME`, ersatzweise `"."`. Ohne diese Angaben landet es bei
`//.lgd-nfy0` und bricht ab:

```text
xCreatePipe: Can't set permissions (436) for //.lgd-nfy0
[Errno 2] No such file or directory: '.lgd-nfy-3'
```

`WorkingDirectory`, `HOME` und `LG_WD` zeigen deshalb auf
`/var/lib/asksin-analyzer`.

> In der Unit steht **kein `DeviceAllow`**. Sobald eine solche Zeile existiert,
> schaltet systemd auf `DevicePolicy=closed` und sperrt jedes nicht genannte
> Gerät — damit auch die `gpiochip`-Knoten, über die Blinka arbeitet. Gemeint
> war eine Erlaubnis, gewirkt hat ein Verbot. Der Zugriff auf `/dev/i2c-1`
> kommt über die Gruppe `i2c`.

---

## 7. Beteiligte Dienste, Dateien und Werkzeuge

| Einheit | Zweck |
| --- | --- |
| `asksin-analyzer-oled.service` | zeichnet das Display (Python, venv) |
| `asksin-analyzer-led.service` | WS2812 über PWM — **nur Pi 3/4** |
| `asksin-analyzer-neustart.path` / `.service` | Neustart bei langem Tastendruck |

| Datei unter `/var/lib/asksin-analyzer/` | Inhalt |
| --- | --- |
| `oled-state.json` | Werte des Analyzers + aktuelle Seite |
| `oled-bild.b64` | letzter Framebuffer, Seitenzahl, Bauhöhe |
| `led-farbe` | `r,g,b` für den PWM-Hilfsdienst |
| `neustart-anstoss` | Auslöser für den Root-Helfer |

| Werkzeug | Zweck |
| --- | --- |
| `deploy/oled-einrichten.sh` | Einrichtung, einzeln wiederholbar |
| `deploy/oled-vorschau.py` | rendert die Seiten als PNG — **aus dem Code des Geräts** |

`oled-vorschau.py` schiebt der Zeichenklasse ein Ersatz-Display unter, statt
einen zweiten Renderer zu pflegen. Damit kann das Bild im Handbuch nicht mehr
von dem abweichen, was auf dem Panel steht.

---

## 8. In der Weboberfläche

Die Übersicht zeigt bei aktiver Anzeige den Bereich **Status-LED & OLED**: den
LED-Punkt in Echtfarbe mit Klartext-Grund, Störungsmeldungen je Teil und eine
**Live-Vorschau des Displays** samt Blättern-Knopf — seit v0.9.0 das echte
Bild vom Gerät, nicht mehr ein Nachbau davon.

Aktivierung, Ansteuerungsart und Helligkeit stehen unter **Einstellungen →
Status-LED & OLED**, sofort wirksam und ohne Neustart.

---

## 9. Was nicht übernommen wurde

Die **restic-Backup-Funktion** des Vorlagenprojekts. Sie bleibt Sache des
eigenständigen Status-LED-OLED-Projekts.
