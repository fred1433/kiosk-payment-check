#!/usr/bin/env bash
# Starts a throwaway Postgres server, runs the server-only tests and the bench against it,
# then stops it. Needs initdb/pg_ctl on PATH (or PG_BIN=/path/to/bin). Uses port 54329.
# Alternative: point DATABASE_URL at `supabase start`'s database and run `deno task test:pg`.
set -euo pipefail
PG_BIN="${PG_BIN:-$(dirname "$(command -v pg_ctl)")}"
PORT="${PORT:-54329}"
DIR="$(mktemp -d)"
cleanup() { "$PG_BIN/pg_ctl" -D "$DIR/data" -m fast stop >/dev/null 2>&1 || true; rm -rf "${DIR:?}"; }
trap cleanup EXIT
"$PG_BIN/initdb" -D "$DIR/data" -U postgres --auth=trust -E UTF8 >/dev/null
"$PG_BIN/pg_ctl" -D "$DIR/data" -l "$DIR/log" -w \
  -o "-p $PORT -k '' -c listen_addresses=127.0.0.1 -c max_connections=300 -c lc_messages=C" start >/dev/null
"$PG_BIN/psql" -h 127.0.0.1 -p "$PORT" -U postgres -q -f "$(dirname "$0")/supabase-roles.sql"
export DATABASE_URL="postgres://postgres@127.0.0.1:$PORT/postgres"
"$PG_BIN/postgres" --version
deno task test:pg
deno task bench
