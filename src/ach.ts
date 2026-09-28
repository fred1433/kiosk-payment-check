// ACH return windows, as dates the staff screen can show. Sources (read 28 Sep 2026):
//   Plaid, "What are the common ACH return codes?": unless noted, 2 banking days from the
//   settlement date of the original debit; consumer unauthorized returns (R05, R07, R10, R11)
//   use the 60-day window.
//   Federal Reserve holiday schedule 2026 (federalreserve.gov/aboutthefed/k8.htm).
// These are the bank's deadlines. A webhook can arrive after them; it is still recorded.

export const FED_HOLIDAYS_2026 = new Set([
  "2026-01-01",
  "2026-01-19",
  "2026-02-16",
  "2026-05-25",
  "2026-06-19", // Jul 4 is a Saturday: banks open Fri Jul 3
  "2026-09-07",
  "2026-10-12",
  "2026-11-11",
  "2026-11-26",
  "2026-12-25",
]);

export const CONSUMER_UNAUTHORIZED = new Set(["R05", "R07", "R10", "R11"]);

const iso = (d: Date) => d.toISOString().slice(0, 10);
const parse = (s: string) => new Date(`${s}T00:00:00Z`);

export function isBankingDay(day: string): boolean {
  const wd = parse(day).getUTCDay();
  return wd !== 0 && wd !== 6 && !FED_HOLIDAYS_2026.has(day);
}

export function addBankingDays(day: string, n: number): string {
  const d = parse(day);
  let left = n;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (isBankingDay(iso(d))) left--;
  }
  return iso(d);
}

export function addCalendarDays(day: string, n: number): string {
  const d = parse(day);
  d.setUTCDate(d.getUTCDate() + n);
  return iso(d);
}

/** Last day the RDFI can return a debit that settled on `settledOn`, by return family. */
export function returnDeadlines(settledOn: string) {
  return {
    administrative: addBankingDays(settledOn, 2), // e.g. R01-R04, R09
    consumerUnauthorized: addCalendarDays(settledOn, 60), // R05, R07, R10, R11
  };
}

export function returnFamily(code: string): "consumer_unauthorized" | "administrative" {
  return CONSUMER_UNAUTHORIZED.has(code) ? "consumer_unauthorized" : "administrative";
}

/** True when a return arrives after the bank deadline for its code: record it, flag it. */
export function isLateNotice(code: string, settledOn: string, receivedOn: string): boolean {
  const dl = returnDeadlines(settledOn);
  const last = returnFamily(code) === "consumer_unauthorized" ? dl.consumerUnauthorized : dl.administrative;
  return receivedOn > last;
}
