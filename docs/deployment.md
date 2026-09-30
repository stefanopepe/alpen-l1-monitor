# Deploy steps 1–2 to Vercel

The repository is ready for a paid-team Vercel deployment. A local build is not a deployment. The current session has no authenticated Vercel project or production database URLs; see `release-verification.md` for the recorded status.

## 1. Database

Create a **separate Neon project** for mainnet in `aws-us-east-1` (Vercel `iad1`), preferably Postgres 17 to match the tested local/CI configuration. Use a separate project for staging and a separate one for any future signet network. Never share a stamp across networks.

Use a schema-owning migrator role with a **direct, unpooled TLS URL**. Create `monitor_app` and `monitor_read` as normal login roles and set their passwords privately in the database console; do not grant them Neon superuser privileges. Store URLs in a local ignored `.env` or a secret manager, never source code. Do not disable certificate verification.

```sh
# MIGRATION_DATABASE_URL must already be set privately.
pnpm migrate --init-network mainnet
```

The migration runner takes a session advisory lock on the direct connection, records SQL checksums, refuses edited applied migrations, checks the network stamp and refuses wallet key identity changes. It does not run from an HTTP request.

Apply `ops/roles.sql` as the migrator after migrations. Revoke `CONNECT` on the actual database from `PUBLIC` and grant it to the migrator, `monitor_app` and `monitor_read`. Use `monitor_app`'s **pooled** URL for collection and `monitor_read`'s **pooled** URL for reads. The read role has `default_transaction_read_only=on`; runtime transactions also explicitly request read-only mode.

## 2. Vercel project and secrets

Authenticate the CLI (`pnpm exec vercel login`) and link this directory to the intended paid team and project (`pnpm exec vercel link`). Suggested project name: `bridge-wallet-monitor-mainnet`. Select framework **Other**, Node **24.x**, Fluid compute enabled, region **iad1**. The repository sets output directory `public`, 800-second collect/refresh limits and a 15-minute cron. Hobby cannot meet these settings; use the existing paid team. No team plan purchase is automated.

Add these **Production** environment variables through the Vercel dashboard or its interactive `env add` prompt:

| Variable | Value/source |
|---|---|
| `NETWORK` | `mainnet` |
| `DATABASE_URL` | Neon pooled TLS URL for `monitor_app` |
| `DATABASE_URL_METRICS` | Neon pooled TLS URL for `monitor_read` |
| `CRON_SECRET` | Fresh random token, at least 32 characters, no whitespace/commas |
| `METRICS_BEARER_TOKENS` | Independent random read token; optional second token separated by a comma |

Mark secret variables Sensitive. Generate tokens locally with `openssl rand -hex 32` and enter them directly into Vercel; do not paste them into chat. Do not configure `MIGRATION_DATABASE_URL` in Vercel. Preview deployments get no database URLs or cron secret. Preview routes therefore fail closed.

Production app routes must be reachable without Vercel's separate deployment-authentication wall: use **Standard** protection (previews protected; production domain reachable). The app itself authenticates every data and collection route. Do not create query-string bypass credentials or remove app auth. Review any team setting that enforces protection for all deployments before switching it.

Public Esplora requires no credential. To add the internal indexer, insert it as the first provider (`role: primary`, `tier: internal`), change Blockstream to failover, and reference its auth environment variable via `secret_env`. `base_url` must contain no credentials, query string or trailing slash. The internal endpoint must be reachable from Vercel. Alchemy may be configured separately for RPC-only future uses; it cannot substitute for Esplora discovery/history/inventory.

## 3. Build and deploy

```sh
pnpm install --frozen-lockfile
NETWORK=mainnet pnpm check
pnpm exec vercel deploy --prod
```

For the established release path, configure GitHub environment `production-mainnet` with secrets `MIGRATION_DATABASE_URL` and `VERCEL_TOKEN`, and variables `VERCEL_ORG_ID` / `VERCEL_PROJECT_ID`. The workflow in `.github/workflows/deploy.yml` validates, migrates and deploys a `v*` tag or a manual dispatch. Git automatic deployment is disabled in `vercel.json`, so an ordinary main-branch merge does not change production.

Keep the repository **private**: it contains watch-only descriptors and the supplied plan/brief. If it must become public, first externalise descriptor strings and remove private wallet details from documentation/history; do not simply change visibility. The configured GitHub remote is not currently accessible to the available GitHub account/connector, so direct CLI deployment is the shortest path once Vercel and database access exist.

## 4. Verify the production domain

1. Visit `/` and load status using the read token. Before collection both wallets should be `STALE / UNAVAILABLE`; this is expected.
2. Verify unauthenticated `/api/status`, `/api/metrics` and `/api/collect` return 401. A read token must not trigger collection. A cron token must not read metrics.
3. Use **Refresh now** with the cron token. It can take several minutes on public providers. A second concurrent refresh must return a skipped result rather than start a competing scan.
4. Load text and JSON. Check **both** wallets, `asOf`, tip height/hash, provider, ceiling flags and the exact balance partition. Compare live inventory to an independent Esplora `/utxo` reading at the same stable tip. Never use a historical number from the brief as a current balance.
5. First-run naive runway may be `null` with `history_incomplete`. Allow subsequent cron runs (or manual refreshes) to finish bounded history and reveal linking. Never lower the sample floor or invent cadence to make a number appear.
6. Inspect Vercel Cron Jobs and the database `runs` table after at least two scheduled executions, roughly 15 minutes apart. Verify both wallets' timestamps advance. A manual trigger alone does not prove scheduling.
7. For a stale-read drill in **staging**, withhold collection and confirm `stale=true` after 3300 seconds while prior balances retain their old `asOf`. External notifications/Grafana are not configured by this scoped release.

Every environment variable change requires a new deployment. Rotate read tokens by temporarily accepting old/new tokens, update consumers, then remove the old token and redeploy. Never log authorization headers, request URLs containing RPC credentials, database errors or raw provider error bodies.

## Config-only signet

Do not copy the mainnet xpubs into a signet profile. Obtain the actual EE/OL signet descriptors with BIP84 coin type 1 and tpub versions, plus at least one receive and one change address per wallet from an independent source. Obtain the correct Esplora base URL and a **nonzero height/hash checkpoint** for the specific public or custom signet. All signets share genesis, so genesis alone is insufficient.

Create `config/networks/signet.json` using the mainnet schema with `network: signet`, HRP `tb`, public/private BIP32 versions `043587cf`/`04358394`, coin type 1 and the supplied data. Add the signet build assumption to `config/upstream-manifest.json` (identical to the profile’s `upstream` object). Run `NETWORK=signet pnpm validate-config`. Create a separate Neon/Vercel project and run migrations with `--init-network signet`. No derivation or model code change is needed. Real signet deployment remains blocked on these external inputs.

## Operations and rollback

- Inspect `runs`, `provider_errors`, `wallet_state` and snapshot timestamps. A failed wallet does not erase its last good data or stop the other wallet.
- Inventory writes, daily samples and saved history are one fenced transaction; HTTP fetching never runs inside a database transaction.
- Collection maintenance rolls up old snapshot counts/extrema before deleting raw rows in the same transaction. Latest state survives retention. Daily inventories are kept for future replay evidence.
- Roll back by redeploying a prior tag with compatible additive migrations. Never drop tables or rewrite migration checksums to force a rollback. Wallet replacement requires an explicit migration/re-registration procedure; startup refuses silent identity changes.

Relevant platform contracts: [Vercel Node functions](https://vercel.com/docs/functions/runtimes/node-js), [Vercel cron management](https://vercel.com/docs/cron-jobs/manage-cron-jobs), [Esplora API](https://github.com/Blockstream/esplora/blob/master/API.md).
