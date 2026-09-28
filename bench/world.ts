// A fresh, isolated world per scenario: database, simulated bank, simulated register, clock.

import { migrationSql, openPglite, openPostgres, type Sql } from "../src/db.ts";
import { FakeClock } from "../src/clock.ts";
import { BankSimulator } from "../src/adapters/bank_sim.ts";
import { type CovaSimOptions, CovaSimulator } from "../src/adapters/cova_sim.ts";
import type { BankCapabilities, CartLine } from "../src/adapters/types.ts";
import { drain, type WorkerDeps } from "../src/worker.ts";
import { signWebhook } from "../src/webhook_signature.ts";
import { ingestBankWebhook, type StartCheckout, startCheckout } from "../src/service.ts";

export const WEBHOOK_SECRET = "whsec_test_only_not_a_real_secret";
export const STORE = "5a7e0000-0000-4000-8000-000000000001";
export const OTHER_STORE = "5a7e0000-0000-4000-8000-000000000002";
export const SHOPPER = "5b0e0000-0000-4000-8000-00000000000a";
export const OTHER_SHOPPER = "5b0e0000-0000-4000-8000-00000000000b";

// One fictional order, used everywhere on the page.
export const CART: CartLine[] = [
  { name: "Flower, 3.5 g", sku: "FLW-35", qty: 1, lineCents: 4000 },
  { name: "Pre-roll pack, 5 x 0.5 g", sku: "PRL-5", qty: 1, lineCents: 2200 },
  { name: "Gummies, 100 mg", sku: "GUM-100", qty: 1, lineCents: 1800 },
];
export const TAX_RATE = 0.2; // fictional
export const FEE_CENTS = 150; // fictional disclosed fee
export const QUOTE_CENTS = CovaSimulator.total(CART, TAX_RATE); // 9600

export interface World {
  sql: Sql;
  clock: FakeClock;
  bank: BankSimulator;
  pos: CovaSimulator;
  savedRefId: string;
  otherShopperRefId: string;
  worker: (id?: string, extra?: Partial<WorkerDeps>) => WorkerDeps;
  checkout: (over?: Partial<StartCheckout>) => ReturnType<typeof startCheckout>;
  run: (extra?: Partial<WorkerDeps>) => Promise<void>;
  deliver: (
    opts?: { duplicate?: boolean; reverse?: boolean; drop?: (i: number) => boolean },
  ) => Promise<string[]>;
  today: () => string;
  close: () => Promise<void>;
}

export async function freshPostgres(url: string): Promise<Sql> {
  const admin = openPostgres(url, 1);
  const db = `kiosk_t_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  await admin.query(`create database ${db}`);
  await admin.close();
  const u = new URL(url);
  u.pathname = `/${db}`;
  const sql = openPostgres(u.toString(), 10);
  await sql.query(await migrationSql());
  return sql;
}

export async function makeWorld(
  opts: { pos?: CovaSimOptions; bank?: BankCapabilities; pgUrl?: string } = {},
): Promise<World> {
  const sql = opts.pgUrl ? await freshPostgres(opts.pgUrl) : await openPglite();
  const clock = new FakeClock();
  const bank = new BankSimulator(opts.bank ?? { idempotencyKeys: true });
  const pos = new CovaSimulator({ taxRate: TAX_RATE, ...opts.pos });
  bank.enroll("consent_shopper_a");
  bank.enroll("consent_shopper_b");
  const [ref] = await sql.query<{ id: string }>(
    `insert into kiosk.saved_bank_refs (shopper_id, store_id, provider_consent_ref) values ($1, $2, 'consent_shopper_a') returning id`,
    [SHOPPER, STORE],
  );
  const [other] = await sql.query<{ id: string }>(
    `insert into kiosk.saved_bank_refs (shopper_id, store_id, provider_consent_ref) values ($1, $2, 'consent_shopper_b') returning id`,
    [OTHER_SHOPPER, STORE],
  );
  const worker = (id = "worker-1", extra: Partial<WorkerDeps> = {}): WorkerDeps => ({
    sql,
    bank,
    pos,
    clock,
    workerId: id,
    leaseSeconds: 60,
    ...extra,
  });
  const w: World = {
    sql,
    clock,
    bank,
    pos,
    savedRefId: ref.id,
    otherShopperRefId: other.id,
    worker,
    checkout: (over = {}) =>
      startCheckout(sql, clock, {
        storeId: STORE,
        shopperId: SHOPPER,
        kioskRequestId: "kiosk-7-tap-000184",
        savedRefId: ref.id,
        quotedTotalCents: QUOTE_CENTS,
        feeCents: FEE_CENTS,
        cart: CART,
        ...over,
      }),
    run: (extra = {}) => drain(worker("worker-1", extra), { advance: (s) => clock.advance(s) }),
    async deliver(o = {}) {
      let evts = bank.takeEvents();
      if (o.reverse) evts = evts.reverse();
      const results: string[] = [];
      for (let i = 0; i < evts.length; i++) {
        if (o.drop?.(i)) continue;
        const body = JSON.stringify(evts[i]);
        const sig = await signWebhook(WEBHOOK_SECRET, body, Math.floor(clock.now().getTime() / 1000));
        const copies = o.duplicate ? 2 : 1;
        for (let c = 0; c < copies; c++) {
          results.push(
            await ingestBankWebhook(sql, clock, WEBHOOK_SECRET, { rawBody: body, signatureHeader: sig }),
          );
        }
      }
      return results;
    },
    today: () => clock.now().toISOString().slice(0, 10),
    close: () => sql.close(),
  };
  return w;
}
