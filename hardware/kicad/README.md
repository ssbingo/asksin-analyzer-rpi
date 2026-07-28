# KiCad-Projekt AskSin-Analyzer V4

KiCad 9. Schaltplan und Layout werden **generiert**, geroutet wird mit
Freerouting.

Stand: **ERC 0 Fehler, 0 Warnungen · DRC 0 Verstöße.** Netzliste stimmt exakt
mit der Spezifikation überein — 32 Bauteile, 25 Netze, 111 Anschlüsse. Platine
vollständig verdrahtet: 330 Leiterbahnen, 157 Durchkontaktierungen, vier Lagen.

## Ablauf

```bash
python3 generate_module_symbol.py     # Symbol des Funkmoduls
python3 generate_module_footprint.py  # Footprint des Funkmoduls
python3 generate_schematic.py         # Schaltplan, Projektdateien, netlist.md
python3 generate_pcb.py               # Umriss, Platzierung, Netze, Flächen
python3 autoroute.py                  # Freerouting + Flächenanbindung

kicad-cli sch erc --output erc.rpt --severity-all AskSin-Analyzer-V3.kicad_sch
kicad-cli sch export netlist --output netlist.net AskSin-Analyzer-V3.kicad_sch
python3 verify_netlist.py netlist.net
kicad-cli pcb drc --output drc.rpt --severity-error AskSin-Analyzer-V3.kicad_pcb
```

⚠️ **Freerouting arbeitet mit Zufallselementen.** Zwei Läufe auf derselben
Eingabe liefern unterschiedliche Ergebnisse — mal null Verstöße, mal zwei bis
drei offene Verbindungen. Die geroutete Platinendatei gehört deshalb ins
Repository und wird **nicht** bei jedem Bauen neu erzeugt. Wer neu routet, prüft
anschließend den DRC.

## Warum generiert

Die Netzliste steht in `generate_schematic.py` und ist die einzige Quelle der
Wahrheit. `verify_netlist.py` liest KiCads eigenen Netzlisten-Export zurück und
vergleicht ihn Knoten für Knoten — der Generator kann eine formal gültige Datei
schreiben, die trotzdem falsch verdrahtet ist.

Der Generator prüft vorab auf Pins in mehreren Netzen und auf Platzierungen, die
sich überlappen, den Umriss verlassen oder auf einer Bohrung liegen. Beides hat
echte Fehler gefangen: der Koppelkondensator C8 der Reset-Strecke war
versehentlich zusätzlich auf Masse gelegt, und der erste Platzierungsentwurf
hatte elf Überlappungen, aus denen der DRC 85 Folgefehler machte — darunter
sechs „Kurzschlüsse", die alle dieselbe Ursache hatten.

## Bauform

L-förmig, 118 × 46 mm umschließend, 3380 mm². Ein schmaler **Arm** trägt die
2×20-Buchse über dem durchgeschleiften Header des Waveshare-PoE-HAT, der
**Körper** sitzt rechts daneben außerhalb des Stapels. Der Lüfter bleibt frei,
und das Funkmodul liegt nicht zwischen zwei Schaltreglern, HDMI und USB3.

Position der Buchse und die beiden Bohrungen im Arm stammen aus der offiziellen
KiCad-Vorlage `RaspberryPi-HAT`. Die beiden hinteren Bohrungen stützen den
auskragenden Körper; **KB1/KB2** sind Kabelbinderlöcher als Zugentlastung für
das Antennenkabel.

## Lagenaufbau

| Lage | Belegung |
| --- | --- |
| F.Cu | Signale, Masseauffüllung |
| In1.Cu | durchgehende Masse |
| In2.Cu | durchgehende Masse |
| B.Cu | Signale, Masseauffüllung |

Ursprünglich lag +3V3 auf In2. Das zwang jedem Versorgungspad ein eigenes
Stützvia auf, wofür in der fertig gerouteten Platine regelmäßig der Platz
fehlte — sieben Pads blieben offen. Das Netz zieht rund 25 mA; als Leiterbahn
mit 0,6 mm ist es reichlich bemessen. Zwei durchgehende Masseflächen schirmen
den Empfänger zudem besser ab. Nach der Umstellung routete Freerouting alle
52 Netze ohne Rest.

Die Anbindung ist **`THT_THERMAL`**: Durchsteckpads bekommen eine thermische
Entlastung, SMD-Pads sind voll angebunden. Die Platine wird von Hand bestückt,
und dort sind die Durchsteckpins das Problem — ihr Pin berührt die Massefläche
auf allen vier Lagen. Volle Anbindung an allen Pads, wie ursprünglich gesetzt,
hätte die acht Massepins der 40-poligen Buchse praktisch unlötbar gemacht.
Umgekehrt ließe eine Entlastung auch der SMD-Pads am TQFP-32 mit 0,8 mm Raster
nicht genug Speichen zu — der DRC meldet das als `starved_thermal`.

## Was der Weg über Freerouting sichtbar gemacht hat

**Die Zonenumrisse waren offene Polygonzüge.** KiCad meldet das nur als
Warnung, aber es war die Ursache eines Absturzes beim Füllen. `SetClosed(True)`
behebt es.

**Die Umrandung im Specctra-Export hat Breite 0** — Freerouting darf dann bis
exakt an die Platinenkante routen. Die Breite zu erhöhen macht es schlimmer:
Freerouting liest die Umrandung dann als Linie statt als geschlossene Grenze und
routet quer durch die Aussparung des L. Von 2 auf 21 Kantenverstöße. Richtig
ist, den Umriss selbst im DSN um 0,55 mm nach innen zu schrumpfen.

**Kleinere Stützvias sparen keinen Platz.** 0,45 mm Durchmesser mit 0,25 mm
Bohrung erzeugte 52 neue Verstöße, weil es die eigenen Entwurfsregeln
unterschritt: 0,3 mm ist die Bohrungsuntergrenze, und mit 0,13 mm Restring folgt
daraus mindestens 0,56 mm Durchmesser.

## Flächenanbindung

Freerouting behandelt die Innenlagen als Versorgungslagen und lässt sie
unangetastet — setzt dorthin aber auch keine Durchkontaktierungen.
`autoroute.py` ergänzt sie in drei Schritten:

1. **Pad-Anbindung** — jeder Massepin bekommt eine Durchkontaktierung, der Weg
   dorthin wird mit A*-Suche gelegt.
2. **Via-Raster** im 3-mm-Abstand über die ganze Platine. Bindet die Auffüllung
   der Außenlagen an die Innenlagen und verbessert die Masseführung unter dem
   Funkmodul.
3. **Gezielte Inselanbindung** — die Auffüllung zerfällt durch die Leiterbahnen
   in Teilflächen; solche ohne Pad und ohne Durchkontaktierung meldet der DRC
   als offene Verbindung. Der Schritt sucht sie mit einem exakten
   Punkt-in-Fläche-Test und setzt gezielt eine Durchkontaktierung hinein.
   Wiederholt, weil jede neue Durchkontaktierung die Auffüllung verändert und
   dabei neue Teilflächen entstehen können.

Schritt 3 war nötig: ein gleichmäßiges Raster allein ließ zuverlässig zwei bis
drei Inseln übrig, unabhängig von der Rasterweite.

## Dateien

| Datei | Rolle |
| --- | --- |
| `generate_schematic.py` | Netzliste, Bestückung — hier wird geändert |
| `generate_module_symbol.py` | Symbol des CC1101-Moduls, 22 Pins |
| `generate_module_footprint.py` | Footprint aus den Datenblattmaßen |
| `generate_pcb.py` | Umriss, Platzierung, Netze, Flächen |
| `autoroute.py` | Freerouting-Durchlauf und Flächenanbindung |
| `route_pcb.py` | eigener Rasterrouter — Wegsuche und Via-Setzung, von `autoroute.py` mitbenutzt |
| `verify_netlist.py` | vergleicht KiCads Netzlisten-Export mit der Vorgabe |
| `netlist.md` | menschenlesbare Netzliste zur Gegenprobe |
| `erc.rpt`, `drc.rpt`, `bom.csv`, `*.pdf` | Prüf- und Review-Artefakte |

## Funkmodul

`U3` ist ein **Ebyte E07-900M10S** — CC1101, 855–925 MHz, 14 × 20 mm,
22 Halblöcher im 1,27-mm-Raster, IPEX-Antennenbuchse.

Symbol und Footprint sind gegen
[`../datasheets/Ebyte_E07-M_series_specification.pdf`](../datasheets/)
Abschnitt 3.2 verifiziert. Die Maßkette schließt exakt:
`2,00 + 7 × 1,27 + 5,57 + 2 × 1,27 + 1,00 = 20,00 mm`. Das Datenblatt gibt Ober-
und Unterkantenabstand unabhängig an; der Generator bricht ab, wenn die Kette
nicht aufgeht.

⚠️ Beim Einkauf: `E07-900M10S`, **nicht** `E07-900MM10S` — Letzterer ist
10 × 10 mm groß und hat kein IPEX, nur Stanzlöcher.

## Voraussetzungen

```bash
sudo apt install kicad
sudo apt install openjdk-25-jre-headless      # Freerouting 2.x braucht Java 25
mkdir -p ~/.local/share/freerouting
curl -L -o ~/.local/share/freerouting/freerouting-2.2.4.jar \
  https://github.com/freerouting/freerouting/releases/download/v2.2.4/freerouting-2.2.4.jar
```

`autoroute.py` sucht sich das neueste JAR, das mit der installierten
Java-Version wirklich startet, und meldet klar, was fehlt.

## Was noch fehlt

- Bestückungsdruck aufräumen: die Bezeichner stehen an Vorgabepositionen und
  überlappen teils. Für die Fertigung unkritisch, für die Bestückungskontrolle
  unschön.
- 3D-Modelle sind nicht installiert; die Darstellung zeigt nur Pads.
- Lagenaufbau und Impedanz mit dem Fertiger abstimmen.

## Lizenz

Abgeleitet von **AskSin-Analyzer-XS-RPi V1.1** (der-pw), CC BY-NC-SA 4.0.
Diese Ableitung steht unter derselben Lizenz. Namensnennung ist Pflicht.
