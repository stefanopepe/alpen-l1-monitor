# Time machine

The time machine evaluates the current runway algorithm without changing its formula. It reconstructs what was visible at a confirmed Bitcoin height, predicts consumption, then scores that prediction against later commit/reveal packages. EE and OL are always scored separately. Fee recommendations are supplementary context, never inputs to this audit's models.

## Commands

Use the repository's Node 24/pnpm environment. Fetch and refresh need the existing `ALPEN_ESPLORA_TOKEN`; export needs `DATABASE_URL_METRICS`. Run and report need neither network access nor credentials. The pnpm launcher optionally loads `.env`, but an absent file is fine for offline commands.

```sh
# Mainnet EE/OL, finalized tip, all address history through configured ceilings.
# Repeating resumes an interrupted capture or extends the seal to newer finalized blocks.
pnpm replay fetch --network mainnet --archive .local/replay/mainnet

# Latest 90 days, every block, with at least 30 days of estimator warm-up.
pnpm replay run --archive .local/replay/mainnet --out .local/replay/audit-mainnet

# Capture later funding/spends, replay and replace the report in one command.
pnpm replay refresh --network mainnet --archive .local/replay/mainnet --out .local/replay/audit-mainnet

# Reproduce an earlier archive using the digest from its result manifest.
pnpm replay run --archive .local/replay/mainnet --seal ARCHIVE_DIGEST --out .local/replay/earlier-audit

# One height; outcomes can still use the archive's later blocks.
pnpm replay run --archive .local/replay/mainnet --from 967914 --to 967914 --out .local/replay/one-block

# UTC range; optional sampling changes which replay origins are produced.
pnpm replay run --archive .local/replay/mainnet --from 2026-09-01T00:00:00Z --to 2026-09-25T00:00:00Z --step blocks:144 --out .local/replay/sampled

# Export retained issued forecasts and quotes through a read-only transaction.
pnpm replay export-observations --network mainnet --out .local/replay/observations.json
pnpm replay run --archive .local/replay/mainnet --observations .local/replay/observations.json --out .local/replay/with-context

# Rebuild HTML from saved results, without any provider or database call.
pnpm replay report --out .local/replay/audit-mainnet

# Attach a separately fitted network-fee study (also accepted by run/refresh).
pnpm replay report --out .local/replay/audit-mainnet --fees-study .local/fees/study/study.json
```

Open the generated `report.html` directly in a current browser. Bootstrap controls/tooltips, Chart.js, CSS and compressed audit data are bundled in the file. Browser gzip `DecompressionStream` support is required. No CDN or external assets are loaded. The report opens with balance burndown at the latest captured block, including every discovered spendable deposit confirmed through that height. These are saved historical balances, not live wallet readings. The header shows the last recorded UTC timestamp; “Latest archived block” jumps to that saved endpoint without fetching new data. Run `pnpm replay refresh` to advance the local report, then reload the browser. The existing live collector continues updating independently every 15 minutes; opening or rebuilding HTML alone does not capture new chain data. Wallet selectors spell out EE as execution environment and OL as orchestration layer. Block/date navigation, previous/next and playback update the selected forecast.

The main chart shows recorded spendable balances and a separate constant-rate projection from the selected block. Its UTC date axis extends past the projected zero-balance point, which is marked and dated. Recorded balances stop at the last saved snapshot; shading identifies any later part of the chart. Funding markers and the newest-first wallet action list show the deposited spendable amount. Funding and wallet actions remain on the observed balance line and never revise the original projection. Missing estimates have no projected zero; a zero spending rate has no finite depletion date.

The accuracy section contains explained controls for 1/3/5/7-day spending periods, wallet actions and forecast spacing. These control the backtest, not the full runway projection. The model comparison retains availability, matched errors and improvement against both baselines. **Largest forecast errors** ranks the same matched forecasts used in the scorecard and states each period, predicted/actual spending and the amount the forecast was too low or too high. Selecting a row opens that original block's burndown. Inventory, training samples and wallet events expand on demand. Methodology, coverage limitations and open questions are at the bottom.

`--config FILE` can audit a compatible configuration against the same archive. It must preserve the network and wallet descriptors and cannot increase discovery ceilings beyond capture coverage. The 7-/30-day baselines keep fixed window lengths and use the configured short/long minimum settlement counts. Current-model parameters remain configurable. A longer current-model window requires corresponding archive warm-up.

Bulk capture defaults to the configured primary, Alpen. It never silently fails over. `--provider NAME` explicitly selects another configured provider. Provider/config changes within an existing archive directory are refused; use a new directory for a different provider. A completed capture advances on the next fetch/refresh, reusing sealed block headers, transaction history pages and reveal records. Mutable address heads and counts are reread. Every capture validates the configured chain checkpoint, prior finalized anchor and new anchor before and after traversal, and rejects any missing or changed previously sealed transaction. An interrupted Alpen capture resumes its pinned boundary on Alpen; another completed invocation can then advance again. The old `archive.json` stays usable until the new archive passes validation. Prior seals are retained by digest under `seals/`, sharing the deduplicated raw responses.

## Evidence and storage

All files live under ignored `.local/replay/` by default. Keep the sealed archive to reuse transactions across model runs:

| Artifact | Contents |
|---|---|
| `capture.json` | Resume boundary, provider and configuration fingerprint |
| `raw/`, `requests/` | Deduplicated successful response bodies and sanitized API-path references |
| `archive.json` | Versioned seal, addresses, transactions, contiguous headers, capture time, code revision and digest |
| `seals/` | Earlier immutable archive versions, selectable with `run --seal DIGEST`; raw responses remain shared |
| `manifest.json` | Result format version, archive/config hashes, actual implementation hash and revision, replay range/step |
| `snapshots.jsonl`, `forecasts.jsonl` | Per-wallet, per-height predictions and compact forecasts |
| `training.json` | Deduplicated training sets referenced by snapshots |
| `outcomes.json`, `scores.json` | Package accounting, window outcomes, availability, model errors and exhaustion diagnostics |
| `execution.json` | Volatile execution time and size metadata, separate from deterministic payloads |
| `report.html` | Portable interactive report |

Capture stores no credential values or authenticated request URLs. It uses the same environment-backed request construction as collection, rejects redirects, obeys provider pacing and retries network/rate/server failures with bounded backoff. Other failures leave resumable local evidence. Pagination, reported transaction counts, address membership, fee identities, prevouts, duplicate spends, header ancestry and transaction block hashes are checked before sealing. Loading verifies archive/raw response digests. Coverage is through the configured address ceilings, not an assertion about arbitrarily distant descriptor indices.

Raw blocks/transactions never enter the production database for this feature. Only compact fee observations and issued forecasts are added to existing `runs.results`, retained for the existing 90 days. Successful quotes, failed attempts and both wallet results share a version-1 envelope. The export reader also accepts legacy array-shaped results. Snapshots have an optional `feeContext`; older snapshots remain readable. Live reads label missing/unavailable or older-than-configured-freshness quotes accordingly. Replay itself adds no paid API, extra cron or database write path. The later local fee hardening iteration adds an optional collector-side durable evidence migration; see [seasonal fees](seasonal-fees.md#observation-and-evaluation-hardening-local-iteration).

The October 1 archive takes **19,789,084 logical bytes (19.8 MB)** for 1,266 transactions, 17,340 headers and all 200 addresses (50 indices × two chains × two wallets). The full 90-day audit, with the October 2 dashboard rebuild, takes approximately **92.2 MB**, including an **11.6 MB HTML report**, 25,906 snapshots, forecasts, training sets and scoring output. Filesystem allocated sizes can be larger. Each command reports measured logical bytes. This is one real workload measurement; longer histories, more addresses and more replay origins increase local storage. `--step blocks:N` reduces output size but also changes available evaluation origins.

## Reconstruction and scoring

Height controls visibility. A transaction, address use, spend or completed reveal package is visible only after its confirmation height. Historical UTXOs are created from outputs and removed only by visible spending transactions. Each origin starts fresh discovery/history state, so backward seeks cannot retain later knowledge. Offline history traversal is exhaustive; live collection keeps its existing budgets. Both call the same orchestration and snapshot formula.

The replay clock is the running maximum of block header timestamps. Original header/transaction timestamps are retained. This is a reconstruction, not the wall-clock instant an operator observed a block. It does not reconstruct mempool inventory, orphaned branches or historical provider latency. The finalized anchor is six confirmations behind the capture tip under the current mainnet configuration.

The current model uses its existing median settlement drain × median-interval cadence. Baselines sum complete observed settlement drain over 7 or 30 days and divide by the entire window length. They require complete discovery/history coverage and their configured sample floors. Pending reveal packages within a baseline window make its cost total unavailable. No later reveal fee enters a prediction at H. Delayed reveals can enter hindsight outcome accounting after H.

Forecasts multiply each daily estimate by 1, 3, 5 or 7 days; five days is the primary view. Future commits inside `(origin height, horizon endpoint]` own their eventual complete reveal packages, even if reveals finish after the horizon. Fees plus newly stranded wallet outputs are independently reconciled against spendable inputs minus returned spendable outputs. Missing packages, ambiguous ownership/classification and accounting mismatches make affected outcomes unscorable. Missing future coverage also yields null, never zero. Deposits never offset settlement consumption. Consolidations and unrelated spends are interventions, excluded from settlement consumption and visible in the timeline.

Daily origins are the first replayed block of each UTC day, including partial boundary days. Scores compare all three models on the intersection of eligible origins; availability and individual scorable counts are shown separately. Signed error is **prediction − observed consumption**: negative is optimistic. MAE is mean absolute error; bias is mean signed error; underprediction frequency counts negative errors. Optimistic p90 is the interpolated 90th percentile of `max(observed − predicted, 0)` across matched origins. Improvement is `1 − model MAE / baseline MAE`; a zero baseline MAE leaves that ratio unavailable.

Daily outcome windows overlap. The alternate sample selects origins at least the chosen horizon apart, independently of future eligibility, then applies the same availability and matching rules. The intervention-free subset excludes deposits, consolidations, unrelated spends and ambiguous events. Neither subset supplies a confidence guarantee or a pass/fail funding threshold.

The secondary exhaustion diagnostic accumulates settlement consumption against origin spendable funds. It records predicted days and the follow-up duration, censoring at the first intervention, unrelated spend, unresolved/ambiguous event or archive end. A cumulative crossing is a consumption diagnostic, not proof that the sequencer actually failed. Silence never establishes failure.

Provider context is joined only from a quote observed by the origin and still within the configured freshness interval. Missing historical quotes stay unavailable; mined block fees are never substituted. The first collection after this code is deployed starts continuous quote history. The existing production run export contained 15 legacy records and no quotes at verification time.

## First real audit: October 1, 2026

Alpen supplied the finalized anchor **969456**, hash `0000000000000000000111649e51da112d0a597d36f0cf549c6e7741388a4b06`. Archive digest: `3ffb038bcae209375433b4c15fabacdcad397176369b25a5485503360ae99c0f`.

The audit replays every block **956504–969456**, July 3–October 1, with 91 UTC daily origins per wallet and sufficient preceding warm-up headers. Wallet funding begins in August, so a 90-day range does not mean 90 days of useful predictions. The sealed archive contains 519 complete EE settlements and 104 complete OL settlements; all reconcile. There are seven deposits and 13 consolidation transactions in total, with no unresolved or ambiguous packages at the anchor.

Five-day scores, all eligible daily windows:

| Wallet | Matched origins | Current MAE, sats | 7-day mean MAE | 30-day mean MAE | Current underprediction | Optimistic p90, sats |
|---|---:|---:|---:|---:|---:|---:|
| EE | 36 | 9,585.9 | 8,129.0 | 34,580.5 | 91.7% | 14,558.2 |
| OL | 26 | 4,058.7 | 4,697.4 | 6,607.1 | 73.1% | 8,383.9 |

The current EE model has **17.9% greater MAE** than the seven-day mean; OL has **13.6% lower MAE**. Both tend to underpredict consumption. Removing intervention windows reduces the difference versus the seven-day mean to EE **0.8% worse** (25 matched origins) and OL **2.8% better** (24). For non-overlapping, intervention-free five-day windows, only **five EE and four OL origins** remain; their relative MAE differences are EE 3.7% worse and OL 4.1% better. Those small samples do not establish reliable outperformance.

Largest optimistic five-day errors for the current model, both without interventions:

| Wallet | Origin UTC | Height | Predicted sats | Observed sats | Underestimated sats |
|---|---|---:|---:|---:|---:|
| EE | 2026-08-28 00:22 | 964365 | 90,491.0 | 107,117 | 16,626.0 |
| OL | 2026-09-21 00:05 | 967914 | 26,084.4 | 38,279 | 12,194.6 |

The report allows inspection of each origin and its exact training samples. Current forecasts are available on 40 EE and 31 OL daily origins before future-coverage exclusions. Empty early wallets, sample floors and the final incomplete outcome horizons explain the remaining gaps. Historical quote coverage is zero, which does not block this wallet-only audit.

## October 2 refreshed audit

The October 1 seal ended at 969456; a **310,000-sat EE deposit confirmed in the very next block, 969457**, at 15:00:02 UTC. Refreshing through finalized block **969554** captures that deposit and later spending. The chart's confirmed spendable balance rises from **64,153 to 374,153 sats** at the funding block. At the new endpoint (October 2, 07:11:32 UTC), EE has **351,462 spendable sats / 20.38 days** and OL has **87,117 sats / 16.67 days**. A live snapshot at a later tip can differ because additional spending has occurred.

The updated archive contains **1,285 transactions, 17,438 headers and 200 addresses**. Including the retained earlier seal, it occupies **26.8 MB**; the updated 25,870-snapshot audit occupies **93.0 MB**, including **11.8 MB** of HTML. All 25,674 predictions overlapping the earlier replay have identical payloads. The extra future coverage makes one more five-day daily origin scorable per wallet: current-model MAE is now **9,782.6 sats for EE** (37 matched origins, 21.0% worse than the seven-day mean) and **4,057.3 sats for OL** (27, 13.1% better). These updated scores use the extended outcome coverage; the underlying forecast formula is unchanged.

Version-2 fee attachments retain daily forecast snapshots. Block navigation selects the most recent saved fee origin at or before the block time, with causal calibration and freshness labels. The latest saved fee view remains separately selectable. Missing fee snapshots never disable wallet replay.
