CREATE TABLE network_stamp (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  network text NOT NULL UNIQUE
);
CREATE TABLE settings (
  network text PRIMARY KEY REFERENCES network_stamp(network),
  stale_after_s integer NOT NULL CHECK (stale_after_s > 0),
  primary_is_public boolean NOT NULL
);
CREATE TABLE wallets (
  network text NOT NULL REFERENCES network_stamp(network), wallet text NOT NULL,
  display_name text NOT NULL, key_identity text NOT NULL, descriptor_checksum text NOT NULL,
  PRIMARY KEY (network, wallet)
);
CREATE TABLE run_lease (
  network text PRIMARY KEY REFERENCES network_stamp(network), holder uuid,
  fence bigint NOT NULL DEFAULT 0, expires_at timestamptz NOT NULL DEFAULT '-infinity',
  last_completed_slot bigint NOT NULL DEFAULT -1
);
CREATE TABLE runs (
  run_id uuid PRIMARY KEY, network text NOT NULL REFERENCES network_stamp(network),
  started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
  status text NOT NULL, results jsonb NOT NULL DEFAULT '[]'
);
CREATE TABLE snapshots (
  network text NOT NULL, wallet text NOT NULL, run_id uuid NOT NULL REFERENCES runs(run_id),
  scan_started_at timestamptz NOT NULL, data jsonb NOT NULL,
  balance_sats bigint GENERATED ALWAYS AS ((data->'composition'->>'balanceSats')::bigint) STORED NOT NULL,
  spendable_sats bigint GENERATED ALWAYS AS ((data->'composition'->>'spendableSats')::bigint) STORED NOT NULL,
  stranded_sats bigint GENERATED ALWAYS AS ((data->'composition'->>'strandedSats')::bigint) STORED NOT NULL,
  unconfirmed_gt_dust_sats bigint GENERATED ALWAYS AS ((data->'composition'->>'unconfirmedGtDustSats')::bigint) STORED NOT NULL,
  unsupported_gt_dust_sats bigint GENERATED ALWAYS AS ((data->'composition'->>'unsupportedGtDustSats')::bigint) STORED NOT NULL,
  largest_utxo_sats bigint GENERATED ALWAYS AS ((data->'composition'->>'largestUtxoSats')::bigint) STORED NOT NULL,
  PRIMARY KEY (network, wallet, run_id), FOREIGN KEY (network, wallet) REFERENCES wallets(network, wallet),
  CHECK (data->>'network' = network AND data->>'wallet' = wallet),
  CHECK (balance_sats = spendable_sats + stranded_sats + unconfirmed_gt_dust_sats + unsupported_gt_dust_sats),
  CHECK (spendable_sats >= 0 AND stranded_sats >= 0 AND unconfirmed_gt_dust_sats >= 0 AND unsupported_gt_dust_sats >= 0),
  CHECK (largest_utxo_sats BETWEEN 0 AND spendable_sats)
);
CREATE INDEX snapshots_latest ON snapshots(network, wallet, scan_started_at DESC);
CREATE TABLE wallet_state (
  network text NOT NULL, wallet text NOT NULL, addresses jsonb NOT NULL, history jsonb NOT NULL,
  latest_snapshot jsonb NOT NULL, utxos jsonb NOT NULL,
  PRIMARY KEY (network, wallet), FOREIGN KEY (network, wallet) REFERENCES wallets(network, wallet),
  CHECK (latest_snapshot->>'network' = network AND latest_snapshot->>'wallet' = wallet)
);
CREATE TABLE daily_samples (
  network text NOT NULL, wallet text NOT NULL, day date NOT NULL, snapshot jsonb NOT NULL, utxos jsonb NOT NULL,
  PRIMARY KEY (network, wallet, day), FOREIGN KEY (network, wallet) REFERENCES wallets(network, wallet)
);
CREATE TABLE daily_rollup (
  network text NOT NULL, wallet text NOT NULL, day date NOT NULL,
  samples bigint NOT NULL, spendable_min bigint NOT NULL, spendable_max bigint NOT NULL,
  last_as_of timestamptz NOT NULL,
  PRIMARY KEY (network, wallet, day), FOREIGN KEY (network, wallet) REFERENCES wallets(network, wallet)
);
CREATE TABLE provider_errors (
  network text NOT NULL REFERENCES network_stamp(network), provider text NOT NULL,
  total bigint NOT NULL DEFAULT 0, last_kind text,
  PRIMARY KEY (network, provider)
);
