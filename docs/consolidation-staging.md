# Stranded output consolidation

Open **Operator controls → Consolidate stranded outputs** at the bottom of the app home. The feature lives at `/consolidation.html`; the home page continues to show the saved inventory and runway.

The dashboard shows a per-wallet consolidation switch, confirmed stranded output count and value, the fee rate in sat/vB, total transaction fee, and recovered spendable amount. The fee can be entered directly or adjusted with −/+ buttons in **0.1 sat/vB steps** (minimum 0.1). Changing it refreshes both amounts and invalidates the old download until a new quote is ready. **Download unsigned transaction** exports a PSBT at the selected rate; the monitor never signs or broadcasts it. The header links to the main application.

The transaction builder accepts only confirmed P2WPKH outputs of 1–546 sats whose addresses match the configured descriptor. It rejects duplicates and batches that cannot return a spendable output, limits a transaction to 1,000 inputs, and returns value to the same wallet's change address at `1/0`. Every input and the output include BIP32 derivations. The fee estimate reserves maximum signature size and includes CompactSize overhead. Transactions enable replacement by fee. The wallet must verify the file before signing.

Normal operation defaults to a fresh mempool.space economy quote rounded up to the next 0.1 sat/vB and checks the selected inventory through a checkpoint-verified Esplora provider. A manually selected fee is preserved in both quotes and downloads. Downloading repeats the input checks and rejects a mismatched quote. Inputs spent since the snapshot are excluded; missing or failed provider evidence stops the download. Inventory/runway accounting remains unchanged until the ordinary collector observes confirmed funds.

## Preview modes

- `STAGING_PREVIEW=demo`: synthetic testnet wallets, nonexistent input transactions and an explicitly labelled example fee. This mode does not read a database or fetch wallet data. PSBT filenames include `sample`; they cannot spend real funds. Collection endpoints return 403.
- `STAGING_PREVIEW=1`: an approved, dated inventory export from `config/staging-snapshot.json`, with live fee/input checks. Collection endpoints return 403. The optional export script uses the read-only role. Do not export real wallet inventory for deployment without explicit authorization.
- Unset: normal stored inventory and live consolidation checks. Existing production collection controls apply.

The October 2 [approved preview](https://ee-ol-wallet-monitor-8g1an1ksv-alpen-labs.vercel.app/) uses **demo mode**. No real wallet inventory was exported. It is a Vercel Preview deployment and retains the project's Vercel authentication requirement. The v2.2.0 production release uses the existing read-only database connection and live input checks; it does not bundle a staging export.

Validation: `pnpm check` covers types/config checks, lint, dependency boundaries and 134 tests. The HTTP smoke suite includes the dedicated consolidation page. Additional tests decode PSBTs at multiple selected rates, verify the exact fee and returned amount, and reject invalid increments or mismatched quotes. Browser checks verified the 1.1 and 0.1 sat/vB calculations and the lower step limit. The signing test uses synthetic keys only.
