-- Independent research refresh lease: never competes with the wallet collector.
CREATE TABLE fee_research (
  network text PRIMARY KEY REFERENCES network_stamp(network),
  holder uuid, expires_at timestamptz NOT NULL DEFAULT '-infinity',
  last_attempt_at timestamptz, updated_at timestamptz, last_error text,
  archive jsonb, study jsonb
);

-- Preserve daily observations after the collector's rolling retention expires.
CREATE TABLE time_machine_samples (
  network text NOT NULL,
  wallet text NOT NULL,
  day date NOT NULL,
  snapshot jsonb NOT NULL,
  PRIMARY KEY(network,wallet,day),
  FOREIGN KEY(network,wallet) REFERENCES wallets(network,wallet)
);
