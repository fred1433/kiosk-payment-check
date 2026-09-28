// A minimal SQL port so the same code runs on PGlite (in-process Postgres 17, used by the
// default test run) and on a real Postgres server (used for concurrency and restart tests).
import { PGlite } from "@electric-sql/pglite";
import postgres from "postgres";

export interface Sql {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
  readonly kind: "pglite" | "postgres";
}

const MIGRATION = new URL("../supabase/migrations/20260928120000_kiosk_checkout.sql", import.meta.url);

export async function migrationSql(): Promise<string> {
  return await Deno.readTextFile(MIGRATION);
}

export async function openPglite(): Promise<Sql> {
  const db = new PGlite();
  await db.exec(await migrationSql());
  return {
    kind: "pglite",
    async query<T>(text: string, params: unknown[] = []) {
      return (await db.query<T>(text, params)).rows;
    },
    async close() {
      await db.close();
    },
  };
}

/** Connects to an existing database. The caller is responsible for having applied the migration. */
export function openPostgres(url: string, max = 10): Sql {
  const sql = postgres(url, { max, onnotice: () => {}, prepare: false });
  return {
    kind: "postgres",
    async query<T>(text: string, params: unknown[] = []) {
      return (await sql.unsafe(text, params as never[])) as unknown as T[];
    },
    async close() {
      await sql.end({ timeout: 5 });
    },
  };
}

/** Database errors raised by the SQL functions carry a stable code as their message. */
export function sqlErrorCode(err: unknown): string | undefined {
  const msg = err instanceof Error ? err.message : String(err);
  const m = msg.match(/^([a-z_]+)/);
  return m ? m[1] : undefined;
}
