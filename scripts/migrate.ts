/**
 * Applies the migrations to whatever DATABASE_URL points at.
 *
 *   npm run migrate
 *
 * WHY THIS EXISTS. `migrate()` had exactly one caller: the test suite, which
 * runs it against an in-memory PGlite. So the schema was reproducible in tests
 * and applied by hand everywhere else — fine for one laptop, and the first
 * thing to fail on a deployment, where nothing had ever created a table.
 *
 * Idempotent: every migration is `create table if not exists` / `add column if
 * not exists`, so running it twice is a no-op and running it on deploy is safe.
 * It prints what it applied rather than succeeding silently, because "did the
 * schema change land" is the question you ask when something is broken.
 */
process.loadEnvFile();

import { connect } from "../lib/db/sql.ts";
import { migrate } from "../lib/db/migrate.ts";

const url = process.env["DATABASE_URL"];
if (!url) {
  console.error("DATABASE_URL is not set. Nothing to migrate.");
  process.exit(1);
}

// The host, never the credentials: this output belongs in a deploy log.
console.log(`migrating ${new URL(url).host}`);

const applied = await migrate(await connect());
if (applied.length === 0) console.log("already up to date");
else for (const name of applied) console.log(`applied ${name}`);
