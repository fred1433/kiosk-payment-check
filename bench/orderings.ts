// Three orders of operations under the same faults. A and B are minimal straight-line flows
// written only for this comparison; C is the module itself. Read from the simulators' ground truth.

import { BankSimulator } from "../src/adapters/bank_sim.ts";
import { type CovaSimOptions, CovaSimulator } from "../src/adapters/cova_sim.ts";
import { CART, FEE_CENTS, makeWorld, QUOTE_CENTS } from "./world.ts";

interface Cell {
  debits: number;
  orders: number;
  unpaidOpenOrders: number;
  moneyWithoutPaidOrder: boolean;
  outcome: string;
}

interface Fault {
  id: string;
  title: string;
  pos?: CovaSimOptions;
  declineBank?: boolean;
}

const FAULTS: Fault[] = [
  {
    id: "pos-rejects",
    title: "Register rejects the order",
    pos: { landOrderIn: "NonTransientProcessingFailure", rejectMessage: "item not in selling room" },
  },
  { id: "bank-declines", title: "Bank declines the debit", declineBank: true },
  {
    id: "total-higher",
    title: "Register total is $6.00 above the quote",
    pos: { saleTotalOverrideCents: QUOTE_CENTS + 600 },
  },
  {
    id: "register-refuses-payment",
    title: "Register refuses the payment record",
    pos: { landPaymentIn: "PaymentCannotBeApplied" },
  },
];

function truth(bank: BankSimulator, pos: CovaSimulator, outcome: string): Cell {
  const orders = [...pos.orders.values()];
  const unpaid =
    orders.filter((o) => o.orderStatus === "ReadyForPayment" && o.paymentStatus !== "PaymentApplied").length;
  const paid = orders.some((o) => o.paymentStatus === "PaymentApplied");
  return {
    debits: bank.debitsAccepted(),
    orders: pos.ordersCreated(),
    unpaidOpenOrders: unpaid,
    moneyWithoutPaidOrder: bank.debitsAccepted() > 0 && !paid,
    outcome,
  };
}

function sims(f: Fault) {
  const bank = new BankSimulator();
  bank.enroll("consent_shopper_a");
  if (f.declineBank) bank.declineReason = "insufficient_funds";
  const pos = new CovaSimulator({ taxRate: 0.2, ...f.pos });
  return { bank, pos };
}

async function debitFirst(f: Fault): Promise<Cell> {
  const { bank, pos } = sims(f);
  const d = await bank.debit({
    operationKey: "k1",
    consentRef: "consent_shopper_a",
    amountCents: QUOTE_CENTS + FEE_CENTS,
  });
  if (d.kind !== "ok") return truth(bank, pos, "Declined, nothing else happened.");
  const id = crypto.randomUUID();
  await pos.submitOrder({ posOrderId: id, lines: CART, reference: "k" });
  const st = await pos.getStatus(id);
  if (st.kind !== "ok" || st.value.orderStatus !== "ReadyForPayment") {
    return truth(bank, pos, "Shopper debited; no order. Needs a refund.");
  }
  const pay = await pos.applyPayment({
    posOrderId: id,
    amountCents: QUOTE_CENTS,
    paymentRef: d.value.paymentRef,
  });
  if (pay.kind !== "ok") {
    return truth(
      bank,
      pos,
      "Shopper debited the quote; register refuses it (total differs). Order open and unpaid.",
    );
  }
  return truth(
    bank,
    pos,
    pos.registerShowsPaid() ? "Completed." : "Reports completed; the register shows the order unpaid.",
  );
}

async function orderFirst(f: Fault): Promise<Cell> {
  const { bank, pos } = sims(f);
  const id = crypto.randomUUID();
  await pos.submitOrder({ posOrderId: id, lines: CART, reference: "k" });
  const st = await pos.getStatus(id);
  if (st.kind !== "ok" || st.value.orderStatus !== "ReadyForPayment") {
    return truth(bank, pos, "Order rejected before any debit. Nothing charged.");
  }
  const total = st.value.saleTotalCents! + FEE_CENTS;
  const d = await bank.debit({ operationKey: "k1", consentRef: "consent_shopper_a", amountCents: total });
  if (d.kind !== "ok") {
    return truth(bank, pos, "Debit declined; unpaid order left open, holding inventory until cancelled.");
  }
  await pos.applyPayment({
    posOrderId: id,
    amountCents: st.value.saleTotalCents!,
    paymentRef: d.value.paymentRef,
  });
  const note = !pos.registerShowsPaid()
    ? "Reports completed; the register shows the order unpaid."
    : total > QUOTE_CENTS + FEE_CENTS
    ? "Completed, but the shopper was debited more than the kiosk showed."
    : "Completed.";
  return truth(bank, pos, note);
}

async function preauthConfirmCapture(f: Fault): Promise<Cell> {
  const w = await makeWorld({ pos: f.pos });
  if (f.declineBank) w.bank.declineReason = "insufficient_funds";
  const r = await w.checkout();
  await w.run();
  const [rec] = await w.sql.query<{ outcome: string; outcome_reason: string }>(
    `select outcome, outcome_reason from kiosk.checkouts`,
  );
  const cell = truth(w.bank, w.pos, rec ? `${rec.outcome}: ${rec.outcome_reason ?? ""}` : "refused");
  await w.close();
  void r;
  return cell;
}

export async function runOrderings() {
  const strategies = [
    { id: "A", title: "Debit, then create the order", run: debitFirst },
    { id: "B", title: "Create and confirm the order, then debit", run: orderFirst },
    {
      id: "C",
      title: "Preauthorize, confirm order and total, then capture (this module)",
      run: preauthConfirmCapture,
    },
  ];
  const rows = [];
  for (const f of FAULTS) {
    const cells: Record<string, Cell> = {};
    for (const s of strategies) cells[s.id] = await s.run(f);
    rows.push({ fault: f.id, title: f.title, cells });
  }
  return { strategies: strategies.map(({ id, title }) => ({ id, title })), rows };
}
