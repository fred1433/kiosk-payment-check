// Durable execution: claim (short transaction) -> call provider (no transaction open) ->
// record the result with the claim token -> the next operation is already committed with it.
// A worker that dies after the provider accepted leaves a claimed row; when the lease expires
// another worker claims the SAME row and sends the SAME operation_key.

import { type Sql, sqlErrorCode } from "./db.ts";
import type { Clock } from "./clock.ts";
import type { BankAdapter, Call, CartLine, PosAdapter } from "./adapters/types.ts";
import { decide, type Decision, mustNotRepeat, type OperationRow, type Snapshot } from "./workflow.ts";

export interface WorkerDeps {
  sql: Sql;
  bank: BankAdapter;
  pos: PosAdapter;
  clock: Clock;
  workerId: string;
  leaseSeconds?: number;
  /** test hook: runs after the provider call and before the result is recorded */
  afterCall?: (op: OperationRow, call: Call<unknown>) => void;
}

export class WorkerCrash extends Error {}

export async function loadSnapshot(sql: Sql, checkoutId: string): Promise<Snapshot> {
  const [r] = await sql.query<Record<string, unknown>>(
    `select c.id, c.created_at, c.quoted_total_cents, c.fee_cents, c.cart, s.provider_consent_ref,
            b.preauth_state, b.preauth_ref, b.preauth_amount_cents, b.capture_state, b.capture_ref, b.capture_amount_cents,
            p.pos_order_id, p.order_state, p.sale_total_cents, a.ack_state
       from kiosk.checkouts c
       join kiosk.saved_bank_refs s on s.id = c.saved_ref_id
       join kiosk.bank_payments b on b.checkout_id = c.id
       join kiosk.pos_orders p on p.checkout_id = c.id
       join kiosk.register_acks a on a.checkout_id = c.id
      where c.id = $1`,
    [checkoutId],
  );
  return {
    checkoutId: r.id as string,
    createdAt: new Date(r.created_at as string),
    quotedTotalCents: r.quoted_total_cents as number,
    feeCents: r.fee_cents as number,
    cart: (typeof r.cart === "string" ? JSON.parse(r.cart) : r.cart) as CartLine[],
    consentRef: r.provider_consent_ref as string,
    preauthState: r.preauth_state as string,
    preauthRef: r.preauth_ref as string | null,
    preauthAmountCents: r.preauth_amount_cents as number | null,
    captureState: r.capture_state as string,
    captureRef: r.capture_ref as string | null,
    captureAmountCents: r.capture_amount_cents as number | null,
    posOrderId: r.pos_order_id as string,
    orderState: r.order_state as string,
    saleTotalCents: r.sale_total_cents as number | null,
    ackState: r.ack_state as string,
    posIdempotentSubmit: true,
  };
}

function perform(op: OperationRow, s: Snapshot, d: WorkerDeps): Promise<Call<unknown>> {
  const key = op.operation_key;
  switch (op.kind) {
    case "bank_preauthorize":
      return d.bank.preauthorize({
        operationKey: key,
        consentRef: op.input.consent_ref as string,
        amountCents: op.input.amount_cents as number,
      });
    case "pos_submit_order":
      return d.pos.submitOrder({
        posOrderId: s.posOrderId,
        lines: s.cart,
        reference: `Kiosk ${s.checkoutId.slice(0, 8)}`,
      });
    case "pos_check_order":
    case "pos_check_payment":
      return d.pos.getStatus(s.posOrderId);
    case "bank_capture":
      return d.bank.capture({
        operationKey: key,
        preauthRef: op.input.preauth_ref as string,
        amountCents: op.input.amount_cents as number,
      });
    case "pos_apply_payment":
      return d.pos.applyPayment({
        posOrderId: s.posOrderId,
        amountCents: op.input.amount_cents as number,
        paymentRef: op.input.payment_ref as string,
      });
    case "pos_cancel_order":
      return d.pos.cancelOrder(s.posOrderId);
    case "bank_void_preauth":
      return s.preauthRef
        ? d.bank.voidPreauth({ operationKey: key, preauthRef: s.preauthRef })
        : Promise.resolve({ kind: "ok", value: {} });
    case "bank_refund":
      return d.bank.refund({
        operationKey: key,
        paymentRef: op.input.capture_ref as string,
        amountCents: op.input.amount_cents as number,
      });
  }
}

/** Claims and runs one operation. Returns false when nothing is runnable. */
export async function runOnce(d: WorkerDeps): Promise<boolean> {
  const now = d.clock.now();
  const [op] = await d.sql.query<OperationRow>(
    `select * from kiosk.claim_next_operation($1, $2, $3)`,
    [d.workerId, d.leaseSeconds ?? 60, now.toISOString()],
  );
  if (!op) return false;
  op.input = typeof op.input === "string" ? JSON.parse(op.input) : op.input;
  const snap = await loadSnapshot(d.sql, op.checkout_id);

  snap.posIdempotentSubmit = d.pos.capabilities.idempotentSubmitById;

  let decision: Decision;
  if (op.kind === "pos_submit_order" && op.attempts > 1 && !d.pos.capabilities.idempotentSubmitById) {
    // A previous attempt may have reached the register; re-sending could create a second order.
    // Read the register's status under our id instead.
    decision = {
      op_state: "done",
      outcome: "not_resent_status_first",
      note: "POS deduplication by id not established",
      next: [{ kind: "pos_check_order", seq: op.seq, delay_seconds: 0 }],
    };
  } else if (op.attempts > 1 && mustNotRepeat(op.kind) && !d.bank.capabilities.idempotencyKeys) {
    // A previous attempt may have reached the provider, and the provider cannot tell us.
    // Repeating could create a second debit. Stop and ask a person.
    decision = {
      op_state: "needs_investigation",
      outcome: "not_repeated",
      note: "provider idempotency not established",
      checkout_outcome: "needs_staff",
      checkout_reason: `A previous ${
        op.kind.replace("bank_", "")
      } attempt may have reached the bank, and this provider cannot deduplicate a repeat. Not repeated. Check the provider dashboard before any retry.`,
    };
  } else {
    const call = await perform(op, snap, d);
    d.afterCall?.(op, call);
    decision = decide(op, call, snap, d.clock.now());
  }
  try {
    await d.sql.query(`select kiosk.finish_operation($1, $2, $3::text::jsonb, $4)`, [
      op.id,
      op.claim_token,
      JSON.stringify(decision),
      d.clock.now().toISOString(),
    ]);
  } catch (e) {
    // Our lease expired and another worker owns the operation now. It will send the same
    // operation_key, so our result is discarded rather than written twice.
    if (sqlErrorCode(e) !== "lease_lost") throw e;
  }
  return true;
}

/** Runs until idle, advancing the fake clock past retry delays when `advance` is given. */
export async function drain(d: WorkerDeps, opts: { advance?: (s: number) => void; maxSteps?: number } = {}) {
  for (let i = 0; i < (opts.maxSteps ?? 200); i++) {
    let worked = false;
    try {
      worked = await runOnce(d);
    } catch (e) {
      if (e instanceof WorkerCrash) continue;
      throw e;
    }
    if (!worked) {
      if (!opts.advance) return;
      const [{ n }] = await d.sql.query<{ n: number }>(
        `select count(*)::int as n from kiosk.operations where state in ('ready','claimed')`,
      );
      if (n === 0) return;
      opts.advance(15);
    }
  }
}
