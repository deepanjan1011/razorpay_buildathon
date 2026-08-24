/**
 * Who is calling, and what they may act for.
 *
 * NARROW ON PURPOSE. This is a signed-credential check, not an identity system:
 * no OAuth, no scopes, no key rotation, no delegation chain. What it does is
 * close the actual hole the `X-Merchant-Id` stub left — the CLIENT chose which
 * merchant's catalogue it transacted against — by taking the merchant from the
 * credential instead of from a header the caller controls.
 *
 * Stated as a gap rather than implied away: a real deployment needs scopes, an
 * agent-to-buyer binding, and rotation. Phase 4's gate is a real agent
 * completing a purchase, and none of those are on the path to it.
 */
import { createHash, timingSafeEqual } from "node:crypto";

import type { Sql } from "../db/sql.ts";

export type AgentIdentity = { agent_id: string; merchant_id: string };

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * The bearer token, or null.
 *
 * Case-insensitive on the scheme, because `Bearer` and `bearer` are the same
 * thing to every HTTP client and rejecting one is an interoperability bug
 * dressed as strictness.
 */
export function bearerOf(header: string | null): string | null {
  if (!header) return null;
  const match = /^bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

/**
 * Resolve a request to an agent, or null.
 *
 * The lookup is BY HASH, so the query itself never carries the token, and a
 * slow-query log cannot leak one. The equality is still compared in constant
 * time afterwards: the index lookup is not a constant-time operation and
 * returning early on a near-miss is exactly the leak the hash was meant to
 * avoid.
 */
export async function authenticate(sql: Sql, request: Request): Promise<AgentIdentity | null> {
  const token = bearerOf(request.headers.get("authorization"));
  if (!token) return null;

  const hashed = hashToken(token);
  const { rows } = await sql.query<{ token_sha256: string; agent_id: string; merchant_id: string }>(
    `select token_sha256, agent_id, merchant_id
       from agent_credential
      where token_sha256 = $1 and revoked_at is null`,
    [hashed],
  );

  const row = rows[0];
  if (!row) return null;

  const a = Buffer.from(row.token_sha256, "utf8");
  const b = Buffer.from(hashed, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  return { agent_id: row.agent_id, merchant_id: row.merchant_id };
}
