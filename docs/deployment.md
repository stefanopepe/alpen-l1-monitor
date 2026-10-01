# Deploy steps 1–2 to Vercel

The production app is `https://ee-ol-wallet-monitor.vercel.app/`, in the `alpen-labs` Vercel team, backed by Neon. Local and Vercel collectors write to the same mainnet database. The steps below also document how to reproduce the setup.

## Headless operation

`vercel.json` schedules `GET /api/collect` every 15 minutes (`*/15 * * * *`). Vercel supplies `Authorization: Bearer <CRON_SECRET>` from its Production environment. Collection runs with the browser closed and the developer's computer off. View the job and execution logs under the project's **Settings → Cron Jobs**.

For a separate scheduler on a host with this checkout, run `pnpm collect` from the repository directory with Node/pnpm available on the scheduler's PATH. It reads that host's local `.env`, writes directly to the configured `DATABASE_URL`, prints a JSON result and exits nonzero if collection fails. `pnpm collect --force` is a manual override of successful-slot deduplication; both commands still respect the shared database lease. Vercel already provides the recurring scheduler, so a second local cron is unnecessary.

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

The existing project is **alpen-labs / ee-ol-wallet-monitor**. Manage it through the Vercel dashboard; CLI sign-in is optional. For CLI deployment, authenticate (`pnpm exec vercel login`) and link this directory to that exact project (`pnpm exec vercel link`). Use framework **Other**, Node **24.x**, Fluid compute enabled, region **iad1**. The repository sets output directory `public`, 800-second collect/refresh limits and a 15-minute cron. Hobby cannot meet these settings; use the existing paid team. No team plan purchase is automated.

Add these **Production** environment variables through the Vercel dashboard or its interactive `env add` prompt:

| Variable | Value/source |
|---|---|
| `NETWORK` | `mainnet` |
| `DATABASE_URL` | Neon pooled TLS URL for `monitor_app` |
| `DATABASE_URL_METRICS` | Neon pooled TLS URL for `monitor_read` |
| `CRON_SECRET` | Fresh random token, at least 32 characters, no whitespace/commas |
| `ALPEN_ESPLORA_TOKEN` | Private Alpen Esplora token, raw value only (no `?token=` prefix) |

Mark secret variables Sensitive. Generate tokens locally with `openssl rand -hex 32` and enter them directly into Vercel; do not paste them into chat. Do not configure `MIGRATION_DATABASE_URL` in Vercel. Preview deployments get no database URLs or cron secret. Preview routes therefore fail closed.

Production app routes must be reachable without Vercel's separate deployment-authentication wall: use **Standard** protection (previews protected; production domain reachable). The dashboard and read APIs are public by the user's explicit choice. Collection still requires `CRON_SECRET`; database and Esplora authentication remain server-side. The old `METRICS_BEARER_TOKENS` variable is unused after deploying the public-read update and can then be removed. Do not remove `DATABASE_URL_METRICS`: it remains the read-only database connection.

The mainnet configuration selects the private Alpen Esplora at `https://esplora.himalayan-java-8qh3wg.alpen.org` as primary; its API paths start at the root, without `/api`. It uses `auth.scheme: query`, `parameter_name: token`, and `secret_env: ALPEN_ESPLORA_TOKEN`. The client URL-encodes the token for each outgoing request, rejects redirects, and returns sanitized errors. Keep the token out of the configured `base_url`, logs and saved reports. Bearer and custom-header authentication are also supported. Blockstream and mempool remain public failovers, each paced at one request per second; the private primary is initially paced at four requests per second.

For this provider switch, put `ALPEN_ESPLORA_TOKEN` in **both** the local ignored `.env` (local collection) and **Vercel → Project → Settings → Environment Variables → Production**, marked Sensitive (cloud collection). Adding it in one place does not update the other. Deploy the updated code/configuration, then rerun `pnpm migrate --init-network mainnet` using the local direct migrator URL to synchronize the stored provider metadata. The migration command preserves wallet data and validates existing migration checksums. Verify a cloud run reports provider `alpen`; local connectivity alone does not establish Vercel connectivity.

Alchemy may be configured separately for RPC-only future uses; it cannot substitute for Esplora discovery/history/inventory.

## 3. Build and deploy

For dashboard deployment, select the project, open **Deployments → ⋯ → Create Deployment**, and choose the latest commit on **main**, with the Production branch/environment configuration. Verify the displayed source commit matches the intended update. Redeploying an older deployment rebuilds that older source; it does not pick up the new main-branch commit. This is the [Vercel dashboard deployment flow](https://vercel.com/changelog/manually-create-deployments-by-commit-or-branch-in-the-dashboard).

For CLI deployment:

```sh
pnpm install --frozen-lockfile
NETWORK=mainnet pnpm check
pnpm exec vercel deploy --prod
```

For the established release path, configure GitHub environment `production-mainnet` with secrets `MIGRATION_DATABASE_URL` and `VERCEL_TOKEN`, and variables `VERCEL_ORG_ID` / `VERCEL_PROJECT_ID`. The workflow in `.github/workflows/deploy.yml` validates, migrates and deploys a `v*` tag or a manual dispatch. Git automatic deployment is disabled in `vercel.json`, so an ordinary main-branch merge does not change production.

Keep the repository **private**: it contains watch-only descriptors and the supplied plan/brief. If it must become public, first externalise descriptor strings and remove private wallet details from documentation/history; do not simply change visibility. Smart-card SSH access to the GitHub remote works. The available CLI/connector API credentials cannot access it, so configure deployment secrets through the repository settings or use direct Vercel CLI deployment once Vercel and database access exist.

## 4. Verify the production domain

1. Visit `/`; status should load automatically without a token. Before collection both wallets should be `STALE / UNAVAILABLE`; this is expected.
2. Verify unauthenticated `/api/status` and `/api/metrics` return 200 when storage is available. Unauthenticated `GET /api/collect` and `POST /api/refresh` must still return 401. A wrong bearer token or a query parameter must not authorize collection.
3. Open **Operator controls** and use **Collect now** with the cron token. It can take several minutes on public providers. A second concurrent refresh must return a skipped result rather than start a competing scan.
4. Load text and JSON. Check **both** wallets, `asOf`, tip height/hash, provider, ceiling flags and the exact balance partition. Compare live inventory to an independent Esplora `/utxo` reading at the same stable tip. Never use a historical number from the brief as a current balance.
5. First-run naive runway may be `null` with `history_incomplete`. Allow subsequent cron runs (or manual refreshes) to finish bounded history and reveal linking. Never lower the sample floor or invent cadence to make a number appear.
6. Inspect Vercel Cron Jobs and the database `runs` table after at least two scheduled executions, roughly 15 minutes apart. Verify both wallets' timestamps advance. A manual trigger alone does not prove scheduling.
7. For a stale-read drill in **staging**, withhold collection and confirm `stale=true` after 3300 seconds while prior balances retain their old `asOf`. External notifications/Grafana are not configured by this scoped release.

Every environment variable change requires a new deployment. Never log authorization headers, request URLs containing credentials, database errors or raw provider error bodies.

## Config-only signet

Do not copy the mainnet xpubs into a signet profile. Obtain the actual EE/OL signet descriptors with BIP84 coin type 1 and tpub versions, plus at least one receive and one change address per wallet from an independent source. Obtain the correct Esplora base URL and a **nonzero height/hash checkpoint** for the specific public or custom signet. All signets share genesis, so genesis alone is insufficient.

Create `config/networks/signet.json` using the mainnet schema with `network: signet`, HRP `tb`, public/private BIP32 versions `043587cf`/`04358394`, coin type 1 and the supplied data. Add the signet build assumption to `config/upstream-manifest.json` (identical to the profile’s `upstream` object). Run `NETWORK=signet pnpm validate-config`. Create a separate Neon/Vercel project and run migrations with `--init-network signet`. No derivation or model code change is needed. Real signet deployment remains blocked on these external inputs.

## Operations and rollback

- Inspect `runs`, `provider_errors`, `wallet_state` and snapshot timestamps. A failed wallet does not erase its last good data or stop the other wallet.
- Inventory writes, daily samples and saved history are one fenced transaction; HTTP fetching never runs inside a database transaction.
- Collection maintenance rolls up old snapshot counts/extrema before deleting raw rows in the same transaction. Latest state survives retention. Daily inventories are kept for future replay evidence.
- Roll back by redeploying a prior tag with compatible additive migrations. Never drop tables or rewrite migration checksums to force a rollback. Wallet replacement requires an explicit migration/re-registration procedure; startup refuses silent identity changes.

Relevant platform contracts: [Vercel Node functions](https://vercel.com/docs/functions/runtimes/node-js), [Vercel cron management](https://vercel.com/docs/cron-jobs/manage-cron-jobs), [Esplora API](https://github.com/Blockstream/esplora/blob/master/API.md).
