# UART-Konfiguration für Raspberry Pi 3, 4 und 5

> **Stand V4:** Die Platine ist ein reiner Pi-Aufsatz, dieses Dokument ist
> damit Pflichtlektüre für jede Inbetriebnahme. (Der USB-Zweig aus dem
> V3-Entwurf ist entfallen.)

Ziel: Auf **allen drei Modellen** liegt am Ende dieselbe Gerätedatei an
GPIO14/15 — `/dev/ttyAMA0`, eine echte PL011-/RP1-UART, keine miniUART, keine
serielle Konsole. Der Core-Dienst muss dann nicht nach Modell verzweigen.

---

## 1. Warum das je Modell anders aussieht

| Modell | SoC | UART an GPIO14/15 *ab Werk* | Problem |
| --- | --- | --- | --- |
| Pi 3 | BCM2837 | miniUART (`/dev/ttyS0`) | Bluetooth belegt die PL011. Die miniUART leitet ihre Baudrate vom Core-Takt ab — taktet der herunter, driftet die Baudrate |
| Pi 4 | BCM2711 | miniUART (`/dev/ttyS0`) | wie Pi 3 |
| Pi 5 | BCM2712 + RP1 | **keine** | Die primäre Debug-UART liegt am dedizierten 3-poligen Connector neben den HDMI-Buchsen (`/dev/ttyAMA10`). GPIO14/15 sind unbelegt, bis man sie einschaltet |

Die miniUART bei 57600 Baud ohne festgenagelten Core-Takt ist genau die Quelle
der sporadischen Empfangsfehler, die dieser Platine im Forum nachhängen. Wir
umgehen sie vollständig.

## 2. Die Konfiguration

`config.txt` liegt ab Bookworm unter `/boot/firmware/config.txt`, davor unter
`/boot/config.txt`. Gleiches gilt für `cmdline.txt`.

### Pi 3 und Pi 4

```ini
# /boot/firmware/config.txt
enable_uart=1
dtoverlay=disable-bt
```

`disable-bt` schaltet das Bluetooth-Modem ab und gibt die PL011 an GPIO14/15
frei — sie erscheint als `/dev/ttyAMA0`, `/dev/serial0` zeigt darauf. Zusätzlich:

```bash
sudo systemctl disable --now hciuart
```

Ohne das versucht `hciuart` weiterhin, ein Bluetooth-Modem an der UART zu
attachen.

### Pi 5

```ini
# /boot/firmware/config.txt
dtparam=uart0=on
```

Alternativ `dtoverlay=uart0-pi5`, gleiche Wirkung. Ergebnis ist ebenfalls
`/dev/ttyAMA0`. `disable-bt` ist hier **nicht** nötig und auch nicht wirksam —
das Bluetooth-Modem des Pi 5 hängt nicht an dieser UART.

Nicht verwenden: `dtparam=uart0_console`. Das würde die Konsole auf GPIO14/15
legen — genau das, was wir nicht wollen.

### Auf allen Modellen: Konsole abschalten

In `cmdline.txt` muss `console=serial0,115200` (bzw. `console=ttyAMA0,115200`)
entfernt werden. Sonst schreibt getty in dieselbe Schnittstelle, aus der wir
lesen. Zusätzlich:

```bash
sudo systemctl disable --now serial-getty@ttyAMA0.service
sudo systemctl mask serial-getty@ttyAMA0.service
```

Auf dem Pi 5 bleibt die Konsole über den Debug-Connector (`/dev/ttyAMA10`)
erreichbar — komfortabler als bei Pi 3/4, wo sie damit ganz entfällt.

## 3. GPIO4 als Reset-Leitung

Die Platine nutzt **GPIO4 (Header-Pin 7)** als DTR-Ersatz für den Reset des
328P (`../hardware/README.md`, Abschnitt 4.2). Daraus folgt:

- **I²C-1 bleibt frei** und wird vom OLED des Status-LED-Projekts genutzt —
  `dtparam=i2c_arm=on` ist dafür ausdrücklich erwünscht. (In den Entwürfen
  V1–V3 lag der Reset auf GPIO2 und blockierte den Bus; das ist Geschichte.)
- **1-Wire kollidiert:** `dtoverlay=w1-gpio` legt sich standardmäßig auf
  GPIO4. Wer 1-Wire braucht, verschiebt es mit `gpiopin=` auf einen anderen
  Pin.
- **Ansteuerung über libgpiod** (`gpioset`), nicht über `RPi.GPIO` oder
  `pigpio` — beide funktionieren auf dem Pi 5 nicht mehr. Die Syntax
  unterscheidet sich zwischen libgpiod v1 und v2.
- GPIO4 bootet mit aktivem internen Pull-up (BCM-Standard für GPIO 0–8), die
  Ruhelage ist also definiert high.

## 4. Automatisches Setup

`../hardware/setup-uart.sh` erkennt das Modell über
`/proc/device-tree/model`, schreibt die passenden Zeilen, sichert die
Originaldateien und meldet, was zu tun bleibt:

```bash
sudo ./hardware/setup-uart.sh          # Prüfen und anwenden
sudo ./hardware/setup-uart.sh --check  # nur prüfen, nichts ändern
```

Nach dem Neustart verifizieren:

```bash
ls -l /dev/serial* /dev/ttyAMA*
# erwartet: /dev/ttyAMA0 vorhanden

# Rohdaten sehen — 58824, nicht 57600. Begründung siehe unten.
# stty beherrscht nur genormte Raten und lehnt 58824 ab.
# Deshalb zwei Schritte: erst der Rahmen, dann die exakte Rate.
stty -F /dev/ttyAMA0 57600 raw -echo
sudo python3 /opt/asksin-analyzer/deploy/baudrate.py /dev/ttyAMA0 58824
cat -v /dev/ttyAMA0
```

Erwartete Ausgabe sind Zeilen wie `:5A0A0100103F4B2A1234AB…;` und alle 750 ms
eine kurze Zeile `:5B;` (Grundrauschen). Kommt gar nichts, ist entweder die
Baudrate falsch, die Konsole noch aktiv oder der 328P hat keine Firmware.

## 5. Zugriffsrechte

Der Core-Dienst läuft nicht als root:

```bash
sudo usermod -aG dialout,gpio <dienstbenutzer>
```

`gpio` existiert nicht auf jeder Installation; alternativ eine udev-Regel für
`/dev/gpiochip*`. Das Setup-Skript weist darauf hin.

---

Quellen zur Pi-5-Konfiguration:
[Does Raspberry Pi 5 Support Serial Port on GPIO 14/15](https://forums.raspberrypi.com/viewtopic.php?t=362821) ·
[UART over GPIO 14/15 on the Raspberry Pi 5](https://forums.raspberrypi.com/viewtopic.php?t=378931) ·
[Configuring Pi 5 UARTs](https://forums.raspberrypi.com/viewtopic.php?t=359132) ·
[Need to update UART documentation for Pi5](https://github.com/raspberrypi/documentation/issues/3239)
