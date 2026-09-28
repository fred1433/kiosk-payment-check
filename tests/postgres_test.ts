// Tests that need a real Postgres server: concurrency, restart recovery, lease fencing, roles.
// Skipped unless DATABASE_URL points at a server where the current user can create databases.
// See README: `scripts/test-postgres.sh` starts a throwaway server and runs these.

import { assert, assertEquals, assertRejects } from "@std/assert";
import { freshPostgres, makeWorld, WEBHOOK_SECRET } from "../bench/world.ts";
import { openPostgres } from "../src/db.ts";
import { drain, runOnce, WorkerCrash } from "../src/worker.ts";
import type { OperationRow } from "../src/workflow.ts";
import { reconciliation } from "../src/service.ts";

const url = Deno.env.get("DATABASE_URL");
const opts = { ignore: !url, sanitizeOps: false, sanitizeResources: false };

Deno.test(
  { name: "pg: 20 simultaneous submissions of one checkout make one checkout", ...opts },
  async () => {
    const w = await makeWorld({ pgUrl: url });
    const results = await Promise.all(Array.from({ length: 20 }, () => w.checkout()));
    assert(results.every((r) => r.ok));
    const ids = new Set(results.map((r) => (r.ok ? r.checkoutId : "")));
    assertEquals(ids.size, 1);
    assertEquals(results.filter((r) => r.ok && r.created).length, 1);
    const [{ n }] = await w.sql.query<{ n: number }>(`select count(*)::int n from kiosk.operations`);
    assertEquals(n, 1);
    await w.close();
  },
);

Deno.test(
  { name: "pg: 5 workers draining 10 checkouts in parallel never run an operation twice", ...opts },
  async () => {
    const w = await makeWorld({ pgUrl: url });
    for (let i = 0; i < 10; i++) {
      const r = await w.checkout({ kioskRequestId: `kiosk-7-tap-${String(i).padStart(6, "0")}` });
      assert(r.ok);
    }
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        drain(w.worker(`worker-${i}`, { leaseSeconds: 3600 }), {
          advance: (s) => w.clock.advance(s),
        })),
    );
    assertEquals(w.bank.calls.preauthorize, 10);
    assertEquals(w.bank.calls.capture, 10);
    assertEquals(w.bank.debitsAccepted(), 10);
    assertEquals(w.pos.ordersCreated(), 10);
    assertEquals(w.pos.paymentsApplied(), 10);
    const [{ n }] = await w.sql.query<{ n: number }>(
      `select count(*)::int n from kiosk.checkouts where outcome = 'ready_for_pickup'`,
    );
    assertEquals(n, 10);
    await w.close();
  },
);

Deno.test(
  { name: "pg: provider accepted, process restarted, a new pool resumes with the same key", ...opts },
  async () => {
    const w = await makeWorld({ pgUrl: url });
    const r = await w.checkout();
    assert(r.ok);
    let crashed = false;
    // run until the capture reaches the bank, then "kill the process"
    for (let i = 0; i < 50 && !crashed; i++) {
      try {
        const worked = await runOnce(w.worker("worker-a", {
          afterCall: (op: OperationRow) => {
            if (op.kind === "bank_capture") {
              crashed = true;
              throw new WorkerCrash("process killed");
            }
          },
        }));
        if (!worked) w.clock.advance(15);
      } catch (e) {
        if (!(e instanceof WorkerCrash)) throw e;
      }
    }
    assert(crashed);
    const dbUrl = (w.sql as unknown as { url?: string }).url;
    void dbUrl;
    // Pool closed: nothing in memory survives. Reopen by database name.
    const [{ db }] = await w.sql.query<{ db: string }>(`select current_database() as db`);
    await w.close();
    const u = new URL(url!);
    u.pathname = `/${db}`;
    const sql2 = openPostgres(u.toString(), 4);
    w.clock.advance(120); // lease expired
    await drain({
      sql: sql2,
      bank: w.bank,
      pos: w.pos,
      clock: w.clock,
      workerId: "worker-b",
      leaseSeconds: 60,
    }, { advance: (s) => w.clock.advance(s) });
    assertEquals(w.bank.calls.capture, 2); // the capture was sent twice...
    assertEquals(w.bank.debitsAccepted(), 1); // ...with the same key, so one debit
    const rec = await reconciliation(sql2, r.checkoutId);
    assertEquals(rec.outcome, "ready_for_pickup");
    await sql2.close();
  },
);

Deno.test({ name: "pg: a worker whose lease expired cannot record its result", ...opts }, async () => {
  const w = await makeWorld({ pgUrl: url });
  await w.checkout();
  const [a] = await w.sql.query<OperationRow>(
    `select * from kiosk.claim_next_operation('worker-a', 60, $1)`,
    [w.clock.now().toISOString()],
  );
  w.clock.advance(90);
  const [b] = await w.sql.query<OperationRow>(
    `select * from kiosk.claim_next_operation('worker-b', 60, $1)`,
    [w.clock.now().toISOString()],
  );
  assertEquals(a.id, b.id);
  assertEquals(a.operation_key, b.operation_key);
  await assertRejects(
    () =>
      w.sql.query(`select kiosk.finish_operation($1, $2, $3::text::jsonb, $4)`, [
        a.id,
        a.claim_token,
        JSON.stringify({ op_state: "done", outcome: "x" }),
        w.clock.now().toISOString(),
      ]),
    Error,
    "lease_lost",
  );
  await w.sql.query(`select kiosk.finish_operation($1, $2, $3::text::jsonb, $4)`, [
    b.id,
    b.claim_token,
    JSON.stringify({ op_state: "done", outcome: "ok" }),
    w.clock.now().toISOString(),
  ]);
  await w.close();
});

Deno.test(
  { name: "pg: browser roles can read nothing and call nothing; service_role can", ...opts },
  async () => {
    const main = await freshPostgres(url!);
    const [{ db }] = await main.query<{ db: string }>(`select current_database() as db`);
    await main.close();
    const u = new URL(url!);
    u.pathname = `/${db}`;
    const one = openPostgres(u.toString(), 1);
    for (const role of ["anon", "authenticated"]) {
      await one.query(`set role ${role}`);
      await assertRejects(() => one.query(`select * from kiosk.checkouts`), Error, "permission denied");
      await assertRejects(() => one.query(`select * from kiosk.reconciliation`), Error, "permission denied");
      await assertRejects(
        () => one.query(`select kiosk.request_refund(gen_random_uuid(), 100, 'x', 'y')`),
        Error,
        "permission denied",
      );
      await one.query(`reset role`);
    }
    await one.query(`set role service_role`);
    const rows = await one.query(`select * from kiosk.checkouts`);
    assertEquals(rows.length, 0);
    await one.query(`reset role`);
    await one.query(`select kiosk.log(null, 'test', 'probe', '{}'::jsonb, now())`);
    await assertRejects(() => one.query(`update kiosk.events set type = 'x'`), Error, "append_only");
    await assertRejects(() => one.query(`delete from kiosk.events`), Error, "append_only");
    await one.close();
  },
);

void WEBHOOK_SECRET;
