# Changelog

## Unreleased — public reads and private Esplora

- Require an explicit stable version tag for production releases and manual workflow runs; validate it against the app version and record the tag/commit in Vercel deployment metadata.
- Make the dashboard and JSON/text/Prometheus reads public at the user's request. Load status on page open; place authenticated manual collection under Operator controls.
- Remove the obsolete metrics bearer requirement while preserving the read-only database role and cron/refresh authentication.
- Add environment-backed query-token authentication and select the supplied private Alpen Esplora as mainnet primary, with public failovers.

## 2.0.0 — initial steps 1–2 implementation

- Bootstrap strict TypeScript/Vercel/Postgres application, migrations, CI and deployment workflow.
- Validate and derive EE/OL watch-only descriptors; gap-scan both chains and measure exact UTXO partitions.
- Add resumable settlement sampling and explicitly naive runway from observed commit/reveal drain and median cadence.
- Add authenticated JSON, text and metrics, manual refresh, periodic collection, fenced leases and stale-read reporting.
- Preserve configurable network/Signet and pure replay boundaries. Full simulation, confidence bounds, alerts and historical replay remain deferred.

The original release is deployed. See the release verification record for the deployment status of subsequent changes.
