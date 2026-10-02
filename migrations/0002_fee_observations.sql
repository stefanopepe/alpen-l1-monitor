-- Append-only evidence. Deliberately no FK to runs and no run-retention cleanup.
CREATE TABLE fee_observations (
  network text NOT NULL REFERENCES network_stamp(network),
  run_id uuid NOT NULL,
  observed_at timestamptz NOT NULL,
  schema_version integer NOT NULL CHECK (schema_version = 1),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  data jsonb NOT NULL,
  PRIMARY KEY(network, run_id)
);
CREATE INDEX fee_observations_time ON fee_observations(network, observed_at);
