/**
 * The webhook, which is the security boundary.
 *
 * Two things this suite is built to catch, both of which pass a naive test:
 *
 * 1. A signature computed over a RE-SERIALISED body. `JSON.parse` then
 *    `JSON.stringify` produces a document that means the same and hashes
 *    differently, so a handler that reads `request.json()` fails every genuine
 *    event. There is an explicit assertion for it below.
 * 2. Deduplication keyed on something in the payload. The real payloads carry
 *    no event id at all — asserted here against the fixtures, so this cannot
 *    quietly regress into "key it on payment id".
 *
 * The fixtures are Razorpay's own published payloads, transcribed verbatim
 * before this code existed (fixtures/razorpay/README.md).
 */
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { connectEphemeral } from "../lib/db/sql.ts";
import type { Sql } from "../lib/db/sql.ts";
import { migrate } from "../lib/db/migrate.ts";
import {
  canonicalId,
  decide,
  handleEvent,
  parseEvent,
  verifySignature,
} from "../lib/checkout/webhook.ts";
import type { LinkEvent, SessionFacts } from "../lib/checkout/webhook.ts";

const SECRET = "whsec_test_only_never_live";
const FIXTURES = join(import.meta.dirname, "..", "fixtures", "razorpay");

/** The raw bytes, exactly as read. Never parsed on the way to a signature. */
function raw(name: string): string {
  return readFileSync(join(FIXTURES, `${name}.json`), "utf8");
}

function sign(body: string, secret = SECRET): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

describe("signature verification", () => {
  const body = raw("payment_link.paid");

  test("accepts a signature over the raw body", () => {
    assert.equal(verifySignature(body, sign(body), SECRET), true);
  });

  test("rejects a signature computed over a re-serialised body", () => {
    // The whole reason the route reads request.text(). Same meaning, different
    // bytes, different HMAC — and a handler that parsed first would reject
    // every real event while looking correct in a test that also parsed first.
    const reserialised = JSON.stringify(JSON.parse(body));
    assert.notEqual(reserialised, body);
    assert.equal(verifySignature(body, sign(reserialised), SECRET), false);
  });

  test("rejects a tampered body", () => {
    const signature = sign(body);
    const tampered = body.replace('"amount": 1000', '"amount": 1');
    assert.notEqual(tampered, body);
    assert.equal(verifySignature(tampered, signature, SECRET), false);
  });

  test("rejects the API key secret used in place of the webhook secret", () => {
    assert.equal(verifySignature(body, sign(body, "rzp_test_other_secret"), SECRET), false);
  });

  test("rejects missing, empty and wrong-length signatures without throwing", () => {
    assert.equal(verifySignature(body, null, SECRET), false);
    assert.equal(verifySignature(body, "", SECRET), false);
    assert.equal(verifySignature(body, "abc", SECRET), false);
    // timingSafeEqual throws on unequal buffer lengths; the guard must run first.
    assert.equal(verifySignature(body, `${sign(body)}00`, SECRET), false);
  });

  test("rejects everything when the secret is unset", () => {
    assert.equal(verifySignature(body, sign(body), ""), false);
  });
});

describe("parsing the real payloads", () => {
  test("no real payload carries an event id — dedupe must use the header", () => {
    for (const name of ["payment_link.paid", "payment_link.expired", "payment_link.cancelled"]) {
      const body = JSON.parse(raw(name)) as Record<string, unknown>;
      assert.equal(body["id"], undefined);
      assert.equal(body["event_id"], undefined);
    }
  });

  test("paid: pulls session id from reference_id, and matches the two order ids", () => {
    const event = parseEvent(JSON.parse(raw("payment_link.paid")), "evt_1");
    assert.ok(event);
    assert.equal(event.event, "payment_link.paid");
    assert.equal(event.session_id, "23");
    assert.equal(event.link_id, "plink_QflcnnZqCekuvL");
    assert.equal(event.payment_id, "pay_Qfldmt5StKZFCB");
    assert.equal(event.amount_minor, 1000);
    assert.equal(event.amount_paid_minor, 1000);
    assert.equal(event.currency, "INR");

    // The trap: the link says `order_QflczVVaNJciLq`, the order entity says
    // `QflczVVaNJciLq`. Same order, and `===` on the raw strings says no.
    const orderEntityId = (
      (JSON.parse(raw("payment_link.paid")) as any).payload.order.entity as { id: string }
    ).id;
    assert.notEqual(event.order_id, "order_QflczVVaNJciLq");
    assert.equal(event.order_id, canonicalId(orderEntityId));
  });

  test("canonicalId matches prefixed and bare ids, and refuses odd shapes", () => {
    assert.equal(canonicalId("order_abc123"), canonicalId("abc123"));
    assert.equal(canonicalId("plink_QaIlOGFf8KZNF8"), "QaIlOGFf8KZNF8");
    // Extraction, not subtraction: a shape we did not anticipate fails loudly
    // rather than yielding a plausible wrong id.
    assert.equal(canonicalId("order_abc_123"), null);
    assert.equal(canonicalId("../../etc/passwd"), null);
    assert.equal(canonicalId(""), null);
    assert.equal(canonicalId(null), null);
  });

  test("survives notes being an array, null and an object across payloads", () => {
    // All three shapes occur in the real samples. None of them may throw.
    for (const name of ["payment_link.paid", "payment_link.expired", "payment_link.cancelled"]) {
      assert.ok(parseEvent(JSON.parse(raw(name)), "evt"));
    }
  });

  test("rejects a body that is not an event", () => {
    assert.equal(parseEvent({ entity: "payment" }, "evt"), null);
    assert.equal(parseEvent({ entity: "event" }, "evt"), null);
    assert.equal(parseEvent(null, "evt"), null);
    assert.equal(parseEvent("nope", "evt"), null);
  });
});

const event = (over: Partial<LinkEvent> = {}): LinkEvent => ({
  event: "payment_link.paid",
  event_id: "evt_1",
  session_id: "cs_1",
  link_id: "plink_1",
  order_id: "abc",
  order_id_raw: "order_abc",
  payment_id: "pay_1",
  amount_minor: 136500,
  amount_paid_minor: 136500,
  currency: "INR",
  ...over,
});

const facts = (over: Partial<SessionFacts> = {}): SessionFacts => ({
  status: "complete_in_progress",
  total_minor: 136500,
  currency: "INR",
  ...over,
});

describe("decide — the policy, with no database in sight", () => {
  test("a matching payment completes a pending session", () => {
    const d = decide(event(), facts());
    assert.equal(d.transition, "completed");
    assert.equal(d.outcome, "allowed");
  });

  test("payment after EXPIRY never completes the session", () => {
    // DESIGN.md §2. The money arrived; the session does not change; a human
    // decides fulfil-or-refund.
    const d = decide(event(), facts({ status: "expired" }));
    assert.equal(d.transition, null);
    assert.equal(d.outcome, "observed");
    assert.equal(d.reason_code, "LATE_AUTH_AFTER_TERMINAL");
    assert.match(d.reason_human, /expired/);
  });

  test("payment after cancellation never completes the session", () => {
    const d = decide(event(), facts({ status: "canceled" }));
    assert.equal(d.transition, null);
    assert.equal(d.outcome, "observed");
    assert.equal(d.reason_code, "LATE_AUTH_AFTER_TERMINAL");
  });

  test("a late authorisation is never recorded as allowed", () => {
    for (const status of ["expired", "canceled"] as const) {
      assert.notEqual(decide(event(), facts({ status })).outcome, "allowed");
    }
  });

  test("the wrong amount is refused, not completed", () => {
    const d = decide(event({ amount_paid_minor: 1000 }), facts());
    assert.equal(d.transition, null);
    assert.equal(d.outcome, "refused");
    assert.equal(d.reason_code, "AMOUNT_MISMATCH");
  });

  test("a partial payment is not a payment", () => {
    const d = decide(event({ amount_paid_minor: 136499 }), facts());
    assert.equal(d.transition, null);
    assert.equal(d.reason_code, "AMOUNT_MISMATCH");
  });

  test("the wrong currency is refused", () => {
    const d = decide(event({ currency: "USD" }), facts());
    assert.equal(d.outcome, "refused");
    assert.equal(d.reason_code, "CURRENCY_MISMATCH");
  });

  test("out-of-order expiry does not undo a completion", () => {
    // Razorpay's own docs warn that ordering is not guaranteed.
    const d = decide(event({ event: "payment_link.expired" }), facts({ status: "completed" }));
    assert.equal(d.transition, null);
    assert.equal(d.reason_code, "EXPIRY_AFTER_COMPLETION");
  });

  test("expiry without payment expires the session", () => {
    const d = decide(event({ event: "payment_link.expired" }), facts());
    assert.equal(d.transition, "expired");
  });

  test("an unknown session is observed, never an error", () => {
    const d = decide(event(), null);
    assert.equal(d.transition, null);
    assert.equal(d.outcome, "observed");
    assert.equal(d.reason_code, "SESSION_UNKNOWN");
  });

  test("an event we do not act on changes nothing", () => {
    const d = decide(event({ event: "payment.failed" }), facts());
    assert.equal(d.transition, null);
    assert.equal(d.reason_code, "EVENT_NOT_ACTIONED");
  });
});

describe("handleEvent — end to end against the real paid payload", () => {
  let sql: Sql;

  // The fixture's reference_id is "23", so that is the session id it names.
  const SESSION = "23";

  async function seed(status: string, totalMinor: number): Promise<void> {
    await sql.query(
      `insert into checkout_session
         (id, merchant_id, status, currency, requested, snapshot)
       values ($1, 'mer_x', $2, 'INR', '[]'::jsonb, $3)`,
      [
        SESSION,
        status,
        JSON.stringify({
          id: SESSION,
          status,
          totals: [{ type: "total", display_text: "Total", amount: totalMinor }],
        }),
      ],
    );
  }

  const paid = (id = "evt_paid") => parseEvent(JSON.parse(raw("payment_link.paid")), id)!;

  beforeEach(async () => {
    sql = await connectEphemeral();
    await migrate(sql);
  });

  test("the real payload completes a real row", async () => {
    // 1000 is the fixture's own amount; a total invented to match the code
    // would be the mirror this project keeps warning about.
    await seed("complete_in_progress", 1000);

    const result = await handleEvent(sql, paid());
    assert.equal(result.duplicate, false);
    assert.equal(result.decision.transition, "completed");

    const { rows } = await sql.query<{ status: string; snapshot: { status: string } }>(
      `select status, snapshot from checkout_session where id = $1`,
      [SESSION],
    );
    assert.equal(rows[0]?.status, "completed");
    // The snapshot is what a GET on a terminal session serves, so it must move
    // with the row rather than keep saying complete_in_progress forever.
    assert.equal(rows[0]?.snapshot.status, "completed");
  });

  test("redelivery of the same event id changes nothing twice", async () => {
    await seed("complete_in_progress", 1000);
    const first = await handleEvent(sql, paid());
    const second = await handleEvent(sql, paid());

    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true);
    assert.equal(second.decision.reason_code, first.decision.reason_code);
  });

  test("four concurrent redeliveries produce exactly one non-duplicate", async () => {
    await seed("complete_in_progress", 1000);
    const results = await Promise.all([
      handleEvent(sql, paid()),
      handleEvent(sql, paid()),
      handleEvent(sql, paid()),
      handleEvent(sql, paid()),
    ]);
    assert.equal(results.filter((r) => !r.duplicate).length, 1);
  });

  test("distinct event ids for the same payment are each handled", async () => {
    await seed("complete_in_progress", 1000);
    const first = await handleEvent(sql, paid("evt_a"));
    const second = await handleEvent(sql, paid("evt_b"));

    assert.equal(first.decision.transition, "completed");
    // Not a duplicate by id, but the session has already moved — so the second
    // is an observation, not a second completion.
    assert.equal(second.duplicate, false);
    assert.equal(second.decision.transition, null);
    assert.equal(second.decision.reason_code, "ALREADY_COMPLETED");
  });

  test("a payment against an expired session leaves the row expired", async () => {
    await seed("expired", 1000);
    const result = await handleEvent(sql, paid());

    assert.equal(result.decision.reason_code, "LATE_AUTH_AFTER_TERMINAL");
    const { rows } = await sql.query<{ status: string }>(
      `select status from checkout_session where id = $1`,
      [SESSION],
    );
    assert.equal(rows[0]?.status, "expired");
  });

  test("the observation records the status the session had at the time", async () => {
    await seed("expired", 1000);
    await handleEvent(sql, paid());

    const { rows } = await sql.query<{ response_body: Record<string, unknown> }>(
      `select response_body from idempotency_record
        where key = 'evt_paid' and endpoint = 'razorpay_webhook'`,
    );
    // DESIGN.md §4: what makes a late authorisation legible later is the status
    // observed AT THE EVENT, not one inferred from timestamps afterwards.
    assert.equal(rows[0]?.response_body["session_status_at_event"], "expired");
    assert.equal(rows[0]?.response_body["outcome"], "observed");
  });

  test("a payment for a session we do not have touches nothing", async () => {
    const result = await handleEvent(sql, paid());
    assert.equal(result.decision.reason_code, "SESSION_UNKNOWN");
  });

  test("a mismatched total is refused against a real row", async () => {
    // The fixture pays 1000; this session says it costs 136500.
    await seed("complete_in_progress", 136500);
    const result = await handleEvent(sql, paid());

    assert.equal(result.decision.reason_code, "AMOUNT_MISMATCH");
    const { rows } = await sql.query<{ status: string }>(
      `select status from checkout_session where id = $1`,
      [SESSION],
    );
    assert.equal(rows[0]?.status, "complete_in_progress");
  });

  // razorpay_order_id was added by migration 006 because a Payment Link creates
  // its own order and only names it on the webhook. parseEvent extracted it,
  // LinkEvent carried it, and NO STATEMENT IN THE CODEBASE EVER WROTE IT — a
  // column that existed as an empty promise. Found only after a real captured
  // payment left it null. It is the reconciliation key to Razorpay's ledger.
  test("a captured payment stores it, prefix and all", async () => {
    await seed("complete_in_progress", 73500);
    const id = SESSION;
    await handleEvent(
      sql,
      event({
        session_id: id,
        event: "payment_link.paid",
        order_id: "TTTgqhxfWVphIh",
        order_id_raw: "order_TTTgqhxfWVphIh",
        amount_paid_minor: 73500,
        amount_minor: 73500,
      }),
      new Date(),
    );

    const { rows } = await sql.query<{ razorpay_order_id: string | null }>(
      "select razorpay_order_id from checkout_session where id = $1",
      [id],
    );
    // The PREFIXED form. `canonicalId` strips the prefix so two spellings of
    // one id can be compared; storing that stripped value in a column named
    // razorpay_order_id is a trap, because Razorpay's own API 404s on it.
    assert.equal(rows[0]?.razorpay_order_id, "order_TTTgqhxfWVphIh");
  });

  test("a redelivery carrying no order id does not blank the one we hold", async () => {
    await seed("complete_in_progress", 73500);
    const id = SESSION;
    await handleEvent(
      sql,
      event({ session_id: id, event: "payment_link.paid", order_id_raw: "order_keepme", amount_paid_minor: 73500, amount_minor: 73500 }),
      new Date(),
    );
    await handleEvent(
      sql,
      event({ session_id: id, event_id: "evt_2", event: "payment_link.paid", order_id_raw: null, amount_paid_minor: 73500, amount_minor: 73500 }),
      new Date(),
    );

    const { rows } = await sql.query<{ razorpay_order_id: string | null }>(
      "select razorpay_order_id from checkout_session where id = $1",
      [id],
    );
    assert.equal(rows[0]?.razorpay_order_id, "order_keepme");
  });
});
