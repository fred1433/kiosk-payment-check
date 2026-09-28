// Entry points used by the Edge Function and by the bench.

import { type Sql, sqlErrorCode } from "./db.ts";
import type { Clock } from "./clock.ts";
import type { BankAdapter, CartLine } from "./adapters/types.ts";
import { verifyWebhook } from "./webhook_signature.ts";
import { isLateNotice, returnDeadlines } from "./ach.ts";

export interface StartCheckout {
  storeId: string;
  shopperId: string;
  kioskRequestId: string;
  savedRefId: string;
  quotedTotalCents: number;
  feeCents: number;
  cart: CartLine[];
}

export type StartResult =
  | { ok: true; checkoutId: string; created: boolean }
  | {
    ok: false;
    error:
      | "saved_reference_not_usable"
      | "reauthentication_required"
      | "kiosk_request_id_reused_with_different_checkout";
  };

export async function startCheckout(sql: Sql, clock: Clock, req: StartCheckout): Promise<StartResult> {
  try {
    const [r] = await sql.query<{ checkout_id: string; created: boolean }>(
      `select * from kiosk.start_checkout($1, $2, $3, $4, $5, $6, $7::text::jsonb, $8)`,
      [
        req.storeId,
        req.shopperId,
        req.kioskRequestId,
        req.savedRefId,
        req.quotedTotalCents,
        req.feeCents,
        JSON.stringify(req.cart),
        clock.now().toISOString(),
      ],
    );
    return { ok: true, checkoutId: r.checkout_id, created: r.created };
  } catch (e) {
    const code = sqlErrorCode(e);
    if (
      code === "saved_reference_not_usable" || code === "reauthentication_required" ||
      code === "kiosk_request_id_reused_with_different_checkout"
    ) {
      return { ok: false, error: code };
    }
    // Two identical taps racing on a real server: the loser of the unique index retries once.
    if (/duplicate key|unique/i.test(String(e))) return startCheckout(sql, clock, req);
    throw e;
  }
}

export interface IncomingWebhook {
  rawBody: string;
  signatureHeader: string | null;
}

export type WebhookResult =
  | "rejected_signature"
  | "rejected_body"
  | "recorded"
  | "already_known"
  | "duplicate_event"
  | "unknown_reference"
  | "consent_revoked";

export async function ingestBankWebhook(
  sql: Sql,
  clock: Clock,
  secret: string,
  w: IncomingWebhook,
): Promise<WebhookResult> {
  const check = await verifyWebhook(
    secret,
    w.rawBody,
    w.signatureHeader,
    Math.floor(clock.now().getTime() / 1000),
  );
  if (check !== "ok") return "rejected_signature";
  let e: {
    id: string;
    type: string;
    ref: string;
    amountCents: number;
    returnCode?: string;
    effectiveDate: string;
  };
  try {
    e = JSON.parse(w.rawBody);
    if (!e.id || !e.type || !e.ref || !/^\d{4}-\d{2}-\d{2}$/.test(e.effectiveDate)) return "rejected_body";
  } catch {
    return "rejected_body";
  }
  const [r] = await sql.query<{ r: WebhookResult }>(
    `select kiosk.record_bank_event($1, $2, $3, $4, $5, $6::text::date, 'webhook', $7) as r`,
    [e.id, e.type, e.ref, e.amountCents, e.returnCode ?? null, e.effectiveDate, clock.now().toISOString()],
  );
  if (r.r === "recorded" && e.type === "payment.returned" && e.returnCode) {
    await flagLateReturn(sql, clock, e.ref, e.returnCode);
  }
  return r.r;
}

/** A return that reaches us after the bank's deadline for its code is kept and flagged for review. */
async function flagLateReturn(sql: Sql, clock: Clock, captureRef: string, code: string) {
  const [m] = await sql.query<{ checkout_id: string; settled_on: string }>(
    `select checkout_id, effective_date::text as settled_on from kiosk.money_movements where kind = 'settlement' and provider_ref = $1`,
    [captureRef],
  );
  if (!m) return;
  const received = clock.now().toISOString().slice(0, 10);
  if (isLateNotice(code, m.settled_on, received)) {
    await sql.query(`select kiosk.log($1, 'webhook', 'return_after_bank_deadline', $2::text::jsonb, $3)`, [
      m.checkout_id,
      JSON.stringify({
        code,
        settled_on: m.settled_on,
        received_on: received,
        deadlines: returnDeadlines(m.settled_on),
      }),
      clock.now().toISOString(),
    ]);
  }
}

/**
 * Reconciliation for missing webhooks: ask the provider about every accepted capture that has
 * no settlement or return recorded yet. Same unique keys as webhooks, so a late webhook after a
 * poll inserts nothing.
 */
export async function pollUnsettledCaptures(sql: Sql, clock: Clock, bank: BankAdapter): Promise<number> {
  const rows = await sql.query<{ capture_ref: string }>(
    `select b.capture_ref from kiosk.bank_payments b
      where b.capture_state = 'accepted'
        and not exists (select 1 from kiosk.money_movements m where m.provider_ref = b.capture_ref and m.kind in ('settlement','return'))`,
  );
  let recorded = 0;
  for (const { capture_ref } of rows) {
    const r = await bank.getPayment(capture_ref);
    if (r.kind !== "ok") continue;
    const v = r.value;
    const now = clock.now().toISOString();
    if (v.status === "settled" || (v.status === "returned" && v.settledOn)) {
      await sql.query(
        `select kiosk.record_bank_event(null, 'payment.settled', $1, $2, null, $3::text::date, 'poll', $4)`,
        [capture_ref, v.amountCents, v.settledOn, now],
      );
      recorded++;
    }
    if (v.status === "returned") {
      await sql.query(
        `select kiosk.record_bank_event(null, 'payment.returned', $1, $2, $3, $4::text::date, 'poll', $5)`,
        [capture_ref, v.amountCents, v.returnCode, v.returnedOn, now],
      );
      recorded++;
    }
  }
  return recorded;
}

export async function requestRefund(
  sql: Sql,
  clock: Clock,
  checkoutId: string,
  amountCents: number,
  reason: string,
  staff: string,
) {
  try {
    const [r] = await sql.query<{ created: boolean }>(
      `select kiosk.request_refund($1, $2, $3, $4, $5) as created`,
      [checkoutId, amountCents, reason, staff, clock.now().toISOString()],
    );
    return { ok: true as const, created: r.created };
  } catch (e) {
    return { ok: false as const, error: sqlErrorCode(e) };
  }
}

export async function recordHandoff(
  sql: Sql,
  clock: Clock,
  checkoutId: string,
  staff: string,
  overrideReason: string | null,
) {
  try {
    await sql.query(`select kiosk.record_handoff($1, $2, $3, $4)`, [
      checkoutId,
      staff,
      overrideReason,
      clock.now().toISOString(),
    ]);
    return { ok: true as const };
  } catch (e) {
    return { ok: false as const, error: sqlErrorCode(e) };
  }
}

export interface ReconRow {
  checkout_id: string;
  outcome: string;
  outcome_reason: string | null;
  preauth_state: string;
  capture_state: string;
  capture_amount_cents: number | null;
  order_state: string;
  sale_total_cents: number | null;
  register_ack_state: string;
  goods_released: boolean;
  goods_returned: boolean;
  settled_cents: number;
  refunded_cents: number;
  returned_cents: number;
  net_cash_cents: number;
  expected_net_cents: number;
  exposure_cents: number;
  held_for_shopper_cents: number;
  open_investigations: number;
}

export async function reconciliation(sql: Sql, checkoutId: string): Promise<ReconRow> {
  const [r] = await sql.query<ReconRow>(`select * from kiosk.reconciliation where checkout_id = $1`, [
    checkoutId,
  ]);
  for (
    const k of [
      "settled_cents",
      "refunded_cents",
      "returned_cents",
      "net_cash_cents",
      "expected_net_cents",
      "exposure_cents",
      "held_for_shopper_cents",
      "open_investigations",
    ] as const
  ) {
    (r as unknown as Record<string, number>)[k] = Number(r[k]);
  }
  return r;
}

export async function events(sql: Sql, checkoutId: string) {
  return await sql.query<{ source: string; type: string; detail: Record<string, unknown>; at: string }>(
    `select source, type, detail, at from kiosk.events where checkout_id = $1 order by id`,
    [checkoutId],
  );
}
