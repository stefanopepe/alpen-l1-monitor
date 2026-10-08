# Seasonal Bitcoin fee forecasts

This experiment implements the network-fee layer of the runway estimator: a recent fee baseline, a learned daily/weekly profile, and an optional correction from observed projected blocks. Alpen EE transaction sizes, posting cadence and fee-bumping policy remain outside this change. The operational `naiveRunway` formula is unchanged; the experiment appears alongside the wallet audit.

## Options considered

| Approach | Useful for | Limitation / decision |
|---|---|---|
| Recent mean/median or EWMA | Current fee regime | Cannot anticipate recurring peaks; recent log-rate mean is the reference here |
| Historical daily/weekly profiles | Predictable recurring demand | Normalize fee regimes and account for coarse history; implemented with smooth seasonal regression |
| Mempool projected blocks | Immediate backlog and near-term pressure | A snapshot cannot describe a whole week; implemented as a decaying correction |
| Bitcoin Core confirmation estimator | Rate for a transaction's confirmation deadline | Different target from future network costs; future execution-policy comparator |
| Queue/arrival-rate simulation | Backlog clearance and random block intervals | Needs archived arrivals, fee bins and a miner-selection model |
| Seasonal ARIMA/state-space models | Joint changing level, trend and seasonality | Useful challenger with a consistent higher-resolution series |
| Quantile regression/boosting/neural models | Nonlinear interactions and conditional tails | Needs larger aligned history and strict walk-forward validation |
| Stress scenarios / shock replay | Exceptional-congestion funding sensitivity | Complements prediction; not a calibrated percentile |
| Alpen writer-specific model | Settlement costs and wallet consumption | Deferred: requires vB, cadence, package structure and bumping policy |

Bitcoin Core's [estimator interface](https://doxygen.bitcoincore.org/class_c_block_policy_estimator.html) targets confirmation within a block count. [FENN research](https://arxiv.org/abs/2405.15293) studies combining transaction, mempool and blockchain information. Neither establishes that a particular daily/weekly pattern is permanent. Here the hypothesis is tested against captured data, with annual fits and a flat-baseline comparison.

## Commands and reproducibility

Use Node 24 and the repository's pinned pnpm. Only `fetch` and `observe` need network access; they use public mempool endpoints without credentials.

```sh
pnpm fees fetch --archive .local/fees/mainnet
pnpm fees observe --out .local/fees/observations.json
pnpm fees run --archive .local/fees/mainnet --observations .local/fees/observations.json --out .local/fees/study
pnpm fees report --out .local/fees/study

# Attach without recomputing wallet forecasts.
pnpm replay report --out .local/replay/audit-mainnet --fees-study .local/fees/study/study.json
```

Open `.local/fees/study/report.html` or the combined replay report. Both bundle their data and assets and require a current browser with `DecompressionStream`. Select 1/3/5/7-day horizons and daily/non-overlapping evaluation dates. The fee study has its own origin. Version-2 studies also retain daily forecasts; the wallet block slider selects the latest saved forecast already available at the chosen time. It does not refit a model in the browser. Replay report rebuilds retain the attached `fee-study.json`; pass `--fees-study` again to replace it. `run` and `refresh` also accept that flag.

Use `run --as-of 2026-10-02T11:13:08Z` for an explicit origin. The default uses archive/observation capture times, rounded up to the next second so a just-captured subsecond observation remains eligible. The report is a saved forecast, not a live quote. `--config FILE` accepts overrides validated by `src/fees/schema.ts`. `study.json` records archive and eligible-pressure digests, actual source hash, resolved configuration, forecasts, outcomes and scores. Retain archive/raw bodies, config and observation exports together. Local evidence is Git-ignored.

Better historical data can be imported with `pnpm fees import --input FILE --archive DIR`. The input is the archive schema without `digest` and `responses`: `schemaVersion: 1`, `network: "mainnet"`, `target: "bucket_mean_block_median_sat_vb"`, ISO `capturedAt`, descriptive `source`, `integerQuantized`, and `buckets` containing Unix-second `start`/`end`, `rate` in sat/vB and `source`. Buckets must be non-overlapping, complete at capture, positive duration and at most one day. Never relabel recommended quotes or total fees as block medians.

## Data and model

History comes from mempool's [block fee-rate API](https://mempool.space/docs/api/rest#get-block-feerates). `avgFee_50` averages block medians within each time bucket. The [mining time-range code](https://github.com/mempool/mempool/blob/master/backend/src/api/mining/mining.ts) and [block repository query](https://github.com/mempool/mempool/blob/master/backend/src/repositories/BlocksRepository.ts), inspected October 2, 2026, define resolutions and integer conversion. We combine 4y/1y/6m/3m/1m windows at 12h/8h/3h/2h/30m resolution, keeping finer observations. Overlapping coarse buckets are discarded whole; gaps remain gaps and unfinished buckets are excluded. Loading verifies archive/raw-response hashes.

The target is the duration-weighted average of bucket medians over the forecast period. It is **not** a transaction inclusion quote, transaction-fee quantile, or per-block prediction. Old 12-hour buckets support broad time-of-day and weekday effects; finer hourly shape depends on recent finer data. Integer conversion loses sub-sat information; displayed decimal precision cannot restore it.

Defaults fit four years of `log(1 + sat/vB)` with a one-year recency half-life. Weekday contrasts, three daily harmonic pairs and a weekday/weekend first-harmonic interaction produce a smooth UTC profile. Regressors are integrated over actual bucket intervals. Demeaning each observed week removes its fee level; ridge regularization limits unsupported shape. The last seven observed days determine the current level after subtracting seasonality. Displayed factors multiply **1 + rate**, not raw sat/vB. Requirements: 84 observed training days, 80% recent-window coverage and an endpoint gap no longer than one day.

Pressure uses mempool's [projected blocks](https://mempool.space/docs/api/rest#get-mempool-blocks-fees): the vsize-weighted log median of the first three eligible single-block projections. Overflow stacks exceeding 1M vB are excluded. The difference from the current seasonal level decays with an experimental six-hour half-life. Snapshots older than 30 minutes, future snapshots, or a latest failed observation produce no pressure forecast. Historical pressure is never reconstructed from today's mempool. Recommendation quotes remain separate context.

The collector records recommendation and projected-block requests independently and concurrently, with five-second timeouts, in existing 90-day run records. Failure cannot invalidate inventory or runway. Old exports remain readable. Use `pnpm replay export-observations` and pass its file to `pnpm fees run --observations FILE`. With the hardening migration, export also includes durable evidence beyond run retention. The original experiment needed no migration. The local hardening iteration below adds a durable evidence migration; no new scheduler or production deployment is included.

## Validation and findings

Walk-forward fits use only completed buckets at each historical midnight UTC. A preceding warm-up supplies calibration before the 180-day evaluation window. Period p50/p90 adjust central estimates using empirical log forecast errors from the preceding 180 days, with at least 30 **fully resolved** earlier outcomes of the same model and horizon. They are period-average quantiles; hourly lines are central estimates. Calibration periods overlap. Non-overlapping scoring reduces evaluation dependence, but does not create independent calibration samples or a guarantee.

Outcomes require at least 95% observed duration. Missing duration is never filled with zero; buckets crossing either outcome boundary are excluded. Each model is compared with the baseline on its own matching dates. Unfinished outcomes are censored. Errors describe the network target, not Alpen spending. Historic API publication latency is not archived; replay assumes a completed bucket is available at its end.

The October 2 capture contains **5,589 buckets**, from October 2, 2022 through October 2, 2026 at 10:30 UTC. Archive digest: `c92d68982499709283f3b00a10273f273492ef6de54927c64c73274cc7b4a31c`. Study origin: 11:13:08 UTC. Non-overlapping seasonal-model results:

| Period | Matched periods | Baseline MAE · sat/vB | Seasonal MAE · sat/vB | Error reduction | p90 coverage |
|---|---:|---:|---:|---:|---:|
| 1 day | 169 | 0.353 | 0.297 | 15.8% | 87.0% |
| 3 days | 57 | 0.280 | 0.260 | 7.3% | 86.0% |
| 5 days | 34 | 0.237 | 0.224 | 5.5% | 82.4% |
| 7 days | 23 | 0.236 | 0.227 | 3.8% | 87.0% |

Annual weekday/weekend factors are 1.125, 1.135, 1.189, 1.174 and 1.171 for 2022–2026; first/last years are partial. They support the broad weekday/weekend hypothesis in this archive, without establishing its cause or a fixed hourly profile across all years. UTC seasonality ignores daylight-saving shifts, holidays and event-driven shocks.

Seasonality improves central accuracy here, but **p90 coverage is below its 90% target**. Bounds remain experimental. One live pressure snapshot supplies the initial current central curve, with no historical pressure score or calibrated pressure p50/p90. Next priorities are longer recorded pressure history, finer historical fees, calibration/regime checks and a genuinely held-out period. EE sizing and conversion to funded days follow as a separate analysis.

## Observation and evaluation hardening (local iteration)

The version-2 study adds causal daily forecast snapshots, arithmetic rolling and EWMA baselines, a same-UTC-weekday/hour challenger, calibration diagnostics and a frozen evaluation protocol. Existing version-1 reports remain readable. This work is local and does not release or deploy the experiment. The operational wallet formula is unchanged.

### Durable collection

Migration `0002_fee_observations.sql` adds compact, versioned, hashed observations independent of `runs`. There is no foreign key to expiring runs and no automatic cleanup of this table. Apply migrations and `ops/roles.sql` only as part of a later release: the runtime can insert/select evidence but cannot update/delete it. Back up this growing table or retain verified exports. At a 15-minute cadence there are at most 96 new collection envelopes per day; actual bytes depend on projected/completed-block payloads.

The three independent initial requests (five-second timeout each) capture recommendations, projected blocks and the latest 15 completed blocks. Completed blocks retain height/hash, header time, weight, transaction count and the upstream `extras` fields. The [mempool v1 blocks API](https://mempool.space/docs/api/rest#get-blocks) documents those fields. Its `medianFee` can count unused block capacity as zero and can initially contain integer-valued fallback statistics; it is retained as raw evidence, not used as the live report's transaction median.

Starting in v2.4.2, each block is enriched from `/v1/block/:hash/summary` using the same network's fee API. At most three summaries are requested concurrently, with five-second individual timeouts and a shared 20-second enrichment deadline. The collector verifies transaction count, unique IDs, a zero-fee first/coinbase entry and the total fee sum against the block metadata. It excludes only the first coinbase entry, computes each remaining transaction's `fee / ceil(vsize)` (the API's vsize can be weight/4), and takes the ordinary median, averaging the two middle rates for an even count. Upstream CPFP-adjusted `rate` is not used. Successful compact `transactionFees` observations record the explicit `median_transaction_fee_per_vbyte` basis, non-coinbase count and fractional median; coinbase-only blocks have count zero and median null. A failed summary records a redacted `transactionFeesError` on that block and does not discard other blocks or quotes. Summaries are retried in subsequent collections.

The report uses only verified `transactionFees`, including genuine zero-fee transactions. Legacy observations and failed summaries are unavailable rather than zero, and coinbase-only blocks have no fee sample; each excluded category is counted. The 24-hour arithmetic average uses one verified median per block, with gaps labelled partial. Verified statistics survive later failed retries for the same hash, but a reorg replaces the old block's statistics. Each observation records its completion time; header time is not a publication timestamp. Fifteen recent blocks are a bounded sample. These transaction medians are not silently converted into the existing research time-bucket target or projected-block pressure model. No migration or retrospective overwrite of saved evidence is required.

Collection marks persistence `durable` or `unavailable`. Missing migration, failed grants and evidence-storage failures leave wallet collection and read APIs usable; results still contain the attempt under the old run-retention policy. Export reads the union of retained runs and durable observations, verifies content hashes, and deduplicates by run ID. Export older run evidence before it expires; this migration does not reconstruct observations that have already been deleted.

```sh
pnpm replay export-observations --network mainnet --from 2026-10-01T00:00:00Z --out .local/fees/retained-observations.json
pnpm fees observe --out .local/fees/manual-observations.json
```

New fee-history captures stamp each bucket with `availableAt` at request completion. Repeated fetches append newly observed non-overlapping buckets, retain first-observed values and all response versions, and preserve earlier seals. They never replace an earlier coarse bucket with a later refinement. Use a new archive directory for imports or revised research datasets. Imports may provide explicit Unix-second `availableAt` values (at or after bucket end); omitted values identify legacy, assumed-at-end research. On the first refresh of a legacy archive, its original capture time becomes the conservative availability time. Keep its old seal for reproducing the original retrospective study.

At every forecast origin, both training and residual calibration use only observations actually available by that origin. Late outcome data can improve later calibration but cannot revise an earlier issued prediction. The study saves each origin's input digest, data endpoint, pressure attempt timestamp, fallback, curves and period quantiles. Two calibration windows of warm-up keep prior-coverage diagnostics stable when the overall report window advances.

### Comparisons and uncertainty

Rolling means and EWMA use the same recent coverage safeguards as the reference log baseline. The same-weekday/hour challenger averages corresponding slots from the previous four weeks, requiring three known matches; coarse buckets remain coarse rather than becoming new independent samples. Pressure is compared to seasonality on its own matching dates. Missing predictions/outcomes remain null. Daily and non-overlapping score tables are separate.

Both p50 and p90 report empirical coverage against 50%/90% and pinball loss (lower is better). Rolling and same-regime residual calibration are compared on identical dates, with their own sample counts; wider p90 bounds can worsen pinball loss. Regimes are fixed in advance from the origin's recent reference fee: low <1, normal 1–10, high ≥10 sat/vB. No realized future demand selects the regime. Prior coverage beside a forecast uses only earlier resolved forecasts, not the later report-wide scorecard.

Effective sample counts are capped by disjoint periods and reduced for positive residual autocorrelation (up to 14 lags). The displayed Wilson-style 95% coverage intervals use that adjusted count. These are conservative diagnostic approximations, not a validated sampling-distribution guarantee. Small effective samples and deteriorating p90 coverage are visible; all bounds remain experimental unless a later frozen evaluation meets its gates. Year and London/New York UTC-offset groups diagnose stability; differences are confounded by regime, year and seasonal changes and do not establish a causal daylight-saving effect. UTC remains the fitted seasonal clock.

### Train, freeze, then evaluate

```sh
# Training only: no later outcomes or observations enter tuning.
pnpm fees tune --archive .local/fees/recorded --observations .local/fees/retained-observations.json \
  --through 2026-10-02T23:00:00Z --out .local/fees/training

# Choose a genuinely future start/end; existing plan files cannot be overwritten.
pnpm fees freeze --archive .local/fees/recorded --out .local/fees/plan.json \
  --start 2026-10-03T00:00:00Z --end 2027-07-01T00:00:00Z --baseline baseline

# After collecting the held-out period, run the frozen implementation/config.
pnpm fees run --archive .local/fees/recorded --observations .local/fees/retained-observations.json \
  --plan .local/fees/plan.json --out .local/fees/held-out
```

Replace those example dates if they have passed. Tuning evaluates strengths 0.25/0.5/1 and half-lives 1/3/6/12 hours using non-overlapping, complete 24-hour outcomes. Projected-fee, backlog and recent-block-fullness challengers are reported, including comparisons on common dates. Only projection strength/decay can become a training proposal, with at least 30 periods and lower central error than seasonality. Backlog/fullness weights remain zero by default; challenger results never automatically change a model. Insufficient history produces `unvalidated_insufficient_or_no_gain`, with no proposed config. A proposal is in-sample evidence; pass its `proposed-config.json` to `freeze --config` only before the later held-out window.

The immutable plan records time boundaries, baseline, candidate models, source/config hashes, frozen training-input digest and thresholds. Any source/config change or revision to the training inputs invalidates that evaluation. Selection of non-overlapping origins is anchored to the plan start, independently of eligibility. For **each** horizon, review eligibility requires at least 30 matching calibrated periods and 20 effective samples; strictly lower central MAE; no increase in either p50 or p90 pinball loss; empirical p50 coverage within 10 percentage points of 50% and p90 within 5 points of 90%; and adjusted coverage intervals containing the targets. Pressure must also pass the same comparisons against seasonality alone. The full held-out period must be collected, and assumed publication times cannot qualify. Passing yields `eligible_for_review`, never automatic operational promotion. Do not move thresholds after seeing outcomes; a changed model needs a new future plan.

Each run saves `inputs.json` (sealed archive, observations, config, origin and optional plan), `implementation.json` (actual source files and hash, including uncommitted changes), `study.json`, and portable `report.html`. Retain these with the archive/raw bodies and lockfile. `--seal DIGEST` selects a previous archive; `report` only rebuilds presentation from saved results. Source bundles contain implementation files only, not environment files or credentials.

### Operator views

The fee panel has a **Latest saved fees** view with history age, pressure fallback, current recent level, expected busiest/quietest six-hour periods and additive seasonal/pressure contributions for 1/3/5/7-day averages. It is a saved capture, not a live fetch. Stale history stays visibly stale; insufficient recent coverage withholds predictions. Provider failure or stale/missing pressure leaves the seasonal forecast usable.

Attaching a version-2 study to replay lets the block selector show the most recent saved daily fee forecast at or before that block's reconstructed time. The original forecast origin is explicit; it is not refitted at every block. Seeking backwards cannot reveal a future curve or its calibration. Before the first saved forecast, or with a legacy study lacking snapshots, the historical fee panel is unavailable while wallet replay continues. **Latest saved fees** remains a separate selection. The weekly heatmap and evaluation tables are explicitly labelled as the latest study, and the latter uses hindsight outcomes; neither changes the historical prediction.

The initial one-snapshot dataset cannot validate historical pressure, feature additions or new operational uncertainty guarantees. Continuous collection begins only after the separate release. EE transaction sizing and any conversion from network fees to wallet cost/runway remain follow-up work.


### October 2 hardening verification

The rebuilt exploratory report is `.local/fees/evolution/report.html`; the combined wallet report remains `.local/replay/audit-mainnet/report.html`. It retains the same 5,589-bucket parent seal and 11:13:08 UTC forecast origin. The five-day non-overlapping comparison is:

| Model | Matched periods | Central MAE · sat/vB | Change vs matched reference | p50 coverage | p90 coverage | p90 pinball |
|---|---:|---:|---:|---:|---:|---:|
| Recent log baseline | 34 | 0.2374 | Reference | 47.1% | 79.4% | 0.0707 |
| Seasonal | 34 | 0.2244 | 5.5% better | 47.1% | 82.4% | 0.0696 |
| Rolling arithmetic mean | 34 | 0.2375 | 0.02% worse | 55.9% | 88.2% | 0.0685 |
| EWMA | 34 | 0.2668 | 12.4% worse | 52.9% | 88.2% | 0.0742 |
| Same weekday/hour | 32 | 0.1986 | 15.9% better | 43.8% | 90.6% | 0.0714 |
| Pressure | 0 | — | Unvalidated | — | — | — |

Each challenger has its own intersection with the reference; the 32-date row is not a head-to-head comparison with the 34-date rows. Seasonal p90's approximate adjusted 95% coverage interval is 66.5%–91.7%, with 34 effective periods. The weekday/hour challenger has incomplete recent-slot coverage at the current forecast origin. These results remain exploratory: no model or calibration method has been promoted, and the existing pressure file provides no complete historical training periods.

A separate conservative seed under `.local/fees/recorded` assigns the original archive's capture time to all imported historical buckets, retains its raw responses, and records the parent seal. Its digest is `ddad85eec9556b021400daef9d80af4b5894ac2b96299f74bde74f2013153fb5`. This makes those values available from capture onward without claiming they were available at earlier block times. The local plan `.local/fees/evolution/evaluation-plan-final.json` freezes the unchanged default model and the recent log baseline for **October 3, 2026–July 1, 2027 UTC**, digest `d24c4d6eeeda31722cd7f633193a97d1bd70624bfe2895589922128f81b08de8`. Its initial report under `.local/fees/prospective` is explicitly experimental with an incomplete held-out period and insufficient calibration. The longer period allows warm-up before the 30 non-overlapping seven-day sample floor, subject to actual collection coverage. No scheduler, live migration or deployment was executed.

Verification: `pnpm check` passed all 127 tests, type/config checks, lint and dependency boundaries; `pnpm smoke` passed 18 HTTP checks with database access disabled. Browser checks covered standalone scores, earlier-block navigation, latest-fee switching and pressure fallback. Report attachment leaves saved wallet predictions unchanged.

## Recover missing mined-block fees — 2.7.3

Use `pnpm fees:backfill --hours 26 --out .local/block-fee-backfill` on the mainnet checkout to capture missing verified transaction medians. Capture uses `DATABASE_URL_METRICS` for small hash lookups and public, unauthenticated mempool.space requests paced at one per second. `--from ISO_TIMESTAMP --to-height HEIGHT` selects an older range; each capture is bounded to 2,000 blocks. Pagination follows consecutive heights and previous-block hashes, walks an additional two-hour timestamp margin, and checks the captured anchor against the current canonical height. Only missing block summaries are fetched. Successful hash-addressed summaries are cached locally for retries; mutable height lookups and pages are always rechecked.

The existing calculation validates the summary's transaction count, unique transaction IDs, coinbase position and total fees, then takes the ordinary median of each non-coinbase transaction's `fee / ceil(vsize)`. Failed validation aborts capture. The saved capture contains the linked block metadata and compact verified medians; large summaries remain local and are never written to Neon.

Deploy 2.7.3-compatible readers before importing, then run `pnpm fees:backfill --out .local/block-fee-backfill --apply`. This uses `DATABASE_URL`, verifies the network and canonical anchor again, skips already verified block hashes, and appends to the existing immutable `fee_observations` table with deterministic block IDs. No schema migration is required. Reapplying a capture is safe. Each row is marked `kind: historical_blocks` and records when the source was fetched, rather than pretending it was observed live at its header time. Exports preserve this provenance and verify its digest.

Backfilled mined-block medians contribute to the 24-hour block statistics and transaction benchmarks. They never replace a live recommendation, alter quote coverage, invent a historical mempool projection, move the observed tip backward, or train the existing seasonal time-bucket model under a different target. After import, check `/api/status` for unchanged current quote freshness, increased verified-block coverage, and a current tip. Historical recommendation/mempool gaps remain missing.
