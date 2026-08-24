/**
 * Append-only audit log. DESIGN.md §4, CLAUDE.md invariant 3.
 *
 * One row per DECISION, not per request: a request that makes two decisions
 * writes two events, and a request that makes none writes none.
 *
 * There is no update and no delete here, and that is the whole design. The
 * dashboard renders this timeline, which is what makes "explainable" something
 * a judge can look at rather than something the README claims.
 */
import { randomUUID } from "node:crypto";

import type { Sql } from "../db/sql.ts";

export type Actor = "agent" | "system" | "merchant" | "psp";
export type Outcome = "allowed" | "refused" | "error" | "observed";

export type AuditEvent = {
  session_id: string | null;
  mandate_id: string | null;
  actor: Actor;
  action: string;
  outcome: Outcome;
  /** The status the session had WHEN THIS HAPPENED, not when it is read. */
  session_status_at_event: string | null;
  reason_code: string | null;
  reason_human: string | null;
  evidence?: Record<string, unknown>;
};

export async function record(sql: Sql, event: AuditEvent): Promise<string> {
  // Invariant 3 is checked in the database as well; this is the earlier, more
  // legible failure for a caller that forgets, since a constraint violation
  // names a constraint and not a mistake.
  if (event.outcome === "refused" && !(event.reason_code && event.reason_human)) {
    throw new Error(
      `Refusal for ${event.action} needs both a reason_code and a reason_human ` +
        "(CLAUDE.md invariant 3)",
    );
  }

  const eventId = `evt_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  await sql.query(
    `insert into audit_event
       (event_id, session_id, mandate_id, actor, action, outcome,
        session_status_at_event, reason_code, reason_human, evidence)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      eventId,
      event.session_id,
      event.mandate_id,
      event.actor,
      event.action,
      event.outcome,
      event.session_status_at_event,
      event.reason_code,
      event.reason_human,
      JSON.stringify(event.evidence ?? {}),
    ],
  );
  return eventId;
}

/** `seq` is insertion order — the only ordering the timeline can trust. */
export type AuditRow = AuditEvent & { event_id: string; seq: string; ts: Date };

/** One session's timeline, oldest first. The only read shape there is. */
export async function timeline(sql: Sql, sessionId: string): Promise<AuditRow[]> {
  const { rows } = await sql.query<AuditRow>(
    `select event_id, seq, ts, session_id, mandate_id, actor, action, outcome,
            session_status_at_event, reason_code, reason_human, evidence
       from audit_event
      where session_id = $1
      order by seq asc`,
    [sessionId],
  );
  return rows;
}
