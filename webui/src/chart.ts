/**
 * ECharts, gezielt tree-shaken: nur Linie, Punkte, Achsen, Tooltip, Legende.
 * (Apache-2.0 — Highcharts des Originals ist bewusst ersetzt, siehe
 * docs/webui-und-updates.md Abschnitt 4.)
 */

import * as echarts from 'echarts/core';
import { LineChart, ScatterChart } from 'echarts/charts';
import {
  GridComponent,
  LegendComponent,
  TooltipComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { EChartsCoreOption } from 'echarts/core';

echarts.use([
  LineChart,
  ScatterChart,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  CanvasRenderer,
]);

export { echarts };

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
