/**
 * Migrations: numbered .sql files, applied in order, each exactly once.
 *
 * No migration framework. The whole mechanism is "read a directory, skip what
 * is recorded, run the rest in a transaction", which is shorter than the
 * configuration a framework would need — and it runs identically against
 * Supabase and against the in-process Postgres the tests use.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { Sql } from "./sql.ts";

export const MIGRATIONS_DIR = join(import.meta.dirname, "..", "..", "migrations");

export async function migrate(sql: Sql, dir = MIGRATIONS_DIR): Promise<string[]> {
  await sql.exec(`
    create table if not exists schema_migration (
      name        text primary key,
      applied_at  timestamptz not null default now()
    )
  `);

  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const { rows } = await sql.query<{ name: string }>("select name from schema_migration");
  const applied = new Set(rows.map((r) => r.name));

  const ran: string[] = [];
  for (const name of files) {
    if (applied.has(name)) continue;
    const statements = await readFile(join(dir, name), "utf8");
    // One transaction per migration: a half-applied schema change is far worse
    // than a failed deploy, and Postgres can roll back DDL.
    await sql.transaction(async (tx) => {
      await tx.exec(statements);
      await tx.query("insert into schema_migration (name) values ($1)", [name]);
    });
    ran.push(name);
  }
  return ran;
}
