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

Deno.test("T1b after the 60-day window the reconciler stops reading a settled capture", async () => {
  const w = await makeWorld();
  await w.checkout();
  await w.run();
  w.bank.settle([...w.bank.payments.keys()][0], "2026-09-29");
  await w.deliver();
  w.clock.advanceDays(62);
  const before = w.bank.calls.get;
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
  assertEquals(rec.outcome_reason, "Paid. The register shows the payment.");
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
  assert(rec.outcome_reason?.includes("Possible double collection"));
  await w.close();
});
