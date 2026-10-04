import { eeDaReportLines } from '../../read/eeDa.js';
import { epochReportLines } from '../../read/epoch.js';
import Chart from 'chart.js/auto';
import type { ChartDataset, ChartOptions, Plugin } from 'chart.js';
import { Tooltip } from 'bootstrap';
import type { NetworkConfig } from '../../config/schema.js';
import type { Settlement } from '../../types.js';
import type { Evaluation, ModelId, ReplayRecord, Score } from '../evaluate.js';
import type { OutcomeEvent } from '../outcomes.js';
import { buildBurndown, type Burndown } from './burndown.js';
import { renderFeeStudy } from '../../fees/report/view.js';
import type { FeeStudy } from '../../fees/schema.js';

interface ReportData {
  feeStudy?: FeeStudy;
  records: ReplayRecord[]; evaluations: Evaluation[]; scores: Score[]; events: OutcomeEvent[];
  exhaustion: { wallet: string; height: number; [key: string]: unknown }[];
  training: Record<string, Settlement[]>;
  manifest: { network: string; fromHeight: number; toHeight: number; config: NetworkConfig };
}
interface PlotPoint { x: number; y: number | null; height?: number; event?: string }
type LineChart = Chart<'line', PlotPoint[]>;
const day = 86400000;
const names: Record<ModelId, string> = { current: 'Current runway algorithm', mean7: '7-day spending average', mean30: '30-day spending average' };
const roles: Record<string, string> = { ee: 'Execution environment', ol: 'Orchestration layer' };
const eventNames: Record<string, string> = { deposit: 'Funding received', consolidation: 'Consolidation', unrelated_spend: 'Other spending', unresolved: 'Incomplete reveal package', ambiguous: 'Unclassified transaction' };
const reasons: Record<string, string> = { no_spendable_funds: 'No spendable funds', insufficient_settlements: 'Not enough settlements', future_coverage_incomplete: 'Future period not fully recorded', incomplete_reveal_package: 'Reveal package incomplete', ambiguous_transaction: 'Unclassified transaction', history_incomplete: 'History incomplete', discovery_incomplete: 'Address discovery incomplete', cadence_unavailable: 'Posting cadence unavailable', available: 'Available' };
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const value = (id: string) => el<HTMLSelectElement>(id).value;
const text = (id: string, content: string) => { el(id).textContent = content; };
const fmt = (v: number | null | undefined, digits = 0) => v === null || v === undefined ? '—' : new Intl.NumberFormat('en', { maximumFractionDigits: digits }).format(v);
const pct = (v: number | null) => v === null ? '—' : fmt(v * 100, 1) + '%';
const date = (time: number, year = false) => new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: '2-digit', month: 'short', ...(year ? { year: 'numeric' as const } : {}) }).format(time);
const timestamp = (time: number) => date(time, true) + ' · ' + new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(time) + ' UTC';
const cell = (row: HTMLTableRowElement, content: string, className?: string) => { const td = row.insertCell(); td.textContent = content; if (className) td.className = className; return td; };
const subline = (td: HTMLElement, content: string) => { const small = document.createElement('span'); small.className = 'secondary-line'; small.textContent = content; td.append(small); };
const emptyRow = (id: string, columns: number, message: string) => { const row = document.createElement('tr'), td = cell(row, message, 'empty-row'); td.colSpan = columns; el(id).append(row); };
const model = () => value('model') as ModelId;
let feeView: ReturnType<typeof renderFeeStudy> | undefined;
let data: ReportData, rows: ReplayRecord[] = [], position = 0, timer: ReturnType<typeof setInterval> | null = null;
let balanceChart: LineChart | undefined, accuracyChart: LineChart | undefined, burn: Burndown | undefined;

function axisOptions(from: number, to: number, yTitle: string): ChartOptions<'line'> {
  return {
    responsive: true, maintainAspectRatio: false, animation: false,
    interaction: { mode: 'nearest', intersect: false },
    layout: { padding: { top: 24, left: 0, right: 10 } },
    plugins: { legend: { display: false }, tooltip: { backgroundColor: '#193240', padding: 12, displayColors: true,
      callbacks: { title: items => timestamp(items[0]?.parsed.x ?? 0), label: item => {
        const point = item.raw as PlotPoint;
        return point.event ? point.event : item.dataset.label + ': ' + fmt(item.parsed.y) + ' sats';
      } } } },
    scales: {
      x: { type: 'linear', min: from, max: to, grid: { display: false }, border: { color: '#dce5eb' },
        afterBuildTicks: axis => {
          const target = (to - from) / day / (window.innerWidth < 600 ? 3 : 6);
          const step = ([1, 2, 3, 7, 14, 30, 60, 90, 180, 365].find(n => n >= target) ?? Math.ceil(target / 365) * 365) * day;
          const ticks = []; for (let t = Math.ceil(from / step) * step; t <= to; t += step) ticks.push({ value: t });
          axis.ticks = ticks;
        },
        title: { display: true, text: 'Date · UTC', color: '#7a8e9c', font: { size: 10 } },
        ticks: { maxTicksLimit: window.innerWidth < 600 ? 4 : 8, maxRotation: 0, color: '#6c8291', font: { size: 10 },
          callback: v => date(Number(v), to - from > 330 * day) } },
      y: { beginAtZero: true, min: 0, grid: { color: '#eaf0f3' }, border: { display: false },
        title: { display: true, text: yTitle, color: '#7a8e9c', font: { size: 10 } },
        ticks: { maxTicksLimit: 5, color: '#6c8291', font: { size: 10 }, callback: v => fmt(Number(v)) } }
    }
  };
}
const annotations: Plugin<'line'> = {
  id: 'replay-markers',
  beforeDatasetsDraw(chart) {
    if (!burn || burn.recordedThrough >= burn.to) return;
    const { ctx, chartArea, scales } = chart;
    const left = Math.max(chartArea.left, scales.x!.getPixelForValue(burn.recordedThrough));
    ctx.save(); ctx.fillStyle = '#f4f7fa'; ctx.fillRect(left, chartArea.top, chartArea.right - left, chartArea.height); ctx.restore();
  },
  afterDatasetsDraw(chart) {
    if (!burn) return;
    const { ctx, chartArea, scales } = chart;
    const line = (time: number, label: string, color: string, offset: number) => {
      if (time < burn!.from || time > burn!.to) return;
      const x = scales.x!.getPixelForValue(time);
      ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.setLineDash([3, 4]);
      ctx.beginPath(); ctx.moveTo(x, chartArea.top); ctx.lineTo(x, chartArea.bottom); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = color; ctx.font = '10px system-ui';
      ctx.fillText(label, Math.max(chartArea.left + 4, Math.min(x + 6, chartArea.right - ctx.measureText(label).width)), chartArea.top + offset); ctx.restore();
    };
    line(burn.origin, 'Forecast · ' + date(burn.origin), '#647f8e', 12);
    if (burn.recordedThrough < burn.to) line(burn.recordedThrough, 'Recorded data ends', '#97a7b3', 29);
    if (burn.depletion !== null) {
      const x = scales.x!.getPixelForValue(burn.depletion), y = scales.y!.getPixelForValue(0);
      const label = 'Projected zero · ' + date(burn.depletion);
      ctx.save(); ctx.fillStyle = '#087f72'; ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fill();
      ctx.font = '600 11px system-ui'; const w = ctx.measureText(label).width;
      const left = Math.max(chartArea.left + 4, Math.min(x - w / 2, chartArea.right - w - 4));
      ctx.fillStyle = '#ffffffed'; ctx.fillRect(left - 5, y - 30, w + 10, 20);
      ctx.fillStyle = '#087f72'; ctx.fillText(label, left, y - 16); ctx.restore();
    }
  }
};
function chart(previous: LineChart | undefined, id: string, datasets: ChartDataset<'line', PlotPoint[]>[], options: ChartOptions<'line'>, plugins: Plugin<'line'>[] = []): LineChart {
  if (previous) { previous.data.datasets = datasets; previous.options = options; previous.update('none'); return previous; }
  return new Chart<'line', PlotPoint[]>(el<HTMLCanvasElement>(id), { type: 'line', data: { datasets }, options, plugins });
}
function eventGroups() {
  const groups = new Map<string, { event: OutcomeEvent; count: number; fundingSats: number | null }>();
  for (const event of data.events.filter(e => e.wallet === value('wallet') && e.kind !== 'settlement' && e.height >= data.manifest.fromHeight && e.height <= data.manifest.toHeight)) {
    const key = event.height + ':' + event.kind, group = groups.get(key);
    if (group) {
      group.count++;
      group.fundingSats = group.fundingSats === null || event.fundingSats === undefined ? null : group.fundingSats + event.fundingSats;
    } else groups.set(key, { event, count: 1, fundingSats: event.fundingSats ?? null });
  }
  return [...groups.values()];
}
function eventLabel(event: OutcomeEvent, count: number, fundingSats: number | null) {
  return (eventNames[event.kind] ?? event.kind) + (fundingSats !== null ? ' · +' + fmt(fundingSats) + ' spendable sats' : '') + (count > 1 ? ' · ' + count + ' transactions' : '');
}
function renderBalance() {
  const selected = rows[position]!;
  burn = buildBurndown(rows, selected, model());
  const groups = eventGroups(), byHeight = new Map(rows.map(r => [r.snapshot.tip.height, r]));
  const eventPoints = groups.flatMap(({ event, count, fundingSats }) => {
    const r = byHeight.get(event.height), time = event.time * 1000;
    return r && time >= burn!.from && time <= burn!.to ? [{ x: time, y: r.snapshot.composition.spendableSats,
      event: eventLabel(event, count, fundingSats) }] : [];
  });
  balanceChart = chart(balanceChart, 'balanceChart', [
    { label: 'Recorded spendable balance', data: burn.actual, borderColor: '#344f68', backgroundColor: '#344f68', borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, stepped: 'before' },
    { label: names[model()] + ' projection', data: burn.projected, borderColor: '#087f72', backgroundColor: '#087f72', borderWidth: 2, borderDash: [7, 5], pointRadius: 3, pointHoverRadius: 6 },
    { label: 'Funding / wallet action', data: eventPoints, showLine: false, backgroundColor: '#bc8731', borderColor: '#fff', borderWidth: 2, pointRadius: 5, pointHoverRadius: 7 }
  ], axisOptions(burn.from, burn.to, 'Spendable balance · sats'), [annotations]);
  const f = selected.forecasts.find(f => f.model === model());
  text('balance', fmt(burn.balance)); text('daily', fmt(burn.dailySats, 1));
  const runway = burn.depletion === null ? null : (burn.depletion - burn.origin) / day;
  text('runway', runway === null ? 'Unavailable' : fmt(runway, 1) + ' days');
  text('runwayHelp', runway !== null ? 'at the selected model’s rate' : burn.dailySats === 0 ? 'zero estimated spending; no finite end date' : reasons[f?.reason ?? ''] ?? 'No eligible estimate');
  text('emptyDate', burn.depletion === null ? 'Unavailable' : date(burn.depletion));
  text('emptyTime', burn.depletion === null ? 'no finite depletion date' : new Date(burn.depletion).toISOString().slice(0,16).replace('T',' ') + ' UTC');
  text('burndownCaption', date(burn.from, true) + ' – ' + date(burn.to, true) + ' · ' +
    (burn.depletion !== null ? 'Projected zero: ' + timestamp(burn.depletion) + '. ' : 'A zero-balance date is unavailable for this forecast. ') +
    'Recorded balances end ' + timestamp(burn.recordedThrough) + '.');
  el('balanceChart').setAttribute('aria-label', (roles[value('wallet')] ?? value('wallet')) + ' balance burndown. ' + el('burndownCaption').textContent);
}
function renderBlock() {
  if (!rows.length) return;
  position = Math.max(0, Math.min(position, rows.length - 1));
  const r = rows[position]!, s = r.snapshot, c = s.composition;
  el<HTMLInputElement>('slider').value = String(position); el<HTMLInputElement>('height').value = String(s.tip.height);
  el<HTMLInputElement>('date').value = s.asOf.slice(0, 10);
  el<HTMLButtonElement>('prev').disabled = position === 0; el<HTMLButtonElement>('next').disabled = position === rows.length - 1;
  text('originLabel', 'Historical forecast at block ' + fmt(s.tip.height) + ' · ' + timestamp(Date.parse(s.asOf)));
  const ol = s.wallet === 'ol' ? s : data.records.find(row => row.snapshot.wallet === 'ol' && row.snapshot.tip.height === s.tip.height)?.snapshot;
  const ee = s.wallet === 'ee' ? s : data.records.find(row => row.snapshot.wallet === 'ee' && row.snapshot.tip.height === s.tip.height)?.snapshot;
  text('eeDaContext', eeDaReportLines(ee?.eeDaContext, s.tip).join('\n'));
  text('epochContext', epochReportLines(ol?.epochContext, s.tip).join('\n'));
  text('inputCount', '· ' + s.naiveRunway.sampleSize + ' complete settlements');
  el('inventory').replaceChildren();
  for (const [name, val] of [['Spendable balance', fmt(c.spendableSats) + ' sats'], ['Stranded outputs (≤ 546 sats)', fmt(c.strandedSats) + ' sats'], ['Largest spendable output', fmt(c.largestUtxoSats) + ' sats'],
    ['Unspent outputs', fmt(c.counts.total)], ['History coverage', s.naiveRunway.historyComplete ? 'Complete' : 'Incomplete'], ['Address discovery', s.ceilingHit.receive || s.ceilingHit.change ? 'Ceiling reached · lower bounds only' : 'Complete within configured gap scan']] as const) {
    const tr = document.createElement('tr'); cell(tr, name); cell(tr, val); el('inventory').append(tr);
  }
  feeView?.selectAt(Date.parse(s.asOf) / 1000);
  const quote = s.feeContext;
  text('fee', quote?.status === 'available' ? 'Fee recommendation observed ' + timestamp(Date.parse(quote.observedAt)) + ': ' + quote.rates!.fastestFee + ' sat/vB. Informational only.' : 'Fee recommendation: no historical quote available at this block.');
  el('training').replaceChildren();
  const training = data.training[r.trainingRef] ?? [];
  for (const settlement of [...training].reverse()) {
    const tr = document.createElement('tr'); cell(tr, date(settlement.blockTime * 1000)); cell(tr, fmt(settlement.drainSats));
    cell(tr, settlement.complete ? 'Complete' : 'Reveal pending'); const tx = cell(tr, settlement.txid.slice(0, 12) + '…'); tx.title = settlement.txid; el('training').append(tr);
  }
  if (!training.length) emptyRow('training', 4, 'No settlement samples at this block.');
  text('trainingHelp', 'Costs include commit/reveal fees and newly stranded outputs. Newest commits appear first. Current model uses eligible 7-/30-day medians; averages use their full windows.');
  const ex = data.exhaustion.find(e => e.wallet === s.wallet && e.height === s.tip.height);
  text('exhaustion', ex ? JSON.stringify(ex, null, 2) : 'This block is not a daily forecast origin. Select a row in Largest forecast errors to inspect the corresponding diagnostic.');
  renderBalance();
}
function goHeight(height: number, scroll = false) {
  if (!Number.isFinite(height)) return;
  const i = rows.findIndex(r => r.snapshot.tip.height >= height); position = i < 0 ? rows.length - 1 : i; renderBlock();
  if (scroll) { el('burndownTitle').focus({ preventScroll: true }); el('burndown').scrollIntoView({ block: 'start', behavior: 'instant' }); }
}
function stop() { if (timer) clearInterval(timer); timer = null; text('play', 'Play'); el('play').setAttribute('aria-pressed', 'false'); }
function selections() { return { wallet: value('wallet'), horizon: Number(value('horizon')), subset: value('subset'), sampling: value('sampling') }; }
function evaluations(allModels = false) {
  const s = selections();
  return data.evaluations.filter(e => e.wallet === s.wallet && (allModels || e.model === model()) && e.horizonDays === s.horizon && (s.subset === 'all' || e.clean) && (s.sampling === 'daily' || e.nonOverlapping));
}
function renderEvents() {
  const groups = eventGroups(); text('eventCount', '· ' + groups.reduce((s, g) => s + g.count, 0) + ' transactions');
  el('events').replaceChildren();
  for (const { event, count, fundingSats } of groups.reverse()) {
    const button = document.createElement('button'); button.className = 'list-group-item list-group-item-action'; button.type = 'button';
    button.textContent = eventLabel(event, count, fundingSats);
    const when = document.createElement('span'); when.className = 'event-date'; when.textContent = timestamp(event.time * 1000) + ' · block ' + event.height; button.append(when);
    button.onclick = () => { stop(); goHeight(event.height, true); }; el('events').append(button);
  }
  if (!groups.length) text('events', 'No funding or other wallet actions in this replay range.');
}
function renderErrors() {
  const es = evaluations(true), eligible = new Map<number, Set<string>>();
  for (const e of es) if (e.errorSats !== null) { const set = eligible.get(e.height) ?? new Set<string>(); set.add(e.model); eligible.set(e.height, set); }
  const scorable = es.filter(e => e.model === model() && e.errorSats !== null && eligible.get(e.height)?.size === 3);
  const ordered = [...scorable].sort((a, b) => value('sort') === 'absolute' ? Math.abs(b.errorSats!) - Math.abs(a.errorSats!) : a.errorSats! - b.errorSats!);
  const shown = ordered.slice(0, 15), horizon = Number(value('horizon'));
  text('errorsDescription', names[model()] + ' · Each row compares predicted settlement spending with actual spending over the next ' + horizon + (horizon === 1 ? ' day. ' : ' days. ') + '“Too low” means the wallet spent more than predicted. Select a forecast to inspect its balance burndown.');
  el('worst').replaceChildren();
  for (const e of shown) {
    const tr = document.createElement('tr'), first = cell(tr, '');
    const button = document.createElement('button'); button.type = 'button'; button.className = 'btn btn-link';
    button.textContent = date(e.time * 1000, true); button.setAttribute('aria-label', 'Inspect forecast at block ' + e.height);
    button.onclick = () => { stop(); goHeight(e.height, true); }; first.append(button); subline(first, 'Block ' + e.height + ' · ' + new Date(e.time * 1000).toISOString().slice(11, 16));
    cell(tr, date(e.time * 1000) + ' → ' + date(e.time * 1000 + horizon * day));
    cell(tr, fmt(e.predictedSats)); cell(tr, fmt(e.actualSats));
    cell(tr, e.errorSats === 0 ? 'Exact' : fmt(Math.abs(e.errorSats!)) + ' sats too ' + (e.errorSats! < 0 ? 'low' : 'high'), e.errorSats! < 0 ? 'error-low' : 'error-high');
    cell(tr, e.clean ? 'None' : 'Present'); el('worst').append(tr);
  }
  if (!shown.length) emptyRow('worst', 6, 'No comparable forecasts for this selection.');
  text('errorsCount', 'Showing ' + shown.length + ' of ' + scorable.length + ' forecasts comparable across all three models.');
}
function renderAccuracy() {
  const s = selections(), scores = data.scores.filter(sc => sc.wallet === s.wallet && sc.horizonDays === s.horizon && sc.subset === s.subset && sc.sampling === s.sampling);
  const current = scores.find(sc => sc.model === model());
  text('accuracyDescription', 'All replayed dates · Alpen ' + s.wallet.toUpperCase() + ' · ' + names[model()] + ' · ' + s.horizon + '-day settlement spending');
  text('matched', fmt(current?.matched)); text('coverage', 'of ' + fmt(current?.origins) + ' forecast dates in this selection');
  text('mae', fmt(current?.maeSats)); text('under', pct(current?.underpredictionRate ?? null)); text('p90', fmt(current?.optimisticP90Sats));
  text('underCount', current?.underpredictionRate !== null && current?.underpredictionRate !== undefined ? fmt(Math.round(current.underpredictionRate * current.matched)) + ' of ' + current.matched + ' compared forecasts' : 'no comparable forecasts');
  el('scoreRows').replaceChildren(); el('missing').replaceChildren();
  for (const score of scores) {
    const tr = document.createElement('tr'); if (score.model === model()) tr.className = 'selected-model';
    const comparison = (skill: number | null, baseline: ModelId) => skill === null ? '—' : score.model === baseline ? 'Reference' : pct(Math.abs(skill)) + (skill >= 0 ? ' lower' : ' higher');
    for (const v of [names[score.model], fmt(score.available), fmt(score.matched), fmt(score.maeSats), fmt(score.biasSats), pct(score.underpredictionRate)]) cell(tr, v);
    const relative = cell(tr, '7-day: ' + comparison(score.skillVsMean7, 'mean7'));
    subline(relative, '30-day: ' + comparison(score.skillVsMean30, 'mean30'));
    el('scoreRows').append(tr);
    const missing = document.createElement('tr');
    for (const v of [names[score.model], fmt(score.origins), fmt(score.available), fmt(score.scorable), Object.entries(score.unavailableReasons).map(([r,n]) => (reasons[r] ?? r) + ': ' + n).join(' · ') || 'None']) cell(missing, v);
    el('missing').append(missing);
  }
  text('comparisonNote', 'Error and bias are in sats over the selected ' + s.horizon + '-day period, compared on the same dates for every model. Negative bias means spending was underestimated. Lower average error is better.');
  const es = evaluations(), from = es[0]?.time ? es[0].time * 1000 : Date.parse(rows[0]!.snapshot.asOf), to = Math.max(from + day, (es.at(-1)?.time ?? from / 1000) * 1000);
  accuracyChart = chart(accuracyChart, 'accuracyChart', [
    { label: 'Predicted settlement spending', data: es.map(e => ({ x: e.time * 1000, y: e.predictedSats })), borderColor: '#087f72', backgroundColor: '#087f72', borderDash: [6, 4], borderWidth: 2, pointRadius: 2, pointHoverRadius: 5, spanGaps: false },
    { label: 'Actual settlement spending', data: es.map(e => ({ x: e.time * 1000, y: e.actualSats })), borderColor: '#344f68', backgroundColor: '#344f68', borderWidth: 2, pointRadius: 2, pointHoverRadius: 5, spanGaps: false }
  ], axisOptions(from, to, s.horizon + '-day spending · sats'));
  text('accuracyRange', date(from, true) + ' – ' + date(to, true) + ' · ' + es.length + ' forecast dates. Gaps indicate unavailable predictions or incomplete future records.');
  const independent = data.scores.find(sc => sc.wallet === s.wallet && sc.model === model() && sc.horizonDays === s.horizon && sc.subset === 'clean' && sc.sampling === 'non_overlapping');
  text('sampleNote', 'For Alpen ' + s.wallet.toUpperCase() + ', this archive has ' + (independent?.matched ?? 0) + ' comparable ' + s.horizon + '-day forecasts with non-overlapping periods and no funding or wallet actions. Daily samples overlap and should not be treated as independent evidence.');
  renderErrors();
}
function selectWallet(initial = false) {
  stop(); const oldHeight = rows[position]?.snapshot.tip.height;
  rows = data.records.filter(r => r.snapshot.wallet === value('wallet'));
  if (!rows.length) throw new Error('Empty wallet replay');
  if (initial) position = rows.length - 1;
  else { const i = rows.findIndex(r => r.snapshot.tip.height >= (oldHeight ?? 0)); position = i < 0 ? rows.length - 1 : i; }
  el<HTMLInputElement>('slider').max = String(rows.length - 1);
  el<HTMLInputElement>('height').min = String(rows[0]!.snapshot.tip.height); el<HTMLInputElement>('height').max = String(rows.at(-1)!.snapshot.tip.height);
  el<HTMLInputElement>('date').min = rows[0]!.snapshot.asOf.slice(0, 10); el<HTMLInputElement>('date').max = rows.at(-1)!.snapshot.asOf.slice(0, 10);
  const role = roles[value('wallet')];
  text('walletName', 'Alpen ' + value('wallet').toUpperCase() + (role ? ' / ' + role : ''));
  text('walletDescription', (role ? role + ' checkpoint funding.' : 'Checkpoint funding wallet.') + ' Receive + change chains.');
  renderBlock(); renderEvents(); renderAccuracy();
}
async function start() {
  const packed = Uint8Array.from(atob(el('data').textContent ?? ''), c => c.charCodeAt(0));
  data = await new Response(new Blob([packed]).stream().pipeThrough(new DecompressionStream('gzip'))).json() as ReportData;
  if (!data.records.length) throw new Error('No replay records');
  Chart.defaults.font.family = 'system-ui, sans-serif'; Chart.defaults.color = '#687f8f';
  text('network', data.manifest.network + ' · historical replay');
  text('archiveRange', date(Date.parse(data.records[0]!.snapshot.asOf), true) + ' – ' + date(Date.parse(data.records.at(-1)!.snapshot.asOf), true));
  text('archiveBlocks', 'Blocks ' + fmt(data.manifest.fromHeight) + '–' + fmt(data.manifest.toHeight));
  text('archiveEnd', 'Last recorded: ' + timestamp(Date.parse(data.records.at(-1)!.snapshot.asOf)));
  for (const id of [...new Set(data.records.map(r => r.snapshot.wallet))]) {
    const option = document.createElement('option'); option.value = id;
    option.textContent = (data.manifest.config.wallets.find(w => w.id === id)?.display_name ?? id.toUpperCase()) + (roles[id] ? ' · ' + roles[id] : ''); el('wallet').append(option);
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-bs-toggle="tooltip"]')) {
    const tip = new Tooltip(button, { container: 'body', trigger: 'hover focus', animation: false });
    button.addEventListener('keydown', event => { if (event.key === 'Escape') { tip.hide(); button.blur(); } });
  }
  el('wallet').onchange = () => selectWallet();
  el('model').onchange = () => { stop(); renderBlock(); renderAccuracy(); };
  for (const id of ['horizon', 'subset', 'sampling']) el(id).onchange = renderAccuracy;
  el('sort').onchange = renderErrors;
  el('slider').oninput = () => { stop(); position = Number(value('slider')); renderBlock(); };
  el('prev').onclick = () => { stop(); position--; renderBlock(); }; el('next').onclick = () => { stop(); position++; renderBlock(); };
  el('jump').onclick = () => { stop(); if (value('height')) goHeight(Number(value('height'))); };
  el('height').onkeydown = event => { if (event.key === 'Enter') el('jump').click(); };
  el('dateJump').onclick = () => { const time = Date.parse(value('date') + 'T00:00:00Z'); if (!Number.isFinite(time)) return; stop(); const i = rows.findIndex(r => Date.parse(r.snapshot.asOf) >= time); position = i < 0 ? rows.length - 1 : i; renderBlock(); };
  el('latest').onclick = () => { stop(); position = rows.length - 1; renderBlock(); };
  el('play').onclick = () => { if (timer) stop(); else { text('play', 'Pause'); el('play').setAttribute('aria-pressed', 'true'); timer = setInterval(() => { if (position >= rows.length - 1) { stop(); return; } position++; renderBlock(); }, 600); } };
  if (data.feeStudy) feeView = renderFeeStudy(el('network-fees'), data.feeStudy);
  text('manifest', JSON.stringify(data.manifest, null, 2)); selectWallet(true);
}
void start().catch(() => { const error = el('loadError'); error.hidden = false; error.textContent = 'Unable to load this audit. Rebuild with pnpm replay report, then open it in a current browser with gzip support.'; });
