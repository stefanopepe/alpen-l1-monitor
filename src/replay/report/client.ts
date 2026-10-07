import { eeDaReportLines } from '../../read/eeDa.js';
import { renderTransactionText } from '../../ui/explorer.js';
import { epochReportLines } from '../../read/epoch.js';
import Chart from 'chart.js/auto';
import { FundingTimeline, type TimelineRange } from './timeline.js';
import type { TransactionSummary } from '../../transactions.js';
import { TransactionInspector } from './transactions.js';
import type { ChartDataset, ChartOptions } from 'chart.js';
import { Tooltip } from 'bootstrap';
import type { NetworkConfig } from '../../config/schema.js';
import type { Settlement } from '../../types.js';
import type { Evaluation, ModelId, ReplayRecord, Score } from '../evaluate.js';
import type { OutcomeEvent } from '../outcomes.js';
import { buildBurndown, type Burndown } from './burndown.js';
import { renderFeeStudy } from '../../fees/report/view.js';
import type { FeeStudy } from '../../fees/schema.js';
import { mergeCollected, walletFresh, type LiveTimeMachine } from './live.js';

interface ReportData {
  transactions?: TransactionSummary[];
  feeStudy?: FeeStudy;
  records: ReplayRecord[]; evaluations: Evaluation[]; scores: Score[]; events: OutcomeEvent[];
  exhaustion: { wallet: string; height: number; [key: string]: unknown }[];
  training: Record<string, Settlement[]>;
  manifest: { network: string; archiveDigest?: string; fromHeight: number; toHeight: number; config: NetworkConfig };
}
interface PlotPoint { x: number; y: number | null; height?: number; event?: string; txid?: string }
type LineChart = Chart<'line', PlotPoint[]>;
const day = 86400000;
const names: Record<ModelId, string> = { current: 'Current runway algorithm', mean7: '7-day spending average', mean30: '30-day spending average' };
const roles: Record<string, string> = { ee: 'Execution environment', ol: 'Orchestration layer' };
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
let balanceChart: FundingTimeline, accuracyChart: LineChart | undefined, burn: Burndown | undefined;
const liveEndpoint = document.body.dataset.liveEndpoint;
let archiveRecords: ReplayRecord[] = [], archiveStudy: FeeStudy | undefined;
let staleAfterSeconds = 3300, loadingLive = false, liveReadAt: string | null = null;
let liveError = false, studyAsOf = 0;
let archiveTransactions: TransactionSummary[] = [], inspector: TransactionInspector;
const walletTransactions = () => (data.transactions ?? []).filter(t => t.wallet === value('wallet'));
function rangeChanged(range: TimelineRange) {
  text('visibleRange', timestamp(range.min) + ' – ' + timestamp(range.max));
  inspector?.setRange(range.min, range.max);
}

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
          const target = (axis.max - axis.min) / day / (window.innerWidth < 600 ? 3 : 6);
          const step = ([1/24, 3/24, 6/24, 0.5, 1, 2, 3, 7, 14, 30, 60, 90, 180, 365].find(n => n >= target) ?? Math.ceil(target / 365) * 365) * day;
          const ticks = []; for (let t = Math.ceil(axis.min / step) * step; t <= axis.max; t += step) ticks.push({ value: t });
          axis.ticks = ticks;
        },
        title: { display: true, text: 'Date · UTC', color: '#7a8e9c', font: { size: 10 } },
        ticks: { maxTicksLimit: window.innerWidth < 600 ? 4 : 8, maxRotation: 0, color: '#6c8291', font: { size: 10 },
          callback: function(v) { return this.max - this.min < 2 * day ? new Date(Number(v)).toISOString().slice(5, 16).replace('T', ' ') : date(Number(v), this.max - this.min > 330 * day); } } },
      y: { beginAtZero: true, min: 0, grid: { color: '#eaf0f3' }, border: { display: false },
        title: { display: true, text: yTitle, color: '#7a8e9c', font: { size: 10 } },
        ticks: { maxTicksLimit: 5, color: '#6c8291', font: { size: 10 }, callback: v => fmt(Number(v)) } }
    }
  };
}
function chart(previous: LineChart | undefined, id: string, datasets: ChartDataset<'line', PlotPoint[]>[], options: ChartOptions<'line'>): LineChart {
  if (previous) { previous.data.datasets = datasets; previous.options = options; previous.update('none'); return previous; }
  return new Chart<'line', PlotPoint[]>(el<HTMLCanvasElement>(id), { type: 'line', data: { datasets }, options });
}
function renderBalance() {
  const selected = rows[position]!;
  burn = buildBurndown(rows, selected, model());
  const stale = !!liveEndpoint && position === rows.length - 1 && !walletFresh(selected, staleAfterSeconds);
  if (stale) burn = { ...burn, dailySats: null, depletion: null, projected: [] };
  const transactions = walletTransactions();
  const range = balanceChart.render(value('wallet'), burn, transactions, Date.parse(rows[0]!.snapshot.asOf));
  inspector.update(transactions, range.min, range.max);
  rangeChanged(range);
  const f = selected.forecasts.find(f => f.model === model());
  text('balance', fmt(burn.balance)); text('daily', fmt(burn.dailySats, 1));
  text('balanceHelp', selected.collected ? 'sats · includes pending funds' : 'sats · confirmed-chain history');
  const runway = burn.depletion === null ? null : (burn.depletion - burn.origin) / day;
  text('runway', stale || runway === null ? 'Unavailable' : (runway > 0 && runway < 0.1 ? '<0.1' : fmt(runway, 1)) + ' days');
  text('runwayHelp', stale ? 'Latest observation is stale or unavailable' : runway !== null ? 'at the selected spending rate' : burn.dailySats === 0 ? 'zero estimated spending; no finite end date' : f?.reason === 'not_recorded' ? 'This alternative model was not recorded by the collector' : f?.reason === 'no_spendable_funds' && burn.balance > 0 ? 'Spending estimate unavailable during pending transaction' : reasons[f?.reason ?? ''] ?? 'No eligible estimate');
  text('emptyDate', burn.depletion === null ? 'Unavailable' : date(burn.depletion));
  text('emptyTime', burn.depletion === null ? 'no finite depletion date' : new Date(burn.depletion).toISOString().slice(0,16).replace('T',' ') + ' UTC');
  text('burndownCaption',
    (burn.depletion !== null ? 'Projected zero: ' + timestamp(burn.depletion) + '. ' : 'A zero-balance date is unavailable for this forecast. ') +
    'Recorded balances end ' + timestamp(burn.recordedThrough) + '.' + (selected.collected ? ' Collected samples; gaps over two hours are left blank.' : ''));
  if (!selected.collected) el('burndownCaption').textContent += ' Historical mempool balances were not recorded; this portion uses confirmed-chain balances.';
  el('balanceChart').setAttribute('aria-label', (roles[value('wallet')] ?? value('wallet')) + ' balance burndown. ' + el('burndownCaption').textContent);
}
function renderBlock() {
  if (!rows.length) return;
  position = Math.max(0, Math.min(position, rows.length - 1));
  const r = rows[position]!, s = r.snapshot, c = s.composition;
  el<HTMLInputElement>('slider').value = String(position); el<HTMLInputElement>('height').value = String(s.tip.height);
  el<HTMLInputElement>('date').value = s.asOf.slice(0, 10);
  el<HTMLButtonElement>('prev').disabled = position === 0; el<HTMLButtonElement>('next').disabled = position === rows.length - 1;
  const latest = !!liveEndpoint && position === rows.length - 1;
  text('originLabel', (latest ? 'Latest collected observation' : 'Historical forecast') + ' at block ' + fmt(s.tip.height) + ' · ' + timestamp(Date.parse(s.asOf)));
  if (liveEndpoint) {
    const last = rows.at(-1)!;
    const fresh = walletFresh(last, staleAfterSeconds);
    text('liveStatus', (fresh ? 'Current wallet data' : 'STALE / UNAVAILABLE · Current wallet estimates hidden') + ' · Last observation ' + timestamp(Date.parse(last.snapshot.asOf)) +
      (liveReadAt ? ' · Checked ' + timestamp(Date.parse(liveReadAt)) : ' · Connecting to monitor…') + (liveError ? ' · Latest update failed; retrying automatically.' : ''));
    el('liveStatus').classList.toggle('stale-data', !fresh || liveError);
  }
  const ol = s.wallet === 'ol' ? s : data.records.find(row => row.snapshot.wallet === 'ol' && row.snapshot.tip.height === s.tip.height)?.snapshot;
  const ee = s.wallet === 'ee' ? s : data.records.find(row => row.snapshot.wallet === 'ee' && row.snapshot.tip.height === s.tip.height)?.snapshot;
  renderTransactionText(el('eeDaContext'), eeDaReportLines(ee?.eeDaContext, s.tip).join('\n'), s.network);
  renderTransactionText(el('epochContext'), epochReportLines(ol?.epochContext, s.tip).join('\n'), s.network);
  text('inputCount', '· ' + s.naiveRunway.sampleSize + ' complete settlements');
  el('inventory').replaceChildren();
  for (const [name, val] of [['Total observed wallet balance', fmt(c.balanceSats) + ' sats'], ['Confirmed funding balance (>546 sats)', fmt(c.spendableSats) + ' sats'], ['Pending confirmation (>546 sats)', r.collected ? fmt(c.unconfirmedGtDustSats) + ' sats' : 'Not recorded in historical replay'], ['Small outputs (≤546 sats; excluded by pinned model)', fmt(c.strandedSats) + ' sats'], ['Unsupported confirmed outputs (>546 sats)', fmt(c.unsupportedGtDustSats) + ' sats'], ['Largest confirmed funding output', fmt(c.largestUtxoSats) + ' sats'],
    ['Unspent outputs', fmt(c.counts.total)], ['History coverage', s.naiveRunway.historyComplete ? 'Complete' : 'Incomplete'], ['Address discovery', s.ceilingHit.receive || s.ceilingHit.change ? 'Ceiling reached · lower bounds only' : 'Complete within configured gap scan']] as const) {
    const tr = document.createElement('tr'); cell(tr, name); cell(tr, val); el('inventory').append(tr);
  }
  feeView?.selectAt(Date.parse(s.asOf) / 1000, latest);
  const quote = s.feeContext;
  text('fee', quote?.status === 'available' ? 'Fee recommendation observed ' + timestamp(Date.parse(quote.observedAt)) + ': ' + quote.rates!.fastestFee + ' sat/vB. Informational only.' : 'Fee recommendation: no historical quote available at this block.');
  el('training').replaceChildren();
  const training = data.training[r.trainingRef] ?? [];
  for (const settlement of [...training].reverse()) {
    const tr = document.createElement('tr'); cell(tr, date(settlement.blockTime * 1000)); cell(tr, fmt(settlement.drainSats));
    cell(tr, settlement.complete ? 'Complete' : 'Reveal pending'); const tx = cell(tr, settlement.txid.slice(0, 12) + '…'); tx.title = settlement.txid; el('training').append(tr);
  }
  if (!training.length) emptyRow('training', 4, r.collected ? 'Individual settlements are not included in the collected sample. Daily spending is the estimate recorded by the monitor.' : 'No settlement samples at this block.');
  text('trainingHelp', r.collected ? 'Runway divides confirmed plus pending funding by the collector’s daily spending estimate, assuming normal confirmation. Alternative 7-/30-day averages are unavailable for collected samples.' : 'Costs include commit/reveal fees and newly stranded outputs. Newest commits appear first. Current model uses eligible 7-/30-day medians; averages use their full windows.');
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
  text('accuracyDescription', 'Historical replay through block ' + fmt(data.manifest.toHeight) + ' · Alpen ' + s.wallet.toUpperCase() + ' · ' + names[model()] + ' · ' + s.horizon + '-day settlement spending');
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
  stop(); const oldTime = Date.parse(rows[position]?.snapshot.asOf ?? '');
  rows = data.records.filter(r => r.snapshot.wallet === value('wallet'));
  if (!rows.length) throw new Error('Empty wallet replay');
  if (initial) position = rows.length - 1;
  else { const i = rows.findIndex(r => Date.parse(r.snapshot.asOf) >= (Number.isFinite(oldTime) ? oldTime : 0)); position = i < 0 ? rows.length - 1 : i; }
  el<HTMLInputElement>('slider').max = String(rows.length - 1);
  el<HTMLInputElement>('height').min = String(rows[0]!.snapshot.tip.height); el<HTMLInputElement>('height').max = String(rows.at(-1)!.snapshot.tip.height);
  el<HTMLInputElement>('date').min = rows[0]!.snapshot.asOf.slice(0, 10); el<HTMLInputElement>('date').max = rows.at(-1)!.snapshot.asOf.slice(0, 10);
  const role = roles[value('wallet')];
  text('walletName', 'Alpen ' + value('wallet').toUpperCase() + (role ? ' / ' + role : ''));
  text('walletDescription', (role ? role + ' checkpoint funding.' : 'Checkpoint funding wallet.') + ' Receive + change chains.');
  renderBlock(); renderAccuracy();
}
async function refreshLive() {
  if (!liveEndpoint || loadingLive) return;
  loadingLive = true;
  try {
    const response = await fetch(liveEndpoint, { cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(25000) });
    if (!response.ok) throw new Error('Live data unavailable');
    const update = await response.json() as LiveTimeMachine;
    if (update.network !== 'mainnet' || !update.records?.length || !Number.isFinite(update.staleAfterSeconds) || !Number.isFinite(Date.parse(update.readAt))) throw new Error('Invalid live data');
    const followLatest = position === rows.length - 1;
    data.records = mergeCollected(archiveRecords, update.records);
    const mergedTransactions = new Map(archiveTransactions.map(t => [t.wallet + ':' + t.txid, t]));
    for (const tx of update.transactions ?? []) {
      const key = tx.wallet + ':' + tx.txid, old = mergedTransactions.get(key);
      mergedTransactions.set(key, old ? { ...old, benchmark: tx.benchmark?.kind === 'block_median' ? tx.benchmark : old.benchmark ?? tx.benchmark } : tx);
    }
    data.transactions = [...mergedTransactions.values()].sort((a, b) => a.time - b.time || a.txid.localeCompare(b.txid));
    staleAfterSeconds = update.staleAfterSeconds;
    liveReadAt = update.readAt; liveError = false;
    if (update.study && update.study.network === 'mainnet' && update.study.asOf > studyAsOf) {
      const study = { ...update.study, timeline: [...new Map([...(update.study.timeline ?? []), ...(archiveStudy?.timeline ?? [])].map(t => [t.origin, t])).values()].sort((a, b) => a.origin - b.origin) };
      feeView?.destroy(); feeView = renderFeeStudy(el('network-fees'), study, { live: true }); studyAsOf = study.asOf;
    }
    text('researchStatus', update.researchError ? 'The last fee study refresh failed. Current fee estimates expire after two hours.' : update.researchUpdatedAt ? 'Fee study last refreshed ' + timestamp(Date.parse(update.researchUpdatedAt)) + '.' : 'Waiting for the first scheduled fee study refresh.');
    selectWallet(followLatest);
  } catch { liveError = true; renderBlock(); }
  finally { loadingLive = false; }
}
async function start() {
  const packed = Uint8Array.from(atob(el('data').textContent ?? ''), c => c.charCodeAt(0));
  data = await new Response(new Blob([packed]).stream().pipeThrough(new DecompressionStream('gzip'))).json() as ReportData;
  if (!data.records.length) throw new Error('No replay records');
  const supplement = document.getElementById('transactionData');
  if (supplement?.textContent) {
    const bytes = Uint8Array.from(atob(supplement.textContent), c => c.charCodeAt(0));
    const details = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).json() as { archiveDigest: string; transactions: TransactionSummary[] };
    if (details.archiveDigest === data.manifest.archiveDigest) data.transactions = details.transactions;
  }
  archiveTransactions = data.transactions ?? [];
  inspector = new TransactionInspector(data.manifest.network);
  balanceChart = new FundingTimeline(el('balanceChart'), txid => inspector.inspect(txid, true), rangeChanged);
  archiveRecords = data.records; archiveStudy = data.feeStudy;
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
  el('wallet').onchange = () => selectWallet(position === rows.length - 1);
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
  if (data.feeStudy) feeView = renderFeeStudy(el('network-fees'), data.feeStudy, { live: !!liveEndpoint });
  text('manifest', JSON.stringify(data.manifest, null, 2)); selectWallet(true);
  if (liveEndpoint) {
    text('latest', 'Latest collected snapshot');
    void refreshLive();
    setInterval(() => { renderBlock(); void refreshLive(); }, 60000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { renderBlock(); void refreshLive(); } });
  }
}
void start().catch(() => { const error = el('loadError'); error.hidden = false; error.textContent = 'Unable to load this audit. Rebuild with pnpm replay report, then open it in a current browser with gzip support.'; });
