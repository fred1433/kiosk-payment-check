# kiosk-payment-check

A work sample: the part of a kiosk bank-payment integration that runs after the happy path.
TypeScript for Supabase (Postgres functions and a Deno Edge Function), with a bench that replays
failures against simulated bank and POS services and a naive baseline the bench catches.

**Simulated payment and POS services. No live payments. No real provider or POS API is called.**
The POS simulator is shaped on Cova's public Sales Order documentation; it is a contract-shaped
simulator, not a certified integration. The tests verify this module against the stated simulated
contracts. They do not certify provider behavior or prevent independent cashier actions.

## Run the tests on a clean clone

Requires [Deno](https://deno.com) 2.x. Nothing else: the default run uses PGlite, Postgres 17 in
WebAssembly, in-process.

```sh
deno task test        # unit tests, the failure bench, the HTTP handler
deno task bench       # same bench, writes site/data/bench.json (measures per sequence)
```

Concurrency, restart recovery, lease fencing and database roles need a real Postgres server:

```sh
./scripts/test-postgres.sh                      # throwaway local server (needs initdb/pg_ctl);
                                                # it also reruns the bench, rewriting site/data/bench*.json
# or, against any server where you can create databases, e.g. `supabase start`:
psql "$DATABASE_URL" -f scripts/supabase-roles.sql   # only on a plain server
DATABASE_URL=postgres://... deno task test:pg
```

What ran where for the published results: see "Where it ran" on the page, or
`site/data/bench.json` and `site/data/bench.postgres.json`.

## Deploying the Edge Function (not done here)

Set `KIOSK_DB_URL` to a server-side connection for a role with EXECUTE on the kiosk functions
(`service_role` in Supabase; the functions are SECURITY DEFINER, and browser roles get nothing),
`KIOSK_FEE_CENTS` for the disclosed fee (never taken from the kiosk request), `BANK_WEBHOOK_SECRET`,
`KIOSK_TICK_SECRET`. Without `KIOSK_SIMULATION=1` it refuses to start: there is no real adapter.

## Layout

```
supabase/migrations/   schema, SQL functions (claim, finish, bank events, staff actions), reconciliation view
supabase/functions/    Edge Function entry (serves the simulators only, refuses to start otherwise)
src/workflow.ts        every decision as one pure function
src/worker.ts          claim -> call outside any transaction -> record with the claim token
src/service.ts         checkout, webhooks, reconciler reading the bank (captures for 60 days, refunds), refunds, handoff
src/adapters/          ports, Cova-shaped POS simulator, bank simulator
src/naive.ts           the naive baseline
bench/                 the failure families, the order-of-operations comparison, the page's timeline
docs/                  feasibility note (dated, sourced), integration map
site/                  the static page (build: deno task site; served by site/worker.js, wrangler.toml)
```

## The design in five lines

1. Payment, money movements, POS order, register acknowledgment and goods handoff are separate facts.
2. Every provider call is an operation row whose key is created once and resent on every retry.
3. Transactions are short; no transaction is open during a provider call.
4. An unknown outcome is never treated as a failure: read status first, retry with the same key,
   then stop and tell a person.
5. Money movements are append-only facts keyed by provider reference, so duplicate and reordered
   webhooks do not change the totals.

I built and tested this work sample. I have not built a production ACH system. It demonstrates the
failure-handling approach, not a production payment track record.
