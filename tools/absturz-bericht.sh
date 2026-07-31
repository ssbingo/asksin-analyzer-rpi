#!/usr/bin/env bash
# Sammelt nach einem Absturz alles ein, was die Ursache verrät — in einem Lauf.
#
# Aufruf auf dem Raspberry Pi, nachdem er nach einem Absturz wieder läuft:
#
#     sudo bash absturz-bericht.sh
#
# Schreibt /var/lib/asksin-analyzer/absturz-bericht.txt und gibt am Ende eine
# Einschätzung aus. Das Skript ändert nichts — es liest nur.
#
# Der wichtigste Teil ist der VORHERIGE Systemstart (`journalctl -b -1`). Den
# gibt es nur, wenn das Journal dauerhaft gespeichert wird; der Installer
# richtet das ein. Ohne dauerhaftes Journal ist nach jedem harten Absturz
# alles weg — dann sagt der Bericht das ausdrücklich, statt zu schweigen.

set -uo pipefail

BERICHT=${1:-/var/lib/asksin-analyzer/absturz-bericht.txt}
mkdir -p "$(dirname "$BERICHT")" 2>/dev/null || BERICHT=/tmp/absturz-bericht.txt
: > "$BERICHT"

# Befunde für die Schlussbewertung
BEFUND_UNTERSPANNUNG=0
BEFUND_OOM=0
BEFUND_DATENTRAEGER=0
BEFUND_TEMPERATUR=0
BEFUND_KERNEL=0
BEFUND_SAUBER=unbekannt
BEFUND_JOURNAL=0

abschnitt() { printf '\n===== %s =====\n' "$1" >> "$BERICHT"; }
zeile()     { printf '%s\n' "$1" >> "$BERICHT"; }

# ---------------------------------------------------------------- Kopf ------
abschnitt "Bericht"
zeile "erstellt : $(date -Is)"
zeile "Rechner  : $(hostname)"
zeile "Modell   : $( { tr -d '\0' < /proc/device-tree/model; } 2>/dev/null || echo unbekannt)"
zeile "Kernel   : $(uname -srm)"
zeile "System   : $(. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME")"
zeile "Laufzeit : $(uptime -p 2>/dev/null)"
zeile "Start um : $(uptime -s 2>/dev/null)"

# ------------------------------------------------- Neustarts im Überblick ---
abschnitt "Bisherige Systemstarts (last-reboot)"
last --reboot 2>/dev/null | head -15 >> "$BERICHT" || zeile "nicht verfügbar"

abschnitt "Vom Journal erfasste Systemstarts"
if journalctl --list-boots --no-pager >/dev/null 2>&1; then
    ANZ=$(journalctl --list-boots --no-pager 2>/dev/null | wc -l)
    journalctl --list-boots --no-pager 2>/dev/null | tail -12 >> "$BERICHT"
    if [ "$ANZ" -le 1 ]; then
        zeile ""
        zeile "!! Nur der laufende Start ist bekannt. Das Journal ist FLÜCHTIG —"
        zeile "!! nach jedem Absturz ist die Vorgeschichte verloren. Einschalten mit:"
        zeile "!!     sudo mkdir -p /var/log/journal"
        zeile "!!     sudo sed -i 's/^#\\?Storage=.*/Storage=persistent/' /etc/systemd/journald.conf"
        zeile "!!     sudo systemctl restart systemd-journald"
        BEFUND_JOURNAL=1
    fi
else
    zeile "journalctl nicht verfügbar"
    BEFUND_JOURNAL=1
fi

# ------------------------------------------- Der Absturz selbst: -b -1 ------
abschnitt "Letzte 60 Zeilen VOR dem Absturz (vorheriger Start)"
VORHER=$(journalctl -b -1 -n 60 -o short-iso --no-pager -q 2>&1)
if [ -z "$VORHER" ] || printf '%s' "$VORHER" | grep -qiE \
    'no persistent journal|Specifying boot ID|Data from the specified boot|not found'; then
    zeile "Kein vorheriger Systemstart im Journal — siehe Hinweis oben."
else
    printf '%s\n' "$VORHER" >> "$BERICHT"
    # Sauberes Herunterfahren hinterlässt Spuren, ein Absturz nicht.
    if printf '%s' "$VORHER" | grep -qiE \
        'Shutting down|Reached target.*(Power-Off|Reboot|Shutdown)|systemd-shutdown|Unmounting'; then
        BEFUND_SAUBER=ja
    else
        BEFUND_SAUBER=nein
    fi
fi

abschnitt "Warnungen und Fehler des vorherigen Starts"
journalctl -b -1 -p 4 -n 120 -o short-iso --no-pager -q >> "$BERICHT" 2>&1 \
    || zeile "nicht verfügbar"

# ------------------------------------------------- Musterauswertung ---------
# Beide Starts durchsuchen: der vorherige zeigt den Absturz, der laufende zeigt,
# ob das Problem gerade wieder anläuft.
SUCHE=$( { journalctl -b -1 --no-pager -q 2>/dev/null;
           journalctl -b  0 --no-pager -q 2>/dev/null; } )

# grep -c schreibt bei null Treffern bereits „0" und endet trotzdem mit Code 1.
# Ein zusätzliches „|| echo 0" ergäbe zwei Zeilen und damit keine Zahl mehr.
zaehle() { printf '%s' "$SUCHE" | grep -ciE "$1" 2>/dev/null | head -1; }

N_UV=$(zaehle 'under[- ]?voltage')
N_OOM=$(zaehle 'out of memory|oom-killer|killed process')
N_DT=$(zaehle 'ext4-fs error|i/o error|blk_update_request|reset .*speed usb|usb .*: reset|nvme.*(reset|timeout)')
N_TMP=$(zaehle 'critical temperature|thermal shutdown|over-temperature')
N_KRN=$(zaehle 'kernel panic|hung task|watchdog: bug|general protection|oops:')

abschnitt "Auffällige Kernelmeldungen (beide Starts)"
zeile "Unterspannung .............. $N_UV"
zeile "Speichermangel (OOM) ....... $N_OOM"
zeile "Datenträger / USB / NVMe ... $N_DT"
zeile "Übertemperatur ............. $N_TMP"
zeile "Schwerer Kernelfehler ...... $N_KRN"
[ "$N_UV"  -gt 0 ] && BEFUND_UNTERSPANNUNG=1
[ "$N_OOM" -gt 0 ] && BEFUND_OOM=1
[ "$N_DT"  -gt 0 ] && BEFUND_DATENTRAEGER=1
[ "$N_TMP" -gt 0 ] && BEFUND_TEMPERATUR=1
[ "$N_KRN" -gt 0 ] && BEFUND_KERNEL=1

abschnitt "Belege dazu (je bis zu 12 Zeilen)"
for m in 'under[- ]?voltage' 'out of memory|oom-killer|killed process' \
         'ext4-fs error|i/o error|blk_update_request|reset .*speed usb|nvme.*(reset|timeout)' \
         'critical temperature|thermal shutdown' \
         'kernel panic|hung task|watchdog: bug|general protection|oops:'; do
    T=$(printf '%s' "$SUCHE" | grep -iE "$m" | tail -12)
    [ -n "$T" ] && { zeile "--- $m"; printf '%s\n' "$T" >> "$BERICHT"; }
done

# ------------------------------------------------------- Stromversorgung ----
abschnitt "Stromversorgung und Temperatur (jetzt)"
if command -v vcgencmd >/dev/null 2>&1; then
    TH=$(vcgencmd get_throttled 2>/dev/null)
    zeile "$TH"
    W=$(printf '%s' "$TH" | sed -n 's/.*=0x//p')
    W=$((16#${W:-0}))
    [ $((W & 0x1))     -ne 0 ] && { zeile "  -> JETZT Unterspannung";            BEFUND_UNTERSPANNUNG=1; }
    [ $((W & 0x4))     -ne 0 ] &&   zeile "  -> JETZT gedrosselt"
    [ $((W & 0x8))     -ne 0 ] && { zeile "  -> JETZT Temperaturgrenze";         BEFUND_TEMPERATUR=1; }
    [ $((W & 0x10000)) -ne 0 ] && { zeile "  -> seit dem Start Unterspannung";   BEFUND_UNTERSPANNUNG=1; }
    [ $((W & 0x40000)) -ne 0 ] &&   zeile "  -> seit dem Start gedrosselt"
    [ $((W & 0x80000)) -ne 0 ] && { zeile "  -> seit dem Start Temperaturgrenze"; BEFUND_TEMPERATUR=1; }
    zeile "Kerntemperatur : $(vcgencmd measure_temp 2>/dev/null)"
    zeile "Kernspannung   : $(vcgencmd measure_volts 2>/dev/null)"
else
    zeile "vcgencmd nicht vorhanden"
fi
zeile "Netzteil laut Firmware:"
grep -iE 'power|psu|current' /sys/firmware/devicetree/base/chosen/* 2>/dev/null | head -3 >> "$BERICHT"
for f in /sys/class/power_supply/*/; do
    [ -d "$f" ] && zeile "  $(basename "$f"): $(cat "$f/online" 2>/dev/null)"
done

# ----------------------------------------------------- Speicher und Platte --
abschnitt "Arbeitsspeicher"
free -h >> "$BERICHT" 2>&1

abschnitt "Datenträger"
df -h / /var /boot 2>/dev/null >> "$BERICHT"
zeile ""
zeile "Wurzeldateisystem: $(findmnt -no SOURCE / 2>/dev/null)"
lsblk -o NAME,SIZE,TRAN,MODEL,MOUNTPOINT 2>/dev/null >> "$BERICHT"

abschnitt "Journalgröße"
journalctl --disk-usage --no-pager 2>/dev/null >> "$BERICHT" || zeile "unbekannt"

# ----------------------------------------------------------- Unsere Dienste -
abschnitt "Zustand unserer Dienste"
for d in asksin-analyzer asksin-analyzer-led asksin-analyzer-netz.path \
         asksin-analyzer-update.path; do
    zeile "--- $d"
    systemctl status "$d" --no-pager -n 0 2>&1 | head -6 >> "$BERICHT"
done

abschnitt "Neustarts unseres Dienstes im laufenden Start"
journalctl -b 0 -u asksin-analyzer --no-pager -q 2>/dev/null \
    | grep -ciE 'Started|Stopped|Failed' >> "$BERICHT"

# Das Wertvollste ueberhaupt: unsere eigenen Zeilen UNMITTELBAR VOR dem
# Ausfall. Der Tail der Datei zeigt den laufenden Betrieb — gebraucht wird
# aber der Moment des Abrisses. Deshalb wird bis zum Zeitstempel der letzten
# Journalzeile des vorherigen Starts geschnitten.
LOGV=/var/lib/asksin-analyzer/protokoll
NEUSTE=$(ls -1t "$LOGV"/asksin-*.log 2>/dev/null | head -1)
ENDE_VORHER=$(journalctl -b -1 -n 1 -o short-iso --no-pager -q 2>/dev/null \
    | awk '{print $1}' | sed 's/T/ /; s/+.*//')

abschnitt "Unser Protokoll UNMITTELBAR VOR dem Ausfall"
if [ -z "$NEUSTE" ]; then
    zeile "Kein Protokoll gefunden unter $LOGV"
elif [ -z "$ENDE_VORHER" ]; then
    zeile "Zeitpunkt des Ausfalls unbekannt (kein vorheriger Start im Journal)."
else
    zeile "Datei: $NEUSTE"
    zeile "Ausfall gegen: $ENDE_VORHER"
    zeile ""
    awk -v grenze="$ENDE_VORHER" '$0 <= grenze' "$NEUSTE" | tail -25 >> "$BERICHT"
    zeile ""
    zeile "^^^ Bricht die Aufzeichnung hier mitten in einer Aktion ab (etwa"
    zeile "    zwischen \"LED-Frame wird geschrieben\" und \"LED-Frame"
    zeile "    geschrieben\"), hat genau diese Aktion den Rechner geholt."
fi

abschnitt "Letzte 25 Zeilen unseres Protokolls (laufender Betrieb)"
if [ -n "$NEUSTE" ]; then
    tail -25 "$NEUSTE" >> "$BERICHT"
fi

abschnitt "Prozesse mit dem meisten Speicher"
ps -eo pmem,pcpu,rss,comm --sort=-rss 2>/dev/null | head -8 >> "$BERICHT"

# ------------------------------------------------------------ Bewertung -----
abschnitt "Einschätzung"
VERDACHT=()
[ "$BEFUND_UNTERSPANNUNG" = 1 ] && VERDACHT+=("STROMVERSORGUNG: Der Kernel hat Unterspannung gemeldet. Das ist bei einem Pi, der ohne Vorwarnung 'tot' ist, die häufigste Ursache. Bei PoE-Betrieb mit SSD reicht das Leistungsbudget oft nicht.")
[ "$BEFUND_DATENTRAEGER" = 1 ] && VERDACHT+=("DATENTRÄGER: USB-, NVMe- oder Dateisystemfehler. Wenn sich die Boot-SSD kurz abmeldet, verliert der Pi sein Wurzeldateisystem und wirkt sofort tot, ohne neu zu starten.")
[ "$BEFUND_OOM" = 1 ]           && VERDACHT+=("SPEICHERMANGEL: Der OOM-Killer war aktiv. Welcher Prozess getroffen wurde, steht oben bei den Belegen.")
[ "$BEFUND_TEMPERATUR" = 1 ]    && VERDACHT+=("TEMPERATUR: Die Notabschaltung hat gegriffen oder war nahe. Lüfter und Luftweg prüfen.")
[ "$BEFUND_KERNEL" = 1 ]        && VERDACHT+=("KERNEL: Panik, hängende Aufgabe oder Watchdog. Das ist ein Systemfehler, keine Anwendungsstörung.")

if [ ${#VERDACHT[@]} -eq 0 ]; then
    if [ "$BEFUND_JOURNAL" = 1 ]; then
        zeile "Keine Aussage möglich: Das Journal überlebt den Neustart nicht."
        zeile "Zuerst das dauerhafte Journal einschalten (Hinweis oben), dann den"
        zeile "nächsten Absturz abwarten und diesen Bericht erneut erzeugen."
    else
        zeile "Keine der bekannten Ursachen hat Spuren hinterlassen."
        zeile "Ein Absturz ganz ohne Kernelmeldung deutet auf einen harten"
        zeile "Stromausfall oder ein Einfrieren der Hardware hin — beides"
        zeile "hinterlässt nichts mehr im Journal."
    fi
else
    for v in "${VERDACHT[@]}"; do zeile "* $v"; done
fi
zeile ""
zeile "Vorheriger Start sauber beendet: $BEFUND_SAUBER"
[ "$BEFUND_SAUBER" = nein ] && zeile "  -> Der Pi ist ausgefallen, er wurde nicht heruntergefahren."

# --------------------------------------------------------------- Ausgabe ----
sed -n '/===== Einschätzung =====/,$p' "$BERICHT"
printf '\nVollständiger Bericht: %s\n' "$BERICHT"
printf 'Zum Verschicken:  cat %s\n' "$BERICHT"
