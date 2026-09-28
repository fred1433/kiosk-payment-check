import { assertEquals } from "@std/assert";
import { makeWorld } from "../bench/world.ts";
import { reconciliation } from "../src/service.ts";

Deno.test("happy path: preauthorize, order, capture, register shows paid", async () => {
  const w = await makeWorld();
  const r = await w.checkout();
  if (!r.ok) throw new Error(r.error);
  await w.run();
  const rec = await reconciliation(w.sql, r.checkoutId);
  assertEquals(rec.outcome, "ready_for_pickup");
  assertEquals(rec.register_ack_state, "applied");
  assertEquals(w.bank.debitsAccepted(), 1);
  assertEquals(w.pos.ordersCreated(), 1);
  await w.close();
});
