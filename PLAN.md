> **DRAFT, review in progress.** This file is the execution plan (no code, per the brief). It is being revised against adversarial review findings; this banner is removed when final.

# Execution plan — bridge-wallet-monitor v2

**For:** the coding session that implements the service.
**Inputs you receive:** this plan and `bridge-wallet-monitor-v2-brief.md` ("the brief"). Nothing else.
**Precedence:** the brief is authoritative for *what* is measured (§4 above all). This plan is authoritative for *how*: every decision the brief leaves open, plus the facts established while planning that the brief does not contain. Where this plan extends or tightens the brief, it says so explicitly and lists it in Appendix B. You may not silently change either document. If you disagree with a decision, raise it in `docs/open-questions.md` and continue with the plan's choice unless it is marked as a blocker.

**Conventions used below**

- `§n` is a section of the brief; `Pn` is a section of this plan.
- `D-nn` a decision (with rationale). `Q-nn` an open question. `WU-nn` a work unit. `R-nn` a risk. `M-n` a milestone.
- **STOP** marks the point where you must stop and escalate rather than pick a value yourself.
- "Arithmetic" means a calculation on the brief's own numbers. It is never a new measurement and must never be written into `src/` or `config/`.
- All times are UTC. All amounts are integer satoshis unless a unit is given.

---

## P0. The ten things to read before writing any code

The planning session checked the brief against the upstream source, the chain, and the platform documentation. Most of the brief held up. The items below did not, or were missing. Each one changes what you build.

1. **EE commits do not look like §2 describes.** On mainnet, EE commits put an `OP_RETURN` (an 8-byte push beginning with ASCII `ALPN`) at vout 0 and the P2TR at **vout 1**. Change, when present, is at vout 2. The reveal spends vout 1, has **one** output (exactly 546 to a wallet *receive* address), and has **no OP_RETURN**. This matches the chunked-envelope writer upstream (`crates/btcio/src/writer/chunked_envelope/*`), not the single-envelope layout in `builder.rs`. Some EE commits have **no change output** (2–3 inputs, outputs `[OP_RETURN, P2TR]` only). A parser written from §2 ("reveal has an OP_RETURN and a 546 output", "commit creates a P2TR output plus change") would misclassify or miss EE settlements. Missing reveal cost is exactly v1's failure. The settlement parser must not depend on output positions (D-20). OL's layout was not probed. Record it in WU-06.
2. **Consolidation outside the selector has already happened.** At block height 969093 (block time 2026-09-29 03:27 UTC), six transactions at about 1.0 sat/vB swept 260 inputs of 546 sats each (5 × 50 + 10) from EE receive addresses 0/2–0/4 into EE change-chain addresses 1/5–1/10. They recovered 124,096 of 141,960 sats.
   - This explains why the brief measured only 5,460 stranded sats after 105 settlements, where 105 × 546 = 57,330 would be expected (arithmetic).
   - It also explains the change-chain activity in §4.2.
   - Arithmetic inference only: the brief's EE snapshot sits about 8 settlements, roughly 17 h, after the sweep. EE's measured spendable of 112,249 therefore came largely from an out-of-band consolidation.
   - It is a direct, partial answer to the brief's model-input question (§3.2, §15 OQ4) and must go to the brief's owner (Q-04).
   - The service must classify such transactions and never read them as settlements or deposits (D-21). If a 1.0 sat/vB, 50-input sweep were counted as a settlement, it would pull the fee quantiles down and push the multi-input ratio up.
3. **The deployed build is unknown, and selection semantics changed three times in 2026.** The `builder.rs` generations are M0 (≤ 2026-06-24), M1 (from `42d45ee`, 2026-08-13, which adds reveal fee headroom) and M2 (from `13bc320`, 2026-09-03, which adds `fund_commit_transaction`, `select_commit_utxos` and the script-type filter). The brief's reading at `7f20dcb` is M2. `choose_utxos` itself has been unchanged since 2026-06-05. The brief's §4.4 (`required = cost + 546`, `change = sum − cost`) matches **M2's first pass** only. M2 also has a no-change "carry" second pass and per-input-count fee pricing. M0/M1 require only `cost` and burn sub-dust excess to fee. Chain evidence on EE points to a pre-M2 build. Reveals pay exactly 546, so P2TR value = 546 + reveal fee and headroom is zero. On 2026-09-28, two multi-input commits had no change output and inflated rates, which is consistent with sub-dust excess being burned to fee. On a probed settlement, the commit-only rate divided by the reveal-only rate is about 0.93, which matches M0/M1's underpricing of P2WPKH inputs. This is an inference from a few days of history, not a finding. **You implement the brief's §4.4 exactly** (`SELECTOR_MODEL_VERSION = 1`, D-40). You record the divergences in `docs/model-divergences.md` and add chain "fingerprint" metrics so the discrepancy is visible (D-23). The owner answers Q-03 before anyone relies on the numbers.
4. **The sequencer only spends confirmed UTXOs** (`listunspent` minconf = 1), so §4.1's "confirmed" matches upstream. Esplora's `/address/{a}/utxo` includes unconfirmed outputs and **excludes outputs already spent by a mempool transaction**. As a result, for roughly one block after every commit, confirmed spendable drops by the whole working UTXO. That is correct under §4.1 and will trip the spendable/largest-UTXO rules unless Grafana's pending periods absorb it (D-63). Do not "fix" it in code.
5. **`settlements_per_day` is never defined in the brief, and the obvious definition is wrong.** Count/span gives EE 105 / 13.6 d = 7.7/day, but the brief uses 11.9/day. Only a median-inter-commit-interval cadence reproduces the brief's runway and alert figures. With count/span, AC3 returns 5.6 days instead of 3.6 (arithmetic). The plan adopts the median interval (D-13) and takes the larger of the 7-day and 30-day values, so a cadence increase is not hidden for about 10 days. The owner is asked to confirm (Q-05).
   - **The brief's fee quantiles appear to be commit-only rates.** One probed EE settlement drained exactly 487 (commit fee) + 403 (reveal fee) + 546 = 1,436, which is §4.3's "observed net". Its commit-only rate, 487 / 171.25 = 2.84, is §5's p50. Its package rate is 2.93.
   - The plan uses the **package** rate (D-10), because it is the only rate under which §4.3's formula reproduces a settlement's own cost. A commit-only rate understates reveal cost and overstates runway.
   - The service's p50/p90 will therefore sit a few percent above §5's. That is expected, not a bug (Q-10).
6. **The p90 CI upper bound needs n ≥ 36** (exact binomial). The brief's floor of 30 therefore leaves n = 30–35 with no p90 upper bound. OL's 7-day window (about 15–17 settlements) can never reach the floor. The fallback basis (D-12) covers both cases. The brief's "roughly 563 observations" for p99 comes from a normal-approximation rank rule, so the brief's CI values are **not** test oracles for an exact implementation.
7. **The §4.4 simulator, as specified, equals a closed form.** It returns `floor((Σpool − 546) / cost)` except when a change lands exactly on 546. AC3 is therefore independent of UTXO composition, and it validates cost and cadence, not the selector. Selector fidelity is validated only by the §10 golden tests plus mutation tests (D-41, P9.4). The faithful port is **not** monotone in fee rate; a pinned counterexample must stay green (P9.3).
8. **Both descriptors and all six test vectors verify.** BIP380 checksums pass with the `h` markers exactly as written; the apostrophe forms have different checksums. A JavaScript `Number` port of the checksum polymod silently gives wrong answers (40-bit state), so use `BigInt`.
9. **Esplora traps:** `utxos_limit` defaults to 500 in both electrs forks and returns HTTP 400 when exceeded. The address that collects reveal receipts gains one 546 output per settlement. The first-page composition of `/address/{a}/txs` differs between forks. `/txs/chain/{unknown_txid}` returns `[]`, which can silently truncate history. `/tx/{txid}/outspend/{vout}` returns `{spent:false}` (HTTP 200) for an outpoint the indexer does not know. Each of these can make a wallet look healthier than it is, and each has a guard in D-20…D-28.
10. **Grafana resolves a firing alert when its series disappears** (MissingSeries after 2 evaluations), and NoData is not "alerting" by default. A metric that goes absent therefore reads as good news. Every per-wallet liveness series is always emitted, the dead-man rule uses NoData = Alerting, and companion rules catch missing thresholds (P8.4).

---

## P1. Blockers and open questions

Status as of planning. Keep this table in `docs/open-questions.md` and update it as answers arrive. "Proceeds meanwhile" never means "assume a value": it means building the parts that don't depend on the answer.

### 1.1 Blockers (a phase cannot complete without the answer)

| ID | Question | Bites at | What proceeds meanwhile |
|---|---|---|---|
| **Q-01** | **Signet wallet descriptors** for EE and OL (brief OQ6). Also needed: at least one receive and one change test vector per wallet, sourced from the signet wallet or observed signet txs (never from our own derivation). Confirm the shape is exactly `wpkh([fpr/84h/1h/0h]tpub…/<0;1>/*)#chk`, the signet indexer URL, and whether this is the default public signet or a custom one. | **WU-16 (signet track), entirely.** No `config/networks/signet.json` can pass startup validation without them. It also blocks the positive half of AC9. | All derivation and validation code. The AC9 rejection half. A synthetic signet test profile (P9.2). Mainnet, fully. **Ask now.** A different descriptor shape (`tr()`, split single-path descriptors) would need a grammar change, and that has to be known before WU-01 closes. |
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

## P2. Phasing

### 2.1 Work units

Each work unit ends in something runnable and checkable. "Done when" is the exit test. Lanes (L1–L6) can run in parallel. Arrows are hard dependencies.

| WU | Title | Depends on | Done when (demonstrable) |
|---|---|---|---|
| **WU-00** | Repo bootstrap | — | `pnpm i && pnpm test` green on an empty suite in CI. Node 24, TS strict ESM, vitest, ESLint and dependency-cruiser rules, Postgres + PgBouncer (transaction mode) in `docker compose` and in the CI services, the config zod schema *skeleton*, the brief copied verbatim to `docs/brief/`, and `docs/{decisions,open-questions,model-divergences}.md` seeded from this plan. |
| **WU-01** (L1) | Descriptor parser, derivation, network validation | WU-00 | The six brief vectors, the BIP84/BIP32/BIP173 published vectors, the 27-case rejection matrix and the 300-row differential fixture all pass. `scripts/validate-configs.ts` passes on `mainnet.json` and fails on each corrupted variant. AC1 and the rejection half of AC9 are covered. |
| **WU-02** (L2) | Estimator statistics | WU-00 | The rank-table fixture (exact BigInt), quantile, regime, cadence and basis fixtures (P9.3) pass. The fallback band n = 30–35 is covered. |
| **WU-03** (L3) | Selector port, cost, simulator, composition, alert level | WU-00 | Golden selection fixtures pass. The 7 mutants each fail at least one golden case and the unmutated control passes (AC12). AC3/AC4 unit oracles pass (Appendix A). Simulator property tests pass, including the pinned non-monotone counterexample. |
| **WU-04** (L4) | Esplora client, provider pool, limiter, budget, error taxonomy | WU-00 | The fake-provider test matrix passes: every error kind maps to its action, a scan stays on one provider (provider-atomic), failover is sticky, the genesis/checkpoint binding holds, and zod response schemas accept real response shapes. Also delivers `capture-fixture`'s **tx/address capture mode** (it needs only `EsploraClient`), so WU-06 has provenance-stamped mainnet fixtures, OL's included. |
| **WU-05** (L5) | Storage: migrations, lease, counters, repositories | WU-00 | Migrations apply on a fresh DB through the direct URL. The lease race through PgBouncer yields exactly one holder. The network-stamp FK rejects foreign rows. int8 parsing is safe. |
| **WU-06** | Chain extraction: gap scan, history sync, classification, settlement linking, integrity, reorg | WU-01, WU-04 | Recorded mainnet fixtures classify correctly: EE chunked commits (with and without change), reveals, the 969093 sweeps, and top-ups. Integrity identities hold. The truncation guard fires. The rotation case (AC7) passes. OL's layout is recorded as fixtures. |
| **WU-07** | Wallet snapshot pipeline (pure core plus orchestration) | WU-02, WU-03, WU-05, WU-06 | `computeWalletSnapshot()` gives the expected snapshot on the replay fixtures. `runCollect()` against fake providers and a real Postgres writes one snapshot per wallet, and nothing for a wallet whose scan failed. |
| **WU-08** | HTTP: `/api/collect`, `/api/metrics` | WU-07 | Auth matrix, exposition-completeness and AC8 tests (throwing `fetch`, dependency rule) pass. A local `vercel dev` scrape shows every §12 metric for both wallets. |
| **WU-09** | Backfill job, anchor search, provider conformance | WU-06, WU-05 | `backfill --network mainnet` (phase-B code with no page cap, its own `backfill` lease; P5.4) fills settlements against a real provider and is idempotent on re-run. It is an accelerator only: an empty DB also converges through collect alone (integration test). `provider-conformance` passes against each configured provider. The anchor-height search (P9.5) reports its intervals or no match. |
| **WU-10** | Mainnet Stage 0 deploy and minimal Grafana | WU-08, WU-09, **Q-06**, (Q-07) | Vercel production cron runs every 15 minutes. Grafana scrapes. The M-1 rule set (P8.4) is provisioned. Drill D1 (kill cron) fires the dead-man. **M-1 reached.** |
| **WU-11** (L5) | Maintenance: rollup and purge | WU-05 | AC10 integration test: tiers respected, second run deletes 0, counters monotonic, never deletes un-rolled days. |
| **WU-12** (L6) | Compatibility manifest, drift check (CI and runtime), `/api/drift-check` | WU-00 (runtime part: WU-05) | AC13 unit test. The scheduled CI job runs against real upstream. The history replay test (extractor stable 7f20dcb→4acde82; flags 42d45ee→13bc320) passes. The runtime cron writes `drift_checks`. |
| **WU-13** | Network fee context (mempool.space) | WU-04, WU-05 | `bitcoin_inclusion_feerate_sat_vb{quantile=p50\|p90}` and `fee_premium_ratio` are exposed from stored rows. A fee-source failure never blocks a wallet snapshot. |
| **WU-14** | Full alert rule set and dashboards | WU-10, WU-12, WU-13 | Every §13 rule plus the P8.4 companions is provisioned by Terraform. `promtool test rules` covers AC4, AC5 and AC11 logic. The dashboard shows as-of, n and CI on every figure. |
| **WU-15** | Rollout Stages A → D, drills D2–D4 | WU-14, **Q-02** (A entry), **Q-03/Q-04/Q-08** (A exit), Q-06 pager (B) | The stage exit criteria in P11.7 are met and recorded. |
| **WU-16** | Signet track | **Q-01 (BLOCKED)**, WU-10 | `config/networks/signet.json` is added with no `src/` diff, the signet Vercel project and Neon project run, and the positive half of AC9 is shown. |
| **WU-17** | Time machine: chain archive, `AsOfChainView`, `replay run`, outcomes, backtest report, live/replay equivalence job | WU-06, WU-07, WU-09, WU-14 | The no-look-ahead property test passes. Replay of every stored daily UTXO sample reproduces its confirmed composition exactly (D-86). A backtest over the brief's measurement window, 2026-08-19 → 2026-09-30, where 2026-08-19 is 40.5 days before 2026-09-29, i.e. the start of OL's §5.1 span (arithmetic). The archive is fetched from 2026-07-20, so the first step has a full 30-day window. The backtest produces `report.md` with lead times, calibration and the silence audit (D-85). |

### 2.2 Parallelism

```
WU-00 ──┬─ L1 WU-01 ─────────────┐
        ├─ L2 WU-02 ─────────────┤
        ├─ L3 WU-03 ─────────────┤
        ├─ L4 WU-04 ──┬──────────┼─ WU-06 ─┬─ WU-07 ─ WU-08 ─┐
        │             │  (WU-01)─┘         │                 ├─ WU-10 ═ M-1 ─ WU-14 ─ WU-15
        ├─ L5 WU-05 ──┼─ WU-11             └─ WU-09 ─────────┘              (Stages A–D)
        │             └─ WU-13
        └─ L6 WU-12 (manifest + CI drift; runtime part after WU-05)
                                                        WU-16 (signet) ── blocked on Q-01
                     (WU-06, WU-07, WU-09, WU-14) ──► WU-17 (time machine) ──► Stage A exit gate
```

- **Strictly sequential:** WU-00 → {WU-01, WU-04} → WU-06 → WU-07 → WU-08 → WU-10. Also WU-10 → WU-14 → WU-15.
- **Fully parallel after WU-00:** WU-01, WU-02, WU-03, WU-04, WU-05, WU-12. These are pure modules or independent I/O layers. Give each its own branch or worktree; they share only the type definitions in `src/types.ts` and the config schema, both frozen at the end of WU-00.
- WU-11 and WU-13 run in parallel with the WU-06 → WU-08 chain.

### 2.3 Critical path to the first correct mainnet alert (M-1)

**M-1 definition.** The production mainnet deployment computes every §4 quantity from live chain data every 15 minutes. Grafana evaluates the M-1 rule set (P8.4): dead-man, exposition-absent, `spendable < alert_level`, `runway{p90} < 2`, `largest_utxo < cost{p90_ci_upper}`, `insufficient_data`, and missing-alert-level. At least one of these has been observed to fire correctly against mainnet data. "Correctly" means: drill D1 fires the dead-man within the AC5 bound; and the spendable, stranded and largest-UTXO values in the snapshot reconcile to the satoshi with an independent manual reading at the same block height (the humans on shift do the manual reading). If EE is still below its alert level, the WARN fires on the first run. §5 says that is correct behaviour.

**Path:** WU-00 → WU-01 ∥ WU-04 → WU-06 → WU-07 (with WU-02, WU-03 and WU-05 done in parallel beforehand) → WU-08 → WU-09 (backfill) → WU-10.

What is deliberately **off** the critical path, and why it is safe:
- **Purge/rollup (WU-11).** The estimator enforces its windows with explicit predicates and never relies on purge (D-31). WU-11 must land before day 14 of operation, when the first snapshots reach retention.
- **Drift check (WU-12).** Needed before Stage A exit. The manifest constant check (code vs manifest `SELECTOR_MODEL_VERSION`) is part of WU-00/WU-07, because the version metrics need it.
- **Network fee context (WU-13).** Informational only; no threshold depends on it (non-negotiable 6).
- **Full §13 rule set (WU-14).** Multi-input, stall, regime, drift and ceiling WARNs matter but are not the funding backstop.
- **Time machine (WU-17).** It needs no new estimator code (D-80), so it can follow M-1 without delaying it. It **gates Stage A exit**: the backtest is the evidence that the monitor would have warned at least 5 days ahead over real history (P11.7).
- **Anchor-height fixture (part of WU-09).** AC3 passes on a declared snapshot because of composition invariance (P0 item 7). The anchor search is validation, not a gate for M-1.

What is **on** the critical path even though it looks like hardening:
- **Layout-agnostic settlement parsing and reveal linking (WU-06).** Without it, EE cost is understated: the v1 failure.
- **The exact CI, the fallback basis and the median-interval cadence (WU-02).** Without them, the alert level is wrong.
- **Always-emitted series and NoData handling (WU-08, WU-10).** Without them, a dead monitor is silent.

### 2.4 Milestones

- **M-0** (end of WU-05 lanes): all pure modules green; the replay oracles in Appendix A pass.
- **M-1** (WU-10): first correct mainnet alert (definition above). Stage 0 begins.
- **M-2** (WU-14): full rule set live. Stage A may start once Q-02 is answered.
- **M-3** (Stage B exit): paging verified; humans still on shift.
- **M-4** (Stage C exit): humans off overnight.
- **M-S** (WU-16): signet running from config only. Blocked on Q-01.
- **M-T** (WU-17): backtest report over the brief's measurement window reviewed by the brief's owner. Required before Stage A exit.

---

## P3. Measurement specification

This section pins down every quantity the brief leaves open. It sits under §4 of the brief and adds no new definitions of spendable, cost, runway or threshold. Each item cites the brief section it implements. P7 gives the implementing module.

### 3.1 Address set (brief §4.2)

**D-01 Gap scan.** For each wallet and each chain c ∈ {0, 1}:

```
i = 0; run = 0; last_used = -1
while i < ceiling:
    s = GET /address/{addr(c,i)}
    used = s.chain_stats.tx_count + s.mempool_stats.tx_count > 0
    if used: last_used = i; run = 0 else: run += 1
    i += 1
    if i >= min_indices and run >= gap_limit: break
ceiling_hit[c] = (run < gap_limit)          # loop ended at the ceiling, not at the gap
```

- The scan runs over every index from 0 to the stop point **every run**, holes included. An address once seen as used stays watched even if it drops below the scan range later (it cannot, but assert it).
- `ceiling_hit` never silently caps the scan. The snapshot is still written, with the flag set; spendable is then a lower bound, and a WARN fires (P8.4). Arithmetic: with ceiling 50 and gap 20, once a chain's last used index reaches 30, a gap of 20 no longer fits under the ceiling, so `ceiling_hit` must fire.
- Config validation: `ceiling > gap_limit ≥ 1` and `ceiling ≥ min_indices`.
- `min_indices`, `gap_limit` and `ceiling` are explicit per-wallet config. The brief's suggestions (6/20/50) go in `mainnet.json`, never in code.

### 3.2 UTXO set and composition (brief §4.1, non-negotiables 1, 2, 5)

**D-02 Source.** Call `GET /address/{a}/utxo` for **every used address on every run**, with no caching. Use `tx_count` only to decide "used" and whether history needs paging. Aggregate sums (`funded_txo_sum`, `spent_txo_sum`) are never read in the runtime path. An aggregate cross-check exists only in the offline `provider-conformance` script (D-27).

**D-03 Tip consistency.** Read `/blocks/tip/hash` before and after the UTXO phase. If it changed, redo the UTXO phase once. If it changes again, the wallet scan fails with `inconsistent` and fails over. **`as_of` for a wallet** is the start of the provider attempt that produced the snapshot. It is stored as `scan_started_at` (= `last_update_timestamp`) and injected into `computeWalletSnapshot`. The snapshot also records the tip height, hash and block time read at that attempt's start.

**D-04 Script type.** `/utxo` has no script field. Script type comes from the derived address, and every derived address is P2WPKH. Assert that each UTXO's address is in the derived set. A UTXO at an address that is not in the set cannot exist in this design; if it appears, it is a bug and fails the scan.

**D-05 Partition.** Over the `/utxo` result U for all watched addresses:

| field | definition |
|---|---|
| `spendable_sats` | Σ v where v > 546 ∧ confirmed ∧ type ∈ {p2wpkh, p2tr} — **exactly §4.1** |
| `stranded_sats` | Σ v where v ≤ 546, confirmed or not (§4.1 has no confirmation clause) |
| `unconfirmed_gt_dust_sats` | Σ v where v > 546 ∧ ¬confirmed |
| `unsupported_gt_dust_sats` | Σ v where v > 546 ∧ confirmed ∧ type ∉ {p2wpkh, p2tr}. Always 0 with wpkh descriptors; kept so the identity holds. |
| `balance_sats` | Σ v over U. **Identity enforced by a DB CHECK:** `balance = spendable + stranded + unconfirmed_gt_dust + unsupported_gt_dust`. |
| `largest_utxo_sats` | max v over the spendable set (`commitCandidateFilter`); 0 if empty. Invariant: `largest ≤ spendable`. |
| `utxo_count{bucket}` | `dust`: count v ≤ 546. `sub_threshold`: spendable-set UTXOs with v < `required_basis`. `spendable`: spendable-set UTXOs with v ≥ `required_basis`. `unconfirmed`: count of `unconfirmed_gt_dust` (**addition**, so bucket counts sum to the UTXO count). `required_basis = cost_sats(basis_rate) + 546` (P3.9). `sub_threshold` and `spendable` are absent when there is no basis rate. |

Note: `balance_sats` is the `/utxo` total, so it includes unconfirmed outputs and excludes mempool-spent ones. It is for contrast only (§12) and is never an alert input.

### 3.3 Settlement extraction (brief §2, §4.3)

**D-20 Layout-agnostic commit and reveal recognition.** **W** is the set of scriptPubKeys at every index `0..stop_index` on both chains derived in this run (used or not, the gap included), together with every stored `addresses` row for the wallet. It is built once per wallet run, right after the gap scan, and passed to `classifyTx` and `checkIntegrity`. Using only *used* addresses would reclassify a commit whose change lands on a fresh index as `external_spend`, and silently drop a settlement.

- **Commit:** every input's prevout scriptPubKey ∈ W. At least one output is `v1_p2tr` and not in W. Every other non-W output is a zero-value `op_return`. At most one value-bearing output pays W (the change; it may be absent). **Never locate outputs by index.**
- **Reveal:** for **each** non-W P2TR output of a commit, `GET /tx/{commit}/outspend/{vout}` on the same provider as the scan. The spender must have exactly one input (that outpoint), a script-path witness (≥ 3 witness items), and every value-bearing output paying W. `OP_RETURN` presence and position are recorded, not required.
- Record per settlement: `layout` (`chunked` if the commit carries the OP_RETURN, `single` if the reveal carries it, `none` otherwise), `p2tr_vouts`, `reveal_count`, `change_present`, and each reveal's wallet-output value (`reveal_receipt_sats`).
- `{spent:false}` from outspend means **pending**, never "no reveal". A commit whose P2TR output is still unspent after `reveal_link_timeout_blocks` (config) increments `events_total{kind="unlinked_commit"}`. A mempool spend is stored as pending and re-resolved every run, because the reveal can be replaced (RBF).
- A wallet-funded transaction with a non-W P2TR output whose spender is **not** reveal-shaped is `external_spend`, not a commit.
- Cross-check: the reveal's receipt pays a W address, so the reveal txid also appears in wallet history. If it does not, increment `events_total{kind="layout_unrecognized"}`.

**D-21 Classification of every other wallet transaction** (deduplicated across address histories):

| class | rule | effect |
|---|---|---|
| `settlement_commit` / `settlement_reveal` | D-20 | fee series, cadence, multi-input ratio |
| `deposit` | no W inputs, ≥ 1 W output, not a known reveal | counted; `events_total{kind="deposit"}` |
| `internal_consolidation` | all inputs in W and all value-bearing outputs in W | counted and **WARN**; e.g. the 969093 sweeps |
| `external_spend` | all inputs in W, value to non-W, not a linked commit | counted and **WARN** |
| `mixed_spend` | inputs from both W and outside W | counted and **WARN** (possible missing descriptor, Q-21) |

Only settlements enter the fee series, cadence and multi-input ratio.

**D-22 Integrity identities** per settlement. All are exact in sats. A settlement failing (2) or (4) is excluded from the fee series and counted.

1. For the commit and each reveal: `fee == Σ vin.prevout.value − Σ vout.value`. A mismatch is a `malformed` provider error and triggers failover.
2. Net identity: `Σ W-inputs(C) − Σ W-outputs(C) − Σ W-outputs(R) == fee_C + Σ fee_R`.
3. `spendable_drain_sats = fee_C + Σ fee_R + Σ(W-outputs of C and R with value ≤ 546)`. This is §4.3's "observed net" (used by AC2).
4. The change output address ∈ W.
5. In a transaction classified `settlement_commit`, `settlement_reveal` or `internal_consolidation`, any value-bearing **P2WPKH** output paying a non-W address increments `events_total{kind="unknown_output_address"}`. This is the blind-spot detector for change sent beyond the scanned range. The reveal-funding P2TR outputs of recognised commits are expected and are excluded. For `external_spend`, foreign outputs are the point, and that class has its own counter.

**D-23 Model-assumption fingerprints** (observation only; §4 is unchanged):
- `events_total{kind="reveal_receipt_ne_dust"}` when a reveal's W-output ≠ 546 (M1/M2 headroom or carry).
- `events_total{kind="reveal_count_ne_1"}`: the brief's `+546` assumes one dust output per settlement.
- `events_total{kind="commit_without_change"}`
- `events_total{kind="dust_spent_by_non_settlement"}`
- Gauge `bridge_wallet_commit_reveal_feerate_ratio{wallet}`: the median over the 30-day sample of the commit-only rate divided by the reveal-only rate. Arithmetic expectation: about 0.93–0.94 for M0/M1 builds, which underprice P2WPKH inputs, and about 1.00 for M2. It is a fingerprint, not a threshold, and is shown next to the manifest's `deployed_build_confirmed`.

**D-24 History traversal.** Never use `/address/{a}/txs`, because its page composition differs between forks. Use `/address/{a}/txs/chain[/{last_seen}]` (25 per page on both forks) and `/address/{a}/txs/mempool`.

Traversal state is **per address**, in `address_txs(network, address, txid, block_height, block_hash)` (P5.3). That table is written in the step-(2) transaction and purged at the ingest horizon.

Stop paging an address when any of these holds:
- (a) the page contains a txid already in `address_txs` **for this address** at depth ≥ `finality_depth`;
- (b) the oldest `block_time` on the page is older than the ingest horizon (D-32);
- (c) the confirmed txids seen in this traversal, plus this address's stored rows not re-seen, equal `chain_stats.tx_count`.

A page with fewer than 25 entries is a normal end. An empty page is normal only if (c) holds. An empty page before (a) or (c), or a repeated first txid, means **history truncated**, and the scan fails over.

Skip traversal entirely when `(chain, mempool) tx_count` is unchanged and nothing for the address is unfrozen. Never stop an address because a txid was first ingested through a *different* address: a sweep or change transaction touching two addresses would otherwise end B's traversal early and skip B's older commits.

**Coverage (per address, D-24c).** Track how far back each address's history is known:
- unused address: `history_covered_since = -infinity`;
- traversal reached the true end of history (c): `-infinity`;
- stopped at the horizon (b): the horizon time;
- stopped at a known txid (a), or interrupted by the page cap or budget: **keep the previous value**. It stays `NULL` if coverage was never completed.

The wallet's value is the **MAX** over all watched addresses, and `NULL` if any address is `NULL` (not covered). `history_coverage_days = (as_of − wallet value) / 86400`, capped at `settlements_raw_days`. A newly used address, such as the AC7 rotation, is complete after its first traversal, because a new address's whole history is short.

**D-25 Reorgs.** Store `block_hash` and height for every transaction. Each run, re-check transactions with `tip − height < finality_depth` via `/tx/{txid}/status`. If a transaction is now unconfirmed, drop its settlement from the fee series and mark it pending. If the hash differs, update it. At `finality_depth`, freeze the row. A frozen txid later seen with a different hash increments `events_total{kind="reorg_beyond_finality"}` and is unfrozen.

**D-25b Replaced or evicted transactions.** Upstream replaces chunked commits and reveals through RBF, and the fee-bumping config is unknown (Q-03). Any stored **unconfirmed** transaction (commit, reveal or other) that is absent from `/txs/mempool` and `/txs/chain` of every W address it touches, for `collection.mempool_drop_runs` consecutive runs, is marked `status = 'dropped'`.
- Dropped rows are excluded from pending counts, linking and the fee series.
- The drop is recorded as a fingerprint event, `events_total{kind="tx_dropped"}`, shown on the dashboard only.
- A 404 from `/tx/{txid}` for a txid whose stored state is **unconfirmed** is a drop signal, not a provider error. Fail-over-on-404 applies only to txids stored as confirmed.

Without this rule, a replaced commit's `{spent:false}` outspend would trip `unlinked_commit` for 90 days, and every re-fetch of it would fail over on every provider.

**D-26 Which set feeds what.** Everything below uses **settlement commits** as recognised by D-20; sweeps and other classes never enter.

| quantity | set |
|---|---|
| fee quantiles, CIs, regime medians, vsize medians, window max | `complete = true`: commit and all reveals confirmed, identities (2) and (4) pass, not dropped |
| cadence (D-13), `multi_input_ratio_7d` (D-50), `commits_7d`/`commits_30d`, `last_settlement_timestamp` (D-51) | every **confirmed**, not-dropped settlement commit, whatever its reveal or integrity state (a slow reveal must not hide a stall or a multi-input commit) |
| `settlements_pending` | commits whose reveals are not all linked and confirmed, not dropped |

`commits_30d` counts the cadence set over `estimator.cadence.window_days`. `sample_span_days = (max − min commit_block_time of the active fee sample) / 86400`.

**D-27 Aggregate cross-check (offline only).** The identity `Σ /utxo == chain.funded − chain.spent + mempool.funded − mempool.spent` per address holds given Esplora's mempool semantics. It lives only in `scripts/provider-conformance.ts`, run by hand or in scheduled CI, because §4.1 allows aggregates only as a change detector. It is never read by the collector and never becomes a metric.

### 3.4 Fee-rate series (brief §4.3, §5.1, §9)

**D-10 Rate and size.** Per settlement *i*, from stored integer fees and weights:
- `r_i = 4 · (fee_C + Σ fee_R) / (weight_C + Σ weight_R)` sat/vB, computed as a rational and converted to float only at the end.
- `commit_vsize_i = weight_C / 4` and `reveal_vsize_i = Σ weight_R / 4`, unrounded.
- The 546 dust is not a fee and is never in the numerator.

**D-14 Windows.** `S(W) = { settlements with complete = true ∧ commit_block_time > as_of − W·86400 }`. `as_of` is the run's `scan_started_at` from an injected clock. There is no upper cut, because block timestamps can run up to 2 hours ahead.

### 3.5 Quantiles and confidence intervals (brief §5.1 items 1–3, non-negotiable 7)

**D-16 Point estimator.** Hyndman–Fan type 7 on the ascending sample: `h = (n−1)q + 1`, `Q = x⌊h⌋ + (h − ⌊h⌋)(x⌊h⌋+1 − x⌊h⌋)`. Used for every median (fees, vsizes, intervals) and for p50/p90. Rationale: it is consistent with all six "obs above" rows in §5.1 and matches four exactly without ties. Type 1 is refuted by the OL rows.

**D-17 CI.** Exact, distribution-free, equal-tailed, nominal 95%:
`l = max{k ∈ 1..n : P(Bin(n,q) ≤ k−1) ≤ 1/40}`, `u = min{k ∈ 1..n : P(Bin(n,q) ≤ k−1) ≥ 39/40}`, `CI = [x(l), x(u)]`.
Compute with **BigInt exact rationals** (q = 1/2 or 9/10; compare `40·Σ C(n,j)·a^j·(b−a)^(n−j)` against `b^n`). At n = 35 the p90 cutoff is within 3.2e-5, so floating point can get the rank wrong.

**D-18 Support (rank refusal).** Quantile q is *supported* at sample size n iff both `l` and `u` exist. That is p50 for n ≥ 6 and p90 for n ≥ 36. If a quantile is unsupported, its point and both bounds are **absent**: not 0 and not NaN. Refusal keys on the CI ranks, because the type-7 `h` is always within [1, n] (§5.1 treats p99 at n = 117 as unsupported although a point value exists). **Only p50 and p90 are ever computed** (D-19: the quantile label allowlist is `{p50, p90}` service-wide, network metrics included).

### 3.6 Regime (brief §9)

**D-11.** `m7 = Q0.5(S(7d))`, `m30 = Q0.5(S(30d))`. `ratio = m7 / m30` is computed iff `|S(7d)| ≥ regime.min_sample_short`, `|S(30d)| ≥ min_sample` and `m30 > 0`. Otherwise the ratio is absent, `regime_shift = 0` and the active window is 30 d.

`regime_shift = 1` iff `ratio < band_lo` or `ratio > band_hi`. The band is closed: exactly 0.67 or exactly 1.5 is **no** shift, which matches AC11's strict "> 1.5×". In IEEE doubles, 3.0/2.0 == 1.5 and 0.67/1.0 == 0.67 exactly, so tests can assert band edges.

`active = 7d` iff `regime_shift = 1`. Only fee-rate inputs switch with the active window: the p50/p90 points, CIs and basis rate. vsize medians and cadence always use 30 d (Q-15).

`regime.min_sample_short = 6` in config: the smallest n with a closed exact median CI. Arithmetic: any value above about 15 makes regime detection impossible for OL.

Consequence to document: an OL regime shift always resolves to the fallback basis, because OL's 7-day n is about 15–17 (arithmetic).

### 3.7 Threshold basis (brief §5.1 items 2–3, §13)

**D-12.** Let `n_a = |S(active)|`.
- **Regular** (`threshold_basis = ci_upper`) iff all of: `n_a ≥ min_sample`; p90 is supported in the active window; cadence is available (P3.8); and **history coverage is complete**: the wallet's `history_covered_since` (D-24) is not NULL and is ≤ `as_of − 30d` (Q-16). The basis rate is the p90 CI upper of the active window.
- **Fallback** (`threshold_basis = window_max`, `insufficient_data = 1`), otherwise, provided `|S(30d)| ≥ 1` and cadence is available. The basis rate is `max(S(30d))`. It is never widened beyond the configured 30 days (§9). S(7d) ⊂ S(30d), so the fallback is never below any regime-shifted statistic. For 36 ≤ n ≤ 53, the exact p90 CI upper already *is* the sample maximum, so the fallback is continuous with the regular basis.
- **None** (`threshold_basis = none`, `insufficient_data = 1`): `|S(30d)| = 0` or cadence unavailable. The basis rate, alert level, the p90 and p90_ci_upper costs, and their runways are absent. `feerate_sample_size = 0` (or its true value) and `insufficient_data = 1` are always emitted.
- Dashboard caveat, stated on the panel: below n ≈ 29 the window maximum is only the "most conservative available", not a 95% bound. Arithmetic: its one-sided coverage is 1 − 0.9ⁿ, which is 0.65 at n = 10.

### 3.8 Cadence (brief §4.4, §4.5, §13 stall rule)

**D-13.** For a window W:
1. Take the confirmed **settlement commits** (reveal status does not matter; D-20 recognition only, so sweeps and other spends are excluded) with `commit_block_time > as_of − W`. Sort them by `(block_height, position in block)`.
2. Build a running-max envelope `t'_i = max(t'_{i−1}, block_time_i)`, because block timestamps are not monotone.
3. Intervals are `Δ_i = t'_i − t'_{i−1}`. Keep zero intervals.
4. `m_W = Q0.5(Δ)`, and `spd_W = 86400 / m_W`.

`spd_W` is absent if the interval count is below the window's minimum, or if `m_W = 0` (degenerate).

- `spd_30 = spd` over 30 d, with a minimum of `cadence.min_intervals` intervals (config: 30).
- `spd_7 = spd` over 7 d, with a minimum of `cadence.min_intervals_short` intervals (config: 10; OL has about 16 per week, arithmetic).
- **`settlements_per_day = max(spd_30, spd_7)`**, using whichever of the two is present. It is absent only if both are absent.

Rationale for the max: a 30-day median lags a cadence increase (for example when DA goes live) by about 10 days, and during that lag drain is understated and runway overstated. Taking the max is conservative in both directions. It is not a regime mechanism and does not follow `regime_shift`.

Store and expose `commits_30d` (a count), `spd_7` and `spd_30`, so any divergence between the count basis and the median basis stays visible (Q-05).

The §13 stall rule's "expected cadence" is `86400 / settlements_per_day` seconds.

### 3.9 Cost, runway, alert level (brief §4.3–4.5; unchanged, only instantiated)

**D-40.** Let `v_i = commit_vsize_i + reveal_vsize_i` be settlement *i*'s total vsize, where `reveal_vsize_i` sums all of that commit's reveals (D-10). Then:
- `vs_30 = Q0.5(v over S(30d))`
- `vs_7 = Q0.5(v over S(7d))`, computed only if `|S(7d)| ≥ regime.min_sample_short`
- **`vs = max(vs_30, vs_7)`**

Using the median of per-settlement totals, rather than the sum of two separate medians, prices the quantity `cost()` actually charges for. It stays correct when a chunked settlement has N reveals. The max(7d, 30d) rule follows D-13's reasoning: it tracks payload growth (brief OQ5) without a 10-day lag. The commit and reveal medians are stored as diagnostics only. Arithmetic check: the brief's 171 + 132 = 303 comes out the same under either statistic when the sample is homogeneous.

`cost_sats(rate) = ceilSafe(vs × rate) + 546` (integer sats). `ceilSafe(x) = ceil(round(x, 6))` guards against floating-point noise pushing an exact integer up by 1 sat (for example 74591.99999999999 vs 74592.00000000001). The same helper is used for the alert level. Ceil is the only rounding that reproduces all four §5 runway figures from the displayed inputs (OL @p90 needs 4,236, not 4,235.28; arithmetic). It is also the conservative choice.

Scenarios:
| scenario | rate | emitted iff |
|---|---|---|
| `p50` | p50 point of the active window | p50 supported in the active window, and cadence available |
| `p90` | regular: p90 point of the active window. Fallback: the basis rate. | basis ≠ none |
| `p90_ci_upper` | the basis rate (regular or fallback) | basis ≠ none |

**D-41 Runway.** The §4.1 spendable set is **`utxos.filter(commitCandidateFilter)`**, and no other spendable predicate exists in `src/`. `composition.ts`, `largest_utxo_sats` and the runway pool all use it. `pool` = the values of that set, so Σpool = `spendable_sats` (the §4.4 pool filter is narrower on paper; Appendix B). Run the §4.4 loop exactly, in integer sats, with `required = cost + 546` and `change = sum(selected) − cost`, appending the change iff `> 546`, and using the faithful `choose_utxos` port (P7.2). `runway_days = settlements / settlements_per_day`.

**Special case (rate-independent zero):** if `Σpool < 2 × 546`, runway is **0 in every scenario**, even with no fee data or cadence. For any rate ≥ 0, `required = cost + 546 ≥ 1,092`, so no settlement is possible. This is what makes AC4 fire for a wallet with no settlement history.

**D-15 Alert level.** Two quantities:
- `drain_per_day_sats = settlements_per_day × cost_sats(basis_rate)`
- `alert_level_sats = ceilSafe(alert.level_days × drain_per_day_sats)`, with `level_days = 6` in config. `ceil` is conservative and consistent with D-40.

Also emit `drain_per_day_sats` (an addition), so operations can alert on `spendable < K × drain_per_day` with a K chosen in Grafana without a deploy (§11). `alert_level_sats` stays §4.5's 6-day level.

Store `trigger_5d_sats` (`trigger_days = 5`) and `alert_level_point_sats` (at the p90 point) in the snapshot for the dashboard. Neither is an alert input.

Note: §4.5 justifies the 6th day by "a 5-day threshold checked daily", whereas collection runs every 15 minutes. The 6 is kept as specified; the justification mismatch is recorded in Appendix B.

### 3.10 Leading indicators and context (brief §6, §12)

- **D-50** `multi_input_ratio_7d = M / C`, where C = confirmed **settlement commits** (D-20; reveal status does not matter, so a slow reveal cannot hide a multi-input commit) with `commit_block_time > as_of − 7d`, and M = those with ≥ 2 inputs. Sweeps and other non-settlement spends are excluded; the 50-input sweeps at 969093 would otherwise dominate the ratio. Absent if C = 0. Also expose `commits_7d` and `multi_input_commits_7d`: with OL's C of about 15–17 per week, 2 events give 11.8% (arithmetic).
- **D-51** `last_settlement_timestamp` = max `commit_block_time` over confirmed settlement commits, whatever their reveal status, within retention.
- **D-53 Chain-tip freshness.** Each snapshot stores the tip height, hash **and tip block time** read at scan start from the scan's provider. Also expose `bridge_wallet_snapshot_tip_time`. A provider that serves well-formed but stale data yields a fresh `last_update_timestamp` over an old chain state (non-negotiable 4). The cross-provider `stale_tip` check (P7.4) and a Grafana WARN on tip age (P8.4) both catch it.
- **D-52** Network fee context (informational, never a threshold input; non-negotiable 6): `GET /api/v1/mining/blocks/fee-rates/1m` on mempool.space. The response is **time-bucketed averages** (about 30-minute groups, integer-cast), not per-block values: /1m returned 1,428 points over about 31 days. Take N50 = type-7 median of the `avgFee_50` field across the points. `bitcoin_inclusion_feerate_sat_vb{quantile="p50"|"p90"}` = type-7 p50/p90 of `avgFee_50` across the points. `fee_premium_ratio` = `Q0.5(S(30d)) / N50`, absent if p50 is unsupported or N50 ≤ 0. Refresh at most hourly. The dashboard label must say "30-min bucket averages of block median fee rates". The brief's "per-block median, n = 1,105 blocks over 3 months" was in fact 2-hour buckets from `/3m` (arithmetic: 92 × 12 ≈ 1,104).

### 3.11 Historical replay ("time machine") and backtest — D-80…D-86

**Purpose.** Answer two questions from chain data alone:
- "What would this monitor have concluded at block height H?"
- "Across a range of heights, when would each alert have fired, and how does that compare with what the chain later showed?"

This audits the monitor's effectiveness against history, instead of relying on argument. It also checks the mission statement (§1: "at least 5 days of usable warning") directly.

**D-80 One implementation, not two.** Replay runs the **production code path** against a different data source:
- gap scan, classification (D-20/D-21), linking, integrity (D-22) and `computeWalletSnapshot` (P7.8);
- the **generated alert rules** (P8.4).

Only the chain view differs. `AsOfChainView(H)` answers the same read surface as `EsploraClient`, restricted to height ≤ H. There is no replay-only estimator or rule code. Anything that disagrees between replay and live is a bug in one of the two data sources, not a second model.

**D-81 No look-ahead.** This is the rule that keeps replay honest. At height H, `as_of = block_time(H)` (the header time; D-14 windows key on it):
- A transaction exists iff it is confirmed at height ≤ H. Spends at heights > H do not exist, so an output spent later is unspent at H.
- An address is "used" iff it has a transaction at height ≤ H. The gap scan (D-01) is evaluated on that, so the replayed address set is the one the live monitor would have discovered.
- A settlement is complete iff its commit and every reveal are confirmed at ≤ H. A reveal confirmed at H+1 is pending at H.
- The tip is H; the finality depth is measured from H.
- Config and model: the replay uses a chosen config file (default: the current one) and the current `SELECTOR_MODEL_VERSION`. Both are recorded in the output. Replaying an older config is how you audit a threshold change.
- **Mempool state at H is not recoverable from chain data.** Replay is therefore confirmed-only by default: `unconfirmed_sats = 0`, so the dip rules' "now" arm is always live. That is the conservative direction. Option `--mempool-proxy` treats transactions confirmed in block H+1 as the mempool at H: their W inputs are removed from the confirmed set, as `/utxo` would do. It is labelled **approximate** in every output.
- Network fee context is not reconstructed (it is informational only), so `fee_premium_ratio` is absent in replay.
- **Enforced by construction and by test.** `AsOfChainView` filters every response by height. A property test deletes all archive data above H and asserts that `replay(H)` is byte-identical.

**D-82 Chain archive.** Replay reads a local, append-only, content-addressed archive of raw Esplora responses, in the same format as the P9.3 capture layout (`raw/…` plus `PROVENANCE.json`).
- It is populated by `scripts/replay.ts fetch` through the normal `EsploraClient`: serial, rate-limited, provider recorded.
- Address histories are fetched **in full**, back to each address's first transaction, not only 90 days.
- A replay is deterministic given the archive digest, the config sha256 and the monitor version. All three are written into the output.
- Arithmetic on the brief's cadences: a 90-day EE history is about 2,000–2,600 requests. That is minutes on the internal indexer and under an hour at 1 req/s on a public one.

**D-83 Outputs. Replay never writes to the production database or the production metrics tenant.**

`replay run --network mainnet --from <height|UTC time> --to <height|UTC time> --step 15m|blocks:<n>|settlement [--config <path>] [--mempool-proxy] --out <dir>` writes:
- `snapshots.jsonl`: one `SnapshotRecord` per step per wallet. Same shape as production, plus `as_of_height`.
- `series.om`: OpenMetrics with explicit timestamps (the block times). Same metric names and labels as `/api/metrics`.
- `alerts.json`: firing intervals per rule. These come from **evaluating the generated rule files** (P8.4) over `series.om` with `promtool`, so replay alerts *are* the production rules. `keepFiringFor`, `KeepLast` and pending periods are applied by a small documented post-processor. That post-processor is labelled as an approximation of Grafana's state machine.
- `outcomes.json`: the ground-truth events of D-84.
- `report.md`: per wallet, a timeline of alerts against outcomes, lead times, the calibration table (D-85), and, where live snapshots exist, a composition diff against them (D-86).

`replay import` can push `series.om` into a **separate audit tenant** or a local Prometheus, so the timeline can be browsed in Grafana with the production dashboard JSON. Never the production tenant.

**D-84 Ground truth without guessing.** Events are derived from chain data after the fact, using the same definitions as the live rules:

| event | definition |
|---|---|
| `stall_start` | the first time the gap since the last settlement commit exceeds 3 × the expected cadence at that point (the §13 stall definition, applied in hindsight) |
| `cliff_proxy` | a `stall_start` at a moment when the replayed `largest_utxo_sats < required` (cost at the p50 point + 546). This is the chain-visible signature of `NotEnoughUtxos`: the sequencer logs and retries (P0 item 3), and the chain shows only silence. |
| `first_multi_input` | the first multi-input settlement commit after a given step |
| `intervention` | a `deposit` (top-up) or `internal_consolidation` (sweep): operator actions that change the natural trajectory. The 969093 sweep is one. |
| `realized_runway(H)` | the time from `as_of(H)` until the **actual** cumulative `spendable_drain_sats` (D-22(3)) of settlements after H reaches `spendable(H) − 546`. Deposits and sweeps are ignored. Right-censored if the data ends first. |

`realized_runway(H)` is the model-free counterpart of `runway_days`. It uses the fees the sequencer really paid and the cadence it really kept, which are exactly the quantities v1 got wrong. It is an **upper bound** on the true time to the cliff, because it ignores fragmentation losses near the end, and it is labelled that way. It needs no counterfactual modelling: interventions are simply not counted as income.

**D-85 Effectiveness measures** (computed in `report.md`; no target is invented beyond §1's 5 days):
- **Lead time**, per wallet and per outcome: `outcome_time − first_fire_time` for R1 (WARN) and for R2/R3 (CRITICAL). There is one outcome per `cliff_proxy` and `intervention`, plus the counterfactual exhaustion time `as_of(H) + realized_runway(H)`.
  - **Mission check:** for every step whose counterfactual exhaustion falls inside the data, R1 must already be firing at least **5 days** before it (§1).
- **Calibration:** for each step, the predicted `runway_days{p50, p90, p90_ci_upper}` against `realized_runway`. Report the distribution of `predicted − realized` per scenario.
  - Flag **every step where `runway_days{p90} > realized_runway`**: that is an overstatement, v1's failure mode. Each flagged step lists its cause columns (basis rate vs realized rate after H, cadence vs realized cadence, vsize, composition).
- **Contrast column:** `naive_aggregate_runway = balance_sats / (settlements_per_day × cost_p90)`. It is labelled "naive aggregate (v1-style; not v1's exact formula, which the brief does not give)", so the audit shows the gap v1 fell into.
- **Silence audit:** every step with `insufficient_data = 1` or basis `none`, with the reason.
- **Model-generation annotations:** the upstream M0/M1/M2 dates (Appendix C) are marked on the timeline. The replay always uses the current model, and `realized_runway` is model-free, so any divergence is attributable.

**D-86 Live/replay equivalence** (the time machine also audits the live monitor). Each stored daily `utxo_sets` sample was captured at tip height h. **`replay(h)` must reproduce that sample's confirmed composition exactly**: `spendable_sats`, `stranded_sats`, and the per-bucket counts. Given the same settlement set, it must reproduce identical estimates.
- The only permitted difference is the mempool effect: a confirmed input already spent in the mempool at capture time. It is explained row by row from the live snapshot's `unconfirmed_gt_dust_sats` and the transactions confirmed at h+1.
- A weekly scheduled job (`replay-equivalence.yml`) replays the last 30 daily samples. It reads production through `DATABASE_URL_METRICS` (read-only) and fails loudly with a GitHub issue on any unexplained difference.
- Equivalence failing means the live monitor and the chain disagree about the past. That is exactly the silent-mismeasurement class this project exists to catch.

---

## P4. Repository layout (brief §10)

New standalone repo, suggested name `alpenlabs/bridge-wallet-monitor`, private (Q-07, Q-17). pnpm, Node **24.x** (`engines.node`), `"type": "module"`, TypeScript `strict` + `noUncheckedIndexedAccess`.

```
bridge-wallet-monitor/
├── README.md                         run, test, deploy; links to the runbook
├── CHANGELOG.md                      one entry per release; notes value-affecting changes (P10.3)
├── package.json  pnpm-lock.yaml  tsconfig.json  vitest.config.ts
├── eslint.config.js                  bans listed in P10.1
├── .dependency-cruiser.cjs           import boundaries (AC8, P7.1)
├── vercel.json                       functions and crons (P11.2)
├── docker-compose.yml                postgres:<Neon major> + pgbouncer (pool_mode=transaction)
│
├── api/                              Vercel Functions: thin adapters, no business logic
│   ├── collect.ts                    cron: scan + compute + write + daily maintenance
│   ├── metrics.ts                    Prometheus exposition from stored rows only
│   └── drift-check.ts                cron: daily upstream drift check → drift_checks
│
├── src/
│   ├── types.ts                      shared domain types (frozen at end of WU-00)
│   ├── version.ts                    MONITOR_VERSION (from package.json at build)
│   ├── config/   schema.ts  load.ts  validate.ts
│   ├── descriptor/ checksum.ts  parse.ts
│   ├── derive/   address.ts
│   ├── chain/    esplora.ts  schemas.ts  errors.ts  limits.ts  pool.ts  bind.ts
│   ├── discovery/ gapScan.ts
│   ├── extract/  history.ts  classify.ts  settlement.ts  integrity.ts  reorg.ts
│   ├── model/                        ← THE SELECTOR PORT AND THE §4 MODEL
│   │   ├── selector.ts               SELECTOR_MODEL_VERSION, DUST_LIMIT_SATS, commitCandidateFilter, chooseUtxos
│   │   ├── cost.ts                   costSats
│   │   ├── runway.ts                 simulateRunway, singlePoolBound, runwayDays
│   │   ├── composition.ts            §4.1 partition and buckets
│   │   └── alertLevel.ts
│   ├── stats/    quantile.ts  ci.ts  regime.ts  cadence.ts  basis.ts  window.ts
│   ├── pipeline/ snapshot.ts (pure: computeWalletSnapshot)  walletRun.ts  collectRun.ts
│   ├── db/       pool.ts  lease.ts  counters.ts  retention.ts  repos/*.ts
│   ├── metrics/  contract.ts (metric registry)  readModel.ts  exposition.ts
│   ├── upstream/ manifest.ts  rustExtract.ts  normalize.ts  drift.ts
│   ├── netfee/   mempoolSpace.ts  summarize.ts
│   ├── replay/   archive.ts  asOfView.ts  replayRun.ts  outcomes.ts  backtest.ts  report.ts   (P3.11)
│   └── http/     auth.ts  respond.ts
│
├── config/
│   ├── networks/mainnet.json         per-network declarative config (P6)
│   ├── networks/signet.json          NOT CREATED until Q-01 is answered
│   ├── upstream-manifest.json        compatibility manifest (P10.2)
│   └── selector-models.json          SELECTOR_MODEL_VERSION registry (P10.2)
│
├── migrations/                       0001_init.sql, … (plain SQL, additive only)
├── scripts/
│   ├── migrate.ts                    runner (direct URL, advisory lock, checksums)
│   ├── backfill.ts                   CLI: resumable history ingest, no deadline
│   ├── replay.ts                     time machine CLI: fetch | run | import | equivalence (P3.11)
│   ├── capture-fixture.ts            records Esplora JSON and anchored UTXO sets with provenance
│   ├── provider-conformance.ts       read-only provider checks + offline aggregate identity (D-27)
│   ├── validate-configs.ts           all networks: schema, vectors, cross-file key reuse, coherence
│   ├── drift-check-ci.ts             CI entry for src/upstream/drift.ts
│   ├── tripwire-constants.ts         bans measured constants in src/ and config/
│   ├── check-timing-invariants.ts    dead-man, lease, dip-window arithmetic (P10.1)
│   ├── gen-alerts.ts                 renders per-network Grafana rules + promtool rule files (P8.4)
│   └── version-gate.ts               required semver bump from diffs (P10.3)
│
├── ops/grafana/                      Terraform root (Grafana Cloud or self-hosted)
│   ├── main.tf  scrape.tf  alerting.tf  routing.tf  dashboards.tf
│   ├── alert-params.yaml             ops-owned thresholds ($DIP, 3300, 0.10, 30, 7200, …)
│   ├── rules.tmpl.yaml               SINGLE SOURCE of rule expressions (P8.4 notation), expanded by gen-alerts.ts
│   ├── generated/<network>.json      gen-alerts output consumed by Terraform (committed, CI diff-checked)
│   ├── rules.test.yaml               promtool unit tests (AC4, AC5, AC11, dip, absent-input cases)
│   └── dashboards/wallets.json
│
├── test/
│   ├── unit/  integration/  replay/  meta/          (meta = mutation harness, P9.4)
│   └── fixtures/                                    ← GOLDEN AND REPLAY FIXTURES
│       ├── selector/golden.json                     §10 golden selection cases
│       ├── model/ac-oracles.json                    Appendix A arithmetic oracles (injected inputs)
│       ├── stats/ci-ranks.json  regime-cases.json  cadence-cases.json  basis-cases.json
│       ├── derivation/brief-vectors.json  bip84.json  bip32-tv1.json  differential-0-49.json  synthetic-signet.json
│       ├── descriptors/rejection-matrix.json
│       ├── network-params.json                      coherence table from Bitcoin Core chainparams (CI only)
│       ├── chain/<network>/<capture-id>/            PROVENANCE.json, raw/ (byte-exact), derived/ (CI-regenerated), expected/
│       ├── synthetic/<case>.json                    hand-built chain cases (N-reveal commit, foreign P2TR spend, …)
│       ├── compat/manifest.bad-hash.json            negative self-test for the drift check (AC13)
│       └── snapshots/
│           ├── ac3-declared.json                    declared EE snapshot for AC3
│           └── anchor-<wallet>-<height>.json        reconstructed, provenance-stamped (if found, P9.5)
│
├── tools/refimpl/                    Python stdlib reference (derivation, CI ranks, simulator). Regenerates
│                                     fixtures; documented, not run in CI.
├── docs/
│   ├── brief/bridge-wallet-monitor-v2-brief.md      verbatim, authoritative
│   ├── decisions.md                  D-nn log (seeded from this plan)
│   ├── open-questions.md             Q-nn tracker with owner and status
│   ├── model-divergences.md          SELECTOR_MODEL_VERSION 1 vs upstream M0/M1/M2 (P10.2)
│   └── runbook.md                    alert → action; first-run EE WARN; drills; rotation
└── .github/workflows/  ci.yml  upstream-drift.yml  live-canary.yml  deploy.yml  backfill.yml  replay-equivalence.yml
```

Where things live, as the brief asks: the **ported selector** is `src/model/selector.ts`, the only file containing `choose_utxos` semantics and the only place `546` may appear as a literal in `src/`. **Per-network config** is `config/networks/<network>.json`. **Golden fixtures** are `test/fixtures/selector/golden.json` (selection) and `test/fixtures/model/ac-oracles.json` (runway/cost oracles).

---

## P5. Data model (brief §9)

### 5.1 Topology — D-30

- **One Neon project per network** (not only one database per network). Roles are per-branch and `PUBLIC` gets `CONNECT` by default, so two databases on one branch are not isolated. RLS in a shared database was rejected: its policies depend on session `SET`, which Neon's transaction-mode PgBouncer does not support, and a policy mistake would silently mix networks into a quantile.
- Every table still carries `network text NOT NULL REFERENCES network_stamp(network)`. The single-row stamp is written only by `scripts/migrate.ts --init-network <name>`, never by the app. The FK therefore makes a foreign-network row impossible at the database level. There is no CHECK or ENUM on network names, because §8 requires adding a network without a code change.
- Driver: **`pg` (node-postgres)** with a module-scope `Pool` registered via `@vercel/functions` `attachDatabasePool`. The runtime uses the **pooled** URL. `pg` sends unnamed statements, which are safe under transaction pooling; Vercel's pool helper recognises `pg` but not postgres.js.
- Migrations run from CI on the **unpooled** URL only. They are plain numbered SQL files applied by `scripts/migrate.ts` (session advisory lock on the direct connection, each file in its own transaction, sha256 recorded, refuse if an applied file changed). They are additive only. Always write `STORED` for generated columns: PG18 defaults to VIRTUAL.
- The runtime never uses session features: no `SET`, no session advisory locks, no `LISTEN`, no SQL `PREPARE`. A lint tripwire enforces this (P10.1).
- Types: sats are `bigint`, parsed by a global int8 type parser into a JS `number` that **throws** if the value is not a safe integer (arithmetic: 2.1e15 < 2⁵³). Rates are `float8`. txids are `text CHECK (~ '^[0-9a-f]{64}$')`. Times are `timestamptz`. The UTC day is `(ts AT TIME ZONE 'UTC')::date`.

### 5.2 Tables in the §9 tiers

**`settlements`** — raw 90 d, then daily rollup. One row per commit, created at discovery; reveal fields fill in later.

| column | type | notes |
|---|---|---|
| network, wallet | text | PK part / FK `wallets` |
| commit_txid | text | **PK (network, commit_txid)** |
| commit_first_seen_at | timestamptz NOT NULL | |
| commit_block_height, commit_block_hash, commit_block_time | int / text / timestamptz NULL | NULL together (CHECK) |
| commit_fee_sats | bigint NOT NULL | |
| commit_weight | int NOT NULL | vsize is derived: weight/4 (D-10) |
| commit_input_count | int NOT NULL CHECK ≥ 1 | multi-input = ≥ 2 |
| commit_wallet_input_sats, commit_wallet_output_sats | bigint NOT NULL | for the identities (D-22) |
| layout | text NOT NULL | `chunked` \| `single` \| `none` |
| reveal_count | int NOT NULL | number of non-W P2TR outputs |
| change_present | boolean NOT NULL | |
| reveals_linked | int NOT NULL DEFAULT 0 | |
| reveal_fee_sats_sum, reveal_weight_sum, reveal_receipt_sats_sum | bigint NULL | aggregates over `settlement_reveals` |
| all_reveals_confirmed | boolean NOT NULL DEFAULT false | |
| integrity_ok | boolean NULL | D-22 (2) and (4) |
| spendable_drain_sats | bigint NULL | D-22 (3) |
| frozen | boolean NOT NULL DEFAULT false | depth ≥ finality_depth |
| status | text NOT NULL DEFAULT 'active' CHECK IN ('active','dropped') | D-25b |
| complete | boolean GENERATED ALWAYS AS (status = 'active' AND commit_block_height IS NOT NULL AND all_reveals_confirmed AND integrity_ok IS TRUE) STORED | |
| commit_day | date GENERATED ALWAYS AS ((commit_block_time AT TIME ZONE 'UTC')::date) STORED | |
| updated_at | timestamptz NOT NULL | bumped only when a value changes (`IS DISTINCT FROM`) |

Indexes: `(network, wallet, commit_block_time) WHERE complete`; `(network, wallet) WHERE NOT complete`; `(network, commit_day)`.

**`settlement_reveals`** (child; purged with its parent via `ON DELETE CASCADE`): `(network, commit_txid, p2tr_vout)` PK, `reveal_txid` (UNIQUE per network where not null), `first_seen_at`, `block_height/hash/time`, `fee_sats`, `weight`, `receipt_sats`, `has_op_return`, `op_return_position`. A later, *different* `reveal_txid` for a confirmed reveal is never overwritten. It becomes an `anomalies` row plus `events_total{kind="reveal_conflict"}`.

**View `settlement_feerates`**: `SELECT network, wallet, commit_txid, commit_block_height, commit_block_time, commit_day, (commit_weight/4.0)::float8 AS commit_vsize, (reveal_weight_sum/4.0)::float8 AS reveal_vsize, ((commit_weight+reveal_weight_sum)/4.0)::float8 AS total_vsize, commit_input_count, (4.0*(commit_fee_sats+reveal_fee_sats_sum)/(commit_weight+reveal_weight_sum))::float8 AS effective_feerate FROM settlements WHERE complete`. The **`::float8` casts are mandatory**: node-postgres returns `numeric` as strings, and a string in the type-7 interpolation concatenates instead of adding. Repos zod-parse every row. This is the **only** place the D-10 rate is computed in SQL. The TS pipeline reads it; the rate is not recomputed elsewhere.

**`snapshots`** — raw 14 d, then daily rollup. One row per *complete* wallet scan. PK `(network, wallet, run_id)`, index `(network, wallet, scan_started_at DESC)`.

Column groups (names mirror §12 so the exposition only renames):
- **As-of (non-negotiable 4):** `scan_started_at` (this is `last_update_timestamp`), `scan_finished_at`, `written_at`, `tip_height_start`, `tip_hash_start`, `tip_time_start`, `tip_height_end`, `tip_hash_end`, `provider`.
- **Provenance (§10):** `monitor_version`, `selector_model_version`, `upstream_repo`, `upstream_ref`, `deployed_build_confirmed`, `config_sha256`.
- **Composition (§4.1):** `balance_sats`, `spendable_sats`, `stranded_sats`, `unconfirmed_gt_dust_sats`, `unsupported_gt_dust_sats` with `CHECK (balance_sats = spendable_sats + stranded_sats + unconfirmed_gt_dust_sats + unsupported_gt_dust_sats)`; `largest_utxo_sats`; `utxo_count_total`, `utxo_count_dust`, `utxo_count_unconfirmed`, `utxo_count_sub_threshold NULL`, `utxo_count_spendable NULL`; `max_utxos_per_address`.
- **Discovery:** `addresses_scanned`, `max_used_idx_receive`, `max_used_idx_change`, `ceiling_hit_receive`, `ceiling_hit_change`.
- **Sample (§5.1, §9):**
  - window and sample: `active_window_days`, `window_start`, `history_covered_since`, `sample_size`, `sample_span_days`
  - basis: `insufficient_data`, `threshold_basis`, `basis_rate`, `basis_window_days`
  - quantiles (all NULL-able): `feerate_p50`, `feerate_p50_ci_lower`, `feerate_p50_ci_upper`, `feerate_p90`, `feerate_p90_ci_lower`, `feerate_p90_ci_upper`
  - regime: `median_7d`, `median_30d`, `ratio_7d_over_30d`, `regime_shift`
  - vsize: `vsize_total_median_30d`, `vsize_total_median_7d`, `vsize_used`, plus diagnostics `commit_vsize_median`, `reveal_vsize_median`
  - cadence: `spd_7`, `spd_30`, `settlements_per_day`, `commits_30d`, `commit_reveal_feerate_ratio`
- **§4.3–4.5:** `cost_p50_sats`, `cost_p90_sats`, `cost_p90_ci_upper_sats`, `runway_settlements_{p50,p90,p90_ci_upper}`, `runway_days_{p50,p90,p90_ci_upper}`, `drain_per_day_sats`, `alert_level_sats`, `alert_level_point_sats`, `trigger_5d_sats`.
- **§6/§13:** `commits_7d`, `multi_input_commits_7d`, `multi_input_ratio_7d`, `last_settlement_at`, `pending_reveals`, `fee_premium_ratio`, `network_fee_snapshot_id`, `scan_duration_s`, `requests_used`.

There are no p99 columns anywhere.

**`utxo_sets` + `utxo_set_members`** — latest only, plus one daily sample kept 30 d. `utxo_sets(set_id identity PK, network, wallet, kind CHECK IN ('latest','daily'), sample_day NULL, run_id, collected_at, tip_height, tip_hash, provider)` with partial unique indexes `(network, wallet) WHERE kind='latest'` and `(network, wallet, sample_day) WHERE kind='daily'`. `utxo_set_members(set_id FK ON DELETE CASCADE, network, txid, vout, value_sats, address, chain, idx, confirmed, block_height)`, PK `(set_id, txid, vout)`. In the snapshot transaction, replace `latest` (this is not counted as purge) and `INSERT … ON CONFLICT DO NOTHING` the day's `daily` copy, so the first complete scan of each UTC day is kept. Daily sets make any runway replayable.

**`daily_rollup`** — kept 2 y. PK `(network, wallet, day)`. It holds **composable aggregates only, never per-day quantiles** (§14.7):
- Settlement group (by `commit_day`): `s_rows`, `s_complete`, `s_multi_input`, `s_fee_sats_sum`, `s_weight_sum`, `s_commit_weight_sum`, `s_reveal_weight_sum`, `s_dust_created_sats`, `s_feerate_min`, `s_feerate_max`, `s_computed_at`, `s_source_max_updated_at`.
- Snapshot group: `n_rows`, `spendable_first`, `spendable_last`, `spendable_min`, `spendable_max`, `stranded_last`, `largest_utxo_min`, `alert_level_max`, `runway_p90_min`, `runway_p90_ci_upper_min`, `regime_shift_rows`, `insufficient_data_rows`, `last_scan_started_at`, `n_computed_at`.
- The volume-weighted daily rate is `4·s_fee_sats_sum / s_weight_sum`. `n_rows = 0` on a day means the monitor was dead; `s_rows = 0` means the sequencer was stalled.

### 5.3 Operational tables (outside §9's tiers)

| table | key | purpose | retention |
|---|---|---|---|
| `network_stamp` | network (singleton) | network binding (D-30) | never |
| `schema_migrations` | version | runner bookkeeping; runtime refuses when DB < build's required version | never |
| `wallets` | (network, wallet) | `descriptor_checksum`, `key_identity` (sha256 of script, origin fpr, h-normalised path, pubkey, chaincode), `registered_at`. No xpub stored. Rows are created by `migrate --init-network` from the validated config. Collect refuses if a configured wallet is missing or its identity differs. A legitimate replacement goes through `migrate --register-wallet <id> --replace`, documented in the runbook. | never |
| `addresses` | (network, wallet, chain, idx); UNIQUE (network, address) | gap-scan state: `address`, `scriptpubkey_hex`, `used`, `first_used_seen_at`, `tx_count_chain`, `tx_count_mempool`, `history_covered_since` (D-24 rule; `-infinity` allowed, NULL = not covered), `last_checked_at` | never (≤ 200 rows, arithmetic) |
| `address_txs` | (network, address, txid) | per-address traversal state for D-24 (a)/(c): `block_height`, `block_hash`, `first_seen_at`. Written in the step-(2) transaction. | purged at the ingest horizon (D-32), same guard as settlements |
| `wallet_other_txs` | (network, txid) | classified non-settlement txs (D-21): class, fee, weight, input count, W-in/W-out sats, block fields | Q-20 (config) |
| `anomalies` | (network, kind, ref) | first-seen record for each distinct anomaly event | Q-20 |
| `counters` | (network, metric, label_value) | persisted monotonic counters, seeded at 0 | never |
| `run_lease` | (network, job) | lease + fence + `last_completed_slot` + `last_maintenance_day` + `last_maintenance_ok_at` | never |
| `runs`, `run_wallet_results` | run_id / (run_id, wallet) | every invocation, including skipped and refused; status, error code, provider, request count, `maintenance jsonb` (per-table removed counts) | Q-20 |
| `provider_error_events` | (run_id, seq) | per-error diagnostic detail (kind, endpoint, status); the metric comes from `counters` | Q-20 |
| `drift_checks` | identity | tri-state results of pinned/tip checks (P10.2) | Q-20 |
| `network_fee_snapshots` | identity | `fetched_at`, `source`, `period`, `n_points`, `n50`, `p50`, `p90` (no p99) | Q-20 |

### 5.4 Concurrency and idempotency — D-33

- **Lease row, not advisory locks.** Session advisory locks are unsupported through Neon's pooler, and a transaction-scoped lock would have to span about 120 HTTP calls. Acquire:
  `INSERT INTO run_lease … ON CONFLICT (network, job) DO UPDATE SET holder=$run, fence=run_lease.fence+1, acquired_at=now(), expires_at=now()+make_interval(secs=>$ttl) WHERE run_lease.expires_at < now() RETURNING fence`.
  Zero rows returned means the lease is held: record `runs.status='skipped_lease_held'` and return 200. Only DB `now()` is compared.
- **Fencing.** Every write transaction starts with `SELECT … FROM run_lease WHERE holder=$run AND fence=$fence AND expires_at>now() FOR SHARE` and rolls back on 0 rows (`LeaseLostError`).
- **Timing invariant**, validated at config load and in CI: `max_duration_s < lease_ttl_s < collect_interval_s` (for example 800 < 830 < 900).
- **Slot dedupe.** `slot = floor(epoch / collect_interval_s)`. If `last_completed_slot ≥ slot`, skip with `skipped_slot_done`. It is set on release only if every wallet succeeded. `?force=1` (with CRON_SECRET) bypasses slot dedupe but never the lease.
- **Per-wallet run: two phases on one provider — D-35.** Never make an HTTP call inside a DB transaction. Only provider-error counters are written during fetching, and they autocommit.
  - **Phase A (required):** gap scan, tips (height, hash, block time), the reference-tip check, and the UTXO phase (D-03). If phase A fails, or its budget is exhausted, on every provider, **no snapshot** is written. The wallet's `last_update_timestamp` stays put and the dead-man handles it.
  - **Phase B (bounded, best effort):** history traversal (D-24), reveal linking, reorg and drop re-checks (D-25/D-25b). It is bounded by `history_page_cap_per_address`, `max_requests_phase_b` and the wallet's deadline share. Hitting a bound is **not** a wallet failure. Whatever phase B fetched is committed. Addresses that did not finish keep their previous coverage value, so the coverage gate reports `insufficient_data = 1`.
  - A **failover restarts both phases** on the next provider (provider-atomic). Phase-B data already committed from the failed provider is chain data keyed by txid and block hash, and is reused only if frozen.
  - **Write order:**
    1. fenced transaction: upsert settlements, reveals, `wallet_other_txs`, `address_txs`, events and coverage (idempotent and resumable);
    2. read the fee series from the DB and compute (pure);
    3. fenced transaction: `snapshots` + `utxo_sets` + `addresses`.
  - **A snapshot is written iff phase A completed on one provider.** A failed wallet writes a `run_wallet_results` row and nothing else.
  - Consequence: an **empty DB converges through collect alone**. Snapshots are written from the first run with `insufficient_data = 1`, and history catches up over successive runs (arithmetic: about 28 runs for 90 days of EE). The backfill job only speeds this up.
- **Backfill job.** It runs the same phase-B code with no page cap. It is a `workflow_dispatch` GitHub Actions job in environment `production-<network>` (secret `DATABASE_URL` for `app_rw`), with a local CLI equivalent. It holds its **own** lease row `(network, 'backfill')`, so collect keeps running. The two writers are safe together because every write is an idempotent upsert keyed by txid. It writes only settlements, reveals, `wallet_other_txs`, `address_txs`, events and coverage, and **never** snapshots or UTXO sets. If the internal indexer accepts only Vercel egress (Q-02), skip the job and let collect converge.
- **Settlement upsert** fills fields in (NULL to value) via `COALESCE`. Reveal fee and weight may be refreshed while unconfirmed (txid excludes the witness). Once frozen, nothing changes. `updated_at` moves only when a value changes.
- **Counters.** `provider_errors_total` is incremented by an autocommit UPDATE at the moment of failure, so a rollback cannot erase it (AC6). Event counters increment in the same transaction as `INSERT … ON CONFLICT DO NOTHING RETURNING`, only when the event is new, so duplicate runs are idempotent. Every counter series is seeded at 0 at startup for every configured provider, table and event kind; otherwise `increase()` misses the first increment.

### 5.5 Rollup and purge — D-31, D-32

Maintenance runs **inside `/api/collect`**, after all wallet writes have committed, under the same lease. It runs once per UTC day, when `last_maintenance_day < today` and the remaining time from `getDeadline()` allows. On failure it retries on the next collect, 15 minutes later. Rationale: Vercel never retries a failed cron, so a separate daily cron that fails would wait a full day. Snapshots are committed before maintenance starts, so a maintenance crash cannot trip the dead-man.

Order: (1) roll up settlements, (2) roll up snapshots, (3) purge each source **only if its rollup step succeeded in this run**, (4) daily UTXO sets, (5) operational tables, (6) `daily_rollup` older than 2 y. Then set `last_maintenance_day` and `last_maintenance_ok_at`.

- **Rollup:** recompute and overwrite every day that currently has at least one raw row. The data is tiny: at most about 180 day-groups per run. Late reveals and late confirmations therefore need no special window. Days in `[cutoff, today]` with no raw rows get an insert-only zero row. A rollup is never overwritten from zero raw rows, which protects frozen history if retention is shortened and later lengthened.
- **Purge:** whole UTC days only, oldest first, one transaction per day. Delete settlements of day D < `retention_cutoff(90)` **only if** `daily_rollup.s_rows` equals the current raw count for D and `s_computed_at ≥ max(updated_at)` of those rows. Otherwise skip and log `purge_skipped_unrolled`. Snapshots follow the same rule with `n_rows`/`n_computed_at`. Never-confirmed commits purge by `commit_first_seen_at`. In the **same transaction** as each DELETE, run `UPDATE counters SET value = value + $deleted WHERE metric='rows_purged_total' AND label_value=$table`, and write per-table counts to `runs.maintenance` and a structured log line (§9). A second run deletes 0 and adds 0 (AC10).
- **D-32 Ingest horizon:** one SQL function, `retention_cutoff(days) = (now() AT TIME ZONE 'UTC')::date − days`, used by purge, rollup and ingest. Settlement upserts are `WHERE commit_day IS NULL OR commit_day ≥ retention_cutoff(settlements_raw_days)`, and history paging stops at the horizon. Without this, re-ingestion and purge fight each other, and `rows_purged_total` climbs every day for no reason.
- **Estimator isolation (D-31):** every estimator query carries an explicit window predicate relative to `as_of`. Estimators never read `daily_rollup` and never depend on purge having run. Config validation rejects any window longer than `settlements_raw_days`.

### 5.6 Volumes (arithmetic on the brief's figures)

About 1,290–1,350 settlement rows per network at 90 d. 2,688 snapshot rows over 14 d at 15-minute collection (the brief's 1,344 figure assumes 30 minutes). 1,460 rollup rows per network over 2 y. 60 daily UTXO sets. At most 200 address rows. No partitioning, TimescaleDB or materialised views are needed (§9, "do not over-engineer").

---

## P6. Configuration schema (brief §8)

### 6.1 Rules — D-34

- `NETWORK` (env) selects `config/networks/${NETWORK}.json`. **Decision:** `vercel.json` `functions[*].includeFiles: "config/**"` bundles the files, and `loadConfig(path)` reads `join(process.cwd(), 'config/networks', `${NETWORK}.json`)`. The path is an explicit argument, so tests pass fixture paths, including the synthetic signet profile. `package.json` `"vercel-build"` runs `scripts/validate-configs.ts --network $NETWORK` before bundling, so a missing or invalid file fails the **build**. Bundling is verified on the first run of the `mainnet-staging` project (P11.1): its `runs` row must show `status = ok`. There is no preview smoke endpoint and no `dry_run` flag. Pin `"packageManager": "pnpm@<exact version current at WU-00>"` and use corepack.
- **No defaults in code.** Every field is required by the zod schema (`.default()` is banned in `src/config/` by lint). The brief's suggested policy values go in `mainnet.json`.
- **No measured constant from brief §5 may appear in config** (P10.1 tripwire). Config holds protocol values (HRP, version bytes, dust limit), policy values (windows, floors, bands, retention) and infrastructure values (URLs, timeouts).
- Validation runs in three places: CI over every `config/networks/*.json` (`scripts/validate-configs.ts`); the Vercel build step for `$NETWORK`; and the start of every `/api/collect` invocation (memoised per warm instance by config sha256). A failure at collect start writes a `runs` row with `status='refused_startup_check'` and an error code, and writes **no measurement rows**. `/api/metrics` never validates, derives or calls a provider.

### 6.2 Schema

`R` = required. Every field below is required; there are no optional fields except where marked `nullable`.

| path | type | validation (startup) |
|---|---|---|
| `schema_version` | int | equals the code's `CONFIG_SCHEMA_VERSION` |
| `network` | string `^[a-z0-9-]+$` | equals `NETWORK` env **and** `network_stamp.network` |
| `chain.bech32_hrp` | string | every vector's HRP equals it; CI coherence vs `network-params.json` |
| `chain.bip32_versions.public` / `.private` | 8-hex | every descriptor key's version bytes equal `.public`; any private version → `E_PRIVATE_KEY` |
| `chain.bip44_coin_type` | int ≥ 0 | equals the descriptor origin's 2nd element (hardened) |
| `chain.checkpoint` | `{height:int, hash:hex64}` | each Esplora provider: `GET /block-height/{height}` == hash before first use in a run, else `E_PROVIDER_NETWORK` (fatal for that provider, no data used). Mainnet: height 0, genesis `000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f`. Signet: height > 0, because all signets share a genesis block (Q-01). |
| `chain.dust_limit_sats` | int | **must equal** `DUST_LIMIT_SATS` of the selector model (546); otherwise refuse. Upstream it is a compile-time constant, not network config (Appendix B). |
| `chain.finality_depth` | int ≥ 1 | mainnet 6 (policy; the brief says only "immutable once confirmed") |
| `wallets[]` | array, len ≥ 1, unique `id` | |
| `wallets[].id` | `^[a-z0-9_]+$` | metric label `wallet`; e.g. `ee`, `ol` |
| `wallets[].display_name` | string | dashboard only |
| `wallets[].descriptor` | string | strict grammar and checks (P7.3): checksum verified **as written**; key version equals `chain.bip32_versions.public`; origin `84h/<coin>h/<acct>h`; xpub depth 3 and child number `0x80000000\|acct`; no key material reused across wallets (in file) or networks (CI) |
| `wallets[].vectors[]` | `{chain:0\|1, index:int, address:string}` | ≥ 1 on each chain; lowercase bech32; HRP match; derivation equals address exactly |
| `wallets[].vector_source` | string | provenance, e.g. "brief §4.2 (mainnet-verified)". **Self-derived vectors are forbidden.** |
| `wallets[].gap_scan` | `{min_indices, gap_limit, ceiling}` ints | `ceiling > gap_limit ≥ 1`, `ceiling ≥ min_indices` |
| `providers.esplora[]` | array, exactly one `role:"primary"` | |
| `  .name` | string | metric label `provider` |
| `  .role` | `primary` \| `failover` | order in the array = failover order |
| `  .base_url` | https URL, no trailing slash | |
| `  .auth` | `{scheme:"none"}` \| `{scheme:"bearer"\|"header", secret_env:string, header_name?:string}` | `secret_env` must be set in the environment at startup |
| `  .timeout_ms`, `.retries`, `.min_interval_ms`, `.max_tip_lag_blocks` | ints | explicit per provider; public providers get non-zero `min_interval_ms` |
| `  .tier` | `internal` \| `public` | drives `bridge_monitor_primary_is_public` (D-70) |
| `providers.network_fee` | `{name, base_url, period:"1m", refresh_minutes, timeout_ms}` | nullable for a network without a fee source |
| `estimator.quantile_window_days` | int | 30; ≤ `retention.settlements_raw_days` |
| `estimator.short_window_days` | int | 7; < quantile window |
| `estimator.min_sample` | int ≥ 2 | 30. Validation **warns** (it does not fail) that p90 CI upper needs 36. |
| `estimator.regime` | `{band_lo, band_hi, min_sample_short}` | `0 < band_lo < 1 < band_hi`; 0.67 / 1.5 / 6 |
| `estimator.cadence` | `{window_days, short_window_days, min_intervals, min_intervals_short}` | 30 / 7 / 30 / 10 (D-13); `min_intervals_short ≤ min_intervals` |
| `estimator.multi_input_window_days` | int | 7 |
| `estimator.alert` | `{level_days, trigger_days}` | 6 / 5; `level_days > trigger_days` |
| `collection` | `{interval_s, lease_ttl_s, max_duration_s, deadline_margin_s, max_requests_phase_a, max_requests_phase_b, history_page_cap_per_address, reveal_link_timeout_blocks, mempool_drop_runs, max_tip_age_s}` | `max_duration_s < lease_ttl_s < interval_s`; `interval_s` equals the `vercel.json` cron (CI). Budgets are **per wallet per run**, and each wallet gets a deadline share of `(max_duration_s − deadline_margin_s) / n_wallets`, so one wallet's failover cannot starve the other. |
| `retention` | `{settlements_raw_days:90, snapshots_raw_days:14, utxo_daily_sample_days:30, daily_rollup_days:730, ops_tables_days}` | every estimator window ≤ `settlements_raw_days` |
| `upstream.manifest_network` | string | key into `config/upstream-manifest.json`; that entry's `selector_model_version` must equal code's `SELECTOR_MODEL_VERSION`, else refuse |

**Secrets never appear in config.** Config names env vars (`secret_env`); values live in Vercel env (P11.4).

### 6.3 `config/networks/mainnet.json` values (policy, protocol and infrastructure only; none is a §5 measurement)

| field | value | rationale |
|---|---|---|
| `chain.bech32_hrp` / `bip32_versions` / `bip44_coin_type` | `bc` / `0488b21e`,`0488ade4` / `0` | Bitcoin Core chainparams |
| `chain.checkpoint` | `{height: 0, hash: 000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f}` | mainnet genesis |
| `chain.dust_limit_sats` | 546 | must equal the model constant |
| `chain.finality_depth` | 6 | conventional depth; policy |
| `wallets` | `ee`, `ol`: descriptors and the six vectors verbatim from §4.2, `vector_source: "brief §4.2 (mainnet-verified)"`, `gap_scan {6, 20, 50}` | §4.2 |
| `providers.esplora[0]` | `internal` (primary, tier `internal`): `base_url` / `auth` **from Q-02**, `timeout_ms 10000`, `retries 1`, `min_interval_ms 100`, `max_tip_lag_blocks 2` | internal indexer is primary (§7); requests stay serial and paced |
| `providers.esplora[1]` | `blockstream` (failover, `public`): `https://blockstream.info/api`, `timeout_ms 10000`, `retries 0`, `min_interval_ms 1000`, `max_tip_lag_blocks 2` | §7 names it; 1 req/s because it returned 429s during analysis |
| `providers.esplora[2]` | `mempool` (failover, `public`): `https://mempool.space/api`, same values as blockstream | §7 |
| `providers.network_fee` | `mempool.space`, `https://mempool.space/api`, `period "1m"`, `refresh_minutes 60`, `timeout_ms 10000` | P3.10 |
| `estimator` | windows 30/7; `min_sample 30`; regime `{0.67, 1.5, min_sample_short 6}`; cadence `{30, 7, min_intervals 30, min_intervals_short 10}`; `multi_input_window_days 7`; alert `{6, 5}` | §5.1, §9, §4.5; P3 |
| `collection` | `interval_s 900`, `lease_ttl_s 830`, `max_duration_s 800`, `deadline_margin_s 60`, `max_requests_phase_a 250`, `max_requests_phase_b 150`, `history_page_cap_per_address 20`, `reveal_link_timeout_blocks 6`, `mempool_drop_runs 8`, `max_tip_age_s 10800` | Phase A worst case at the ceiling is about 100 stats + ≤ 100 utxo + 5 tips/checks, hence 250. Deadline share = 370 s per wallet; at 1 req/s on a public failover the steady phase A (about 60 requests) takes about 60 s. |
| `retention` | 90 / 14 / 30 / 730; `ops_tables_days 90` | §9; Q-20 |
| `upstream.manifest_network` | `mainnet` | |

The internal provider's `base_url` and `auth` are the only values the plan cannot supply (Q-02). Until then, Stage 0 lists `blockstream` as primary with `tier: "public"` (D-70).

---

## P7. Interfaces

### 7.0 Shared types — `src/types.ts` (frozen at the end of WU-00; every lane codes against these)

```ts
type Sats = number;                        // safe integer, asserted at every boundary
type Network = string;                     // config id, e.g. 'mainnet'
interface Utxo { txid: string; vout: number; valueSats: Sats; confirmed: boolean; blockHeight: number | null;
                 address: string; chain: 0 | 1; index: number; scriptType: 'p2wpkh' | 'p2tr' | 'other' }
interface SettlementObs {                  // one per stored settlement commit, ≥ 30 d back; built from settlements ⟕ settlement_feerates
  commitTxid: string; commitHeight: number | null; commitBlockTime: number | null /* epoch s */;
  inputCount: number; confirmed: boolean; dropped: boolean;
  complete: boolean; integrityOk: boolean | null;
  feerate: number | null; commitVsize: number | null; revealVsize: number | null; totalVsize: number | null; // null unless complete
  commitOnlyRate: number | null; revealOnlyRate: number | null;                                               // fingerprint D-23
}
interface ScanMeta { provider: string; scanStartedAt: Date; scanFinishedAt: Date; tipStart: TipRef; tipEnd: TipRef;
                     ceilingHit: { receive: boolean; change: boolean }; maxUsedIdx: { receive: number | null; change: number | null };
                     addressesScanned: number; maxUtxosPerAddress: number; requestsUsed: number; phaseBComplete: boolean }
interface TipRef { height: number; hash: string; blockTime: number }
interface NetworkFeeSummary { fetchedAt: Date; source: string; period: string; nPoints: number; n50: number; p50: number; p90: number }
interface Composition { spendableSats: Sats; strandedSats: Sats; unconfirmedGtDustSats: Sats; unsupportedGtDustSats: Sats;
                        balanceSats: Sats; largestUtxoSats: Sats; counts: { total: number; dust: number; unconfirmed: number;
                        subThreshold: number | null; spendable: number | null }; poolSats: Sats[] /* = spendable set values */ }
type QuantileResult = { n: number; supported: false } |
                      { n: number; supported: true; point: number; lower: number; upper: number; l: number; u: number };
type TxClass = 'settlement_commit' | 'settlement_reveal' | 'deposit' | 'internal_consolidation' | 'external_spend' | 'mixed_spend';
type EventKind = 'deposit' | 'internal_consolidation' | 'external_spend' | 'mixed_spend' | 'unknown_output_address'
  | 'layout_unrecognized' | 'unlinked_commit' | 'reveal_receipt_ne_dust' | 'reveal_count_ne_1' | 'commit_without_change'
  | 'dust_spent_by_non_settlement' | 'reveal_conflict' | 'reorg_beyond_finality' | 'tx_dropped';
type SnapshotRecord = { /* exactly the P5.2 `snapshots` columns, camelCased; nullability as in P5.2 */ };
```
`EsploraTx`, `AddressStats`, `EsploraUtxo`, `TxStatus` and `Outspend` are the zod-inferred types from `src/chain/schemas.ts` (P7.4). `WalletCfg`, `EstimatorCfg` and `RetentionCfg` are zod-inferred from `src/config/schema.ts` (P6.2). `Lease` is `{ network: string; job: 'writer' | 'backfill'; runId: string; fence: bigint }`.


### 7.1 Module boundaries (enforced by dependency-cruiser in CI)

```
api/metrics.ts ──► src/metrics/* ──► src/db/repos/*          (NEVER src/chain, src/extract, src/discovery, src/netfee, src/upstream)
api/collect.ts ──► src/pipeline/collectRun ──► {chain, discovery, extract, pipeline/snapshot, db, netfee}
src/pipeline/snapshot.ts (PURE) ──► {model/*, stats/*}       (no I/O imports at all)
src/model/*, src/stats/* (PURE)  ──► nothing outside src/types.ts
src/extract/* ──► src/chain (types only) + src/types.ts
```

Rules: `src/model` and `src/stats` may not import from `src/db`, `src/chain`, `node:*` (except `node:assert`), or `fetch`. `api/metrics.ts` may not reach `src/chain/**` transitively (AC8, structural half). `HDKey.fromJSON` is banned, as is `fromExtendedKey` without a versions argument.

### 7.2 Selector port — `src/model/selector.ts`

```ts
export const SELECTOR_MODEL_VERSION = 1 as const;       // brief §4.4 semantics over upstream M2 first pass as read at 7f20dcb
export const DUST_LIMIT_SATS = 546 as const;            // upstream BITCOIN_DUST_LIMIT (builder.rs), compile-time constant

export interface Candidate { readonly id: string; readonly valueSats: number }   // id = "txid:vout"
export type Selection =
  | { ok: true;  inputs: readonly Candidate[]; sumSats: number }
  | { ok: false; reason: 'NotEnoughUtxos'; amountSats: number; availableSats: number };

/** §3.2(a) pre-filter: value > 546 ∧ confirmed ∧ p2wpkh|p2tr. spendable/solvable are unobservable
 *  watch-only and are taken as true for descriptor-derived addresses (documented in model-divergences.md). */
export function commitCandidateFilter(u: Utxo): boolean;

/** Faithful port of choose_utxos. Single branch: filter value >= amount, STABLE ascending sort, take [0].
 *  Fallback: filter value < amount, STABLE descending sort, accumulate until sum >= amount, stop.
 *  Ties keep input order (upstream: listunspent order, unspecified). Pure; no I/O; integer sats. */
export function chooseUtxos(candidates: readonly Candidate[], amountSats: number): Selection;
```

Port notes. `sort_by_key` in Rust is stable, so use a stable sort explicitly: `Array.prototype.sort` is stable in V8, but assert it in a test. `>=` in the single-input branch and `<` in the fallback partition must match the source exactly. Do not port the M2 carry pass, headroom or per-input-count fee iteration (Q-18, `docs/model-divergences.md`).

### 7.3 Descriptor and derivation — `src/descriptor/*`, `src/derive/address.ts`

```ts
export function descriptorChecksum(body: string): string;                // BIP380, BigInt polymod
export function parseWalletDescriptor(desc: string, net: ChainParams): ParsedWallet;  // throws DescriptorError{code}
export type ParsedWallet = { script: 'wpkh'; originFingerprint: string; originPath: readonly [number, number, number];
                             account: HDKey; keyIdentity: string };
export function deriveAddress(w: ParsedWallet, chain: 0 | 1, index: number, hrp: string):
  { address: string; scriptPubKeyHex: string };                          // HDKey.fromExtendedKey(key, versions).deriveChild(c).deriveChild(i)
```

- Accepted grammar, exactly: `wpkh([FPR/84H/COINH/ACCTH]KEY/<0;1>/*)#CHK`. `H` is `h` or `'`, mixed allowed per BIP380; uppercase `H` is rejected. Anything else fails with a distinct error code: `E_CHECKSUM_MISSING`, `E_CHECKSUM_MISMATCH`, `E_CHARSET`, `E_UNSUPPORTED_SCRIPT`, `E_HARDENED_MARKER`, `E_HARDENED_WILDCARD`, `E_MULTIPATH`, `E_GRAMMAR`, `E_KEY_BASE58`, `E_KEY_LENGTH`, `E_PRIVATE_KEY` (never echo the key), `E_SLIP132` (zpub/vpub: reject, do not convert), `E_NETWORK_VERSION`, `E_KEY_POINT`, `E_ORIGIN_PURPOSE`, `E_NETWORK_COINTYPE`, `E_DEPTH`, `E_CHILD_NUMBER`, `E_VECTOR_FORMAT`, `E_VECTOR_HRP`, `E_VECTOR_MISMATCH`, `E_VECTOR_COVERAGE`, `E_DUPLICATE_KEY`, `E_WALLET_IDENTITY_CHANGED`, `E_PROVIDER_NETWORK`, `E_TEST_KEY`.
- Libraries, pinned exactly: `@scure/bip32@2.4.0`, `@scure/base@2.4.0`, `@noble/hashes@2.4.0` (with `@noble/curves@2.4.0` transitively). They are pure JS (no WASM on Vercel), audited, and `fromExtendedKey(key, versions)` enforces version bytes. Take RIPEMD-160 from `@noble/hashes/legacy.js`, not `node:crypto`. Do not use bitcoinjs-lib, tiny-secp256k1 or full miniscript libraries.
- Log hygiene: never log or emit a descriptor or key. Log the wallet id, the checksum and the first 4 characters of the key only.

### 7.4 Chain access — `src/chain/*`

```ts
export interface EsploraClient {
  readonly provider: string;
  tipHeight(): Promise<number>; tipHash(): Promise<string>; blockHashAt(h: number): Promise<string>;
  addressStats(a: string): Promise<AddressStats>; addressUtxos(a: string): Promise<EsploraUtxo[]>;
  addressTxsChain(a: string, lastSeen?: string): Promise<EsploraTx[]>; addressTxsMempool(a: string): Promise<EsploraTx[]>;
  tx(txid: string): Promise<EsploraTx>; txStatus(txid: string): Promise<TxStatus>; outspend(txid: string, vout: number): Promise<Outspend>;
}
export type ProviderErrorKind = 'timeout'|'rate_limited'|'server_error'|'utxo_limit'|'history_limit'|'not_found'
  |'bad_request'|'wrong_network'|'malformed'|'inconsistent'|'stale_tip'|'budget_exhausted';
export class ProviderError extends Error { provider: string; kind: ProviderErrorKind; status?: number; failover: boolean }

/** Provider-atomic scan: run `scan` wholly on one provider; on a failover-able error restart it from scratch on
 *  the next provider (sticky for the rest of the run). Every error → counters.provider_errors_total{provider} (autocommit). */
export function runWalletScan<T>(wallet: WalletCfg, pool: ProviderPool, budget: RunBudget,
  scan: (c: EsploraClient) => Promise<T>): Promise<{ ok: true; provider: string; value: T } | { ok: false; errors: ProviderError[] }>;
export class SerialLimiter { constructor(minIntervalMs: number); run<T>(fn: () => Promise<T>): Promise<T> }
export class RunBudget { constructor(deadlineAtMs: number, maxRequests: number); take(): void; remainingMs(): number }
```

**Error table (D-28):**

| condition | kind | action |
|---|---|---|
| timeout, reset, 408 | `timeout` | retry the same provider up to `.retries`, then fail over |
| 429 | `rate_limited` | fail over at once |
| 5xx | `server_error` | fail over |
| 400 matching `/Too many (unspent\|history)/` | `utxo_limit` / `history_limit` | fail over. If every provider fails, the wallet scan **fails with that reason**. Never treat it as an empty set. |
| 400 "Address on invalid network", or checkpoint mismatch | `wrong_network` | **fatal for that provider**; do not use its data; alert |
| other 400 | `bad_request` | fail the scan; this is a bug |
| 404 on `/tx` | `not_found` | fail over |
| invalid JSON / zod failure | `malformed` | fail over |
| tip stale: behind the reference provider by more than `max_tip_lag_blocks`, **or** tip block time older than `max_tip_age_s` while another provider has a newer tip | `stale_tip` | fail over. The reference is the next provider in order; the last provider is checked against the primary. If the reference is unreachable, skip the relative check and log it. If **every** provider agrees on an old tip, it is the network, not the indexer: write the snapshot and let R17 WARN. |
| integrity/completeness/truncation failure (D-22, D-24) | `inconsistent` | fail over |
| budget or deadline share exhausted | `budget_exhausted` | in **phase A**: the wallet fails, and no snapshot is written. In **phase B**: stop phase B, commit what was fetched, continue (not a failure; D-35). |

zod response schemas: `status.block_*` are nullish (the code omits them; the docs say null). `scriptpubkey_address` is optional. Unknown keys pass through. `scriptpubkey_type` is a string, not a closed enum (mempool adds `anchor`). Values, fees and weights are non-negative safe integers. The tip height is parsed from `text/plain` with `/^\d+$/`.

Request budget (arithmetic, at the brief's indices and gap 20): about 122 requests per steady-state run: 100 stats, about 16 utxo, 2 tips, about 2 status and a few history pages. That is higher than §11's "~90". The phase-A budget has more than 2× steady-state headroom per wallet, so a provider-atomic restart fits (AC6 "without gaps").

### 7.5 Extraction — `src/discovery`, `src/extract`

```ts
gapScan(derive: (c: 0|1, i: number) => string, stats: (a: string) => Promise<AddressStats>, p: GapParams)
  : Promise<ChainScan[]>                                       // D-01; ceilingHit per chain
syncAddressHistory(c: EsploraClient, a: ScannedAddress, known: KnownTxs, p: { horizonUnix: number; pageCap: number })
  : Promise<{ confirmed: EsploraTx[]; mempool: EsploraTx[]; complete: boolean }>   // D-24; throws inconsistent on truncation
classifyTx(tx: EsploraTx, W: ReadonlySet<string>, commitOutpoints: ReadonlyMap<string, string>): TxClass   // D-20/D-21, pure
linkReveals(c: EsploraClient, commit: EsploraTx, p2trVouts: number[], tip: number, p: { linkTimeoutBlocks: number })
  : Promise<Array<{ vout: number; state: 'linked'; reveal: EsploraTx } | { vout: number; state: 'pending' | 'unlinked' }>>
checkIntegrity(commit: EsploraTx, reveals: EsploraTx[], W: ReadonlySet<string>)
  : { ok: boolean; spendableDrainSats: number; failures: string[] }                // D-22, exact sats
reverifyUnfrozen(c: EsploraClient, rows: StoredTx[], tip: number, finalityDepth: number): Promise<ReorgAction[]>  // D-25
```

### 7.6 Statistics — `src/stats/*` (pure)

```ts
quantileType7(sortedAsc: readonly number[], q: 0.5 | 0.9): number;                       // throws on n = 0
exactCiRanks(n: number, q: { num: bigint; den: bigint }): { l: number | null; u: number | null };
quantileWithCi(values: readonly number[], q: 'p50' | 'p90'):
  { n: number; supported: false } | { n: number; supported: true; point: number; lower: number; upper: number; l: number; u: number };
regime(s7: readonly number[], s30: readonly number[], cfg: RegimeCfg & { minSample: number }):
  { m7: number | null; m30: number | null; ratio: number | null; shift: 0 | 1; active: 'short' | 'default' };
cadence(commits: readonly { height: number; txid: string; blockTime: number }[], cfg: { minIntervals: number }):
  { medianIntervalS: number | null; settlementsPerDay: number | null; intervals: number; zeroIntervals: number };
thresholdBasis(i: { active: QuantileResult; s30Max: number | null; nActive: number; minSample: number;
                    cadenceOk: boolean; coverageComplete: boolean }):
  { basis: 'ci_upper' | 'window_max' | 'none'; rate: number | null; insufficientData: 0 | 1 };
```

### 7.7 Cost / runway / composition — `src/model/*` (pure)

```ts
costSats(vsizeSum: number, rateSatVb: number): number;                // ceil(vsizeSum*rate) + DUST_LIMIT_SATS
simulateRunway(poolSats: readonly number[], costSats: number):
  { settlements: number; exactDustChanges: number; finalPoolSats: number[] };   // §4.4 loop, uses chooseUtxos
singlePoolBound(spendableSats: number, costSats: number): number;      // max(0, floor((V-546)/cost)) — tests only
runwayDays(settlements: number, settlementsPerDay: number): number;
composition(utxos: readonly Utxo[], requiredAtBasisSats: number | null): Composition;   // D-05 partition + buckets
alertLevelSats(levelDays: number, settlementsPerDay: number, costAtBasisSats: number): number;
```

### 7.8 The pure core — `src/pipeline/snapshot.ts`

```ts
/** THE boundary that makes replay possible: no I/O, no clock, no config loading. */
export function computeWalletSnapshot(i: {
  asOf: Date; wallet: WalletCfg; estimator: EstimatorCfg;
  utxos: readonly Utxo[];                       // this scan's /utxo result, already partitioned by address
  settlements: readonly SettlementObs[];        // from settlement_feerates + settlements, ≥ 30 d back
  historyCoveredSince: Date | null;
  scanMeta: ScanMeta;                           // tip, provider, ceiling flags, timings
  networkFee: NetworkFeeSummary | null;
}): SnapshotRecord;                              // exactly the `snapshots` row shape
```

`walletRun.ts` does the I/O around it: scan (provider-atomic), then the settlement upsert transaction, then a DB read of the series, then `computeWalletSnapshot`, then the snapshot transaction. `collectRun.ts` does the auth-free orchestration, in this order:
1. startup validation (config, manifest, DB stamp, wallet identity, `REQUIRED_SCHEMA_VERSION`);
2. lease and slot dedupe;
3. network fee refresh, only if the latest `network_fee_snapshots.fetched_at` is older than `refresh_minutes`, with a hard timeout. A failure increments `provider_errors_total{provider="mempool.space"}` and never blocks wallets;
4. wallets in config order, each with its own budget and deadline share. EE and OL are independent, so one failing does not stop the other. Each gets the latest network fee summary only if it is younger than 2 × `refresh_minutes`, otherwise `null` and the ratio is absent;
5. maintenance (P5.5);
6. lease release.

`REQUIRED_SCHEMA_VERSION` is a constant in `src/db`, and CI checks that it equals the highest migration number.

### 7.9 Storage — `src/db/*`

```ts
acquireLease(net: string, job: 'writer', runId: string, ttlS: number, slot: bigint): Promise<Lease | null>;
withFencedTx<T>(lease: Lease, fn: (tx: PoolClient) => Promise<T>): Promise<T>;          // throws LeaseLostError
releaseLease(lease: Lease, allWalletsOk: boolean, slot: bigint): Promise<void>;
seedCounters(net: string, spec: { metric: string; labels: string[] }[]): Promise<void>;
incrementProviderError(net: string, provider: string): Promise<void>;                     // autocommit
recordEvent(tx: PoolClient, net: string, wallet: string, kind: EventKind, ref: string, detail: object): Promise<boolean>;
runMaintenance(lease: Lease, cfg: RetentionCfg, deadline: Date | undefined): Promise<MaintenanceResult>;
assertDbStamp(net: ValidatedNetwork): Promise<void>;   // stamp, schema version, wallet identity, stored addresses == derived
// repos: settlements.upsert/readWindow, snapshots.insert/latestPerWallet, utxoSets.replaceLatest/insertDaily,
//        addresses.upsertScan, runs.*, drift.*, networkFee.*
```

### 7.10 HTTP handlers — `api/*` (thin)

| route | auth | behaviour |
|---|---|---|
| `GET /api/collect` | `Authorization: Bearer ${CRON_SECRET}`, constant-time. Returns 401 if the env var is unset. | `runCollect()`. 200 with `{run_id, skipped?, wallets:[{wallet,status,provider,scan_started_at,duration_s}]}`. `export const config = { maxDuration: 800 }` |
| `GET /api/metrics` | `Bearer` token ∈ `METRICS_BEARER_TOKENS` (≤ 2, for rotation). **Never CRON_SECRET.** | One `READ ONLY` transaction, then `readMetricsModel()`, then `renderExposition()`. `text/plain; version=0.0.4`, `Cache-Control: no-store`, **5xx if the DB read fails** (never an empty 200). No sample timestamps. |
| `GET /api/drift-check` | Bearer CRON_SECRET | `runDriftCheck()` → `drift_checks` row. Tri-state; a fetch error is `unknown`, never `ok`. |

`readMetricsModel(db, cfg): MetricsModel` and `renderExposition(model, cfg): string` are separate, and the second is pure. That lets exposition completeness be tested without a DB.

### 7.11 Time machine — `src/replay/*` (P3.11)

```ts
/** Same read surface as EsploraClient; every answer filtered to height ≤ H; tip = H. */
interface ChainView extends Omit<EsploraClient, 'provider'> { readonly asOf: { height: number; blockTime: number } }
openArchive(dir: string): Promise<ChainArchive>;                     // content-addressed raw/ store + PROVENANCE
fetchIntoArchive(archive: ChainArchive, net: ValidatedNetwork, c: EsploraClient): Promise<FetchReport>;  // full histories
asOfView(archive: ChainArchive, height: number): ChainView;
replayAt(net: ValidatedNetwork, view: ChainView, opts: { mempoolProxy: boolean }): Promise<SnapshotRecord[]>;
  // runs the production phase A + B logic (no budgets) against `view`, then computeWalletSnapshot — no replay-only math
backtest(net: ValidatedNetwork, archive: ChainArchive, range: { from: number; to: number; step: Step }): AsyncIterable<SnapshotRecord>;
deriveOutcomes(archive: ChainArchive, net: ValidatedNetwork, range: HeightRange): Outcome[];             // D-84
evaluateRules(seriesOm: string, generatedRules: string): Promise<AlertInterval[]>;                      // promtool over P8.4 output
equivalence(liveSample: UtxoSetSample, replayed: SnapshotRecord): { ok: boolean; explainedByMempool: string[]; unexplained: string[] };
```
`replayRun.ts` imports the same `gapScan`, `classifyTx`, `linkReveals`, `checkIntegrity` and `computeWalletSnapshot` that `walletRun.ts` uses. dependency-cruiser forbids `src/replay/**` from importing `src/db/**` write paths and `api/**`.

---

## P8. Metrics contract and alert rules (brief §11–§13)

### 8.1 Exposition rules — D-60…D-61

- `/api/metrics` renders **only stored rows**: the latest snapshot per configured wallet (`DISTINCT ON`), `counters`, the latest `drift_checks`, the latest `network_fee_snapshots`, `runs`, `run_lease`, the manifest and the version. It never computes an estimate and never touches a provider (AC8).
  - It uses one `READ ONLY REPEATABLE READ` transaction on the `metrics_ro` role.
  - It returns **503 with no body** on any DB error, never a partial or empty 200.
  - It keeps serving the latest row however old it is. Hiding stale rows would turn staleness into missing series, and missing series resolve alerts. Staleness is the dead-man's job.
- **The service writes `network="<config.network>"` into every series itself**, including `bridge_monitor_*`. Do **not** add `network` as a static label on the scrape job. Under `honor_labels=false` a conflicting target label renames the scraped one to `exported_network`, and every rule's selector breaks.
- **No sample timestamps** (Prometheus exporter guidance). The as-of for every wallet figure is `bridge_wallet_last_update_timestamp`: the snapshot's `scan_started_at` in epoch seconds, captured before the first upstream request of the successful scan attempt. All per-wallet series in one response come from the same snapshot row. Dashboards show the as-of next to every figure (non-negotiable 4).
- **Never NaN, never Inf, never 0 as a stand-in for "unknown".** The renderer asserts `Number.isFinite`. A NULL column means the series is **omitted**. Series whose 0 is a true measurement are always emitted once a snapshot exists: `spendable_sats`, `stranded_sats`, `balance_sats`, `largest_utxo_sats` (0 when the pool is empty), `utxo_count{bucket="dust"}`, `unconfirmed_sats`, `feerate_sample_size`, `insufficient_data`, `regime_shift`. Two more mechanisms make sure absence never reads as good news:
  1. **Always-on per configured wallet**, from the first scrape, even before any snapshot: `last_update_timestamp` (0 if none) and `insufficient_data` (1 if none). Counters are **seeded at 0** for every configured provider, purgeable table and event kind.
  2. **Rules are written so a missing input cannot look healthy** (8.4). This is done with `bool` comparisons, an `EXPECTED_WALLETS` vector, `missing_series_evals_to_resolve = 20`, and a CRITICAL "threshold unavailable" rule.
- The response is `text/plain; version=0.0.4; charset=utf-8` with `Cache-Control: no-store`. One HELP and one TYPE per family; each HELP gives unit, definition, and "as of `bridge_wallet_last_update_timestamp`". Integers are printed as integers and floats as the shortest round-trip, unrounded. HELP/TYPE come from `src/metrics/contract.ts`, the single registry of names, types and label allowlists. A contract test parses the exposition from a fixture run and fails on:
  - any metric outside the registry;
  - any series without `network`;
  - any `bridge_wallet_*` series without a configured `wallet`;
  - any `quantile` label value other than `p50` or `p90`;
  - the substring `p99` anywhere;
  - more than 150 series per network.

### 8.2 §12 metrics → source

| metric | type | labels (besides network) | source | when absent |
|---|---|---|---|---|
| `bridge_wallet_spendable_sats` | gauge | wallet | `snapshots.spendable_sats` | no snapshot yet |
| `bridge_wallet_stranded_sats` | gauge | wallet | `.stranded_sats` | no snapshot |
| `bridge_wallet_balance_sats` | gauge | wallet | `.balance_sats` (the /utxo total; display only; **lint: no rule may reference it**, non-negotiable 5) | no snapshot |
| `bridge_wallet_largest_utxo_sats` | gauge | wallet | `.largest_utxo_sats` (max over the §4.1 spendable set; 0 if empty; invariant `largest ≤ spendable`) | no snapshot |
| `bridge_wallet_utxo_count` | gauge | wallet, bucket=`dust\|sub_threshold\|spendable\|unconfirmed`* | `.utxo_count_*`. HELP must say `bucket="spendable"` means "individually sufficient for a single-input commit at the alert basis", **not** the §4.1 set. | `sub_threshold`/`spendable` when basis = none |
| `bridge_wallet_cost_per_settlement_sats` | gauge | wallet, scenario=`p50\|p90\|p90_ci_upper` | `.cost_*_sats`. `p90_ci_upper` **is** the alert-basis cost (regular or fallback, P3.9). | per P3.9 emission rules |
| `bridge_wallet_runway_days` | gauge | wallet, scenario | `.runway_days_*` | per P3.9 (0 in all scenarios when Σpool < 1,092) |
| `bridge_wallet_feerate_quantile_ci` | gauge | wallet, quantile=`p50\|p90`, bound=`lower\|upper` | `.feerate_*_ci_*` | quantile unsupported (P3.5) |
| `bridge_wallet_feerate_sample_size` | gauge | wallet | `.sample_size` (the **active** window) | never once a snapshot exists (0 is valid) |
| `bridge_wallet_feerate_sample_span_days` | gauge | wallet | `.sample_span_days` | n < 2 |
| `bridge_wallet_regime_shift` | gauge 0\|1 | wallet | `.regime_shift` | never once a snapshot exists (0 when the ratio is not computable) |
| `bridge_wallet_feerate_ratio_7d_over_30d` | gauge | wallet | `.ratio_7d_over_30d` | not computable (P3.6) |
| `bridge_monitor_version` | info (=1) | version, git_sha | `MONITOR_VERSION`, `VERCEL_GIT_COMMIT_SHA` | never |
| `bridge_monitor_selector_model_version` | gauge | — | `SELECTOR_MODEL_VERSION` of the **serving** build. Each snapshot row also stores the computing build's version, for deploy-skew audit. | never |
| `bridge_monitor_upstream_ref` | info (=1) | repo, commit (40-hex), deployed_build_confirmed | manifest entry for the network | never |
| `bridge_monitor_rows_purged_total` | counter | table | `counters` | never (seeded 0) |
| `bridge_wallet_alert_level_sats` | gauge | wallet | `.alert_level_sats` (basis rate, P3.9) | basis = none |
| `bridge_wallet_settlements_per_day` | gauge | wallet | `.settlements_per_day` (never 0; absent instead) | cadence unavailable |
| `bridge_wallet_multi_input_ratio_7d` | gauge | wallet | `.multi_input_ratio_7d` | C = 0 |
| `bridge_wallet_realized_feerate_sat_vb` | gauge | wallet, quantile=`p50\|p90` | `.feerate_p50/p90` | unsupported |
| `bridge_wallet_fee_premium_ratio` | gauge | wallet | `.fee_premium_ratio` (display only; lint: no rule may use it) | P3.10 |
| `bitcoin_inclusion_feerate_sat_vb` | gauge | quantile=`p50\|p90` | latest `network_fee_snapshots`. HELP: "30-min bucket averages of per-block median fee rate, integer-quantized by source". | no fee source / fetch failed |
| `bridge_wallet_last_update_timestamp` | gauge (epoch s) | wallet | latest `.scan_started_at` | never (0 if no snapshot) |
| `bridge_monitor_provider_errors_total` | counter | provider | `counters` | never (seeded 0) |
| `bridge_monitor_scan_duration_seconds` | gauge | wallet | `.scan_duration_s` | no snapshot |

\* `bucket="unconfirmed"` is an addition, so the buckets partition the UTXO count.

**Additions** (minimal; each is needed to express a §13 rule or a non-negotiable; see Appendix B):

| metric | type | why |
|---|---|---|
| `bridge_wallet_insufficient_data{wallet}` | gauge 0\|1, always on | §5.1 item 3. 1 whenever the threshold is not on the regular basis (P3.7), including the n = 30–35 band and the coverage gate, neither of which §13's `sample_size < 30` rule can see. |
| `bridge_wallet_alert_basis_feerate_sat_vb{wallet,basis,window}` | gauge | The basis rate and its provenance in one series: `basis ∈ ci_upper\|window_max`, `window ∈ 7d\|30d`. §5.1 item 1 ("visibly weak"). Absent when basis = none. |
| `bridge_wallet_drain_per_day_sats{wallet}` | gauge | `spd × cost(basis)`. Lets ops tune the K-day level in Grafana without a deploy (§11). |
| `bridge_wallet_last_settlement_timestamp{wallet}` | gauge | The §13 stall rule cannot be written without it. Latest confirmed settlement commit, whatever the reveal status. |
| `bridge_wallet_cadence_settlements_per_day{wallet,window="7d"\|"30d"}` | gauge | D-13 inputs, for the count-vs-cadence check (Q-05) |
| `bridge_wallet_commits_7d`, `bridge_wallet_multi_input_commits_7d`, `bridge_wallet_commits_30d` | gauges | Small-denominator visibility (§6) and the count-vs-cadence diagnostic |
| `bridge_wallet_unconfirmed_sats{wallet}` | gauge | Input to the post-commit dip handling (8.4), not just display |
| `bridge_wallet_scan_ceiling_hit{wallet,chain="receive"\|"change"}` | gauge 0\|1 | §4.2 "silently go blind" |
| `bridge_wallet_max_utxos_per_address{wallet}` | gauge | Early warning before electrs `utxos_limit` (P0 item 9) |
| `bridge_wallet_snapshot_tip_height{wallet}`, `bridge_wallet_snapshot_tip_time{wallet}` | gauges | As-of block for reconciliation; tip freshness (D-53) |
| `bridge_wallet_history_coverage_days{wallet}` | gauge | Coverage gate (Q-16) |
| `bridge_wallet_settlements_pending{wallet}` | gauge | Commits with a reveal that is not yet linked or confirmed |
| `bridge_wallet_events_total{wallet,kind}` | counter, seeded | kinds: `deposit`, `internal_consolidation`, `external_spend`, `mixed_spend`, `unknown_output_address`, `layout_unrecognized`, `unlinked_commit`, `reveal_receipt_ne_dust`, `reveal_count_ne_1`, `commit_without_change`, `dust_spent_by_non_settlement`, `reveal_conflict`, `reorg_beyond_finality` (D-21…D-25). A persisted counter, incremented only on newly inserted events, so it never decreases when rows are purged. |
| `bridge_wallet_commit_reveal_feerate_ratio{wallet}` | gauge | Build fingerprint (D-23) |
| `bridge_wallet_scan_provider{wallet,provider}` | info | AC6 verification; primary-not-used rule |
| `bridge_monitor_primary_is_public` | gauge 0\|1 | Stage 0 flag (D-70) |
| `bridge_monitor_deployed_build_confirmed` | gauge 0\|1 | Q-03, visible |
| `bridge_monitor_upstream_drift{check="pinned"\|"tip"}` | gauge 0\|1 | §13 drift WARN |
| `bridge_monitor_upstream_drift_check_timestamp{check}` | gauge | Advances only on a **conclusive** check. A stale or never-run check must alert (GitHub auto-disables schedules; Instant Rollback leaves stale crons). |
| `bridge_monitor_last_run_timestamp`, `bridge_monitor_last_run_status{status}` | gauge / info | Why a run refused (for example `refused_startup_check`) |
| `bridge_monitor_maintenance_last_success_timestamp` | gauge | A dead purge/rollup is visible |
| `bitcoin_inclusion_feerate_last_update_timestamp` | gauge | As-of for the network fee context (non-negotiable 4) |

Cardinality is about 45 series per wallet plus about 30 per network. The contract test bounds it at 150.

### 8.3 Read path — D-61

**Chosen: Prometheus exposition at `/api/metrics`, scraped by Grafana, with Grafana-managed alert rules written in PromQL.**

Rationale:
- §12 is a Prometheus contract (it has `_total` counters) and §13 is written in PromQL. Keeping both as specified makes the contract testable in code.
- Neon stays private to Vercel. Grafana Cloud has no per-stack static IPs, so it would otherwise have to reach Neon from unpinned addresses.
- The scraped TSDB is an independent record of what the monitor said and when. v1 lacked that record, and this one survives the §9 purges.

Rules are **Grafana-managed**, not Mimir-ruler rules, because only Grafana-managed rules expose NoData/Error mapping, `keepFiringFor` and `missing_series_evals_to_resolve`. Each rule is **one pure-PromQL expression** returning 0|1 per series, followed by a Threshold node `A > 0`. The same expression string is rendered into a Prometheus rule file for `promtool test rules` in CI.

**By Q-06 answer:**
- *Grafana Cloud:* a hosted Metrics Endpoint scrape job with a 60 s interval and bearer auth. It supports only Basic or Bearer auth and no custom headers, so the production domain must be free of Vercel Deployment Protection (P11.1).
- *Self-hosted with Prometheus or Alloy:* a `scrape_config` with `authorization: {type: Bearer}` and the same rules.
- *Self-hosted with only a Postgres datasource:* rewrite each rule as time-series SQL under a SELECT-only `grafana_ro` role. The dead-man becomes `EXTRACT(EPOCH FROM now() - max(scan_started_at))` per wallet, with NoData and Error both set to Alerting. `/api/metrics` still ships.

An optional **Postgres datasource per network** (`grafana_ro`: SELECT only, `default_transaction_read_only=on`, `statement_timeout`, `CONNECTION LIMIT`) serves **history panels only**: the 2-year `daily_rollup` and settlement lists. Alerts never use it.

### 8.4 Alert rules (brief §13) — D-62…D-64

Provisioned in WU-10 (★ = the M-1 set) and WU-14.

**Grouping and labels:** one folder and one rule group per network, evaluated every 60 s, with deterministic UIDs `bwm-<net>-<rule>`. Each rule carries static labels `{severity, network, component="bridge-wallet-monitor", rule}`, so NoData-derived instances still route.

**Generation:** `scripts/gen-alerts.ts` generates the rules from `config/networks/<net>.json` (wallet ids) and `ops/grafana/alert-params.yaml` (thresholds). Its output feeds both Terraform and promtool. Thresholds are **ops-owned**, changed by PR plus `terraform apply`, with no service deploy (§11).

**Notation** (the generator expands it):
- `m(x{sel})` ≡ `max by (network,wallet) (x{network="$N",sel})`. `max by` removes `job`/`instance`.
- `mo(x{sel},W)` ≡ `max by (network,wallet) (max_over_time(x{network="$N",sel}[W]))`
- `U0` ≡ `(m(bridge_wallet_unconfirmed_sats) == bool 0)`: no wallet-owned unconfirmed value is in flight.
- `EXPECTED_WALLETS` ≡ `label_replace(label_replace(vector(0),"network","$N","",""),"wallet","<id>","","")`, joined with `or` for each configured wallet. `EXPECTED_CHECKS` is the same over `check ∈ {pinned, tip}`.
- `$DIP` = **1h**, the dip window (a judgement parameter to confirm in Stage A; `$DIP ≥ 3 × collect interval`, CI-checked).

**Common state settings:** every rule except R10–R12 uses `noDataState = KeepLast`, `execErrState = KeepLast`, `missing_series_evals_to_resolve = 20`. That way a scrape blip neither resolves nor re-fires, and a vanishing series cannot silently resolve a real alert before R10/R11 fire. **R10–R12 use `Alerting`/`Alerting`** and are the single paging path for datasource trouble. Without it, a DatasourceError flood would drown the signal.

**Post-commit dip (P0 item 4).** Balance-derived rules R1–R3 have two arms:
- a **now** arm, `breach × U0`, which fires at once when nothing of the wallet's own is in flight;
- a **sustained** arm, `breach` held over `$DIP` using `mo()` on both sides, which rides out a dip and uses the most conservative threshold seen in the window.

A commit stuck for more than 1 h is a real funding constraint (minconf = 1), so the rule then fires. This replaces a blunt pending period, and it is not app-side hysteresis (§11).

| id | sev | expression `A` (condition `A > 0`) | for | keepFiringFor | notes |
|---|---|---|---|---|---|
| ★ R1 spendable below 6-day level (§13 row 1) | WARN | `clamp_max((m(bridge_wallet_spendable_sats) < bool m(bridge_wallet_alert_level_sats)) * U0 + (mo(bridge_wallet_spendable_sats,$DIP) < bool mo(bridge_wallet_alert_level_sats,$DIP)), 1)` | 0 | 2h | expected to fire on EE's first run if EE is unfunded (§5) |
| ★ R2 runway p90 < 2 d (§13 row 2) | CRIT | `clamp_max((m(bridge_wallet_runway_days{scenario="p90"}) < bool 2) * U0 + (mo(bridge_wallet_runway_days{scenario="p90"},$DIP) < bool 2), 1)` | 0 | 1h | §13 literal: scenario p90 |
| ★ R3 NotEnoughUtxos cliff (§13 row 4) | CRIT | with `brk(L,K) ≡ (L < bool K) or (L == bool 0)`: `clamp_max(brk(m(bridge_wallet_largest_utxo_sats), m(bridge_wallet_cost_per_settlement_sats{scenario="p90_ci_upper"})) * U0 + brk(mo(bridge_wallet_largest_utxo_sats,$DIP), mo(bridge_wallet_cost_per_settlement_sats{scenario="p90_ci_upper"},$DIP)), 1)` | 0 | 1h | Q-12: literal `< cost` at the alert-basis rate. The `== 0` arm makes AC4 fire with no fee data. |
| ★ R4 weak estimate (§13 row 3 intent) | WARN | `m(bridge_wallet_insufficient_data) == bool 1` | 0 | 6h | fallback basis or no basis |
| ★ R4b threshold unavailable | CRIT | `(m(bridge_wallet_last_update_timestamp) > bool 0) unless on(network,wallet) m(bridge_wallet_alert_level_sats)` | 60m | 0 | The wallet reports but cannot be judged. R1–R3 cannot see this, so absence would otherwise be silent. |
| R5 sample floor (§13 row 3, literal) | WARN | `m(bridge_wallet_feerate_sample_size) < bool $min_sample` | 0 | 6h | `$min_sample` must equal config `estimator.min_sample` (CI-checked) |
| R6 fragmentation (§13 row 5) | WARN | `m(bridge_wallet_multi_input_ratio_7d) > bool 0.10` | 0 | 6h | OL has a small denominator; the dashboard shows `commits_7d` |
| R7 stall (§13 row 6) | WARN | `(time() - m(bridge_wallet_last_settlement_timestamp)) > bool (3 * 86400 / m(bridge_wallet_settlements_per_day))` | 0 | 0 | If cadence goes absent in a long stall, R4b fires instead |
| R8 regime shift (§13 row 7) | WARN | `m(bridge_wallet_regime_shift) == bool 1` | 0 | 6h | `keepFiringFor` absorbs band-edge toggling (§11) |
| R9 upstream drift (§13 row 8) | WARN | `clamp_max(((max by(network,check)(bridge_monitor_upstream_drift{network="$N"}) or EXPECTED_CHECKS) == bool 1) + ((time() - (max by(network,check)(bridge_monitor_upstream_drift_check_timestamp{network="$N"}) or EXPECTED_CHECKS)) > bool 172800), 1)` | 0 | 0 | fires if drift is found, or if the check is stale or has never run |
| ★ R10 dead-man (§13 row 9, AC5) | CRIT | `(time() - (max by(network,wallet)(last_over_time(bridge_wallet_last_update_timestamp{network="$N"}[10m])) or EXPECTED_WALLETS)) > bool 3300` | 0 | 0 | **NoData/Error = Alerting**. `EXPECTED_WALLETS` means a missing wallet or an endpoint down for more than 10 min gives an age ≈ `time()`, and so fires. |
| ★ R11 exposition unobservable | CRIT | `(count by(network)(bridge_monitor_version{network="$N"}) or label_replace(vector(0),"network","$N","","")) == bool 0` | 5m | 0 | **NoData/Error = Alerting**. Covers auth, Deployment Protection, 503 and DNS. If the scraper exposes `up`, add `max by(network)(up{job=~"bwm-$N.*"}) == bool 0` as a second arm. |
| ★ R12 startup refused | CRIT | `max by(network)(bridge_monitor_last_run_status{network="$N",status="refused_startup_check"}) == bool 1` | 0 | 0 | **NoData/Error = Alerting**. Fires within about a minute, where the dead-man alone takes about 55. |
| R13 scan ceiling | WARN | `m(bridge_wallet_scan_ceiling_hit) > bool 0` | 0 | 0 | |
| R14 wallet events | WARN | `max by(network,wallet)(increase(bridge_wallet_events_total{network="$N",kind=~"internal_consolidation\|external_spend\|mixed_spend\|unknown_output_address\|layout_unrecognized\|unlinked_commit\|reveal_conflict\|reorg_beyond_finality"}[24h])) > bool 0` | 0 | 0 | **Positive allowlist.** The D-23 fingerprint kinds (`commit_without_change`, `reveal_receipt_ne_dust`, `reveal_count_ne_1`, `dust_spent_by_non_settlement`, `tx_dropped`) are routine for EE and go on the dashboard only. Otherwise the WARN channel that carries sweeps would be trained into noise. |
| R15 UTXO-limit headroom | WARN | `m(bridge_wallet_max_utxos_per_address) > bool $utxo_limit_warn` | 0 | 0 | set to about 80% of the indexer's `utxos_limit` once Q-02 answers it |
| R16 primary not in use | WARN | `max by(network,wallet)(bridge_wallet_scan_provider{network="$N",provider!="$primary"}) == bool 1` | 60m | 0 | |
| R17 chain tip stale | WARN | `(time() - m(bridge_wallet_snapshot_tip_time)) > bool $tip_age_warn` | 0 | 0 | `$tip_age_warn` = 7200 s |
| R18 maintenance stale | WARN | `(time() - max by(network)(bridge_monitor_maintenance_last_success_timestamp{network="$N"})) > bool 172800` | 0 | 0 | |

**Rule coverage for "inputs absent"** (so nothing is silently disarmed):

| absent | rule that fires |
|---|---|
| alert level or cost | R4 + R4b |
| runway p90 | R4 + R4b (same cause: no basis or no cadence) |
| last update (wallet never collected) | R10 via `EXPECTED_WALLETS` |
| whole exposition | R11 + R10 |
| DB down | 503 → R11 |
| drift check never ran | R9 via `EXPECTED_CHECKS` |

**D-62 Dead-man threshold (Q-13).** Constraints, with C = collect interval, E = eval interval, G = group_wait, J = cron jitter plus scan duration plus scrape lag, and k = tolerated consecutive missed runs:
- no false page: `(k+1)·C + J < θ`
- AC5: `θ + E + G + Δdeliver ≤ 3600`

Here J = cron jitter (≤ 60 s) + the other wallets' scan time before this wallet's attempt starts + this wallet's scan-to-commit time + scrape lag (≤ 60 s). With per-wallet deadline shares of 370 s, J ≤ 60 + 370 + 370 + 60 = 860 in the pathological worst case. So:
- **k = 1 always holds**: 1800 + 860 < 3300.
- **k = 2 holds whenever the scans on both sides of the gap stay under about 3 minutes combined** (2700 + J < 3300 needs J < 600). On the internal indexer, scans take seconds.

With C = 900, E = 60 and G = 30, the AC5 side gives θ ≤ 3510, so **θ = 3300 s**. It does not fire on 2 consecutive missed runs under normal scan durations, it fires on the 3rd, and the worst case is about 3390 s from the kill (arithmetic). A false page after two missed runs **and** two very slow failover scans is accepted: that state is itself degraded.

θ = 2700 would sit exactly on the two-missed-runs gap, which Vercel documents can happen, and would page on it. At a 30-minute interval, no θ satisfies both constraints with k ≥ 1 (Q-25). `scripts/check-timing-invariants.ts` recomputes all of this from `vercel.json`, config and `alert-params.yaml` in CI. It enforces the AC5 side, k = 1 strictly, and `$DIP ≥ 3·C`, and it prints the k = 2 scan-time budget.

**Routing** (under `component="bridge-wallet-monitor"`):
- `network="signet"` goes to a non-paging channel, repeat 24h. Signet never pages.
- `network="mainnet", severity="critical"` goes to the shift Slack in Stages 0/A (title prefixed `[shadow]`), then to the pager from Stage B, repeat 1h.
- `severity="warn"` goes to the WARN Slack, repeat 12h.
- `alertname=~"DatasourceNoData|DatasourceError"` goes to ops Slack, explicitly.
- `group_by: [alertname, network, wallet]`, `group_wait: 30s` (counted in G), `group_interval: 5m`.

**Not alerts:** an unconfirmed deployed build (`deployed_build_confirmed = 0`) and `primary_is_public = 1` are **dashboard banners**. They would fire permanently, and they are stage gates instead (P11.7).

**Lint on `ops/grafana/`:** no rule may reference `bridge_wallet_balance_sats` or `bridge_wallet_fee_premium_ratio`. No file may contain `p99`. No §5 measured figure may appear as a threshold; only the §13 constants (2, 0.10, 3, 30) and derived operational values (3300, 172800, 7200, 1h) are allowed.

**promtool** tests expression logic only. Grafana NoData/KeepLast/missing-series behaviour is verified by drills D1 and D2 (P11.6).

---

## P9. Test strategy (brief §16)

### 9.1 Levels

| level | runs | network | data |
|---|---|---|---|
| **unit** | every PR | none | synthetic; oracles from Appendix A; recorded fixtures |
| **integration** | every PR | none | Postgres pinned to Neon's major version, run **twice**: once direct, once **behind PgBouncer in transaction mode** as on Neon. Fake Esplora servers serve recorded fixtures. |
| **replay** | every PR | none | captured mainnet fixtures (structure and anchored snapshots) run through `computeWalletSnapshot()` |
| **meta** (mutation) | every PR | none | patch-based mutants of `src/model/selector.ts` |
| **rules** | every PR | none | `promtool test rules` on `ops/grafana/rules.test.yaml` |
| **scheduled live** | daily | yes | read-only: upstream drift, API-shape canary, provider conformance |
| **drill** | staged | a `mainnet-staging` Vercel project with its own Neon project (stamped `mainnet`, alerts to a test contact point) first, then prod | P11.6 D1–D4 |

PR CI is **hermetic**: no network calls. Every live check is scheduled or manual.

### 9.2 Acceptance criteria → tests

| AC | test(s) | level | data | pass criterion | WU |
|---|---|---|---|---|---|
| **1** vectors at startup | `derive.brief-vectors`; `collect.startup-refuses-on-vector-mismatch` | unit + integration | brief §4.2 vectors | all 6 exact. A corrupted vector yields `refused_startup_check`, **zero** snapshot rows and **zero** provider requests. | 01, 07 |
| **2** cost model within 10% | (a) `cost.brief-oracle`: `cost(303 vB, 2.84)` vs 1,436 and `cost(549 vB, 2.82)` vs 2,206; (b) `replay.cost-vs-observed`: on captured mainnet settlements, predicted `cost(p50)` from the fixture's own medians vs the median of per-settlement `spendable_drain_sats` | unit + replay | injected brief inputs; captured fixtures | (a) errors 2.05% and 5.07% (arithmetic), ≤ 10%; (b) ≤ 10% | 03, 09 |
| **3** EE ≈ 3.6 d @p90 | `runway.ac3-declared`: any split of 112,249 into UTXOs > 546 plus 10 × 546, `cost_int = 2546`, `spd = 11.9` injected; `runway.ac3-anchored` if an anchor was found (P9.5) | unit (+ replay) | `snapshots/ac3-declared.json` | settlements == 43 and runway ∈ [3.55, 3.65), under both the real-valued cost (2,545.8) and the ceil cost (2,546). 43 is the only integer that rounds to 3.6 at 11.9/day, and the margin is about 2,230 sats, so the result is robust to the open rounding questions. Also pin EE p50 (79, 6.64 d) and OL p50 (52, 21.67 d). OL p90 (25 → 10.42 d) is pinned **only under ceil**: it is knife-edge, and 26 → 10.83 d with the real-valued cost. The test states honestly what it proves: **cost + cadence + the §4.4 loop, not selector ordering** (composition invariance; see AC12). | 03 |
| **4** all-546 wallet → spendable 0 + CRITICAL | `composition.all-dust`; `runway.empty-pool`; promtool `ac4` | unit + rules | synthetic | spendable 0, stranded = Σ, largest 0, runway 0 in every scenario (even with no fee data), R2 and R3 fire immediately (U0 = 1, no in-flight value), including with **n = 0** (no fee history) via the rate-independent zero runway and R3's `largest == 0` arm | 03, 14 |
| **5** kill cron → dead-man ≤ 1 h | promtool `ac5`: series frozen fires at θ; 2 missed runs stay silent; 3 fire. Also: on a healthy fixture **the dead-man query returns exactly one 0-valued series per configured wallet** (so NoData = Alerting can never fire on a healthy system), and a wallet absent from the exposition yields a firing series via `EXPECTED_WALLETS`. Drill D1. | rules + drill | synthetic; prod | promtool as stated. D1 fires ≤ 3600 s after the click, on staging first, then once on prod at night (Stage B). D1b: DB URL pointed at an invalid host → `/api/metrics` 503 → R11, then R10, ≤ 3600 s. | 14, 15 |
| **6** primary fails → failover, counter up, no gap | `pool.failover-matrix` (each error kind); `collect.failover-writes-snapshot`; drill D3 | integration + drill | fake providers; prod | **"Without gaps"**, operationally:
(i) every scheduled slot during the outage has a committed snapshot per wallet, served by a failover provider (`provider` recorded);
(ii) `time() − last_update_timestamp` never exceeds interval + 120 s;
(iii) `provider_errors_total{provider=primary}` never decreases and rises by ≥ 1 per failed primary attempt, **including when the wallet transaction rolls back**;
(iv) no data from the failed provider is mixed into the snapshot.
D3: 4/4 snapshots per wallet in the hour. | 04, 07, 15 |
| **Convergence** (supports AC6, AC10, Stage 0) | `collect.empty-db-converges`: on an empty DB with a fake provider holding 90 d of history, the first collect writes a snapshot per wallet with `insufficient_data = 1`, and repeated runs converge to full coverage with no snapshot gaps. Coverage per D-24: an interrupted address keeps NULL, a new address is complete after its first traversal. | integration | fake provider | a snapshot on every run; coverage reaches 90 d within ⌈pages/cap⌉ runs; `insufficient_data` clears only once coverage ≥ 30 d | 07 |
| **7** rotation picked up | `gapScan.rotation` (activity at last_used+19 found; +21 not found, which is correct by design); `collect.rotation-next-run` | unit + integration | synthetic + recorded EE rotation (0/2 → 0/4) | new index watched on the next run with no config change; ceiling case sets the flag | 06 |
| **8** scrape ≠ upstream request | `metrics.no-fetch` (global `fetch` throws; any provider import throws); dependency-cruiser rule | unit + static | seeded DB | 200 with 0 outbound calls (global `fetch` and undici stubbed to throw). dependency-cruiser (transitive, `reachable: true`) forbids `api/metrics` → `src/{chain,discovery,extract,netfee,upstream,pipeline}/**`. ESLint `no-restricted-globals: fetch` applies everywhere except `src/chain/**`, `src/netfee/**` and `src/upstream/**`. The handler connects as `metrics_ro` (SELECT only), so it cannot write either. | 08 |
| **9** signet by config only; cross-network rejection | rejection matrix (27 cases, exact error codes); `collect.signet-profile-mainnet-descriptor-refused`; `pipeline.synthetic-signet-profile` (full pipeline against a fake signet provider using **synthetic** test keys); **positive live half BLOCKED on Q-01** | unit + integration | `descriptors/rejection-matrix.json`, `derivation/synthetic-signet.json` | every case gives its exact code; a refused run writes nothing and calls no provider; the synthetic profile runs with **no src diff** | 01, 07, 16 |
| **10** purge tiers, idempotent, counted | `maintenance.tiers-and-idempotency`; `maintenance.never-deletes-unrolled`; `maintenance.counters-monotonic` | integration | seeded rows at 89/90/91 d, 13/14/15 d, 29/30/31 d, 729/730/731 d | counts match the tiers; 2nd run deletes 0; counters rise only by the 1st run's count | 11 |
| **11** synthetic regime shift | `regime.*` fixtures (P9.3) + promtool `ac11` | unit + rules | synthetic | 7d/30d median moved > 1.5× gives `regime_shift = 1` and active window 7 d, and thresholds come from the 7-day sample (or the fallback, for OL-like density) | 02, 14 |
| **12** golden selector + mutants | `selector.golden`; `meta.mutants` | unit + meta | `selector/golden.json` | all golden cases pass; **each** mutant fails ≥ 1 golden case | 03 |
| **13** drift check fails on hash mismatch | `drift.integrity-mismatch` (mocked `fetchRaw` returns altered bytes) | unit | fixture bytes plus recorded hash | `mismatch`, message names `choose_utxos` and `fund_commit_transaction`, CLI exit ≠ 0 | 12 |
| §4.3 validation | = AC2 | | | | |
| §10 golden | = AC12 | | | | |

### 9.3 Fixture inventory (every file carries a `provenance` object: source, date, script and version, and for chain data the provider, height and hash)

- `stats/ci-ranks.json`: (n, q, l, u) for q ∈ {½, 9⁄10}, n ∈ {1–6, 30–40, 50, 53, 54, 64, 72, 84, 87, 105, 117, 357, 360}, generated by `tools/refimpl` with exact rationals. Must include: p90 n = 35 → (28, null); n = 36 → (29, 36); n = 117 → (99, 112); n = 87 → (72, 84); p50 n = 117 → (48, 70); n = 5 → (null, null); n = 6 → (1, 6).
- `stats/regime-cases.json`: cases R1–R6. The generator spec and every expected value are in **Appendix D.1**.
- `stats/cadence-cases.json`: regular 7,200 s → spd 12.0. A 72-hour stall keeps spd 12.0. A zero interval is kept. Non-monotone timestamps `[0, 7200, 6600, 14400, 21600]` → envelope intervals `[7200, 0, 7200, 7200]`, median 7,200. Degenerate median 0 → absent.
- `stats/basis-cases.json`: `x_i = 1 + (i−1)/4`. n = 36 → p90 8.875, CI [8.0, 9.75], basis `ci_upper` 9.75 (= max). The first 35 values → p90 unsupported, basis `window_max` 9.5, `insufficient_data = 1`. n = 0 → `none`.
- `model/ac-oracles.json`: Appendix A.
- `selector/golden.json`: P9.4.
- `descriptors/rejection-matrix.json`: the 27 cases in **Appendix D.2**.
- `derivation/*`: the brief's six vectors; BIP84 published vectors via the zpub re-encoded as `xpub6CatWd…PW6V`; BIP32 TV1 public derivation; BIP173; the synthetic signet key from the BIP84 test mnemonic at `m/84h/1h/0h` (labelled **synthetic, public key material, never a wallet**); a 300-row differential fixture (EE, OL and synthetic; chains 0/1; indices 0–49) from the independent Python reference. CI bans fingerprint `73c5da0a` anywhere under `config/`.
- **Chain fixtures layout**, one directory per capture: `chain/<network>/<capture-id>/`. It contains:
  - `PROVENANCE.json`: capture id; network; wallets; descriptor checksums; gap parameters; the address list with (chain, index, tx_count); provider label and version headers (for example `x-powered-by`); `captured_at`; tip height and hash; repo git SHA; script name and version; Node version; the brief's sha256; a per-file sha256 map; and the request log.
  - `raw/esplora/…`: **byte-exact** response bodies, never re-serialized, named by URL path.
  - `derived/…`: UTXO sets and settlements, which CI **regenerates from `raw/` and diff-checks**.
  - `expected/brief-5.json`: brief oracles, each with a tolerance and a § citation.
  - `expected/outputs.snap.json`: the service's own outputs, used by the version gate.

  Tolerances: integers exact; two-decimal brief values ±0.005; one-decimal values ±0.05; the §5.1 derived table ±1 sat; AC2 ≤ 10%. Excluded as oracles: §5 OL 61,668; §4.3's "predicted" column; §5.1 CI bounds (a different rank convention); the network 1.0/2.0 (a rolling window). `/utxo` at historical heights cannot be fetched, so `FixtureProvider` synthesises it from `derived/utxo-set@H` and marks it derived.
- **Replay must contain the discriminating cases:**
  - the 969093 sweep (excluded from the fee series and the multi-input ratio, counted as `internal_consolidation`);
  - the 2026-09-28 no-change multi-input commits;
  - the EE receive rotation 0/2 → 0/3 → 0/4;
  - the change-chain extension to 1/5–1/10;
  - a synthetic 3-P2TR chunked commit (N = 3 reveals);
  - a synthetic wallet spend to a foreign P2TR whose spender is not reveal-shaped (`external_spend`).
- `chain/mainnet/<capture>/raw/…` recorded by `capture-fixture`, values kept (these are fixture data, not constants in code). EE commit with change `bdd3031c…142e`; no-change commits `fc9d7236…f837` and `91e472ca…4e5a`; change moving to 0/3 `46f1a471…9d54`; reveals `08972c50…4a73` and `8cc25603…9118`; consolidation sweep `e2379d1e…f2d5` (and its five siblings at height 969093); top-ups `715bb2e7…ddb6` and `a827d4d2…e8e1`. **Plus OL equivalents to be recorded in WU-06** (not yet probed). Full txids are in Appendix C.

### 9.4 Golden selector tests and mutation (AC12) — D-42

`test/fixtures/selector/golden.json` is validated by `golden.schema.json`. It has three layers: `prefilter`, `choose_utxos` and `simulate`. Case shape:
```json
{ "id": "single-smallest-sufficient-01",
  "layer": "choose_utxos",
  "behaviour": ["single_input", "smallest_sufficient"],
  "source": "synthetic",                                 // | "upstream-test:<fn>#k" | "chain:<txid>"
  "utxos": [{"id":"a:0","valueSats":5000,"confirmed":true,"type":"p2wpkh"}, …],
  "amountSats": 3092,
  "expectCandidates": ["a:0", …],                        // prefilter layer: after commitCandidateFilter, order preserved
  "expect": {"ok": true, "inputs": ["c:0"], "sumSats": 5000} }  // or {"ok": false, "reason": "NotEnoughUtxos", "amountSats": …, "availableSats": …}
```
`simulate` cases use integer costs and expect a full trace `steps[{selected, change, change_kept}]` plus the terminal pool. **Port upstream's own `choose_utxos` unit-test cases verbatim** as `source: "upstream-test:…"` (for example pool [10e9, 5e9, 1e9]: amount 5e8 → [1e9]; 1e9 → [1e9]; 2e9 → [5e9]; 1.55e10 → [1e10, 5e9, 1e9]; 5e10 → NotEnoughUtxos). Check the alpenlabs/alpen licence before vendoring any upstream text.
Required coverage. Every behaviour case is **tie-free**: upstream tie order is `listunspent` order and cannot be reproduced. One separate tie case asserts stable input order ([a:700, b:700, c:900], amount 2000 → [c, a, b]).
1. **single-input whenever any UTXO suffices**, including when a multi-input combination would be "better".
2. **smallest sufficient**: several sufficient UTXOs; the chosen one is the minimum; `amount == value` is selected (`>=`).
3. **descending accumulate**: no single UTXO suffices; largest first; **stops as soon as** sum ≥ amount (a case where continuing would add an input).
4. **dust exclusion**: values 545, 546 excluded; 547 included; unconfirmed excluded; unsupported type excluded.
5. Edge cases: empty pool; Σ < amount gives `NotEnoughUtxos` with `availableSats`; a single candidate exactly at the amount.

**Mutants** (`test/meta/mutants.test.ts`). Each is a **textual patch applied to the real `src/model/selector.ts` at test time**; the patched copy is written to a temp dir and dynamically imported. A patch whose anchor text is not found **fails the meta-test**, which forces the patches to track the source.
`test/meta/mutants.ts` lists `{id, behaviour, find, replace}`. **`find` must occur exactly once**; otherwise the meta-test fails. An **unmutated control** run must pass all cases.
- M1: single-input branch disabled (always accumulate). *Behaviour: single input when any suffices.*
- M2: single-branch sort reversed (largest sufficient). *Behaviour: smallest sufficient.*
- M3a: fallback sort ascending. *Behaviour: descending accumulate.*
- M3b: early `break` removed (accumulate past sufficiency). *Behaviour: stops as soon as covered.*
- M4a: prefilter `> 546` → `>= 546`. *Behaviour: dust exclusion.*
- M4b: dust predicate removed. *Behaviour: dust exclusion.*
- M5: single-branch `>=` → `>` (a UTXO exactly equal to the amount is not "sufficient"). Killed by the exact-equality case.

Pass criterion: each mutant fails ≥ 1 golden case, and the test reports which case ids killed it. **Runway assertions cannot do this job:** M1–M3 and M5 leave AC3's 43 settlements unchanged, and only M4 changes it (to 46). StrykerJS is not used; its generic operators do not map one-to-one to the §10 behaviours.

**Simulator property tests** (fast-check, seeded). Pools are integer sats > 546 and costs are integers.
- K ≤ `singlePoolBound`.
- Conservation: `K·cost + 546·exactDustChanges + Σfinal == Σinitial`.
- Σfinal < cost + 546.
- exactDustChanges = 0 ⇒ K = bound.
- An empty pool, or Σ < required, gives 0.
- The *bound* is non-increasing in cost.
- **Pinned counterexample, never "fix" it:** pool `[1546] × 10` gives K = 10 at cost 1000 (every change is exactly 546 and dropped) and K = 14 at cost 1001. The faithful port is **not** monotone in rate.

### 9.5 Anchored snapshot capture — D-43

`scripts/capture-fixture.ts --wallet ee --anchor-search <from-height>..<to-height>` is read-only and serial (≤ 1 request/s). It does the following:
- Gap-scan both chains. Page `/txs/chain` until an **empty page**, never by page length. Follow every non-W P2TR output via outspend.
- For each height H from **969093** (the sweep; the brief's snapshot is after it, per the P0 item 2 inference) through the end of 2026-09-29, reconstruct two UTXO-set variants:
  - *confirmed*: outputs to W with height ≤ H that are not spent at a height ≤ H;
  - *mempool-adjusted*: the confirmed set minus the W inputs spent in block H+1. This reproduces `/utxo`'s exclusion of mempool-spent outputs.
- Report every **interval** of heights and variant where spendable = 112,249 **and** stranded = 5,460 in exactly 10 UTXOs. For OL: 110,680 and 0. A matched state holds over a block interval, not a single height.
- **Zero matches means escalate. Never take the nearest fit.**
- Log every reveal receipt value and every spend of a 546 output on the way, with the spending tx's class.
- If there is a match, write `snapshots/anchor-ee-<H>.json` with provenance and the settlement samples ending at H: the last 105 EE settlements for §5 and the last 117 for §5.1, each evaluated against its own section.
- Then run `replay.brief-definitions` as a **diagnostic** (it does not block CI). It evaluates every candidate convention and **reports which reproduce** the brief: commit-only vs package rate; weight/4 vs ceil; exact vs normal-approximation ranks. Nobody tunes a convention to fit.
- It also asserts §5's multi-input counts, EE 8 and OL 2, which catches a classifier that counts sweeps as commits.
- Expected outcome given P0 item 5: the package-rate p50 lands a few percent above 2.84. It should still fall inside the brief's §5.1 CI ([2.08, 2.92] for EE p50); if it does not, that is information for Q-10 and Q-26, not a failure to fix.
- **STOP if** the diagnostic shows the sample itself cannot be reproduced (a different n over the stated span, multi-input counts ≠ 8/2): either the brief's sample had different address coverage or our classifier is wrong. Escalate (Q-26).
- **If no height matches,** record that, keep AC3 on the declared snapshot (valid by composition invariance), and ask the brief's author for the raw snapshot (under Q-04: the 969093 sweep changes which heights can match).
- Accepting an anchored fixture as golden requires the Q-04 answer (Stage A exit), not M-1.

### 9.5b Time machine tests (WU-17)

- **No look-ahead (property):** for random H in a recorded archive, delete everything above H and assert `replayAt(H)` is byte-identical.
- **Determinism:** the same archive digest, config sha and version give an identical `snapshots.jsonl`.
- **Equivalence (integration):** seed a live `utxo_sets` daily sample from a recorded capture. `equivalence()` must report ok. A deliberately mempool-affected sample must be *explained*, not reported as ok-by-accident.
- **Rules parity:** the alert intervals `evaluateRules` computes on a synthetic `series.om` equal the promtool unit-test expectations of P9.2 (the same generated rules).
- **Outcome derivation:** synthetic archives with a stall, an intervention and a right-censored end produce the expected `outcomes.json`.

### 9.6 What is live and what is fixture

Live network only in: `upstream-drift.yml` (raw.githubusercontent.com), `live-canary.yml` (a daily read-only schema check of each configured mainnet provider against the zod schemas and the recorded fixture shapes, asserting no values), `provider-conformance` (manual/scheduled: page size 25; `/txs/chain/{unknown}` returns `[]`; outspend of a known commit; checkpoint; utxo-limit error format; the offline aggregate identity), `backfill`, `capture-fixture` and `replay fetch` (operator-run), `replay-equivalence.yml` (weekly, read-only), and the drills. Everything in P9.2 runs without the network.

---

## P10. CI and versioning (brief §10)

### 10.1 PR pipeline — `.github/workflows/ci.yml`

1. `pnpm install --frozen-lockfile` on Node 24.
2. `tsc --noEmit`; ESLint. Lint bans: `HDKey.fromJSON`; `fromExtendedKey(` with one argument; `.default(` in `src/config`; `\bSET\b` or `pg_advisory_lock(` in `src/db` runtime code; `Math.random`/`Date.now` inside `src/model` and `src/stats`; any `p99` token in `src/`, `ops/` and `config/`.
3. `depcruise` boundaries (P7.1).
4. `scripts/tripwire-constants.ts`: fails if any §5 measured literal appears in `src/`, `api/` or `config/` **as a numeric token**. It matches TS numeric literals through the TS AST (ESLint `no-restricted-syntax` on `Literal`) and JSON number values. It never substring-matches inside strings, so hashes, xpubs and addresses cannot trip it. The list includes 2.84, 6.60, 2.82, 6.72, 11.9, 2.4, 2.02, 10.01, 112249, 110680, 5460, 171, 132, 152, 397, 303, 549, 1403, 1436, 2097, 2206, 181483, 61668, 181770, 60988, 239317, 74586, 145425, 59644, 4.92, 9.26, 6.55, 8.44, 11.72, 8.95, 1105. `546` is whitelisted only at its definition in `src/model/selector.ts` and in the `dust_limit_sats` config field. `test/` and `docs/` are exempt.
5. `scripts/validate-configs.ts`: every `config/networks/*.json` passes schema, grammar, checksum, vectors and coherence against `test/fixtures/network-params.json`. No key material is reused across files. No test fingerprint.
6. `scripts/check-timing-invariants.ts`: `max_duration < lease_ttl < interval`; the `vercel.json` cron equals `collection.interval_s`; the dead-man inequalities (P8.4); `$DIP ≥ 3 × interval`; `$min_sample` in `alert-params.yaml` equals `estimator.min_sample`; every cron path maps to an `api/` file with an explicit `maxDuration` and no trailing slash.
7. `vitest run` for unit, replay and meta, then integration with the `postgres` and `pgbouncer` services.
8. Manifest consistency: `config/upstream-manifest.json` `selector_model_version` for every network == `SELECTOR_MODEL_VERSION`, and all SHAs are 40-hex.
9. `promtool test rules`, on the rule files rendered by `scripts/gen-alerts.ts` from `ops/grafana/rules.tmpl.yaml` (the generated Terraform input is committed and CI diff-checks it against a fresh render).
10. `terraform fmt -check && terraform validate` in `ops/grafana`.
11. Version-bump gate (P10.3).

### 10.2 Compatibility manifest and drift check — D-44, D-45

`config/upstream-manifest.json`:
```json
{
  "manifest_version": 1,
  "networks": {
    "mainnet": {
      "repo": "alpenlabs/alpen",
      "pinned_commit": "7f20dcb65fa478c9654626b77a05ea789d28806a",
      "pin_basis": "brief §3.2 source reading (2026-09-29); NOT confirmed as deployed",
      "deployed_build_confirmed": false,
      "deployed_build_evidence": null,
      "writers": { "ee": "chunked_envelope (inferred from chain layout, unconfirmed)", "ol": "unknown" },
      "status": "active",
      "selector_model_version": 1,
      "files": {
        "crates/btcio/src/writer/builder.rs": { "sha256": "<recorded by WU-12 from a fresh fetch>", "bytes": 0 },
        "crates/btcio/src/writer/chunked_envelope/builder.rs": { "sha256": "…", "bytes": 0 },
        "crates/btcio/src/writer/chunked_envelope/signer.rs": { "sha256": "…", "bytes": 0 }
      },
      "upstream_constants": { "BITCOIN_DUST_LIMIT": 546 },
      "items": [ { "path": "crates/btcio/src/writer/builder.rs", "kind": "fn", "name": "choose_utxos", "hash": "<normalized sha256 at pinned_commit>" }, … ],
      "tip_baseline": { "commit": "<last upstream main commit a human reviewed>", "reviewed_at": "…", "reviewed_by": "…",
                        "item_hashes": { "builder.rs#choose_utxos": "…", … } }
    },
    "signet": { "status": "blocked", "blocked_reason": "Q-01 signet descriptors; Q-08 signet SHA" }
  }
}
```
- **SELECTOR_MODEL_VERSION** is a positive integer constant in `src/model/selector.ts`, starting at 1. Model 1 means: the §4.4 loop as written, plus the prefilter and `choose_utxos` equivalent to upstream at `13bc320`, `c97bb7a`, `7f20dcb` and `4acde82`, whose function bodies are identical. **Bump it exactly when a golden expected output changes.** A refactor that leaves the golden file unchanged does not bump it.
  - `config/selector-models.json` records `[{version, description, golden_sha256, equivalent_upstream_shas[], non_equivalent_notes}]`. Version 1's notes list: the M2 carry pass (≤ 1 settlement of difference, arithmetic: EE p90 43 vs 44); headroom; per-input fee pricing; and the M0/M1 differences (no +546 reserve, sub-dust excess burned).
  - One model per build. If two networks need different models, their Vercel projects deploy different release tags.
  - At startup the runtime refuses to run (`refused_startup_check`) unless all of these hold: the manifest entry for its network has `status: "active"`; it names this `SELECTOR_MODEL_VERSION`; its SHA is 40-hex; `upstream_constants.BITCOIN_DUST_LIMIT == DUST_LIMIT_SATS == config.chain.dust_limit_sats`.
- **Pinned-SHA integrity check** (the brief's §10 check, and AC13). Fetch every `files` entry at `pinned_commit` from `raw.githubusercontent.com` and compare the whole-file sha256. The planning session observed `0bd6d5f10dc5eea716897f277e9b9ba9e326eabedd726528125db17f3287c1e6` for `builder.rs` at `7f20dcb…`. **Recompute it in WU-12; do not paste this value.** Say plainly in CI output: *"manifest integrity"*. The content at a full SHA is immutable, so this check fails only on an inconsistent manifest edit or a bad fetch. It **cannot** detect upstream drift. On mismatch, fail with: `builder.rs at <sha> differs from recorded hash — review choose_utxos and fund_commit_transaction (and the manifest item list) before bumping`.
- **Tip-tracking check** (added). Fetch each listed item at upstream `main`. Extract it with a comment-, string-, raw-string- and lifetime-aware Rust brace matcher (`src/upstream/rustExtract.ts`), searching only above `#[cfg(test)] mod tests`. Normalise it (strip comments, collapse whitespace), hash it, and compare with **`tip_baseline.item_hashes`**, the last upstream commit a human reviewed, **not** the pin. Comparing against the pin would stay red for as long as main is ahead of the deployed build, and a permanently red check trains people to ignore it.
  - The result is tri-state `ok | drift(items[]) | unknown`. A listed item missing upstream is `drift`, never `ok`.
  - When drift is reported, a human reviews the diff, records whether semantics changed (and so whether a `SELECTOR_MODEL_VERSION` bump will be needed when the deployed build catches up), and moves `tip_baseline` forward in a PR.
  - **WU-12's first task** is this review for `7f20dcb → 4acde82`. The planning session found only error-type changes in `create_envelope_transactions` and `fetch_envelope_prereqs`; confirm that yourself, then set the baseline. The item list comes from the upstream analysis and covers every place selection semantics live:
  - `builder.rs`: `BITCOIN_DUST_LIMIT`, `MAX_ECDSA_SIGNATURE_SIZE`, `COMPRESSED_PUBLIC_KEY_SIZE`, `choose_utxos`, `select_commit_utxos`, `fund_commit_transaction`, `build_commit_transaction`, `is_supported_commit_utxo`, `signed_commit_vsize`, `commit_inputs`, `fee_sats_for_vsize`, `get_size`, `default_txin`, `calculate_commit_output_value`, `single_reveal_vsize`, `reveal_fee_headroom`, `create_envelope_transactions`, `build_reveal_transaction`, `fetch_envelope_prereqs`, `build_envelope_txs`, `build_and_sign_envelope_txs`, `sign_commit_with_fee_guardrail`, `rebind_single_reveal`.
  - `chunked_envelope/builder.rs`: `build_chunked_envelope_txs`, `calculate_reveal_commit_value`, `build_multi_output_commit`, `build_reveals_for_commit`.
  - `chunked_envelope/commit_op_return.rs`: `COMMIT_OP_RETURN_PAYLOAD_LEN`, `build_commit_op_return`.
  - `chunked_envelope/signer.rs`: `sign_chunked_envelope`.
  - `replacement/build.rs`: `set_reveal_replacement_fee`, `build_chunked_commit_replacement`, `reject_added_inputs`, `chunked_commit_change_index`.
  - `replacement/driver.rs`: `process_record`, `reveal_fee_budget`.
  - `crates/config/src/btcio.rs`: `FeeBumpingConfig`, `default_fee_bumping_*`, `WriterConfig`.
  - `bin/strata/src/helpers.rs`: `generate_sequencer_address`.
  - `Cargo.lock` entries for `bitcoind-async-client`, `bitcoin`, `bitcoin-units`.
- A scheduled CI job (`upstream-drift.yml`, daily, plus on PRs touching `config/upstream-manifest.json`) runs both checks. **Exit codes:** 0 ok; 1 mismatch or drift; 2 fetch/extract error. The HTTP status is checked **before** hashing, so a 404 or error page is never hashed, and byte size is compared. The integrity check blocks merges. The tip check opens or updates a GitHub issue. A **negative self-test** runs on every PR: the checker against `test/fixtures/compat/manifest.bad-hash.json` must exit 1 with a message naming `choose_utxos` and `fund_commit_transaction` (AC13).
- **Runtime cron `/api/drift-check`** (daily) runs the same `src/upstream/drift.ts` and writes `drift_checks`. This is how §13's "drift check failed in CI" WARN becomes observable at all: Grafana cannot see CI. It also covers GitHub's auto-disable of schedules in inactive public repos. A GitHub outage yields `unknown` and a stale `last_success`, never `ok`.
- **The drift that matters most, deployed build ≠ pin, cannot be detected from source.** The chain fingerprints (D-23) and Q-03 are the only defences. Say so in `docs/model-divergences.md`.
- **History replay test** (scheduled job, network): the extractor over real upstream bytes must show 7f20dcb → 4acde82 (current `main`, error-type refactor) as a change in `create_envelope_transactions` and `fetch_envelope_prereqs` only. It must show 42d45ee → 13bc320 as `fund_commit_transaction` going from missing to present, and `reveal_fee_headroom` as absent at `cdaeb8e`. Hashes are recomputed in CI, not vendored.

### 10.3 Semantic versioning — D-46

| bump | trigger |
|---|---|
| **MAJOR** | a `SELECTOR_MODEL_VERSION` bump: the tool now models a different sequencer build, and a network still on the old build must not take it; a breaking change to the metrics contract (a metric or label renamed or removed, or unit or label semantics changed); a breaking config schema change (`CONFIG_SCHEMA_VERSION`++); a non-additive migration |
| **MINOR** | any other **value-affecting** change, i.e. any emitted number changes for the same stored inputs: an estimator definition change, or a changed policy value in `mainnet.json`. Also additive metrics, labels, alert rules and config fields. |
| **PATCH** | manifest pin moves with no semantic change (`upstream_ref` changes, model does not); fixes that provably change no output |

CI enforcement. `test/replay/__snapshots__/outputs.json` holds the full `SnapshotRecord` for every replay fixture. If a PR changes it, or changes `SELECTOR_MODEL_VERSION`, `CONFIG_SCHEMA_VERSION` or `src/metrics/contract.ts`, the PR must also bump `package.json` by at least the corresponding level and add a `CHANGELOG.md` entry naming affected networks. The gate compares with the base branch's version. Releases are tags `vX.Y.Z`; the mainnet production branch deploys tags only (P11.1).

---

## P11. Deployment and rollout (brief §7, §11, §13)

### 11.1 Vercel projects — D-70…D-72

- **One Vercel project per network**: `bridge-wallet-monitor-mainnet` now, and `…-signet` once Q-01 is answered. Also a **`bridge-wallet-monitor-mainnet-staging`** project, with its own Neon project stamped `mainnet` (DB name suffixed `-staging`) and alerts routed to a test contact point. Vercel crons only fire on production deployments and signet is blocked, so staging is where drills D1–D4 are rehearsed before they touch the real alert path. Both are linked to the same repo, use framework preset *Other*, have Fluid compute on, and differ only in `NETWORK`. Crons, env scopes, Static IPs and protection are all per project in Vercel, so this separates failure, rollback and cost domains.
- **Plan tier (brief OQ1) verifies itself.** A `*/15` cron and `maxDuration: 800` fail deployment on Hobby. If the first production deploy succeeds, the plan is Pro or Enterprise. Record which.
- **The mainnet production branch deploys release tags only**, through `deploy.yml` with `vercel deploy --prod` on `v*` tags. A merge to `main` therefore never changes the production alert path by itself. Migrations run in the same job before the deploy, over `MIGRATION_DATABASE_URL`.
- **Region:** pin `regions` in `vercel.json` to the Neon region (default `iad1` ↔ Neon `aws-us-east-1`) unless Q-02 places the internal indexer elsewhere. In that case co-locate with the indexer and move Neon to match.
- **Egress to the internal indexer (Q-02).** If it is reachable over HTTPS with a token, nothing extra is needed. If it is IP-allowlisted, buy Static IPs (Pro, $100/month) for the mainnet project only; they apply to all its environments. If it is on a private network only, Secure Compute (Enterprise) is the only Vercel option. **That is a blocker for Stage A, not something to work around.**
- **Deployment Protection:** *Standard* (production domain unprotected, previews behind Vercel Authentication). Grafana Cloud's hosted scrape cannot send `x-vercel-protection-bypass`, and putting the bypass secret in a query string leaks it to logs. Do not create a bypass secret. Do not enable Attack Challenge Mode or bot challenges without a WAF exception for `/api/metrics`. **Stage 0 check:** the team default did not silently apply *All Deployments*. Cron behaviour under *All Deployments* is undocumented.
- **D-70, Stage 0 on public providers.** If Q-02 is still open at WU-10, the mainnet config may list only public Esplora providers (`tier: "public"`, one marked `primary`). The service then emits `bridge_monitor_primary_is_public=1`, the dashboard shows a banner, and every alert title is prefixed `[shadow][public-primary]`. Rationale: the humans on shift get a correct second signal days earlier, and nobody relies on it. It is not a workaround, because Stage A cannot start until the internal indexer is primary (P11.7).

### 11.2 `vercel.json`

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "regions": ["iad1"],
  "functions": {
    "api/collect.ts":     { "maxDuration": 800, "includeFiles": "config/**" },
    "api/metrics.ts":     { "maxDuration": 30,  "includeFiles": "config/**" },
    "api/drift-check.ts": { "maxDuration": 60,  "includeFiles": "config/**" }
  },
  "crons": [
    { "path": "/api/collect",     "schedule": "*/15 * * * *" },
    { "path": "/api/drift-check", "schedule": "37 5 * * *" }
  ]
}
```

- Maintenance (rollup + purge) runs inside collect (P5.5), so it needs no cron of its own.
- The lease TTL is 830 s: at least `maxDuration` (800 s) and less than the 900 s interval. The collect run deadline is `maxDuration − deadline_margin_s` (60 s), checked through `getDeadline()`.
- Crons do not follow redirects. Use no trailing slashes and no rewrites on these paths.
- Vercel crons may be missed, duplicated or overlapping, and are never retried. The lease and slot dedupe handle duplicates and overlap; the dead-man handles missed runs.

### 11.3 Neon

- One Neon **project** per network (P5.1), in the Vercel function region. Record the Postgres major version and pin the CI image to it.
- Roles are created with SQL, so they don't get `neon_superuser`:
  - `migrator` owns the schema and is used only by CI.
  - `app_rw` has DML only: no DDL, no TRUNCATE.
  - `metrics_ro` has SELECT only and `default_transaction_read_only=on`. It is used by `/api/metrics` through its own URL (`DATABASE_URL_METRICS`), so a scrape *cannot* write, which is the storage half of AC8.
  - `grafana_ro` exists only if history panels are used (P8.3).
  - `REVOKE CONNECT ON DATABASE … FROM PUBLIC`.
- `migrate --init-network mainnet` stamps the empty database once. The app never stamps.
- Scale-to-zero stays on unless scrape latency is a problem (a cost issue, not correctness). A 60 s scrape keeps the compute warm anyway.
- **Preview deployments get no `DATABASE_URL` and no `CRON_SECRET`**, so they fail closed. Do not enable Neon preview branching for the mainnet project.

### 11.4 Secrets inventory

| name | purpose | where | set by | rotation |
|---|---|---|---|---|
| `CRON_SECRET` | authenticates Vercel cron to `/api/collect` and `/api/drift-check` | Vercel, Production, Sensitive, per project | Vercel project admin; random, ≥ 32 chars, no newlines | quarterly or on staff change: edit → redeploy → `vercel crons run /api/collect` → 200. One missed run is within the dead-man tolerance. |
| `METRICS_BEARER_TOKENS` | comma list (≤ 2) accepted by `/api/metrics`; never accepted on cron routes | Vercel, Production, Sensitive; mirrored into the Grafana scrape job via a Terraform sensitive var | Vercel admin + Grafana admin | add new → redeploy → `terraform apply` → remove old → redeploy (no scrape gap, so no false dead-man) |
| `DATABASE_URL` | Neon **pooled** URL for `app_rw` | Vercel, Production, Sensitive | DB owner | reset role password → update → redeploy |
| `DATABASE_URL_METRICS` | Neon **pooled** URL for `metrics_ro`; the only DB credential `/api/metrics` loads | Vercel, Production, Sensitive | DB owner | same as above |
| `MIGRATION_DATABASE_URL` | Neon **unpooled** URL for `migrator` | GitHub Actions environment secret (`production-<network>`), never in Vercel | DB owner | same |
| `ESPLORA_PRIMARY_AUTH` (name from config `secret_env`) | internal indexer credential, only if Q-02 requires one | Vercel, Production, Sensitive, mainnet project | indexer operator | per operator |
| `GRAFANA_AUTH` | service-account token: rules, contact points, policies, dashboards | GitHub Actions secret | Grafana admin | per org policy |
| `GRAFANA_CONNECTIONS_API_TOKEN` | Grafana Cloud access policy (`integration-management:read/write`, `stacks:read`) for scrape jobs | GitHub Actions secret | Grafana Cloud admin | per org policy |
| Slack webhooks / pager key | contact points | Terraform sensitive vars (from CI secrets) | ops | per ops |
| `VERCEL_TOKEN` | tag deploys from CI | GitHub Actions secret | Vercel admin | per policy |

Not needed: `VERCEL_AUTOMATION_BYPASS_SECRET`, or a GitHub token for raw.githubusercontent.com (a public repo). Env var changes apply only to new deployments, so **every rotation needs a redeploy**. Descriptors are not secrets (Q-17), but they are never logged.

### 11.5 Grafana wiring (Terraform in `ops/grafana`, applied independently of service deploys)

1. Providers: `grafana` (stack URL + `GRAFANA_AUTH`) and, on Cloud, the connections API. The state backend is an ops decision; record it in `ops/grafana/README.md`.
2. The scrape job per network (Cloud: `grafana_connections_metrics_endpoint_scrape_job`): name `bwm-<network>`, URL `https://<production domain>/api/metrics`, `authentication_method = "bearer"` (token without the `Bearer ` prefix), `scrape_interval_seconds = 60`. It adds no static `network` label, because the exposition carries one.
3. Folder `Bridge wallet monitor`, and one dashboard with variables `network = label_values(bridge_monitor_version, network)` and `wallet`. Every stat panel shows the value, the as-of (`last_update_timestamp`), `n`, the CI bounds and `threshold_basis`. Banners cover `deployed_build_confirmed = 0` and `primary_is_public = 1`, and state which network-fee buckets feed the context panels (P3.10). There is no panel that sums across wallets or networks (non-negotiables 3, §8).
4. One rule group per network, generated by `scripts/gen-alerts.ts` from `rules.tmpl.yaml` + `alert-params.yaml` (P8.4). The M-1 rules (★) are in WU-10 and the rest in WU-14.
5. Notification policy tree per P8.4. Contact points come from Q-06.
6. Verify: Explore shows exactly one `bridge_monitor_version` series per network. A test notification per contact point is acknowledged by a human.

### 11.6 Drills (rehearsed on `mainnet-staging` first, then run on production at the stage noted in P11.7)

| id | action | expected | covers |
|---|---|---|---|
| **D1** | Vercel → Settings → Cron Jobs → *Disable*; record click time T | dead-man CRITICAL per wallet at ≤ T + 3600 s (predicted ≈ 3390 s worst case). Re-enable: resolves after the next committed scan. | AC5 |
| **D2** | remove the scrape token from `METRICS_BEARER_TOKENS` and redeploy, or disable the scrape job | the NoData → Alerting dead-man and/or exposition-absent CRITICAL within about 10 min | NoData path |
| **D3** | deploy with the primary `base_url = https://esplora-drill.invalid` (RFC 6761) for ≥ 1 h, then redeploy the real config (**not** Instant Rollback, which does not update crons) | 4/4 snapshots per wallet in the hour, `provider` = failover on each, `provider_errors_total{provider=primary}` increasing, "primary not in use" WARN after 60 m | AC6 |
| **D4** | two concurrent `vercel crons run /api/collect` | exactly one `ok` run and one `skipped_lease_held`; one snapshot per wallet | idempotency |

### 11.7 Staged rollout alongside the humans on shift — D-73

The exit criteria are policy targets for ops to confirm. They are not measurements. Each stage's evidence is recorded in `docs/runbook.md#rollout-log`.

**Stage 0: bring-up** (humans unchanged).
- *Entry:* WU-10 done; Q-06 answered (Grafana plus a shadow channel); Q-07 answered.
- *During:* optionally run the backfill job (P5.4) to reach 30-day coverage in minutes instead of about 8 hours of collect runs (arithmetic). Correctness does not depend on it. Run D1 once, on `mainnet-staging` first.
- *Exit (≥ 48 h):*
  - ≥ 190 of 192 expected snapshots per wallet over the 48 h window, with no gap longer than 2 slots.
  - Startup validation logged on every run (AC1).
  - Unauthenticated `GET /api/collect` returns 401.
  - `history_coverage_days ≥ 30`.
  - **M-1 observed.**
  - **Q-02 answered and the internal indexer configured as primary**, with ≥ 24 h clean (`primary_is_public = 0`, no `wrong_network`, conformance script green against it).
- If EE is still below its level, the first run's EE WARN is **expected** (§5). The runbook says so, so nobody "recalibrates" it.

**Stage A: shadow** (≥ 7 days; alerts go to the on-shift humans tagged `[shadow]`).
- *Each shift:* reconcile `spendable`, `stranded`, `largest_utxo` and the UTXO counts **to the satoshi** at the snapshot's `tip_height`. Use the sequencer wallet's own read-only `listunspent 1` if ops can run it (this is the selector's actual input), otherwise an explorer. Log each result.
- *Exit:*
  - 0 unexplained mismatches.
  - D1–D4 passed.
  - 0 false CRITICALs. A false CRITICAL resets the 7-day clock.
  - Every fired alert triaged.
  - **Q-03, Q-04 and Q-08 answered.** The manifest is pinned to the deployed SHA with `deployed_build_confirmed = true`, or the owner has signed off in writing on the documented model divergence.
  - Q-05 and Q-09–Q-16, Q-18, Q-19 confirmed or explicitly accepted.
  - Q-21 answered.
  - The anchor-fixture outcome recorded (P9.5).
  - **M-T:** the time-machine backtest (P3.11) over 2026-08-19 → 2026-09-30 (archive from 2026-07-20) has been reviewed by the brief's owner, with the provider archive recorded. For every step whose counterfactual exhaustion falls inside the data, R1 fired at least 5 days before it. Every step where `runway_days{p90} > realized_runway` has an explanation. The live/replay equivalence job has been green for the whole of Stage A.
  - **The brief's OQ8 (retention) answered before day 14 of Stage A**, which is the first snapshot purge.

**Stage B: real routing** (≥ 7 days; humans still on shift).
- *Entry:* the pager contact point test is acknowledged.
- *Exit:*
  - Every CRITICAL paged within 5 min of Grafana firing (pager timestamps).
  - One night-time D1 paged and acknowledged by on-call.
  - 0 missed detections: no shift found a §13 condition true that did not alert.

**Stage C: humans off overnight** (≥ 14 days; one daytime spot check per day).
- *Entry:* B exit plus sign-off by the ops owner. Q-22 (watchdog on Grafana) decided.
- *Exit:* 14 consecutive spot checks reconcile to the satoshi, and 0 missed detections.

**Stage D: steady state.** D1 monthly, D3 quarterly, secrets rotated per P11.4.

**Rollback.** Any reconciliation mismatch, missed detection, failed drill or delivery failure returns the rollout to the previous stage, with humans back on shift.

**Signet** runs as its own track (WU-16), blocked on Q-01. Its alerts never page.

---

## P12. Risk register

Ordered by expected damage. "Detection" says what verification catches the risk and where it lives.

| # | risk (what is most likely to go wrong) | consequence | detection / verification |
|---|---|---|---|
| R-01 | Settlement parser built from §2's layout (P2TR at vout 0, OP_RETURN in the reveal). EE is actually chunked, sometimes has no change, and a reveal may be N ≥ 1. | EE reveal cost or whole settlements missed. Cost understated, runway overstated: **v1 again**. | D-20 layout-agnostic parser; recorded EE fixtures (both layouts, with and without change); integrity identity D-22(2); `events_total{layout_unrecognized,unlinked_commit}` stays 0; AC2 replay within 10% |
| R-02 | `settlements_per_day` implemented as count/span | runway overstated by up to 1.54× (EE: 5.6 d instead of 3.6 at p90, arithmetic) | D-13; AC3 oracle needs the interval-based spd; `commits_30d` diagnostic; Q-05 |
| R-03 | Deployed build ≠ modelled build (M0/M1 vs M2; headroom; carry) | runway wrong in either direction (M0/M1: the brief is conservative; M2 carry: conservative; headroom: optimistic) | fingerprints D-23; `deployed_build_confirmed = 0` banner; Stage A exit gate on Q-03 |
| R-04 | A metric goes absent (null → missing series) and Grafana auto-resolves the firing alert, or NoData stays silent | dead or degraded monitor looks healthy: **v1's structural flaw** | always-on series (P8.1); dead-man NoData = Alerting; exposition-absent and threshold-missing rules; exposition-completeness unit test; drills D1/D2 |
| R-05 | Post-commit unconfirmed dip fires CRITICALs on a healthy wallet | alert fatigue on the backstop rule; humans learn to ignore it | two-arm rules (now × U0, sustained over `$DIP`; P8.4); `unconfirmed_sats`; Stage A exit: 0 CRITICALs that fired while `unconfirmed_sats > 0` and cleared within the dip window; dip durations tracked on the dashboard |
| R-06 | electrs `utxos_limit` (default 500) exceeded on the receipt address, since dust accrues one per settlement | `/utxo` HTTP 400, scan fails, monitor blind exactly as the wallet degrades | `utxo_limit` error kind (fails loudly, never empty); `max_utxos_per_address` WARN; Q-02 asks for the limit; conformance checks the error format |
| R-07 | History truncation (`[]` for an unknown cursor after a reorg or provider switch; page 1 repeated for a malformed cursor) | commits missing, fee sample and cadence wrong, runway high | D-24 `tx_count` completeness check (fails over); repeated-first-txid guard; unit tests with a hostile fake |
| R-08 | Wrong network anywhere: descriptor, provider, DB, or a mainnet key re-encoded as tpub | plausible empty wallet | version bytes, coin type, HRP, vectors (D-34); checkpoint binding; DB stamp FK and wallet identity; CI cross-file key-reuse check; rejection matrix |
| R-09 | CI rank computed in floating point, or with the brief's normal-approximation rule | a p90 CI upper emitted where none exists (n = 35), or a different basis | BigInt exact ranks; rank-table fixture; brief CI values are never oracles |
| R-10 | Selector drift undetected, because AC3 is composition-invariant (M1–M3, M5 do not move the runway) | a wrong port passes the acceptance tests | selection-level golden fixture + patch-based mutation meta-test; pinned non-monotone counterexample |
| R-11 | "Runway is monotone in rate" asserted as a property | a correct port gets "fixed" into an incorrect one | explicit counterexample test (P9.4) with a comment pointing here |
| R-12 | Pinned-SHA drift check treated as drift detection | false confidence: it cannot fail from upstream change | labelled "manifest integrity"; per-item tip check; runtime cron plus stale WARN; fingerprints |
| R-13 | Purge deletes un-rolled rows, fights re-ingest, or counters decrease | lost history; `rows_purged_total` climbing or resetting | purge guard per day (P5.5); ingest horizon D-32; counters in the same tx; AC10 tests including the retention shrink/grow case |
| R-14 | Session features through Neon's PgBouncer, or lease TTL misconfigured | overlapping writers, or a collection gap after every crash | lease row with fence; timing invariant in config and CI; integration tests through PgBouncer; lint tripwire for `SET`/advisory locks |
| R-15 | Internal indexer unreachable from Vercel (allowlist/private) | permanent fallback to rate-limited public providers (brief §7: 429s) | Q-02 at Stage A entry; `primary_is_public` and "primary not in use" WARNs; D3 |
| R-16 | Deployment Protection, Attack Challenge or bot mode blocks the scraper | all series NoData | Stage 0 check; dead-man NoData = Alerting fires within minutes; D2 |
| R-17 | Gap-scan ceiling reached, or change sent beyond the scanned range | blind to part of the wallet; spendable understated (this at least errs conservative) | `scan_ceiling_hit` WARN; `unknown_output_address` events; AC7 tests |
| R-18 | Manual consolidations, top-ups or reveal receipts misclassified | fake settlements in the fee series, or inflated deposits | D-21 classes; fixtures incl. the 969093 sweep and receipt txs; `events_total` WARN |
| R-19 | Measured constants hardcoded, or p99 reintroduced "for context" | stale thresholds, or an unsupported number that looks like a measurement (non-negotiable 7) | tripwire (P10.1); label allowlist; `p99` lint ban; exposition registry test |
| R-20 | Regime band edge flapping; downward shift lowers the threshold | WARN flapping; less warning margin (Q-14) | Grafana pending periods; closed-band tests; `regime_shift_rows` in the rollup for review |
| R-21 | OL regime shift forces fallback every time (7-day n ≈ 15–17) | recurring `insufficient_data` WARN on OL | expected and documented; fixture R6; runbook entry |
| R-22 | Partial backfill gives a recency-biased sample with n ≥ 30 | thresholds from an unrepresentative sample | coverage gate (Q-16) → `insufficient_data = 1`; `history_coverage_days` metric; Stage 0 exit requires ≥ 30 d |
| R-23 | The fixed median commit vsize understates multi-input commits | runway slightly optimistic right at the cliff | Q-18 to the owner; the largest-UTXO CRITICAL and multi-input WARN are the backstops |
| R-24 | The first production run fires the EE WARN and someone "recalibrates" | the one correct alert is suppressed | runbook entry; the Stage 0 exit criteria expect it |
| R-25 | The JS `Number` BIP380 polymod (40-bit state truncated to 32) | every checksum wrong (fails closed), or a lax fallback accepts corrupt descriptors | BigInt only; BIP380 vector plus the brief's two checksums in unit tests |
| R-26 | Grafana itself is down | total silence; nothing in this design notices | Q-22 (external heartbeat), decided before Stage C |
| R-27 | Config file not bundled into the function | ENOENT on the first cron; the dead-man fires only after the deploy | `includeFiles: "config/**"`; `vercel-build` validates the same path; the first `mainnet-staging` run's `runs.status = ok` gates the production deploy |
| R-28 | A wallet descriptor other than the two `wpkh` holds funds (for example `tr()`) | spendable undercounted; commits show as `mixed_spend` | `mixed_spend` events WARN; Q-21 |
| R-29 | Commit-only fee rates used by mistake (matching the brief's §5 numbers is tempting) | reveal cost understated, runway overstated | D-10 in one SQL view; `packageRate` unit test with commit ≠ reveal rates; the P9.5 diagnostic *reports* conventions and never selects one |
| R-30 | 30-day cadence or vsize lags an increase (DA going live, payload growth) | about 10 days of overstated runway (arithmetic) | max(7 d, 30 d) in D-13 and D-40; `cadence_settlements_per_day{window}` on the dashboard |
| R-31 | Indexer serves a stale tip, so a fresh `last_update` sits over an old state | stale data presented as current (non-negotiable 4) | reference-provider tip check + `max_tip_age_s` (P7.4); R17 |
| R-32 | Replaced or evicted mempool transactions linger | `unlinked_commit` noise; every run fails over on 404 | drop rule D-25b; 404 on an unconfirmed txid is a drop signal |
| R-33 | Wallet scan budget shared across wallets; EE failover starves OL | OL dead-man pages while OL itself is healthy | per-wallet budgets and deadline shares (P6.2) |
| R-34 | Traversal stops an address on a txid first seen via another address | older commits of that address silently skipped | per-address `address_txs` stop rule (D-24) |
| R-35 | Look-ahead bias in replay: later spends, later-confirmed reveals or later addresses leak into the view at H | the backtest flatters the monitor, the opposite of an audit | `AsOfChainView` filters every answer by height; no-look-ahead property test (P9.5b) |
| R-36 | Replay and live diverge (a different code path, or mempool effects misread) | the audit certifies a monitor that is not the one running | D-80 (one implementation); the D-86 weekly equivalence job with per-row explanations |
| R-37 | `realized_runway` read as the true cliff time | overconfidence: it ignores fragmentation losses | labelled an upper bound everywhere; the report shows `cliff_proxy` separately |

---

## Appendix A — Arithmetic oracles (for `test/fixtures/model/ac-oracles.json`)

These are **computed from the brief's displayed inputs, injected into pure functions**. They are not measurements, never belong in `src/` or `config/`, and are not expected outputs of the live service's own windows. They are reproduced independently in `tools/refimpl`.

| case | inputs | expected |
|---|---|---|
| cost EE p50 | vs 303, rate 2.84 | float 1,406.52; `costSats` = 1,407 |
| cost EE p90 point | 303, 6.60 | 2,545.80 → 2,546 |
| cost EE p90 CI lower / upper | 303, 4.92 / 9.26 | 2,036.76 / 3,351.78 → 2,037 / 3,352 |
| cost OL p50 | 549, 2.82 | 2,094.18 → 2,095 |
| cost OL p90 point | 549, 6.72 | 4,235.28 → **4,236** |
| cost OL p90 CI lower / upper | 549, 6.55 / 8.44 | 4,141.95 / 5,179.56 → 4,142 / 5,180 |
| AC2 error EE / OL | cost(303, 2.84) vs 1,436; cost(549, 2.82) vs 2,206 | 2.05% / 5.07%, both ≤ 10% |
| 6-day level, §5.1 rows: **brief-reproduction check only**, via a test-only float helper and `Math.round` | spd 11.9 (EE), 2.4 (OL) | EE 145,425 / 181,770 / 239,317; OL 59,644 / 60,988 / 74,586 |
| 6-day level, **production path**: `ceil(6 × spd × costSats)` with integer ceil cost | EE 3,352 @ 11.9; OL 5,180 @ 2.4 | EE 239,333; OL 74,592 |
| runway EE @p90 (AC3) | Σspendable 112,249, cost 2,546, spd 11.9 | 43 settlements, 3.613 d |
| runway EE @p50 | 112,249, 1,407, 11.9 | 79, 6.639 d |
| runway EE @p90_ci_upper | 112,249, 3,352, 11.9 | 33, 2.773 d |
| runway OL @p90 | 110,680, 4,236, 2.4 | 25, 10.417 d (26 / 10.83 d with the unrounded 4,235.28, which does **not** match the brief's 10.4) |
| runway OL @p50 | 110,680, 2,095, 2.4 | 52, 21.667 d |
| runway OL @p90_ci_upper | 110,680, 5,180, 2.4 | 21, 8.75 d |
| count/span counter-oracle (R-02) | EE spd 105/13.6 = 7.72 | 43 / 7.72 = 5.57 d. The test asserts that the service does **not** use this basis. |
| dust-filter mutant (M4) on the AC3 snapshot | 10 × 546 admitted | 46 settlements, 3.87 d |
| EE trigger check | 112,249 vs 5 × 11.9 × 2,545.8 = 151,475 (point) or 199,431 (CI upper) | below both, so the §5 claim holds |

Do **not** assert: §5.1's CI bounds (different rank convention); §5's 6-day row (181,483 comes from an unrounded spd; 61,668 cannot be reproduced, Q-23); §4.3's "predicted" column (rounded inputs); or any §5 quantile as an output of the 30-day window (the brief's spans were 14.6 d and 40.5 d).

---

## Appendix B — Where this plan extends, tightens or interprets the brief

Nothing here redefines spendable, cost, runway or the alert threshold.

1. Alert level on the p90 **CI upper** (§5.1/§13 over §4.5). Q-09.
2. `settlements_per_day` = median-interval cadence (§4.4/§4.5 leave it undefined). Q-05.
3. Package fee rate; vsize = weight/4, unrounded (unstated in the brief). Q-10.
4. Cost in integer sats with `ceil` (the brief's formula is real-valued). Conservative; reproduces §5.
5. Fallback basis = 30-day max; coverage gate → `insufficient_data` (§5.1 item 3 undefined). Q-11, Q-16.
6. Exact binomial CI instead of the brief's apparent normal-approximation ranks (§5.1 says "order statistics"). p99 is not computed at all.
7. Regime: closed band; `min_sample_short = 6`; only fee-rate inputs switch window (§9 underdetermined). Q-14, Q-15.
8. The §4.4 simulator pool is the §4.1 spendable set: the confirmed and script-type clauses are added to the "> 546" filter, so Σpool = `spendable_sats`.
9. `dust_limit_sats` stays in config (§8) but must equal the model constant: upstream it is compile-time.
10. Dead-man θ = 3300 s, not 3600 s (so AC5 is achievable). Q-13. Balance-derived rules use a two-arm form: fire at once when no wallet-owned value is in flight, otherwise require the breach to hold over a 1 h dip window. This stops §4.1's confirmed-only rule paging after every commit, without app-side hysteresis.
11. Largest-UTXO CRITICAL uses `scenario="p90_ci_upper"` and literal `cost` (§13 is silent). Q-12.
12. Drift: tip-tracking and runtime checks added to the literal pinned-SHA check; the coverage list extends beyond `builder.rs`.
13. Additional metrics (P8.2 table); `utxo_count` gains `bucket="unconfirmed"`.
14. Aggregate endpoints: runtime use is limited to `tx_count` and used-detection (§4.1). The sum identity lives only in the offline conformance script.
15. Settlement parsing is layout-agnostic and handles N reveals per commit. §2's layout is treated as one case, not the definition.
16. Dead-man and composition rules route through static labels; NoData/Error states are explicit.
17. Stage 0 may run on public providers, labelled, before Q-02 is answered. Stage A may not.
18. The time machine (P3.11) is an addition the brief does not ask for. It uses the production code path, and its backtest is a Stage A exit gate, because it tests §1's 5-day guarantee against real history.
19. `drain_per_day_sats`, max(7d, 30d) cadence and vsize, the phase-A/B scan split, the tx drop rule, and `ceilSafe` rounding are plan decisions where the brief is silent (P3, P5.4).

---

## Appendix C — Evidence index (as observed by the planning session, 2026-09-29/30; re-verify, do not paste into `src/`)

- Upstream `alpenlabs/alpen`: short SHA `7f20dcb` = `7f20dcb65fa478c9654626b77a05ea789d28806a` ("refactor(btcio): Expose fee rate api (#2269)", 2026-09-23). `main` = `4acde82671bbbf06601531616d50a557a56001ba` on 2026-09-29, which differs in `builder.rs` error types only. Generations: M0 ≤ `cdaeb8e` (2026-06-24); M1 from `42d45ee` (2026-08-13); M2 from `13bc320` (2026-09-03). `choose_utxos` unchanged since `81d4e77` (2026-06-05). `BITCOIN_DUST_LIMIT: u64 = 546` is defined in `builder.rs`. `listunspent` is called with minconf 1 (bitcoind-async-client 0.15.0 default). `NotEnoughUtxos` makes the writer wait and retry each tick; no crash. raw.githubusercontent.com resolves 7-char short SHAs, but the manifest stores full SHAs only.
- `builder.rs` sha256 at `7f20dcb65f…`: `0bd6d5f10dc5eea716897f277e9b9ba9e326eabedd726528125db17f3287c1e6` (70,628 bytes).
- Descriptors: EE `#lecc6wxp` and OL `#qj7slk5k` are valid BIP380 checksums over the text as written. With apostrophe markers they would be `#g39kk0vu` / `#h6r7nh7t`. Both xpubs: version `0488b21e`, depth 3, child `0x80000000`. Parent fingerprints: EE `ff875cb1`, OL `e995df82`. All six §4.2 vectors reproduce.
- Mainnet EE fixtures (full txids):
  - commit with change: `bdd3031c1ac7ebaf44db3f787e78eb2bb948836aec1462adba65dfe52c32142e`
  - no-change commits: `fc9d7236e4fb45d07bbc7000d8ff5a28c198c163e97b99909c94ef83703bf837`, `91e472ca95077d6cc0c637d147088da09e8a2384a85d6f98e3fd8463acf44e5a`
  - change moving to 0/3: `46f1a4711815602a70d00588f6937fbc2ce4c88fb29019a8687ecb3f83e49d54`
  - reveals: `08972c50b886222c3c21529c3b88041af52cc282b3bda65e14ce17d4c6894a73`, `8cc256034146600917a4aaf2cc102979ff5890352e90f5ed2c9e414da50f9118` (pays 0/4)
  - height-969093 dust sweeps: `e2379d1e63e7ba936e24987cf0678dee83607a658a9e5664e7d1a6116818f2d5`, `d26e8d0a0f225cbe5c2aa0ae369c4d2deebf21cbb33e4db08e7c7e92749d5ca2`, `4aa64021ca786280dc464462561057018661a08e9c0fc7b4411a14d506288888`, `dabf6cbcbafdddd790ce25d8f5e1ba8d0e970bc103b714153868fa62dc4f3b5f`, `40592f4c37645935d9ed92b5a92cf2401a2241c3d0e6da5e609c222e1087795a`, `0f327164bac6058be81a1b8dbee312ee564b7827a96dea83c337ced5e0e7b049`
  - top-ups: `715bb2e7e8f144fc5b853525d36f74e45b5222b7e03fb4c582bcf220cb11ddb6`, `a827d4d247986c801c894405aa9406f3092bdd09f4a0f90d3fe565448e06e8e1`
  - EE commit OP_RETURN push: `414c504e00000000`.
  - Reveal witness items: 64 + 98 + 33 bytes (= 195 B, consistent with brief OQ5).
- Network constants (Bitcoin Core `chainparams.cpp`):
  - mainnet: xpub `0488B21E` / xprv `0488ADE4`, HRP `bc`, genesis `000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f`
  - signet/testnet: tpub `043587CF` / tprv `04358394`, HRP `tb`, signet genesis `00000008819873e925422c1ff0f99f7cc9bbb232af63a077a480a3633bee1ef6` (shared by all signets); public-signet checkpoint candidate height 160000 = `0000003ca3c99aff040f2563c2ad8f8ec88bd0fd6b8f0895cfaf1ef90353a62c`
- Esplora/electrs: `utxos_limit` default 500, HTTP 400 "Too many unspent …". `/txs/chain` has 25 per page. `/address/{a}/txs` first-page composition differs by fork (mempool.space serves 50 total). `outspend` returns `{spent:false}` for unknown outpoints. `status.block_*` are omitted when unconfirmed. `/utxo` excludes mempool-spent outputs and includes mempool-funded ones.
- mempool.space `fee-rates/1m`: `[{avgHeight, timestamp, avgFee_0…avgFee_100}]`, 30-min buckets (1,428 points over about 31 days). The `/signet/api/v1/mining/blocks/fee-rates/1m` route exists (HTTP 200, same schema).
- Vercel: Hobby crons are daily only; Pro/Enterprise per minute. Fluid duration defaults to 300 s, max 800 s on Pro/Enterprise. Crons run only on production and are never retried. Duplicate and overlapping invocations are possible. `CRON_SECRET` is sent as `Authorization: Bearer`. Static IPs: Pro+, $100/month/project. Secure Compute: Enterprise. Grafana Cloud hosted scrape: public HTTPS, Basic/Bearer auth only, intervals 30/60/120 s. Grafana Cloud has no file provisioning; use Terraform or the API.

---

## Appendix D — Fixture specifications the plan's numbers were checked against

These are **synthetic** fixtures. They are reproducible from the generator specs below, and the planning session verified them independently with exact arithmetic.

### D.1 Regime and basis cases (`test/fixtures/stats/regime-cases.json`, AC11)

- **Clock:** `as_of = T = 1790000000`.
- **Config:** `band_lo 0.67`, `band_hi 1.5`, `min_sample 30`, `min_sample_short 6`.
- **Rate helper:** `cyc(k) = 2 + (k mod 16)/8`.
- **EE-like series:** 360 commits at `t_k = T − 3600 − 7200·k`, k = 0..359. That gives n30 = 360 and n7 = 84 (k ≤ 83).
- **OL-like series:** 72 commits at `t_k = T − 3600 − 36000·k`, which gives n7 = 17.
- Window membership uses `t > T − W·86400`. A commit at exactly `T − 604800` is **excluded** from 7 d.

| case | series | rates | m30 | m7 | ratio | shift | n_active | p90 (active) | basis |
|---|---|---|---|---|---|---|---|---|---|
| R1 | EE | 7 d: `2·cyc(k)`; older: `cyc(k)` | 3.25 | 5.75 | 1.7692307692 | 1 | 84 | 7.5, CI [7.25, 7.75], ranks (70, 82) | ci_upper 7.75 |
| R2 | EE | all `cyc(k)` | 2.875 | 2.875 | 1.0 | 0 | 360 | 3.75, CI [3.625, 3.75], ranks (312, 336) | ci_upper 3.75 |
| R3 | EE | 7 d: 3.0; older: 2.0 | 2.0 | 3.0 | **1.5 exactly** | 0 | 360 | 3.0, CI [3.0, 3.0] | ci_upper 3.0 |
| R3b | EE | 7 d: 3.0 + 2⁻¹⁰; older: 2.0 | 2.0 | 3.0009765625 | 1.50048828125 | 1 | 84 | 3.0009765625 | ci_upper 3.0009765625 |
| R4 | EE | 7 d: 2.0; older: 4.0 | 4.0 | 2.0 | 0.5 | 1 | 84 | 2.0 | ci_upper 2.0 (a downward shift lowers the basis, Q-14) |
| R5 | EE | 7 d: 0.67; older: 1.0 | 1.0 | 0.67 | **0.67 exactly** | 0 | 360 | 1.0 | ci_upper 1.0 |
| R6 | OL | 7 d: `2·cyc(k)`; older: `cyc(k)` | 3.125 | 5.75 | 1.84 | 1 | 17 | **unsupported** (l = 13, u = null) | **window_max 7.75**, `insufficient_data = 1` |

Non-computable cases give an absent ratio, `shift 0`, and active window 30 d:
- `m30 = 0`
- `n7 < min_sample_short`
- `n30 < min_sample`

### D.2 Descriptor rejection matrix (`test/fixtures/descriptors/rejection-matrix.json`, AC9 rejection half)

Each case recomputes the checksum when needed, so exactly one check fails. MAIN is the mainnet profile, SIG the synthetic-signet test profile, and SYN the synthetic BIP84 test-mnemonic tpub (Appendix C, P9.3). **Never put SYN in `config/`.**

| # | case | profile | expected |
|---|---|---|---|
| 1 | EE descriptor + EE vectors | MAIN | OK |
| 2 | OL descriptor + OL vectors | MAIN | OK |
| 3 | SYN tpub + SYN vectors | SIG | OK |
| 4 | EE (mainnet xpub) with tb-encoded vectors | SIG | E_NETWORK_VERSION |
| 5 | SYN tpub with EE vectors | MAIN | E_NETWORK_VERSION |
| 6 | EE key re-encoded as tpub, origin still 0h | SIG | E_NETWORK_COINTYPE |
| 7 | EE key re-encoded as tpub, origin rewritten to 1h, tb vectors derived from it | SIG | **OK at runtime**. It is caught **only** by the CI cross-file key-material check (duplicate pubkey+chaincode) and by the rule that vectors must be externally sourced. |
| 8 | mainnet vectors copied into a signet config | SIG | E_VECTOR_HRP |
| 9 | zpub (SLIP-132) | MAIN | E_SLIP132 |
| 10 | vpub (SLIP-132) | SIG | E_SLIP132 |
| 11 | apostrophe markers with the `h`-form checksum `#lecc6wxp` | MAIN | E_CHECKSUM_MISMATCH |
| 12 | apostrophe markers with their own checksum (`#g39kk0vu`) | MAIN | OK (identity is key-based, so no `E_WALLET_IDENTITY_CHANGED`) |
| 13 | uppercase `H` markers | MAIN | E_HARDENED_MARKER |
| 14 | no checksum | MAIN | E_CHECKSUM_MISSING |
| 15 | hardened wildcard `/*h` | MAIN | E_HARDENED_WILDCARD |
| 16 | reversed multipath `<1;0>` | MAIN | E_MULTIPATH |
| 17 | single-path `/0/*` | MAIN | E_MULTIPATH |
| 18 | `tr(...)` with origin 86h | MAIN | E_UNSUPPORTED_SCRIPT |
| 19 | `sh(wpkh(...))` | MAIN | E_UNSUPPORTED_SCRIPT |
| 20 | origin missing | MAIN | E_GRAMMAR |
| 21 | origin path of length 2 | MAIN | E_GRAMMAR |
| 22 | origin purpose 44h | MAIN | E_ORIGIN_PURPOSE |
| 23 | origin account 1h vs xpub child 0h | MAIN | E_CHILD_NUMBER |
| 24 | EE key with OL vectors | MAIN | E_VECTOR_MISMATCH |
| 25 | receive-only vectors | MAIN | E_VECTOR_COVERAGE |
| 26 | one corrupted xpub character (checksum recomputed) | MAIN | E_KEY_BASE58 |
| 27 | xprv (BIP32 TV1 master) in place of the key | MAIN | E_PRIVATE_KEY (the message never echoes the key) |

Also add: `E_CHECKSUM_FORMAT` (a 7-character checksum), `E_CHARSET` (a non-charset character), `E_KEY_POINT` (an invalid point), `E_DEPTH` (a depth-2 key), and a Number-based polymod mutant that must fail the checksum tests.
