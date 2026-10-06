import { init, use, type EChartsType } from 'echarts/core';
import { LineChart, ScatterChart } from 'echarts/charts';
import { AriaComponent, DataZoomComponent, GridComponent, MarkAreaComponent, MarkLineComponent, ToolboxComponent, TooltipComponent } from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';
import type { EChartsOption } from 'echarts';
import type { Burndown } from './burndown.js';
import type { TransactionSummary } from '../../transactions.js';
import { feeLabel } from './transactions.js';

use([LineChart, ScatterChart, AriaComponent, DataZoomComponent, GridComponent, MarkAreaComponent, MarkLineComponent, ToolboxComponent, TooltipComponent, SVGRenderer]);
const fmt = (n: number, digits = 0) => new Intl.NumberFormat('en', { maximumFractionDigits: digits }).format(n);
const time = (n: number) => new Date(n).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
export interface TimelineRange { min: number; max: number }
interface TransactionPoint { value: [number, string]; txid: string; transactions: TransactionSummary[] }
const lanes = ['Wallet action', 'Reveal', 'Commit'];

/** Configure native ECharts components; no canvas drawing, tick placement or zoom calculations. */
export function timelineOptions(burn: Burndown, transactions: TransactionSummary[], first: number, range?: TimelineRange): EChartsOption {
  const last = Math.max(burn.to, burn.recordedThrough), groups = new Map<string, TransactionPoint>();
  for (const tx of transactions) {
    const lane = tx.kind === 'commit' ? 'Commit' : tx.kind === 'reveal' ? 'Reveal' : 'Wallet action';
    const key = tx.blockHash + ':' + lane, group = groups.get(key);
    if (group) group.transactions.push(tx);
    else groups.set(key, { value: [tx.time * 1000, lane], txid: tx.txid, transactions: [tx] });
  }
  const bounds = { min: first, max: last };
  const axis = { type: 'time' as const, ...bounds, axisLine: { lineStyle: { color: '#a4afbc' } }, axisLabel: { color: '#687f8f', hideOverlap: true }, splitLine: { show: false } };
  const selected = range ?? { min: burn.from, max: burn.to };
  const zoom = { xAxisIndex: [0, 1], filterMode: 'none' as const, minValueSpan: 3600000, startValue: selected.min, endValue: selected.max };
  return {
    animation: false, useUTC: true, textStyle: { fontFamily: 'system-ui, sans-serif', fontSize: 12, color: '#193240' },
    aria: { enabled: true, label: { description: 'Wallet funding balance, forecast and confirmed transactions. Drag the overview handles to change the time range. Individual transactions are also available in the list below.' } },
    grid: [{ left: 78, right: 25, top: 36, bottom: 205 }, { left: 78, right: 25, bottom: 102, height: 68 }],
    xAxis: [{ ...axis, gridIndex: 0, axisLabel: { show: false }, axisTick: { show: false } }, { ...axis, gridIndex: 1 }],
    yAxis: [{ type: 'value', name: 'Funding · sats', nameTextStyle: { color: '#687f8f', align: 'left' }, min: 0,
      axisLabel: { color: '#687f8f' }, splitLine: { lineStyle: { color: '#eaf0f3' } } },
    { type: 'category', gridIndex: 1, data: lanes, axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: '#687f8f', fontSize: 10 }, splitLine: { show: true, lineStyle: { color: '#f0f3f6' } } }],
    toolbox: { top: 0, right: 22, feature: { restore: { title: 'Reset timeline' } }, iconStyle: { borderColor: '#173c55' } },
    dataZoom: [
      { ...zoom, id: 'timeline-navigator', type: 'slider', bottom: 14, left: 78, right: 25, height: 42,
        showDataShadow: true, brushSelect: true, borderColor: '#dce5eb', backgroundColor: '#f6f8fa', fillerColor: '#173c5526',
        handleStyle: { color: '#173c55', borderColor: '#173c55' }, moveHandleStyle: { color: '#8399aa' },
        selectedDataBackground: { lineStyle: { color: '#344f68' }, areaStyle: { color: '#a4afbc' } },
        labelFormatter: value => new Date(value).toISOString().slice(0, 10) },
      { ...zoom, id: 'timeline-gestures', type: 'inside', zoomOnMouseWheel: 'ctrl', moveOnMouseMove: true, moveOnMouseWheel: false }
    ],
    tooltip: { trigger: 'item', confine: true, renderMode: 'richText', backgroundColor: '#193240', borderWidth: 0,
      textStyle: { color: '#fff', fontSize: 12 }, formatter: raw => {
        const p = Array.isArray(raw) ? raw[0]! : raw;
        const point = p.data as TransactionPoint | undefined;
        if (point?.transactions) return point.transactions.slice(0, 3).map(tx =>
          time(tx.time * 1000) + ' · ' + tx.kind + '\n' + fmt(tx.vsize) + ' vB · ' + fmt(tx.feeSats) + ' sats · ' + fmt(tx.feeRate, 3) + ' sat/vB\n' + feeLabel(tx)).join('\n\n') +
          (point.transactions.length > 3 ? '\n+' + (point.transactions.length - 3) + ' more transactions' : '') + '\nClick to inspect';
        const value = p.value as [number, number];
        return time(value[0]) + '\n' + p.seriesName + ': ' + fmt(value[1]) + ' sats';
      } },
    series: [
      { id: 'funding', name: 'Funding balance', type: 'line', step: 'end', showSymbol: false, connectNulls: false,
        data: burn.actual.map(p => [p.x, p.y]), lineStyle: { color: '#344f68', width: 2 }, itemStyle: { color: '#344f68' },
        markLine: { silent: true, symbol: 'none', lineStyle: { color: '#8399aa', type: 'dashed' },
          label: { formatter: '{b}', position: 'insideEndTop', fontSize: 10, color: '#687f8f' },
          data: [{ name: 'Forecast origin', xAxis: burn.origin }, ...(burn.recordedThrough !== burn.origin ? [{ name: 'Recorded data ends', xAxis: burn.recordedThrough }] : [])] },
        markArea: { silent: true, itemStyle: { color: '#f4f7fa' }, data: [[{ xAxis: burn.recordedThrough }, { xAxis: last }]] } },
      { id: 'forecast', name: 'Forecast', type: 'line', showSymbol: true, symbolSize: 5, data: burn.projected.map(p => [p.x, p.y]),
        lineStyle: { color: '#173c55', type: 'dashed', width: 2 }, itemStyle: { color: '#173c55' } },
      ...lanes.map((lane, i) => ({ id: 'transactions-' + i, name: lane, type: 'scatter' as const, xAxisIndex: 1, yAxisIndex: 1,
        data: [...groups.values()].filter(p => p.value[1] === lane), symbol: ['diamond', 'triangle', 'roundRect'][i], symbolSize: 9,
        itemStyle: { color: ['#bc8731', '#7c719c', '#344f68'][i], opacity: 0.9 }, emphasis: { scale: 1.5 }, cursor: 'pointer' }))
    ]
  };
}

export class FundingTimeline {
  private chart: EChartsType;
  private viewport?: TimelineRange;
  private wallet?: string;
  constructor(element: HTMLElement, onInspect: (txid: string) => void, private onRange: (range: TimelineRange) => void) {
    this.chart = init(element, undefined, { renderer: 'svg' });
    this.chart.on('click', event => {
      const point = event.data as TransactionPoint | undefined;
      if (point?.txid) onInspect(point.txid);
    });
    this.chart.on('datazoom', () => { this.viewport = this.range(); this.onRange(this.viewport); });
    this.chart.on('restore', () => { this.viewport = undefined; this.onRange(this.range()); });
    new ResizeObserver(() => this.chart.resize()).observe(element);
  }
  render(wallet: string, burn: Burndown, transactions: TransactionSummary[], first: number): TimelineRange {
    if (wallet !== this.wallet) this.viewport = undefined;
    this.wallet = wallet;
    this.chart.setOption(timelineOptions(burn, transactions, first), { notMerge: true, silent: true });
    if (this.viewport) this.chart.dispatchAction({ type: 'dataZoom', startValue: this.viewport.min, endValue: this.viewport.max }, { silent: true });
    return this.range();
  }
  private range(): TimelineRange {
    const zoom = (this.chart.getOption().dataZoom as { startValue: number; endValue: number }[])[0]!;
    return { min: zoom.startValue, max: zoom.endValue };
  }
}
