/**
 * ECharts, gezielt tree-shaken: nur Linie, Punkte, Achsen, Tooltip, Legende.
 * (Apache-2.0 — Highcharts des Originals ist bewusst ersetzt, siehe
 * docs/webui-und-updates.md Abschnitt 4.)
 */

import * as echarts from 'echarts/core';
import { LineChart, PieChart, ScatterChart } from 'echarts/charts';
import {
  GridComponent,
  LegendComponent,
  TooltipComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { EChartsCoreOption } from 'echarts/core';

echarts.use([
  LineChart,
  PieChart,
  ScatterChart,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  CanvasRenderer,
]);

export { echarts };

/** Ein Tortenstück: ein Gerät (oder die Sammelposition „Übrige"). */
export interface TortenStueck {
  name: string;
  /** Telegramme — bestimmt die Größe des Stücks. */
  value: number;
  /** Anteil in Prozent, vorgerechnet für den Tooltip. */
  anteil: number;
  address: string | null;
  rssi: number | null;
  dutyCycle: number | null;
}

/**
 * „Telegramme pro Gerät" wie auf der Startseite des Originals: volle Torte
 * links, daneben eine blätterbare Legende mit allen Geräten; die Daten des
 * Geräts erscheinen beim Überfahren als Tooltip.
 */
/**
 * Tortengrafik der Übersicht.
 *
 * Die Legende steht am Rechner **rechts** neben der Torte. Am Telefon ist dort
 * kein Platz — sie lag dann quer über der Grafik. ECharts löst das selbst,
 * wenn man die Option als `baseOption` + `media` aufbaut: Unterhalb von 560 px
 * rückt die Legende unter die Torte, die Torte wird kleiner und rutscht nach
 * oben. Die Regeln werden bei jedem `resize()` neu ausgewertet, und das ist
 * bereits an das Fenster gehängt — auch das Drehen des Geräts sitzt damit.
 */
export function tortenOption(stuecke: TortenStueck[]): EChartsCoreOption {
  return {
    baseOption: tortenBasis(stuecke),
    media: [
      {
        query: { maxWidth: 560 },
        option: {
          legend: {
            orient: 'horizontal',
            right: 'center',
            left: 'center',
            top: 'auto',
            bottom: 0,
          },
          series: [{ radius: '55%', center: ['50%', '38%'] }],
        },
      },
    ],
  };
}

function tortenBasis(stuecke: TortenStueck[]): EChartsCoreOption {
  return {
    animation: false,
    backgroundColor: 'transparent',
    tooltip: {
      trigger: 'item',
      backgroundColor: '#1d2632',
      borderColor: '#27313f',
      textStyle: { color: '#dce5ef' },
      formatter: (p: unknown) => {
        const d = (p as { data: TortenStueck }).data;
        const zeilen = [
          `<strong>${d.name}</strong>`,
          `${d.value} Telegramme (${d.anteil.toFixed(1)} %)`,
        ];
        if (d.address !== null) zeilen.push(`Adresse ${d.address}`);
        if (d.rssi !== null) zeilen.push(`RSSI ${d.rssi} dBm`);
        if (d.dutyCycle !== null) zeilen.push(`Duty-Cycle ${d.dutyCycle.toFixed(1)} %`);
        return zeilen.join('<br/>');
      },
    },
    legend: {
      type: 'scroll',                      // ▲/▼-Blätterer wie im Original
      orient: 'vertical',
      right: 0,
      top: 'middle',
      icon: 'circle',
      textStyle: { color: '#8899ad' },
      pageIconColor: '#4cc2ff',
      pageIconInactiveColor: '#27313f',
      pageTextStyle: { color: '#8899ad' },
    },
    series: [
      {
        type: 'pie',
        radius: '72%',
        center: ['34%', '50%'],
        data: stuecke,
        label: { show: false },            // Namen stehen in der Legende
        itemStyle: { borderColor: '#0f1419', borderWidth: 1 },
        emphasis: {
          itemStyle: { shadowBlur: 8, shadowColor: 'rgba(0,0,0,0.4)' },
        },
      },
    ],
  };
}

/** Zeitchart der Übersicht: Grundrauschen (Minutenmittel) + Telegramm-RSSI. */
export function zeitChartOption(
  rauschen: Array<[number, number]>,
  telegramme: Array<[number, number]>,
): EChartsCoreOption {
  return {
    animation: false,
    backgroundColor: 'transparent',
    textStyle: { color: '#8899ad' },
    legend: {
      data: ['Grundrauschen', 'Telegramme'],
      textStyle: { color: '#8899ad' },
      top: 0,
    },
    tooltip: {
      trigger: 'axis',
      backgroundColor: '#1d2632',
      borderColor: '#27313f',
      textStyle: { color: '#dce5ef' },
      valueFormatter: (v: unknown) => `${String(v)} dBm`,
    },
    grid: { left: 48, right: 16, top: 32, bottom: 28 },
    xAxis: {
      type: 'time',
      axisLine: { lineStyle: { color: '#27313f' } },
      splitLine: { show: false },
    },
    yAxis: {
      type: 'value',
      name: 'dBm',
      scale: true,
      axisLine: { lineStyle: { color: '#27313f' } },
      splitLine: { lineStyle: { color: '#1d2632' } },
    },
    series: [
      {
        name: 'Grundrauschen',
        type: 'line',
        data: rauschen,
        showSymbol: false,
        lineStyle: { color: '#8899ad', width: 1.5 },
        itemStyle: { color: '#8899ad' },
      },
      {
        name: 'Telegramme',
        type: 'scatter',
        data: telegramme,
        symbolSize: 5,
        itemStyle: { color: '#4cc2ff' },
      },
    ],
  };
}
