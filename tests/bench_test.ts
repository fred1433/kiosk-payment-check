// Runs every bench sequence on PGlite and requires its expectation to hold.
import { assert } from "@std/assert";
import { FAMILIES } from "../bench/scenarios.ts";

for (const f of FAMILIES) {
  for (const s of f.sequences()) {
    Deno.test(`${f.title}`, async (t) => {
      const r = await s({});
      await t.step(`${r.id} ${r.title}`, () => {
        assert(r.pass, `${r.id} failed: ${JSON.stringify({ module: r.module, notes: r.notes }, null, 1)}`);
      });
    });
  }
}
