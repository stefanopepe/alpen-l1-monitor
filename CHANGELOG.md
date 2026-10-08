# Changelog

## 2.7.2 — incremental wallet index reads (2026-10-08)

- Reconcile the collector's stored wallet index by record: transfer only added, changed and removed transactions, reveal sets, address memberships, inventory and tip metadata. Reuse the index across function instances while checking its database revision on every collection.
- Preserve exact transaction/address ordering, pending-reveal retries, reorg handling, inventory validation and fee calculations. Keep the existing durable storage and atomic fenced writes; no migration or extra service is required.
- Add SQL integration and transfer regressions for a thousand retained transactions, incremental additions/deletions, changed block hashes, stale cache pointers, eviction and wallet/network isolation. Cold cache fills remain bounded full reads; local CLI collection remains uncached.

## 2.7.1 — shared read caching and transfer reduction (2026-10-07)

- Cache versioned read evidence in Vercel Runtime Cache across instances; coalesce concurrent misses with transaction-scoped locks. Reuse unchanged time groups and recompute freshness from the current clock.
- Project unused snapshot fee context, research evaluations, old fee buckets and transaction internals out in SQL before transfer. The hourly worker reads only pressure observations and the prior forecast timeline it needs.
- Check the live time machine every five minutes while visible, back off after errors, and use ETags to avoid downloading unchanged responses. Preserve existing wallet/fee expiry and network isolation.
- Add cache, concurrency, freshness, polling, conditional HTTP and database-result-size regression checks. No migration or new credential is required.

## 2.7.0 — network navigation and publication detail (2026-10-07)

- Add a mainnet/public Signet selector and network-correct mempool.space transaction links across the homepage and time machine.
- Identify each wallet's latest completed publication with its EE update or OL epoch, Bitcoin posting block, and completion timestamp.
- Show pending EE blob payload bytes, payload vB, transaction overhead, total and remaining vB, historical completion estimates, and costs at the current high-priority fee quote. Separate observed values from estimates, preserve overdue estimates, and suppress estimates when evidence is insufficient or stale. New fields populate on the next collection; no database migration is required.
- Color commit and reveal markers against their historical fee benchmark. Use visible-range logarithmic commit sizes below 48 hours, full contrast at 24 hours, actual vB labels when space allows, and compact markers for wide or crowded views.
- Preserve equal-sized commits and existing mainnet-only historical replay evidence on both deployments.

## 2.6.2 — explicit transaction fee comparisons (2026-10-06)

- Replace the misleading “Overpayment estimate” label with “Fee vs period benchmark” or “Fee vs same-block median,” including the reference rate in the inspector, transaction list and chart tooltips.
- Explicitly identify missing same-block evidence. A period average cannot establish a transaction's position among others in its block, and being above either reference does not establish avoidable fees.
- Preserve recorded fees, virtual sizes, benchmark selection and comparison arithmetic.

## 2.6.1 — native ECharts timeline navigation (2026-10-06)

- Replace the funding timeline with Apache ECharts 6.1.0, using its built-in overview slider, draggable range handles, panning, zoom gestures, reset, time axis and annotations. Remove the Chart.js zoom plugin and custom zoom controls.
- Put confirmed commits, reveals and other wallet actions in separate ECharts scatter rows, with exact fee/size details in native tooltips and the existing transaction inspector on click.
- Preserve the user’s selected date range through live updates and preserve the original balance, forecast and transaction evidence. Include ECharts and ZRender redistribution notices in hosted and portable reports.

## 2.6.0 — timeline exploration and transaction inspection (2026-10-06)

- Add Chart.js zoom/pan, 7-/30-/90-day and full-history views, with a reset button. Preserve the chosen view during automatic refresh; changing the view does not change the forecast.
- Show clickable confirmed-transaction markers, including commits and reveals, a filterable list and a block transaction chooser for overlapping events.
- Show exact per-transaction virtual size, sats paid, sat/vB, related package totals and explorer links. Compare with the same block’s recorded transaction median when available, otherwise an explicitly coarse historical benchmark; missing or quantized-zero comparisons remain unknown. A premium is not proof a lower fee would have confirmed.
- Read current transactions from stored collector history and supplement the immutable historical report with verified archive summaries. Preserve historical balance plateaus while breaking genuine gaps between collected samples.

## 2.5.2 — balance planning without confirmation dips (2026-10-06)

- Use one funding-balance line and calculate displayed runway from confirmed plus recorded pending funds, assuming normal confirmation. Keep the confirmation breakdown in inventory and remove the separate reference line.
- Apply the same planning balance to the monitor report. Preserve stored observations, spending rates, small-output exclusions and historical backtests; do not invent historical mempool balances.

## 2.5.1 — pending funds and confirmed-only projections (2026-10-06)

- Label chart and report funding balances as confirmed-only. Show a separate confirmed-plus-pending reference for collected observations; historical mempool balances remain unknown.
- Show “Awaiting confirmation” without a depletion forecast when confirmed funding is zero but pending outputs remain. Preserve stored balances, estimates and historical backtests.
- Check the operator-reported deployed revision `d24ebe2`: new commits require confirmed inputs above 546 sats; qualifying reveals can spend an unconfirmed parent, but no automatic CPFP fee-bumping path was found. Distinguish that release from newer upstream's RBF replacement machinery and 546-sat eligibility.

## 2.5.0 — continuously updated time machine (2026-10-06)

- Use the monitor’s collected wallet observations for current balances and runway, with automatic page refresh and explicit data timestamps. Preserve the original replay and its wallet backtests.
- Refresh the mainnet seasonal fee study hourly on Vercel from newly captured mempool history and recorded pressure observations; preserve first-observed bucket values and causal daily forecasts.
- Hide stale current wallet/fee estimates, leave missing history as chart gaps, and mark collector-unrecorded alternative models unavailable.
- Add schema 3 for an independent research lease, the last successful fee study, and durable daily wallet samples. Reads remain read-only and Signet keeps its own collection separate.

## 2.4.4 — consistent time machine design (2026-10-06)

- Match the hosted time machine to the monitor's heading, network banner, system typography, navy controls and plain bordered panels. Share the monitor stylesheet across both pages and retain the saved analysis and interactive controls.

## 2.4.3 — hosted fee analysis time machine (2026-10-06)

- Link the combined fee analysis and wallet time machine from Operator controls on both deployments.
- Publish the saved mainnet dashboard at `/time-machine.html`, preserving its wallet slider, forecast comparisons and seasonal fee analysis. Show the wallet and fee-study timestamps, a saved-snapshot label and a return link.
- Bundle the selected report with the application so subsequent Vercel builds retain it. No database migration or collector change is required.

## 2.4.2 — transaction-based block fees (2026-10-05)

- Calculate each block's median from actual non-coinbase transaction fees divided by `ceil(vsize)`, preserving fractional sat/vB. Do not use mempool's capacity-based or preliminary integer-valued `medianFee` for the report.
- Validate transaction counts, unique IDs and total fees against block metadata. Bound summary requests to 15 blocks, three concurrent requests and a 20-second enrichment deadline. A failed summary leaves that block unavailable without losing recommendations or other blocks.
- Exclude legacy/unavailable block statistics and coinbase-only blocks from 24-hour averages; expose partial coverage and excluded counts. Preserve a verified same-block result across failed retries, while replacing it on reorgs.
- Show positive rates below display precision as `<0.01`, keeping genuine zero-fee transactions distinct. No database migration is required; corrected historical coverage accumulates through normal collections.

## 2.4.1 — preserve small fee trends (2026-10-04)

- Keep the correct up/down arrow when a real fee change rounds below 0.1%; display `<0.1%` instead of reporting an unchanged rate.

## 2.4.0 — readable wallet report (2026-10-04)

- Replace the dashboard's diagnostic text with the agreed EE/OL report, shared latest posted Strata epoch, concise data-quality checks and collapsed transaction details.
- Show UTC alongside the browser's client timezone, including daylight-saving offsets and dates. Text API clients can pass an IANA `timezone` parameter; UTC is the default.
- Show combined commit/reveal publication fees and effective sat/vB, with arrows against the same wallet's preceding 24-hour and seven-day average publication rates. Exclude the target and later completions; incomplete history remains unavailable.
- Estimate the next commit confirmation from observed commit intervals. Missed estimates remain overdue; stale or insufficient history does not produce a new date.
- Aggregate stored Bitcoin block median fees and time-weighted mempool recommendations over 24 hours. Deduplicate blocks, expose gaps and partial coverage, and keep Signet/mainnet evidence separate.
- Use existing snapshot JSON and stored fee evidence; no migration or additional upstream calls on report reads. DA backlog sizing and future DA cost estimation are outside this release.

## 2.3.0 — Signet support and L1 posting progress (2026-10-04)

- Combine the mainnet monitor and isolated public Signet deployment, with network-labelled pages, Signet fee sources, verified Sparrow descriptors and local wallet export/import tools.
- Report the most recent observed OL checkpoint epoch and fully posted EE DA update, including Bitcoin transaction IDs, posting blocks and covered OL/EVM progress. Keep their independent sequence numbers and coverage limits visible in live reads and historical replay.
- Decode the Alpen v0.3.2 posting formats; configure Signet's observed `ALPN` checkpoint marker separately from mainnet's `STRA`. Publication does not establish proof validity or protocol acceptance.
- Preserve bounded, validated posting headers through compact database history so EE and OL progress survives subsequent collections without retaining full witness payloads. Older compacted records remain explicitly undecodable until refreshed.
- Retain Signet's guarded exact-inventory cache for provider UTXO limits. Network and provider changes, new address activity and reorgs fail closed. No database migration is required.

## 2.2.0 — stranded output consolidation (2026-10-02)

- Link **Consolidate stranded outputs** from Operator controls at the bottom of the app home to a dedicated consolidation page.
- Show each wallet's confirmed stranded output count, total value, fee rate, estimated transaction fee and spendable amount after confirmation.
- Adjust the fee in 0.1 sat/vB steps and download an unsigned PSBT for the selected rate. Return funds to the same wallet and recheck inputs before download; signing and broadcasting stay in the operator's wallet.
- Add clearly labelled sample-data staging, a link back to the main application, and PSBT construction/validation coverage. No database migration or collector accounting change.

## 2.1.0 — replay and durable fee evidence (2026-10-02)

First tagged release. Includes the public dashboard and existing production collector, wallet replay, and the experimental fee research tools. Operational wallet runway keeps its existing formula; seasonal forecasts and calibration remain local CLI/report features.

### Fee evidence and evaluation

- Preserve hashed fee/provider/completed-block observations beyond run retention with an additive optional migration.
- Respect observed availability, preserve causal forecast snapshots, and freeze prospective evaluation rules.
- Compare rolling/EWMA/weekday-hour models, rolling/regime calibration, and training-only pressure challengers; expose coverage, pinball loss and effective samples.
- Join historical fee forecasts to replay and show saved-fee freshness/fallbacks without changing wallet runway.
- Automatically apply runtime database permissions during release, including append-only fee evidence. Deploy schema-compatible code before the additive migration.
- No EE sizing change or additional scheduler.

### Seasonal fee experiment

- Add multi-resolution mainnet fee archives, daily/weekly seasonal fitting, a recent baseline and an experimental decaying projected-block pressure correction. Add `pnpm fees` fetch/import/observe/run/report commands and reproducible walk-forward p50/p90 evaluation.
- Add a portable interactive fee report, optional attachment to the wallet time machine, annual pattern comparisons and coverage diagnostics. Capture pressure alongside recommendations without changing wallet runway or adding a scheduler.
- Evaluate four years of history: seasonality improves central accuracy in the initial test, while p90 undercoverage and absent historical pressure keep the model experimental. EE sizing remains out of scope. See [methodology and findings](docs/seasonal-fees.md).

### Time machine

- Add resumable authenticated Alpen archives, confirmed-height chain reconstruction, shared live/replay scanning, and offline `pnpm replay` fetch/run/report/export-observations commands.
- Preserve the current runway formula and compare its consumption forecasts against complete 7-/30-day means at 1/3/5/7-day horizons. Report matched errors, optimistic misses, interventions, missing outcomes, non-overlapping samples and censored exhaustion diagnostics.
- Bundle an interactive local HTML report with block/date controls, playback, model filters, training inputs and worst predictions. Record deterministic provenance separately from execution timestamps.
- Refine the report with bundled Bootstrap and Chart.js: explicit EE/OL roles, accessible control explanations, dated balance burndown through projected zero, funding markers, clear spending-error rankings, and methodology/questions at the bottom. Forecasts and backtest scores remain unchanged.
- Fix completed archives remaining stuck at their first capture boundary. Fetch now advances to newer finalized blocks while preserving prior seals; `pnpm replay refresh` captures, replays and rebuilds in one command. Open the report at its latest captured balance and label funding amounts, including deposits after the prior cutoff.
- Capture free mempool recommendations once per leased collection. Persist optional quote context and compact issued forecasts in versioned existing run JSON, with durable fee evidence in migration 2; retain legacy reads and the read-only API boundary.
- Complete a real EE/OL audit through finalized block 969456. See [time-machine findings](docs/time-machine.md) and [verification](docs/release-verification.md).

### Public reads and private Esplora

- Require an explicit stable version tag for production releases and manual workflow runs; validate it against the app version and record the tag/commit in Vercel deployment metadata.
- Make the dashboard and JSON/text/Prometheus reads public at the user's request. Load status on page open; place authenticated manual collection under Operator controls.
- Remove the obsolete metrics bearer requirement while preserving the read-only database role and cron/refresh authentication.
- Add environment-backed query-token authentication and select the supplied private Alpen Esplora as mainnet primary, with public failovers.

## 2.0.0 — initial steps 1–2 implementation

- Bootstrap strict TypeScript/Vercel/Postgres application, migrations, CI and deployment workflow.
- Validate and derive EE/OL watch-only descriptors; gap-scan both chains and measure exact UTXO partitions.
- Add resumable settlement sampling and explicitly naive runway from observed commit/reveal drain and median cadence.
- Add authenticated JSON, text and metrics, manual refresh, periodic collection, fenced leases and stale-read reporting.
- Preserve configurable network/Signet and pure replay boundaries. Full simulation, confidence bounds, alerts and historical replay remain deferred.

The original release is deployed. See the release verification record for the deployment status of subsequent changes.
