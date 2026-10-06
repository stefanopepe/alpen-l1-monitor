-- Run as the schema-owning migrator AFTER migrations. Create login roles and set their
-- passwords privately in the database console first. No credentials belong in this file.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO monitor_app, monitor_read;
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO monitor_app;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO monitor_app;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO monitor_read;
ALTER ROLE monitor_read SET default_transaction_read_only = on;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO monitor_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE,SELECT ON SEQUENCES TO monitor_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO monitor_read;
-- Apply a database-specific REVOKE CONNECT FROM PUBLIC, then grant CONNECT only
-- to these two roles and the migrator. Substitute the actual database identifier.
-- Fee evidence is append-only for the runtime; only the schema owner may manage it.
REVOKE UPDATE,DELETE ON fee_observations FROM monitor_app;

-- Daily time-machine evidence is immutable to the runtime once copied.
REVOKE UPDATE,DELETE ON time_machine_samples FROM monitor_app;
