# Open questions and release setup

## Current steps 1–2 status

- Mainnet descriptors and six vectors are supplied and validated. No descriptor credentials are required.
- Vercel: `ee-ol-wallet-monitor.vercel.app` is deployed in `alpen-labs`. A scheduled collection completed successfully. The user manages deployments through the dashboard; CLI sign-in is not required for that workflow.
- Postgres: the stamped mainnet Neon database is initialized, with verified TLS and separate pooled collector/read-only roles. Local collection writes directly to it.
- Application auth and database credentials are configured privately in the local `.env` and Vercel Production. No secrets need to be pasted into chat.
- Q-02: the internal mainnet Esplora URL and query-token scheme are supplied. Both wallets collected successfully through it locally. Deployment of this provider change and cloud connectivity verification remain pending; version, server limits and rate limits are still not supplied.
- Q-01 resolved October 2, 2026: public Signet descriptors were supplied by the operator; receive/change vectors were independently observed through both indexers and a nonzero checkpoint verified. The separate purple Signet deployment is live at `ee-ol-wallet-monitor-signet.vercel.app` with its own Neon database. Complete EE history and a fresh inventory were imported from a local export. A guarded cached-inventory path now handles capped addresses with no activity; Alpen's per-address limit should still be raised for future activity on those addresses. See [Signet verification](signet-verification.md).
- Grafana, alerts, selector simulation and replay are outside the human-set first release scope. Their plan questions do not block steps 1–2.
- Repository remote is the private `stefanopepe/alpen-l1-monitor`; the initial implementation is pushed to `main`.

## Plan register (preserved for later phases)

## P1. Blockers and open questions

Status as of planning. Keep this table in `docs/open-questions.md` and update it as answers arrive. "Proceeds meanwhile" never means "assume a value": it means building the parts that don't depend on the answer.

### 1.1 Blockers (a phase cannot complete without the answer)

| ID | Question | Bites at | What proceeds meanwhile |
|---|---|---|---|
| **Q-01** | **Resolved October 2, 2026.** Public Signet; operator-supplied EE/OL Sparrow descriptors; independently observed receive/change vectors; verified block-1 checkpoint; Alpen Signet indexer configured. | Configuration, deployment and local EE import are complete. Cached inventory handles inactive capped addresses; new activity still requires an unrestricted complete inventory. | See [Signet verification](signet-verification.md) for evidence and the remaining provider limit. |
| **Q-02** | **Internal mainnet Esplora** (brief OQ2): base URL, auth scheme, which electrs fork and version, the `--utxos-limit` value, rate limits, whether `/block-height/{h}`, `/address/{a}/txs/chain/{txid}`, `/tx/{txid}/outspend/{vout}` are exposed, **and whether it is reachable from the public internet or IP-allowlisted.** Vercel egress IPs rotate. Static IPs cost $100/month per project on Pro. A private-network-only indexer needs Secure Compute (Enterprise only). | **Stage A entry** (P11.7). The service must not become part of the funding-critical path on public providers. | Everything, including M-1. Stage 0 may run with the public Esplora providers only, flagged as such (D-70). This is not a workaround: nobody relies on Stage 0. |
| **Q-03** | **Deployed sequencer build per network and per writer** (brief OQ4, first half): the alpen commit SHA running the EE writer and the OL writer on mainnet (and signet). Is EE the chunked EE-DA writer? What are the mainnet `btcio.writer.fee_bumping` values and the signing mode (these decide whether reveal outputs are exactly 546)? | **Stage A exit** (humans may not step down). It also fixes the manifest pin (`deployed_build_confirmed`). | Implement §4.4 as written. Ship with `deployed_build_confirmed=false`, visible on the dashboard. Fingerprint metrics (D-23) gather evidence meanwhile. |
| **Q-04** | **Consolidation outside the selector** (brief OQ4, second half). Who created the six dust-sweep transactions at height 969093, will it happen again, and is it a procedure? Are there other spenders of these wallets? | **Stage A exit**, and acceptance of the anchored AC3 fixture (WU-09). | Classification (`internal_consolidation`) and counting. The runway model does not change. |
| **Q-06** | **Grafana topology** (brief OQ3): Cloud or self-hosted; whether the Metrics Endpoint (hosted scrape) integration or a Prometheus/Alloy scraper is available; which Slack channel receives the shadow alerts; later, WARN vs CRITICAL contact points and the pager. | **M-1**: no alert can fire anywhere without a Grafana stack and one contact point. Stage B needs the paging contact point. | All service code. The Terraform module in `ops/grafana` can be written against variables. **Ask now; this is on the critical path.** |
| **Q-07** | **Repository name, owner and visibility** (brief OQ7, first half). | WU-00 push and CI. The GitHub schedule auto-disable (public repos, 60 days) and xpub exposure (Q-17) both depend on visibility. | Local development. |
| **Q-08** | **Pinned sequencer SHA per network** (brief OQ7, second half). | Manifest finalisation (WU-12) and Stage A exit. | Pin the SHA the brief read, `7f20dcb65fa478c9654626b77a05ea789d28806a`, with `deployed_build_confirmed=false`. That is the brief's own model input, not an assumption about deployment. |

### 1.2 Model inputs and definitions to confirm (the plan has decided; the owner confirms before Stage A exit)

| ID | Decision taken | Why it needs confirmation |
|---|---|---|
| Q-05 | `settlements_per_day = 86400 / median inter-commit interval`, taking the larger of the 7-day value (when it has enough intervals) and the 30-day value (D-13). | The brief never defines it. It is the only reading that reproduces the brief's figures, but a sample that missed addresses would produce the same pattern (chain-data analyst). It scales every drain and runway figure by up to 1.54× (11.9 / 7.72, arithmetic). |
| Q-09 | Alert level uses the **p90 CI upper bound** (D-15), per §5.1 and §13, not §4.5's plain `realized_rate_p90`. | The brief contradicts itself; the plan follows the more specific and more conservative text. |
| Q-10 | Realized effective fee rate = **package rate** `4·(fee_commit + Σfee_reveal) / (weight_commit + Σweight_reveal)`, with vsize = weight/4 (unrounded) (D-10). | Not stated in the brief. It is the only rate that makes §4.3's formula reproduce a settlement's own cost exactly. The brief's own p50 (2.84) looks like a **commit-only** rate (P0 item 5), so the service's quantiles will run a few percent higher. That is the conservative direction. The brief's 171/132 vB equal the probed EE pair's weights (685, 529) divided by 4 and truncated. |
| Q-11 | Fallback basis when the p90 CI upper is unavailable or `n < min_sample`: the **maximum realized rate in the 30-day window** (D-12). | §5.1 says "most conservative available basis" without defining it. For 36 ≤ n ≤ 53 the exact CI upper already equals the sample maximum, so the fallback is continuous with the regular basis. |
| Q-12 | Largest-UTXO CRITICAL compares against `cost_per_settlement{scenario="p90_ci_upper"}`, i.e. cost, literally as §13 says, not `required = cost + 546` (D-64). | §13 does not name a scenario. The selector's real single-input threshold is cost + 546. |
| Q-13 | Dead-man threshold **3300 s**, stamped from scan start, rather than §13's 3600 s (D-62). | With 3600 s and a 15-minute cadence, AC5 ("within one hour of killing the cron") is unachievable: the worst case is 3600 s plus evaluation and delivery latency. |
| Q-14 | A downward regime shift (ratio < 0.67) moves thresholds to the 7-day window and **lowers** them, as §9 literally says. Implemented as written. | This reduces warning margin, which cuts against §1's guarantee. Confirm it is intended. |
| Q-15 | Under a regime shift, only the **fee-rate** inputs switch to 7 d. The settlement-vsize median and the cadence do not follow the regime flag. Each always takes the **larger** of its 7-day and 30-day value, whenever the 7-day sample is large enough (D-13, D-40). | §9 says "threshold computation" without naming which inputs switch. A 30-day median lags a cadence or payload increase by about 10 days (arithmetic), which exceeds the 5-day guarantee. Taking the larger value is always conservative. |
| Q-16 | `insufficient_data = 1` also while ingested history does not yet cover the 30-day window (D-12, coverage gate). | §5.1 defines insufficiency by sample size only. A partial backfill can exceed n = 30 on a sample biased toward recent data. |
| Q-18 | The §4.4 simulator uses one median commit vsize even for multi-input selections. The real commit is about 67.75 vB larger per extra P2WPKH input (arithmetic), so runway is slightly optimistic exactly at the cliff. Implemented as written. | This is a §4 fidelity question for the owner, not an implementation choice. |
| Q-19 | Manual dust sweeps (point 2 in §0) make "stranded" recoverable by operator action. The runway model never assumes a future sweep, so it stays conservative. Implemented unchanged. | §3.2 says consolidation outside the code path means §4.4 "must be re-derived". The plan's view is that an operator sweep is an external event, like a top-up, and needs no re-derivation. The owner decides. |

### 1.3 Minor or operational (decide on arrival; defaults are in the plan)

- **Q-17** Descriptors (xpubs) in the repo. Decision: they live in `config/networks/*.json` and the repo is private. If the repo must be public, move the descriptor strings to env vars referenced by name from the JSON. That is a config change, not a code change.
- **Q-20** Retention for operational tables not covered by §9 (runs, events, anomalies, drift checks, network fee snapshots). The plan uses 90 days in config pending ops (brief OQ8). **OQ8 itself (the §9 tiers) must be answered within 14 days of Stage A start, before the first snapshot purge.**
- **Q-21** Does the sequencer's bitcoind wallet hold any descriptor other than the two `wpkh` ones (for example `tr()`)? §4.1 counts P2TR as spendable, but a wpkh scan can never see it. Answer before Stage A exit.
- **Q-22** Is an external watchdog on Grafana alerting itself required? Nothing in this design detects a dead Grafana evaluator. Ops decision, before Stage C.
- **Q-23** How §5's OL 6-day level of 61,668 was derived. It cannot be reproduced from any stated input (EE's 181,483 is explained by an unrounded cadence of 24/2.02). No test asserts it.
- **Q-24** What the overnight watchers check today (tool, frequency, trigger). Needed to define Stage A reconciliation.
- **Q-25** Collection interval. The plan decides **15 minutes** (D-60); §9's "~96 rows/day" assumed 30. At 30 minutes, AC5 cannot be met while also tolerating a single missed run (arithmetic).
- **Q-26** Can the brief's author supply the raw data behind §5/§5.1: the settlement txids per sample (EE 105/117, OL 87), their extraction windows, the snapshot height or time, and the quantile and CI method? This would turn the P9.5 diagnostics into real oracles. It is not blocking, because AC3 does not depend on it.

---
