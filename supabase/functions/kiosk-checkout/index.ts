// Supabase Edge Function entry point.
//
// Status: NOT deployed and NOT run in the Supabase Edge runtime (no Docker on the build
// machine). The handler it serves is tested under plain Deno in tests/edge_handler_test.ts.
// There is no real bank or POS adapter in this repository: with KIOSK_SIMULATION=1 it serves
// the simulators; otherwise it refuses to start.

import { openPostgres } from "../../../src/db.ts";
import { systemClock } from "../../../src/clock.ts";
import { makeHandler } from "../../../src/http/handler.ts";
import { BankSimulator } from "../../../src/adapters/bank_sim.ts";
import { CovaSimulator } from "../../../src/adapters/cova_sim.ts";

const env = (k: string) => {
  const v = Deno.env.get(k);
  if (!v) throw new Error(`missing env ${k}`);
  return v;
};

if (Deno.env.get("KIOSK_SIMULATION") !== "1") {
  throw new Error(
    "No production bank or POS adapter is wired in this work sample. Set KIOSK_SIMULATION=1 to serve the simulators.",
  );
}

const supabaseUrl = env("SUPABASE_URL");
const anonKey = env("SUPABASE_ANON_KEY");

Deno.serve(makeHandler({
  sql: openPostgres(env("SUPABASE_DB_URL"), 3),
  clock: systemClock,
  bank: new BankSimulator(),
  pos: new CovaSimulator(),
  webhookSecret: env("BANK_WEBHOOK_SECRET"),
  signatureHeader: "x-bank-signature",
  tickSecret: env("KIOSK_TICK_SECRET"),
  // Shopper identity from the platform's existing Supabase Auth session. Endpoint to verify   // the platform's setup before use.
  authenticateShopper: async (req) => {
    const auth = req.headers.get("authorization");
    if (!auth) return null;
    const r = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { authorization: auth, apikey: anonKey },
    });
    if (!r.ok) return null;
    const u = await r.json();
    return typeof u?.id === "string" ? u.id : null;
  },
}));
