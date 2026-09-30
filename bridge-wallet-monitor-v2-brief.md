# BRIEF: Bitcoin sequencer wallet runway monitor ("bridge-wallet-monitor v2")

**Audience:** a planning model with no prior context, producing an execution plan for a
coding session. This document is self-contained. Nothing here depends on prior conversation.

**Status:** requirements + validated domain model. No code exists yet for v2. A previous
v1 monitor existed, failed in production, and its failure mode is the reason this document
is specific about definitions.

---

## 1. Mission

Build a service that answers one question correctly and continuously:

> How many days until the Alpen sequencer's Bitcoin wallets can no longer post checkpoints?

and raises an alarm with **at least 5 days of usable warning** before that happens.

The previous system reported ~20 days of runway while the true figure was under 5. It did
not fail from bad plumbing. It failed because it measured the wrong quantity. Treat the
definitions in section 4 as the core deliverable; the hosting is incidental.

---

## 2. Domain background

Alpen Labs runs a Bitcoin rollup. A sequencer posts checkpoints (and, when enabled, data
availability blobs) to **Bitcoin mainnet** on a fixed cadence. Each posting is a
**commit + reveal transaction pair** following the standard inscription/envelope pattern:

- **Commit tx** — spends the sequencer's wallet UTXOs. Creates a P2TR output funding the
  reveal, plus a change output back to the wallet.
- **Reveal tx** — spends that P2TR output. Carries the payload in its *witness*. Has an
  `OP_RETURN` output and a **546-sat dust output paid back to the sequencer**.

The reveal is not spent from a wallet address, so a monitor that only reads wallet
addresses sees the commit and misses the reveal entirely. Reveal fees are real money and
must be counted.

Two wallets are monitored, independently. They are separate infrastructure and must never
be aggregated into a combined balance:

| name | role | approx cadence |
|---|---|---|
| **Alpen EE** | execution environment checkpoints (+ DA when live) | ~2.0 h |
| **Alpen OL** | orchestration layer checkpoints | ~10.0 h |

---

## 3. Why v1 failed — read this before designing anything

Two independent defects, both about *composition* rather than totals.

### 3.1 Aggregate balance hides UTXO composition

v1 called the Esplora endpoint `/address/{addr}` and used
`chain_stats.funded_txo_sum − chain_stats.spent_txo_sum`. That is a scalar. It cannot
express how the balance is split across UTXOs. v1 never called `/address/{addr}/utxo`.

The sequencer's wallet does **not** rotate to a fresh change address per spend — change
returns to the same address that holds the main balance. So one address simultaneously
holds the working capital and an accumulating pile of tiny outputs, and the aggregate
number looks healthy throughout.

### 3.2 The sequencer cannot spend most of what it holds

This is the decisive one. Authoritative source:

```
Repository   https://github.com/alpenlabs/alpen
File         crates/btcio/src/writer/builder.rs
Raw          https://raw.githubusercontent.com/alpenlabs/alpen/main/crates/btcio/src/writer/builder.rs
Branch read  main
Commit shown for crates/btcio/src/writer at time of reading:
             7f20dcb  "refactor(btcio): Expose fee rate api (#2269)"
```

Access note for whoever fetches this: the github.com REST API and the repository tarball
endpoints returned 403 from the environment used here; `raw.githubusercontent.com` served
the file without issue. GitHub code search requires an authenticated session. Pin a commit
SHA rather than tracking `main` — see section 10.

**(a) A pre-selection filter excludes dust outright.** In `fund_commit_transaction`:

```rust
let utxos: Vec<ListUnspentItem> = utxos
    .iter()
    .filter(|utxo| {
        utxo.spendable
            && utxo.solvable
            && utxo.amount.to_sat() > BITCOIN_DUST_LIMIT   // strictly greater than 546
            && is_supported_commit_utxo(utxo)              // p2wpkh or p2tr only
    })
    .cloned()
    .collect();
```

`BITCOIN_DUST_LIMIT = 546`. Every reveal returns a dust output of **exactly 546**. The
filter admits only values **strictly greater than** 546. Therefore **every dust output the
system creates is permanently unspendable by the system that created it**, at any fee rate.
This is not a prioritisation heuristic — those UTXOs never enter the candidate set.

**(b) Selection takes exactly one input when it can.** `choose_utxos`, reached via
`fund_commit_transaction` → `select_commit_utxos` → `choose_utxos`:

```rust
// comment in source: "Choose utxos almost naively."
let mut bigger_utxos = utxos.iter().filter(|u| u.amount.to_sat() >= amount).collect();
if !bigger_utxos.is_empty() {
    bigger_utxos.sort_by_key(|&x| x.amount);   // ascending
    let utxo = bigger_utxos[0];                // SMALLEST SUFFICIENT
    Ok((vec![utxo.clone()], sum))              // exactly one input
} else {
    let mut smaller_utxos = utxos.iter().filter(|u| u.amount.to_sat() < amount).collect();
    smaller_utxos.sort_by_key(|x| Reverse(&x.amount));   // descending
    for utxo in smaller_utxos {
        sum += utxo.amount.to_sat();
        chosen_utxos.push(utxo.clone());
        if sum >= amount { break; }            // stops as soon as it has enough
    }
    if sum < amount { return Err(EnvelopeError::NotEnoughUtxos(amount, sum)); }
}
```

Consequences the plan must encode:

1. **There is no consolidation path anywhere in this logic.** The multi-input branch is a
   funding fallback, not a sweep: it takes the *fewest, largest* inputs that cover the
   amount and stops. It also cannot see the 546s, which were filtered upstream.
2. Because selection picks the **smallest sufficient** UTXO, spending grinds one UTXO down
   through successive change outputs, then abandons a remnant in `(546, required)` and
   moves to the next. Remnants are a second fragmentation source beyond the 546s.
3. Terminal state is `NotEnoughUtxos` — the sequencer stops posting while a block explorer
   shows a healthy balance.

**Provenance and scope of this reading.** The above was read from
`crates/btcio/src/writer/builder.rs` on the `main` branch. It is stated here as the model
input the monitor must reproduce, not as a finding about the codebase. Two facts about the
deployed system are inputs to the runway model and should be confirmed as such before the
numbers are trusted: which build mainnet runs, and whether any consolidation occurs outside
this code path. If either differs from the above, the runway model in section 4.4 must be
re-derived — the monitor's job is to model the wallet behaviour as actually deployed.

**Out of scope.** This service observes and reports. It does not change wallet behaviour,
sign transactions, consolidate outputs, or recommend changes to the sequencer.

---

## 4. Definitions — the core deliverable

### 4.1 Spendable balance

Mirror the sequencer's own filter exactly. Anything else reproduces the v1 bug.

```
spendable = Σ utxo.value  for utxos where
                 utxo.value > 546
             and scriptPubKey is P2WPKH or P2TR
             and utxo is confirmed

stranded  = Σ utxo.value  for utxos where utxo.value <= 546
```

Source data must be `/address/{addr}/utxo`. Aggregate endpoints are forbidden as a balance
source; they may be used only as a cheap change-detector (`tx_count`).

### 4.2 Address discovery

Both wallets are BIP84 (`wpkh`) accounts at `m/84'/0'/0'`, dual-chain `<0;1>`. Addresses
rotate over time: during the incident window the active receive index moved from `0/2` to
`0/4`, and the change chain extended past `1/10`. A fixed address list will silently go
blind. Required behaviour: derive from the descriptor and **gap-scan both chains** — scan a
minimum number of indices, continue until N consecutive unused addresses, with a hard
ceiling. Suggested defaults: minimum 6, gap limit 20, ceiling 50.

Descriptors (watch-only — extended **public** keys, no signing capability):

```
Alpen EE: wpkh([145638e2/84h/0h/0h]xpub6DXhkgumY1NGrkcT6YEakg81r5CWugPEyU61fXQTF3mySMpwBAnNUyxHJiNaM969HxJGCay7cWaEsvSWbh3VZGqCVZUkGsCpBotsasGp6Ui/<0;1>/*)#lecc6wxp
Alpen OL: wpkh([c482a5ea/84h/0h/0h]xpub6DNMBbGP7Yr8gqmo4EMMp5fBqnh1Z5YMDC5M9rZiLQCdRp5SWEF2jefPgNroJ3fYmqWjKmTRmGiYuDTpitkxJotYgBDTg3bgNnzr57HW3fH/<0;1>/*)#qj7slk5k
```

Derivation test vectors (verified on mainnet — a derivation bug must fail loudly at startup
against these, not silently produce an empty wallet):

| wallet | path | address |
|---|---|---|
| EE | `0/1` | `bc1qm3qjapenndvyq0vgjqfv2pfwc2w27j3h480ynh` |
| EE | `0/2` | `bc1qeuu2a0fw92y8fjk4c4jqhd98llurdm89u099fq` |
| EE | `1/0` | `bc1qfrhdjylgn50g76tq4qmp8jmg9dtv2q28ge79wf` |
| OL | `0/1` | `bc1qhc5pezg88kksj9nkdj9lwlhl2pr8vt96qtke57` |
| OL | `0/2` | `bc1qhrpjjt92aqf4t7459hryw3cgd0385jxe3xa5l7` |
| OL | `1/0` | `bc1qvyvrpktcwfwsrjdda5tremkyaanvxzswthr08f` |

### 4.3 Cost per settlement

```
cost(rate) = (commit_vsize + reveal_vsize) * rate + 546
```

The `+546` is balance converted to permanently unspendable dust, not a fee. It must be
counted as drain.

Reveal vsize requires following each commit to its reveal: take the commit's non-wallet
P2TR output address, find the transaction spending it, read its vsize and fee. Cache this
per commit txid — it is immutable once confirmed.

Model validation against measured mainnet data (2026-09-29):

| wallet | commit vB | reveal vB | predicted @p50 | observed net | error |
|---|---|---|---|---|---|
| EE | 171 | 132 | 1,403 | 1,436 | 2.3% |
| OL | 152 | 397 | 2,097 | 2,206 | 4.9% |

The coding session should reproduce this validation as a test.

### 4.4 Runway

Do **not** compute `spendable / cost`. The drain is not uniform — see 3.2(2). Simulate the
actual selector:

```
pool = [u for u in utxos if u.value > 546]
required = cost(rate) + 546          # code reserves a dust-sized change excess
loop:
    selected = choose_utxos(pool, required)     # faithful port of the Rust
    if selected is None: break                  # NotEnoughUtxos
    remove selected from pool
    change = sum(selected) - cost(rate)
    if change > 546: pool.append(change)
    settlements += 1
runway_days = settlements / settlements_per_day
```

Compute at **p50** and **p90** of the wallet's own realized effective fee rate. **Do not
use p99** — see 5.1; it is not estimable from the available sample.

### 4.5 Alert threshold

```
drain_per_day = settlements_per_day * cost(realized_rate_p90)
trigger_5d    = 5 * drain_per_day
alert_level   = 6 * drain_per_day
```

Alert at 6 days, not 5: the collection interval adds detection latency, and a 5-day
threshold checked daily delivers 4 days of warning. This must **not** be a fixed satoshi
constant — p90 nearly doubles the drain versus p50, so recompute every run from the
current realized distribution.

---

## 5. Measured constants (2026-09-29)

Starting values only. The service must recompute all of these. Do not hardcode.

| | Alpen EE | Alpen OL |
|---|---|---|
| sample | 105 commit txs / 13.6 d | 87 commit txs / 40.5 d |
| realized fee rate p50 / p90 (sat/vB) | 2.84 / 6.60 | 2.82 / 6.72 |
| cadence | 2.02 h (11.9/day) | 10.01 h (2.4/day) |
| spendable | 112,249 | 110,680 |
| stranded (≤546) | 5,460 (10 UTXOs) | 0 |
| runway @p50 / @p90 | 6.6 / **3.6** d | 21.7 / 10.4 d |
| 6-day alert level | 181,483 | 61,668 |
| multi-input commits in sample | **8** | 2 |

**EE was already below its 5-day trigger when measured.** Expect the first production run
to fire immediately; that is correct behaviour, not a calibration error.

Bitcoin network inclusion cost, per-block median fee rate: **p50 1.0, p90 2.0, p99 4.0**
sat/vB (n = 1,105 blocks over 3 months).

### 5.1 Statistical support for the quantiles — read before trusting a threshold

Nonparametric 95% confidence intervals via order statistics, computed on the raw series:

| wallet | n | span | quantile | value | obs above | 95% CI |
|---|---|---|---|---|---|---|
| EE | 117 | 14.6 d | p50 | 2.84 | 57 | [2.08, 2.92] |
| EE | 117 | 14.6 d | p90 | 6.60 | 11 | [4.92, 9.26] |
| EE | 117 | 14.6 d | p99 | 11.72 | **2** | **no upper bound exists** |
| OL | 87 | 40.5 d | p50 | 2.82 | 43 | [2.81, 3.04] |
| OL | 87 | 40.5 d | p90 | 6.72 | 9 | [6.55, 8.44] |
| OL | 87 | 40.5 d | p99 | 8.95 | **1** | **no upper bound exists** |

**p50 is well supported.** Use it freely.

**p90 is marginal and must be carried as a range.** EE's interval spans 4.92–9.26, which
propagates directly into the alert level:

| wallet | p90 basis | cost/settlement | drain/day | 6-day alert level |
|---|---|---|---|---|
| EE | CI lower 4.92 | 2,037 | 24,237 | 145,425 |
| EE | point est. 6.60 | 2,546 | 30,295 | 181,770 |
| EE | **CI upper 9.26** | 3,352 | 39,886 | **239,317** |
| OL | CI lower 6.55 | 4,142 | 9,941 | 59,644 |
| OL | point est. 6.72 | 4,235 | 10,165 | 60,988 |
| OL | **CI upper 8.44** | 5,180 | 12,431 | **74,586** |

Because the stated goal is *guaranteeing* 5 days of warning, the threshold should be driven
by the **CI upper bound**, not the point estimate. Using the point estimate accepts a ~1-in-20
chance the true p90 is higher and the warning correspondingly shorter.

**p99 is not a statistic at these sample sizes.** Two observations lie above EE's p99 and one
above OL's; the upper confidence bound does not exist. A closed 95% CI on a p99 needs roughly
**563 observations** — about 47 days at EE's cadence and 235 days at OL's. Drop it, or label
it explicitly as an unvalidated illustration.

**Serial correlation is not the limiting factor.** Lag-1 autocorrelation of the fee-rate
series is ρ = 0.203 for EE (n_eff ≈ 78) and ρ = −0.016 for OL (n_eff ≈ 90), so observations
are close to independent. The constraint is raw sample size and regime coverage, not clustering.

**The real limitation is regime coverage, and more samples will not fix it.** EE's 117
observations come from 14.6 days of a quiet fee market — over the trailing 3 months the
network's per-block median was 1.0 sat/vB at p50 and 2.0 at p90. No congested regime appears
in the sample. The measured p90 therefore describes *what this wallet paid during a calm
fortnight*, not what it will pay when the market is hot. Sampling the same calm period harder
does not address this.

**A composite estimator was tested and rejected.** The hypothesis was that decomposing the
rate into `network_p90 × wallet_premium` would borrow the network's much larger sample
(n = 1,105 blocks) and stabilise the estimate. It does not: the premium ratio is *noisier*
than the raw rate (coefficient of variation 0.94 vs 0.67 for EE; 0.75 vs 0.59 for OL),
because the sequencer's fee choice does not track the concurrent block median closely. Use
the wallet's own raw distribution. This negative result is recorded so it is not re-attempted.

**Required implementation consequences:**

1. Emit sample size and CI bounds alongside every quantile; a threshold derived from a weak
   estimate must be visibly weak on the dashboard.
2. Refuse to compute a quantile whose order-statistic rank exceeds the sample — return null
   and mark it unavailable rather than emitting a number that looks like a measurement.
3. Set a minimum sample floor (suggested: 30 observations) below which the wallet reports
   `insufficient_data` and falls back to the most conservative available basis.
4. Re-derive thresholds once a congested fee regime has actually been observed.

The wallets' realized effective fee rates run **2–3× the network block median**. This is a
measurement, recorded because it determines which distribution the thresholds must use: the
wallets' own realized rates, not the network's. See 14.6.

---

## 6. Leading indicator: multi-input commits

A commit transaction with more than one input proves `choose_utxos` found no single
sufficient UTXO and fell into the accumulate branch. This is the cliff announcing itself
days ahead, and it is visible in ordinary chain data.

Track the share of multi-input commits over a trailing 7 days. Suggested warning threshold
~10%. EE was already at ~8 in 13.6 days (~0.6/day) when measured.

---

## 7. Available infrastructure

- **Vercel** — paid team plan (confirm whether it maps to Pro or Enterprise; both give
  per-minute cron and ≥300s function duration, which is what this needs; only the free
  Hobby tier would not). Function limits: 300s default duration, 800s max on paid tiers,
  4.5 MB request/response body, rotating egress IPs by default.
- **Grafana** — available. Intended owner of thresholds, hysteresis, deduplication,
  escalation and notification routing.
- **Internal mainnet Esplora indexer** — available, operator-run. **Use this as the primary
  data source.** Public Blockstream returned HTTP 429 during analysis of this very problem;
  a funding-critical alert path must not depend on a rate-limited third party. Keep a public
  Esplora (blockstream.info, mempool.space — both Esplora-compatible) as failover only.
- **mempool.space** — needed for network fee distribution:
  `/api/v1/mining/blocks/fee-rates/{24h|1w|1m|3m}` gives per-block fee-rate percentiles;
  `/api/mempool` gives the fee histogram for inclusion-cost estimation.

---

## 8. Networks and configuration

The same service must run against **Bitcoin mainnet** and **public signet**. Network is a
first-class configuration dimension, not a fork of the codebase. Adding a network must
require no code change.

Everything below is network-scoped and must live in a declarative per-network config,
selected at runtime by environment variable:

| item | mainnet | signet | note |
|---|---|---|---|
| wallet descriptors | see 4.2 | **to be supplied** | watch-only xpubs |
| BIP84 coin type | `m/84'/0'/0'` | `m/84'/1'/0'` | testnet/signet use coin type 1' — **do not hardcode 0'** |
| bech32 HRP | `bc` | `tb` | derivation must be network-aware or it silently produces valid-looking wrong addresses |
| Esplora base URL | internal indexer | public signet indexer | |
| Esplora failover | blockstream.info, mempool.space | as available | |
| network fee source | `mempool.space/api` | `mempool.space/signet/api` | confirm route coverage |
| dust limit | 546 | 546 | protocol-level, identical |
| expected cadence | per wallet, measured | per wallet, measured | never assumed |
| thresholds | computed | computed | never shared across networks |

Additional requirements:

- Every database row and every metric carries a `network` label. Never mix networks in an
  aggregate.
- Derivation test vectors are required **per network**; startup validation must run against
  the vectors for the configured network only.
- Grafana dashboards and alert rules templated by `network`.

**Expectation-setting for signet:** signet fees are effectively free, so the fee-quantile
machinery will be inert there and its thresholds near-meaningless. The metrics that carry
over are the ones about *composition* — spendable vs stranded, UTXO counts, multi-input
ratio, largest-UTXO headroom. Those are network-independent because the selector logic is,
and they are the reason to run this on signet at all.

## 9. Data retention and regime awareness

Retention here is a **correctness** concern, not storage hygiene. A fee quantile computed
over all history describes a fee regime that no longer exists. Past fees do not bound future
costs, and the estimator must be deliberately short-memory.

**Tiers:**

| table | raw retention | then | long-term |
|---|---|---|---|
| `settlements` (one row per commit+reveal pair) | 90 d | daily rollup | rollup kept 2 y |
| `snapshots` (one row per collect run per wallet) | 14 d | daily rollup | rollup kept 2 y |
| `utxo_sets` | latest only, plus one daily sample kept 30 d | — | never retained in full historically |
| `daily_rollup` | — | — | 2 y |

**Quantile window:** rolling and configurable, **default 30 days**. Thresholds are never
computed over full history. Where the window yields fewer than the minimum sample (see 5.1),
the wallet reports `insufficient_data` rather than widening the window to reach a quorum —
widening trades a weak estimate for a stale one, which is worse.

**Regime-shift detection.** Each run compares the median realized fee rate over the trailing
7 days against the trailing 30. If the ratio falls outside a configurable band (suggested
0.67–1.5), set a `regime_shift` flag, prefer the shorter window for threshold computation,
and expose it as a metric and a WARN. This is what operationalises "past fees don't guarantee
future costs" rather than leaving it as a caveat in a document.

**On volume — do not over-engineer this.** Both wallets together produce roughly 15
settlements/day; at a 30-minute collection interval, snapshots add ~96 rows/day. Ninety days
of raw settlements is on the order of 1,350 rows. The purge job exists to keep the
*estimator* honest, not to save disk. It must be idempotent and must log the row count it
removed.

## 10. Repository, versioning and upstream tracking

**A new standalone repository.** Suggested: `alpenlabs/bridge-wallet-monitor`. It must not
live inside the sequencer repository: it has its own release cadence, and it must be able to
pin to *different* sequencer versions per network simultaneously.

Semantic versioning.

**The core versioning problem:** this tool models the behaviour of an external component it
does not own. If `crates/btcio/src/writer/builder.rs` changes upstream, this tool's runway
model can become silently wrong — the same class of failure as v1. The binding must be
explicit and machine-checked:

- A `SELECTOR_MODEL_VERSION` constant in the code, bumped whenever the ported selector
  semantics change.
- A **compatibility manifest** mapping `network → upstream repo + pinned commit SHA →
  SELECTOR_MODEL_VERSION`. Mainnet and signet may run different sequencer builds; the
  manifest must express that, and the runtime must report which build it assumes.
- Metrics: `bridge_monitor_version`, `bridge_monitor_selector_model_version`,
  `bridge_monitor_upstream_ref{network}`.

**Golden tests.** A fixture file of UTXO sets paired with expected selections, asserting the
Python/TypeScript port reproduces the Rust semantics — specifically: single-input selection
when any UTXO suffices, smallest-sufficient ordering, descending accumulate in the fallback,
and exclusion of everything at or below 546. Any change to the port must break a test.

**Upstream drift check in CI.** A scheduled job fetches `builder.rs` at the pinned SHA via
`raw.githubusercontent.com`, hashes it, and compares against a recorded hash. On mismatch,
fail the build with a message naming `choose_utxos` and `fund_commit_transaction` as the
functions to review. This is the mechanism that ties a writer/builder change to a version
bump of this tool, and it is the difference between discovering upstream drift in CI and
discovering it during an incident.

## 11. Architecture requirements

**Separate measurement from alerting.** The service computes and exposes; Grafana decides
and notifies. v1 hand-rolled hysteresis, cooldowns and edge-triggering in application code
and that logic was its buggiest part. Thresholds must be tunable by operations without a
deploy.

Required shape:

- **`/api/collect`** — cron-driven. Performs the scan, computes everything in section 4,
  writes one timestamped row per wallet to persistent storage. Protected by `CRON_SECRET`
  so it cannot be triggered externally. Idempotent.
- **Storage** — Postgres (e.g. Neon). Chosen over a key-value store because the trailing
  fee-rate distribution and the multi-input trend need real queries over 30–90 days, and
  because Grafana can read Postgres directly as a datasource.
- **Read path** — either a Prometheus exposition endpoint serving the latest stored row, or
  Grafana reading Postgres directly. Either way, **a Grafana scrape must never trigger an
  upstream Esplora call.** Collection cadence and read cadence must be independent.

Suggested collection interval: 15–30 minutes. The full scan is roughly 90 serial upstream
requests; with an internal indexer this is unconstrained, but keep requests serial and
rate-limited anyway so a failover to a public provider degrades rather than breaks.

---

## 12. Metrics contract

**Every metric below additionally carries a `network` label** (`mainnet` | `signet`).
Never aggregate across networks.

```
bridge_wallet_spendable_sats{wallet}
bridge_wallet_stranded_sats{wallet}
bridge_wallet_balance_sats{wallet}              # on-chain total, for contrast only
bridge_wallet_largest_utxo_sats{wallet}
bridge_wallet_utxo_count{wallet,bucket}         # bucket: dust|sub_threshold|spendable
bridge_wallet_cost_per_settlement_sats{wallet,scenario}
bridge_wallet_runway_days{wallet,scenario}      # scenario: p50|p90|p90_ci_upper
bridge_wallet_feerate_quantile_ci{wallet,quantile,bound}   # bound: lower|upper
bridge_wallet_feerate_sample_size{wallet}
bridge_wallet_feerate_sample_span_days{wallet}
bridge_wallet_regime_shift{wallet}                  # 0|1, see section 9
bridge_wallet_feerate_ratio_7d_over_30d{wallet}
bridge_monitor_version
bridge_monitor_selector_model_version
bridge_monitor_upstream_ref{network}                # pinned sequencer commit assumed
bridge_monitor_rows_purged_total{table}
bridge_wallet_alert_level_sats{wallet}          # the computed 6-day level
bridge_wallet_settlements_per_day{wallet}
bridge_wallet_multi_input_ratio_7d{wallet}
bridge_wallet_realized_feerate_sat_vb{wallet,quantile}
bridge_wallet_fee_premium_ratio{wallet}         # realized p50 / network block median
bitcoin_inclusion_feerate_sat_vb{quantile}
bridge_wallet_last_update_timestamp{wallet}     # dead man's switch
bridge_monitor_provider_errors_total{provider}
bridge_monitor_scan_duration_seconds{wallet}
```

---

## 13. Alert rules (defined in Grafana, not in code)

| severity | condition |
|---|---|
| WARN | `bridge_wallet_spendable_sats < bridge_wallet_alert_level_sats` (6-day level, computed from the **p90 CI upper bound** — see 5.1) |
| CRITICAL | `bridge_wallet_runway_days{scenario="p90"} < 2` |
| WARN | `bridge_wallet_feerate_sample_size < 30` — thresholds resting on an under-powered estimate |
| CRITICAL | `bridge_wallet_largest_utxo_sats < cost_per_settlement` — the `NotEnoughUtxos` cliff; late, but a guaranteed backstop |
| WARN | `bridge_wallet_multi_input_ratio_7d > 0.10` — fragmentation biting |
| WARN | no settlement in > 3× expected cadence — sequencer stalled, which presents as *rising* runway and is easily mistaken for good news |
| WARN | `bridge_wallet_regime_shift == 1` — fee regime moved; thresholds now rest on the 7-day window |
| WARN | upstream drift check failed in CI — the ported selector model may no longer match the deployed sequencer (section 10) |
| **CRITICAL** | `time() - bridge_wallet_last_update_timestamp > 3600` — **the monitor itself is dead** |

That last rule is not optional. v1's worst structural flaw was that a dead monitor and a
healthy system produced identical output: silence.

---

## 14. Non-negotiables

1. Never derive balance from an aggregate endpoint. `/address/{addr}/utxo` only.
2. Never treat a 546-sat output as an asset.
3. Never aggregate EE and OL into a single figure.
4. Never present a stale reading as current — every figure carries an "as of" timestamp,
   and staleness is itself an alert condition.
5. Alert on *spendable*, never on on-chain balance. As measured, EE's on-chain balance
   overstates usable funds by 5,460 and the gap widens ~6,552/day.
6. The fee-rate distribution driving thresholds must come from the **wallets' own realized
   rates**, not the network's, and not from a network × premium composite — see 5.1 for the
   measurement supporting both points.
7. Never emit a quantile the sample cannot support. p99 is not computable at current sample
   sizes; a number that looks like a measurement but is not is the failure mode this whole
   document exists to prevent.

---

## 15. Open questions for the planner

1. Does the paid Vercel plan in use map to Pro or Enterprise? (Either satisfies the
   requirement; confirm it is not Hobby.)
2. Internal mainnet Esplora: base URL, authentication, rate limits, and whether it exposes
   the standard Esplora routes (`/address/{a}/utxo`, `/address/{a}/txs/chain/{txid}`,
   `/tx/{txid}`).
3. Grafana: Cloud or self-hosted? Which datasources are already wired? Which Slack channel
   and which contact points should receive WARN vs CRITICAL?
4. **Model inputs to confirm** (section 3.2): which build mainnet runs, and whether any
   consolidation of outputs occurs outside the code path described. Both change the runway
   model if they differ from the stated assumption. These are inputs to be read, not work
   items for this service.
5. Payload variability: as measured, reveal witnesses were ~195 B and payload sizes flat.
   The cost model in 4.3 measures reveal vsize per settlement rather than assuming it, so
   it tracks variable payloads without change. Note only that thresholds computed from
   today's distribution assume today's payload profile, and should be recomputed if that
   profile shifts.
6. Signet configuration: wallet descriptors, derivation path (confirm coin type `1'`),
   indexer base URL, and whether `mempool.space/signet/api` exposes the fee-rate routes the
   model needs. Signet descriptors were not supplied with this brief.
7. Repository name and ownership for the new repo (section 10 suggests
   `alpenlabs/bridge-wallet-monitor`), and which sequencer commit SHA to pin per network.
8. Confirm the retention tiers and the 30-day quantile window in section 9 match what
   operations wants to keep for post-incident review.

---

## 16. Acceptance criteria

1. Derivation reproduces all six test vectors in 4.2, verified at startup.
2. Cost model reproduces the section 4.3 validation within 10% for both wallets.
3. Given the section 5 UTXO snapshot, the simulator returns EE ≈ 3.6 days at p90.
4. A wallet whose balance sits entirely in 546-sat outputs reports `spendable = 0` and
   fires CRITICAL — the exact case v1 reported as healthy.
5. Killing the cron raises the dead-man's-switch alert within one hour.
6. Forcing the primary indexer to fail routes to failover and increments
   `bridge_monitor_provider_errors_total` without gaps in the series.
7. An address-rotation event (activity appearing at a previously unused derivation index)
   is picked up on the next run without configuration changes.
8. No Grafana scrape produces an upstream Esplora request.
9. The service runs against signet using only a config change — no code edit, no rebuild of
   derivation logic — and startup validation rejects a mainnet descriptor configured against
   signet (and vice versa) rather than deriving plausible-looking wrong addresses.
10. The purge job reduces row counts to the section 9 tiers, is idempotent across repeated
    runs, and reports `bridge_monitor_rows_purged_total`.
11. A synthetic fee-regime shift (7-day median moved >1.5x against the 30-day) raises
    `regime_shift` and switches threshold computation to the shorter window.
12. Golden tests cover the four selector behaviours in section 10; mutating any one of them
    in the port fails a test.
13. The CI upstream-drift check fails when `builder.rs` at the pinned SHA differs from the
    recorded hash.
