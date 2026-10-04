# Public Signet setup and verification

The operator supplied the EE and OL Sparrow descriptors and `https://esplora.testnet-prod.alpenlabs.io` on October 2, 2026. The descriptors are preserved exactly, including their checksums and key origins. The indexer accepts unauthenticated requests.

Both that indexer and `https://mempool.space/signet/api` returned block 1 hash `00000086d6b2636cb2a392d45edc4ec544a10024d30141c9adf4bfd9de533b53`. This nonzero checkpoint binds collection to public Signet. All fee observations use `https://mempool.space/signet/api`.

## Address evidence

Each address below was observed as a confirmed transaction output through both indexers, then checked against the supplied descriptor. The listed indexes are relative to the exported tpub.

| Wallet | Chain/index | Address | Confirmed transaction/output |
| --- | --- | --- | --- |
| EE | Receive `0/1` | `tb1qw537f77nwg534ehmfs8ef4prdnmseyxlrtmq9g` | `ebaff41455c9f84bde07b1d14c2b98984c28acc254990fdbb80b14e7f2642acc:0` |
| EE | Change `1/0` | `tb1qqmtf56q4sjl3t998f8g2qna4kg23n2p4w3yash` | `3359f270f397cd3df22dddf0c41dcad3612d1c62dba92f8ec2c0a26b38f47957:0` |
| OL | Receive `0/2` | `tb1qry2955px37rgpaceg6zf4r5nh6ga4988xg95zq` | `24b7eaf68f4909d20bba0d5bdfb6afe4e6d2b76da3688ce0856df66c523052dc:1` |
| OL | Change `1/0` | `tb1qejnzftnjlksyspaysj6lxfu7c2x22uz50shvqu` | `33bbfe5758ac4587ac04fdfd183d8612e4bb32f6434fd129a86458d2b0fa5047:0` |

## Sparrow key origins

Both tpubs have serialized BIP32 depth 6 and origin paths `84h/1h/0h`. This is supported: [BIP380 key origins](https://github.com/bitcoin/bips/blob/master/bip-0380.mediawiki#key-expressions) identify the key where derivation starts, which can be an intermediate key. Absolute tpub depth need not equal the origin path length. The parser accepts depths 3–253, while retaining network, purpose, account child-number, checksum and point validation. It preserves the supplied origin; it does not prepend guessed path elements or rewrite the tpub.

A synthetic test constructs this depth-6/intermediate-origin case and signs/finalizes the exported PSBT using the supplied origin fingerprint and relative path. No real private keys are used. Actual Sparrow signing remains the operator's responsibility.

## Infrastructure

- Vercel: `alpen-labs / ee-ol-wallet-monitor-signet`, project ID `prj_EPWqMEFELlKu5ahoT79ZBwe7U4a9`.
- Neon resource: `ee-ol-wallet-monitor-signet`, created through Vercel's existing integration, free plan, `iad1`, PostgreSQL 18.
- Migrations 1 and 2 applied to the new database and stamped `signet` with exactly two wallets. Runtime connections use pooled, verified TLS and ordinary collector/read-only roles. Owner credentials remain local.
- Production variables: `NETWORK=signet`, independent `DATABASE_URL`, `DATABASE_URL_METRICS` and `CRON_SECRET`. No preview fixture mode or provider token.
- Both pages use purple testnet styling. The standard 15-minute Vercel cron remains configured.

## Initial live reads and remaining limit

OL completed a real read at block 324662 on October 2: 199,148,863 spendable sats and 34,398 stranded sats across 64 outputs. History was still incomplete; runway was correctly unavailable. These are dated observations, not fixed configuration values.

EE discovery covered 82 addresses without hitting its scan ceiling, but inventory failed at receive index `0/7`, address `tb1qg9vum54p4ccmn6j7sksce6j4cyxazga0m9gr9x`. Alpen returned HTTP 400: `Too many unspent transaction outputs (>500). Contact support to raise limits.` The public mempool Signet fallback also returned a UTXO-limit error. No partial EE balance was stored. A later complete collection succeeded through mempool for both wallets, but subsequent scheduled runs hit the same limit again. Reliable EE refreshes remain blocked until Alpen's per-address UTXO limit is raised (10,000 was requested). Failed attempts never overwrite the last successful snapshot.

Validation before deployment: all 142 tests passed, including actual descriptor/vector checks, relative-origin PSBT signing, and network isolation. Mainnet and synthetic Signet HTTP smoke suites exercise the same route handlers. Production deployment `dpl_SbjTa2nCsRztb41WX2crqLL17mrD` is ready at https://ee-ol-wallet-monitor-signet.vercel.app/. The Vercel build ran on Node 24 and passed type/config validation. Eight live HTTP checks passed: both pages, shared CSS, JSON/text status and metrics return 200; unauthenticated collection and refresh return 401. The response network is `signet`, with no preview/sample mode.

The Vercel protection settings remain unchanged at `all_except_custom_domains`. An attempted switch to Standard Protection was rejected by automatic approval review and was not executed. Verification showed the existing settings already allow the canonical production alias, while the generated deployment URL redirects to Vercel authentication. No protection bypass or disabled authentication was used.

The first stored run, `1c3834e6-b33d-4caa-a92d-81e83313abe0`, completed successfully for both wallets through mempool at block 324666. EE: 399,637,805 spendable sats and 174,174 stranded sats (319 stranded outputs). OL: 199,148,863 spendable sats and 34,398 stranded sats (63 stranded outputs). Both scans were complete; settlement history was still backfilling, so both runway estimates remained null with `history_incomplete`. Fee evidence was stored durably.

Live unsigned consolidation downloads were decoded and verified for both wallets at 1 sat/vB: EE used 319 inputs, a 21,816-sat fee and a 152,358-sat output; OL used 63 inputs, a 4,342-sat fee and a 30,056-sat output. Both destinations match the change vectors above, and the PSBTs preserve the supplied fingerprints and Signet derivation paths. No real transaction was signed or broadcast.

Vercel reports cron enabled on this deployment with `/api/collect` scheduled `*/15 * * * *`. Two scheduled executions were observed: `6c7d3592-481e-44ad-8289-1aecda972e12` at 16:30 UTC and `ddfe3ec2-0fee-44f3-938c-bc49d7d6c6dd` at 16:45 UTC on October 2. Both completed with `partial_failure`: EE returned `E_PROVIDER_UTXO_LIMIT`, while OL refreshed successfully through Alpen and completed its history backfill, making its runway available. EE continues to show its last successful snapshot, with its timestamp and the usual freshness gating. This verifies scheduling and cloud connectivity, but not reliable EE collection. Mainnet's project linkage, deployment and database were not changed.

## Local EE export

On October 2 at 21:08 Asia/Nicosia (18:08 UTC), a database-free local capture completed directly against Alpen. It used paginated confirmed history instead of `/utxo`, inspecting receive/change indexes 0–49 and confirming 20 unused addresses at each range's end. All 100 addresses' funded/spent counts and sums reconciled. Capture used 418 requests paced at no more than two per second; it invoked no Vercel functions and made no Neon queries or writes.

The capture contains 2,240 unique transactions, 2,228 historical EE outputs and 324 confirmed unspent outputs totaling 399,807,277 sats at block 324676. Of these, 320 dust outputs total 174,720 sats; four larger outputs total 399,632,557 sats. No mempool entries were observed. The previously proposed 10,000 limit was not an observed UTXO count. In particular, receive index 7 has 1,007 historical outputs, all spent, despite its `/utxo` endpoint returning the limit error.

The local export is `.local/exports/ee-signet-export-2026-10-02.zip`, with JSON/JSONL data, coverage/provenance, checksums and a freshly verified unsigned PSBT. At 1 sat/vB the 320-input draft pays 21,884 sats in fees and returns 152,836 sats to EE change index 0. Every input was checked live, then decoded and checked for amount, outpoint, fingerprint and derivation path. No signing, broadcasting or deployment occurred. Raw page evidence remains in `.local/exports/signet-ee-2026-10-02/evidence`. See the README for the local export commands and confirmed-history limitations.

## Neon import and compact collector state

The operator subsequently authorized importing the local work into Neon. The import validated the source digest and Signet wallet identities, acquired the ordinary collector lease, and refreshed EE locally using 142 provider requests. Run `1108b66a-0a9c-4183-befd-033ede63e90c` stored the result atomically on October 2 at 21:26 Asia/Nicosia (18:26 UTC). The fresh snapshot is at block 324677: 399,632,557 spendable sats, 174,720 stranded sats, 324 outputs including 320 dust outputs. Its 355 settlement samples cover the configured window completely, so the existing naive runway formula now reports about 25,762 days. OL's state was structurally compared before and after and remained unchanged by this import.

The database retains transaction inputs/outputs and explicit witness item counts needed for classification; full witness payloads stay in the local archive. EE's history is 3,551,874 bytes as JSON and 1,829,846 bytes in Postgres, down from the prior 33,619,457-byte stored history. Import provenance is recorded in `runs.results`, with a local pre-import snapshot and verification record retained alongside the export.

Deployment `dpl_3M1ymjz8pQ6Q9ay5Sr2bg82iYwMP` adds compact history storage and a guarded response to provider UTXO caps. The collector may reuse an address's prior exact inventory from the same provider only if confirmed counts are unchanged, both mempool counts are zero, and the previous block hash remains canonical. New activity or a changed block fails closed; raising the provider limit remains advisable for addresses that become active again. This does not derive inventory from aggregate balance arithmetic. Mainnet's deployment was not changed.

All 148 tests and both HTTP smoke suites passed before deployment. A subsequent database persistence test verified witness compaction and cached inventory retrieval. The live API returned a fresh EE snapshot with complete history, and browser verification showed the updated balance, 320-output consolidation quote and available runway. The imported state and local refresh are verified; a scheduled run of this new deployment had not yet completed at this check.
