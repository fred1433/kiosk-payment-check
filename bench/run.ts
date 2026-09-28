// deno task bench            -> PGlite, writes site/data/bench.json
// DATABASE_URL=... deno task bench -> also runs on a Postgres server
import { runAll } from "./scenarios.ts";
import { runOrderings } from "./orderings.ts";
import { runHero } from "./hero.ts";

const pgUrl = Deno.env.get("DATABASE_URL");
const started = new Date().toISOString();
const families = await runAll({ pgUrl });
const out = {
  generated_at: started,
  database: pgUrl ? "postgres-server" : "pglite (Postgres 17.5 in WebAssembly)",
  runtime: `Deno ${Deno.version.deno}`,
  families: families.map(({ family, results }) => ({
    id: family.id,
    title: family.title,
    demonstrates: family.demonstrates,
    results,
  })),
  orderings: await runOrderings(),
  hero: await runHero(pgUrl),
};
await Deno.mkdir(new URL("../site/data/", import.meta.url), { recursive: true });
const file = pgUrl ? "bench.postgres.json" : "bench.json";
await Deno.writeTextFile(new URL(`../site/data/${file}`, import.meta.url), JSON.stringify(out, null, 2));
for (const f of out.families) {
  for (const r of f.results) {
    const m = r.module, n = r.naive;
    console.log(
      `${r.pass ? "PASS" : "FAIL"} ${
        r.id.padEnd(3)
      } debits=${m.debits} orders=${m.orders} reg=${m.registerPaid} net=${m.bankNetCents} rec=${
        m.recordedNetCents ?? "-"
      } exp=${m.exposureCents ?? "-"} ${m.outcome}` +
        (n
          ? ` | naive: debits=${n.debits} orders=${n.orders} reg=${n.registerPaid} rec=${
            n.recordedNetCents ?? "-"
          } ${n.belief}`
          : ""),
    );
  }
}
console.log(`wrote site/data/${file}`);
const failed = out.families.flatMap((f) => f.results).filter((r) => !r.pass);
if (failed.length) {
  console.error(`${failed.length} sequence(s) failed: ${failed.map((r) => r.id).join(", ")}`);
  Deno.exit(1);
}
