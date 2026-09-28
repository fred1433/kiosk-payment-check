// Pure functions: no database.
import { assert, assertEquals, assertThrows } from "@std/assert";
import { addBankingDays, isLateNotice, returnDeadlines } from "../src/ach.ts";
import { signWebhook, verifyWebhook } from "../src/webhook_signature.ts";
import { decide, LIMITS, type OperationRow, type Snapshot } from "../src/workflow.ts";

const snap: Snapshot = {
  checkoutId: "c1",
  createdAt: new Date("2026-09-28T16:00:00Z"),
  quotedTotalCents: 9600,
  feeCents: 150,
  cart: [],
  consentRef: "consent",
  preauthState: "preauthorized",
  preauthRef: "pa_1",
  preauthAmountCents: 9750,
  captureState: "none",
  captureRef: null,
  captureAmountCents: null,
  posOrderId: "g1",
  orderState: "submitted",
  saleTotalCents: null,
  ackState: "not_sent",
  posIdempotentSubmit: true,
};
const op = (kind: OperationRow["kind"], attempts = 1, seq = 1, input = {}): OperationRow => ({
  id: "o",
  checkout_id: "c1",
  kind,
  seq,
  operation_key: "k",
  attempts,
  claim_token: "t",
  input,
  created_at: "",
});
const now = new Date("2026-09-28T16:00:30Z");

Deno.test("administrative returns: 2 banking days after settlement, skipping weekends and Fed holidays", () => {
  assertEquals(addBankingDays("2026-09-25", 2), "2026-09-29"); // Fri -> Tue
  assertEquals(addBankingDays("2026-10-09", 2), "2026-10-14"); // Fri, Columbus Day Mon 12 -> Wed 14
  assertEquals(returnDeadlines("2026-09-29").consumerUnauthorized, "2026-11-28");
  assertEquals(returnDeadlines("2026-12-31").administrative, "2027-01-05"); // Jan 1 2027 closed, then a weekend
  assertThrows(() => addBankingDays("2027-12-30", 2), Error, "unsupported_calendar_year");
});

Deno.test("a return received after its bank deadline is flagged, not dropped", () => {
  assert(isLateNotice("R01", "2026-09-29", "2026-10-05"));
  assert(!isLateNotice("R10", "2026-09-29", "2026-10-05"));
});

Deno.test("webhook signature: ok, tampered, stale, missing", async () => {
  const body = '{"id":"evt_1"}';
  const h = await signWebhook("s", body, 1000);
  assertEquals(await verifyWebhook("s", body, h, 1010), "ok");
  assertEquals(await verifyWebhook("s", body + " ", h, 1010), "mismatch");
  assertEquals(await verifyWebhook("s", body, h, 2000), "stale");
  assertEquals(await verifyWebhook("s", body, null, 1010), "missing");
});

Deno.test("capture never exceeds what the shopper approved", () => {
  const d = decide(
    op("pos_check_order"),
    {
      kind: "ok",
      value: { orderStatus: "ReadyForPayment", paymentStatus: "ReadyForPayment", saleTotalCents: 9700 },
    },
    snap,
    now,
  );
  assertEquals(d.checkout_outcome, "needs_new_consent");
  assertEquals(d.next ?? [], []);
});

Deno.test("unknown capture: same operation retried, then escalated, never marked failed", () => {
  const unknown = { kind: "unknown" as const, reason: "timeout" };
  assertEquals(
    decide(op("bank_capture", 1, 1, { amount_cents: 9750 }), unknown, snap, now).op_state,
    "retry",
  );
  const last = decide(op("bank_capture", LIMITS.maxAttempts, 1, { amount_cents: 9750 }), unknown, snap, now);
  assertEquals(last.op_state, "needs_investigation");
  assertEquals(last.checkout_outcome, "needs_staff");
});

Deno.test("unknown order submission reads status before any resubmission", () => {
  const d = decide(op("pos_submit_order"), { kind: "unknown", reason: "timeout" }, snap, now);
  assertEquals(d.next?.[0].kind, "pos_check_order");
});
