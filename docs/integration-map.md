# Integration map

What this slice is, and what it would take to fit it into an existing TypeScript / Supabase
monorepo with its own POS adapter framework and OpenAPI contracts. Estimates are provisional until
the real repository has been read.

## What is in the slice

| Piece | File | Replaces nothing; plugs into |
|---|---|---|
| Schema and SQL functions | `supabase/migrations/20260928120000_kiosk_checkout.sql` | Your migrations folder, own `kiosk` schema |
| Workflow as a pure function | `src/workflow.ts` | Domain package |
| Durable worker | `src/worker.ts` | A scheduled job calling `/worker/tick` |
| Webhook verification and ingestion | `src/webhook_signature.ts`, `src/service.ts` | Edge Function route |
| HTTP handler | `src/http/handler.ts`, `supabase/functions/kiosk-checkout/index.ts` | Your Edge Function conventions |
| POS port and Cova-shaped simulator | `src/adapters/types.ts`, `src/adapters/cova_sim.ts` | Your POS adapter framework |
| Bank port and simulator | `src/adapters/bank_sim.ts` | A real provider adapter, once a route is chosen |
| Failure bench and naive baseline | `bench/`, `src/naive.ts`, `tests/` | Deno tests and database tests in CI |

## Interfaces to reconcile with your code

- `PosAdapter` (`submitOrder`, `getStatus`, `applyPayment`, `cancelOrder`) against your existing
  adapter interface. The one addition that matters is `applyPayment`: the register must learn the
  order is paid.
- `BankAdapter` (`preauthorize`, `capture`, `voidPreauth`, `refund`, `getPayment`) against the
  chosen provider's API, including `capabilities.idempotencyKeys`.
- `POST /checkout` and `GET /checkout/:id` against your OpenAPI contracts and kiosk client.
- `authenticateShopper` against your Supabase Auth session handling (the `/auth/v1/user` call in
  `index.ts` is to verify against your setup).
- Cart and total: the kiosk quote versus the register's sale total, and where your adapters
  already compute tax.

## Order of operations, compared

Run by `bench/orderings.ts` against the same simulated faults (results on the page).

| Order | Helps with | Introduces |
|---|---|---|
| A. Debit, then create the order | Starts payment early | Money taken with no order when the register rejects it or stays unknown; a refund, and a possible later return on top |
| B. Confirm the order, then debit | Never charges for an order that does not exist | An unpaid order holding inventory when the debit fails; cancellation can be refused (Dutchie: allocated inventory) |
| C. Preauthorize, confirm order and total, then capture (chosen) | Charges the register's final total, never more than approved; no money moves until the order exists | Needs a provider with preauthorization and capture; leaves a window where money moved but the register does not yet show it paid. That window is surfaced to staff, never marked complete |

C is chosen under two assumptions to confirm: the provider supports preauthorization and capture of
an amount at most the preauthorized one, and the register accepts a payment record (Cova does,
publicly).

## Review checkpoints

1. Schema and SQL functions (transaction boundaries, constraints, roles).
2. Workflow decisions, one operation kind at a time, with the bench sequences that cover each.
3. Adapter mapping for the chosen POS, against its real sandbox.
4. Provider adapter and webhook scheme, against the chosen provider's sandbox.
5. Staff screen wording for every `needs_staff` reason.

Expected technical-lead involvement: a kickoff on the repository, then one review per checkpoint.

## Not in this slice

Kiosk and staff screens; partial and multiple refunds; recovery flows for a revoked or failed bank
connection beyond "reconnect"; returns collection policy (a business decision); any production
adapter; deployment of the Edge Function; load testing.
