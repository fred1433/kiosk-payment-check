# Feasibility note: bank payments at a cannabis kiosk

Public sources only, read on **28 September 2026**. This is documentary review, not provider
approval, not a live API test, and not an assessment of any private codebase. Every line says what
the source establishes, what it does not, who can settle it, and whether it blocks a pilot.

The requirement, restated: the shopper should not have to **create and manage a separate provider
login or install another app**. Provider records, identity checks, consent and merchant onboarding
are allowed. So each route is judged on the whole life of a shopper, not the first checkout: first
purchase, returning purchase, expired bank connection, shopper who already has a provider account,
disputed debit, and recovery after a failed payment.

## Payment routes

| Route | What the public source establishes | Not established | Who can settle it | Blocks a pilot? |
|---|---|---|---|---|
| **Aeropay** | White-label user creation through the API with a merchant-scoped token (`POST /v2/user`); an `Idempotency-Key` header in the request examples; and preauthorized transactions: "Preauthorized transactions do not initiate the movement of any funds, but instead store the details of a transaction that must be captured later by an employee." [dev.aero.inc/docs/api-quick-start](https://dev.aero.inc/docs/api-quick-start) | Whether an unattended kiosk flow can capture by API: the documented flow has **an employee** capture the preauthorization, which a kiosk without staff at the moment of payment does not have. Also whether the kiosk company, as a platform, may originate for several retailers: the merchant terms prohibit initiating "transactions on behalf of others (Nested Third-Party Senders)". [Merchant terms](https://www.aeropay.com/legal/terms-of-service---merchant) | Aeropay, in writing, for the platform, retailer, provider structure and the capture step | **Yes**, until both are answered |
| Aeropay, recovery | For returns R02, R16, R20, R29 the merchant help center tells the customer to **log in to Aeropay** and change bank account; R03, R04, R17 go through an emailed form. [help.aeropay.com](https://help.aeropay.com/a-34-understanding-payment-status-type-and-declines) | Whether a white-label integration can keep recovery inside the kiosk platform's experience | Aeropay | **Yes** for "one platform-facing experience" |
| Aeropay, fees and returns | The merchant may charge consumers a service fee "no higher than Aeropay charges you". For merchants who elect **non guaranteed ACH**: "Merchant agrees to fund a reserve account at an amount provided by Aeropay and based on projected volumes. Merchant will reimburse Aeropay weekly for all returned payments through an auto debit initiated by Aeropay. Merchant agrees that they will not attempt to recover on any returned payments. Aeropay will attempt to recover any returned payments and will retain 25% of the payments recovered." Other terms depend on the product elected. [Merchant terms](https://www.aeropay.com/legal/terms-of-service---merchant) | Which product a pilot would be on (guaranteed or not), the reserve amount, and who is debited for a return: retailer, platform or Aeropay. Under non guaranteed ACH the store may not chase a returned payment itself, which changes what a staff screen should offer | Aeropay, the platform, the pilot retailer | Yes for the fee design and the returns screen |
| Aeropay, cannabis | `aeropay.com/cannabis` now redirects to `/specialized-retail`; the text we read there discusses CBD companies. [aeropay.com/specialized-retail](https://www.aeropay.com/specialized-retail) | Current acceptance of licensed THC retail in the pilot state, at a kiosk, through a platform | Aeropay, in writing | **Yes** |
| **CanPay RemotePay** | CanPay lists "Kiosk" among its payment contexts. RemotePay lets consumers prepay "on participating merchants' websites and apps, either through one-click payments or via guest checkout", and merchants "can modify transaction amounts up or down". [canpaydebit.com](https://www.canpaydebit.com/), [RemotePay](https://www.canpaydebit.com/remotepay/) | Whether guest checkout supports a saved reference tied to the kiosk platform's shopper profile, how returning shoppers authenticate, recovery, integration access for a platform, fees | CanPay | Not yet known |
| **Dutchie Pay by Bank** | Now "Pay by Bank, powered by Plaid". It "does not support funds reimbursement. Voiding or returning in the POS does not cancel or reverse the transaction"; refunds are cash or store credit. [Dutchie support](https://support.dutchie.com/hc/en-us/articles/27912721247507-How-do-I-void-or-issue-a-refund-for-a-Pay-by-Bank-order) | Whether a third-party kiosk can use it, and whether a partner program behaves differently | Dutchie | Yes for refunds by bank; relevant only to a Dutchie pilot store |

## Register integration (one adapter, chosen: Cova)

| POS | What the public source establishes | Not established | Blocks? |
|---|---|---|---|
| **Cova** (simulated here) | The integrator generates the order GUID (`PUT .../TEPCovaOrder({id})`, 202 without validation); the status endpoint is the source of truth (`ReadyForPayment` with `saleTotal`, or failure states); `POST v1/CovaOrderPayment` marks the order paid and the amount "must exactly match the saleTotal"; "Paid orders cannot be modified or cancelled"; onboarding creates Online Payment types matching the order source name: the guide's example source "LOTR Online" gets an associated "LOTR Online Payment" (a kiosk source such as "LOTR Kiosk" would get its own); if the names do not match, the default payment type is "Online Payment". [Sales Orders guide](https://api.covasoft.net/Content/pdf/SalesOrders.pdf), [CovaOrderPayment](https://api.covasoft.net/Documentation/Api/POST-v1-CovaOrderPayment). Cova is moving order submission to synchronous processing; "a 200-level response does not guarantee successful order submission", the status endpoint stays the truth. [Notice](https://api.covasoft.net/GatewayNotice/SynchronousOrders) | That a repeated PUT with the same GUID never creates a second order; that a repeated CovaOrderPayment on a paid order is refused; how a later bank return or refund is recorded in Cova | Not for a simulation; yes for production |
| Dutchie POS | `POST /preorder/submit`: "Payment occurs later at pickup/delivery, not during creation"; 120 requests per minute. Idempotency needs **both** the `ConsumerKey` header and `IdempotencyKey` (36 characters at most); missing either silently disables it; the key is stored "upon successful completion". `GET /preorder/Status` takes a PreOrderId, or returns all open orders of the last 14 days; no lookup by external reference. Cancel requires no allocated inventory. [swagger v1.0.0](https://api.pos.dutchie.com/swagger/v001/swagger.json). Keys go to certified partners, requested by the retailer's account administrator. [Dutchie support](https://support.dutchie.com/hc/en-us/articles/27660267271187-Dutchie-POS-API-key-request-process-for-third-party-integrations) | How a kiosk-paid preorder is shown as paid at the register (note field, separate transaction, Pay by Bank). Until that is known the register may ask the shopper to pay again | **Yes**: "payment not acknowledged by the register" |
| Treez | The public reference (v3.1.0) lists ticket endpoints (create, preview, update, get by order number) next to legacy v2 docs. [code.treez.io/reference](https://code.treez.io/reference) | Which Treez API the platform already uses; how an external payment is recorded on a ticket; cancellation, lookup and idempotency behavior; partner certification (not re-read by us). Nothing here is written from memory | Treez | Not yet known |

Why Cova for the simulated adapter: it is the one public contract that documents a way to tell the
register an order is paid (CovaOrderPayment with an integration-specific payment type), a caller
generated order id we can use to look an order up after a timeout, and an amount check. The pilot
POS should still follow access and store feasibility.

## ACH rules that shape the code

- **Authorization exists in ACH.** The shopper's consent to debit is an authorization; what it does
  not create is a card-style hold of funds. Keep separate: consent, provider acceptance or
  preauthorization, funds movement, settlement, possible later return.
- **Return windows** (Plaid, [return codes](https://support.plaid.com/hc/en-us/articles/32881797799575-What-are-the-Common-ACH-Return-Codes)):
  unless noted, 2 banking days from the **settlement date** of the original debit (R01 to R04, R09);
  consumer unauthorized returns R05, R07, R10, R11 use the 60-day window. R11 means a valid
  authorization but a debit that did not match it, for example the amount: relevant to fees and to
  any total that changes after approval.
- **A refunded debit can still be returned.** Plaid: "If a debit transfer that you have refunded is
  later returned by the payment network, you may be debited for both the return and for the refund."
  [Plaid refunds](https://plaid.com/docs/transfer/refunds/). No local lock prevents that.
- **Nacha rules in force in 2026.** WEB debit account validation (effective 19 March 2021): account
  validation is part of fraud screening and, in Nacha's words, "should apply to the first use of an
  account number and subsequent account number changes".
  [Nacha](https://www.nacha.org/rules/supplementing-fraud-detection-standards-web-debits).
  New in 2026: fraud monitoring Phase 2 applies to all remaining non-consumer originators,
  third-party service providers and senders; effective 19 June 2026, practically Monday 22 June 2026.
  [Nacha](https://www.nacha.org/rules/risk-management-topics-fraud-monitoring-phase-2). Which
  participant (kiosk platform, retailer, provider) holds each obligation depends on their roles: to confirm.

## Open questions, in the order they block

1. Aeropay: written position on licensed THC retail, kiosk, platform structure (nested senders), and
   how a preauthorization is captured without an employee at the kiosk.
2. The register: how "paid at the kiosk" is recorded, per POS, in a way the cashier sees.
3. Recovery after a failed or returned payment without a provider login.
4. Fee: who charges it, who receives it, inside the debit or separate, refundable or not, under which agreement.
5. Return liability: guaranteed or non-guaranteed product, and who is debited.
6. Provider guarantees this code relies on: same result for a repeated idempotency key; capture of
   less than the preauthorized amount; preauthorization expiry; webhook signature scheme.

A small paid discovery milestone would turn these into a route decision and acceptance criteria,
including the possible conclusion that no route meets the requirement yet.
