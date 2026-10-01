# Release verification — updated 2026-10-01

## Implemented locally

Mainnet EE/OL descriptor derivation and dual-chain discovery; exact inventory partition and stale timestamps; bounded resumable confirmed settlement sampling; explicitly naive spendable runway; public JSON/text/Prometheus reads; authenticated cron collection and manual refresh; Postgres migrations, fencing, slot deduplication and retention; Vercel configuration and CI/deployment workflows. Signet is configuration-driven but not operationally configured. Replay has a reusable chain interface and pure snapshot boundary, not an implemented replay command. Older verification entries below describe the authentication policy in effect when those checks ran.

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

All **75 tests** plus type checking, config validation and lint passed after this change. Integration checks served persisted JSON, text and metrics without any authorization header while forbidding upstream calls. The **18 HTTP smoke checks** passed, including protected collection and missing-storage behavior. A local browser automatically displayed both real Neon wallet snapshots without token entry. Deployment of this update remains pending.

## Remaining verification and deployment work

1. Ensure `ALPEN_ESPLORA_TOKEN` is saved in Vercel Production and create a deployment from the newest `main` commit, including both query authentication and public reads. Verify the deployment's source commit; redeploying an older commit does not include either change.
2. Synchronize database provider metadata with `pnpm migrate --init-network mainnet` after deployment, then verify a cloud collection reports provider `alpen`. Local success alone does not prove cloud connectivity.
3. Allow EE history to converge and perform the independent same-tip inventory cross-check. Grafana alerts, selector simulation and historical replay remain outside steps 1–2.
4. For tag-driven CI deployment, add the deployment environment secrets/variables listed in the runbook to the private GitHub repository. Dashboard deployment does not require CLI sign-in.

Detailed commands and role permissions are in [deployment.md](deployment.md).
