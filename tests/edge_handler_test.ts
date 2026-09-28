// The Edge Function's HTTP handler under plain Deno (not the Supabase Edge runtime).
import { assertEquals } from "@std/assert";
import { CART, FEE_CENTS, makeWorld, QUOTE_CENTS, SHOPPER, STORE, WEBHOOK_SECRET } from "../bench/world.ts";
import { makeHandler } from "../src/http/handler.ts";
import { signWebhook } from "../src/webhook_signature.ts";

Deno.test("edge handler: checkout, tick, status, signed webhook, forged webhook", async () => {
  const w = await makeWorld();
  const h = makeHandler({
    sql: w.sql,
    clock: w.clock,
    bank: w.bank,
    pos: w.pos,
    webhookSecret: WEBHOOK_SECRET,
    signatureHeader: "x-bank-signature",
    tickSecret: "tick",
    feeCents: FEE_CENTS,
    authenticateShopper: (req) =>
      Promise.resolve(req.headers.get("authorization") === "Bearer shopper-a" ? SHOPPER : null),
  });
  const base = "http://localhost/kiosk-checkout";
  const body = JSON.stringify({
    store_id: STORE,
    kiosk_request_id: "kiosk-7-tap-000184",
    saved_ref_id: w.savedRefId,
    quoted_total_cents: QUOTE_CENTS,
    fee_cents: 0, // a kiosk that tries to skip the fee
    cart: CART,
  });
  assertEquals((await h(new Request(`${base}/checkout`, { method: "POST", body }))).status, 401);
  const r1 = await h(
    new Request(`${base}/checkout`, { method: "POST", body, headers: { authorization: "Bearer shopper-a" } }),
  );
  const r2 = await h(
    new Request(`${base}/checkout`, { method: "POST", body, headers: { authorization: "Bearer shopper-a" } }),
  );
  assertEquals([r1.status, r2.status], [201, 200]);
  const { checkout_id } = await r1.json();
  const [fee] = await w.sql.query<{ fee_cents: number }>(
    `select fee_cents from kiosk.checkouts where id = $1`,
    [checkout_id],
  );
  assertEquals(fee.fee_cents, FEE_CENTS); // the server's fee, not the client's 0
  await r2.body?.cancel();
  for (let i = 0; i < 12; i++) {
    const t = await h(
      new Request(`${base}/worker/tick`, { method: "POST", headers: { authorization: "Bearer tick" } }),
    );
    await t.body?.cancel();
    w.clock.advance(15);
  }
  const st = await (await h(
    new Request(`${base}/checkout/${checkout_id}`, { headers: { authorization: "Bearer shopper-a" } }),
  )).json();
  assertEquals(st.outcome, "ready_for_pickup");
  assertEquals(st.register, "applied");

  w.bank.settleAllPending("2026-09-29");
  const [evt] = w.bank.takeEvents();
  const raw = JSON.stringify(evt);
  const sig = await signWebhook(WEBHOOK_SECRET, raw, Math.floor(w.clock.now().getTime() / 1000));
  const ok = await h(
    new Request(`${base}/webhooks/bank`, { method: "POST", body: raw, headers: { "x-bank-signature": sig } }),
  );
  const dup = await h(
    new Request(`${base}/webhooks/bank`, { method: "POST", body: raw, headers: { "x-bank-signature": sig } }),
  );
  const forged = await h(
    new Request(`${base}/webhooks/bank`, {
      method: "POST",
      body: raw.replace("9750", "1"),
      headers: { "x-bank-signature": sig },
    }),
  );
  assertEquals([ok.status, (await ok.json()).result], [200, "recorded"]);
  assertEquals([dup.status, (await dup.json()).result], [200, "duplicate_event"]);
  assertEquals(forged.status, 401);
  await forged.body?.cancel();
  await w.close();
});

Deno.test("edge handler: a webhook for a reference we have not written yet is refused for retry, not swallowed", async () => {
  const w = await makeWorld();
  const h = makeHandler({
    sql: w.sql,
    clock: w.clock,
    bank: w.bank,
    pos: w.pos,
    webhookSecret: WEBHOOK_SECRET,
    signatureHeader: "x-bank-signature",
    tickSecret: "tick",
    feeCents: FEE_CENTS,
    authenticateShopper: () => Promise.resolve(null),
  });
  const raw = JSON.stringify({
    id: "evt_early",
    type: "refund.settled",
    ref: "rf_9999",
    amountCents: 9750,
    effectiveDate: "2026-09-30",
  });
  const sig = await signWebhook(WEBHOOK_SECRET, raw, Math.floor(w.clock.now().getTime() / 1000));
  const req = () =>
    new Request("http://localhost/kiosk-checkout/webhooks/bank", {
      method: "POST",
      body: raw,
      headers: { "x-bank-signature": sig },
    });
  const a = await h(req());
  const b = await h(req());
  assertEquals([a.status, b.status], [503, 503]); // the retry is processed again, not deduplicated away
  await a.body?.cancel();
  await b.body?.cancel();
  await w.close();
});
