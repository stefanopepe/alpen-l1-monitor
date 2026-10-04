# Release verification — updated 2026-10-04

## Wallet report release — v2.4.0

The dashboard uses the agreed report layout with UTC and browser-local timestamps, a shared latest posted Strata epoch, mined-block median fee summaries, four mempool priorities and 24-hour quote averages. Each wallet shows the latest publication's combined commit/reveal fees, effective sat/vB and comparisons against its own preceding 24-hour/seven-day publication rates. The next-transaction estimate uses confirmed commit intervals and stays overdue when missed. Raw transaction IDs are collapsed into details.

The report reads stored evidence only. No migration or new scheduler is needed. Stored snapshots without the new publication summary remain readable and explicitly show not collected until refreshed. Partial fee histories retain visible coverage; quote averages never carry a quote through a collection gap longer than 30 minutes. DA backlog size and next-DA cost estimates are deferred.

Local checks use Node 24.19.0. Type/configuration checks, lint and dependency boundaries pass. Regression tests cover completion-window exclusions, fee arithmetic, missed transaction estimates, network-scoped stored fees, block deduplication/reorg replacement, missing coverage, failed quotes, zero fees and timezone/daylight-saving conversion. Both HTTP smoke suites pass. A browser inspection against the read-only mainnet database confirms the report layout and 24-hour block/quote coverage. Deployment results are recorded after release.

## Signet and L1 posting progress — v2.3.0

This release combines the previously deployed Signet work with OL checkpoint epochs and EE DA progress. Both network profiles retain their own descriptors, chain checkpoints, fee sources and page labels. Signet's `ALPN` checkpoint marker is configured from the October 2 capture; mainnet retains `STRA`. The captured Signet fixture decodes epoch 185 at block 324662 and is historical evidence, not a current reading or confirmation of the deployed sequencer build.

The integration preserves a validated envelope length and at most 68 header bytes before compacting database history. Repeated storage round trips preserve OL epochs, EE sequence numbers and split-chunk metadata without retaining full witness payloads. Fresh malformed witnesses cannot reuse old cached evidence, provider data cannot inject the local cache, and older compacted records without headers remain explicitly undecodable until refreshed.

Validation passed on Node **24.19.0**: type/configuration checks, ESLint, dependency boundaries, **177 tests across 23 files**, **20 mainnet HTTP checks** and **8 Signet HTTP checks**. Database regression coverage verifies EE posting evidence after storage. Mainnet and Signet checkpoint fixtures verify namespace separation, compact storage and confirmation boundaries. No database migration is required; stored legacy snapshots remain readable. Publishing the release tag triggers the existing mainnet deployment workflow; Signet uses its separate project and environment.

## Consolidation release — v2.2.0

The home page's Operator controls link to `/consolidation.html`. The page shows confirmed stranded outputs, value, an adjustable fee in 0.1 sat/vB steps, and an unsigned PSBT download. Input ownership, spend status, same-wallet change, conservative fee sizing and quote consistency are checked before download. The application never signs or broadcasts a transaction.

Local validation passed strict types, config/address vectors, lint, dependency boundaries, **134 tests across 17 files** and **19 HTTP smoke checks**. Browser inspection verified the home-page link; HTTP checks verified the dedicated page. The approved Vercel preview contains only synthetic wallets; no real inventory export was created. Production uses the existing read-only database connection. There is no new database migration.

The release branch was committed and merged into main as `6b491bf3e40a16c291f58279103a849e04093ae4`; the annotated [v2.2.0 tag](https://github.com/stefanopepe/alpen-l1-monitor/tree/v2.2.0) points to that commit. Both [CI jobs passed](https://github.com/stefanopepe/alpen-l1-monitor/actions/runs/37027368102), including PostgreSQL/PgBouncer checks. The CLI token and connected GitHub integration lack permission to create pull requests, so the verified branch was merged and pushed through Git. GitHub release-note publication also returned HTTP 403; the tag is published, but there is no GitHub Release object.

GitHub's production deployment environment remains unconfigured; the [tag-triggered deployment](https://github.com/stefanopepe/alpen-l1-monitor/actions/runs/37027545700) failed at its configuration check. The documented authenticated Vercel CLI fallback succeeded from the exact tagged commit. Deployment `dpl_HnhKs5XYtjLvwbqAcsmuf79fqRhC` is Ready and aliased to [the main app](https://ee-ol-wallet-monitor.vercel.app/).

Production home, consolidation page and status returned 200; unauthenticated collection returned 401. Both wallets' live quotes and unsigned PSBT downloads were verified at 1.2 sat/vB, including fee, returned amount, input count and absence of signatures. Browser verification followed the Operator controls link and confirmed the live fee controls and download button. No transaction was signed or broadcast. The existing collector reports durable fee evidence; no migration was needed for consolidation.

## First tagged release — v2.1.0

The user authorized production deployment and the first release on October 2. The release includes wallet replay, experimental seasonal fee research, and durable quote/pressure/completed-block observations. The live API exposes observation context; seasonal predictions and calibrated bounds remain offline report/CLI features. The operational wallet-runway formula is unchanged.

Release checks passed under Node **24.19.0**: strict types, configuration/address vectors, lint, dependency boundaries, **128 tests across 16 files**, and **18 HTTP smoke checks**. The additional role regression verifies runtime fee inserts, rejection of runtime updates/deletes, continued normal run writes, read-only access, and idempotent permission application. A scan of the 126 candidate source/documentation files found no configured credential values.

Production preflight verified the existing `alpen-labs/ee-ol-wallet-monitor` Vercel project, Node 24.x, mainnet database schema 1, and both runtime/read roles. The rollout deploys the schema-1/2-compatible code before applying migration 2 and role permissions. Earlier code rejects schema 2 and is not a supported rollback target. GitHub's `production-mainnet` deployment environment was absent, so this release uses the authenticated Vercel CLI fallback; configuring tag-driven deployment remains separate setup work.

At the v2.2.0 release preflight, v2.1.0 remained a local tag and its commit was not yet on remote main. That work is included in the published v2.2.0 tag above. Earlier entries below preserve the verification state at the time they were written.

## Implemented locally

Mainnet EE/OL descriptor derivation and dual-chain discovery; exact inventory partition and stale timestamps; bounded resumable confirmed settlement sampling; explicitly naive spendable runway; public JSON/text/Prometheus reads; authenticated cron collection and manual refresh; Postgres migrations, fencing, slot deduplication and retention; Vercel configuration and CI/deployment workflows. Version 2.1 adds the offline time-machine CLI/report, authenticated historical archives and continuous free fee context. Signet is configuration-driven but not operationally configured. Older verification entries below describe the scope and authentication policy in effect when those checks ran.

## Time machine verification — 2.1.0

### October 2 archive refresh and funding verification

The original archive stopped at block 969456. Authenticated Alpen verification located EE's 310,000-sat deposit at **969457**, October 1 at **15:00:02 UTC**, transaction `8851fd44fa9607f49fcc5ada01e55171d0d050c2118b07b84014b2dc50c89bd5`, output 0. It pays EE receive index 1, has no EE inputs, and was absent from the old seal. The live collector already included it; completed replay captures previously returned their first seal without advancing.

Fetch now extends completed archives, validates the prior/new finalized anchors and preserves prior seals by digest. `pnpm replay refresh` combines capture, replay and report rebuilding. Interrupted updates retain a usable old seal and resume their pinned boundary. The report opens at the latest captured balance and labels deposited spendable amounts in chart tooltips and the newest-first funding list.

- Real refresh sealed **1,285 transactions / 17,438 headers / 200 addresses** through block **969554**, October 2 **07:11:32 UTC**, digest `0c6ac08628a8b594e19eaea3cefffcd6312f050ad6dd2ac1703609442efe39be`. The earlier October 1 seal remains loadable with `--seal` and its original digest.
- Replay shows EE spendable balance **64,153 → 374,153 sats** across blocks **969456 → 969457**, exactly the deposit amount. At 969554, EE has **351,462 spendable sats / 20.3831 days**, and OL has **87,117 sats / 16.6731 days**. These are finalized replay observations, not live-tip readings.
- The latest 90-day replay covers **956620–969554**, **25,870 wallet snapshots**. All **25,674 overlapping prediction records** exactly match the preceding audit by canonical digest. There are **632 reconciled settlements, eight deposits and 13 consolidations**, with no unresolved/ambiguous events at the seal.
- `pnpm check` passed **100 tests in 12 files**, types/config validation, lint and import boundaries. New regressions cover deposits on receive and change chains, before/after balances, old prediction invariance, saved-seal loading, header reuse, interrupted refresh, unchanged finalized tips, reorg refusal and omission of previously sealed funding. All **18 HTTP smoke checks** passed.
- Browser verification confirmed the latest-block default, +310,000-sat funding row and navigation to its exact confirmation block. Generated archives/report contained **zero credential matches**. Logical sizes: archive with retained prior seal **26,760,526 bytes**, audit **93,028,717 bytes**, HTML **11,816,891 bytes**.

### October 2 dashboard refinement

The self-contained report now bundles Bootstrap 5.3.8 and Chart.js 4.5.1. The top-level wallet/model selectors have focus/hover explanations; EE and OL have their full roles. The primary chart shows actual spendable balance and the original model projection through a dated zero-balance marker, with UTC ticks and a recorded-data boundary. Scoring controls are grouped below the chart, error rows state the exact spending period and how far the forecast was too low/high, and interpretation/open questions sit at the bottom. Saved forecasts, outcomes and scores were reused without modification.

`pnpm check` passed **96 tests in 11 files**, type/config validation, lint and import boundaries. Four new chart-data cases verify the zero intercept, model selection, future deposits, unavailable/zero-rate predictions and single-block coverage. All **18 HTTP smoke checks** passed after dependency changes. Browser checks verified wallet/model changes, tooltip text, error-row navigation, date and block controls, play/pause, filtering and sorting. Screenshots confirmed visible date ticks and the zero marker; the browser reported no warnings or errors. The refreshed report is approximately **11.6 MB** and loads its libraries locally.

### October 1 capture and audit

- `pnpm check` passed: strict types, descriptor/config validation, ESLint, dependency boundaries and **92 tests across ten files**. `pnpm smoke` passed all **18 HTTP checks**. No migration or new scheduler was introduced; the version is prepared for the existing `v2.1.0` tag workflow, not deployed.
- Regression coverage verifies future-data removal/modification cannot affect an earlier prediction, backward seeks agree with fresh reconstruction, delayed/multiple reveals, same-block spends, backward timestamps, future address usage, discovery ceilings, missing parents/records, incomplete archives, digest/ancestry failures, deterministic outputs, fixed-window baselines, unresolved outcomes, optimistic error signs, deposit handling and censoring. Corrupting reveal fees produces an accounting discrepancy; deliberately optimistic forecasts produce underprediction errors.
- Collector integration verifies failed fee recommendations still allow wallet collection and persist a versioned run envelope. Optional quote context survives database-only reads. Legacy snapshots and array-shaped runs remain readable. Import checks prohibit replay modules from depending on database/API modules. A secret-value scan over source, archive, observation export and report found **zero credential matches**.
- Completed a real authenticated **Alpen** capture through finalized block **969456**: **1,266 transactions, 17,340 contiguous headers, 200 derived addresses**, archive digest `3ffb038bcae209375433b4c15fabacdcad397176369b25a5485503360ae99c0f`. The offline run replayed **12,953 heights / 25,906 wallet snapshots**, July 3–October 1, with 30-day warm-up and no historical quote substitutions. All 623 complete settlement packages reconcile; no unresolved or ambiguous packages remain at this seal.
- Read-only observation export succeeded against the configured mainnet database: **15 retained legacy run records**, no fee quotes yet. Replaying with that export leaves historical quote context unavailable. Continuous quotes begin when the new collector code is deployed.
- Final logical sizes: archive **19,789,084 bytes**; audit **91,658,084 bytes**, including **11,043,832 bytes** of self-contained HTML. The outputs remain in ignored `.local/replay/mainnet`, `.local/replay/audit-mainnet` and `.local/replay/observations.json`.
- Browser verification exercised EE/OL selection, model/horizon filters, intervention-free and non-overlapping sampling, date/height jumps, previous/next, slider, play/pause, training disclosure and worst-prediction sorting/jumps. The report was visually inspected and reloaded after the final offline rebuild.
- On matched five-day daily windows, EE's current MAE was **17.9% worse** than the seven-day mean (36 origins), while OL's was **13.6% better** (26). Underprediction occurred on **91.7% / 73.1%** respectively. Intervention-free comparisons shrink to **0.8% worse / 2.8% better**. Only five EE and four OL intervention-free, non-overlapping origins remain. See [full methodology, largest errors and coverage limits](time-machine.md).

## Executed checks

- **Node 24.19.0:** strict TypeScript, six supplied mainnet address vectors/checksums, ESLint and dependency-cruiser boundaries passed (`pnpm check`). TypeScript 6.0.3 is pinned for linter compatibility.
- **65 tests across seven files passed.** Coverage includes descriptor/network rejection, synthetic signet, dust boundary/partitions, commit+reveal fees, no-change commits, output permutations, sweep exclusion, cadence/runway availability, gap rotation/ceiling, tip movement, malformed/limited providers, provider-atomic failover, resumable history, auth roles/rotation, absent liveness, SQL network binding, concurrent lease contenders, stale fences, successful-slot dedupe, atomic snapshots, daily retention, stale reads and integer safety.
- SQL tests applied `0001_init.sql` to embedded Postgres (PGlite). On October 1, all six SQL tests also passed against **PostgreSQL 17.6 through PgBouncer 1.24.1 in transaction mode**, including concurrent lease contenders and fencing. The documented migration command initialized a fresh database and succeeded again without reapplying the migration. Full collector integration persisted OL after an EE failure, then authenticated reads served that stored result with a throwing global `fetch` to prove no provider call occurred.
- Provenance-stamped **real mainnet EE and OL commit/reveal fixtures** were captured and replayed offline. Their measured fee/drain identities reconcile exactly. The captured OL commit puts P2TR at vout 0 and change at vout 1, with no commit OP_RETURN; its reveal has a zero-value OP_RETURN followed by a 546-sat wallet output. This differs from the captured EE layout and is now pinned in the fixture test.
- **18 real localhost HTTP checks passed** under Node 24 through `pnpm smoke`: public shell, routing, method/format rejection, unauthenticated and wrong-role denials, authenticated missing-storage 503s, no-store headers and manual refresh failure semantics. Test tokens were generated in memory and not logged. This exposed and fixed an extra `--import node` in the four local launcher commands; the smoke test now launches the actual `pnpm dev` script on an ephemeral port and runs in CI.
- `git diff --check` passed. No private keys, real tokens or database credentials were added. Supplied plan and brief were preserved; the brief copy is verbatim. Watch-only descriptors remain only in config and the supplied specifications, as the plan allows for a private repository.

## Live mainnet inventory observed

These are observations, not current funding advice or fixture constants. Both scans used Blockstream at height **969310**, hash `00000000000000000001d2ee959c5e4d3b819cd4d0594281ae1568330a732dd5`, with no discovery ceiling reached.

| Wallet | Scan start (UTC) | Spendable sats | Stranded sats | Inventory total sats | Largest spendable sats | Derived addresses |
|---|---|---:|---:|---:|---:|---:|
| EE | 2026-09-30 15:10:42 | 86,854 | 13,104 | 99,958 | 22,737 | 56 |
| OL | 2026-09-30 15:14:31 | 104,596 | 1,638 | 106,234 | 63,334 | 47 |

Both inventories had zero larger unconfirmed outputs. EE had 29 UTXOs (24 dust, 5 spendable); OL had 7 (3 dust, 4 spendable). The first bounded samples contained 54 EE and 69 OL complete settlements, but the history/linking phase had not fully finished, so **both live runway values correctly remained null (`history_incomplete`)**. These observations were read-only CLI verification, not production database collections.

A resumable verification scan repeated the EE balance at height 969311 and saved progress locally. The subsequent OL attempt received HTTP 429 from both Blockstream and mempool, so it failed without publishing partial output. No further public-provider retries were made in that validation sequence. Full live history convergence and an independent same-tip conformance run remain unverified because of provider throttling. An internal Esplora makes that validation deterministic; the production cron's 15-minute cadence also provides recovery time between public runs.

## October 1 live collection smoke test

A manual `POST /api/refresh` ran against a disposable PostgreSQL database through transaction-mode PgBouncer, using `monitor_app` for writes and `monitor_read` for reads. The server recorded both wallets as successful from **12:54:52 to 13:02:10 UTC**. Authenticated JSON, text and Prometheus responses returned 200 and agreed with these persisted snapshots:

| Wallet | Inventory scan start (UTC) | Tip height | Spendable sats | Stranded sats | Inventory total sats |
|---|---|---:|---:|---:|---:|
| EE | 2026-10-01 12:54:52 | 969444 | 67,345 | 19,110 | 86,455 |
| OL | 2026-10-01 12:58:40 | 969445 | 99,714 | 2,730 | 102,444 |

Both used Blockstream with zero recorded provider errors. Exact balance partitions passed; neither had larger unconfirmed or unsupported outputs. Runway remained null with `history_incomplete` (54 EE and 69 OL sampled settlements). These are timestamped observations, not current balances or production data.

Concurrent cron, manual-refresh and CLI calls all skipped while the collection lease was held. Reads remained responsive during collection, and a direct write attempt using the pooled read role was rejected. Fresh-database JSON/text/metrics correctly showed both wallets as unavailable before collection.

**HTTP duration limitation:** the original Node `fetch` smoke client failed before receiving the roughly 439-second refresh response; Node's default headers timeout is 300 seconds. The successful server-side run and all three output formats were subsequently verified independently. The original long-running refresh HTTP response is not counted as a passed check. A repeat of that request needs an HTTP client configured to wait for the full collection duration. The normal 18-check smoke suite uses short requests and passed.

The local report is retained under ignored `.local/smoke/live-report.json`. The real OL fixture was extracted from this collected history without further provider requests. The production checks below were performed subsequently.

## Production deployment and private-provider switch

- `https://ee-ol-wallet-monitor.vercel.app/` is deployed in the `alpen-labs` team and reads the mainnet Neon database. Neon reports PostgreSQL 18.6. Migrations, network binding, pooled TLS connections, separate collector/read roles and rejection of writes by the reader were verified. Secrets remain outside Git.
- Production JSON, text and Prometheus reads returned 200 with matching persisted inventories. Missing and wrong-role credentials returned 401. Concurrent collection skipped while the database lease was held.
- The first cloud collection completed from **14:21:00 to 14:28:15 UTC** on October 1. A local collector subsequently wrote directly to the same Neon database; production served those snapshots. OL history became complete; EE history remains resumable and incomplete.
- Runs arrived at the expected **14:30** and **14:45 UTC** cron slots without a manual trigger from this session. The first skipped because local collection held the lease. The second successfully collected both wallets from **14:45:19 to 14:50:13 UTC**. This establishes one successful unattended collection plus a correctly skipped scheduled invocation, not two successful scheduled collections.
- The supplied private Alpen Esplora authenticated using `?token=…`; `/blocks/tip/hash` and the Bitcoin mainnet genesis checkpoint succeeded at the root API path. Query authentication now uses an environment variable, URL-encodes the value per request, rejects redirects and sanitizes errors. Both the collector and independent conformance script use the same authentication construction.
- A local run through provider `alpen` successfully collected both wallets from **14:51:48 to 14:53:19 UTC**, about 91 seconds, and the production status endpoint served these fresh snapshots. The preceding public-provider collection took about 294 seconds. These timings cover different moments/history progress and are observations, not a controlled benchmark. EE history remains incomplete; OL is complete.
- After the private-provider change, **75 tests across eight files**, strict type checking, configuration/vector validation, lint and dependency boundaries passed. New cases cover query encoding, existing header authentication, missing credentials, redirect/error redaction and refusal to embed credentials in the configured base URL. Source files were checked against the actual token without printing it.
- **The private-provider code is not yet verified on Vercel.** After the user reported redeployment, the **15:00:19–15:05:13 UTC** scheduled run succeeded for both wallets but used Blockstream. Both snapshots' configuration fingerprints exactly match the old public-provider configuration, with zero Alpen errors. The observed cloud run therefore used old code, rather than failing over from Alpen. The database's provider display flag was restored to public to match the active deployment. The **14:45** and **15:00 UTC** runs now establish two successful scheduled collections about 15 minutes apart. The user manages deployments through the dashboard; no CLI sign-in was completed.

## Public-read update

The user explicitly requested public dashboard/read APIs on October 1. The read-token input is removed and the page loads stored status automatically. The status JSON/text and Prometheus handlers no longer require a bearer token. Cron and manual-refresh authentication, read-only database access and server-side provider credentials remain in place.

All **75 tests** plus type checking, config validation and lint passed after this change. Integration checks served persisted JSON, text and metrics without any authorization header while forbidding upstream calls. The **18 HTTP smoke checks** passed, including protected collection and missing-storage behavior. A local browser automatically displayed both real Neon wallet snapshots without token entry.

## Production verification after deploying `db73e0c`

At **15:31:46 UTC on October 1**, the production HTML matched the public-read update: no read-token input, with authenticated Operator controls retained. Unauthenticated JSON, text and Prometheus reads all returned **200**; unauthenticated collection and manual refresh returned **401**.

Scheduled run `267b5a4c-f551-41f8-a542-2828e6496f5b` completed successfully from **15:30:19.645 to 15:31:02.136 UTC**, about 42 seconds. Both wallets used provider **`alpen`**, had complete history and available runway, and were fresh at verification time. This supersedes the earlier pending-cloud-provider and incomplete-EE-history observations. The direct migration command synchronized the database's provider metadata with the private-primary configuration.

## Remaining verification and deployment work

The release-tag workflow passed `actionlint` 1.7.12 and 18 local guard cases covering stable tag formats, missing deployment configuration and tag/app-version agreement. Exact tag checkout and the required manual tag input were also verified. No deployment credentials were used in these checks.

1. For tag-driven CI deployment, configure GitHub environment `production-mainnet` with the two secrets and two variables listed in the runbook, then push the first matching version tag. The workflow is prepared; a successful tag-triggered cloud deployment remains unverified.
2. Perform the independent same-tip live inventory cross-check. Grafana alerts and selector simulation remain outside steps 1–2; historical replay was subsequently implemented under the explicit time-machine scope above.

Detailed commands and role permissions are in [deployment.md](deployment.md).

## Seasonal fee experiment — October 2, 2026, local verification

Prepared on `codex/seasonal-fee-forecast`, preserving the existing time-machine work. `pnpm check` passed under Node **24.21.0**: strict type checking, configuration/address vectors, ESLint, dependency boundaries and **116 tests in 15 files**. `pnpm smoke` passed **18 HTTP checks** with disconnected storage and ephemeral tokens. No deployment was performed.

New fee tests cover coarse-bucket merging, archive tampering, incomplete history, future-data leakage, seasonal recovery, pressure freshness/failure/overflow/decay, subsecond observations, resolved-only calibration and matched baselines. Portable report round-tripping and optional replay attachment leave wallet forecast files unchanged.

Public mempool history capture produced 5,589 non-overlapping buckets across four years. One live projected-block snapshot drives the current pressure curve; historical pressure scores and pressure p50/p90 remain unavailable. The real walk-forward findings and archive digest are in [seasonal-fees.md](seasonal-fees.md). Seasonal central error improves, while measured p90 coverage remains below 90%.

Browser checks verified the standalone and combined reports, all three current curves, one-day/non-overlapping controls, annual pattern disclosure, and the combined report's Seasonal fees navigation. No browser console errors or warnings were recorded. Saved HTML and study data remain in ignored `.local/fees/study/`; the attached wallet report is `.local/replay/audit-mainnet/report.html`.


## Local fee hardening (unreleased, October 2)

`pnpm check`: 127 tests, type/config validation, lint and dependency boundaries passed. `pnpm smoke`: 18 local HTTP checks passed with database URLs disabled. New tests cover retention beyond run cleanup, fractional block fees, independent provider failures, immutable archive refreshes, delayed availability, causal calibration, training-only pressure challengers, frozen plan tampering and replay forecast selection. The portable fee report and existing combined replay report were rebuilt and checked in the browser. A future held-out plan is saved locally; no operational promotion, migration against production, release tag or deployment occurred. See [fee evidence and operating instructions](seasonal-fees.md#observation-and-evaluation-hardening-local-iteration).
