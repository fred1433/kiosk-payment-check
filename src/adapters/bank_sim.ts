// Simulated pay-by-bank provider. It is a generic shape (consent, preauthorization without
// funds movement, capture, refund, lookup, signed webhooks), not any provider's contract.
// The bench drives settlement, returns and webhook delivery explicitly.

import type { BankAdapter, BankCapabilities, BankPaymentStatus, Call } from "./types.ts";
import type { Fault } from "./cova_sim.ts";

export interface BankEvent {
  id: string;
  type: "payment.settled" | "payment.returned" | "refund.settled" | "preauth.expired" | "consent.revoked";
  ref: string;
  amountCents: number;
  returnCode?: string;
  effectiveDate: string; // YYYY-MM-DD
}

export interface LedgerLine {
  kind: "settlement" | "refund" | "return";
  ref: string;
  amountCents: number; // signed, from the store's point of view
  on: string;
  returnCode?: string;
}

interface Preauth {
  ref: string;
  consentRef: string;
  amountCents: number;
  status: "active" | "captured" | "voided" | "expired";
}
interface Payment {
  ref: string;
  preauthRef?: string;
  amountCents: number;
  status: "pending" | "settled" | "returned";
  settledOn?: string;
  returnCode?: string;
  returnedOn?: string;
}
interface Refund {
  ref: string;
  paymentRef: string;
  amountCents: number;
  status: "pending" | "settled";
  settledOn?: string;
}

export class BankSimulator implements BankAdapter {
  readonly consents = new Map<string, { revoked: boolean }>();
  readonly preauths = new Map<string, Preauth>();
  readonly payments = new Map<string, Payment>();
  readonly refunds = new Map<string, Refund>();
  readonly ledger: LedgerLine[] = [];
  readonly outbox: BankEvent[] = [];
  readonly faults: Partial<
    Record<"preauthorize" | "capture" | "void" | "refund" | "get" | "debit", Fault[]>
  > = {};
  readonly calls = { preauthorize: 0, capture: 0, void: 0, refund: 0, get: 0, debit: 0 };
  /** When set, every new preauthorization, capture or debit is declined with this reason. */
  declineReason: string | null = null;
  #idem = new Map<string, Call<unknown>>();
  #n = 0;
  constructor(readonly capabilities: BankCapabilities = { idempotencyKeys: true }) {}

  #id(prefix: string) {
    return `${prefix}_${(++this.#n).toString().padStart(4, "0")}`;
  }
  #fault(m: keyof BankSimulator["faults"]) {
    return this.faults[m]?.shift();
  }
  #emit(e: Omit<BankEvent, "id">) {
    this.outbox.push({ ...e, id: this.#id("evt") });
  }

  /** Runs `effect` once per idempotency key (when supported) and applies the fault script. */
  #call<T>(method: keyof BankSimulator["faults"], key: string, effect: () => Call<T>): Promise<Call<T>> {
    const f = this.#fault(method);
    if (f === "drop_request" || f === "server_error") return Promise.resolve({ kind: "unknown", reason: f });
    let result: Call<T>;
    const seen = this.capabilities.idempotencyKeys ? this.#idem.get(`${method}:${key}`) : undefined;
    if (seen) {
      result = seen as Call<T>;
    } else {
      result = effect();
      if (this.capabilities.idempotencyKeys) this.#idem.set(`${method}:${key}`, result);
    }
    if (f === "lose_response") {
      return Promise.resolve({ kind: "unknown", reason: "response lost after provider accepted" });
    }
    return Promise.resolve(result);
  }

  enroll(consentRef: string) {
    this.consents.set(consentRef, { revoked: false });
  }

  preauthorize(req: { operationKey: string; consentRef: string; amountCents: number }) {
    this.calls.preauthorize++;
    return this.#call<{ preauthRef: string }>("preauthorize", req.operationKey, () => {
      const c = this.consents.get(req.consentRef);
      if (!c) return { kind: "rejected", reason: "unknown consent" };
      if (c.revoked) return { kind: "declined", reason: "consent_revoked" };
      if (this.declineReason) return { kind: "declined", reason: this.declineReason };
      const ref = this.#id("pa");
      this.preauths.set(ref, {
        ref,
        consentRef: req.consentRef,
        amountCents: req.amountCents,
        status: "active",
      });
      return { kind: "ok", value: { preauthRef: ref }, raw: { status: "PREAUTHORIZED" } };
    });
  }

  capture(req: { operationKey: string; preauthRef: string; amountCents: number }) {
    this.calls.capture++;
    return this.#call<{ paymentRef: string }>("capture", req.operationKey, () => {
      const p = this.preauths.get(req.preauthRef);
      if (!p) return { kind: "rejected", reason: "unknown preauthorization" };
      if (this.consents.get(p.consentRef)?.revoked) return { kind: "declined", reason: "consent_revoked" };
      if (p.status === "expired") return { kind: "declined", reason: "preauth_expired" };
      if (p.status !== "active") return { kind: "declined", reason: `preauth_${p.status}` };
      if (req.amountCents > p.amountCents) return { kind: "declined", reason: "exceeds_preauthorization" };
      if (this.declineReason) return { kind: "declined", reason: this.declineReason };
      p.status = "captured";
      const ref = this.#id("pay");
      this.payments.set(ref, { ref, preauthRef: p.ref, amountCents: req.amountCents, status: "pending" });
      return { kind: "ok", value: { paymentRef: ref }, raw: { status: "PENDING" } };
    });
  }

  /** Direct debit without preauthorization. Only the naive baseline uses it. */
  debit(req: { operationKey: string; consentRef: string; amountCents: number }) {
    this.calls.debit++;
    return this.#call<{ paymentRef: string }>("debit", req.operationKey, () => {
      const c = this.consents.get(req.consentRef);
      if (!c || c.revoked) return { kind: "declined", reason: "consent_revoked" };
      if (this.declineReason) return { kind: "declined", reason: this.declineReason };
      const ref = this.#id("pay");
      this.payments.set(ref, { ref, amountCents: req.amountCents, status: "pending" });
      return { kind: "ok", value: { paymentRef: ref } };
    });
  }

  voidPreauth(req: { operationKey: string; preauthRef: string }) {
    this.calls.void++;
    return this.#call<Record<string, never>>("void", req.operationKey, () => {
      const p = this.preauths.get(req.preauthRef);
      if (!p) return { kind: "rejected", reason: "unknown preauthorization" };
      if (p.status === "active") p.status = "voided";
      return { kind: "ok", value: {} };
    });
  }

  refund(req: { operationKey: string; paymentRef: string; amountCents: number }) {
    this.calls.refund++;
    return this.#call<{ refundRef: string }>("refund", req.operationKey, () => {
      const pay = this.payments.get(req.paymentRef);
      if (!pay) return { kind: "rejected", reason: "unknown payment" };
      // Same rule Plaid documents publicly: returned transfers cannot be refunded.
      if (pay.status === "returned") return { kind: "declined", reason: "payment_returned" };
      const ref = this.#id("rf");
      this.refunds.set(ref, { ref, paymentRef: pay.ref, amountCents: req.amountCents, status: "pending" });
      return { kind: "ok", value: { refundRef: ref } };
    });
  }

  getRefund(
    refundRef: string,
  ): Promise<Call<{ status: "pending" | "settled"; amountCents: number; settledOn?: string }>> {
    const r = this.refunds.get(refundRef);
    if (!r) return Promise.resolve({ kind: "rejected", reason: "unknown refund" });
    return Promise.resolve({
      kind: "ok",
      value: { status: r.status, amountCents: r.amountCents, settledOn: r.settledOn },
    });
  }

  getPayment(paymentRef: string): Promise<Call<BankPaymentStatus>> {
    this.calls.get++;
    const f = this.#fault("get");
    if (f) return Promise.resolve({ kind: "unknown", reason: f });
    const p = this.payments.get(paymentRef);
    if (!p) return Promise.resolve({ kind: "rejected", reason: "unknown payment" });
    if (p.status === "returned") {
      return Promise.resolve({
        kind: "ok",
        value: {
          status: "returned",
          amountCents: p.amountCents,
          settledOn: p.settledOn,
          returnCode: p.returnCode!,
          returnedOn: p.returnedOn!,
        },
      });
    }
    if (p.status === "settled") {
      return Promise.resolve({
        kind: "ok",
        value: { status: "settled", amountCents: p.amountCents, settledOn: p.settledOn! },
      });
    }
    return Promise.resolve({ kind: "ok", value: { status: "pending", amountCents: p.amountCents } });
  }

  // ---------------- bench controls: what the bank network does later ----------------
  settle(paymentRef: string, on: string) {
    const p = this.payments.get(paymentRef)!;
    if (p.status !== "pending") return;
    p.status = "settled";
    p.settledOn = on;
    this.ledger.push({ kind: "settlement", ref: p.ref, amountCents: p.amountCents, on });
    this.#emit({ type: "payment.settled", ref: p.ref, amountCents: p.amountCents, effectiveDate: on });
  }
  settleAllPending(on: string) {
    for (const p of this.payments.values()) if (p.status === "pending") this.settle(p.ref, on);
  }
  returnDebit(paymentRef: string, code: string, on: string) {
    const p = this.payments.get(paymentRef)!;
    p.status = "returned";
    p.returnCode = code;
    p.returnedOn = on;
    this.ledger.push({ kind: "return", ref: p.ref, amountCents: -p.amountCents, on, returnCode: code });
    this.#emit({
      type: "payment.returned",
      ref: p.ref,
      amountCents: p.amountCents,
      returnCode: code,
      effectiveDate: on,
    });
  }
  settleRefunds(on: string) {
    for (const r of this.refunds.values()) {
      if (r.status !== "pending") continue;
      r.status = "settled";
      r.settledOn = on;
      this.ledger.push({ kind: "refund", ref: r.ref, amountCents: -r.amountCents, on });
      this.#emit({ type: "refund.settled", ref: r.ref, amountCents: r.amountCents, effectiveDate: on });
    }
  }
  expirePreauth(preauthRef: string, on: string) {
    const p = this.preauths.get(preauthRef)!;
    if (p.status !== "active") return;
    p.status = "expired";
    this.#emit({ type: "preauth.expired", ref: p.ref, amountCents: p.amountCents, effectiveDate: on });
  }
  revokeConsent(consentRef: string, on: string) {
    this.consents.get(consentRef)!.revoked = true;
    this.#emit({ type: "consent.revoked", ref: consentRef, amountCents: 0, effectiveDate: on });
  }
  takeEvents(): BankEvent[] {
    return this.outbox.splice(0, this.outbox.length);
  }

  // ---------------- ground truth for the bench ----------------
  debitsAccepted() {
    return this.payments.size;
  }
  netCents() {
    return this.ledger.reduce((a, l) => a + l.amountCents, 0);
  }
}
