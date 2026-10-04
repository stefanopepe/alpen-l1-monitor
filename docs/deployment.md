# Deploy the wallet monitor to Vercel

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

The existing project is **alpen-labs / ee-ol-wallet-monitor**. Manage it through the Vercel dashboard; CLI sign-in is optional. For CLI deployment, authenticate (`pnpm exec vercel login`) and link this directory to that exact project (`pnpm exec vercel link`). Use framework **Other**, Node **24.x**, Fluid compute enabled, region **iad1**. The repository builds network-labelled pages from `public` into output directory `dist`, with 800-second collect/refresh limits and a 15-minute cron. Remove any Vercel dashboard output-directory override still set to `public`. Hobby cannot meet these settings; use the existing paid team. No team plan purchase is automated.

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

## 3. Release tags and deployment

Production releases use **Git tags** in `vMAJOR.MINOR.PATCH` format, matching `package.json`'s version. Pushing a tag triggers `.github/workflows/deploy.yml`: it checks out that exact tag, validates the version and deployment configuration, runs `pnpm check` and `pnpm smoke`, deploys schema-compatible code to the existing production project, then applies additive database migrations and runtime role permissions. This ordering is required for 2.1.0: the previous collector rejects schema 2, while the new collector supports schemas 1 and 2. Vercel deployment metadata records `releaseTag` and `releaseCommit`. A GitHub Release page is optional; the tag push is the trigger.

Git automatic deployment is disabled in `vercel.json`, so merging or pushing `main` does not change production. This follows [Vercel's tag deployment approach](https://vercel.com/kb/guide/can-you-deploy-based-on-tags-releases-on-vercel).

### One-time GitHub configuration

Open the **GitHub repository → Settings → Environments**, and create or open **`production-mainnet`**. Add the following items **inside that GitHub environment**:

| Kind | Name | Exact source |
|---|---|---|
| Environment secret | `VERCEL_TOKEN` | Create a token on the [Vercel account Tokens page](https://vercel.com/account/tokens), named `wallet-monitor-github`. Scope it to `alpen-labs` / `ee-ol-wallet-monitor` if project scope is offered, otherwise the `alpen-labs` team. Copy the raw token here. |
| Environment secret | `MIGRATION_DATABASE_URL` | Copy the value of `MIGRATION_DATABASE_URL` from this checkout's local `.env`, without the surrounding quotes. This is the existing Neon **direct/unpooled schema-owner** URL. Set its `sslmode` parameter to `verify-full`. |
| Environment variable | `VERCEL_ORG_ID` | **Vercel → alpen-labs team → Settings → General → Team ID**. Copy the `team_…` ID, not the team name. |
| Environment variable | `VERCEL_PROJECT_ID` | **Vercel → ee-ol-wallet-monitor project → Settings → General → Project ID**. Copy the `prj_…` ID, not the project name. |

These four entries configure GitHub's deployment job. The application's existing database, Esplora and cron variables stay in **Vercel Production** as listed above. No Vercel installation or sign-in on the developer's Mac is required. The workflow uses the pinned CLI on GitHub's runner. See [Vercel's token instructions](https://vercel.com/kb/guide/how-do-i-use-a-vercel-api-access-token).

### Publish a version

The first tagged release is `v2.1.0`. After the GitHub environment is configured and the release commit is on `main`, run from the repository:

```sh
git switch main
git pull --ff-only origin main
git tag -a v2.1.0 -m "Release v2.1.0"
git push origin v2.1.0
```

For subsequent releases, bump `package.json`'s version and update the changelog, commit and push those changes to `main`, then create and push a new matching tag. Never move an existing release tag. An ordinary commit alone does not publish a release.

Follow **GitHub → Actions → Deploy mainnet release**; the run title identifies the version. After it succeeds, verify the production domain using the checks below. If setup was missing on the first attempt, add the missing entries and rerun the failed job.

For a deliberate redeployment or rollback, use **Actions → Deploy mainnet release → Run workflow**, keep the workflow branch on **main**, and enter the existing tag in the required `tag` field. The workflow checks out that tag's code. Rollbacks require compatibility with already-applied additive migrations. Older commits without the updated workflow cannot initiate tag deployments themselves; manual dispatch uses the workflow from `main`.

### Dashboard fallback

If a manual dashboard deployment is necessary, open **Vercel → Deployments → ⋯ → Create Deployment** and select the exact release commit for Production. Verify the displayed source commit matches the tag. Redeploying an older deployment rebuilds that older source; it does not pick up a new main-branch commit. See the [Vercel dashboard deployment flow](https://vercel.com/changelog/manually-create-deployments-by-commit-or-branch-in-the-dashboard).

The repository is currently public. Keep credentials, private exports and `.local` artifacts out of Git and deployment uploads. The October 2 release preflight verified GitHub API/HTTPS access; smart-card SSH signing was unavailable. GitHub's `production-mainnet` environment was not yet configured, so the first release can use authenticated Vercel CLI deployment to the same existing project:

```sh
pnpm exec vercel link --yes --project ee-ol-wallet-monitor --scope alpen-labs
pnpm exec vercel deploy --prod --yes --meta releaseTag=v2.1.0 --meta "releaseCommit=$(git rev-parse HEAD)"
pnpm migrate --init-network mainnet --apply-roles
```

Run these from the tested release commit, with private local credentials available. Apply migration 2 only after deployment succeeds. This fallback does not configure future GitHub tag deployments. A failed tag workflow must remain visible until the environment is configured and a deployment succeeds.

## 4. Verify the production domain

1. Visit `/`; status should load automatically without a token. Before collection both wallets should be `STALE / UNAVAILABLE`; this is expected.
2. Verify unauthenticated `/api/status` and `/api/metrics` return 200 when storage is available. Unauthenticated `GET /api/collect` and `POST /api/refresh` must still return 401. A wrong bearer token or a query parameter must not authorize collection.
3. Open **Operator controls** and use **Collect now** with the cron token. It can take several minutes on public providers. A second concurrent refresh must return a skipped result rather than start a competing scan.
4. Load text and JSON. Check **both** wallets, `asOf`, tip height/hash, provider, ceiling flags and the exact balance partition. Compare live inventory to an independent Esplora `/utxo` reading at the same stable tip. Never use a historical number from the brief as a current balance.
5. First-run naive runway may be `null` with `history_incomplete`. Allow subsequent cron runs (or manual refreshes) to finish bounded history and reveal linking. Never lower the sample floor or invent cadence to make a number appear.
6. Inspect Vercel Cron Jobs and the database `runs` table after at least two scheduled executions, roughly 15 minutes apart. Verify both wallets' timestamps advance. A manual trigger alone does not prove scheduling.
7. For a stale-read drill in **staging**, withhold collection and confirm `stale=true` after 3300 seconds while prior balances retain their old `asOf`. External notifications/Grafana are not configured by this scoped release.

Every environment variable change requires a new deployment. Never log authorization headers, request URLs containing credentials, database errors or raw provider error bodies.

## Separate testnet deployment

The testnet target in the brief is **Signet**. Both pages use the same implementation as mainnet. `NETWORK=signet` builds a purple theme and a persistent **Testnet · Signet / Test coins only** banner, including when the status API is unavailable. Home links stay on the deployment's own origin. Quotes and PSBT download filenames identify their network. The collector and consolidation endpoint use that profile's fee API; they never fall back to mainnet fees when a testnet fee source is absent.

`config/networks/signet.json` contains the operator-supplied Sparrow EE/OL descriptors and a nonzero public Signet checkpoint cross-checked through Alpen and mempool.space. Receive/change vectors were observed in confirmed outputs through both providers. The deployed sequencer build remains explicitly unconfirmed. See [Signet verification](signet-verification.md) for evidence and the EE indexer limit.

To inspect the finished interface with the existing synthetic wallets, without a database or provider requests:

```sh
NETWORK=signet STAGING_PREVIEW=demo pnpm dev
# Or build the same static pages used on Vercel:
NETWORK=signet STAGING_PREVIEW=demo pnpm build
```

Demo data is visibly labelled and collection is disabled. This is a UI preview, not a live testnet release.

Do not copy the mainnet xpubs into a signet profile. Obtain the actual EE/OL signet descriptors with BIP84 coin type 1 and tpub versions, plus at least one receive and one change address per wallet from an independent source. Obtain the correct Esplora base URL and a **nonzero height/hash checkpoint** for the specific public or custom signet. All signets share genesis, so genesis alone is insufficient.

Create `config/networks/signet.json` from the example with `network: signet`, HRP `tb`, public/private BIP32 versions `043587cf`/`04358394`, coin type 1 and the supplied data. Add the Signet build assumption to `config/upstream-manifest.json` (identical to the profile's `upstream` object). For public Signet, the example uses `https://mempool.space/signet/api` for Esplora and `fee_api_base_url`. For a custom Signet, replace both sources with the correct network's endpoints; set `fee_api_base_url: null` if no mempool-compatible fee service exists. Collection continues with unavailable fee context in that case; live consolidation requires a fee quote. Mainnet's existing implicit fee source is preserved. Run `NETWORK=signet pnpm check`.

The separate Vercel project is **alpen-labs / ee-ol-wallet-monitor-signet**, with a dedicated Neon resource of the same name provisioned through Vercel's existing integration in `iad1` on the free plan. Neon provisioned Postgres 18; migrations and pooled TLS role checks passed on that actual version. Production uses `NETWORK=signet`, its own collector/read-only URLs and a fresh cron secret. `STAGING_PREVIEW` is unset. The mainnet project and database remain separate.

Neon-managed owner credentials were retrieved privately for initialization. The automatic integration connection was then removed so those owner credentials are not part of the app's runtime environment; the Neon resource still exists and is managed from the team's Vercel Storage area. `DATABASE_URL` and `DATABASE_URL_METRICS` use the ordinary `monitor_app` and `monitor_read` roles. The direct owner URL stays only in the ignored, mode-600 `.env.testnet` file for migrations.

For local live testnet work, use a separate ignored environment file so the mainnet `.env` is not loaded:

```sh
cp -n .env.testnet.example .env.testnet
# Fill testnet-only connection strings and tokens privately, then:
node --env-file=.env.testnet --import tsx scripts/migrate.ts --init-network signet --apply-roles
node --env-file=.env.testnet --import tsx scripts/dev.ts
```

Create GitHub environment **production-signet**, containing its own `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`, `VERCEL_TOKEN` and `MIGRATION_DATABASE_URL` with the same variable/secret types as `production-mainnet`. Never reuse the mainnet project ID or database. Manually dispatch **Deploy monitor release** with the matching release tag and `network: signet`. Tag pushes still deploy mainnet only; Signet releases are explicit and have a separate concurrency group. The workflow passes the chosen `NETWORK` to both the build and runtime. Confirm the project uses the repository's `dist` output directory.

Before release, repeat the endpoint, descriptor/address, PSBT and cron checks on the testnet URL. Verify the banner says Testnet, JSON and metrics say `signet`, destination addresses begin `tb1`, downloads contain `-signet-`, and the main-app link stays on the testnet domain. Record the deployment and collection results in [Signet verification](signet-verification.md).

## Operations and rollback

Version **2.1.0** adds the local [time machine](time-machine.md) and continuous fee observations. Release it through the existing matching-tag workflow. It adds migration 2 for durable fee observations and needs no new application credential or scheduler. Keep `ALPEN_ESPLORA_TOKEN` configured; mempool's recommendation endpoint is public and free. After deployment, inspect a newly completed run for `results.schemaVersion = 1`, `feeContext`, and compact wallet forecasts. Confirm both wallets still collect if the quote is unavailable, and that JSON/text reads show the quote's observation time and freshness. Old array-shaped run records and snapshots without fee context remain supported. Do not upload `.local/replay` artifacts to Vercel; replay/report are local tools. See [release verification](release-verification.md) for the deployed release status.

- Inspect `runs`, `provider_errors`, `wallet_state` and snapshot timestamps. A failed wallet does not erase its last good data or stop the other wallet.
- Inventory writes, daily samples and saved history are one fenced transaction; HTTP fetching never runs inside a database transaction.
- Collection maintenance rolls up old snapshot counts/extrema before deleting raw rows in the same transaction. Latest state survives retention. Daily inventories are kept for future replay evidence.
- Roll back by redeploying a prior tag with compatible additive migrations. Never drop tables or rewrite migration checksums to force a rollback. Wallet replacement requires an explicit migration/re-registration procedure; startup refuses silent identity changes.

Relevant platform contracts: [Vercel Node functions](https://vercel.com/docs/functions/runtimes/node-js), [Vercel cron management](https://vercel.com/docs/cron-jobs/manage-cron-jobs), [Esplora API](https://github.com/Blockstream/esplora/blob/master/API.md).


## Durable fee evidence — 2.1.0

Release 2.1.0 includes `0002_fee_observations.sql`. After deploying the schema-compatible collector, run `pnpm migrate --init-network mainnet --apply-roles` to apply migration 2 and `ops/roles.sql`, then verify `feeContext.persistence = durable`, independent pressure/completed-block timestamps and a successful durable export. Do not roll back to 2.0.0 after migration 2: its startup check rejects schema 2. Use a schema-2-compatible fix or release instead. The 2.1.0 runtime remains compatible with schema 1; missing storage is labelled unavailable while inventory/runway continue. The new evidence table has no automatic run-retention cleanup. Back up/export it and review storage growth. Refer to the [operating procedure](seasonal-fees.md#observation-and-evaluation-hardening-local-iteration) for frozen evaluations.
