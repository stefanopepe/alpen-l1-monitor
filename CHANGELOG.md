# Changelog

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
