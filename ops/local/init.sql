-- Local disposable database only. Docker binds ports to loopback; production uses TLS/passwords.
CREATE ROLE monitor_app LOGIN;
CREATE ROLE monitor_read LOGIN;
ALTER ROLE monitor_read SET default_transaction_read_only = on;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO monitor_app, monitor_read;
ALTER DEFAULT PRIVILEGES FOR ROLE monitor_owner IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO monitor_app;
ALTER DEFAULT PRIVILEGES FOR ROLE monitor_owner IN SCHEMA public GRANT USAGE,SELECT ON SEQUENCES TO monitor_app;
ALTER DEFAULT PRIVILEGES FOR ROLE monitor_owner IN SCHEMA public GRANT SELECT ON TABLES TO monitor_read;
