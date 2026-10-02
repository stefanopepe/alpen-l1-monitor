# Runway estimator improvement brief

Evolve the Alpen wallet monitor toward forecasts that account for changing Bitcoin blockspace demand. The next iteration should make the existing seasonal fee experiment reliable, explainable and useful alongside wallet runway. Keep Alpen EE transaction sizing as a separate follow-up.

This brief defines proposed next work for the tool's maintainers. It builds on the local implementation on `codex/seasonal-fee-forecast`; it does not change the production release scope.

## Evidence and starting point

The experiment combines four years of fee history, daily/weekly seasonality, a recent baseline and a decaying mempool-pressure correction. It already provides portable reports and walk-forward evaluation.

In the initial 180-day evaluation, seasonality reduced central forecast error against the recent baseline by **15.8% over one day** and **5.5% over five days**, using non-overlapping periods. Five-day p90 coverage was **82.4% across 34 scored periods**, below the intended 90%. Historical pressure validation is unavailable: the initial study has one live snapshot.

These results support further development, not operational confidence claims. Older history is coarse and integer-quantized. The target is an average network block-median fee rate, which differs from the rate required to confirm an Alpen transaction. See the [methodology and evidence](../seasonal-fees.md).

## Desired operator experience

The tool should explain the current demand level, the next expected busy/quiet periods, and the fee outlook for 1, 3, 5 and 7 days. Show the recent baseline, seasonal forecast and pressure-adjusted forecast together, with clear timestamps and data quality.

Distinguish central hourly curves from calibrated period-average p50/p90. Show observed coverage and sample counts beside uncertainty estimates. Missing or stale pressure should leave the seasonal forecast available with an explicit fallback label. Keep wallet balances and operational runway usable when fee data fails.

## Priorities

1. **Build durable observations.** Extend the existing collector/export path to preserve pressure snapshots, completed-block fee observations and provider availability timestamps beyond the current 90-day run retention. Capture higher-resolution history with fractional sat/vB where available; preserve original resolution and gaps. Version the data and retain enough evidence to reproduce what each forecast actually knew.

2. **Validate seasonality and pressure separately.** Compare the current model with rolling/EWMA baselines and simple same-weekday/hour forecasts. Test pattern stability across years and demand regimes, and investigate daylight-saving effects. Use recorded pressure to measure whether projected fees, backlog and block fullness improve near-term forecasts; tune correction strength and decay on training windows only. Add features only when they improve a later evaluation period.

3. **Improve uncertainty calibration.** Diagnose p90 misses by horizon and demand regime. Compare rolling and regime-aware residual calibration, measuring both coverage and quantile error so wider bounds do not win automatically. Report dependence-aware uncertainty and effective sample counts. Keep bounds experimental where evidence is insufficient or coverage deteriorates.

4. **Connect the experiment to the tool.** Extend replay so selecting a historical block shows the fee forecast available at that time. Add a clearly labelled latest-fee view with collection freshness and fallback state. Present model comparisons and their contribution to the forecast without changing the current wallet-runway formula in this iteration.

## Acceptance criteria

- Every forecast is reproducible from versioned inputs and configuration. Changing future observations cannot alter earlier predictions or calibration.
- Comparisons use matching dates, complete outcomes and both daily and non-overlapping scoring. Missing data never becomes a zero-fee observation.
- Freeze model choices and evaluation thresholds before opening a new held-out period. Promotion requires improved central accuracy against the selected baseline and acceptable quantile error; report p50/p90 coverage against their 50%/90% targets with uncertainty and sample counts.
- Pressure earns adoption through measured improvement over seasonality alone. Insufficient pressure history produces an explicit unvalidated state.
- Stale data, provider failures and insufficient calibration have visible, tested fallbacks. Existing inventory, read APIs and runway remain functional.
- Deliver updated reports, reproducible comparisons, regression tests and concise operating documentation. Keep deployment a separate release step.

## Later runway integration

After the fee layer is validated, analyse EE and OL separately using measured settlement vB, posting cadence, package structure, fee-bumping behaviour and stranded outputs. Validate the relationship between the network benchmark and actual writer fees before converting forecast paths into spending and depletion scenarios. Preserve timing and dependence when combining uncertainty: a p90 period-average fee is not automatically a p90 wallet-cost or runway estimate.

Automatic funding, posting-policy changes and new alert guarantees remain outside this iteration. Start with durable observations and frozen evaluation rules; pressure calibration depends on the history they produce.
