# bridge-wallet-monitor v2

A watch-only Bitcoin wallet monitor for Alpen EE and OL. This first release implements the user's settled steps 1–2: correct Esplora inventory, an explicitly **naive** runway estimate, authenticated text/JSON and Prometheus output, a 15-minute collector, manual refresh, and Vercel deployment configuration.

`PLAN.md` remains the authoritative detailed specification. The user's release scope narrows it: selector simulation, quantile confidence bounds, Grafana alerting, upstream drift monitoring and historical replay are deferred. This is Stage 0 observation, not the plan's M-1 alert milestone. See [scope and decisions](docs/decisions.md).

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

Fill **independent**, random, at least 32-character `CRON_SECRET` and `METRICS_BEARER_TOKENS` values in `.env`. Generate each privately with `openssl rand -hex 32`. Open `http://localhost:3000`, enter the read token, and use the separate refresh token to collect. Token values are not persisted by the page. Never put tokens in URLs or paste them into issues/chat.

Docker's trust authentication is strictly for this disposable, loopback-bound development setup. Production requires separate authenticated TLS database connections and least-privilege roles.

`pnpm smoke` launches the actual `pnpm dev` command on an ephemeral loopback port and checks HTTP routing, authentication, role separation and missing-storage responses. It generates temporary tokens in memory and deliberately disconnects storage; collection-to-read persistence is covered by `pnpm test test/collect-integration.test.ts`.

## Endpoints

| Endpoint | Authentication | Effect |
|---|---|---|
| `GET /api/status` | Metrics bearer token | Latest stored JSON with timestamps and stale flags |
| `GET /api/status?format=text` | Metrics bearer token | Human-readable inventory and naive runway |
| `GET /api/metrics` | Metrics bearer token | Prometheus text; liveness always emitted for both wallets |
| `GET /api/collect` | Cron secret | Periodic collection; successful slots deduplicated |
| `POST /api/refresh` | Cron secret | Collect immediately; bypasses slot dedupe, never the lease |
| `GET /api/collect?force=1` | Cron secret | CLI/cron equivalent of manual refresh |

Authentication uses the `Authorization: Bearer …` header. Read tokens cannot collect. `METRICS_BEARER_TOKENS` supports up to two comma-separated tokens for rotation. Missing/malformed credentials fail closed. Responses have `Cache-Control: private, no-store`. Read endpoints use the read-only database URL and never call Esplora, RPC or the collector. A database failure returns 503; a stored stale snapshot stays readable and visibly stale.

## What is measured

- Both BIP84 chains are gap-scanned every collection (minimum 6, gap 20, ceiling 50, per wallet). The six supplied mainnet vectors and descriptor checksums are validated before collection.
- Inventory comes only from each used address's Esplora `/utxo` response. Confirmed P2WPKH/P2TR outputs **above** 546 sats are spendable. Outputs at or below 546 are stranded, including unconfirmed dust. Larger unconfirmed outputs are separate. Mempool-spent outputs are already absent in Esplora.
- Failed inventory scans never publish partial balances. Tip movement restarts inventory once. A discovery ceiling produces a lower-bound flag and suppresses runway. A provider restart never merges inventory across providers.
- Naive days = `spendable / (median observed settlement drain × settlements per day)`. Drain includes **commit fees + all reveal fees + newly stranded wallet outputs**. Deposits, consolidations and unrelated spends do not enter the sample. Cost uses the larger available 7-/30-day median; cadence uses the plan's running-max median inter-commit intervals and larger eligible 7-/30-day cadence.
- No measured cost, fee rate or cadence is hardcoded. Fewer than 30 complete settlements, incomplete history, missing cadence or incomplete discovery produce `null` with a reason. A fully discovered zero-spendable wallet reports zero days without needing fee history. There are no p90 claims or alert thresholds in this release.
- The first run may hit its history budget. It still stores inventory and traversal progress. Later collections resume paging and reveal linking until the 30-day window is covered. A pure snapshot function receives time and inputs explicitly; a `ChainView` boundary supports future historical replay.

The public-primary configuration is allowed only for Stage 0. It is explicitly labelled in text, JSON and metrics. Switch to the internal Esplora before relying on this operationally. Alchemy is optional **RPC-only** (`src/chain/rpc.ts`); it is never a wallet data source and is not needed for this release.

## Verification and deployment

`pnpm check` runs strict type checking, config/vector validation, lint, import-boundary checks and focused tests. SQL tests run in embedded Postgres (PGlite) without credentials; CI also runs them against Postgres 17 through transaction-mode PgBouncer. `pnpm inspect --resume` performs a real read-only scan, preserving progress under gitignored `.local/inspection`; it never touches the database. `node --env-file-if-exists=.env --import tsx scripts/provider-conformance.ts` independently cross-checks `/utxo` totals against aggregate arithmetic offline, using the saved inspection address set. Aggregate arithmetic never enters the collector. `pnpm collect --force` uses the production collector and configured write database.

[Deployment runbook](docs/deployment.md) covers Vercel, Neon, secrets, migrations, role grants, smoke checks and cron verification. [Release verification](docs/release-verification.md) records what was actually tested. [Open questions](docs/open-questions.md) separates current setup blockers from later plan gates.
