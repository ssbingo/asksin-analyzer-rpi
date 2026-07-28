# Bestellliste AskSin-Analyzer V4

Bauteile für **eine** Platine. Grundlage ist die aus dem Schaltplan erzeugte
Stückliste [`kicad/fab/stueckliste.csv`](kicad/fab/stueckliste.csv).

Alle Angaben zu reichelt.de am 28.07.2026 geprüft. Wo eine
Artikelbezeichnung steht, wurde sie dort gefunden; wo nur ein Suchbegriff
steht, gibt es die Position zwar, aber ich habe die konkrete Variante nicht
verifiziert.

---

## 1. Bei Reichelt erhältlich — Bezeichnung geprüft

| Pos | Menge | Bauteil | Reichelt-Bezeichnung |
| --- | --- | --- | --- |
| U1 | 1 | LDO 3,3 V / 150 mA, SOT-23-3 | **MCP 1754-3302CB** |
| U2 | 1 | ATmega328P, TQFP-32 | **ATMEGA 328P-AU** |
| Y1 | 1 | Keramikresonator 8,00 MHz, 3-polig, bedrahtet | **CST 8,00** |
| J1 | 1 | Buchsenleiste 2×20, RM 2,54 mm, gerade | **MPE 094-2-040** |
| J2 | 1 | Stiftleiste 2×3, RM 2,54 mm, gerade | **ECON SL6G2** |
| C3, C4, C5, C8, C9 | 5 | Kondensator 100 nF, 0805, X7R, 50 V | **KEM X7R0805 100N** |
| R2, R3 | 2 | Widerstand 10 kΩ, 0805, 1 % | **WAL WR08X1002FTL** |

---

## 2. Bei Reichelt erhältlich — Variante selbst wählen

Diese Positionen führt Reichelt, aber in vielen Varianten. Exakte Werte hier,
Auswahl im Shop.

| Pos | Menge | Bauteil | Suchbegriff | Zu beachten |
| --- | --- | --- | --- | --- |
| C1, C2 | 2 | Kondensator **10 µF**, 0805, X5R/X7R, ≥ 10 V | `Kondensator 0805 10µ` | ≥ 10 V, besser 16 V |
| R1 | 1 | Widerstand **330 Ω**, 0805 | `WR08X3300FTL` bzw. `SMD 0805 330` | Reihe wie bei R2/R3: `WR08X…FTL` |
| R4 | 1 | Widerstand **390 Ω**, 0805 | `WR08X3900FTL` bzw. `SMD 0805 390` | Vorwiderstand der LED-Daten |
| L1 | 1 | Ferritperle **30 Ω @ 100 MHz**, 0805 | `BLM21P` | Reihe BLM21P, 30 Ω / 4 A |
| D1 | 1 | LED 0805, **Flussspannung ≈ 2 V** | `EVL 17-21USRC` | ⚠️ siehe Hinweis unten — die Farbe ist **nicht** frei wählbar |

---

## 3. **Nicht bei Reichelt** — anderweitig beschaffen

| Pos | Menge | Bauteil | Genaue Bezeichnung | Bemerkung |
| --- | --- | --- | --- | --- |
| U3 | 1 | CC1101-Funkmodul | **Ebyte E07-900M10S** | 855–925 MHz, 14 × 20 mm, 22 Halblöcher RM 1,27 mm, **IPEX-Buchse**. Bezugsquellen: cdebyte.com, Antratek, AliExpress. ⚠️ **Nicht** `E07-900MM10S` — der ist 10 × 10 mm und hat kein IPEX |
| J5 | 1 | Stiftleiste JST-PH, 4-polig, gerade, bedrahtet | **B4B-PH-K-S** | RM 2,00 mm |
| J6 | 1 | Stiftleiste JST-PH, 2-polig, gerade, bedrahtet | **B2B-PH-K-S** | RM 2,00 mm |
| J7 | 1 | Stiftleiste JST-PH, 3-polig, gerade, bedrahtet | **B3B-PH-K-S** | RM 2,00 mm |
| S1 | 1 | Kurzhubtaster SMD, 4 Eckpads | **Omron B3U-1000P** | 3,0 × 1,6 mm |

**Zu den JST-PH-Steckern:** Reichelt führt von der PH-Reihe nur zwei- und
vierpolige Ausführungen, und die nur als SMD-Variante. Gebraucht werden
bedrahtete Stiftleisten in zwei-, drei- und vierpolig. Bezugsquellen: Mouser,
Digi-Key, TME, Reichelt-Alternative Conrad. Wer ohnehin dort bestellt, nimmt
die Gegenstücke gleich mit — siehe Abschnitt 4.

---

## 4. Zubehör, nicht auf der Platine

| Menge | Teil | Bemerkung |
| --- | --- | --- |
| 1 | Buchsengehäuse **PHR-4** + 4 Kontakte **SPH-002T-P0.5S** | Gegenstück zu J5 (OLED) |
| 1 | Buchsengehäuse **PHR-2** + 2 Kontakte SPH-002T-P0.5S | Gegenstück zu J6 (Taster) |
| 1 | Buchsengehäuse **PHR-3** + 3 Kontakte SPH-002T-P0.5S | Gegenstück zu J7 (WS2812) |
| 1 | IPEX-Verlängerung, **U.FL/IPEX-1**, auf SMA-Einbaubuchse | ⚠️ MHF2/3/4 passen mechanisch nicht |
| 1 | Antenne 868 MHz, SMA | ⚠️ **SMA und RP-SMA sind nicht kompatibel** — Antenne, Kabel und Einbaubuchse müssen demselben Standard folgen |
| 1 | Kabelbinder, ≤ 2 mm Breite | Zugentlastung durch KB1/KB2 |
| 4 | Abstandsbolzen M2,5 | Befestigung über MH1–MH4 |
| 1 | ISP-Programmer **USBasp** | Einmalig für Fuses, Bootloader, Firmware über J2 |

---

## Hinweise

**R5 wird nicht bestückt.** Der 0-Ω-Widerstand ist die Alternative für die
SPI-Variante der WS2812-Ansteuerung (GPIO10 statt GPIO18). Bestückt wird R4
**oder** R5, nie beide. Vorgabe ist R4.

**TP1–TP8 sind keine Bauteile**, sondern Prüfpads auf der Platine.

**Die LED-Farbe ist festgelegt.** D1 muss eine Flussspannung von rund 2 V
haben, also **rot, orange, gelb oder gelbgrün (565–570 nm)**. Blau, Weiß und
echtes Grün (unter etwa 530 nm) sind InGaN-Typen mit rund 3 V Flussspannung —
an 3,3 V Versorgung bleibt dann nichts mehr für den Vorwiderstand übrig, die
LED bliebe dunkel oder glimmte nur, und R1 wäre wirkungslos.

Geprüfte Kandidaten bei Reichelt:

| Artikel | Wellenlänge | U_F | Helligkeit | Strom an R1 |
| --- | --- | --- | --- | --- |
| **EVL 17-21USRC** | 639 nm rot | 2,0 V | 58 mcd | 3,3 mA |
| EVL 17-21/R6C-A | 632 nm rot | 2,3 V | 112 mcd | 2,4 mA |
| EVL 17-21SURC | 632 nm rot | 2,0 V | 15 mcd | 3,3 mA |

**Belastbarkeit der Widerstände:** unkritisch, jede handelsübliche
0805-Bauform mit 125 mW reicht mit großem Abstand.

| Pos | Funktion | Verlustleistung |
| --- | --- | --- |
| R1 | Vorwiderstand Status-LED | ≈ 5 mW (bei roter LED knapp 7 mW) |
| R2, R3 | Pull-up RESET und CS | je ≈ 1 mW |
| R4 | Serienwiderstand Datenleitung WS2812 | < 1 mW — der Eingang der LED ist hochohmig, Strom fließt nur beim Umladen von rund 15 pF |

Auch die Spannungsfestigkeit ist ohne Belang: 0805 sind typisch für 150 V
ausgelegt, auf der Platine liegen maximal 5 V an.

**Mehrere Platinen:** Die passiven Bauteile lohnt es sich gleich in größerer
Stückzahl zu nehmen — 0805-Widerstände und -Kondensatoren kosten bei Reichelt
im Zehnerpack kaum mehr als einzeln, und beim Handlöten geht erfahrungsgemäß
das eine oder andere verloren.
