// Contract-shaped simulator of Cova's Sales Order API, not a certified integration.
//
// What it follows, from Cova's public documentation (read 28 Sep 2026, links in docs/discovery-note.md and docs/sources.md):
//   * The integrator generates the order GUID and sends it in the URL of PUT .../TEPCovaOrder({id}).
//   * The PUT returns 202 without validating; GET .../CovaOrder({id})/Status is the source of truth
//     (ReadyForPayment with saleTotal, or TransientProcessingFailure / NonTransientProcessingFailure).
//   * POST .../CovaOrderPayment marks the order paid; the amount must exactly match saleTotal.
//   * Paid orders cannot be modified or cancelled; unpaid orders can be cancelled.
//
// What it ASSUMES (listed as "to confirm" in docs/discovery-note.md):
//   * A second PUT with the same GUID does not create a second order.
//   * A second CovaOrderPayment on a paid order is refused rather than applied twice.
//   * "NotFound" on the status endpoint is how an order that never arrived looks.

import type { Call, CartLine, PosAdapter, PosOrderStatus, PosPaymentStatus, PosStatus } from "./types.ts";

export type Fault = "drop_request" | "lose_response" | "server_error";

interface SimOrder {
  id: string;
  lines: CartLine[];
  reference: string;
  orderStatus: PosOrderStatus;
  paymentStatus: PosPaymentStatus;
  saleTotalCents: number;
  paymentsApplied: { amountCents: number; paymentRef: string }[];
  counterCollections: number;
  message?: string;
}

export interface CovaSimOptions {
  taxRate?: number; // fictional
  /** Status the order lands in after the PUT. Default ReadyForPayment (synchronous model). */
  landOrderIn?: PosOrderStatus;
  rejectMessage?: string;
  /** Sale total the register computes, when it differs from the kiosk quote. */
  saleTotalOverrideCents?: number;
  /** Payment status the register lands in after CovaOrderPayment. Default PaymentApplied. */
  landPaymentIn?: PosPaymentStatus;
  /** Honor a repeated PUT with the same GUID as the same order (assumption). */
  putIsIdempotentById?: boolean;
  /** Simulate a payment-reference lookup Cova does not document (default false). */
  exposesPaymentReferences?: boolean;
  /** Declared capability: re-sending under the same GUID is safe (default true, to confirm). */
  declareIdempotentSubmit?: boolean;
  /** Make cancellation unavailable, e.g. inventory already allocated (Dutchie documents this case). */
  refuseCancel?: string;
}

export class CovaSimulator implements PosAdapter {
  readonly name = "cova-contract-simulator";
  get capabilities() {
    return {
      paymentReferenceLookup: this.opts.exposesPaymentReferences === true,
      idempotentSubmitById: this.opts.declareIdempotentSubmit !== false,
    };
  }
  readonly orders = new Map<string, SimOrder>();
  readonly faults: Partial<Record<"submit" | "status" | "pay" | "cancel", Fault[]>> = {};
  readonly calls = { submit: 0, status: 0, pay: 0, cancel: 0 };
  #statusScript: PosOrderStatus[] = [];
  constructor(readonly opts: CovaSimOptions = {}) {}

  /** Next getStatus calls will report these order states, in order, before the real one. */
  scriptStatuses(...s: PosOrderStatus[]) {
    this.#statusScript.push(...s);
  }

  static subtotal(lines: CartLine[]) {
    return lines.reduce((a, l) => a + l.lineCents, 0);
  }
  static total(lines: CartLine[], taxRate: number) {
    return Math.round(CovaSimulator.subtotal(lines) * (1 + taxRate));
  }

  #fault(m: keyof CovaSimulator["faults"]): Fault | undefined {
    return this.faults[m]?.shift();
  }

  submitOrder(
    req: { posOrderId: string; lines: CartLine[]; reference: string },
  ): Promise<Call<Record<string, never>>> {
    this.calls.submit++;
    const f = this.#fault("submit");
    if (f === "drop_request" || f === "server_error") return Promise.resolve({ kind: "unknown", reason: f });
    const existing = this.orders.get(req.posOrderId);
    if (existing && this.opts.putIsIdempotentById !== false) {
      // same GUID: no second order (assumption, see header)
    } else {
      const land = this.opts.landOrderIn ?? "ReadyForPayment";
      const id = existing ? `${req.posOrderId}#dup${this.orders.size}` : req.posOrderId;
      this.orders.set(id, {
        id,
        lines: req.lines,
        reference: req.reference,
        orderStatus: land,
        paymentStatus: land === "ReadyForPayment" ? "ReadyForPayment" : "NotReadyForPayment",
        saleTotalCents: this.opts.saleTotalOverrideCents ??
          CovaSimulator.total(req.lines, this.opts.taxRate ?? 0.2),
        paymentsApplied: [],
        counterCollections: 0,
        message: land === "NonTransientProcessingFailure"
          ? (this.opts.rejectMessage ?? "Invalid order")
          : undefined,
      });
    }
    if (f === "lose_response") return Promise.resolve({ kind: "unknown", reason: "response lost after 202" });
    return Promise.resolve({ kind: "ok", value: {}, raw: { http: 202 } });
  }

  getStatus(posOrderId: string): Promise<Call<PosStatus>> {
    this.calls.status++;
    const f = this.#fault("status");
    if (f) return Promise.resolve({ kind: "unknown", reason: f });
    const o = this.orders.get(posOrderId);
    const scripted = this.#statusScript.shift();
    if (scripted) {
      return Promise.resolve({
        kind: "ok",
        value: { orderStatus: scripted, paymentStatus: "NotReadyForPayment", saleTotalCents: null },
      });
    }
    if (!o) {
      return Promise.resolve({
        kind: "ok",
        value: { orderStatus: "NotFound", paymentStatus: "NotReadyForPayment", saleTotalCents: null },
      });
    }
    return Promise.resolve({
      kind: "ok",
      value: {
        orderStatus: o.orderStatus,
        paymentStatus: o.paymentStatus,
        saleTotalCents: o.orderStatus === "ReadyForPayment" || o.orderStatus === "Completed"
          ? o.saleTotalCents
          : null,
        message: o.message,
        payments: this.opts.exposesPaymentReferences
          ? o.paymentsApplied.map((p) => ({ ref: p.paymentRef, amountCents: p.amountCents }))
          : undefined,
      },
    });
  }

  applyPayment(
    req: { posOrderId: string; amountCents: number; paymentRef: string },
  ): Promise<Call<Record<string, never>>> {
    this.calls.pay++;
    const f = this.#fault("pay");
    if (f === "drop_request" || f === "server_error") return Promise.resolve({ kind: "unknown", reason: f });
    const o = this.orders.get(req.posOrderId);
    if (!o || o.orderStatus !== "ReadyForPayment") {
      return Promise.resolve({
        kind: "rejected",
        reason: "order is not ready for payment",
        raw: { http: 400 },
      });
    }
    if (o.paymentStatus === "PaymentApplied") {
      return Promise.resolve({ kind: "rejected", reason: "order already paid", raw: { http: 400 } });
    }
    if (req.amountCents !== o.saleTotalCents) {
      return Promise.resolve({ kind: "rejected", reason: "amount must equal saleTotal", raw: { http: 400 } });
    }
    const land = this.opts.landPaymentIn ?? "PaymentApplied";
    o.paymentStatus = land;
    if (land === "PaymentApplied") {
      o.paymentsApplied.push({ amountCents: req.amountCents, paymentRef: req.paymentRef });
    }
    if (land === "PaymentCannotBeApplied") o.message = "Payment type not configured for this location";
    if (f === "lose_response") return Promise.resolve({ kind: "unknown", reason: "response lost after 202" });
    return Promise.resolve({ kind: "ok", value: {}, raw: { http: 202 } });
  }

  cancelOrder(posOrderId: string): Promise<Call<Record<string, never>>> {
    this.calls.cancel++;
    const f = this.#fault("cancel");
    if (f === "drop_request" || f === "server_error") return Promise.resolve({ kind: "unknown", reason: f });
    const o = this.orders.get(posOrderId);
    if (!o) return Promise.resolve({ kind: "rejected", reason: "order not found", raw: { http: 404 } });
    if (o.paymentStatus === "PaymentApplied") {
      return Promise.resolve({
        kind: "rejected",
        reason: "paid orders cannot be cancelled",
        raw: { http: 400 },
      });
    }
    if (this.opts.refuseCancel) {
      return Promise.resolve({ kind: "rejected", reason: this.opts.refuseCancel, raw: { http: 400 } });
    }
    o.orderStatus = "Cancelled";
    if (f === "lose_response") return Promise.resolve({ kind: "unknown", reason: "response lost" });
    return Promise.resolve({ kind: "ok", value: {} });
  }

  // ---- things a person does at the register, outside the module ----
  cashierCancels(posOrderId: string) {
    const o = this.orders.get(posOrderId);
    if (o && o.paymentStatus !== "PaymentApplied") o.orderStatus = "Cancelled";
  }
  /** The register shows the order unpaid and the cashier takes payment at the counter. */
  cashierCollectsIfUnpaid(posOrderId: string): boolean {
    const o = this.orders.get(posOrderId);
    if (o && o.orderStatus === "ReadyForPayment" && o.paymentStatus !== "PaymentApplied") {
      o.counterCollections++;
      return true;
    }
    return false;
  }

  /** The cashier takes cash for the order and records it at the register. */
  cashierTakesCashAndRecords(posOrderId: string) {
    const o = this.orders.get(posOrderId);
    if (!o || o.paymentStatus === "PaymentApplied") return;
    o.counterCollections++;
    o.paymentStatus = "PaymentApplied";
    o.paymentsApplied.push({ amountCents: o.saleTotalCents, paymentRef: "cash-drawer" });
  }

  // ---- ground truth for the bench ----
  ordersCreated() {
    return this.orders.size;
  }
  registerShowsPaid(): boolean {
    return [...this.orders.values()].some((o) => o.paymentStatus === "PaymentApplied");
  }
  counterPayments() {
    return [...this.orders.values()].reduce((a, o) => a + o.counterCollections, 0);
  }
  paymentsApplied() {
    return [...this.orders.values()].reduce((a, o) => a + o.paymentsApplied.length, 0);
  }
}
