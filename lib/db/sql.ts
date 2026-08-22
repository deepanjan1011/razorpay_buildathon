/**
 * The database seam.
 *
 * Deliberately narrow: `query(text, params)` and `transaction(fn)`. No ORM, no
 * query builder — the SQL in this project is a dozen statements and a builder
 * would be more code than the SQL it generates.
 *
 * TWO IMPLEMENTATIONS, ONE DIALECT. Production uses `pg` against a hosted
 * Postgres — nothing here is provider-specific, it is a connection string.
 * Tests use PGlite, which is real Postgres compiled to wasm and run
 * in-process. Both take the SAME SQL text and the same `$1` parameters, so the
 * statements under test are byte-identical to the ones that ship.
 *
 * That is the point of choosing PGlite over a mock: the alternative was a
 * database layer nobody could exercise until hosted credentials existed —
 * another untested path shipped on the strength of a green suite that never
 * touched it. Constraints, upserts, transaction rollback and `on conflict`
 * semantics are all genuinely executed here.
 */
export type Row = Record<string, unknown>;
export type QueryResult<T extends Row = Row> = { rows: T[] };

export type Sql = {
  query<T extends Row = Row>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
  /**
   * Runs a script of several statements, for DDL. Separate from `query`
   * because the extended protocol accepts exactly one statement per prepare —
   * PGlite rejects a multi-statement `query` outright, and this difference is
   * precisely the kind a mock would have hidden until deploy day.
   */
  exec(text: string): Promise<void>;
  /**
   * Runs `fn` inside a transaction, committing on return and rolling back on
   * throw. Batch completion depends on this being atomic — see
   * migrations/001_ingest.sql.
   */
  transaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T>;
};

/** Wraps a driver that exposes `query` into the seam, adding transactions. */
function fromClient(client: {
  query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
  exec?: (text: string) => Promise<unknown>;
}): Sql {
  return {
    async query<T extends Row = Row>(text: string, params: unknown[] = []) {
      const result = await client.query(text, params);
      return { rows: result.rows as T[] };
    },
    async exec(text: string) {
      if (client.exec) await client.exec(text);
      else await client.query(text);
    },
    async transaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T> {
      await client.query("begin");
      try {
        const out = await fn(fromClient(client));
        await client.query("commit");
        return out;
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
    },
  };
}

/**
 * Production. Connects to any Postgres — Neon, Supabase, RDS, a local server.
 * The provider is a URL, not a dependency.
 *
 * Pooled connections and a transaction do not mix — `begin` must land on the
 * same connection as the statements that follow it — so a transaction checks a
 * client out of the pool and holds it.
 */
export async function connect(connectionString?: string): Promise<Sql> {
  const url = connectionString ?? process.env["DATABASE_URL"];
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. See docs/PHASE-1.md §7 for database setup.",
    );
  }

  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: url });

  return {
    async query<T extends Row = Row>(text: string, params: unknown[] = []) {
      const result = await pool.query(text, params);
      return { rows: result.rows as T[] };
    },
    async exec(text: string) {
      // node-postgres uses the simple protocol when no params are given, which
      // accepts a multi-statement script.
      await pool.query(text);
    },
    async transaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const out = await fn(fromClient(client));
        await client.query("commit");
        return out;
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

/** Tests. Real Postgres, in-process, no server and no credentials. */
export async function connectEphemeral(): Promise<Sql> {
  const { PGlite } = await import("@electric-sql/pglite");
  const db = await PGlite.create();
  return fromClient(db as never);
}
