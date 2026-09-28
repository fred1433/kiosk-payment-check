// The failure bench. Each sequence builds a fresh world, drives it, and reports measures read
// from the simulators' ground truth (what the bank and the register actually did) next to what
// the module recorded. The same sequences run in `deno task test` (tests/bench_test.ts) and in
// `deno task bench` (writes site/data/bench.json for the page).
//
// Boundary: these tests verify this module against the stated simulated contracts. They do not
// certify provider behavior or prevent independent cashier actions.

import { CART, FEE_CENTS, makeWorld, OTHER_STORE, QUOTE_CENTS, SHOPPER, type World } from "./world.ts";
import {
  events,
  pollUnsettledCaptures,
  reconciliation,
  type ReconRow,
  recordHandoff,
  requestRefund,
} from "../src/service.ts";
import { WorkerCrash } from "../src/worker.ts";
import type { OperationRow } from "../src/workflow.ts";
import type { LedgerLine } from "../src/adapters/bank_sim.ts";
import { naiveCheckout, naiveWebhook, newNaiveDb } from "../src/naive.ts";
import { BankSimulator } from "../src/adapters/bank_sim.ts";
import { type CovaSimOptions, CovaSimulator } from "../src/adapters/cova_sim.ts";
import { signWebhook } from "../src/webhook_signature.ts";
import { ingestBankWebhook } from "../src/service.ts";
import { WEBHOOK_SECRET } from "./world.ts";

export interface Measures {
  submissions: number;
  debits: number; // unique debits the bank accepted
  orders: number; // orders the register created
  registerPaid: "yes" | "no";
  paymentsAppliedAtRegister: number;
  movements: LedgerLine[]; // what the bank moved, signed, store's point of view
  bankNetCents: number;
  recordedNetCents?: number; // what the system under test believes
  exposureCents?: number;
  outcome: string;
  reason?: string | null;
  openInvestigations?: number;
}

export interface SequenceResult {
  id: string;
  family: string;
  title: string;
  expectation: string;
  module: Measures;
  naive?: Measures & { belief: string };
  pass: boolean;
  resolved: boolean; // false when the correct ending is a person looking at it
  notes: string[];
}

export interface Family {
  id: string;
  title: string;
  demonstrates: string;
  sequences: () => ((opts: RunOpts) => Promise<SequenceResult>)[];
}

export interface RunOpts {
  pgUrl?: string;
}

const crashOnce = (kind: OperationRow["kind"]) => {
  let crashed = false;
  return (op: OperationRow) => {
    if (op.kind === kind && !crashed) {
      crashed = true;
      throw new WorkerCrash(`worker died after ${kind} reached the provider`);
    }
  };
};

async function measure(w: World, checkoutId: string | null, submissions: number): Promise<Measures> {
  const rec: ReconRow | null = checkoutId ? await reconciliation(w.sql, checkoutId) : null;
  return {
    submissions,
    debits: w.bank.debitsAccepted(),
    orders: w.pos.ordersCreated(),
    registerPaid: w.pos.registerShowsPaid() ? "yes" : "no",
    paymentsAppliedAtRegister: w.pos.paymentsApplied(),
    movements: [...w.bank.ledger],
    bankNetCents: w.bank.netCents(),
    recordedNetCents: rec?.net_cash_cents,
    exposureCents: rec?.exposure_cents,
    outcome: rec?.outcome ?? "refused",
    reason: rec?.outcome_reason,
    openInvestigations: rec?.open_investigations,
  };
}

/** Runs the naive baseline against fresh simulators configured the same way. */
async function naive(
  setup: (bank: BankSimulator, pos: CovaSimulator) => void,
  opts: { pos?: CovaSimOptions; submissions?: number; savedRefId?: string; webhooks?: "duplicate" } = {},
): Promise<Measures & { belief: string }> {
  const bank = new BankSimulator({ idempotencyKeys: true });
  const pos = new CovaSimulator({ taxRate: 0.2, ...opts.pos });
  bank.enroll("consent_shopper_a");
  bank.enroll("consent_shopper_b");
  const db = newNaiveDb({ "ref-a": "consent_shopper_a", "ref-b": "consent_shopper_b" });
  setup(bank, pos);
  let belief = "";
  const n = opts.submissions ?? 1;
  for (let i = 0; i < n; i++) {
    belief = await naiveCheckout(db, bank, pos, {
      savedRefId: opts.savedRefId ?? "ref-a",
      cart: CART,
      amountCents: QUOTE_CENTS + FEE_CENTS,
    });
  }
  if (opts.webhooks) {
    bank.settleAllPending("2026-09-29");
    for (const e of bank.takeEvents()) {
      naiveWebhook(db, e);
      if (opts.webhooks === "duplicate") naiveWebhook(db, e);
    }
  }
  return {
    submissions: n,
    debits: bank.debitsAccepted(),
    orders: pos.ordersCreated(),
    registerPaid: pos.registerShowsPaid() ? "yes" : "no",
    paymentsAppliedAtRegister: pos.paymentsApplied(),
    movements: [...bank.ledger],
    bankNetCents: bank.netCents(),
    recordedNetCents: opts.webhooks ? db.paidCents : undefined,
    outcome: belief,
    belief,
  };
}

function seq(
  family: string,
  id: string,
  title: string,
  expectation: string,
  body: (opts: RunOpts) => Promise<Omit<SequenceResult, "family" | "id" | "title" | "expectation">>,
) {
  return (opts: RunOpts) => body(opts).then((r) => ({ family, id, title, expectation, ...r }));
}

const CHARGE = QUOTE_CENTS + FEE_CENTS;

// ------------------------------------------------------------------------------------------------
export const FAMILIES: Family[] = [
  {
    id: "double-submit",
    title: "Two checkout submissions for one cart",
    demonstrates: "One business payment intent; the module creates no second operation.",
    sequences: () => [
      seq(
        "double-submit",
        "1a",
        "Shopper taps Pay twice; the kiosk sends the same request id",
        "1 checkout, 1 debit, 1 order",
        async (o) => {
          const w = await makeWorld(o);
          const a = await w.checkout();
          const b = await w.checkout();
          await w.run();
          const id = a.ok ? a.checkoutId : null;
          const m = await measure(w, id, 2);
          const pass = a.ok && b.ok && a.checkoutId === b.checkoutId && !b.created && m.debits === 1 &&
            m.orders === 1;
          await w.close();
          return {
            module: m,
            naive: await naive(() => {}, { submissions: 2 }),
            pass,
            resolved: true,
            notes: [
              "On PGlite the two calls are serialized. The concurrent version runs on a Postgres server in tests/postgres_test.ts.",
            ],
          };
        },
      ),
      seq(
        "double-submit",
        "1b",
        "Two submissions arrive at the same moment",
        "1 checkout, 1 debit, 1 order",
        async (o) => {
          const w = await makeWorld(o);
          const [a, b] = await Promise.all([w.checkout(), w.checkout()]);
          await Promise.all([w.run(), w.run()]);
          const m = await measure(w, a.ok ? a.checkoutId : null, 2);
          const pass = a.ok && b.ok && a.checkoutId === b.checkoutId && m.debits === 1 && m.orders === 1;
          await w.close();
          return {
            module: m,
            pass,
            resolved: true,
            notes: [
              o.pgUrl
                ? "Ran on a Postgres server with a 10-connection pool."
                : "PGlite has one connection; this sequence is only meaningful on a server.",
            ],
          };
        },
      ),
    ],
  },
  {
    id: "lost-response",
    title: "Provider accepted, response lost, worker crashed",
    demonstrates: "Recovery with the original identity, or an explicit unresolved state.",
    sequences: () => [
      seq(
        "lost-response",
        "2a",
        "Bank accepts the capture; the response never arrives",
        "Retry sends the same key; 1 debit",
        async (o) => {
          const w = await makeWorld(o);
          w.bank.faults.capture = ["lose_response"];
          const r = await w.checkout();
          await w.run();
          const m = await measure(w, r.ok ? r.checkoutId : null, 1);
          await w.close();
          return {
            module: m,
            naive: await naive((bank) => (bank.faults.debit = ["lose_response"])),
            pass: m.debits === 1 && m.outcome === "ready_for_pickup",
            resolved: true,
            notes: [
              "The simulated provider returns the original result for a repeated key. That guarantee is listed as to confirm per provider.",
            ],
          };
        },
      ),
      seq(
        "lost-response",
        "2b",
        "Bank accepts; the worker dies before writing the result; a second worker resumes",
        "Same operation row, same key; 1 debit",
        async (o) => {
          const w = await makeWorld(o);
          const r = await w.checkout();
          await w.run({ afterCall: crashOnce("bank_capture") });
          const id = r.ok ? r.checkoutId : null;
          const m = await measure(w, id, 1);
          const ev = id ? await events(w.sql, id) : [];
          const reclaimed = ev.some((e) => e.type === "operation_reclaimed_after_lease_expiry");
          await w.close();
          return {
            module: m,
            pass: m.debits === 1 && reclaimed && m.outcome === "ready_for_pickup",
            resolved: true,
            notes: ["The lease expired after 60 s; the reclaim is in the event journal."],
          };
        },
      ),
      seq(
        "lost-response",
        "2c",
        "Same crash, but the provider cannot deduplicate a repeated key",
        "Not repeated; a person is asked to look",
        async (o) => {
          const w = await makeWorld({ ...o, bank: { idempotencyKeys: false } });
          const r = await w.checkout();
          await w.run({ afterCall: crashOnce("bank_capture") });
          const m = await measure(w, r.ok ? r.checkoutId : null, 1);
          await w.close();
          return {
            module: m,
            pass: m.debits === 1 && m.outcome === "needs_staff" && m.registerPaid === "no",
            resolved: false,
            notes: [
              "The money moved and the register shows the order unpaid. The module stops rather than guess; the correct ending is a person checking the provider dashboard.",
            ],
          };
        },
      ),
    ],
  },
  {
    id: "webhooks",
    title: "Duplicate, missing, reordered and invalid webhooks",
    demonstrates: "Invalid input rejected; repeats do not repeat effects; missing events are reconciled.",
    sequences: () => [
      seq("webhooks", "3a", "Every webhook delivered twice", "Settlement recorded once", async (o) => {
        const w = await makeWorld(o);
        const r = await w.checkout();
        await w.run();
        w.bank.settleAllPending("2026-09-29");
        const results = await w.deliver({ duplicate: true });
        const m = await measure(w, r.ok ? r.checkoutId : null, 1);
        await w.close();
        return {
          module: m,
          naive: await naive(() => {}, { webhooks: "duplicate" }),
          pass: m.recordedNetCents === m.bankNetCents && results.includes("duplicate_event"),
          resolved: true,
          notes: [`Delivery results: ${results.join(", ")}.`],
        };
      }),
      seq(
        "webhooks",
        "3b",
        "Return notice arrives before the settlement notice",
        "Both recorded; net is the same in either order",
        async (o) => {
          const w = await makeWorld(o);
          const r = await w.checkout();
          await w.run();
          const ref = [...w.bank.payments.keys()][0];
          w.bank.settle(ref, "2026-09-29");
          w.bank.returnDebit(ref, "R01", "2026-10-01");
          await recordHandoff(w.sql, w.clock, r.ok ? r.checkoutId : "", "budtender-3", null);
          const results = await w.deliver({ reverse: true });
          const m = await measure(w, r.ok ? r.checkoutId : null, 1);
          await w.close();
          return {
            module: m,
            pass: m.recordedNetCents === m.bankNetCents && m.exposureCents === CHARGE &&
              m.outcome === "needs_staff",
            resolved: false,
            notes: [
              `Delivery results: ${results.join(", ")}.`,
              "Goods were handed over, then the debit came back R01: the store is short and staff are told.",
            ],
          };
        },
      ),
      seq(
        "webhooks",
        "3c",
        "Settlement webhook never arrives",
        "The reconciler polls the provider and records it",
        async (o) => {
          const w = await makeWorld(o);
          const r = await w.checkout();
          await w.run();
          w.bank.settleAllPending("2026-09-29");
          await w.deliver({ drop: () => true });
          const before = (await reconciliation(w.sql, r.ok ? r.checkoutId : "")).settled_cents;
          const polled = await pollUnsettledCaptures(w.sql, w.clock, w.bank);
          const m = await measure(w, r.ok ? r.checkoutId : null, 1);
          await w.close();
          return {
            module: m,
            pass: before === 0 && polled === 1 && m.recordedNetCents === m.bankNetCents,
            resolved: true,
            notes: ["Recorded with source 'poll'; a late webhook for the same fact inserts nothing."],
          };
        },
      ),
      seq(
        "webhooks",
        "3d",
        "Forged, tampered and stale webhooks",
        "All rejected; nothing recorded",
        async (o) => {
          const w = await makeWorld(o);
          const r = await w.checkout();
          await w.run();
          const ref = [...w.bank.payments.keys()][0];
          const body = JSON.stringify({
            id: "evt_forged",
            type: "payment.returned",
            ref,
            amountCents: CHARGE,
            returnCode: "R10",
            effectiveDate: "2026-09-30",
          });
          const t = Math.floor(w.clock.now().getTime() / 1000);
          const forged = await ingestBankWebhook(w.sql, w.clock, WEBHOOK_SECRET, {
            rawBody: body,
            signatureHeader: await signWebhook("wrong-secret", body, t),
          });
          const good = await signWebhook(WEBHOOK_SECRET, body, t);
          const tampered = await ingestBankWebhook(w.sql, w.clock, WEBHOOK_SECRET, {
            rawBody: body.replace("R10", "R01"),
            signatureHeader: good,
          });
          const stale = await ingestBankWebhook(w.sql, w.clock, WEBHOOK_SECRET, {
            rawBody: body,
            signatureHeader: await signWebhook(WEBHOOK_SECRET, body, t - 3600),
          });
          const unsigned = await ingestBankWebhook(w.sql, w.clock, WEBHOOK_SECRET, {
            rawBody: body,
            signatureHeader: null,
          });
          const m = await measure(w, r.ok ? r.checkoutId : null, 1);
          await w.close();
          const all = [forged, tampered, stale, unsigned];
          return {
            module: m,
            pass: all.every((x) => x === "rejected_signature") && m.movements.length === 0 &&
              m.recordedNetCents === 0,
            resolved: true,
            notes: [`forged: ${forged}, tampered: ${tampered}, stale: ${stale}, unsigned: ${unsigned}.`],
          };
        },
      ),
    ],
  },
  {
    id: "order-rejected-or-unknown",
    title: "Payment approved, order rejected or unknown",
    demonstrates: "No instruction to pay again; bounded escalation without fictitious success.",
    sequences: () => [
      seq(
        "order-rejected-or-unknown",
        "4a",
        "Register rejects the order after the shopper approved payment",
        "Nothing captured; preauthorization voided",
        async (o) => {
          const w = await makeWorld({
            ...o,
            pos: {
              landOrderIn: "NonTransientProcessingFailure",
              rejectMessage: "Item GUM-100 not in the selling room",
            },
          });
          const r = await w.checkout();
          await w.run();
          const m = await measure(w, r.ok ? r.checkoutId : null, 1);
          const voided = [...w.bank.preauths.values()].every((p) => p.status === "voided");
          await w.close();
          return {
            module: m,
            naive: await naive(() => {}, { pos: { landOrderIn: "NonTransientProcessingFailure" } }),
            pass: m.debits === 0 && voided && m.outcome === "no_charge",
            resolved: true,
            notes: [
              "The naive baseline debits first and reports the order complete on the 202, although the register never created a usable order.",
            ],
          };
        },
      ),
      seq(
        "order-rejected-or-unknown",
        "4b",
        "Order submission times out; the register has no record yet",
        "Status checked by our GUID, resubmitted with the same GUID; 1 order",
        async (o) => {
          const w = await makeWorld(o);
          w.pos.faults.submit = ["drop_request"];
          const r = await w.checkout();
          await w.run();
          const m = await measure(w, r.ok ? r.checkoutId : null, 1);
          await w.close();
          return {
            module: m,
            naive: await naive((_b, pos) => (pos.faults.submit = ["lose_response"])),
            pass: m.orders === 1 && m.debits === 1 && m.outcome === "ready_for_pickup",
            resolved: true,
            notes: [
              "Resubmitting under the same GUID assumes Cova treats it as the same order. To confirm with Cova.",
            ],
          };
        },
      ),
      seq(
        "order-rejected-or-unknown",
        "4c",
        "Register never confirms the order",
        "Nothing captured; staff alerted after 5 minutes",
        async (o) => {
          const w = await makeWorld({ ...o, pos: { landOrderIn: "SubmittedForProcessing" } });
          const r = await w.checkout();
          await w.run();
          const m = await measure(w, r.ok ? r.checkoutId : null, 1);
          await w.close();
          return {
            module: m,
            pass: m.debits === 0 && m.outcome === "needs_staff",
            resolved: false,
            notes: ["The preauthorization is left in place for staff to decide; no funds moved."],
          };
        },
      ),
      seq(
        "order-rejected-or-unknown",
        "4d",
        "Cashier cancels the order between capture and the payment record",
        "Paid, order cancelled: refund decision for staff, no automatic refund",
        async (o) => {
          const w = await makeWorld(o);
          const r = await w.checkout();
          await w.run({
            afterCall: (op, call) => {
              if (op.kind === "bank_capture" && call.kind === "ok") {
                w.pos.cashierCancels([...w.pos.orders.keys()][0]);
              }
            },
          });
          const m = await measure(w, r.ok ? r.checkoutId : null, 1);
          await w.close();
          return {
            module: m,
            pass: m.debits === 1 && m.outcome === "needs_staff" && w.bank.refunds.size === 0,
            resolved: false,
            notes: [
              "A fixed-delay automatic refund would be unsafe here: the shopper may be standing at the counter.",
            ],
          };
        },
      ),
    ],
  },
  {
    id: "register-not-acknowledged",
    title: "Order exists, register does not show it paid",
    demonstrates: "A visible mismatch, not a green completed result.",
    sequences: () => [
      seq(
        "register-not-acknowledged",
        "5a",
        "Register refuses the payment record",
        "Staff told: paid by bank, do not collect again",
        async (o) => {
          const w = await makeWorld({ ...o, pos: { landPaymentIn: "PaymentCannotBeApplied" } });
          const r = await w.checkout();
          await w.run();
          const m = await measure(w, r.ok ? r.checkoutId : null, 1);
          const cashierCould = w.pos.cashierCollectsIfUnpaid([...w.pos.orders.keys()][0]);
          await w.close();
          return {
            module: m,
            naive: await naive(() => {}),
            pass: m.debits === 1 && m.registerPaid === "no" && m.outcome === "needs_staff",
            resolved: false,
            notes: [
              `The register still shows the order unpaid, so a cashier could collect again: ${
                cashierCould ? "yes" : "no"
              }. The module cannot prevent that; it can only say it loudly.`,
              "The naive baseline never records payment at the register at all.",
            ],
          };
        },
      ),
      seq(
        "register-not-acknowledged",
        "5b",
        "Payment record accepted, response lost",
        "Status read first; payment applied once",
        async (o) => {
          const w = await makeWorld(o);
          w.pos.faults.pay = ["lose_response"];
          const r = await w.checkout();
          await w.run();
          const m = await measure(w, r.ok ? r.checkoutId : null, 1);
          await w.close();
          return {
            module: m,
            pass: m.paymentsAppliedAtRegister === 1 && m.outcome === "ready_for_pickup",
            resolved: true,
            notes: [],
          };
        },
      ),
      seq(
        "register-not-acknowledged",
        "5c",
        "Staff try to hand over before the register shows payment",
        "Refused without a written reason",
        async (o) => {
          const w = await makeWorld({ ...o, pos: { landPaymentIn: "PaymentCannotBeApplied" } });
          const r = await w.checkout();
          await w.run();
          const id = r.ok ? r.checkoutId : "";
          const refused = await recordHandoff(w.sql, w.clock, id, "budtender-3", null);
          const withReason = await recordHandoff(
            w.sql,
            w.clock,
            id,
            "budtender-3",
            "Bank capture pay_0002 seen in provider dashboard; manager approved",
          );
          const m = await measure(w, id, 1);
          await w.close();
          return {
            module: m,
            pass: !refused.ok && withReason.ok,
            resolved: false,
            notes: [
              `Without reason: ${
                refused.ok ? "accepted" : refused.error
              }. With reason: accepted and journaled.`,
            ],
          };
        },
      ),
    ],
  },
  {
    id: "total-or-cancel",
    title: "Final total changes, or cancellation is unavailable",
    demonstrates: "No unauthorized amount change and no assumed compensation.",
    sequences: () => [
      seq(
        "total-or-cancel",
        "6a",
        "Register total is $6.00 higher than the kiosk quote",
        "Nothing captured above the approved amount; new approval needed",
        async (o) => {
          const w = await makeWorld({ ...o, pos: { saleTotalOverrideCents: QUOTE_CENTS + 600 } });
          const r = await w.checkout();
          await w.run();
          const m = await measure(w, r.ok ? r.checkoutId : null, 1);
          await w.close();
          return {
            module: m,
            pass: m.debits === 0 && m.outcome === "needs_new_consent",
            resolved: false,
            notes: ["Capturing more than the shopper approved is how an R11 return starts."],
          };
        },
      ),
      seq(
        "total-or-cancel",
        "6b",
        "Register total is $2.40 lower (a sale price applied)",
        "Capture the lower total, never the quote",
        async (o) => {
          const w = await makeWorld({ ...o, pos: { saleTotalOverrideCents: QUOTE_CENTS - 240 } });
          const r = await w.checkout();
          await w.run();
          const m = await measure(w, r.ok ? r.checkoutId : null, 1);
          const captured = [...w.bank.payments.values()][0]?.amountCents;
          await w.close();
          return {
            module: m,
            pass: captured === QUOTE_CENTS - 240 + FEE_CENTS && m.outcome === "ready_for_pickup",
            resolved: true,
            notes: [
              `Captured ${captured} cents: register total plus the fee. That a provider lets you capture less than the preauthorization is to confirm.`,
            ],
          };
        },
      ),
      seq(
        "total-or-cancel",
        "6c",
        "Preauthorization expires before capture",
        "Capture declined; unpaid order cancelled; nothing charged",
        async (o) => {
          const w = await makeWorld(o);
          const r = await w.checkout();
          await w.run({
            afterCall: (op) => {
              if (op.kind === "pos_check_order") {
                w.bank.expirePreauth([...w.bank.preauths.keys()][0], "2026-09-28");
              }
            },
          });
          const m = await measure(w, r.ok ? r.checkoutId : null, 1);
          const cancelled = [...w.pos.orders.values()][0]?.orderStatus === "Cancelled";
          await w.close();
          return {
            module: m,
            pass: m.debits === 0 && cancelled && m.outcome === "no_charge",
            resolved: true,
            notes: [],
          };
        },
      ),
      seq(
        "total-or-cancel",
        "6d",
        "Capture declined and the register refuses to cancel the unpaid order",
        "Staff told; nothing assumed",
        async (o) => {
          const w = await makeWorld({ ...o, pos: { refuseCancel: "inventory already allocated" } });
          const r = await w.checkout();
          await w.run({
            afterCall: (op) => {
              if (op.kind === "pos_check_order") {
                w.bank.expirePreauth([...w.bank.preauths.keys()][0], "2026-09-28");
              }
            },
          });
          const m = await measure(w, r.ok ? r.checkoutId : null, 1);
          await w.close();
          return {
            module: m,
            pass: m.debits === 0 && m.outcome === "needs_staff",
            resolved: false,
            notes: [
              "Refusal text modeled on Dutchie's documented rule (no cancel with allocated inventory); Cova documents cancel for unpaid orders.",
            ],
          };
        },
      ),
    ],
  },
  {
    id: "refund-vs-return",
    title: "Refund races a bank return, including after a restart",
    demonstrates: "Both outcomes recorded; no duplicate refund initiated locally; exposure stays visible.",
    sequences: () => [
      seq(
        "refund-vs-return",
        "7a",
        "Goods returned and refunded; the original debit also comes back R10",
        "Three movements kept; store is short by the full amount",
        async (o) => {
          const w = await makeWorld(o);
          const r = await w.checkout();
          const id = r.ok ? r.checkoutId : "";
          await w.run();
          await recordHandoff(w.sql, w.clock, id, "budtender-3", null);
          const ref = [...w.bank.payments.keys()][0];
          w.bank.settle(ref, "2026-09-29");
          await w.deliver();
          w.clock.advanceDays(2);
          await requestRefund(w.sql, w.clock, id, CHARGE, "goods_returned", "manager-1");
          await w.run();
          w.bank.settleRefunds("2026-10-01");
          w.clock.advanceDays(20);
          w.bank.returnDebit(ref, "R10", "2026-10-21");
          await w.deliver();
          const m = await measure(w, id, 1);
          await w.close();
          return {
            module: m,
            pass: m.movements.length === 3 && m.recordedNetCents === -CHARGE && m.exposureCents === CHARGE,
            resolved: false,
            notes: [
              "Plaid documents this case publicly: a refunded debit can still be returned, and the merchant is debited for both. Who bears it is set by the provider contract.",
            ],
          };
        },
      ),
      seq(
        "refund-vs-return",
        "7d",
        "An R01 return notice reaches us six days after settlement, after the 2-banking-day window",
        "Recorded anyway, flagged as a late notice",
        async (o) => {
          const w = await makeWorld(o);
          const r = await w.checkout();
          const id = r.ok ? r.checkoutId : "";
          await w.run();
          const ref = [...w.bank.payments.keys()][0];
          w.bank.settle(ref, "2026-09-29");
          await w.deliver();
          w.clock.advanceDays(7); // 2026-10-05
          w.bank.returnDebit(ref, "R01", "2026-10-01");
          await w.deliver();
          const ev = await events(w.sql, id);
          const flagged = ev.find((e) => e.type === "return_after_bank_deadline");
          const m = await measure(w, id, 1);
          await w.close();
          return {
            module: m,
            pass: !!flagged && m.recordedNetCents === 0,
            resolved: false,
            notes: [
              `Deadline for R01 after a 2026-09-29 settlement: ${
                (flagged?.detail as { deadlines?: { administrative?: string } })?.deadlines?.administrative ??
                  "?"
              }. The bank deadline is not the date our webhook arrives; the fact is kept either way.`,
            ],
          };
        },
      ),
      seq(
        "refund-vs-return",
        "7b",
        "Return arrives first; staff then try to refund",
        "Refund refused locally: the debit is already returned",
        async (o) => {
          const w = await makeWorld(o);
          const r = await w.checkout();
          const id = r.ok ? r.checkoutId : "";
          await w.run();
          const ref = [...w.bank.payments.keys()][0];
          w.bank.settle(ref, "2026-09-29");
          w.bank.returnDebit(ref, "R01", "2026-10-01");
          await w.deliver();
          const refund = await requestRefund(w.sql, w.clock, id, CHARGE, "goods_returned", "manager-1");
          const m = await measure(w, id, 1);
          await w.close();
          return {
            module: m,
            pass: !refund.ok && w.bank.refunds.size === 0,
            resolved: true,
            notes: [`Refund request: ${refund.ok ? "accepted" : refund.error}.`],
          };
        },
      ),
      seq(
        "refund-vs-return",
        "7c",
        "Two staff members press Refund; the first worker dies after the bank accepted",
        "One refund operation, one refund at the bank",
        async (o) => {
          const w = await makeWorld(o);
          const r = await w.checkout();
          const id = r.ok ? r.checkoutId : "";
          await w.run();
          w.bank.settle([...w.bank.payments.keys()][0], "2026-09-29");
          await w.deliver();
          const a = await requestRefund(w.sql, w.clock, id, CHARGE, "goods_returned", "manager-1");
          const b = await requestRefund(w.sql, w.clock, id, CHARGE, "goods_returned", "budtender-3");
          await w.run({ afterCall: crashOnce("bank_refund") });
          const m = await measure(w, id, 1);
          await w.close();
          return {
            module: m,
            pass: a.ok && a.created && b.ok && !b.created && w.bank.refunds.size === 1,
            resolved: true,
            notes: ["Partial and multiple refunds are outside this slice."],
          };
        },
      ),
    ],
  },
  {
    id: "saved-reference",
    title: "Saved reference of another shopper or store, or a revoked connection",
    demonstrates: "Access denied or reauthentication required; no debit under an unrelated identity.",
    sequences: () => [
      seq(
        "saved-reference",
        "8a",
        "Checkout with another shopper's saved bank reference",
        "Refused before any bank call",
        async (o) => {
          const w = await makeWorld(o);
          const r = await w.checkout({ savedRefId: w.otherShopperRefId });
          const m = await measure(w, null, 1);
          const calls = w.bank.calls.preauthorize;
          await w.close();
          return {
            module: { ...m, outcome: r.ok ? "accepted" : r.error },
            naive: await naive(() => {}, { savedRefId: "ref-b" }),
            pass: !r.ok && calls === 0,
            resolved: true,
            notes: ["The naive baseline debits shopper B's bank for shopper A's cart."],
          };
        },
      ),
      seq(
        "saved-reference",
        "8b",
        "Saved reference registered at a different store",
        "Refused",
        async (o) => {
          const w = await makeWorld(o);
          const [ref] = await w.sql.query<{ id: string }>(
            `insert into kiosk.saved_bank_refs (shopper_id, store_id, provider_consent_ref) values ($1, $2, 'consent_other_store') returning id`,
            [SHOPPER, OTHER_STORE],
          );
          const r = await w.checkout({ savedRefId: ref.id });
          const m = await measure(w, null, 1);
          await w.close();
          return {
            module: { ...m, outcome: r.ok ? "accepted" : r.error },
            pass: !r.ok,
            resolved: true,
            notes: [],
          };
        },
      ),
      seq(
        "saved-reference",
        "8c",
        "Bank connection revoked, then the shopper checks out",
        "Reauthentication required",
        async (o) => {
          const w = await makeWorld(o);
          w.bank.revokeConsent("consent_shopper_a", "2026-09-28");
          await w.deliver();
          const r = await w.checkout();
          const m = await measure(w, null, 1);
          await w.close();
          return {
            module: { ...m, outcome: r.ok ? "accepted" : r.error },
            pass: !r.ok && r.error === "reauthentication_required",
            resolved: true,
            notes: [],
          };
        },
      ),
      seq(
        "saved-reference",
        "8d",
        "Connection revoked at the bank between preauthorization and capture",
        "No debit; order cancelled; shopper asked to reconnect",
        async (o) => {
          const w = await makeWorld(o);
          const r = await w.checkout();
          await w.run({
            afterCall: (op) => {
              if (op.kind === "pos_check_order") w.bank.revokeConsent("consent_shopper_a", "2026-09-28");
            },
          });
          const m = await measure(w, r.ok ? r.checkoutId : null, 1);
          await w.close();
          return {
            module: m,
            pass: m.debits === 0 && m.outcome === "needs_new_consent",
            resolved: true,
            notes: [],
          };
        },
      ),
    ],
  },
];

export async function runAll(opts: RunOpts = {}): Promise<{ family: Family; results: SequenceResult[] }[]> {
  const out = [];
  for (const f of FAMILIES) {
    const results = [];
    for (const s of f.sequences()) results.push(await s(opts));
    out.push({ family: f, results });
  }
  return out;
}
