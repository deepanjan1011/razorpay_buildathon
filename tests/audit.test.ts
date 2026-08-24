/**
 * The audit log. DESIGN.md §4.
 *
 * The tests that matter here are the ones asserting what the schema does NOT
 * forbid. A log that rejects a late authorisation is a log that cannot record
 * money moving against a session we refused, which is the single most valuable
 * row it will ever hold.
 */
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { connectEphemeral } from "../lib/db/sql.ts";
import type { Sql } from "../lib/db/sql.ts";
import { migrate } from "../lib/db/migrate.ts";
import { record, timeline } from "../lib/audit/log.ts";
import type { AuditEvent } from "../lib/audit/log.ts";

let sql: Sql;

beforeEach(async () => {
  sql = await connectEphemeral();
  await migrate(sql);
});

const event = (over: Partial<AuditEvent> = {}): AuditEvent => ({
  session_id: "cs_1",
  mandate_id: "mnd_1",
  actor: "agent",
  action: "mandate.verify",
  outcome: "allowed",
  session_status_at_event: "ready_for_payment",
  reason_code: null,
  reason_human: null,
  ...over,
});

describe("the log accepts what a state machine would reject", () => {
  test("an event after the session is terminal", async () => {
    // Razorpay documents late authorisation. The buyer completes a link we had
    // given up on, and the webhook arrives against a canceled session. A schema
    // that forbids this cannot record the thing most worth recording.
    await record(sql, event({ action: "session.cancel", outcome: "allowed", session_status_at_event: "canceled" }));
    await record(
      sql,
      event({
        action: "payment.authorized",
        outcome: "observed",
        session_status_at_event: "canceled",
        reason_code: "LATE_AUTHORIZATION",
        reason_human: "Payment captured against a session that was already canceled",
      }),
    );

    const rows = await timeline(sql, "cs_1");
    assert.equal(rows.length, 2);
    assert.equal(rows[1]?.outcome, "observed");
    // NOT `allowed`: recording it that way would assert we permitted a charge
    // we in fact refused.
    assert.notEqual(rows[1]?.outcome, "allowed");
  });

  test("two terminal events for one session", async () => {
    await record(sql, event({ action: "session.expire", session_status_at_event: "expired" }));
    await record(sql, event({ action: "session.cancel", session_status_at_event: "expired" }));
    assert.equal((await timeline(sql, "cs_1")).length, 2);
  });

  test("events arriving out of lifecycle order", async () => {
    // Razorpay's own docs warn about webhook ordering.
    await record(sql, event({ action: "payment.captured", outcome: "observed", session_status_at_event: "complete_in_progress" }));
    await record(sql, event({ action: "session.create", session_status_at_event: "ready_for_payment" }));
    assert.equal((await timeline(sql, "cs_1")).length, 2);
  });

  test("an event naming a session we do not have", async () => {
    // An observation worth keeping, not an error to reject — the webhook
    // already produces exactly this as SESSION_UNKNOWN.
    await record(
      sql,
      event({
        session_id: "cs_never_existed",
        outcome: "observed",
        session_status_at_event: null,
        reason_code: "SESSION_UNKNOWN",
        reason_human: "Event names a session this merchant does not have",
      }),
    );
    assert.equal((await timeline(sql, "cs_never_existed")).length, 1);
  });

  test("an event with no session at all", async () => {
    await record(sql, event({ session_id: null, action: "mandate.issue" }));
    assert.equal((await timeline(sql, "cs_1")).length, 0);
  });
});

describe("invariant 3 — every refusal carries a code AND a human string", () => {
  test("the writer refuses to record an unexplained refusal", async () => {
    await assert.rejects(
      () => record(sql, event({ outcome: "refused", reason_code: "X", reason_human: null })),
      /invariant 3/,
    );
    await assert.rejects(
      () => record(sql, event({ outcome: "refused", reason_code: null, reason_human: "why" })),
      /invariant 3/,
    );
  });

  test("the DATABASE refuses it too, for a writer that bypasses the helper", async () => {
    // The check in TypeScript is the legible failure; this is the one that
    // holds when someone writes SQL directly.
    await assert.rejects(() =>
      sql.query(
        `insert into audit_event (event_id, actor, action, outcome)
         values ('evt_raw', 'agent', 'mandate.verify', 'refused')`,
      ),
    );
  });

  test("a non-refusal needs neither", async () => {
    await record(sql, event({ outcome: "observed", reason_code: null, reason_human: null }));
    assert.equal((await timeline(sql, "cs_1")).length, 1);
  });
});

describe("the timeline is what the dashboard renders", () => {
  test("oldest first, with the status each event saw", async () => {
    await record(sql, event({ action: "session.create", session_status_at_event: "ready_for_payment" }));
    await record(
      sql,
      event({
        action: "mandate.verify",
        outcome: "refused",
        session_status_at_event: "ready_for_payment",
        reason_code: "MANDATE_CEILING_EXCEEDED",
        reason_human: "Cart total 299900 exceeds mandate ceiling 280000",
      }),
    );

    const rows = await timeline(sql, "cs_1");
    assert.deepEqual(rows.map((r) => r.action), ["session.create", "mandate.verify"]);
    assert.equal(rows[1]?.reason_code, "MANDATE_CEILING_EXCEEDED");
    assert.match(rows[1]?.reason_human ?? "", /299900.*280000/);
  });
});
