# Changelog

## 2.0.0 — initial steps 1–2 implementation

- Bootstrap strict TypeScript/Vercel/Postgres application, migrations, CI and deployment workflow.
- Validate and derive EE/OL watch-only descriptors; gap-scan both chains and measure exact UTXO partitions.
- Add resumable settlement sampling and explicitly naive runway from observed commit/reveal drain and median cadence.
- Add authenticated JSON, text and metrics, manual refresh, periodic collection, fenced leases and stale-read reporting.
- Preserve configurable network/Signet and pure replay boundaries. Full simulation, confidence bounds, alerts and historical replay remain deferred.

Deployment is pending the access and database setup listed in the release verification record.
