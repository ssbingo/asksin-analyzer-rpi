# AskSin-Analyzer — Hardware-Spezifikation (v0.2.0)

> ### ⚠️ Errata zur Hardware v0.0.1 — Platinen der ersten Chargen
>
> Auf allen 2026 gefertigten Platinen (Bestückungsdruck „HW v0.0.1") ist die
> 2×20-Buchse **J1 gespiegelt**: Die ungerade Pinreihe sitzt richtig, die
> gerade liegt 2,54 mm auf der falschen Seite. Direkt aufgesteckt landet
> jedes Pad auf dem falschen Pi-Pin — 5 V auf 3,3 V, Masse auf GPIOs.
>
> **Diese Platinen niemals ohne Adapter aufstecken und einschalten.** Mit dem
> [J1-Rettungsadapter](kicad/adapter/README.md) sind sie voll funktionsfähig.
>
> Ursache: Der Footprint stammt aus der offiziellen Vorlage
> `RaspberryPi-HAT`, wurde aber ohne deren Flip auf die Unterseite übernommen.
> Seit v0.2.0 flippt `generate_pcb.py` J1 wie die Vorlage **und prüft die
> Pad-Positionen bei jedem Lauf hart gegen das Pi-Raster** — ein erneuter
> Fehler dieser Art bricht den Lauf ab.
>
> **Zweiter Fehler derselben Chargen: die Status-LED D1 war verpolt.** Im
> KiCad-Symbol ist Pin 1 die Kathode; sie lag an R1 statt an Masse, die Anode
> an Masse. Die Firmware schaltet ihren Treiberpin auf HIGH — der Strom hätte
> also gegen die Diodenrichtung fließen müssen, die LED blieb dunkel. Rein
> kosmetisch (die Empfangsanzeige), Funk und Auswertung waren nie betroffen.
> Ab v0.2.0 korrigiert.

Abgeleitet von **AskSin-Analyzer-XS-RPi V1.1** (der-pw, 08/2020), lizenziert
CC BY-NC-SA 4.0. Diese Ableitung steht unter derselben Lizenz und muss den
Urheber nennen.

Quelle der Analyse: `../AskSinAnalyzerXS-RPi-main/AskSinAnalyzerXS-RPi-main/KiCad/AskSin-Analyzer-XS-RPi.sch`
(Netzliste vollständig ausgewertet, nicht aus dem PDF abgelesen).

Umsetzung: [`kicad/`](kicad/) — KiCad-9-Projekt, Schaltplan generiert,
ERC 0 Fehler, Netzliste maschinell gegen diese Spezifikation geprüft.

**Gegenüber der Vorlage:** Der USB-Zweig entfällt — die Platine ist reines
Aufsteckmodul für einen **Raspberry Pi**. Dafür trägt sie zusätzlich die
Peripherie des Status-LED-OLED-Projekts: Stecker für Display, Taster und
WS2812-LED samt deren Vorwiderstand. Die Antenne verlässt das Funkmodul über
dessen IPEX-Buchse — auf der Platine gibt es **keine einzige HF-Leitung**.

**Bauform seit v0.2.0:** T-förmig und **liegend neben dem Pi**. Der Körper
(88 × 34 mm) liegt parallel zur Header-Seite des Pi, steht nach hinten
(SD-Karten-Seite) 20 mm über und deckt **keine Buchsen ab**; der schmale Arm
(65 × 8 mm) ragt nur so weit über den Pi, wie die 2×20-Buchse und die beiden
HAT-Bohrungen es verlangen. Das Funkmodul mit der IPEX-Buchse sitzt im
hinteren Überstand — im 19-Zoll-Einbau direkt am rückwärtigen
Antennen-Keystone und maximal weit weg vom Störnebel aus Schaltreglern,
HDMI und USB. Die drei Peripheriestecker liegen an der Frontkante, kurze
Wege zum OLED-/LED-/Taster-Einsatz.

*(Bis v0.0.1 war der Umriss L-förmig und der Körper ragte über die
USB-/Ethernet-Buchsen des Pi — das kollidierte mit dem 19-Zoll-Einbau.)*

Zielaufbau: Pi (4 oder 5) → PoE-HAT mit durchgeschleiftem 40-poligem
Header → diese Platine. Mehrere solcher Einheiten an verschiedenen Stellen im
Haus, fest in Datenschränken montiert.

---

## 1. Bestandsaufnahme V1.1 (verifiziert)

### 1.1 Steckerbelegung J1 (2×5, Pi-Header Pin 1–10)

| Pi-Pin | Pi-Signal | Platine | Anmerkung |
| --- | --- | --- | --- |
| 1 | 3V3 | über JP1 auf 3,3-V-Rail | Lötbrücke, normal offen |
| 2 | 5V | LDO-Eingang | |
| 3 | GPIO2 / SDA1 | **DTR** → JP2 → RESET | Lötbrücke, normal offen |
| 4 | 5V | LDO-Eingang | |
| 5 | GPIO3 / SCL1 | nur Label `SCL`, **nicht verdrahtet** | toter Pin |
| 6 | GND | GND | |
| 7 | GPIO4 | `NoConn` | |
| 8 | GPIO14 / TXD | 328P **RXD** | |
| 9 | GND | GND | |
| 10 | GPIO15 / RXD | 328P **TXD** | |

### 1.2 Bestückung V1.1

U1 MCP1754S-3302 (SOT-23, 3,3 V / 150 mA) · U2 ATmega328P-AU (TQFP-32) ·
U3 CC1101-Modul (HM-Sensor, Footprint `Homebrew:CC1101_Module_HM-Sensor`) ·
J1 2×5 · JP1/JP2 Lötbrücken · TP1 (RESET) · L1 BLM21PG300 · R1 330 Ω ·
R2 10 kΩ (RESET-Pullup) · C1/C2 10 µF · C3/C4 100 n (VCC/AVCC) · C5 100 n (CC1101) · D1 LED

### 1.3 Bestätigte Schwachstellen

1. **Kein Taktgeber.** XTAL1/XTAL2 sind unbeschaltet → interner 8-MHz-RC.
2. **Kein ISP-Header.** Bootloader/Fuses nur über angelötete Drähte an
   MOSI/MISO/SCK (mit CC1101 geteilt) und TP1.
3. **DTR ohne Kondensator.** JP2 verbindet GPIO2 *galvanisch* mit RESET. Ein
   dauerhaft gesetzter Low-Pegel hält den 328P im Reset. Der 100 nF muss laut
   README ins Kabel gefrickelt werden.
4. **ANT (Pin 9 von U3) ist im Schaltplan unverbunden** — der Draht wird direkt
   an das Modul gelötet, unmittelbar über der Pi-Platine.
5. **CS ohne Pullup.** Liegt der 328P im Reset, sind seine Pins hochohmig, CS
   floated, der CC1101 ist undefiniert selektiert. Relevant, sobald über ISP
   programmiert wird (SPI ist geteilt).
6. **AREF hart auf 3,3 V.** Pin 20 hängt über `5200 1850 → 5025 1550` direkt an
   der Versorgung. Das Datenblatt verlangt stattdessen einen Abblockkondensator
   gegen Masse. Solange die Firmware den ADC nicht anfasst, fällt es nicht auf —
   aktiviert sie je die interne 1,1-V-Referenz, wird diese gegen die
   Versorgung kurzgeschlossen. Latenter Fehler, kein akuter.
7. **Im Footprint fehlt das Antennenpad.** Beim Extrahieren des
   CC1101-Footprints aus der V1.1-Platine kamen nur zehn Pads zutage: 1–8 und
   10–11. **Pad 9 (ANT) existiert nicht.** Das ist der eigentliche Grund für den
   angelöteten Draht — nicht Bequemlichkeit, sondern ein fehlendes Pad. Details:
   `kicad/README.md`.

---

## 2. Taktgeber und Baudrate — die eigentliche Entscheidung

Das ist der Punkt, der vor dem KiCad-Nachmittag geklärt sein muss, weil er
Bauteil *und* Firmware betrifft.

### 2.1 Warum ein Taktgeber gesetzt ist

Die `platformio.ini` des Sketches baut gegen `board = pro8MHzatmega328`, also
F_CPU = 8 000 000. Der Arduino-Pro-Mini-3,3 V hat dafür einen **externen**
8-MHz-Resonator. V1.1 hat keinen — die Firmware läuft dort also auf dem
internen RC-Oszillator, dessen Fuse-Konfiguration (`lfuse = 0xE2`) von der
Pro-Mini-Standardkonfiguration (`lfuse = 0xFF`) abweicht. Der interne RC ist
über Temperatur und Betriebsspannung mit ±10 % spezifiziert; ab Werk kalibriert
liegt er typisch bei 1–2 %. Für 24/7-Betrieb ist das die falsche Seite der
Toleranzgrenze.

### 2.2 Der zweite, unabhängige Fehler: 57600 Baud passen nicht auf 8 MHz

`HardwareSerial::begin()` rechnet im U2X-Modus mit Ganzzahlarithmetik:

```text
UBRR = (F_CPU / 4 / baud - 1) / 2 = (8000000/4/57600 - 1)/2 = (34 - 1)/2 = 16
ist = F_CPU / (8 · (UBRR+1)) = 8000000 / 136 = 58823,5 Baud   →  +2,12 %
```

Die 16-MHz-Sonderbehandlung für 57600 in `HardwareSerial.cpp` greift bei 8 MHz
nicht. **Dieser Fehler entsteht auch bei perfektem Quarz** — er steckt im
Teilerverhältnis, nicht im Oszillator. UART-Empfänger tolerieren bei 8N1 und
16-fach-Oversampling grob ±2,5 %; 2,12 % ist innerhalb, aber ohne Reserve. Der
RC-Oszillator addiert seine Drift oben drauf. Genau daher rühren die
sporadischen Framing-Fehler, die im Homematic-Forum zu dieser Platine
auftauchen.

### 2.3 Sauber teilbare Baudraten bei 8 MHz

| Baud | UBRR (U2X) | Ist-Baudrate | Fehler |
| --- | --- | --- | --- |
| 19200 | 51 | 19230,8 | +0,16 % |
| **38400** | **25** | **38461,5** | **+0,16 %** |
| 57600 | 16 | 58823,5 | +2,12 % |
| 76800 | 12 | 76923,1 | +0,16 % |
| 115200 | 8 | 111111,1 | −3,55 % |

38400 wäre die Baudrate mit dem kleinsten Fehler. **Entschieden ist 57600** —
und das kostet nichts, siehe 2.5.

### 2.4 Was ausdrücklich *nicht* geht

**7,3728 MHz** (der klassische UART-Quarz, 0,00 % Fehler) scheidet aus.
`AskSinPP/AlarmClock.h:152` rechnet

```c
const unsigned long cycles = (F_CPU / 2000000) * (1000000 / TICKS_PER_SECOND);
```

Bei 7 372 800 ergibt die Ganzzahldivision `3` statt 3,6864 — die komplette
Systemuhr liefe 18,6 % falsch. F_CPU muss ein Vielfaches von 2 MHz sein.
8 MHz und 16 MHz sind sauber, 7,3728 MHz ist es nicht.

**16 MHz** scheidet aus, weil der ATmega328P bei 3,3 V nur bis ca. 13 MHz
spezifiziert ist (Datenblatt: 10 MHz @ 2,7 V, 20 MHz @ 4,5 V, linear dazwischen).
Ein Betrieb bei 5 V würde Pegelwandler zum CC1101 *und* zum Pi erzwingen.

### 2.5 Entscheidung: 57600 bleibt, der Fehler wird auf der Gegenseite kompensiert

Es gibt keine Taktfrequenz, die beides erfüllt. Für exakte 57600 Baud im
U2X-Modus müsste `F_CPU = 460800 · n` sein, für AskSinPPs Systemuhr (2.4)
zugleich ein Vielfaches von 2 MHz. Das kleinste gemeinsame Vielfache liegt bei
288 MHz — außerhalb jeder Diskussion. **Bei 8 MHz sind 57600 Baud also
zwangsläufig 58823,5.**

Der entscheidende Punkt ist aber: dieser Fehler ist **einseitig und bekannt**.
Der ATmega sendet mit 58823,5 Baud, und niemand zwingt den Pi, mit 57600 zu
lauschen. Die PL011 des Pi hat einen Baudratenteiler mit 6 Bit Nachkomma und
trifft praktisch jede Rate:

```text
ATmega328P @ 8 MHz, UBRR = 16, U2X = 1   →  8 000 000 / 136 = 58823,53 Baud
Pi PL011   @ 48 MHz UARTCLK, Teiler 51   → 48 000 000 / 816 = 58823,53 Baud
```

Beide Seiten landen auf demselben Wert. **Der Core öffnet den Port also mit
58824 Baud statt 57600 — Restfehler praktisch 0,00 %** statt 2,12 %. Linux
unterstützt beliebige Baudraten über `TCSETS2`/`BOTHER`, `node-serialport`
reicht das durch, und auf dem Pi 5 gilt dasselbe über den fraktionalen Teiler
des RP1.

Damit ist das Ergebnis besser als bei 38400 — und die Firmware bleibt
**unverändert**. Das ist der eigentliche Gewinn: der offizielle
`AskSinSniffer328P`-Sketch wird bit-identisch übernommen, es entsteht kein Fork,
kein abgeleitetes Werk, und wer will, flasht die Original-HEX.

Konsequenzen, die konsistent gehalten werden müssen:

| Stelle | Wert |
| --- | --- |
| Firmware (`DINIT`), `platformio.ini` | 57600 — unverändert |
| Optiboot-Bootloader | 57600 (rechnet dasselbe UBRR = 16) |
| Core-Dienst, serieller Port (USB **und** GPIO) | **58824** |
| `avrdude` beim Firmware-Update | `-b 58824` |
| `stty` zum Mitschneiden | `58824` |

Der 8-MHz-Resonator (Y1) bleibt trotzdem Pflicht. Er behebt die *andere* Hälfte
des Problems: die Temperatur- und Spannungsdrift des internen RC-Oszillators,
die sich nicht wegkonfigurieren lässt.

Durchsatzprüfung: die längste mögliche Zeile ist `23 + 2·(60−9) + 1 = 126`
Zeichen plus Newline ≈ 128 Byte. 57600 Baud = 5760 Byte/s ≈ 45
Maximal-Telegramme pro Sekunde. Das 868-MHz-Band kann physikalisch weniger
tragen — ein 20-Byte-BidCoS-Telegramm belegt rund 25 ms Sendezeit, also
höchstens ~40 Telegramme/s bei 100 % Kanalauslastung, und die sind im Mittel
deutlich kürzer als 126 Zeichen. Reserve ist reichlich vorhanden.

---

## 3. Aufbau V4

### 3.1 Der Konflikt, der die Reset-Leitung verlegt hat

Das Status-LED-OLED-Projekt betreibt sein Display als **SSD1306 über I²C**, also
auf **GPIO2 (SDA)** und **GPIO3 (SCL)** — Header-Pins 3 und 5. Genau auf GPIO2
lag ursprünglich unsere Reset-Leitung, über einen 100-nF-Koppelkondensator zum
RESET des 328P.

**Ein 100-nF-Kondensator auf SDA macht den I²C-Bus unbrauchbar.** Das Display
wäre tot gewesen, und der Fehler wäre erst an der fertig bestückten Platine
aufgefallen.

Der Reset sitzt deshalb auf **GPIO4 (Pin 7)** — auf der ursprünglichen
der-pw-Platine als `NoConn` geführt und sonst frei. Eine Einschränkung bleibt:
aktiviert man je 1-Wire, belegt dessen Standardüberlagerung ebenfalls GPIO4.
Dann muss `dtoverlay=w1-gpio,gpiopin=…` auf einen anderen Pin.

### 3.2 Belegung des Pi-Headers

| Pi-Pin | Signal | Verwendung |
| --- | --- | --- |
| 1 | 3V3 | **durchgereicht** zu Display und LED |
| 2, 4 | 5V | Eingang unseres Reglers |
| 3, 5 | GPIO2/3 | I²C, **durchgereicht** zum Display |
| 6, 9, 14, 20, 25, 30, 34, 39 | GND | |
| 7 | GPIO4 | Reset des 328P |
| 8 | GPIO14 | Pi sendet → 328P RXD |
| 10 | GPIO15 | Pi empfängt ← 328P TXD |
| 11 | GPIO17 | Taster |
| 12 | GPIO18 | WS2812-Daten (PWM, Vorgabe) |
| 19 | GPIO10 | WS2812-Daten (SPI, Alternative) |

Die 3,3 V für Display und LED kommen **vom Pi**, nicht aus unserem Regler. Zwei
Gründe: das Status-LED-Projekt nutzt sie bewusst so, damit der Datenpegel der
WS2812 ohne Pegelwandler passt — und unsere Reglerschiene bleibt frei von
Displaystörungen, was dem Empfänger zugute kommt.

### 3.3 Peripheriestecker

Drei verriegelnde JST-PH-Stecker an der dem Pi zugewandten Kante:

| Ref | Funktion | Belegung |
| --- | --- | --- |
| J5 | OLED, I²C | 1 GND · 2 3V3 · 3 SCL · 4 SDA |
| J6 | Taster | 1 GPIO17 · 2 GND |
| J7 | WS2812 | 1 3V3 · 2 Daten · 3 GND |

Die Datenleitung der WS2812 führt **über die Platine**, wahlweise über
**R5** (SPI, GPIO10) oder **R4** (PWM, GPIO18) — bestückt wird genau einer
von beiden, **beide 330 Ω**. Welcher, hängt am Rechner:

- **Pi 5 → R5 (SPI).** Die PWM/DMA-Bibliotheken bedienen den RP1-Chip nicht;
  der SPI-Takt ist dort stabil.
- **Pi 3/4 → R4 (PWM).** Dort leitet sich der SPI-Takt vom Kerntakt ab und
  wandert mit dessen Skalierung, was das WS2812-Timing zerreißt.

Der Installer erkennt das Modell und wählt vor; umstellbar ist es in den
Einstellungen der Weboberfläche. Einzelheiten:
[`../docs/status-led-oled.md`](../docs/status-led-oled.md)

### 3.4 Funk-Frontend

**Ebyte E07-900M10S**: CC1101, 855–925 MHz, 26-MHz-Quarz ab Werk, 14 × 20 mm,
22 Halblöcher im 1,27-mm-Raster, IPEX-Antennenbuchse.

Die Antenne geht über ein IPEX-Verlängerungskabel auf eine Einbaubuchse in der
Gehäusewand. Auf der Platine entsteht dadurch **keine HF-Leitung** — keine
Impedanzvorgabe, kein Via-Zaun, kein Anpassungsrisiko.

Drei Dinge beim Zubehör:

- **RP-SMA ist nicht SMA.** Bei RP-SMA sind Stift und Buchse vertauscht: die
  Gewinde passen zusammen, innen trifft aber Buchse auf Buchse und es entsteht
  keine Verbindung. Antenne, Kabel und Einbaubuchse müssen demselben Standard
  folgen.
- Das Verlängerungskabel muss **U.FL/IPEX-1** sein. MHF2, MHF3 und MHF4 sehen
  ähnlich aus, passen aber mechanisch nicht.
- Der U.FL-Stecker ist auf rund 30 Steckzyklen ausgelegt und springt unter Zug
  ab. Dafür sitzen **KB1/KB2** neben dem Modul: zwei Löcher für einen
  Kabelbinder als Zugentlastung.

R3 (10 kΩ) hält CSN definiert, solange der 328P im Reset liegt — der SPI-Bus
ist mit dem ISP-Header geteilt.

### 3.5 Programmierung und Prüfung

- **J2**, 6-poliger ISP-Header in Standardbelegung. Darüber werden nach dem
  Aufbau Fuses, Bootloader und Firmware gebrannt — ein USBasp genügt.
- **TP1–TP8**, Prüfpunkte für RESET, +3V3, +5V, GND, TXD, RXD, GDO0 und CS.
- **S1**, Reset-Taster.

---

## 4. Fuses und Bootloader

Externer 8-MHz-Takt, BOD auf 2,7 V (bei 3,3 V Betriebsspannung angemessen):

| Variante | lfuse | hfuse | efuse |
| --- | --- | --- | --- |
| Ohne Bootloader (nur ISP-Flashen) | `0xFF` | `0xD9` | `0xFD` |
| **Mit Optiboot** (MiniCore, 8 MHz extern) | `0xFF` | `0xDE` | `0xFD` |

`lfuse = 0xFF`: CKDIV8 aus, CKOUT aus, SUT = 11, CKSEL = 1111 (externer
Oszillator 8–16 MHz). `efuse = 0xFD`: BODLEVEL = 101 → 2,7 V. Beim Zurücklesen
meldet avrdude `0xFD` je nach Version als `0x05`, weil nur drei Bits
implementiert sind — das ist kein Fehler.

### 4.1 Bootloader ist Pflicht

Mit der Anforderung „Firmware-Update über die Web-UI" ist er gesetzt:
**MiniCore, `ATmega328`, Clock „8 MHz external", Optiboot**, Bootloader-Baudrate
57600 — Optiboot rechnet dasselbe UBRR = 16 wie die Firmware und sendet damit
ebenfalls mit 58823,5 Baud.

Einmalig nach dem Aufbau über J2 gebrannt:

```bash
avrdude -c usbasp -p m328p -B 8 \
        -U lfuse:w:0xFF:m -U hfuse:w:0xDE:m -U efuse:w:0xFD:m \
        -U flash:w:optiboot_atmega328_8MHz_57600.hex:i
avrdude -c usbasp -p m328p -U flash:w:AskSinSniffer328P.hex:i
```

`-B 8` ist beim ersten Zugriff wichtig: ein fabrikfrischer 328P läuft mit
CKDIV8 auf 1 MHz, die ISP-Taktfrequenz muss unter F_CPU/4 liegen.

### 4.2 Firmware-Update im Betrieb

Der Pi-eigene UART führt keine DTR-Leitung — den Reset für den Bootloader
taktet deshalb der Pi selbst, über **GPIO4 (Header-Pin 7) → C8 → RESET**:

```bash
avrdude -c arduino -p m328p -P /dev/ttyAMA0 -b 58824 -D \
        -U flash:w:AskSinSniffer328P.hex:i &
sleep 0.2
gpioset -t0 -c gpiochip0 4=0     # fallende Flanke → Reset-Impuls
gpioset -t0 -c gpiochip0 4=1
wait
```

Zeitverhalten: R2 · C8 = 10 kΩ · 100 nF = 1 ms Zeitkonstante, RESET ist nach
etwa 3 ms wieder auf 3,3 V. Der 328P braucht minimal 2,5 µs. Optiboot wartet
rund 1 s auf ein Kommando, das Fenster ist unkritisch.

Drei Punkte gehören in die Implementierung:

- **GPIO4 bootet mit aktivem internen Pull-up** (BCM-Standard für GPIO 0–8) —
  die Ruhelage ist high, es gibt keinen Reset beim Hochfahren. C8 sperrt
  Gleichspannung ohnehin; nur Flanken kommen durch.
- **Ansteuerung über libgpiod**, nicht über `RPi.GPIO` oder `pigpio` — beide
  funktionieren auf neueren Kerneln bzw. dem Pi 5 nicht mehr. Die
  `gpioset`-Syntax unterscheidet sich zwischen libgpiod v1 und v2, beide
  Varianten abfangen.
- **Beim Loslassen von GPIO4 steigt RESET kurz über VCC** (kapazitive
  Kopplung). Die interne Klemmdiode des 328P fängt das ab — so arbeitet auch
  jeder Arduino Uno.

> Historie: In den Entwürfen V1–V3 lag der Reset auf GPIO2. Das kollidierte
> mit dem I²C-Bus, den das OLED des Status-LED-Projekts braucht — seit V4 ist
> GPIO2/GPIO3 unangetastet durchgereicht und der Reset auf GPIO4 (Abschnitt
> 3.1). Wer 1-Wire nutzt: dessen Standardüberlagerung belegt ebenfalls GPIO4,
> dann `dtoverlay=w1-gpio,gpiopin=…` auf einen anderen Pin legen.

Ein Firmware-Update kann den Bootloader nicht überschreiben (BOOTRST/BOOTSZ
schützen den Bereich). Nur ein fehlgeschlagener Bootloader-Flash über J2 wäre
kritisch, und der passiert einmalig beim Aufbau.

---

## 5. Layout

Umgesetzt in [`kicad/`](kicad/), erzeugt von `generate_pcb.py`. Grundlage ist
die **offizielle KiCad-Vorlage `RaspberryPi-HAT`**: die exakte Position des
40-poligen Sockels, seine Lage auf der **Unterseite** und die beiden
zugehörigen Befestigungsbohrungen kommen von dort und sind nicht nachgebaut.
Der Umriss selbst ist ein eigener (T-Form, siehe oben), weil die Platine
neben dem Pi liegt statt auf ihm.

`check_j1_geometry()` prüft nach dem Platzieren die vier Eckpads von J1
gegen das Pi-Raster und bricht ab, wenn eine Reihe verrutscht ist — die
Lehre aus dem Fehler in v0.0.1.

### 5.1 Lagenaufbau

| Lage | Belegung |
| --- | --- |
| F.Cu | Signale (keine Massefläche) |
| In1.Cu | durchgehende Massefläche |
| In2.Cu | durchgehende Massefläche |
| B.Cu | Signale (keine Massefläche) |

Seit v0.2.0 tragen die **Außenlagen keine Masseauffüllung** mehr. Auf dem
kompakteren Umriss zerfiel sie zwischen den Leiterbahnen in Splitter, die
sich weder zuverlässig verankern noch sauber entfernen ließen. Stattdessen
bekommt **jedes SMD-Massepad vor dem Routen sein eigenes Stützvia** auf die
beiden Innenlagen (`generate_pcb.py`, Freiraum geometrisch geprüft) — die
Abschirmung leisten die durchgehenden Innenflächen.

Zwei Lagen würden reichen, seit keine HF-Leitung mehr auf der Platine liegt.
Die durchgehende Massefläche unter dem Funkmodul und unter dem USB-Paar kostet
beim Platinenhersteller fast nichts und nimmt die Einstreuung von HDMI und
USB3 des Pi spürbar zurück.

Die Flächen sind **für Durchsteckpads thermisch entlastet**, für SMD-Pads voll
angebunden. Die Platine wird von Hand bestückt, und dort sind die Durchsteckpins
das Problem: ihr Pin berührt die Massefläche auf allen vier Lagen und zieht die
Wärme so schnell ab, dass die Lötstelle nicht durchwärmt — bei den acht
Massepins der 40-poligen Buchse der Unterschied zwischen lötbar und nicht
lötbar. Ein SMD-Pad hängt dagegen nur an einer Lage; dort wäre die Entlastung
unnötig und würde beim TQFP-32 mit 0,8 mm Raster nicht einmal genug Speichen
unterbringen.

### 5.2 Platzierung

Das Skript prüft jede Platzierung, bevor es die Datei schreibt: Abstandsflächen
gegeneinander, gegen die beiden Aussparungen, gegen die Bohrungen und gegen den
Rand. Eine sich selbst überlappende Platzierung wird gar nicht erst gespeichert
— sonst erzeugt der DRC einen Schwall von Folgefehlern, die alle dieselbe
Ursache haben.

Leitgedanken:

- **Im Arm liegt nur die Buchse.** Alles andere dort säße über dem PoE-HAT.
- **Funkmodul im hinteren Überstand**, also so weit wie möglich vom Pi und
  von der Reglerecke entfernt — im Rack zeigt die IPEX-Buchse damit direkt
  zum rückwärtigen Antennen-Keystone. Alle Signalpins des E07 liegen auf
  einer Seite und zeigen zum Mikrocontroller; C5 sitzt direkt am VCC-Pin.
- **Peripheriestecker (J5–J7) an der Frontkante** — kurze Wege zum
  OLED-/LED-/Taster-Einsatz an der Rack-Front.
- **Abblockkondensatoren am Pin**, nicht in einer Reihe am Rand.
- **Prüfpunkte** in einer Reihe an der Frontkante, für einen Nadeladapter
  greifbar.
- **Masse-Stützvias vor dem Routen.** Jedes SMD-Massepad bekommt sein Via
  auf die Innenlagen, bevor der Autorouter läuft — sonst belegt der genau
  diese Fläche, und die eng bepinnten Bauteile (ATmega, Funkmodul) kämen
  hinterher nicht mehr an Masse.

### 5.3 Routing

Vollständig maschinell, reproduzierbar über [`rebuild.py`](kicad/rebuild.py):

```text
generate_pcb.py   Umriss, Bauteile, J1-Prüfung, Masse-Stützvias
autoroute.py      Freerouting, Nachrouten offener Reste, Flächenanbindung
finish_board.py   Bestückungsdruck, Markierung, Fertigungsunterlagen
kicad-cli drc     Fehler und Warnungen, beide müssen null sein
```

Masse ist dabei aus dem Autorouter herausgenommen: Sie liegt auf den beiden
Innenlagen, und jedes Massepad hängt über sein Stützvia daran. Ließe man sie
im Autorouter, zöge der zusätzliche Bahnen quer über die Platine, deren
Enden hinterher als unverbunden gemeldet werden — er kennt die Flächen nicht
als Verbindung.

Freerouting arbeitet mit Zufallselementen und liefert bei gleicher Eingabe
nicht zweimal dasselbe Layout; meist ist das Ergebnis fehlerfrei, manchmal
bleibt eine Verbindung offen. `rebuild.py` würfelt deshalb einfach neu, bis
alle Prüfungen durchgehen — statt von Hand nachzubessern und damit die
Reproduzierbarkeit zu verlieren.

### 5.4 Entwurfsregeln

Netzklassen sind in der Projektdatei hinterlegt: `Default` 0,25 mm,
`Power` 0,8 mm, `USB` als Differenzpaar 0,25 mm bei 0,2 mm Abstand. Die
konkrete Breite für 90 Ω hängt vom Lagenaufbau des Fertigers ab und ist mit ihm
abzustimmen — der Wert ist der Startpunkt für einen 1,6-mm-Vierlagenaufbau.

`min_hole_clearance` steht auf 0,15 mm statt der üblichen 0,25 mm. Bindend sind
dort nicht eigene Entscheidungen, sondern die Herstellergeometrie von J4 und S1.

### 5.5 Verbleibende DRC-Meldungen

Acht Meldungen der Art `hole_clearance` bleiben bestehen. Alle stammen aus den
Footprints von **J4** und **S1**: dort liegt der Befestigungsstift des
Steckverbinders innerhalb seines eigenen Schirmpads. Das ist herstellerseitig so
gewollt — der Stift wird auf das Schirmpad gelötet — und lässt sich nicht
beheben, ohne fremde Footprints umzuzeichnen.

### 5.6 Weitere Fertigungshinweise

- **Funkmodul** vollflächig über Masse, C5 direkt am VCC-Pin. Unter dem Modul
  keine Signale führen — das verlangt das Ebyte-Datenblatt in Abschnitt 4.1
  ausdrücklich.
- **USB-Datenpaar** kurz, symmetrisch, möglichst ohne Vias, Bezugsmasse
  durchgehend auf In1.
- **Resonator Y1** so nah wie möglich an XTAL1/XTAL2, Masse-Guard-Ring, keine
  Signale darunter.
- **Antenne** per Pigtail auf eine SMA-Einbaubuchse, von dort mit Kabel
  mindestens 20–30 cm vom Gehäuse weg. Bei Pi 4/5 stören HDMI-Clock und USB3
  im 868-MHz-Bereich messbar. Das Datenblatt warnt zusätzlich davor, die
  Antenne in ein Metallgehäuse zu setzen.

---

## 6. Stückliste

Erzeugt aus dem Schaltplan, nicht von Hand gepflegt:
[`kicad/bom.csv`](kicad/bom.csv).

| Ref | Wert / Typ | Bauform | Menge |
| --- | --- | --- | --- |
| U1 | MCP1754S-3302xCB (JLCPCB-Ersatz: XC6206P332MR-G) | SOT-23-3 | 1 |
| U2 | ATmega328P-AU | TQFP-32 | 1 |
| U3 | Ebyte **E07-900M10S** (CC1101, 855–925 MHz, IPEX) | Modul 14×20 mm | 1 |
| Y1 | Keramikresonator 8 MHz, integr. C (Murata CSTLS8M00G53-B0, JLCPCB C83707) | 3-polig THT | 1 |
| L1 | BLM21PG300 Ferrit | 0805 | 1 |
| R1 | 330 Ω | 0805 | 1 |
| R2, R3 | 10 kΩ | 0805 | 2 |
| R4 | 330 Ω — WS2812-Daten über PWM/GPIO18 (Pi 3/4) | 0805 | (1) |
| R5 | 330 Ω — WS2812-Daten über SPI/GPIO10 (Pi 5) | 0805 | 1 |
| C1, C2 | 10 µF | 0805 | 2 |
| C3, C4, C5, C8, C9 | 100 nF | 0805 | 5 |
| D1 | LED rot, U_F ≈ 2 V | 0805 | 1 |
| J1 | Buchsenleiste 2×20, 2,54 mm — **auf der Unterseite** | THT | 1 |
| J2 | Stiftleiste 2×3, 2,54 mm (ISP) | THT | 1 |
| J5 | JST-PH 4-polig (OLED, I²C) | THT | 1 |
| J6 | JST-PH 2-polig (Taster) | THT | 1 |
| J7 | JST-PH 3-polig (WS2812) | THT | 1 |
| S1 | Taster Omron B3U-1000P (JLCPCB C231329) | SMD | 1 |
| TP1–TP8 | Prüfpads 1 × 1 mm | – | 8 |
| KB1, KB2 | Kabelbinderlöcher (Zugentlastung Antenne) | 2,1 mm | 2 |

Konkrete Bezugsquellen mit Artikelnummern: [`bestellliste-reichelt.md`](bestellliste-reichelt.md)
und für die JLCPCB-Bestückung [`kicad/fab/jlcpcb_bom.csv`](kicad/fab/jlcpcb_bom.csv).

Extern: 868-MHz-Antenne mit SMA-Stecker, IPEX-auf-SMA-Pigtail,
SMA-Einbaubuchse, Gehäuse.

---

## 7. Fertigungsstand

**Hardware v0.2.0.** Prüfstand:

| Prüfung | Ergebnis |
| --- | --- |
| Schaltplan-ERC | 0 Fehler, 0 Warnungen |
| Netzliste gegen diese Spezifikation | exakt übereinstimmend |
| Platinen-DRC | **0 Fehler, 0 Warnungen, 0 unverbundene Elemente** |
| J1-Padgeometrie gegen die HAT-Vorlage | maschinell geprüft, siehe Errata |

38 Footprints auf vier Lagen, Umriss 88 × 42 mm.
Fertigungsunterlagen liegen in [`kicad/fab/`](kicad/fab/): Gerber für zehn
Lagen, Bohrdaten getrennt nach durchkontaktiert und nicht durchkontaktiert,
Bestückungsdatei, Stückliste, Layout- und Schaltplan-PDF.

### Beim Platinenhersteller

Bestellt wird die **unbestückte Platine**. Vier Lagen, 1,6 mm. Beide Innenlagen
tragen durchgehend Masse, es gibt keine impedanzkontrollierte Leitung — der
Lagenaufbau ist damit unkritisch und muss nicht abgestimmt werden.

Hochzuladen ist **`kicad/AskSin-Analyzer-V3-fertigung.zip`** — 13 Dateien: Kupfer für alle vier Lagen, Lötstopplack beidseitig, Bestückungsdruck
oben und unten, Lötpastenmaske oben, Umriss, Bohrdaten getrennt nach
durchkontaktiert und nicht durchkontaktiert, dazu das Gerber-Jobfile mit dem
Lagenaufbau.

Die übrigen Dateien in [`kicad/fab/`](kicad/fab/) — Layout- und
Schaltplan-PDF, Bestückungsdatei, Stückliste — sind für den Eigenbedarf und
gehören nicht in die Bestellung.

> **Hinweis zum Jobfile.** KiCad leitet die Ordnungszahl der Innenlagen aus
> deren interner Lagen-ID ab statt aus der Position im Stapel und schreibt bei
> einer programmgesteuert erzeugten Platine `Copper,L5,Inr` und `Copper,L7,Inr`,
> wo `L2` und `L3` stehen müssen. `finish_board.py` stellt das nach dem Export
> richtig. Wer die Daten von Hand neu exportiert, muss das nachziehen — sonst
> ordnet ein Fertiger, der das Jobfile auswertet, die Innenlagen falsch ein.

### Aufbau von Hand

Die Bestückung erfolgt selbst. Danach richtet sich das Layout:

- **Durchsteckpads sind thermisch entlastet**, SMD-Pads voll angebunden
  (Abschnitt 5.1). Ohne das wären die acht Massepins der 40-poligen Buchse
  praktisch nicht zu löten.
- Alle Widerstände und Kondensatoren sind **0805** mit verlängerten Pads für
  Handlötung. Kleiner wird es nicht.
- Das Funkmodul hat **Halblöcher** — die lassen sich von außen anlöten und sind
  deutlich gutmütiger als ein Gehäuse mit Pads unter dem Bauteil.
- Einziges feines Raster ist der **TQFP-32 des Mikrocontrollers** mit 0,8 mm.
  Mit Flussmittel und Entlötlitze gut beherrschbar; wer mag, nutzt die
  Lötpastenmaske aus `F_Paste.gtp` für eine Schablone.
- **S1** ist ein SMD-Taster mit vier Eckpads. Falls das zu fummelig wird, passt
  an seiner Stelle auch ein bedrahteter 6×6-mm-Taster — dann Platzierung und
  Routing neu erzeugen.

Empfohlene Reihenfolge: TQFP-32 zuerst, dann die passiven Bauteile, dann das
Funkmodul, zuletzt die Steckverbinder und der Taster.

### Nach dem Aufbau

Fuses, Bootloader und Firmware über **J2** brennen (Abschnitt 4.1) — ein USBasp
genügt. Anschließend elektrisch prüfen über **TP1–TP8**: Versorgung, Reset,
serielle Leitungen, GDO0 und CS.

### Beim Einkauf

- **Funkmodul: `E07-900M10S`**, nicht `E07-900MM10S`. Letzterer ist 10 × 10 mm
  groß und hat kein IPEX, nur Stanzlöcher.
- **Antenne, Verlängerung und Einbaubuchse müssen demselben Standard folgen.**
  Bei RP-SMA sind Stift und Buchse gegenüber SMA vertauscht: die Gewinde passen,
  innen trifft aber Buchse auf Buchse. Das Verlängerungskabel muss
  **U.FL/IPEX-1** sein; MHF2, MHF3 und MHF4 sehen ähnlich aus, passen aber nicht.
- **Baudrate:** Firmware unverändert 57600, Gegenseite 58824 (Abschnitt 2.5).
  Diese Asymmetrie muss dokumentiert bleiben, sonst „korrigiert" sie irgendwann
  jemand zurück und holt sich den 2,12-%-Fehler.
