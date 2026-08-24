/**
 * Reading and spending a mandate, and parsing one off the wire.
 */
import type { Sql } from "../db/sql.ts";
import type { Mandate } from "./schema.ts";

/**
 * THE MANDATE TRAVELS IN A HEADER, NOT THE BODY.
 *
 * `CheckoutSessionCompleteRequest` sets `additionalProperties: false`, so there
 * is no conformant place in an ACP request body for a field ACP does not
 * define — the same wall the PaymentData extension hit (OBSTACLES.md). Headers
 * are unconstrained, and it is where ACP carries its own `Signature`, so that
 * is where this goes.
 *
 * base64url of the mandate JSON. Returns null rather than throwing: a
 * malformed mandate is a refusal the gate reports with a reason code, not an
 * exception that becomes a 500 and tells the agent nothing.
 */
export function parseMandateHeader(raw: string | null): Mandate | null {
  if (!raw) return null;
  try {
    const json = Buffer.from(raw, "base64url").toString("utf8");
    const value = JSON.parse(json) as Partial<Mandate>;
    // Shape-checked here, not trusted. Everything below reads these fields, and
    // a mandate missing `constraints` would otherwise throw deep inside the
    // gate rather than being refused by it.
    if (
      typeof value.mandate_id !== "string" ||
      typeof value.issued_at !== "string" ||
      typeof value.expires_at !== "string" ||
      typeof value.signature !== "string" ||
      typeof value.constraints !== "object" ||
      value.constraints === null ||
      typeof (value.constraints as { max_amount?: unknown }).max_amount !== "object"
    ) {
      return null;
    }
    return value as Mandate;
  } catch {
    return null;
  }
}

export function encodeMandateHeader(mandate: Mandate): string {
  return Buffer.from(JSON.stringify(mandate), "utf8").toString("base64url");
}

export async function isConsumed(sql: Sql, mandateId: string): Promise<boolean> {
  const { rows } = await sql.query<{ mandate_id: string }>(
    "select mandate_id from mandate_consumption where mandate_id = $1",
    [mandateId],
  );
  return rows.length > 0;
}

/**
 * Spend it. Returns false if it was ALREADY spent.
 *
 * `on conflict do nothing` plus `returning` makes this atomic: exactly one
 * concurrent caller sees a row back. A read-then-write would let two
 * completions of the same single-use mandate both observe "not consumed" and
 * both charge.
 *
 * CALLED AFTER THE PAYMENT CALL SUCCEEDS, never before. Consuming first would
 * mean a mandate destroyed by a transport failure that charged nobody — and
 * invariant 4 requires that retry to work.
 */
export async function consume(sql: Sql, mandateId: string, sessionId: string): Promise<boolean> {
  const { rows } = await sql.query<{ mandate_id: string }>(
    `insert into mandate_consumption (mandate_id, session_id)
     values ($1, $2)
     on conflict (mandate_id) do nothing
     returning mandate_id`,
    [mandateId, sessionId],
  );
  return rows.length > 0;
}
