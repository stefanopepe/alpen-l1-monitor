# Release verification — updated 2026-10-01

## Implemented locally

Mainnet EE/OL descriptor derivation and dual-chain discovery; exact inventory partition and stale timestamps; bounded resumable confirmed settlement sampling; explicitly naive spendable runway; separate authenticated JSON/text/Prometheus reads; cron collection and manual refresh; Postgres migrations, fencing, slot deduplication and retention; Vercel configuration and CI/deployment workflows. Signet is configuration-driven but not operationally configured. Replay has a reusable chain interface and pure snapshot boundary, not an implemented replay command.

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

The local report is retained under ignored `.local/smoke/live-report.json`. The real OL fixture was extracted from this collected history without further provider requests. Production scheduling, history convergence and a same-tip independent provider-conformance run remain unverified.

## Deployment status: blocked, not deployed

- Vercel CLI reports logged out (rechecked October 1). The previous in-app browser check opened the Vercel login page. A production build preflight on Node 24 failed while loading team access, before bundling or deployment.
- There is no linked Vercel project, team ID or project ID, and no configured production database URLs. Independent bearer secrets exist only in the ignored local `.env`; production secrets still need configuring.
- The implementation was pushed to `stefanopepe/alpen-l1-monitor`, branch `codex/bootstrap-v2`, using smart-card SSH authentication. GitHub CLI/connector credentials lack access; successful SSH access and push do not depend on them.
- The Docker runtime was started for the October 1 smoke test. This host lacks Compose and references an unavailable Docker Desktop credential helper, so isolated Docker settings and disposable containers using the repository's pinned images were used. Real PostgreSQL/PgBouncer checks passed locally; remote CI execution is not claimed as verified.
- No deployed domain, production migration, production cron firing or Grafana alert has been verified. Grafana alerts, selector simulation and historical replay are outside steps 1–2.

## Exact remaining setup

1. Sign in to the intended **paid Vercel team**, link/create `bridge-wallet-monitor-mainnet`, and confirm its team/project selection.
2. Provide a dedicated Neon mainnet project and privately configure `MIGRATION_DATABASE_URL` (direct migrator), `DATABASE_URL` (pooled app writer) and `DATABASE_URL_METRICS` (pooled read-only role). Apply migrations and grants as documented.
3. Independent random `CRON_SECRET` and `METRICS_BEARER_TOKENS` have been generated locally in the gitignored, mode-0600 `.env`; values were never logged. Configure them privately as Vercel Production secrets with `NETWORK=mainnet`, and deploy. The three database URL fields in that file remain blank. No secret needs to be sent in chat.
4. Verify both wallet snapshots, allow history to converge, perform the offline inventory cross-check and observe at least two real scheduled cron runs. Supply an internal Esplora URL/auth if public throttling continues. The service remains Stage 0 until the plan's later operational gates are met.
5. For tag-driven CI deployment, add the deployment environment secrets/variables listed in the runbook to the private GitHub repository. Direct CLI deployment does not require this GitHub setup.

Detailed commands and role permissions are in [deployment.md](deployment.md).
