#!/bin/sh
set -eu
: "${REPOLEAD_APP_PASSWORD:?Set the application role password}"
: "${REPOLEAD_WORKER_PASSWORD:?Set the worker role password}"
# psql reads secrets from the environment; passwords never become command arguments.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
\getenv app_password REPOLEAD_APP_PASSWORD
\getenv worker_password REPOLEAD_WORKER_PASSWORD
SELECT format('CREATE ROLE repolead_app LOGIN PASSWORD %L', :'app_password') \gexec
SELECT format('CREATE ROLE repolead_worker LOGIN PASSWORD %L', :'worker_password') \gexec
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
SQL
