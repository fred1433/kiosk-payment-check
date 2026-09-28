// Ports for the two external systems. Every call returns one of four shapes. "unknown" is the
// important one: a timeout, a 5xx or a dropped connection means the effect may or may not have
// happened, and the caller must not treat it as a failure.

export type Call<T> =
  | { kind: "ok"; value: T; raw?: unknown }
  | { kind: "declined"; reason: string; raw?: unknown } // the provider said no (business decision)
  | { kind: "rejected"; reason: string; raw?: unknown } // our request was invalid (4xx)
  | { kind: "unknown"; reason: string }; // outcome not known

// ------------------------------------------------------------------------------------------
// Bank payment provider. Generic pay-by-bank shape: consent, preauthorization (no funds move),
// capture (funds move), refund, lookup. Modeled on concepts that providers document publicly
// (see docs/discovery-note.md); it is NOT any provider's contract.
// ------------------------------------------------------------------------------------------
export interface BankCapabilities {
  /** The provider returns the original result when the same idempotency key is sent again. */
  idempotencyKeys: boolean;
}

export type BankPaymentStatus =
  | { status: "pending"; amountCents: number }
  | { status: "settled"; amountCents: number; settledOn: string }
  | { status: "returned"; amountCents: number; settledOn?: string; returnCode: string; returnedOn: string };

export interface BankAdapter {
  readonly capabilities: BankCapabilities;
  preauthorize(req: { operationKey: string; consentRef: string; amountCents: number }): Promise<
    Call<{ preauthRef: string }>
  >;
  capture(req: { operationKey: string; preauthRef: string; amountCents: number }): Promise<
    Call<{ paymentRef: string }>
  >;
  voidPreauth(req: { operationKey: string; preauthRef: string }): Promise<Call<Record<string, never>>>;
  refund(req: { operationKey: string; paymentRef: string; amountCents: number }): Promise<
    Call<{ refundRef: string }>
  >;
  getPayment(paymentRef: string): Promise<Call<BankPaymentStatus>>;
}

// ------------------------------------------------------------------------------------------
// POS. Shaped on Cova's public Sales Order documentation (caller-generated order GUID, status
// endpoint as source of truth, CovaOrderPayment with an amount that must equal the sale total).
// ------------------------------------------------------------------------------------------
export type PosOrderStatus =
  | "NotFound"
  | "SubmittedForProcessing"
  | "SubmittedForFinalProcessing"
  | "ReadyForPayment"
  | "TransientProcessingFailure"
  | "NonTransientProcessingFailure"
  | "Cancelled"
  | "Completed";

export type PosPaymentStatus =
  | "NotReadyForPayment"
  | "ReadyForPayment"
  | "PaymentSubmittedForProcessing"
  | "PaymentApplied"
  | "PaymentCannotBeApplied"
  | "TransientProcessingFailure"
  | "NonTransientProcessingFailure";

export interface PosStatus {
  orderStatus: PosOrderStatus;
  paymentStatus: PosPaymentStatus;
  saleTotalCents: number | null;
  message?: string;
}

export interface CartLine {
  name: string;
  sku: string;
  qty: number;
  lineCents: number;
}

export interface PosAdapter {
  readonly name: string;
  submitOrder(
    req: { posOrderId: string; lines: CartLine[]; reference: string },
  ): Promise<Call<Record<string, never>>>;
  getStatus(posOrderId: string): Promise<Call<PosStatus>>;
  applyPayment(req: { posOrderId: string; amountCents: number; paymentRef: string }): Promise<
    Call<Record<string, never>>
  >;
  cancelOrder(posOrderId: string): Promise<Call<Record<string, never>>>;
}
