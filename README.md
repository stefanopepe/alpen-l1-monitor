# bridge-wallet-monitor v2

A watch-only Bitcoin wallet monitor for Alpen EE and OL. This first release implements the user's settled steps 1–2: correct Esplora inventory, an explicitly **naive** runway estimate, public text/JSON and Prometheus output, a 15-minute collector, authenticated manual refresh, and Vercel deployment configuration.

`PLAN.md` remains the detailed alert-system specification. Selector simulation, quantile confidence bounds, Grafana alerting and upstream drift monitoring are deferred. Version 2.1 adds the user-approved [time machine](docs/time-machine.md) to audit the existing runway formula. This remains Stage 0 observation, not the plan's M-1 alert milestone. See [scope and decisions](docs/decisions.md).

## Run locally

Use Node 24 and pnpm 11.25.0 (`corepack enable`).

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm smoke
cp -n .env.example .env
docker compose up -d --wait
pnpm migrate --init-network mainnet
pnpm dev
```

Fill a random, at least 32-character `CRON_SECRET` in `.env`; generate it privately with `openssl rand -hex 32`. Add `ALPEN_ESPLORA_TOKEN` for the private provider. Open `http://localhost:3000`: the latest stored status loads automatically, without a token. **Operator controls** contains the refresh-token field for manual collection. The page clears that token after use and does not persist it. Database and Esplora credentials stay server-side. `METRICS_BEARER_TOKENS` is no longer used.

Docker's trust authentication is strictly for this disposable, loopback-bound development setup. Production requires separate authenticated TLS database connections and least-privilege roles.

`pnpm smoke` launches the actual `pnpm dev` command on an ephemeral loopback port and checks HTTP routing, authentication, role separation and missing-storage responses. It generates temporary tokens in memory and deliberately disconnects storage; collection-to-read persistence is covered by `pnpm test test/collect-integration.test.ts`.

## Endpoints

| Endpoint | Authentication | Effect |
|---|---|---|
| `GET /api/status` | Public | Latest stored JSON with timestamps and stale flags |
| `GET /api/status?format=text` | Public | Human-readable inventory and naive runway |
| `GET /api/metrics` | Public | Prometheus text; liveness always emitted for both wallets |
| `GET /api/collect` | Cron secret | Periodic collection; successful slots deduplicated |
| `POST /api/refresh` | Cron secret | Collect immediately; bypasses slot dedupe, never the lease |
| `GET /api/collect?force=1` | Cron secret | CLI/cron equivalent of manual refresh |

Collection authentication uses `Authorization: Bearer <CRON_SECRET>` and rejects missing, incorrect or malformed credentials. Reading needs no authentication. Responses retain `Cache-Control: private, no-store` to avoid serving cached freshness indicators; that cache policy does not restrict access. Read endpoints use the read-only database URL and never call Esplora, RPC or the collector. A database failure returns 503; a stored stale snapshot stays readable and visibly stale.

## What is measured

- Both BIP84 chains are gap-scanned every collection (minimum 6, gap 20, ceiling 50, per wallet). The six supplied mainnet vectors and descriptor checksums are validated before collection.
- Inventory comes only from each used address's Esplora `/utxo` response. Confirmed P2WPKH/P2TR outputs **above** 546 sats are spendable. Outputs at or below 546 are stranded, including unconfirmed dust. Larger unconfirmed outputs are separate. Mempool-spent outputs are already absent in Esplora.
- Failed inventory scans never publish partial balances. Tip movement restarts inventory once. A discovery ceiling produces a lower-bound flag and suppresses runway. A provider restart never merges inventory across providers.
- Naive days = `spendable / (median observed settlement drain × settlements per day)`. Drain includes **commit fees + all reveal fees + newly stranded wallet outputs**. Deposits, consolidations and unrelated spends do not enter the sample. Cost uses the larger available 7-/30-day median; cadence uses the plan's running-max median inter-commit intervals and larger eligible 7-/30-day cadence.
- No measured cost, fee rate or cadence is hardcoded. Fewer than 30 complete settlements, incomplete history, missing cadence or incomplete discovery produce `null` with a reason. A fully discovered zero-spendable wallet reports zero days without needing fee history. Replay reports empirical error percentiles; there are no calibrated confidence guarantees or alert thresholds.
- The first run may hit its history budget. It still stores inventory and traversal progress. Later collections resume paging and reveal linking until the 30-day window is covered. Live collection and offline replay share scan orchestration and the pure snapshot computation.
- Once the collector holds its lease, it attempts free mempool recommendation and projected-block requests concurrently, each with a five-second timeout. Failures are independent and informational. Quotes, optional pressure snapshots and compact issued forecasts live in the existing 90-day run records; old snapshots remain readable.

Mainnet selects the private Alpen Esplora using `ALPEN_ESPLORA_TOKEN`, with Blockstream and mempool as public failovers. Put the raw token in the local `.env` for local collection and in Vercel's Sensitive Production variables for cloud collection; see the [deployment runbook](docs/deployment.md). A public-primary configuration is allowed only for Stage 0 and is explicitly labelled in text, JSON and metrics. Alchemy is optional **RPC-only** (`src/chain/rpc.ts`); it is never a wallet data source and is not needed for this release.

## Time machine

```sh
pnpm replay fetch --network mainnet --archive .local/replay/mainnet
pnpm replay run --archive .local/replay/mainnet --out .local/replay/audit-mainnet
# Capture new finalized blocks/deposits and rebuild the same report.
pnpm replay refresh --network mainnet --archive .local/replay/mainnet --out .local/replay/audit-mainnet
pnpm replay report --out .local/replay/audit-mainnet
```

Open `.local/replay/audit-mainnet/report.html` in a current browser. Fetch uses authenticated Alpen, respects request pacing, resumes interrupted work and extends completed archives to a newer finalized block. Refresh combines fetch, replay and report generation; earlier seals remain reproducible by digest. The report opens at the latest captured balance and displays funding amounts. It is a saved audit, updated by the CLI; the live collector continues its existing 15-minute schedule. Run and report are offline and need no database credentials. Defaults are both wallets, the latest 90 days after a 30-day warm-up, and every block. All local evidence is ignored by Git.

The first real archive contains 1,266 transactions and 17,340 block headers in **19.8 MB**. A full 25,906-snapshot audit occupies about **92 MB**, including the portable HTML report. See the [command guide, methodology, limitations and measured findings](docs/time-machine.md).

## Seasonal fee experiment

`pnpm fees fetch`, `pnpm fees observe` and `pnpm fees run --observations .local/fees/observations.json` build `.local/fees/study/report.html`: four-year daily/weekly seasonality, recent fee levels, optional projected-block pressure, and walk-forward 1/3/5/7-day p50/p90 evaluation. Attach it with `pnpm replay report --out .local/replay/audit-mainnet --fees-study .local/fees/study/study.json`.

This forecasts a network block-median fee benchmark. EE sizes and operational runway remain separate; initial p90 coverage is below 90%. See [options, commands, methodology and measured results](docs/seasonal-fees.md).

The [runway estimator improvement brief](docs/brief/runway-estimator-evolution.md) defines the next priorities, operator experience and acceptance criteria.

## Verification and deployment

Production follows release tags (`vMAJOR.MINOR.PATCH`), each matching `package.json`'s version. Pushing a tag runs validation, database migrations and deployment to the existing Vercel project. Pushing or merging `main` does not deploy. Complete the one-time [GitHub release setup](docs/deployment.md#3-release-tags-and-deployment) before pushing the first tag.

`pnpm check` runs strict type checking, config/vector validation, lint, import-boundary checks and focused tests. SQL tests run in embedded Postgres (PGlite) without credentials; CI also runs them against Postgres 17 through transaction-mode PgBouncer. `pnpm inspect --resume` performs a real read-only scan, preserving progress under gitignored `.local/inspection`; it never touches the database. `node --env-file-if-exists=.env --import tsx scripts/provider-conformance.ts` independently cross-checks `/utxo` totals against aggregate arithmetic offline, using the saved inspection address set. Aggregate arithmetic never enters the collector. `pnpm collect --force` uses the production collector and configured write database.

[Deployment runbook](docs/deployment.md) covers Vercel, Neon, secrets, migrations, role grants, smoke checks and cron verification. [Release verification](docs/release-verification.md) records what was actually tested. [Open questions](docs/open-questions.md) separates current setup blockers from later plan gates.


The unreleased [fee observation and evaluation hardening](docs/seasonal-fees.md#observation-and-evaluation-hardening-local-iteration) adds durable provider/block observations, frozen held-out plans (`pnpm fees freeze`), training-only pressure comparisons (`pnpm fees tune`), calibration diagnostics and historical fee snapshots in replay. Wallet runway remains unchanged; migration/deployment is a separate release step.
