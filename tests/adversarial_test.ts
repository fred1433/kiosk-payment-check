// Adversarial sequences from an independent review of this repository (28 Sep 2026), kept as
// regression tests. Each one checks that the module does not claim something the simulated
// bank and register contradict.
import { assert, assertEquals } from "@std/assert";
import { FEE_CENTS, makeWorld, QUOTE_CENTS } from "../bench/world.ts";
import { pollUnsettledCaptures, reconciliation, recordHandoff, requestRefund } from "../src/service.ts";
import { runOnce, WorkerCrash } from "../src/worker.ts";

const CHARGE = QUOTE_CENTS + FEE_CENTS;

Deno.test("T1 a return whose notice is lost after settlement is found by the reconciler", async () => {
  const w = await makeWorld();
  const r = await w.checkout();
  const id = r.ok ? r.checkoutId : "";
  await w.run();
  await recordHandoff(w.sql, w.clock, id, "b", null);
  const ref = [...w.bank.payments.keys()][0];
  w.bank.settle(ref, "2026-09-29");
  await w.deliver();
  w.clock.advanceDays(20);
  w.bank.returnDebit(ref, "R10", "2026-10-19");
  await w.deliver({ drop: () => true });
  assertEquals(await pollUnsettledCaptures(w.sql, w.clock, w.bank), 1);
  const rec = await reconciliation(w.sql, id);
  assertEquals(rec.net_cash_cents, w.bank.netCents());
  assertEquals(rec.short_cents, CHARGE);
  assertEquals(rec.outcome, "needs_staff");
  await w.close();
});

Deno.test("T1b the watch on a settled capture closes only after a successful read past 65 days", async () => {
  const w = await makeWorld();
  await w.checkout();
  await w.run();
  w.bank.settle([...w.bank.payments.keys()][0], "2026-09-29");
  await w.deliver();
  w.clock.advanceDays(62);
  let before = w.bank.calls.get;
  await pollUnsettledCaptures(w.sql, w.clock, w.bank);
  assertEquals(w.bank.calls.get, before + 1); // day 62: still watched
  w.clock.advanceDays(5);
  w.bank.faults.get = ["server_error"];
  await pollUnsettledCaptures(w.sql, w.clock, w.bank); // failed read: watch stays open
  await pollUnsettledCaptures(w.sql, w.clock, w.bank); // successful read past the window: closes
  before = w.bank.calls.get;
  w.clock.advanceDays(1);
  await pollUnsettledCaptures(w.sql, w.clock, w.bank);
  assertEquals(w.bank.calls.get, before);
  await w.close();
});

Deno.test("T2 a refund settled before its reference was written is still recorded", async () => {
  const w = await makeWorld();
  const r = await w.checkout();
  const id = r.ok ? r.checkoutId : "";
  await w.run();
  w.bank.settle([...w.bank.payments.keys()][0], "2026-09-29");
  await w.deliver();
  await requestRefund(w.sql, w.clock, id, CHARGE, "goods_returned", "m");
  try {
    await runOnce(w.worker("w1", {
      afterCall: (op) => {
        if (op.kind === "bank_refund") throw new WorkerCrash("x");
      },
    }));
  } catch (e) {
    if (!(e instanceof WorkerCrash)) throw e;
  }
  w.bank.settleRefunds("2026-09-30");
  assertEquals(await w.deliver(), ["unknown_reference"]);
  await w.run();
  await pollUnsettledCaptures(w.sql, w.clock, w.bank);
  const rec = await reconciliation(w.sql, id);
  assertEquals(rec.refunded_cents, -CHARGE);
  assertEquals(rec.net_cash_cents, w.bank.netCents());
  assertEquals(rec.held_for_shopper_cents, 0);
  await w.close();
});

Deno.test("T4 a preauthorization expiry after capture changes nothing", async () => {
  const w = await makeWorld();
  const r = await w.checkout();
  const id = r.ok ? r.checkoutId : "";
  await w.run();
  const [b] = await w.sql.query<{ preauth_ref: string }>(
    `select preauth_ref from kiosk.bank_payments where checkout_id = $1`,
    [id],
  );
  const [x] = await w.sql.query<{ r: string }>(
    `select kiosk.record_bank_event('e1', 'preauth.expired', $1, 0, null, '2026-10-05', 'webhook') as r`,
    [b.preauth_ref],
  );
  assertEquals(x.r, "already_known");
  const [a] = await w.sql.query<{ preauth_state: string; capture_state: string }>(
    `select preauth_state, capture_state from kiosk.bank_payments where checkout_id = $1`,
    [id],
  );
  assertEquals([a.preauth_state, a.capture_state], ["preauthorized", "accepted"]);
  await w.close();
});

Deno.test("T5 boundary: cash taken at the counter and NOT recorded at the register is invisible to the module", async () => {
  const w = await makeWorld();
  const r = await w.checkout();
  const id = r.ok ? r.checkoutId : "";
  await w.run({
    afterCall: (op) => {
      if (op.kind === "bank_capture") w.pos.cashierCollectsIfUnpaid([...w.pos.orders.keys()][0]);
    },
  });
  const rec = await reconciliation(w.sql, id);
  // What the module says is true of the register; the unrecorded cash is outside any system it reads.
  assertEquals(rec.outcome, "ready_for_pickup");
  assertEquals(rec.outcome_reason, "Paid. The register shows our bank payment.");
  assert(w.pos.registerShowsPaid());
  await w.close();
});

Deno.test("T6 cash recorded at the register while the capture is in flight is flagged, not called paid", async () => {
  const w = await makeWorld();
  const r = await w.checkout();
  const id = r.ok ? r.checkoutId : "";
  await w.run({
    afterCall: (op) => {
      if (op.kind === "bank_capture") w.pos.cashierTakesCashAndRecords([...w.pos.orders.keys()][0]);
    },
  });
  const rec = await reconciliation(w.sql, id);
  assertEquals(w.bank.debitsAccepted(), 1);
  assertEquals(rec.outcome, "needs_staff");
  assert(rec.outcome_reason?.includes("does not establish whether it is our bank payment"));
  await w.close();
});

Deno.test("T7 assumption-negative: if the register did NOT deduplicate by id while declared to, a replay makes two order records", async () => {
  // Documents the production prerequisite behind idempotentSubmitById: the module relies on it.
  const w2 = await makeWorld({ pos: { putIsIdempotentById: false, declareIdempotentSubmit: true } });
  await w2.checkout();
  await w2.run({
    afterCall: (op) => {
      if (op.kind === "pos_submit_order" && op.attempts === 1) throw new WorkerCrash("died");
    },
  });
  assertEquals(w2.pos.ordersCreated(), 2);
  await w2.close();
  const w3 = await makeWorld({ pos: { putIsIdempotentById: false, declareIdempotentSubmit: false } });
  await w3.checkout();
  await w3.run({
    afterCall: (op) => {
      if (op.kind === "pos_submit_order" && op.attempts === 1) throw new WorkerCrash("died");
    },
  });
  assertEquals(w3.pos.ordersCreated(), 1); // not declared: status read first, no replay
  await w3.close();
});

Deno.test("T8 a known return is not cleared by a later register reading (direct SQL guard)", async () => {
  const w = await makeWorld();
  const r = await w.checkout();
  const id = r.ok ? r.checkoutId : "";
  await w.run();
  const ref = [...w.bank.payments.keys()][0];
  w.bank.settle(ref, "2026-09-29");
  w.bank.returnDebit(ref, "R01", "2026-10-01");
  await w.deliver();
  const [op] = await w.sql.query<{ id: string }>(
    `select id from kiosk.operations where checkout_id = $1 limit 1`,
    [id],
  );
  await w.sql.query(
    `update kiosk.operations set state = 'claimed', claim_token = '00000000-0000-4000-8000-000000000001' where id = $1`,
    [op.id],
  );
  await w.sql.query(
    `select kiosk.finish_operation($1, '00000000-0000-4000-8000-000000000001', $2::text::jsonb, now())`,
    [
      op.id,
      JSON.stringify({
        op_state: "done",
        outcome: "x",
        checkout_outcome: "ready_for_pickup",
        checkout_reason: "Paid.",
      }),
    ],
  );
  const rec = await reconciliation(w.sql, id);
  assertEquals(rec.outcome, "needs_staff");
  await w.close();
});
