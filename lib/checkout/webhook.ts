/**
 * Razorpay webhooks. The security boundary, written before `complete` exists.
 *
 * Everything here that decides anything is a PURE FUNCTION over values —
 * `verifySignature(rawBody, signature, secret)` and `decide(event, session)`.
 * The database appears once, at the bottom, and only to deduplicate and persist
 * what those two already decided. That is deliberate: this is the one endpoint
 * an unauthenticated stranger on the internet can call, and a security check
 * that needs a database, a live PSP and a payment to exercise is a security
 * check nobody exercises.
 *
 * DESIGN.md §2 "The pending-human state, named" is the specification for
 * `decide`. Read it before changing any outcome here.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

import type { Sql } from "../db/sql.ts";
import type { SessionStatus } from "./session.ts";

/**
 * HMAC-SHA256 over the RAW body, keyed by the webhook secret.
 *
 * Razorpay's docs are emphatic: "Do not parse or cast the webhook request
 * body." A round trip through `JSON.parse`/`JSON.stringify` reorders nothing
 * visible and changes the bytes anyway — key order, unicode escapes, whitespace
 * — and the signature is over bytes. So this takes a string and the caller
 * takes `await request.text()`, never `request.json()`.
 *
 * The webhook secret is NOT the API key secret. They are configured separately
 * in the dashboard and confusing them produces a mismatch that looks like an
 * attack.
 *
 * Compared with `timingSafeEqual`. A hex string comparison with `===` leaks the
 * length of the matching prefix through timing, which over enough attempts is
 * how a signature gets forged one nibble at a time.
 */
export function verifySignature(
  rawBody: string,
  signature: string | null | undefined,
  secret: string,
): boolean {
  if (!signature || !secret) return false;

  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");

  // Both are hex of a SHA-256, so both are 64 chars. A wrong length cannot be
  // compared in constant time and is not a valid signature anyway.
  if (signature.length !== expected.length) return false;

  return timingSafeEqual(Buffer.from(signature, "utf8"), Buffer.from(expected, "utf8"));
}

/**
 * The parts of a payment-link event we act on.
 *
 * Everything else in the payload is left in the stored copy rather than pulled
 * into a type — Razorpay sends around forty fields per entity and typing the
 * ones we ignore would be work whose only output is a maintenance burden.
 */
export type LinkEvent = {
  event: string;
  event_id: string;
  /** Our checkout session id: `complete` puts it in the link's `reference_id`. */
  session_id: string | null;
  link_id: string | null;
  order_id: string | null;
  payment_id: string | null;
  amount_minor: number | null;
  amount_paid_minor: number | null;
  currency: string | null;
};

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function minor(value: unknown): number | null {
  // Integer minor units or nothing. A float here would be a bug upstream, and
  // coercing it would hide that (CLAUDE.md invariant 6).
  return Number.isInteger(value) ? (value as number) : null;
}

function obj(value: unknown): Record<string, unknown> {
  // `notes` arrives as `[]`, as `null` AND as an object across the real
  // payloads in fixtures/razorpay — so "it is an object" is never assumed of
  // anything nested here. An array is not a record.
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Razorpay ids appear with and without their prefix IN THE SAME PAYLOAD:
 * `payment_link.entity.order_id` is `order_QflczVVaNJciLq` while
 * `payload.order.entity.id` is `QflczVVaNJciLq`. Comparing them raw never
 * matches, and that is a live trap for reconciliation.
 *
 * Canonicalised by MATCHING the id, not by stripping the prefix. Stripping is
 * subtraction — it would happily "clean" `order_order_x` into `order_x` and
 * anything unexpected survives into the result. This extracts the tail of a
 * known shape and returns null when the shape is not what we expected.
 */
export function canonicalId(value: unknown): string | null {
  const raw = str(value);
  if (!raw) return null;
  const match = /^(?:[a-z]+_)?([A-Za-z0-9]+)$/.exec(raw);
  return match?.[1] ?? null;
}

export function parseEvent(raw: unknown, eventId: string): LinkEvent | null {
  const body = obj(raw);
  if (body["entity"] !== "event") return null;

  const event = str(body["event"]);
  if (!event) return null;

  const payload = obj(body["payload"]);
  const link = obj(obj(payload["payment_link"])["entity"]);
  const payment = obj(obj(payload["payment"])["entity"]);

  return {
    event,
    event_id: eventId,
    session_id: str(link["reference_id"]),
    link_id: str(link["id"]),
    order_id: canonicalId(link["order_id"]),
    payment_id: str(payment["id"]),
    amount_minor: minor(link["amount"]),
    amount_paid_minor: minor(link["amount_paid"]),
    currency: str(link["currency"]),
  };
}

/**
 * What we know about the session the event names, as stored. Deliberately a
 * plain value so `decide` can be exercised without a database.
 */
export type SessionFacts = {
  status: SessionStatus;
  /** The authoritative total we last told the agent. */
  total_minor: number;
  currency: string;
};

export type Decision = {
  /** The only state change, if any. `null` means the session is untouched. */
  transition: SessionStatus | null;
  outcome: "allowed" | "refused" | "observed";
  reason_code: string;
  reason_human: string;
};

/**
 * The whole policy, in one pure function. DESIGN.md §2.
 *
 * The rule that matters, and the reason this file exists before `complete`:
 * **money arriving against a terminal session never completes it.** Not when
 * expired, not when cancelled. It is recorded as `observed` — something
 * happened that we did not decide — and becomes an operator action item. §4
 * spells out why `allowed` would be a lie there.
 */
export function decide(event: LinkEvent, session: SessionFacts | null): Decision {
  if (!session) {
    // An event for a session we have no record of. Never an error to the
    // sender: retrying it would not produce a session, and 5xx here means
    // Razorpay redelivers forever.
    return {
      transition: null,
      outcome: "observed",
      reason_code: "SESSION_UNKNOWN",
      reason_human: `Event ${event.event} names session ${event.session_id ?? "(none)"}, which does not exist here`,
    };
  }

  if (event.event === "payment_link.paid") {
    if (session.status === "completed") {
      return {
        transition: null,
        outcome: "observed",
        reason_code: "ALREADY_COMPLETED",
        reason_human: "Session was already completed; nothing to change",
      };
    }

    if (session.status === "expired" || session.status === "canceled") {
      // The case the design names explicitly. Fulfil-or-refund is a merchant's
      // judgement about a real customer who really paid; completing here would
      // assert we sold this cart at a price we no longer honour.
      return {
        transition: null,
        outcome: "observed",
        reason_code: "LATE_AUTH_AFTER_TERMINAL",
        reason_human:
          `Payment ${event.payment_id ?? "(unknown)"} captured against a session that was ` +
          `${session.status}; fulfil or refund is an operator decision`,
      };
    }

    // Amount is checked before anything is called complete. A link paid for an
    // amount that is not the session total is not this session's payment,
    // whatever its reference_id says.
    if (event.amount_paid_minor !== session.total_minor) {
      return {
        transition: null,
        outcome: "refused",
        reason_code: "AMOUNT_MISMATCH",
        reason_human:
          `Paid ${event.amount_paid_minor ?? "null"} does not equal the session total ` +
          `${session.total_minor}; session left unchanged`,
      };
    }
    if (event.currency !== session.currency) {
      return {
        transition: null,
        outcome: "refused",
        reason_code: "CURRENCY_MISMATCH",
        reason_human: `Paid in ${event.currency ?? "null"}, session is in ${session.currency}`,
      };
    }

    return {
      transition: "completed",
      outcome: "allowed",
      reason_code: "PAYMENT_CAPTURED",
      reason_human: `Payment ${event.payment_id ?? "(unknown)"} captured for ${session.total_minor}`,
    };
  }

  if (event.event === "payment_link.expired") {
    if (session.status === "completed") {
      // Ordering is not guaranteed — Razorpay's own docs warn about it — so a
      // late `expired` after a `paid` must not undo the completion.
      return {
        transition: null,
        outcome: "observed",
        reason_code: "EXPIRY_AFTER_COMPLETION",
        reason_human: "Link expiry arrived after the session completed; completion stands",
      };
    }
    if (session.status === "canceled" || session.status === "expired") {
      return {
        transition: null,
        outcome: "observed",
        reason_code: "ALREADY_TERMINAL",
        reason_human: `Session was already ${session.status}`,
      };
    }
    return {
      transition: "expired",
      outcome: "allowed",
      reason_code: "LINK_EXPIRED",
      reason_human: "Payment link expired without payment",
    };
  }

  if (event.event === "payment_link.cancelled") {
    if (session.status === "completed") {
      return {
        transition: null,
        outcome: "observed",
        reason_code: "CANCEL_AFTER_COMPLETION",
        reason_human: "Link cancellation arrived after the session completed; completion stands",
      };
    }
    if (session.status === "canceled" || session.status === "expired") {
      return {
        transition: null,
        outcome: "observed",
        reason_code: "ALREADY_TERMINAL",
        reason_human: `Session was already ${session.status}`,
      };
    }
    return {
      transition: "canceled",
      outcome: "allowed",
      reason_code: "LINK_CANCELLED",
      reason_human: "Payment link cancelled at Razorpay",
    };
  }

  // Subscribed to more events than we act on is normal and is not an error.
  return {
    transition: null,
    outcome: "observed",
    reason_code: "EVENT_NOT_ACTIONED",
    reason_human: `No rule for ${event.event}`,
  };
}

export type Handled = {
  duplicate: boolean;
  decision: Decision;
};

/**
 * Dedupe, decide, persist.
 *
 * IDEMPOTENCY IS KEYED ON THE `x-razorpay-event-id` HEADER, because the body
 * carries no event id at all — checked against the real payloads in
 * fixtures/razorpay, none of which has one. Razorpay's own guidance names that
 * header as the deduplication key.
 *
 * The store is `idempotency_record`, unchanged: the same conditional INSERT
 * that arbitrates concurrent checkout retries arbitrates concurrent webhook
 * redeliveries, and it is already raced by a test. A second table would be a
 * second thing to get wrong.
 *
 * ponytail: the decision is stored in `response_body` because there is no audit
 * log yet. Phase 3 adds `audit_event` (DESIGN.md §4) and these rows become
 * audit rows — the fields written here are already §4's field names, so that
 * migration is a copy, not a redesign.
 */
export async function handleEvent(
  sql: Sql,
  event: LinkEvent,
  now: Date = new Date(),
): Promise<Handled> {
  const { rows: claimed } = await sql.query<{ key: string }>(
    `insert into idempotency_record
       (key, endpoint, merchant_id, request_sha256, response_status, response_body)
     values ($1, 'razorpay_webhook', $2, $3, 0, '{}'::jsonb)
     on conflict (key, endpoint) do nothing
     returning key`,
    [event.event_id, event.session_id ?? "unknown", event.event],
  );

  if (claimed.length === 0) {
    const { rows } = await sql.query<{ response_body: Decision }>(
      `select response_body from idempotency_record
        where key = $1 and endpoint = 'razorpay_webhook'`,
      [event.event_id],
    );
    return {
      duplicate: true,
      decision: rows[0]?.response_body ?? {
        transition: null,
        outcome: "observed",
        reason_code: "DUPLICATE_IN_FLIGHT",
        reason_human: "This event id is already being processed",
      },
    };
  }

  const facts = event.session_id ? await sessionFacts(sql, event.session_id) : null;
  const decision = decide(event, facts);

  if (decision.transition && event.session_id) {
    // Guarded by the status we actually decided against: if another caller moved
    // the session between the read and here, this updates nothing rather than
    // overwriting a decision made on fresher facts.
    await sql.query(
      `update checkout_session
          set status = $2, updated_at = $3,
              snapshot = jsonb_set(snapshot, '{status}', to_jsonb($2::text))
        where id = $1 and status = $4`,
      [event.session_id, decision.transition, now, facts?.status ?? null],
    );
  }

  await sql.query(
    `update idempotency_record
        set response_status = 200, response_body = $2
      where key = $1 and endpoint = 'razorpay_webhook'`,
    [event.event_id, JSON.stringify({ ...decision, session_status_at_event: facts?.status ?? null })],
  );

  return { duplicate: false, decision };
}

async function sessionFacts(sql: Sql, sessionId: string): Promise<SessionFacts | null> {
  const { rows } = await sql.query<{
    status: SessionStatus;
    currency: string;
    snapshot: { totals?: Array<{ type: string; amount: number }> };
  }>(`select status, currency, snapshot from checkout_session where id = $1`, [sessionId]);

  const row = rows[0];
  if (!row) return null;

  // The snapshot total, NOT a fresh reprice. This is the one place the stored
  // snapshot is the right source: the question is "does this payment match what
  // we told the buyer to pay", and a reprice would answer a different question
  // and reject a correct payment made seconds after a catalogue edit.
  const total = row.snapshot?.totals?.find((t) => t.type === "total")?.amount;
  return {
    status: row.status,
    total_minor: typeof total === "number" ? total : -1,
    currency: row.currency,
  };
}
