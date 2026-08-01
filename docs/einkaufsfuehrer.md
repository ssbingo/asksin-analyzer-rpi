# Einkaufsführer Zubehör (Phase M12)

Anforderung (29.07.2026): Die Dokumentation bekommt **Beispiellinks und
Bilder** für die zu bestellende Zubehör-Hardware — als eigenes Kapitel im
Root-README **und** im Handbuch.

## Umfang

| Position | Zweck im Projekt |
| --- | --- |
| **SSD-Wechselrahmen** | Boot-SSD der Pis (SD nur Notbehelf), wartungsfreundlich im Datenschrank; am schnellsten bei AliExpress zu finden (30.07.2026) — Einsatz im 19″-Rahmen: [`hardware/3d-druck/19-zoll-rahmen/`](../hardware/3d-druck/19-zoll-rahmen/README.md) |
| **OLED-Display** | Statusanzeige an J5 (I²C, Phase M11) |
| **WS2812B** | Status-LED an J7 (Phase M11) |
| **Keystone-Module** | saubere Durchführungen im Datenschrank (RJ45/USB) |
| **SATA-Adapter** | SSD-an-USB-Anbindung des Pi 4 |
| **USB-Verbindungskabel** | Verkabelung Pi ↔ SSD/Peripherie |

Je Position: kurze Anforderungsbeschreibung (worauf es technisch ankommt),
1–2 **Beispiellinks** (Amazon/Reichelt — als Beispiele gekennzeichnet, keine
Affiliate-Links), Bild, ggf. „Finger weg von"-Hinweise (wie bei der
LED-Farben-Erkenntnis in der Reichelt-Liste).

## Stromversorgung beim Pi 5: prüfen, nicht annehmen

Der Pi 5 verhandelt beim Start mit seiner Stromversorgung und begrenzt
daraufhin den Strom **aller** USB-Geräte zusammen. Meldet die Versorgung nur
3 A, bleiben für USB **600 mA** — zu wenig, um eine 2,5-Zoll-SATA-SSD
überhaupt anlaufen zu lassen. Üblicherweise hebt man die Grenze dann mit
`usb_max_current_enable=1` auf.

Das klingt nach einer offenen Flanke, und wir haben sie zunächst auch für die
Ursache unserer Ausfälle gehalten. **Die Messung hat das widerlegt**
(01.08.2026, Analyzer 01 an PoE, 3000 mA gemeldet, Grenze aufgehoben):

| Messgröße | Wert |
| --- | --- |
| 5 V im Leerlauf | 5,147 V |
| 5 V Minimum unter 30 s Volllast | 5,099 V |
| Einbruch | **58 mV** |
| Drosselung | `throttled=0x0` |

Eine Speisung, die unter voller Leselast um 0,06 V nachgibt, hat reichlich
Reserve. Der gemeldete 3-A-Wert ist ein formaler Deckel, keine reale Grenze —
jedenfalls in diesem Aufbau. **Der Ausfall kam nicht von der Stromversorgung**
(die tatsächliche Ursache steht im Handbuch, Abschnitt 23.2).

Die Lehre ist trotzdem eine Position im Einkaufsführer, nur eine andere als
gedacht: Diese Größen sind **messbar**, und geraten wird hier nicht. Vor jeder
Kaufentscheidung liefert
[`tools/strombudget-messen.sh`](../tools/strombudget-messen.sh) die Zahlen.
Bleibt das Minimum über 4,95 V, ist die Versorgung als Ursache erledigt; unter
4,75 V liegt sie außerhalb der USB-Spezifikation und ist es sicher nicht.

Besonders tückisch an dieser Klasse von Fehlern: Der Rechenkern hat seine
eigene Regelung und bekommt von Einbrüchen am USB-Anschluss nichts mit.
`vcgencmd get_throttled` meldet unbeirrt `0x0`, und im Journal steht nichts,
weil es auf der ausgefallenen Platte liegt. Zu fassen ist so etwas nur über
einen Kernel-Mitschnitt übers Netz (Handbuch 23.1).

Den Zustand zeigen zwei Zeilen:


```bash
python3 -c "print(int.from_bytes(open('/proc/device-tree/chosen/power/max_current','rb').read(),'big'),'mA')"
vcgencmd get_config usb_max_current_enable
```

`5000 mA` heißt: alles offen. `3000 mA` heißt: Der Deckel greift, und wer ihn
aufhebt, sollte einmal nachmessen — nicht mehr und nicht weniger. Bei uns
ergab die Messung reichlich Reserve.

**Der Pi 4 kennt diese Verhandlung gar nicht** und gibt seinen USB-Anschlüssen
ohne Rückfrage Strom. Wer von einem laufenden Pi-4-Aufbau auf einen Pi 5
schließt, überträgt diese Annahme stillschweigend mit — deshalb steht der
Hinweis hier, auch wenn sich in unserem Fall die Versorgung als unschuldig
erwiesen hat.

### Wenn nur PoE zur Verfügung steht

Dann ist das Budget von außen vorgegeben, und zwar durch die Norm:

| Speisung | Leistung am Gerät | Reicht für Pi 5 + USB-SSD? |
| --- | --- | --- |
| 802.3af (PoE) | 12,95 W | knapp — für den Pi 5 allein schon wenig |
| 802.3at (PoE+) | 25,5 W | ja, **wenn** das HAT die 5 A auch meldet |
| 802.3bt (PoE++) | 51 W | reichlich |

Zwei Dinge müssen dabei zusammenkommen: Der **Switch oder Injektor** muss
PoE+ liefern, und das **HAT** muss die 5 A gegenüber der Pi-Firmware
ausweisen. Ein HAT, das nur 3 A meldet, führt trotz ausreichender Einspeisung
wieder zu den 600 mA für USB. Nachprüfen mit den beiden Zeilen oben — dort
muss `5000 mA` stehen.

**Der robustere Weg bei PoE ist, die Platte gar nicht erst an USB zu hängen.**
Eine **NVMe-Platine** am PCIe-Anschluss des Pi 5 umgeht die USB-Begrenzung
vollständig — sie gilt nur für USB-Geräte, nicht für PCIe. Eine M.2-SSD
verbraucht dabei auch weniger als eine 2,5-Zoll-SATA-Platte samt
USB-Brücke, und die gesamte Steckerkette aus Adapter, Keystone und Kabel
entfällt mit. Für Geräte, die jahrelang unbeaufsichtigt im Schrank laufen
sollen, ist das die Bauform ohne Folgefragen.

Vor einer Kaufentscheidung gehört gemessen, wie viel Luft tatsächlich bleibt:
[`tools/strombudget-messen.sh`](../tools/strombudget-messen.sh) belastet die
Platte und protokolliert dabei die 5-Volt-Schiene.

## Wichtig bei den Bildern

Das Repo ist **öffentlich**: Produktfotos aus Shops sind urheberrechtlich
geschützt und dürfen nicht übernommen werden. Deshalb **eigene Fotos** der
tatsächlich gekauften Teile (liefert der User, sobald die Hardware da ist)
— das ist ohnehin glaubwürdiger („so sieht das Richtige aus").

Bis dahin wird überall der **Platzhalter** verwendet:

![Produktbild folgt](img/produktbild-platzhalter.svg)

- Vektor (skaliert, bevorzugt): [`img/produktbild-platzhalter.svg`](img/produktbild-platzhalter.svg)
- Raster (800 × 600, falls SVG nicht geht): [`img/produktbild-platzhalter.png`](img/produktbild-platzhalter.png)

## Umsetzung

1. Kapitel **„Zubehör bestellen"** im Root-README (kompakte Tabelle mit Links)
2. Eigenes **Handbuch-Kapitel** (ausführlich, bebildert, mit
   Anforderungsbeschreibungen und Einbauhinweisen — Stil der bestehenden
   Kapitel), PDF neu bauen
3. Beispiellinks vom User verifizieren lassen (Verfügbarkeit/Varianten),
   analog zur Reichelt-Bestellliste

## Einordnung

Phase **M12** (reine Doku-Phase, jederzeit einschiebbar; Bilder abhängig von
der gelieferten Hardware). Akzeptanz: Kapitel in README und Handbuch-PDF,
alle sechs Positionen mit Anforderung + Beispiellink, Bilder der realen
Teile, keine fremden Produktfotos.
