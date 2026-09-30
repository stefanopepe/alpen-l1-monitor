# Model limits and upstream assumptions

The model input is pinned to `alpenlabs/alpen@7f20dcb65fa478c9654626b77a05ea789d28806a`, with `selector_model_version=1` and `deployed_build_confirmed=false`. Version 1 reserves the plan's filter semantics; the selector loop is deliberately not part of steps 1–2.

PLAN.md records three upstream selection generations (M0/M1/M2), the M2 carry pass, reveal headroom and per-input-count pricing. None is inferred to be the production build. This release reports measured complete settlement drain, not simulated future selection. The naive estimate cannot account for fragmentation, future fee/payload/cadence changes, external spends, new top-ups or operator consolidation. It carries no five-day warning guarantee.

EE commits may have OP_RETURN at vout 0, P2TR at vout 1 and optional change. Reveals may have no OP_RETURN. Recognition uses scripts, ownership and outpoints rather than positions. The dust sweeps described at height 969093 are consolidations and are excluded from cost and cadence.

Watch-only descriptor addresses are presumed solvable/spendable by their owner; those wallet flags cannot be observed through Esplora. A wpkh descriptor cannot discover unrelated descriptors, imported keys or a separate P2TR account. Confirm wallet descriptor completeness before operational reliance (Q-21).

Confirmed spendable can temporarily fall when a mempool transaction spends the working UTXO; Esplora excludes that input before its unconfirmed change is spendable. This is the specified behaviour. A stable block tip is not a frozen mempool. We reject duplicate outpoints and mark scan start as the observation time, but cannot obtain an atomic mempool snapshot from address-by-address Esplora calls.

History samples are bounded and coverage-gated. Provider errors retain the last good snapshot. Shallow transaction statuses are rechecked; beyond-finality reorgs and changed frozen history are not fully audited by this reduced release. A replacement or reorg requiring a clean history rebuild can reset only the affected wallet history after investigation; never fabricate current balances. Full archive/reorg audit, fingerprint metrics, quantile confidence intervals and selector equivalence remain future plan work.
