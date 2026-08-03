#!/usr/bin/env python3
"""
Erzeugt die mitgelieferten Grafana-Vorlagen.

Warum ein Generator und nicht sieben JSON-Dateien von Hand: Ein
Grafana-Dashboard ist mehrere hundert Zeilen JSON, von denen 90 % immer gleich
sind — Datenquelle, Achsen, Farbschwellen, Rasterpositionen. Von Hand gepflegt
laufen die sieben Dateien binnen weniger Änderungen auseinander, und ein
Tippfehler in einer Flux-Abfrage fällt erst im Browser auf.

Hier steht jede Abfrage genau einmal, die Panels entstehen aus wenigen
Bausteinen, und ein Lauf erzeugt alle Dateien neu.

Aufruf:
    python3 vorlagen-bauen.py           # schreibt dashboards/*.json
    python3 vorlagen-bauen.py --pruefen # nur pruefen, nichts schreiben

Die erzeugten Dateien werden **mit eingecheckt**: Grafana liest sie beim Start
aus dem Provisionierungsverzeichnis, dort laeuft kein Python.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

HIER = Path(__file__).resolve().parent
ZIEL = HIER / "dashboards"

# Feste Kennung der Datenquelle. Sie steht genauso in
# provisioning/datasources/influxdb.yaml — beide muessen zusammenpassen,
# sonst zeigen die Dashboards "Datasource not found".
DS = {"type": "influxdb", "uid": "asksin-influx"}

# Beispielstandorte fuer die Vorbelegung der Auswahlfelder. Grafana ersetzt
# sie beim ersten Laden durch die tatsaechlich vorhandenen Werte; sie dienen
# nur dazu, dass ein frisches Dashboard nicht leer aussieht.
BEISPIEL_STANDORTE = ["Büro Keller", "Gartenhaus", "Dachboden", "Kellertreppe"]

# Schwellen, die im ganzen Satz gelten sollen.
DUTY_WARNUNG = 80          # Prozent — ab hier wird ein Geraet auffaellig
RSSI_SCHWACH = -95         # dBm — darunter wird der Empfang unzuverlaessig
STUMM_WARNUNG = 6 * 3600   # Sekunden — so lange darf ein Geraet schweigen
STUMM_ALARM = 24 * 3600    # Sekunden — danach ist die Batterie verdaechtig


# ---------------------------------------------------------------- Abfragen

def flux(rumpf: str) -> str:
    """Setzt eine Flux-Abfrage mit dem immer gleichen Kopf zusammen."""
    return (
        'from(bucket: v.bucket)\n'
        '  |> range(start: v.timeRangeStart, stop: v.timeRangeStop)\n'
        f'{rumpf}'
    )


def nach_standort(measurement: str, feld: str, fn: str = "mean") -> str:
    """Ein Feld je Standort ueber die Zeit."""
    return flux(
        f'  |> filter(fn: (r) => r._measurement == "{measurement}")\n'
        f'  |> filter(fn: (r) => r._field == "{feld}")\n'
        '  |> filter(fn: (r) => contains(value: r.standort, set: ${standort:json}))\n'
        f'  |> aggregateWindow(every: v.windowPeriod, fn: {fn}, createEmpty: false)\n'
        '  |> keep(columns: ["_time", "_value", "standort"])'
    )


def nach_geraet(feld: str, fn: str = "mean") -> str:
    """Ein Geraetefeld ueber die Zeit, eine Linie je Geraet."""
    return flux(
        '  |> filter(fn: (r) => r._measurement == "geraet")\n'
        f'  |> filter(fn: (r) => r._field == "{feld}")\n'
        '  |> filter(fn: (r) => contains(value: r.standort, set: ${standort:json}))\n'
        f'  |> aggregateWindow(every: v.windowPeriod, fn: {fn}, createEmpty: false)\n'
        '  |> keep(columns: ["_time", "_value", "name", "standort"])'
    )


def letzter_wert_je_geraet(feld: str) -> str:
    """Der jeweils juengste Wert je Geraet — Grundlage aller Tabellen."""
    return flux(
        '  |> filter(fn: (r) => r._measurement == "geraet")\n'
        f'  |> filter(fn: (r) => r._field == "{feld}")\n'
        '  |> filter(fn: (r) => contains(value: r.standort, set: ${standort:json}))\n'
        '  |> group(columns: ["standort", "name", "adresse"])\n'
        '  |> last()\n'
        '  |> group()\n'
        '  |> keep(columns: ["standort", "name", "adresse", "_value"])'
    )


# ----------------------------------------------------------------- Panels

# Wie die Linien in der Legende heissen sollen.
#
# Ohne Angabe schreibt Grafana den ganzen Etikettensatz hin:
#   {name="BWM_Einfahrt", standort="Gartenhaus"}
# Das ist korrekt, aber unlesbar — und bei zwanzig Geraeten fuellt es den
# halben Bildschirm. Mit displayName steht dort nur noch, was zaehlt.
NACH_STANDORT = "${__field.labels.standort}"
NACH_GERAET = "${__field.labels.name} · ${__field.labels.standort}"
NUR_GERAET = "${__field.labels.name}"


def _feld(einheit: str = "", schwellen: list | None = None,
          min_: float | None = None, max_: float | None = None,
          legende: str | None = NACH_STANDORT) -> dict:
    vorgaben: dict = {
        "unit": einheit,
        "custom": {"lineWidth": 2, "fillOpacity": 8, "showPoints": "never"},
        "color": {"mode": "palette-classic"},
    }
    if legende is not None:
        vorgaben["displayName"] = legende
    if schwellen is not None:
        vorgaben["thresholds"] = {"mode": "absolute", "steps": schwellen}
        vorgaben["custom"]["thresholdsStyle"] = {"mode": "line"}
    if min_ is not None:
        vorgaben["min"] = min_
    if max_ is not None:
        vorgaben["max"] = max_
    return {"defaults": vorgaben, "overrides": []}


def verlauf(titel: str, abfrage: str, x: int, y: int, w: int = 12, h: int = 8,
            einheit: str = "", beschreibung: str = "",
            schwellen: list | None = None,
            min_: float | None = None, max_: float | None = None,
            legende: str | None = NACH_STANDORT) -> dict:
    return {
        "type": "timeseries",
        "title": titel,
        "description": beschreibung,
        "datasource": DS,
        "gridPos": {"x": x, "y": y, "w": w, "h": h},
        "targets": [{"refId": "A", "query": abfrage}],
        "fieldConfig": _feld(einheit, schwellen, min_, max_, legende),
        "options": {"legend": {"displayMode": "list", "placement": "bottom",
                               "showLegend": True},
                    "tooltip": {"mode": "multi", "sort": "desc"}},
    }


def kennzahl(titel: str, abfrage: str, x: int, y: int, w: int = 6, h: int = 4,
             einheit: str = "", beschreibung: str = "",
             schwellen: list | None = None, text_modus: str = "auto") -> dict:
    return {
        "type": "stat",
        "title": titel,
        "description": beschreibung,
        "datasource": DS,
        "gridPos": {"x": x, "y": y, "w": w, "h": h},
        "targets": [{"refId": "A", "query": abfrage}],
        "fieldConfig": {
            "defaults": {
                "unit": einheit,
                "thresholds": {
                    "mode": "absolute",
                    "steps": schwellen or [{"color": "text", "value": None}],
                },
                "color": {"mode": "thresholds"},
            },
            "overrides": [],
        },
        "options": {"colorMode": "value", "graphMode": "area",
                    "textMode": text_modus, "reduceOptions":
                    {"calcs": ["lastNotNull"], "fields": "", "values": False}},
    }


def tabelle(titel: str, abfrage: str, x: int, y: int, w: int = 12, h: int = 9,
            beschreibung: str = "", sortierung: dict | None = None,
            overrides: list | None = None) -> dict:
    return {
        "type": "table",
        "title": titel,
        "description": beschreibung,
        "datasource": DS,
        "gridPos": {"x": x, "y": y, "w": w, "h": h},
        "targets": [{"refId": "A", "query": abfrage, "format": "table"}],
        "fieldConfig": {"defaults": {"custom": {"align": "auto"}},
                        "overrides": overrides or []},
        "options": {"showHeader": True,
                    "sortBy": [sortierung] if sortierung else []},
    }


def zustandsband(titel: str, abfrage: str, x: int, y: int, w: int = 24,
                 h: int = 6, beschreibung: str = "",
                 abbildung: list | None = None) -> dict:
    """Farbiger Balken je Reihe — zeigt Ausfaelle als Luecke im Band."""
    return {
        "type": "state-timeline",
        "title": titel,
        "description": beschreibung,
        "datasource": DS,
        "gridPos": {"x": x, "y": y, "w": w, "h": h},
        "targets": [{"refId": "A", "query": abfrage}],
        "fieldConfig": {
            "defaults": {
                "displayName": NACH_STANDORT,
                "custom": {"lineWidth": 0, "fillOpacity": 90},
                "mappings": abbildung or [],
                "color": {"mode": "thresholds"},
                "thresholds": {"mode": "absolute",
                               "steps": [{"color": "red", "value": None},
                                         {"color": "green", "value": 1}]},
            },
            "overrides": [],
        },
        "options": {"mergeValues": True, "showValue": "never",
                    "legend": {"displayMode": "list", "placement": "bottom",
                               "showLegend": True}},
    }


def ueberschrift(titel: str, y: int) -> dict:
    return {"type": "row", "title": titel, "collapsed": False,
            "gridPos": {"x": 0, "y": y, "w": 24, "h": 1}, "panels": []}


# ------------------------------------------------------------- Variablen

def var_bucket() -> dict:
    return {
        "name": "bucket", "label": "Bucket", "type": "constant",
        "query": "asksin", "current": {"text": "asksin", "value": "asksin"},
        "hide": 2,
    }


def var_standort() -> dict:
    """Mehrfachauswahl der Standorte, aus den Daten selbst gefuellt."""
    return {
        "name": "standort", "label": "Standort", "type": "query",
        "datasource": DS, "multi": True, "includeAll": True,
        "refresh": 1,
        "query": {
            "query": 'import "influxdata/influxdb/schema"\n'
                     'schema.tagValues(bucket: "asksin", tag: "standort")',
        },
        "current": {"text": ["All"], "value": ["$__all"]},
        "options": [],
    }


def var_geraet() -> dict:
    return {
        "name": "geraet", "label": "Gerät", "type": "query",
        "datasource": DS, "multi": False, "includeAll": False,
        "refresh": 1,
        "query": {
            "query": 'import "influxdata/influxdb/schema"\n'
                     'schema.tagValues(bucket: "asksin", tag: "name")',
        },
        "current": {}, "options": [],
    }


def dashboard(uid: str, titel: str, beschreibung: str, panels: list,
              variablen: list, zeitraum: str = "now-6h",
              takt: str = "30s") -> dict:
    return {
        "uid": uid,
        "title": titel,
        "description": beschreibung,
        "tags": ["asksin", "AskSin-Analyzer"],
        "timezone": "browser",
        "editable": True,
        "schemaVersion": 39,
        "version": 1,
        "refresh": takt,
        "time": {"from": zeitraum, "to": "now"},
        "templating": {"list": variablen},
        "panels": panels,
    }


# ------------------------------------------------------------ Dashboards

def leitstand() -> dict:
    """Die Seite fuer den zweiten Monitor: laeuft alles?"""
    p = [
        kennzahl(
            "Analyzer online", flux(
                '  |> filter(fn: (r) => r._measurement == "analyzer")\n'
                '  |> filter(fn: (r) => r._field == "connected")\n'
                '  |> group(columns: ["standort"])\n'
                '  |> last()\n'
                '  |> filter(fn: (r) => r._value == true)\n'
                '  |> group()\n'
                '  |> count()'),
            0, 0, w=6,
            beschreibung="Wie viele Analyzer melden gerade eine gültige "
                         "Verbindung zum Sniffer.",
            schwellen=[{"color": "red", "value": None},
                       {"color": "green", "value": 1}]),
        kennzahl(
            "Telegramme pro Minute", flux(
                '  |> filter(fn: (r) => r._measurement == "analyzer")\n'
                '  |> filter(fn: (r) => r._field == "telegrammeProMinute")\n'
                '  |> filter(fn: (r) => contains(value: r.standort, set: ${standort:json}))\n'
                '  |> group(columns: ["standort"])\n'
                '  |> last()\n'
                '  |> group()\n'
                '  |> sum()'),
            6, 0, w=6,
            beschreibung="Summe über alle ausgewählten Standorte. Bricht der "
                         "Wert ein, ohne dass ein Analyzer offline ist, "
                         "stimmt etwas mit dem Empfang nicht."),
        kennzahl(
            "Bekannte Geräte", flux(
                '  |> filter(fn: (r) => r._measurement == "analyzer")\n'
                '  |> filter(fn: (r) => r._field == "geraete")\n'
                '  |> filter(fn: (r) => contains(value: r.standort, set: ${standort:json}))\n'
                '  |> group(columns: ["standort"])\n'
                '  |> last()\n'
                '  |> group()\n'
                '  |> max()'),
            12, 0, w=6,
            beschreibung="Höchster Wert über die Standorte — nicht die Summe, "
                         "denn dieselben Geräte werden mehrfach gehört."),
        kennzahl(
            "Höchster Duty-Cycle", flux(
                '  |> filter(fn: (r) => r._measurement == "analyzer")\n'
                '  |> filter(fn: (r) => r._field == "maxDutyCycle")\n'
                '  |> filter(fn: (r) => contains(value: r.standort, set: ${standort:json}))\n'
                '  |> group()\n'
                '  |> last()'),
            18, 0, w=6, einheit="percent",
            beschreibung="Das lauteste Gerät im Funknetz. Ab 80 % wird es eng, "
                         "bei 100 % darf es per Gesetz nicht mehr senden.",
            schwellen=[{"color": "green", "value": None},
                       {"color": "orange", "value": DUTY_WARNUNG},
                       {"color": "red", "value": 100}]),
        zustandsband(
            "Verbindung je Standort", nach_standort("analyzer", "connected", "last"),
            0, 4,
            beschreibung="Grün heißt: Der Sniffer liefert gültige Daten. Jede "
                         "rote Lücke ist ein Ausfall — hier sieht man auf einen "
                         "Blick, wann und wie lange.",
            abbildung=[{"type": "value", "options": {
                "true": {"text": "verbunden", "color": "green", "index": 0},
                "false": {"text": "getrennt", "color": "red", "index": 1}}}]),
        verlauf("Telegramme pro Minute", nach_standort("analyzer", "telegrammeProMinute"),
                0, 10, beschreibung="Eine Linie je Standort."),
        verlauf("Grundrauschen", nach_standort("analyzer", "grundrauschen"),
                12, 10, einheit="dBm",
                beschreibung="Je höher (weniger negativ), desto mehr stört es. "
                             "Ein dauerhafter Anstieg ohne mehr Telegramme "
                             "bedeutet einen Störer in der Nähe."),
        verlauf("Bekannte Geräte", nach_standort("analyzer", "geraete", "max"),
                0, 18, beschreibung="Fällt die Zahl, ist ein Gerät verstummt — "
                                    "siehe „Batterie- und Ausfallwächter“."),
        verlauf("Laufzeit des Dienstes", nach_standort("analyzer", "laufzeitSekunden", "last"),
                12, 18, einheit="s",
                beschreibung="Springt die Kurve auf null, wurde der Dienst neu "
                             "gestartet. Dann fangen auch die Telegrammzähler "
                             "wieder bei null an."),
    ]
    return dashboard(
        "asksin-leitstand", "AskSin — Leitstand",
        "Läuft alles? Die Übersichtsseite für den zweiten Monitor.",
        p, [var_bucket(), var_standort()])


def funkqualitaet() -> dict:
    p = [
        verlauf("Empfangsstärke je Gerät", nach_geraet("rssi"), 0, 0, w=24, h=10,
                einheit="dBm", legende=NACH_GERAET,
                beschreibung="RSSI, geglättet. Die Linie unten markiert −95 dBm — "
                             "darunter wird der Empfang unzuverlässig.",
                schwellen=[{"color": "green", "value": None},
                           {"color": "red", "value": RSSI_SCHWACH}]),
        tabelle("Die schwächsten Empfänge", letzter_wert_je_geraet("rssi"),
                0, 10, w=12, h=10,
                beschreibung="Jüngster Messwert je Gerät, schwächste zuerst. "
                             "Das ist die Liste, nach der man entscheidet, wo "
                             "ein Repeater hin muss.",
                sortierung={"displayName": "_value", "desc": False},
                overrides=[{
                    "matcher": {"id": "byName", "options": "_value"},
                    "properties": [
                        {"id": "displayName", "value": "RSSI"},
                        {"id": "unit", "value": "dBm"},
                        {"id": "custom.cellOptions",
                         "value": {"type": "color-background"}},
                        {"id": "thresholds", "value": {
                            "mode": "absolute",
                            "steps": [{"color": "red", "value": None},
                                      {"color": "orange", "value": RSSI_SCHWACH},
                                      {"color": "green", "value": -85}]}},
                    ]}]),
        verlauf("Schwankung der Empfangsstärke",
                nach_geraet("rssi", "stddev"), 12, 10, w=12, h=10, einheit="dBm",
                legende=NACH_GERAET,
                beschreibung="Wie stark der Pegel innerhalb eines Zeitfensters "
                             "schwankt. Große Werte deuten auf Reflexionen oder "
                             "ein wanderndes Gerät hin."),
    ]
    return dashboard(
        "asksin-funkqualitaet", "AskSin — Funkqualität",
        "Wer wird wie gut gehört — und wo lohnt ein Repeater.",
        p, [var_bucket(), var_standort()], zeitraum="now-24h")


def dutycycle() -> dict:
    p = [
        kennzahl("Geräte über der Schwelle", flux(
            '  |> filter(fn: (r) => r._measurement == "analyzer")\n'
            '  |> filter(fn: (r) => r._field == "dutyAlarme")\n'
            '  |> filter(fn: (r) => contains(value: r.standort, set: ${standort:json}))\n'
            '  |> group()\n'
            '  |> last()'),
            0, 0, w=8,
            beschreibung=f"Wie viele Geräte gerade über {DUTY_WARNUNG} % liegen.",
            schwellen=[{"color": "green", "value": None},
                       {"color": "red", "value": 1}]),
        kennzahl("Höchster Duty-Cycle", flux(
            '  |> filter(fn: (r) => r._measurement == "analyzer")\n'
            '  |> filter(fn: (r) => r._field == "maxDutyCycle")\n'
            '  |> filter(fn: (r) => contains(value: r.standort, set: ${standort:json}))\n'
            '  |> group()\n'
            '  |> last()'),
            8, 0, w=8, einheit="percent",
            schwellen=[{"color": "green", "value": None},
                       {"color": "orange", "value": DUTY_WARNUNG},
                       {"color": "red", "value": 100}]),
        kennzahl("Spitzenwert im Zeitraum", flux(
            '  |> filter(fn: (r) => r._measurement == "analyzer")\n'
            '  |> filter(fn: (r) => r._field == "maxDutyCycle")\n'
            '  |> filter(fn: (r) => contains(value: r.standort, set: ${standort:json}))\n'
            '  |> group()\n'
            '  |> max()'),
            16, 0, w=8, einheit="percent",
            beschreibung="Auch ein kurzer Ausreißer zählt — er kann das Funknetz "
                         "für Minuten blockiert haben."),
        verlauf("Duty-Cycle je Gerät", nach_geraet("dutyCycle", "max"),
                0, 4, w=24, h=10, einheit="percent", min_=0, legende=NUR_GERAET,
                beschreibung=f"Linien bei {DUTY_WARNUNG} % und 100 %. Ein "
                             "einziges defektes Gerät kann das Funknetz "
                             "zustopfen — so fällt es auf.",
                schwellen=[{"color": "green", "value": None},
                           {"color": "orange", "value": DUTY_WARNUNG},
                           {"color": "red", "value": 100}]),
        tabelle("Die lautesten Geräte", letzter_wert_je_geraet("dutyCycle"),
                0, 14, w=24, h=10,
                beschreibung="Jüngster Wert je Gerät, das lauteste zuerst.",
                sortierung={"displayName": "_value", "desc": True},
                overrides=[{
                    "matcher": {"id": "byName", "options": "_value"},
                    "properties": [
                        {"id": "displayName", "value": "Duty-Cycle"},
                        {"id": "unit", "value": "percent"},
                        {"id": "custom.cellOptions",
                         "value": {"type": "gauge", "mode": "gradient"}},
                        {"id": "max", "value": 100},
                        {"id": "thresholds", "value": {
                            "mode": "absolute",
                            "steps": [{"color": "green", "value": None},
                                      {"color": "orange", "value": DUTY_WARNUNG},
                                      {"color": "red", "value": 100}]}},
                    ]}]),
    ]
    return dashboard(
        "asksin-dutycycle", "AskSin — Duty-Cycle-Wächter",
        "Wer sendet zu viel — und seit wann.",
        p, [var_bucket(), var_standort()], zeitraum="now-24h")


def geraetedetail() -> dict:
    def fuer_geraet(feld: str, fn: str = "mean") -> str:
        return flux(
            '  |> filter(fn: (r) => r._measurement == "geraet")\n'
            f'  |> filter(fn: (r) => r._field == "{feld}")\n'
            '  |> filter(fn: (r) => r.name == "${geraet}")\n'
            f'  |> aggregateWindow(every: v.windowPeriod, fn: {fn}, createEmpty: false)\n'
            '  |> keep(columns: ["_time", "_value", "standort"])')

    p = [
        kennzahl("Zuletzt gehört vor", flux(
            '  |> filter(fn: (r) => r._measurement == "geraet")\n'
            '  |> filter(fn: (r) => r._field == "sekundenSeitEmpfang")\n'
            '  |> filter(fn: (r) => r.name == "${geraet}")\n'
            '  |> group()\n'
            '  |> last()'),
            0, 0, w=8, einheit="s",
            beschreibung="Kleinster Wert über alle Standorte wäre genauer; hier "
                         "steht der zuletzt geschriebene.",
            schwellen=[{"color": "green", "value": None},
                       {"color": "orange", "value": STUMM_WARNUNG},
                       {"color": "red", "value": STUMM_ALARM}]),
        kennzahl("Duty-Cycle", fuer_geraet("dutyCycle", "last"), 8, 0, w=8,
                 einheit="percent",
                 schwellen=[{"color": "green", "value": None},
                            {"color": "orange", "value": DUTY_WARNUNG},
                            {"color": "red", "value": 100}]),
        kennzahl("Empfangsstärke", fuer_geraet("rssi", "last"), 16, 0, w=8,
                 einheit="dBm",
                 schwellen=[{"color": "red", "value": None},
                            {"color": "orange", "value": RSSI_SCHWACH},
                            {"color": "green", "value": -85}]),
        verlauf("Empfangsstärke je Standort", fuer_geraet("rssi"), 0, 4, w=24,
                h=9, einheit="dBm",
                beschreibung="Eine Linie je Analyzer. Damit sieht man sofort, "
                             "welcher Standort dieses Gerät am besten hört — "
                             "die Funkloch-Karte als Verlauf.",
                schwellen=[{"color": "green", "value": None},
                           {"color": "red", "value": RSSI_SCHWACH}]),
        verlauf("Duty-Cycle", fuer_geraet("dutyCycle", "max"), 0, 13, einheit="percent",
                min_=0,
                schwellen=[{"color": "green", "value": None},
                           {"color": "orange", "value": DUTY_WARNUNG}]),
        verlauf("Telegramme pro Zeitfenster", flux(
            '  |> filter(fn: (r) => r._measurement == "geraet")\n'
            '  |> filter(fn: (r) => r._field == "telegramme")\n'
            '  |> filter(fn: (r) => r.name == "${geraet}")\n'
            '  |> group(columns: ["standort"])\n'
            '  |> aggregateWindow(every: v.windowPeriod, fn: max, createEmpty: false)\n'
            # difference() statt des rohen Zaehlers: Der faengt bei jedem
            # Dienststart wieder bei null an. nonNegative schluckt genau
            # diesen Ruecksetzer, statt einen Ausschlag nach unten zu zeigen.
            '  |> difference(nonNegative: true)\n'
            '  |> keep(columns: ["_time", "_value", "standort"])'),
            12, 13,
            beschreibung="Aus dem laufenden Zähler gebildet. Der Rücksetzer "
                         "beim Dienststart wird verschluckt, nicht als "
                         "Einbruch gezeigt."),
    ]
    return dashboard(
        "asksin-geraet", "AskSin — Gerätedetail",
        "Ein Gerät im Detail, über alle Standorte hinweg.",
        p, [var_bucket(), var_geraet()], zeitraum="now-24h")


def stoerungen() -> dict:
    p = [
        verlauf("Grundrauschen", nach_standort("analyzer", "grundrauschen"),
                0, 0, w=24, h=10, einheit="dBm",
                beschreibung="Der wichtigste Wert dieser Seite. Steigt er zu "
                             "bestimmten Tageszeiten, ist ein Störer im Haus "
                             "aktiv — Schaltnetzteile und Ladegeräte sind die "
                             "häufigsten Kandidaten."),
        {
            "type": "heatmap",
            "title": "Grundrauschen nach Tageszeit",
            "description": "Dieselben Daten, nach Stunde gestapelt. Ein "
                           "senkrechtes Muster verrät einen Störer, der immer "
                           "zur selben Zeit läuft.",
            "datasource": DS,
            "gridPos": {"x": 0, "y": 10, "w": 24, "h": 10},
            "targets": [{"refId": "A", "query": flux(
                '  |> filter(fn: (r) => r._measurement == "analyzer")\n'
                '  |> filter(fn: (r) => r._field == "grundrauschen")\n'
                '  |> filter(fn: (r) => contains(value: r.standort, set: ${standort:json}))\n'
                '  |> aggregateWindow(every: 1h, fn: mean, createEmpty: false)\n'
                '  |> keep(columns: ["_time", "_value"])')}],
            "options": {"calculate": True,
                        "color": {"mode": "scheme", "scheme": "Turbo"}},
            "fieldConfig": {"defaults": {"unit": "dBm"}, "overrides": []},
        },
        verlauf("Telegramme pro Minute zum Vergleich",
                nach_standort("analyzer", "telegrammeProMinute"), 0, 20, w=24, h=8,
                beschreibung="Steigt das Rauschen und fallen gleichzeitig die "
                             "Telegramme, gehen Nachrichten im Störer unter."),
    ]
    return dashboard(
        "asksin-stoerungen", "AskSin — Störungssuche",
        "Grundrauschen im Tagesverlauf: Störer finden, die sonst niemandem auffallen.",
        p, [var_bucket(), var_standort()], zeitraum="now-7d", takt="5m")


def batterie() -> dict:
    p = [
        kennzahl("Seit über 24 h stumm", flux(
            '  |> filter(fn: (r) => r._measurement == "geraet")\n'
            '  |> filter(fn: (r) => r._field == "sekundenSeitEmpfang")\n'
            '  |> filter(fn: (r) => contains(value: r.standort, set: ${standort:json}))\n'
            '  |> group(columns: ["name"])\n'
            '  |> last()\n'
            '  |> group()\n'
            f'  |> filter(fn: (r) => r._value > {STUMM_ALARM})\n'
            '  |> count()'),
            0, 0, w=8,
            beschreibung="Jedes dieser Geräte hat vermutlich eine leere "
                         "Batterie — oder ist ausgefallen.",
            schwellen=[{"color": "green", "value": None},
                       {"color": "red", "value": 1}]),
        kennzahl("Seit über 6 h stumm", flux(
            '  |> filter(fn: (r) => r._measurement == "geraet")\n'
            '  |> filter(fn: (r) => r._field == "sekundenSeitEmpfang")\n'
            '  |> filter(fn: (r) => contains(value: r.standort, set: ${standort:json}))\n'
            '  |> group(columns: ["name"])\n'
            '  |> last()\n'
            '  |> group()\n'
            f'  |> filter(fn: (r) => r._value > {STUMM_WARNUNG})\n'
            '  |> count()'),
            8, 0, w=8,
            beschreibung="Noch kein Alarm: Manche Geräte melden sich nur alle "
                         "paar Stunden.",
            schwellen=[{"color": "green", "value": None},
                       {"color": "orange", "value": 1}]),
        kennzahl("Bekannte Geräte", flux(
            '  |> filter(fn: (r) => r._measurement == "analyzer")\n'
            '  |> filter(fn: (r) => r._field == "geraete")\n'
            '  |> filter(fn: (r) => contains(value: r.standort, set: ${standort:json}))\n'
            '  |> group()\n'
            '  |> last()'),
            16, 0, w=8),
        tabelle("Zuletzt gehört", flux(
            '  |> filter(fn: (r) => r._measurement == "geraet")\n'
            '  |> filter(fn: (r) => r._field == "sekundenSeitEmpfang")\n'
            '  |> filter(fn: (r) => contains(value: r.standort, set: ${standort:json}))\n'
            # Ueber die Standorte das MINIMUM: Hat auch nur ein Analyzer das
            # Geraet kuerzlich gehoert, lebt es. Das Maximum wuerde ein Geraet
            # als tot melden, sobald ein einzelner Standort es nicht empfaengt.
            '  |> group(columns: ["standort", "name"])\n'
            '  |> last()\n'
            '  |> group(columns: ["name"])\n'
            '  |> min()\n'
            '  |> group()\n'
            '  |> keep(columns: ["name", "_value"])'),
            0, 4, w=24, h=14,
            beschreibung="Was oben steht, ist verdächtig. Über mehrere "
                         "Standorte zählt der kürzeste Abstand — hat auch nur "
                         "ein Analyzer das Gerät gehört, lebt es.",
            sortierung={"displayName": "_value", "desc": True},
            overrides=[{
                "matcher": {"id": "byName", "options": "_value"},
                "properties": [
                    {"id": "displayName", "value": "zuletzt gehört vor"},
                    {"id": "unit", "value": "s"},
                    {"id": "custom.cellOptions",
                     "value": {"type": "color-background"}},
                    {"id": "thresholds", "value": {
                        "mode": "absolute",
                        "steps": [{"color": "green", "value": None},
                                  {"color": "orange", "value": STUMM_WARNUNG},
                                  {"color": "red", "value": STUMM_ALARM}]}},
                ]}]),
        verlauf("Zahl der Geräte", nach_standort("analyzer", "geraete", "max"),
                0, 18, w=24, h=8,
                beschreibung="Ein Knick nach unten heißt: Etwas ist verstummt."),
    ]
    return dashboard(
        "asksin-batterie", "AskSin — Batterie- und Ausfallwächter",
        "Welches Gerät schweigt — und seit wann.",
        p, [var_bucket(), var_standort()], zeitraum="now-7d", takt="5m")


def verbund() -> dict:
    p = [
        zustandsband("Verbindung je Standort",
                     nach_standort("analyzer", "connected", "last"), 0, 0,
                     beschreibung="Jede rote Lücke ist ein Ausfall.",
                     abbildung=[{"type": "value", "options": {
                         "true": {"text": "verbunden", "color": "green", "index": 0},
                         "false": {"text": "getrennt", "color": "red", "index": 1}}}]),
        tabelle("Empfangsmatrix: Gerät × Standort", flux(
            '  |> filter(fn: (r) => r._measurement == "geraet")\n'
            '  |> filter(fn: (r) => r._field == "rssi")\n'
            '  |> group(columns: ["standort", "name"])\n'
            '  |> last()\n'
            '  |> group()\n'
            '  |> keep(columns: ["name", "standort", "_value"])\n'
            # Ein Standort je Spalte — so wird die Tabelle zur Funkloch-Karte.
            '  |> pivot(rowKey: ["name"], columnKey: ["standort"], valueColumn: "_value")'),
            0, 6, w=24, h=14,
            beschreibung="Eine Spalte je Analyzer, eine Zeile je Gerät, "
                         "darin die Empfangsstärke. Leere Zelle heißt: Dieser "
                         "Standort hört das Gerät gar nicht.",
            overrides=[{
                "matcher": {"id": "byType", "options": "number"},
                "properties": [
                    {"id": "unit", "value": "dBm"},
                    {"id": "custom.cellOptions",
                     "value": {"type": "color-background"}},
                    {"id": "thresholds", "value": {
                        "mode": "absolute",
                        "steps": [{"color": "red", "value": None},
                                  {"color": "orange", "value": RSSI_SCHWACH},
                                  {"color": "green", "value": -85}]}},
                ]}]),
        verlauf("Telegramme pro Minute", nach_standort("analyzer", "telegrammeProMinute"),
                0, 20, beschreibung="Wer hört am meisten?"),
        verlauf("Grundrauschen", nach_standort("analyzer", "grundrauschen"),
                12, 20, einheit="dBm",
                beschreibung="Ein Standort mit deutlich höherem Rauschen steht "
                             "zu nah an einem Störer."),
    ]
    return dashboard(
        "asksin-verbund", "AskSin — Verbund-Vergleich",
        "Alle Analyzer nebeneinander, mit der Empfangsmatrix als Funkloch-Karte.",
        p, [var_bucket(), var_standort()], zeitraum="now-24h")


def geraetezustand() -> dict:
    """Die Hardware selbst — aus der Absturzsuche im Juli 2026 gelernt."""
    p = [
        verlauf("Temperatur", nach_standort("system", "tempC"), 0, 0,
                einheit="celsius",
                beschreibung="Ab etwa 80 °C drosselt der Pi seine Rechenleistung.",
                schwellen=[{"color": "green", "value": None},
                           {"color": "orange", "value": 70},
                           {"color": "red", "value": 80}]),
        verlauf("Lüfterdrehzahl", nach_standort("system", "luefterUpm"), 12, 0,
                einheit="rotrpm",
                beschreibung="Fehlt die Kurve, hat das Gerät keinen Lüfter. "
                             "Fällt sie auf null, während die Temperatur "
                             "steigt, ist der Lüfter defekt."),
        verlauf("Systemlast", nach_standort("system", "cpuLast"), 0, 8,
                beschreibung="Ein Wert dauerhaft über der Zahl der Kerne heißt: "
                             "Der Rechner kommt nicht hinterher."),
        verlauf("Freier Arbeitsspeicher", nach_standort("system", "ramFreiProzent"),
                12, 8, einheit="percent", min_=0, max_=100,
                schwellen=[{"color": "red", "value": None},
                           {"color": "orange", "value": 10},
                           {"color": "green", "value": 20}]),
        verlauf("Freier Plattenplatz", nach_standort("system", "diskFreiProzent"),
                0, 16, w=24, h=8, einheit="percent", min_=0, max_=100,
                beschreibung="Mit InfluxDB auf demselben Gerät lohnt der Blick "
                             "hierher. Unter 10 % wird es kritisch.",
                schwellen=[{"color": "red", "value": None},
                           {"color": "orange", "value": 10},
                           {"color": "green", "value": 20}]),
    ]
    return dashboard(
        "asksin-geraetezustand", "AskSin — Gerätezustand",
        "Temperatur, Lüfter, Last, Speicher und Platte der Analyzer selbst.",
        p, [var_bucket(), var_standort()], zeitraum="now-24h")


ALLE = {
    "leitstand": leitstand,
    "funkqualitaet": funkqualitaet,
    "dutycycle": dutycycle,
    "geraetedetail": geraetedetail,
    "stoerungen": stoerungen,
    "batterie": batterie,
    "verbund": verbund,
    "geraetezustand": geraetezustand,
}


def pruefe_provisionierung() -> list[str]:
    """Prueft die Provisionierungsdateien, soweit PyYAML vorhanden ist.

    Ein Syntaxfehler in der Alarmdatei bedeutet schlicht: keine Alarme. Das
    faellt sonst erst auf, wenn man sie braucht — also nie zur rechten Zeit.
    Fehlt PyYAML (Raspberry Pi OS bringt es nicht mit), wird die Pruefung
    uebersprungen statt zu scheitern; sie ist ein Zusatz, keine Voraussetzung.
    """
    try:
        import yaml  # noqa: PLC0415 — bewusst optional
    except ImportError:
        print("  (PyYAML fehlt — Provisionierung nicht geprueft)")
        return []

    fehler: list[str] = []
    for datei in sorted((HIER / "provisioning").rglob("*.yaml*")):
        roh = datei.read_text(encoding="utf8")
        for platzhalter in ("__URL__", "__ORG__", "__BUCKET__", "__TOKEN__"):
            roh = roh.replace(platzhalter, "platzhalter")
        try:
            inhalt = yaml.safe_load(roh)
        except yaml.YAMLError as e:
            fehler.append(f"{datei.name}: {e}")
            continue
        for gruppe in (inhalt or {}).get("groups", []):
            for regel in gruppe["rules"]:
                refs = {stufe["refId"] for stufe in regel["data"]}
                # Zeigt condition auf eine Stufe, die es nicht gibt, laedt
                # Grafana die Regel wortlos nicht.
                if regel["condition"] not in refs:
                    fehler.append(
                        f"{regel['uid']}: Bedingung {regel['condition']} "
                        f"kommt in den Stufen nicht vor")
                for stufe in regel["data"]:
                    if stufe["datasourceUid"] not in ("__expr__", DS["uid"]):
                        fehler.append(
                            f"{regel['uid']}: unbekannte Datenquelle "
                            f"{stufe['datasourceUid']}")
    return fehler


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--pruefen", action="store_true",
                    help="nur bauen und prüfen, nichts schreiben")
    args = ap.parse_args()

    ZIEL.mkdir(exist_ok=True)
    uids: set[str] = set()
    fehler: list[str] = []

    for name, bauen in ALLE.items():
        d = bauen()
        # Zwei Dashboards mit derselben uid ueberschreiben einander beim
        # Provisionieren — dann fehlt eines wortlos.
        if d["uid"] in uids:
            fehler.append(f"{name}: uid {d['uid']} doppelt")
        uids.add(d["uid"])
        # Ueberlappende Panels sind in Grafana erlaubt, sehen aber kaputt aus.
        belegt: set[tuple[int, int]] = set()
        for panel in d["panels"]:
            # Ein Diagramm ohne Anzeigenamen beschriftet seine Linien mit dem
            # ganzen Etikettensatz — {name="…", standort="…"}. Korrekt, aber
            # unlesbar, und bei zwanzig Geraeten fuellt es den halben
            # Bildschirm.
            if panel["type"] in ("timeseries", "state-timeline") and \
               "displayName" not in panel["fieldConfig"]["defaults"]:
                fehler.append(f"{name}/{panel.get('title')}: ohne Anzeigenamen")
            g = panel["gridPos"]
            if g["x"] + g["w"] > 24:
                fehler.append(f"{name}/{panel.get('title')}: ragt über 24 Spalten")
            for zx in range(g["x"], g["x"] + g["w"]):
                for zy in range(g["y"], g["y"] + g["h"]):
                    if (zx, zy) in belegt:
                        fehler.append(
                            f"{name}/{panel.get('title')}: überlappt bei ({zx},{zy})")
                        break
                    belegt.add((zx, zy))
        text = json.dumps(d, indent=2, ensure_ascii=False) + "\n"
        if not args.pruefen:
            (ZIEL / f"{name}.json").write_text(text, encoding="utf8")
        print(f"  {name:16s} {len(d['panels']):2d} Panels, uid {d['uid']}")

    fehler += pruefe_provisionierung()

    if fehler:
        print(f"\n{len(fehler)} Problem(e):", file=sys.stderr)
        for f in fehler:
            print(f"  - {f}", file=sys.stderr)
        return 1

    print(f"\n{len(ALLE)} Vorlagen in Ordnung"
          + ("" if args.pruefen else f", geschrieben nach {ZIEL}"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
