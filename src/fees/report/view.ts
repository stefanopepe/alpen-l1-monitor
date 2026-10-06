import Chart from 'chart.js/auto';
import { currentFeeFresh, forecastAt, forecastOutlook } from './state.js';
import type { FeeStudy } from '../schema.js';

const names = { baseline: 'Recent baseline', seasonal: 'Baseline + seasonality', pressure: 'Seasonality + pressure', rolling: 'Rolling arithmetic mean', ewma: 'EWMA', weekday_hour: 'Same weekday / hour' };
const reasons: Record<string, string> = { weekday_hour_history_incomplete: 'Matching weekday/hour history incomplete', pressure_history_unavailable: 'No fresh pressure snapshot', pressure_projection_unavailable: 'No single-block projection',
  seasonal_warmup: 'Seasonal history too short', recent_history_incomplete: 'Recent history incomplete' };
const fmt = (v: number | null) => v === null ? '—' : new Intl.NumberFormat('en', { maximumFractionDigits: 3 }).format(v);
const utc = (t: number) => new Date(t * 1000).toISOString().replace('T', ' ').slice(0, 16);
const stateLabel = (state: string) => state.replaceAll('_', ' ');
const percent = (v: number | null) => v === null ? '—' : (100 * v).toFixed(1) + '%';
export function renderFeeStudy(root: HTMLElement, study: FeeStudy, options: { live?: boolean } = {}) {
  const el = <T extends HTMLElement = HTMLElement>(key: string) => root.querySelector<T>(`[data-fee="${key}"]`)!;
  const text = (key: string, value: string) => { el(key).textContent = value; };
  const row = (key: string, values: string[]) => {
    const tr = document.createElement('tr');
    for (const value of values) { const td = document.createElement('td'); td.textContent = value; tr.append(td); }
    el(key).append(tr);
  };
  for (const key of ['resolutions', 'stability', 'warnings', 'heatmap']) el(key).replaceChildren();
  text('asOf', 'Fee study updated: ' + utc(study.asOf) + ' UTC · ' + (options.live ? 'Refreshes hourly' : 'Saved study; no live refresh'));
  text('years', fmt((study.coverage.end - study.coverage.start) / 86400 / 365.25) + ' years');
  text('buckets', study.coverage.buckets.toLocaleString('en') + ' observed buckets');
  text('pressure', study.coverage.pressureStatus === 'available'
    ? 'Pressure correction uses the observed projected blocks. Its decay is experimental; assess it against archived observations.'
    : (reasons[study.coverage.pressureStatus] ?? study.coverage.pressureStatus) + '. Baseline and seasonal results remain available; no pressure backtest is invented.');
  for (const r of study.coverage.resolutions) row('resolutions', [fmt(r.seconds / 3600) + ' hours', String(r.buckets), utc(r.start), utc(r.end)]);
  for (const r of study.stability) row('stability', [String(r.year), fmt(r.days), fmt(r.finestHours) + '–' + fmt(r.coarsestHours), fmt(r.weekdayWeekendRatio)]);
  for (const warning of study.warnings) { const li = document.createElement('li'); li.textContent = warning; el('warnings').append(li); }
  text('provenance', JSON.stringify({ validation: study.validation, availabilityMode: study.availabilityMode, inputDigest: study.inputDigest, archiveDigest: study.archiveDigest, pressureDigest: study.pressureDigest, sourceSha256: study.sourceSha256, target: study.target,
    trainingDays: study.coverage.seasonalTrainingDays, pressureSnapshots: study.coverage.pressureSnapshots, config: study.config }, null, 2));
  const heatmap = el<HTMLTableElement>('heatmap'), header = heatmap.createTHead().insertRow();
  for (const label of ['UTC', ...Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0'))]) { const th = document.createElement('th'); th.textContent = label; header.append(th); }
  const body = heatmap.createTBody();
  for (const [weekday, label] of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].entries()) {
    const tr = body.insertRow(), th = document.createElement('th'); th.scope = 'row'; th.textContent = label; tr.append(th);
    for (let hour = 0; hour < 24; hour++) {
      const p = study.profile.find(p => p.weekday === weekday && p.hour === hour), td = tr.insertCell();
      td.textContent = p ? p.factor.toFixed(2) : '—';
      td.style.padding = '8px 5px'; td.style.fontSize = '10px';
      if (p) { td.title = `${label} ${hour}:00–${hour + 1}:00 UTC: ${p.factor.toFixed(3)}× (1 + sat/vB)`;
        const alpha = Math.min(0.75, Math.abs(Math.log(p.factor)) * 2);
        td.style.backgroundColor = p.factor >= 1 ? `rgba(215, 153, 76, ${alpha})` : `rgba(54, 164, 151, ${alpha})`; }
    }
  }
  let chart: Chart | undefined, selectedTime: number | null = null;
  const view = el<HTMLSelectElement>('view');
  view.querySelector<HTMLOptionElement>('option[value="historical"]')!.disabled = true;
  const render = () => {
    const horizon = Number(el<HTMLSelectElement>('horizon').value), sampling = el<HTMLSelectElement>('sampling').value;
    el('forecastRows').replaceChildren(); el('scoreRows').replaceChildren(); el('calibrationRows').replaceChildren(); el('diagnosticRows').replaceChildren();
    const historical = view.value === 'historical';
    const saved = forecastAt(study, historical && selectedTime !== null ? selectedTime : study.asOf);
    const stale = options.live && !historical && !currentFeeFresh(study);
    let forecasts = stale ? [] : historical ? saved?.forecasts ?? [] : study.forecasts;
    const origin = historical ? saved?.origin : study.asOf;
    const referenceTime = historical ? selectedTime! : Date.now() / 1000;
    const historyThrough = historical ? saved?.historyThrough : study.coverage.end;
    const age = historyThrough == null ? null : Math.max(0, (referenceTime - historyThrough) / 3600);
    text('freshness', stale ? 'STALE · Current fee estimates unavailable. Last successful study: ' + utc(study.asOf) + ' UTC. Waiting for fresh fee history and a successful refresh.' : origin === undefined ? 'No fee forecast was saved by this block. Wallet replay remains available.' :
      `${historical ? 'Forecast available at selected block' : 'Latest saved fees'} · Origin ${utc(origin)} UTC · History through ${historyThrough == null ? 'unavailable' : utc(historyThrough) + ' UTC'} · ${age === null ? 'Freshness unknown' : age.toFixed(1) + ' hours old' + (age > 24 ? ' · STALE' : '')} · ${study.availabilityMode === 'recorded' ? 'Recorded availability' : 'Legacy availability assumed; retrospective experiment'}`);
    const pressureAge = saved?.pressureObservedAt ? referenceTime - Date.parse(saved.pressureObservedAt) / 1000 : null;
    const pressureStale = pressureAge !== null && pressureAge > study.config.pressureFreshnessSeconds;
    if (options.live && !historical && pressureStale) forecasts = forecasts.map(f => f.model === 'pressure' ? { ...f, points: [], summaries: [], reason: 'pressure_history_unavailable' } : f);
    const pressureForecast = forecasts.find(f => f.model === 'pressure');
    text('pressure', stale ? 'Pressure estimate unavailable until the fee study refreshes.' : !historical && pressureStale ? `Pressure snapshot is STALE now (${fmt(pressureAge! / 3600)} hours old). Use the seasonal forecast when available; the pressure curve is hidden.` : pressureForecast?.points.length ? 'Pressure: available but UNVALIDATED until frozen held-out checks pass. Collection: ' + (saved?.pressureObservedAt ?? 'see latest study provenance') :
      `Pressure: ${stateLabel(saved?.pressureState ?? pressureForecast?.reason ?? 'missing')}. Seasonal forecast is the fallback when available.`);
    const outlook = forecastOutlook(forecasts);
    text('outlook', outlook ? `Recent demand: ${fmt(outlook.current)} sat/vB · Expected busiest six hours: ${utc(outlook.busy.time)} UTC (${fmt(outlook.busy.central)} sat/vB) · Quietest six hours: ${utc(outlook.quiet.time)} UTC (${fmt(outlook.quiet.central)} sat/vB).` : 'Demand outlook unavailable: insufficient known fee history.');
    const baseSummary = forecasts.find(f => f.model === 'baseline')?.summaries.find(s => s.horizonDays === horizon);
    const seasonSummary = forecasts.find(f => f.model === 'seasonal')?.summaries.find(s => s.horizonDays === horizon);
    const pressureSummary = pressureForecast?.summaries.find(s => s.horizonDays === horizon);
    text('contributions', `Contribution to the ${horizon}-day central average: seasonality ${baseSummary && seasonSummary ? fmt(seasonSummary.central - baseSummary.central) : '—'} sat/vB; pressure ${seasonSummary && pressureSummary ? fmt(pressureSummary.central - seasonSummary.central) : '—'} sat/vB. Wallet runway formula is unchanged.`);
    for (const forecast of forecasts) {
      const s = forecast.summaries.find(s => s.horizonDays === horizon);
      row('forecastRows', [names[forecast.model], s ? fmt(s.central) : reasons[forecast.reason ?? ''] ?? 'Unavailable', fmt(s?.p50 ?? null), fmt(s?.p90 ?? null), s ? `${s.calibrationSamples} / ${fmt(s.effectiveCalibrationSamples ?? null)} effective · ${stateLabel(s.calibrationState ?? 'experimental')}` : '—', s ? `${percent(s.priorP50Coverage ?? null)} / ${percent(s.priorP90Coverage ?? null)} (${s.priorCoverageSamples ?? 0})` : '—']);
    }
    for (const s of study.scores.filter(s => s.horizonDays === horizon && s.sampling === sampling)) {
      row('scoreRows', [names[s.model], `${s.available} / ${s.origins}`, String(s.matched), fmt(s.mae), s.model === 'baseline' ? 'Reference' : percent(s.skillVsBaseline),
        percent(s.p50Coverage) + ` (${s.p50Samples})`, percent(s.p90Coverage) + ` (${s.p90Samples})`, fmt(s.p50Pinball ?? null), fmt(s.p90Pinball)]);
      row('calibrationRows', [names[s.model], `${s.p50Interval?.map(percent).join('–') ?? '—'} / ${s.p90Interval?.map(percent).join('–') ?? '—'} · n eff ${fmt(s.effectiveSamples ?? null)} · ${stateLabel(s.uncertaintyState ?? 'experimental')}`,
        `${percent(s.regimeP50Coverage ?? null)} / ${percent(s.regimeP90Coverage ?? null)} · loss ${fmt(s.regimeP50Pinball ?? null)} / ${fmt(s.regimeP90Pinball ?? null)}`,
        `${percent(s.rollingP50CoverageOnRegime ?? null)} / ${percent(s.rollingP90CoverageOnRegime ?? null)} · loss ${fmt(s.rollingP50OnRegime ?? null)} / ${fmt(s.rollingP90OnRegime ?? null)} · n ${s.regimeSamples ?? 0}`]);
      if (s.model === 'pressure') text('pressureComparison', `Pressure improvement over seasonality: ${percent(s.skillVsSeasonal ?? null)} across ${s.pressureMatched ?? 0} matched periods. Positive means lower central error; no evidence means unvalidated.`);
    }
    for (const d of study.diagnostics?.filter(d => d.horizonDays === horizon && ['seasonal', 'pressure'].includes(d.model)) ?? [])
      row('diagnosticRows', [d.group, names[d.model], String(d.samples), fmt(d.mae), `${d.p90Misses} / ${d.quantileSamples}`]);
    text('validation', 'Validation: ' + stateLabel(study.validation?.state ?? 'legacy_exploratory') + '. ' + (study.validation?.checks.map(c => `${names[c.model]} ${c.horizonDays}d: ${c.state}${c.reasons.length ? ' (' + c.reasons.join(', ') + ')' : ''}`).join('; ') ?? ''));
    const es = study.evaluations.filter(e => e.horizonDays === horizon && (sampling === 'daily' || e.nonOverlapping));
    const period = study.evaluationPeriods?.find(p => p.horizonDays === horizon && p.sampling === sampling);
    text('scorePeriod', es.length || period ? `${utc(period?.from ?? es[0]!.origin)} – ${utc(period?.to ?? es.at(-1)!.origin)} UTC · ${horizon}-day average fee benchmark. Models refit using only history available at each origin.` : 'No eligible backtest dates.');
    chart?.destroy();
    chart = new Chart(el<HTMLCanvasElement>('chart'), { type: 'line', data: { datasets: forecasts.filter(f => f.points.length && ['baseline', 'seasonal', 'pressure'].includes(f.model)).map((f, i) => ({
      label: names[f.model], data: f.points.slice(0, horizon * 24).map(p => ({ x: p.time * 1000, y: p.central })),
      borderColor: ['#788a9a', '#087f72', '#b57831'][i], borderDash: i === 0 ? [5, 4] : [], borderWidth: 2, pointRadius: 0,
    })) }, options: { responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { intersect: false, mode: 'index' }, plugins: { legend: { position: 'bottom' }, tooltip: { callbacks: {
        title: items => items[0] ? utc((items[0].parsed.x ?? 0) / 1000) + ' UTC' : '', label: ctx => ctx.dataset.label + ': ' + fmt(ctx.parsed.y) + ' sat/vB',
      } } }, scales: { x: { type: 'linear', ticks: { maxTicksLimit: 7, callback: v => utc(Number(v) / 1000).slice(5, 16) }, title: { display: true, text: 'Forecast hour · UTC' } },
        y: { min: 0, title: { display: true, text: 'Network fee benchmark · sat/vB' } } } } });
  };
  el<HTMLSelectElement>('horizon').onchange = render; el<HTMLSelectElement>('sampling').onchange = render; view.onchange = render; render();
  if (options.live) view.querySelector<HTMLOptionElement>('option[value="latest"]')!.textContent = 'Latest fee study';
  return { destroy() { chart?.destroy(); }, selectAt(time: number, latest = false) { selectedTime = time; view.querySelector<HTMLOptionElement>('option[value="historical"]')!.disabled = false; view.value = latest ? 'latest' : 'historical'; render(); } };
}
