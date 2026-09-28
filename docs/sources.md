# Sources

Every public source this repository relies on, read on **28 September 2026**. Where a page blocked
automated fetching (Dutchie support, Plaid support) it was read in a desktop browser.

| Subject | URL | Used for |
|---|---|---|
| Cova Sales Orders guide | https://api.covasoft.net/Content/pdf/SalesOrders.pdf | Caller-generated order GUID, status endpoint, CovaOrderPayment, amount = sale total, cancel rules, payment type naming |
| Cova CovaOrderPayment | https://api.covasoft.net/Documentation/Api/POST-v1-CovaOrderPayment | Payment request shape |
| Cova order PUT | https://api.covasoft.net/Documentation/Api/PUT-v1-TEPCovaOrder(orderId) | Integrator-generated id in URL and body |
| Cova order status | https://api.covasoft.net/Documentation/Api/GET-v2-Companies(CompanyId)-CovaOrder(SalesOrderId)-Status | Order and payment status values |
| Cova synchronous orders notice | https://api.covasoft.net/GatewayNotice/SynchronousOrders | 200 does not guarantee success; status endpoint stays the truth |
| Dutchie POS API (swagger v1.0.0) | https://api.pos.dutchie.com/swagger/v001/swagger.json | Preorder submit, idempotency, status, cancel, rate limits |
| Dutchie API keys for integrators | https://support.dutchie.com/hc/en-us/articles/27660267271187-Dutchie-POS-API-key-request-process-for-third-party-integrations | Certified partner program, admin request |
| Dutchie Pay by Bank refunds | https://support.dutchie.com/hc/en-us/articles/27912721247507-How-do-I-void-or-issue-a-refund-for-a-Pay-by-Bank-order | No funds reimbursement |
| Treez API reference v3.1.0 | https://code.treez.io/reference | Ticket endpoints listed |
| Aeropay API quick start | https://dev.aero.inc/docs/api-quick-start | White-label users, preauthorization captured by an employee, Idempotency-Key |
| Aeropay declines help | https://help.aeropay.com/a-34-understanding-payment-status-type-and-declines | Customer logs in to Aeropay after some returns |
| Aeropay merchant terms | https://www.aeropay.com/legal/terms-of-service---merchant | Fee cap, nested senders, non guaranteed ACH |
| Aeropay specialized retail | https://www.aeropay.com/specialized-retail | Former cannabis page redirects here |
| CanPay | https://www.canpaydebit.com/ | Kiosk listed among contexts |
| CanPay RemotePay | https://www.canpaydebit.com/remotepay/ | One-click and guest prepayment; amount adjustment |
| Plaid ACH return codes | https://support.plaid.com/hc/en-us/articles/32881797799575-What-are-the-Common-ACH-Return-Codes | Return windows |
| Plaid refunds | https://plaid.com/docs/transfer/refunds/ | Refund and return can both debit the merchant |
| Nacha WEB debit account validation | https://www.nacha.org/rules/supplementing-fraud-detection-standards-web-debits | First use and account changes |
| Nacha fraud monitoring Phase 2 | https://www.nacha.org/rules/risk-management-topics-fraud-monitoring-phase-2 | 19 / 22 June 2026 |
| Federal Reserve holidays | https://www.federalreserve.gov/aboutthefed/k8.htm | Banking days in src/ach.ts |
| Supabase Edge Function limits | https://supabase.com/docs/guides/functions/limits | CPU, idle and wall-clock limits |
| Supabase Queues | https://supabase.com/docs/guides/queues | Exactly-once delivery to a consumer, not to a provider |
| PostgREST transactions | https://docs.postgrest.org/en/stable/references/transactions.html | Each request runs in one transaction |
