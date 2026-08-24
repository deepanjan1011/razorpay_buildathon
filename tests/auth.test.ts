/**
 * Agent credentials, and the guard on every session route.
 */
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { connectEphemeral } from "../lib/db/sql.ts";
import type { Sql } from "../lib/db/sql.ts";
import { migrate } from "../lib/db/migrate.ts";
import { authenticate, bearerOf, hashToken } from "../lib/auth/agent.ts";
import { ownsSession } from "../lib/auth/scope.ts";

let sql: Sql;

beforeEach(async () => {
  sql = await connectEphemeral();
  await migrate(sql);
});

const issue = async (token: string, agent: string, merchant: string, revoked = false) => {
  await sql.query(
    `insert into agent_credential (token_sha256, agent_id, merchant_id, revoked_at)
     values ($1, $2, $3, $4)`,
    [hashToken(token), agent, merchant, revoked ? new Date() : null],
  );
};

const req = (auth?: string) =>
  new Request("https://x/", { headers: auth ? { Authorization: auth } : {} });

describe("bearer parsing", () => {
  test("accepts either case of the scheme", () => {
    // `Bearer` and `bearer` are the same thing to every HTTP client; rejecting
    // one is an interoperability bug dressed as strictness.
    assert.equal(bearerOf("Bearer abc"), "abc");
    assert.equal(bearerOf("bearer abc"), "abc");
    assert.equal(bearerOf("  Bearer   abc  "), "abc");
  });

  test("rejects anything that is not a bearer token", () => {
    for (const h of [null, "", "abc", "Basic abc", "Bearer", "Bearer a b"]) {
      assert.equal(bearerOf(h), null, JSON.stringify(h));
    }
  });
});

describe("authentication", () => {
  test("a valid credential resolves to its agent and merchant", async () => {
    await issue("ak_good", "agent_1", "mer_1");
    assert.deepEqual(await authenticate(sql, req("Bearer ak_good")), {
      agent_id: "agent_1",
      merchant_id: "mer_1",
    });
  });

  test("no header, a forged token and a revoked credential all fail", async () => {
    await issue("ak_good", "agent_1", "mer_1");
    await issue("ak_dead", "agent_2", "mer_2", true);

    assert.equal(await authenticate(sql, req()), null);
    assert.equal(await authenticate(sql, req("Bearer ak_wrong")), null);
    assert.equal(await authenticate(sql, req("Bearer ak_dead")), null, "revoked must not resolve");
  });

  test("the token itself is never stored", async () => {
    await issue("ak_secret_value", "agent_1", "mer_1");
    const { rows } = await sql.query<{ token_sha256: string }>("select token_sha256 from agent_credential");
    // A credential table readable by anyone with database access is a table of
    // live bearer tokens unless only the hash is in it.
    assert.equal(rows.length, 1);
    assert.notEqual(rows[0]?.token_sha256, "ak_secret_value");
    assert.equal(rows[0]?.token_sha256, hashToken("ak_secret_value"));
  });
});

describe("session ownership", () => {
  test("a session belongs only to the merchant that created it", async () => {
    await sql.query(
      `insert into checkout_session (id, merchant_id, status, currency, requested, snapshot)
       values ('cs_x', 'mer_1', 'ready_for_payment', 'INR', '[]'::jsonb, '{}'::jsonb)`,
    );
    assert.equal(await ownsSession(sql, "mer_1", "cs_x"), true);
    assert.equal(await ownsSession(sql, "mer_2", "cs_x"), false);
    assert.equal(await ownsSession(sql, "mer_1", "cs_missing"), false);
  });
});

describe("every session route is guarded", () => {
  // THE TEST THAT WOULD HAVE CAUGHT THE ONE I MISSED.
  //
  // Three routes were guarded and the session GET was not, because the guard
  // was applied per FILE and that file has two handlers. Nothing about the
  // functions was wrong — a handler simply forgot, and no unit test of a
  // correct function notices a caller that never calls it. An end-to-end check
  // found it: another merchant's credential read the session and got 200.
  //
  // So this asserts the property structurally, over the files themselves.
  test("each exported handler under checkout_sessions calls authenticate", async () => {
    const root = join(import.meta.dirname, "..", "app", "api", "checkout_sessions");

    const walk = async (dir: string): Promise<string[]> => {
      const entries = await readdir(dir, { withFileTypes: true });
      const out: string[] = [];
      for (const e of entries) {
        const p = join(dir, e.name);
        if (e.isDirectory()) out.push(...(await walk(p)));
        else if (e.name === "route.ts") out.push(p);
      }
      return out;
    };

    const files = await walk(root);
    assert.ok(files.length >= 4, `expected the session routes, found ${files.length}`);

    for (const file of files) {
      const source = await readFile(file, "utf8");
      // Split on handler exports and check each body independently, which is
      // the thing a per-file grep cannot do.
      const parts = source.split(/export async function (GET|POST|PATCH|DELETE)\b/);
      const handlers: Array<[string, string]> = [];
      for (let i = 1; i < parts.length; i += 2) {
        handlers.push([parts[i]!, parts[i + 1] ?? ""]);
      }
      assert.ok(handlers.length > 0, `no handlers found in ${file}`);

      for (const [method, body] of handlers) {
        assert.match(
          body,
          /authenticate\(/,
          `${method} in ${file.replace(root, "")} does not authenticate`,
        );
        assert.match(
          body,
          /ownsSession\(|createSession\(/,
          `${method} in ${file.replace(root, "")} neither scopes to a session nor creates one`,
        );
      }
    }
  });
});
