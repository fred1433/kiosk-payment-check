// The checkout workflow as one pure function: given an operation, what the provider answered,
// and the current facts, decide what to record and what to do next. No I/O here, so every
// branch is unit-testable under plain Deno.
//
// Chosen order of operations (see docs/integration-map.md for the comparison):
//   1. bank_preauthorize   shopper's saved consent, quoted total + disclosed fee, no funds move
//   2. pos_submit_order    PUT with the GUID we generated when the checkout was created
//   3. pos_check_order     status endpoint is the source of truth; get the register's sale total
//   4. bank_capture        only after the register confirmed the order and the total
//   5. pos_apply_payment   tell the register the order is paid (amount = sale total)
//   6. pos_check_payment   the register shows the payment, or staff are told it does not
// The failure this order introduces: money can be captured while the register does not yet,
// or never, show the order as paid (steps 4 to 6). That state is surfaced, never hidden.

import type { Call, CartLine, PosStatus } from "./adapters/types.ts";

export type OpKind =
  | "bank_preauthorize"
  | "pos_submit_order"
  | "pos_check_order"
  | "bank_capture"
  | "pos_apply_payment"
  | "pos_check_payment"
  | "pos_cancel_order"
  | "bank_void_preauth"
  | "bank_refund";

export interface OperationRow {
  id: string;
  checkout_id: string;
  kind: OpKind;
  seq: number;
  operation_key: string;
  attempts: number;
  claim_token: string;
  input: Record<string, unknown>;
  created_at: string | Date;
}

export interface Snapshot {
  checkoutId: string;
  createdAt: Date;
  quotedTotalCents: number;
  feeCents: number;
  cart: CartLine[];
  consentRef: string;
  preauthState: string;
  preauthRef: string | null;
  preauthAmountCents: number | null;
  captureState: string;
  captureRef: string | null;
  captureAmountCents: number | null;
  posOrderId: string;
  orderState: string;
  saleTotalCents: number | null;
  ackState: string;
}

export type CheckoutOutcome = "ready_for_pickup" | "no_charge" | "needs_new_consent" | "needs_staff";

export interface Decision {
  op_state: "done" | "retry" | "needs_investigation";
  outcome: string;
  retry_after_seconds?: number;
  error?: string;
  note?: string;
  result?: unknown;
  bank?: Record<string, unknown>;
  pos?: Record<string, unknown>;
  ack?: Record<string, unknown>;
  checkout_outcome?: CheckoutOutcome;
  checkout_reason?: string;
  next?: { kind: OpKind; seq?: number; delay_seconds?: number; input?: Record<string, unknown> }[];
}

export const LIMITS = {
  /** attempts of the same operation (same key) before a person is asked to look */
  maxAttempts: 3,
  /** resubmissions of the order or of the payment record to the POS */
  maxResubmits: 3,
  /** how long the kiosk flow waits for the register before escalating */
  registerDeadlineSeconds: 300,
};

export const usd = (c: number | null | undefined) => c == null ? "?" : `$${(c / 100).toFixed(2)}`;

function ageSeconds(s: Snapshot, now: Date) {
  return (now.getTime() - s.createdAt.getTime()) / 1000;
}

function retryOrEscalate(op: OperationRow, reason: string, extra: Partial<Decision> = {}): Decision {
  if (op.attempts < LIMITS.maxAttempts) {
    return {
      op_state: "retry",
      outcome: "unknown",
      retry_after_seconds: 5 * 3 ** (op.attempts - 1),
      ...extra,
    };
  }
  return {
    op_state: "needs_investigation",
    outcome: "unknown",
    checkout_outcome: "needs_staff",
    checkout_reason: reason,
    ...extra,
  };
}

function waitForRegister(
  _op: OperationRow,
  s: Snapshot,
  now: Date,
  reason: string,
  extra: Partial<Decision> = {},
): Decision {
  if (ageSeconds(s, now) < LIMITS.registerDeadlineSeconds) {
    return { op_state: "retry", outcome: "waiting", retry_after_seconds: 10, ...extra };
  }
  return {
    op_state: "needs_investigation",
    outcome: "deadline",
    checkout_outcome: "needs_staff",
    checkout_reason: reason,
    ...extra,
  };
}

export function decide(op: OperationRow, call: Call<unknown>, s: Snapshot, now: Date): Decision {
  switch (op.kind) {
    case "bank_preauthorize": {
      const amount = op.input.amount_cents as number;
      if (call.kind === "ok") {
        const v = call.value as { preauthRef: string };
        return {
          op_state: "done",
          outcome: "preauthorized",
          bank: {
            preauth_state: "preauthorized",
            preauth_ref: v.preauthRef,
            preauth_amount_cents: amount,
            raw: { [v.preauthRef]: call.raw ?? null },
          },
          next: [{ kind: "pos_submit_order" }],
        };
      }
      if (call.kind === "declined") {
        const revoked = call.reason === "consent_revoked";
        return {
          op_state: "done",
          outcome: "declined",
          bank: { preauth_state: "declined" },
          checkout_outcome: revoked ? "needs_new_consent" : "no_charge",
          checkout_reason: revoked
            ? "The saved bank connection was revoked. Ask the shopper to reconnect their bank."
            : `The bank declined the preauthorization (${call.reason}). Nothing was charged.`,
        };
      }
      if (call.kind === "rejected") {
        return {
          op_state: "needs_investigation",
          outcome: "rejected",
          error: call.reason,
          checkout_outcome: "needs_staff",
          checkout_reason: `Preauthorization request rejected: ${call.reason}.`,
        };
      }
      return retryOrEscalate(
        op,
        "The bank did not answer the preauthorization. No funds move on a preauthorization; nothing was captured.",
        { bank: { preauth_state: "unknown" } },
      );
    }

    case "pos_submit_order": {
      if (call.kind === "ok") {
        return {
          op_state: "done",
          outcome: "accepted_202",
          pos: { order_state: "submitted" },
          next: [{ kind: "pos_check_order", seq: op.seq, delay_seconds: 2 }],
        };
      }
      if (call.kind === "rejected") {
        return {
          op_state: "done",
          outcome: "rejected",
          pos: { order_state: "rejected", raw_message: call.reason },
          checkout_outcome: "no_charge",
          checkout_reason: `The register rejected the order (${call.reason}). Nothing was captured.`,
          next: [{ kind: "bank_void_preauth" }],
        };
      }
      // Unknown: do not resubmit blindly. Ask the register what it has under our GUID.
      return {
        op_state: "done",
        outcome: "unknown",
        pos: { order_state: "unknown" },
        next: [{ kind: "pos_check_order", seq: op.seq, delay_seconds: 5 }],
      };
    }

    case "pos_check_order":
      return decideCheckOrder(op, call, s, now);

    case "bank_capture": {
      const amount = op.input.amount_cents as number;
      if (call.kind === "ok") {
        const v = call.value as { paymentRef: string };
        return {
          op_state: "done",
          outcome: "accepted",
          bank: {
            capture_state: "accepted",
            capture_ref: v.paymentRef,
            capture_amount_cents: amount,
            raw: { [v.paymentRef]: call.raw ?? null },
          },
          next: [{
            kind: "pos_apply_payment",
            input: { amount_cents: s.saleTotalCents, payment_ref: v.paymentRef },
          }],
        };
      }
      if (call.kind === "declined" || call.kind === "rejected") {
        const revoked = call.reason === "consent_revoked";
        return {
          op_state: "done",
          outcome: "declined",
          bank: { capture_state: "declined" },
          checkout_outcome: revoked ? "needs_new_consent" : "no_charge",
          checkout_reason: revoked
            ? "The shopper's bank connection was revoked before capture. Nothing was captured; the unpaid order is being cancelled."
            : `The bank declined the capture (${call.reason}). Nothing was captured; the unpaid order is being cancelled.`,
          next: [{ kind: "pos_cancel_order" }],
        };
      }
      return retryOrEscalate(
        op,
        `The bank has not confirmed the ${
          usd(amount)
        } capture. The register shows the order unpaid: do not take payment at the counter and do not hand over until this is resolved.`,
        { bank: { capture_state: "unknown" } },
      );
    }

    case "pos_apply_payment": {
      if (call.kind === "ok") {
        return {
          op_state: "done",
          outcome: "accepted_202",
          ack: { ack_state: "sent", amount_cents: op.input.amount_cents },
          next: [{ kind: "pos_check_payment", seq: op.seq, delay_seconds: 2 }],
        };
      }
      if (call.kind === "unknown") {
        return {
          op_state: "done",
          outcome: "unknown",
          ack: { ack_state: "unknown" },
          next: [{ kind: "pos_check_payment", seq: op.seq, delay_seconds: 5 }],
        };
      }
      // Rejected: read the register before telling staff anything, the order may be gone.
      return {
        op_state: "done",
        outcome: "rejected",
        error: call.reason,
        ack: { ack_state: "cannot_be_applied", raw_status: call.reason },
        next: [{ kind: "pos_check_payment", seq: op.seq, input: { after_rejection: call.reason } }],
      };
    }

    case "pos_check_payment":
      return decideCheckPayment(op, call, s, now);

    case "pos_cancel_order": {
      if (call.kind === "ok") {
        return {
          op_state: "done",
          outcome: "cancelled",
          pos: { order_state: "cancelled" },
          next: [{ kind: "bank_void_preauth" }],
        };
      }
      if (call.kind === "unknown") {
        return retryOrEscalate(
          op,
          `Could not confirm that unpaid order ${s.posOrderId} was cancelled. Nothing was captured.`,
        );
      }
      return {
        op_state: "needs_investigation",
        outcome: "cancel_refused",
        error: call.reason,
        checkout_outcome: "needs_staff",
        checkout_reason:
          `Unpaid order ${s.posOrderId} could not be cancelled (${call.reason}). Nothing was captured.`,
      };
    }

    case "bank_void_preauth": {
      if (call.kind === "ok") {
        return { op_state: "done", outcome: "voided", bank: { preauth_state: "voided" } };
      }
      if (call.kind === "unknown" && op.attempts < LIMITS.maxAttempts) {
        return { op_state: "retry", outcome: "unknown", retry_after_seconds: 30 };
      }
      // No funds moved; an unvoided preauthorization is recorded, not escalated.
      return {
        op_state: "done",
        outcome: "void_not_confirmed",
        note: "Preauthorization not confirmed voided; provider expiry behavior to confirm.",
      };
    }

    case "bank_refund": {
      const amount = op.input.amount_cents as number;
      if (call.kind === "ok") {
        const v = call.value as { refundRef: string };
        return {
          op_state: "done",
          outcome: "accepted",
          bank: { refund_state: "accepted", refund_ref: v.refundRef, refund_amount_cents: amount },
        };
      }
      if (call.kind === "unknown") {
        return retryOrEscalate(
          op,
          `The ${usd(amount)} refund was sent but not confirmed. Do not issue it again by another route.`,
          { bank: { refund_state: "unknown" } },
        );
      }
      return {
        op_state: "needs_investigation",
        outcome: "refund_refused",
        error: call.reason,
        bank: { refund_state: "declined" },
        checkout_outcome: "needs_staff",
        checkout_reason: `The bank refused the refund (${call.reason}).`,
      };
    }
  }
}

function decideCheckOrder(op: OperationRow, call: Call<unknown>, s: Snapshot, now: Date): Decision {
  if (call.kind !== "ok") {
    return waitForRegister(
      op,
      s,
      now,
      `The register has not confirmed order ${s.posOrderId}. Nothing was captured. Check the order at the register before retrying.`,
    );
  }
  const st = call.value as PosStatus;
  const raw = { raw_status: st.orderStatus, raw_message: st.message ?? null };
  switch (st.orderStatus) {
    case "ReadyForPayment": {
      const sale = st.saleTotalCents!;
      const charge = sale + s.feeCents;
      if (s.preauthAmountCents == null || charge > s.preauthAmountCents) {
        return {
          op_state: "done",
          outcome: "total_above_preauth",
          pos: { order_state: "ready_for_payment", sale_total_cents: sale, ...raw },
          checkout_outcome: "needs_new_consent",
          checkout_reason: `The register total is ${usd(sale)} plus the ${usd(s.feeCents)} fee, above the ${
            usd(s.preauthAmountCents)
          } the shopper approved. Ask the shopper to approve the new total. Nothing was captured.`,
        };
      }
      return {
        op_state: "done",
        outcome: "ready_for_payment",
        pos: { order_state: "ready_for_payment", sale_total_cents: sale, ...raw },
        next: [{ kind: "bank_capture", input: { amount_cents: charge, preauth_ref: s.preauthRef } }],
      };
    }
    case "SubmittedForProcessing":
    case "SubmittedForFinalProcessing":
      return waitForRegister(
        op,
        s,
        now,
        `The register has not confirmed order ${s.posOrderId} after ${
          LIMITS.registerDeadlineSeconds / 60
        } minutes. Nothing was captured.`,
        { pos: raw },
      );
    case "NotFound":
      if (s.orderState === "submitted") {
        // 202 received but not visible yet
        return waitForRegister(
          op,
          s,
          now,
          `Order ${s.posOrderId} was accepted but never appeared at the register. Nothing was captured.`,
          { pos: raw },
        );
      }
    // falls through: the submit outcome was unknown, so resubmit with the SAME GUID
    case "TransientProcessingFailure":
      if (op.seq < LIMITS.maxResubmits) {
        return {
          op_state: "done",
          outcome: "resubmit_same_guid",
          pos: raw,
          next: [{ kind: "pos_submit_order", seq: op.seq + 1 }],
        };
      }
      return {
        op_state: "needs_investigation",
        outcome: "resubmits_exhausted",
        pos: raw,
        checkout_outcome: "needs_staff",
        checkout_reason:
          `The register failed to create order ${s.posOrderId} ${LIMITS.maxResubmits} times. Nothing was captured.`,
      };
    case "NonTransientProcessingFailure":
      return {
        op_state: "done",
        outcome: "rejected",
        pos: { order_state: "rejected", ...raw },
        checkout_outcome: "no_charge",
        checkout_reason: `The register rejected the order: ${
          st.message ?? "no message"
        }. Nothing was captured.`,
        next: [{ kind: "bank_void_preauth" }],
      };
    case "Cancelled":
      return {
        op_state: "done",
        outcome: "cancelled_at_register",
        pos: { order_state: "cancelled", ...raw },
        checkout_outcome: "no_charge",
        checkout_reason: "The order was cancelled at the register before payment. Nothing was captured.",
        next: [{ kind: "bank_void_preauth" }],
      };
    default:
      return {
        op_state: "needs_investigation",
        outcome: "unexpected_status",
        pos: raw,
        checkout_outcome: "needs_staff",
        checkout_reason: `Unexpected register status ${st.orderStatus}.`,
      };
  }
}

function decideCheckPayment(op: OperationRow, call: Call<unknown>, s: Snapshot, _now: Date): Decision {
  if (call.kind !== "ok") {
    return retryOrEscalate(
      op,
      `Paid by bank (${s.captureRef}). The register status could not be read. Do not collect again at the counter.`,
    );
  }
  const st = call.value as PosStatus;
  if (st.orderStatus === "Cancelled") {
    return {
      op_state: "needs_investigation",
      outcome: "paid_but_order_cancelled",
      pos: { order_state: "cancelled", raw_status: st.orderStatus },
      ack: { ack_state: "cannot_be_applied", raw_status: st.paymentStatus },
      checkout_outcome: "needs_staff",
      checkout_reason: `Paid by bank (${
        usd(s.captureAmountCents)
      }, ${s.captureRef}) but the order was cancelled at the register. A refund decision is needed. Nothing was refunded automatically.`,
    };
  }
  switch (st.paymentStatus) {
    case "PaymentApplied":
      if (op.input.after_rejection) {
        // Our payment record was refused, yet the register shows the order paid: someone else
        // recorded a payment (for example cash at the counter) while the bank also took the money.
        return {
          op_state: "needs_investigation",
          outcome: "register_paid_by_someone_else",
          ack: {
            ack_state: "cannot_be_applied",
            raw_status: `PaymentApplied, not ours (${op.input.after_rejection})`,
          },
          checkout_outcome: "needs_staff",
          checkout_reason: `The register shows a payment we did not record, and the bank also took ${
            usd(s.captureAmountCents)
          } (${s.captureRef}). Possible double collection: check how the register was paid before handing over or refunding.`,
        };
      }
      return {
        op_state: "done",
        outcome: "applied",
        ack: { ack_state: "applied", raw_status: st.paymentStatus },
        checkout_outcome: "ready_for_pickup",
        checkout_reason: "Paid. The register shows the payment.",
      };
    case "PaymentSubmittedForProcessing":
      return retryOrEscalate(
        op,
        `Paid by bank (${s.captureRef}). The register is still processing the payment record. Do not collect again at the counter.`,
        { ack: { raw_status: st.paymentStatus } },
      );
    case "NotReadyForPayment":
    case "ReadyForPayment":
    case "TransientProcessingFailure":
      if (op.seq < LIMITS.maxResubmits && !op.input.after_rejection) {
        return {
          op_state: "done",
          outcome: "resubmit_payment",
          ack: { raw_status: st.paymentStatus },
          next: [{
            kind: "pos_apply_payment",
            seq: op.seq + 1,
            input: { amount_cents: s.saleTotalCents, payment_ref: s.captureRef },
          }],
        };
      }
    // falls through
    default:
      return {
        op_state: "needs_investigation",
        outcome: "not_acknowledged",
        ack: { ack_state: "cannot_be_applied", raw_status: st.paymentStatus },
        checkout_outcome: "needs_staff",
        checkout_reason: `Paid by bank (${
          usd(s.captureAmountCents)
        }, ${s.captureRef}). The register does not show the payment (status: ${
          op.input.after_rejection ?? st.paymentStatus
        }${st.message ? `: ${st.message}` : ""}). Do not collect again at the counter.`,
      };
  }
}

/** Operations that move money must not be repeated when the provider cannot deduplicate. */
export function mustNotRepeat(kind: OpKind): boolean {
  return kind === "bank_capture" || kind === "bank_refund" || kind === "bank_preauthorize";
}
