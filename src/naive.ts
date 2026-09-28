// The deliberately naive baseline the bench must catch. It is the version that passes a
// happy-path demo: debit first, then create the order, and on a timeout "just retry" with a
// fresh idempotency key and a fresh order id. It trusts the saved-reference id it is given,
// counts every webhook it receives, and never tells the register the order is paid.

import type { BankSimulator } from "./adapters/bank_sim.ts";
import type { CovaSimulator } from "./adapters/cova_sim.ts";
import type { CartLine } from "./adapters/types.ts";

export interface NaiveDb {
  savedRefs: Map<string, string>; // saved ref id -> provider consent ref (no owner check)
  orders: { status: string; paymentRefs: string[]; posOrderIds: string[] }[];
  paidCents: number; // incremented by every settlement webhook
}

export function newNaiveDb(refs: Record<string, string>): NaiveDb {
  return { savedRefs: new Map(Object.entries(refs)), orders: [], paidCents: 0 };
}

export async function naiveCheckout(
  db: NaiveDb,
  bank: BankSimulator,
  pos: CovaSimulator,
  req: { savedRefId: string; cart: CartLine[]; amountCents: number },
): Promise<string> {
  const consentRef = db.savedRefs.get(req.savedRefId);
  if (!consentRef) return "unknown_ref";
  const order = { status: "pending", paymentRefs: [] as string[], posOrderIds: [] as string[] };
  db.orders.push(order);

  for (let i = 0; i < 3; i++) {
    const r = await bank.debit({
      operationKey: crypto.randomUUID(),
      consentRef,
      amountCents: req.amountCents,
    });
    if (r.kind === "ok") {
      order.paymentRefs.push(r.value.paymentRef);
      break;
    }
    if (r.kind !== "unknown") {
      order.status = "payment_failed";
      return order.status;
    }
  }
  if (order.paymentRefs.length === 0) {
    order.status = "payment_failed";
    return order.status;
  }

  for (let i = 0; i < 3; i++) {
    const id = crypto.randomUUID();
    const r = await pos.submitOrder({ posOrderId: id, lines: req.cart, reference: "kiosk" });
    order.posOrderIds.push(id);
    if (r.kind === "ok") {
      order.status = "completed";
      return order.status;
    }
    if (r.kind === "rejected") break;
  }
  order.status = "paid_order_failed"; // and nothing else happens
  return order.status;
}

export function naiveWebhook(db: NaiveDb, body: { type: string; amountCents: number }) {
  if (body.type === "payment.settled") db.paidCents += body.amountCents;
  if (body.type === "refund.settled") db.paidCents -= body.amountCents;
  // returns are not handled
}
