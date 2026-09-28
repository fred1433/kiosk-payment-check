// The page's first screen: one fictional order where the bank capture succeeds and the call
// that records the payment at the register times out. Same fault, two endings, depending on
// what the register actually did. Rows come from the module's own event journal.

import { makeWorld } from "./world.ts";
import { events, reconciliation } from "../src/service.ts";
import { usd } from "../src/workflow.ts";

type Lane = "kiosk" | "bank" | "register" | "staff";
interface Row {
  at: string; // mm:ss since the shopper tapped Pay
  lane: Lane;
  text: string;
  tone?: "unknown" | "stop";
}

function describe(
  kind: string,
  outcome: string,
  seq: number,
): { lane: Lane; text: string; tone?: Row["tone"] } | null {
  const k = `${kind}:${outcome}`;
  switch (k) {
    case "bank_preauthorize:preauthorized":
      return { lane: "bank", text: "Preauthorized. No money has moved." };
    case "pos_submit_order:accepted_202":
      return { lane: "register", text: "Order received under our GUID." };
    case "pos_check_order:ready_for_payment":
      return { lane: "register", text: "Order confirmed with its final total." };
    case "bank_capture:accepted":
      return { lane: "bank", text: "Capture accepted. Money is moving." };
    case "pos_apply_payment:unknown":
      return {
        lane: "register",
        text: seq === 1
          ? "Payment record sent. No answer: timed out."
          : `Payment record resent (${seq} of 3). No answer.`,
        tone: "unknown",
      };
    case "pos_check_payment:resubmit_payment":
      return { lane: "register", text: "Status read: the register does not have the payment yet." };
    case "pos_check_payment:applied":
      return { lane: "register", text: "Status read: payment applied. The register shows the order paid." };
    case "pos_check_payment:not_acknowledged":
      return { lane: "register", text: "Still no payment on the register. Resends stopped.", tone: "stop" };
    default:
      return null;
  }
}

async function branch(ending: "recovered" | "unresolved", pgUrl?: string) {
  const w = await makeWorld({ pgUrl });
  w.pos.faults.pay = ending === "recovered"
    ? ["lose_response"]
    : ["drop_request", "drop_request", "drop_request"];
  const r = await w.checkout();
  if (!r.ok) throw new Error(r.error);
  const t0 = w.clock.now().getTime();
  await w.run();
  const ev = await events(w.sql, r.checkoutId);
  const rec = await reconciliation(w.sql, r.checkoutId);
  const rows: Row[] = [];
  const mmss = (at: string) => {
    const s = Math.round((new Date(at).getTime() - t0) / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };
  for (const e of ev) {
    if (e.type === "checkout_started") {
      rows.push({
        at: mmss(e.at),
        lane: "kiosk",
        text: `Shopper taps Pay. ${
          usd(Number(e.detail.quoted_total_cents) + Number(e.detail.fee_cents))
        } with a saved bank connection.`,
      });
    }
    if (e.type === "operation_finished") {
      const d = describe(String(e.detail.kind), String(e.detail.outcome), Number(e.detail.seq));
      if (d) rows.push({ at: mmss(e.at), ...d });
    }
  }
  const last = rows.at(-1)?.at ?? "0:00";
  if (rec.outcome === "ready_for_pickup") {
    rows.push({ at: last, lane: "kiosk", text: "Screen shows: Paid. Pick up at the counter." });
    rows.push({ at: last, lane: "staff", text: "Order appears paid. Hand over as usual." });
  } else {
    rows.push({
      at: last,
      lane: "kiosk",
      text: "Screen shows: Payment received. A team member will finish your order.",
    });
    rows.push({ at: last, lane: "staff", text: rec.outcome_reason ?? "", tone: "stop" });
  }
  const out = {
    ending,
    rows,
    measures: {
      debits: w.bank.debitsAccepted(),
      orders: w.pos.ordersCreated(),
      registerPaid: w.pos.registerShowsPaid(),
      captureCents: rec.capture_amount_cents,
      saleTotalCents: rec.sale_total_cents,
      outcome: rec.outcome,
      openInvestigations: rec.open_investigations,
    },
    posOrderId: rec.checkout_id
      ? (await w.sql.query<{ pos_order_id: string }>(
        `select pos_order_id from kiosk.pos_orders where checkout_id = $1`,
        [r.checkoutId],
      ))[0].pos_order_id
      : "",
  };
  await w.close();
  return out;
}

export async function runHero(pgUrl?: string) {
  return { recovered: await branch("recovered", pgUrl), unresolved: await branch("unresolved", pgUrl) };
}
