# Release verification — 2026-09-30

## Implemented locally

Mainnet EE/OL descriptor derivation and dual-chain discovery; exact inventory partition and stale timestamps; bounded resumable confirmed settlement sampling; explicitly naive spendable runway; separate authenticated JSON/text/Prometheus reads; cron collection and manual refresh; Postgres migrations, fencing, slot deduplication and retention; Vercel configuration and CI/deployment workflows. Signet is configuration-driven but not operationally configured. Replay has a reusable chain interface and pure snapshot boundary, not an implemented replay command.

## Executed checks

- **Node 24.19.0:** strict TypeScript, six supplied mainnet address vectors/checksums, ESLint and dependency-cruiser boundaries passed (`pnpm check`). TypeScript 6.0.3 is pinned for linter compatibility.
- **64 tests across seven files passed.** Coverage includes descriptor/network rejection, synthetic signet, dust boundary/partitions, commit+reveal fees, no-change commits, output permutations, sweep exclusion, cadence/runway availability, gap rotation/ceiling, tip movement, malformed/limited providers, provider-atomic failover, resumable history, auth roles/rotation, absent liveness, SQL network binding, concurrent lease contenders, stale fences, successful-slot dedupe, atomic snapshots, daily retention, stale reads and integer safety.
- SQL tests actually applied `0001_init.sql` to embedded Postgres (PGlite). Full collector integration persisted OL after an EE failure, then authenticated reads served that stored result with a throwing global `fetch` to prove no provider call occurred.
- A provenance-stamped **real mainnet EE commit/reveal fixture** was captured and replayed offline. Its measured fee/drain identity reconciles exactly. OL output-order/no-OP_RETURN handling is covered synthetically; a captured OL fixture remains to be added when provider access permits.
- **8 real localhost HTTP checks passed** under Node 24: public shell, unauthenticated denials, wrong-role denials, authenticated missing-storage 503s, no-store headers and manual refresh failure semantics. Test tokens were generated in memory and not logged.
- `git diff --check` passed. No private keys, real tokens or database credentials were added. Supplied plan and brief were preserved; the brief copy is verbatim. Watch-only descriptors remain only in config and the supplied specifications, as the plan allows for a private repository.

## Live mainnet inventory observed

These are observations, not current funding advice or fixture constants. Both scans used Blockstream at height **969310**, hash `00000000000000000001d2ee959c5e4d3b819cd4d0594281ae1568330a732dd5`, with no discovery ceiling reached.

| Wallet | Scan start (UTC) | Spendable sats | Stranded sats | Inventory total sats | Largest spendable sats | Derived addresses |
|---|---|---:|---:|---:|---:|---:|
| EE | 2026-09-30 15:10:42 | 86,854 | 13,104 | 99,958 | 22,737 | 56 |
| OL | 2026-09-30 15:14:31 | 104,596 | 1,638 | 106,234 | 63,334 | 47 |

Both inventories had zero larger unconfirmed outputs. EE had 29 UTXOs (24 dust, 5 spendable); OL had 7 (3 dust, 4 spendable). The first bounded samples contained 54 EE and 69 OL complete settlements, but the history/linking phase had not fully finished, so **both live runway values correctly remained null (`history_incomplete`)**. These observations were read-only CLI verification, not production database collections.

A resumable verification scan repeated the EE balance at height 969311 and saved progress locally. The subsequent OL attempt received HTTP 429 from both Blockstream and mempool, so it failed without publishing partial output. No further public-provider retries were made in that validation sequence. Full live history convergence and an independent same-tip conformance run remain unverified because of provider throttling. An internal Esplora makes that validation deterministic; the production cron's 15-minute cadence also provides recovery time between public runs.

## Deployment status: blocked, not deployed

- Vercel CLI reports logged out / invalid authentication. The in-app browser opens the Vercel login page. A production build preflight on Node 24 failed while loading team access, before bundling or deployment.
- There is no linked Vercel project, team ID or project ID, and no configured production database URLs or app bearer secrets.
- The configured GitHub remote is `stefanopepe/alpen-l1-monitor`; both the connector and `gh repo view` could not access that repository. No code was pushed and no remote repository was created or changed. The implementation was committed locally on `codex/bootstrap-v2`.
- Docker is installed but its daemon is unavailable on this host. The real Postgres/PgBouncer CI job is scaffolded, **not claimed as executed**. The credential-free PGlite SQL tests did run.
- No deployed domain, production migration, production cron firing or Grafana alert has been verified. Grafana alerts, selector simulation and historical replay are outside steps 1–2.

## Exact remaining setup

1. Sign in to the intended **paid Vercel team**, link/create `bridge-wallet-monitor-mainnet`, and confirm its team/project selection.
2. Provide a dedicated Neon mainnet project and privately configure `MIGRATION_DATABASE_URL` (direct migrator), `DATABASE_URL` (pooled app writer) and `DATABASE_URL_METRICS` (pooled read-only role). Apply migrations and grants as documented.
3. Independent random `CRON_SECRET` and `METRICS_BEARER_TOKENS` have been generated locally in the gitignored, mode-0600 `.env`; values were never logged. Configure them privately as Vercel Production secrets with `NETWORK=mainnet`, and deploy. The three database URL fields in that file remain blank. No secret needs to be sent in chat.
4. Verify both wallet snapshots, allow history to converge, perform the offline inventory cross-check and observe at least two real scheduled cron runs. Supply an internal Esplora URL/auth if public throttling continues. The service remains Stage 0 until the plan's later operational gates are met.
5. For tag-driven CI deployment, make the configured private GitHub repository accessible and add the deployment environment secrets/variables listed in the runbook. Direct CLI deployment does not require this GitHub setup.

Detailed commands and role permissions are in [deployment.md](deployment.md).
