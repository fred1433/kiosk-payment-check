// HTTP surface, independent of where it runs. supabase/functions/kiosk-checkout/index.ts wires
// it to Deno.serve; tests call it with a Request directly.
//
//   POST /checkout      kiosk -> start (or join) a checkout; returns the checkout id
//   GET  /checkout/:id  kiosk and staff screens poll this; the facts, not a single status
//   POST /webhooks/bank provider -> signed event
//   POST /worker/tick   scheduler -> run operations for up to `budgetMs`
//
// Supabase limits to keep in mind (supabase.com/docs/guides/functions/limits, read 28 Sep 2026):
// 2 s CPU per request excluding async I/O, 150 s request idle timeout, 150 s (Free) or 400 s
// (paid) worker wall clock. The tick is I/O bound and stops well before those.

import type { Sql } from "../db.ts";
import type { Clock } from "../clock.ts";
import type { BankAdapter, PosAdapter } from "../adapters/types.ts";
import { ingestBankWebhook, reconciliation, startCheckout } from "../service.ts";
import { runOnce } from "../worker.ts";

export interface HandlerDeps {
  sql: Sql;
  clock: Clock;
  bank: BankAdapter;
  pos: PosAdapter;
  webhookSecret: string;
  signatureHeader: string; // header name, to confirm with the provider
  /** Returns the shopper id from the platform's existing session, or null. */
  authenticateShopper: (req: Request) => Promise<string | null>;
  /** The disclosed fee, set on the server. A fee sent by the kiosk is ignored. */
  feeCents: number;
  /** Shared secret for the scheduler calling /worker/tick. */
  tickSecret: string;
  budgetMs?: number;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export function makeHandler(d: HandlerDeps) {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/kiosk-checkout/, "");

    if (req.method === "POST" && path === "/checkout") {
      const shopperId = await d.authenticateShopper(req);
      if (!shopperId) return json(401, { error: "not_signed_in" });
      let b: Record<string, unknown>;
      try {
        b = await req.json();
      } catch {
        return json(400, { error: "invalid_json" });
      }
      const ok = typeof b.store_id === "string" && typeof b.kiosk_request_id === "string" &&
        typeof b.saved_ref_id === "string" &&
        Number.isInteger(b.quoted_total_cents) && Array.isArray(b.cart);
      if (!ok) return json(400, { error: "invalid_body" });
      const r = await startCheckout(d.sql, d.clock, {
        storeId: b.store_id as string,
        shopperId,
        kioskRequestId: b.kiosk_request_id as string,
        savedRefId: b.saved_ref_id as string,
        quotedTotalCents: b.quoted_total_cents as number,
        feeCents: d.feeCents,
        cart: b.cart as never,
      });
      if (!r.ok) return json(r.error === "reauthentication_required" ? 409 : 403, { error: r.error });
      return json(r.created ? 201 : 200, { checkout_id: r.checkoutId });
    }

    const m = path.match(/^\/checkout\/([0-9a-f-]{36})$/);
    if (req.method === "GET" && m) {
      const shopperId = await d.authenticateShopper(req);
      if (!shopperId) return json(401, { error: "not_signed_in" });
      const [own] = await d.sql.query(`select 1 from kiosk.checkouts where id = $1 and shopper_id = $2`, [
        m[1],
        shopperId,
      ]);
      if (!own) return json(404, { error: "not_found" });
      const rec = await reconciliation(d.sql, m[1]);
      return json(200, {
        outcome: rec.outcome,
        message: rec.outcome_reason,
        payment: { preauth: rec.preauth_state, capture: rec.capture_state },
        order: rec.order_state,
        register: rec.register_ack_state,
      });
    }

    if (req.method === "POST" && path === "/webhooks/bank") {
      const raw = await req.text();
      const r = await ingestBankWebhook(d.sql, d.clock, d.webhookSecret, {
        rawBody: raw,
        signatureHeader: req.headers.get(d.signatureHeader),
      });
      if (r === "rejected_signature") return json(401, { error: r });
      if (r === "rejected_body") return json(400, { error: r });
      // Not ours yet (for example a refund whose reference is still being written): ask the
      // provider to retry, and the reconciler reads the bank as well.
      if (r === "unknown_reference") return json(503, { error: "retry_later" });
      return json(200, { result: r }); // duplicates are acknowledged, not reprocessed
    }

    if (req.method === "POST" && path === "/worker/tick") {
      if (req.headers.get("authorization") !== `Bearer ${d.tickSecret}`) {
        return json(401, { error: "unauthorized" });
      }
      const deadline = Date.now() + (d.budgetMs ?? 20_000);
      let ran = 0;
      while (
        Date.now() < deadline &&
        await runOnce({
          sql: d.sql,
          bank: d.bank,
          pos: d.pos,
          clock: d.clock,
          workerId: `edge-${crypto.randomUUID().slice(0, 8)}`,
          leaseSeconds: 60,
        })
      ) ran++;
      return json(200, { ran });
    }

    return json(404, { error: "no_route" });
  };
}
