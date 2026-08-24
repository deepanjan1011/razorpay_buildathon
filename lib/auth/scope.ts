/**
 * Does this agent own this session?
 *
 * A HOLE THE STUB HID. `complete`, `cancel` and the session GET took a session
 * id from the path and never checked who was asking — the merchant was only
 * ever consulted at create. Any caller holding a session id could drive
 * somebody else's checkout to payment.
 *
 * The ids are 96 bits of randomness, so this was not trivially exploitable, and
 * that is exactly why it survived: an unguessable identifier looks like
 * authorisation and is not one. Ownership is now checked, not assumed from
 * knowledge of the id.
 *
 * A session belonging to another merchant answers 404, not 403. 403 confirms
 * the session exists, which tells an enumerating caller which ids are real.
 */
import type { Sql } from "../db/sql.ts";

export async function ownsSession(
  sql: Sql,
  merchantId: string,
  sessionId: string,
): Promise<boolean> {
  const { rows } = await sql.query<{ id: string }>(
    "select id from checkout_session where id = $1 and merchant_id = $2",
    [sessionId, merchantId],
  );
  return rows.length > 0;
}
