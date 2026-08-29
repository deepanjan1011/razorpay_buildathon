/**
 * `complete` — the call that puts a payable amount in front of a person.
 *
 * The Razorpay call is behind a fake, so every refusal is exercised without a
 * key, a network or a payment. That is the point of the seam: the paths that
 * matter most here are the ones where NO call is made, and a suite that could
 * only run against a live PSP would test none of them.
 *
 * What the fake cannot tell us is whether Razorpay accepts our request body.
 * That is stated in OBSTACLES.md rather than implied away by a green suite.
 */
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { connectEphemeral } from "../lib/db/sql.ts";
import type { Sql } from "../lib/db/sql.ts";
import { migrate } from "../lib/db/migrate.ts";
import { upsertCatalog } from "../lib/catalog/store.ts";
import {
  RAZORPAY_LINK_HANDLER,
  cancelSession,
  createSession,
  getSession,
  updateSession,
} from "../lib/checkout/session.ts";
import { completeSession, planCompletion } from "../lib/checkout/complete.ts";
import { handleEvent } from "../lib/checkout/webhook.ts";
import { signMandate } from "../lib/mandate/sign.ts";
import { timeline } from "../lib/audit/log.ts";
import type { Mandate, MandateConstraints } from "../lib/mandate/schema.ts";
import type { CompletionFacts } from "../lib/checkout/complete.ts";
import { LINK_TTL_MINUTES, RAZORPAY_MIN_TTL_MINUTES, expiryFor } from "../lib/checkout/razorpay.ts";
import type { PaymentLinkClient, PaymentLinkRequest } from "../lib/checkout/razorpay.ts";
import { assertValid } from "../lib/checkout/validate.ts";
import type { Product, Variant } from "../lib/normalize/schema.ts";

const MERCHANT = "mer_lakshmi";
let sql: Sql;

const provenance = { source_file: "s.xlsx", source_sheet: "S", source_row: 2, source_cells: {} };
const clean = { confidence: 0.95, flags: [], needs_review: false };

const variant = (o: Partial<Variant> = {}): Variant => ({
  id: "var_shoe",
  title: "Canvas Shoe - White",
  category: "footwear",
  category_raw: null,
  category_confidence: 0.98,
  price: { amount_minor: 89900, currency: "INR" },
  compare_at_price: null,
  availability: "in_stock",
  inventory_count: null,
  options: {},
  attributes: {},
  image_url: null,
  provenance,
  normalization: clean,
  ...o,
});

const product = (o: Partial<Product> = {}): Product => ({
  id: "prod_shoe",
  merchant_id: MERCHANT,
  title: "Canvas Shoe",
  description: null,
  brand: null,
  variants: [variant()],
  image_url: null,
  provenance,
  normalization: clean,
  ...o,
});

/** Records what it was asked for. Never reachable on a refusal path. */
function fakeClient(): PaymentLinkClient & { calls: PaymentLinkRequest[]; canceled: string[] } {
  const calls: PaymentLinkRequest[] = [];
  const canceled: string[] = [];
  return {
    calls,
    canceled,
    async create(request) {
      calls.push(request);
      return {
        id: `plink_fake${calls.length}`,
        short_url: `https://rzp.io/rzp/fake${calls.length}`,
        status: "created",
      };
    },
    async cancel(id) {
      canceled.push(id);
      return { status: "cancelled" };
    },
  };
}

// `handler_id` ALONE. This handler carries no credential, so neither of
// PaymentData's anyOf branches describes it; sending `credential.token: "n/a"`
// would fabricate one. Declared as a deviation — see lib/checkout/http.ts.
//
// EVERY completion below carries a mandate, because invariant 2 means there is
// no other kind. Before the gate was wired in, these tests all passed without
// one — which is precisely what the invariant now forbids.
process.env["MANDATE_SIGNING_SECRET"] ??= "test-secret-not-a-real-key";

const validMandate = (over: Partial<MandateConstraints> = {}): Mandate =>
  signMandate({
    mandate_id: `mnd_${Math.random().toString(16).slice(2, 10)}`,
    issued_at: "2020-01-01T00:00:00Z",
    expires_at: "2099-01-01T00:00:00Z",
    constraints: { max_amount: { value: 10_000_000, currency: "INR" }, single_use: false, ...over },
    intent_text: "test purchase",
  });

const payment = {
  payment_data: { handler_id: RAZORPAY_LINK_HANDLER.id },
  mandate: validMandate(),
};

beforeEach(async () => {
  sql = await connectEphemeral();
  await migrate(sql);
  await upsertCatalog(sql, MERCHANT, [product()]);
});

/**
 * The cart total, written out rather than recomputed from the rule the code
 * uses: ₹899.00 item, plus ₹50 delivery because 89900 is BELOW the ₹1,000 free
 * threshold, plus 5% tax on 94900. A test that recomputed it with
 * `computeTotals` would agree with any arithmetic the code happened to do.
 *
 * The first draft of this constant assumed free delivery and read 94395, which
 * is how the ₹1,000 threshold turned out to be above this cart rather than
 * below it.
 */
const TOTAL = 99645;

describe("planCompletion — the policy, no database", () => {
  const facts = (o: Partial<CompletionFacts> = {}): CompletionFacts => ({
    status: "ready_for_payment",
    payment_link_id: null,
    payment_link_url: null,
    link_amount_minor: null,
    link_expires_at: null,
    total_minor: TOTAL,
    payable: true,
    ...o,
  });
  const now = new Date("2026-08-23T10:00:00Z");

  test("a clean payable session creates a link", () => {
    assert.equal(planCompletion(facts(), payment, now).action, "create");
  });

  test("the handler is checked before anything is priced or called", () => {
    const plan = planCompletion(facts(), { payment_data: { handler_id: "stripe_spt" } }, now);
    assert.equal(plan.action, "refuse");
    assert.equal(plan.action === "refuse" && plan.code, "unsupported_payment_handler");
  });

  test("a missing handler_id is refused, not defaulted", () => {
    const plan = planCompletion(facts(), {}, now);
    assert.equal(plan.action === "refuse" && plan.code, "unsupported_payment_handler");
  });

  test("an unpayable cart is refused before any call", () => {
    const plan = planCompletion(facts({ payable: false }), payment, now);
    assert.equal(plan.action === "refuse" && plan.code, "session_not_ready_for_payment");
  });

  test("terminal sessions are refused", () => {
    for (const status of ["canceled", "expired"] as const) {
      const plan = planCompletion(facts({ status }), payment, now);
      assert.equal(plan.action === "refuse" && plan.code, "session_terminal");
    }
    assert.equal(
      planCompletion(facts({ status: "completed" }), payment, now).action === "refuse" &&
        (planCompletion(facts({ status: "completed" }), payment, now) as any).code,
      "session_completed",
    );
  });

  const live = {
    status: "complete_in_progress" as const,
    payment_link_id: "plink_1",
    payment_link_url: "https://rzp.io/rzp/1",
    link_amount_minor: TOTAL,
    link_expires_at: new Date("2026-08-23T10:20:00Z"),
  };

  test("a live link at the same price is reused, never re-created", () => {
    const plan = planCompletion(facts(live), payment, now);
    assert.equal(plan.action, "reuse");
  });

  test("a live link at a DIFFERENT price is refused, not handed back", () => {
    // The drift case. Returning this link would charge the old price; making a
    // new one would leave two live links for one cart.
    const plan = planCompletion(facts({ ...live, total_minor: TOTAL + 20000 }), payment, now);
    assert.equal(plan.action === "refuse" && plan.code, "price_changed");
    assert.match((plan as any).message, /99645/);
    assert.match((plan as any).message, /119645/);
  });

  test("a link past its deadline expires the session", () => {
    const plan = planCompletion(
      facts({ ...live, link_expires_at: new Date("2026-08-23T09:59:59Z") }),
      payment,
      now,
    );
    assert.equal(plan.action, "expire");
  });

  test("the deadline is exclusive at the instant itself", () => {
    const plan = planCompletion(facts({ ...live, link_expires_at: now }), payment, now);
    assert.equal(plan.action, "expire");
  });
});

describe("expiryFor", () => {
  test("is 30 minutes, in SECONDS, and clears Razorpay's 15-minute floor", () => {
    const now = new Date("2026-08-23T10:00:00Z");
    const { at, unix } = expiryFor(now);
    assert.equal(at.toISOString(), "2026-08-23T10:30:00.000Z");
    // Seconds, not milliseconds. Milliseconds here would set an expiry in the
    // year 57000 and quietly delete the deadline the design rests on.
    assert.equal(unix, Math.floor(at.getTime() / 1000));
    // Independently computed, not read back from the code under test:
    // `python3 -c "datetime(2026,8,23,10,30,tzinfo=utc).timestamp()"`.
    assert.equal(unix, 1787481000);
    assert.ok(LINK_TTL_MINUTES > RAZORPAY_MIN_TTL_MINUTES);
  });
});

describe("completeSession", () => {
  const start = async () =>
    (await createSession(sql, MERCHANT, [{ id: "var_shoe", quantity: 1 }])).id;

  test("creates a link and parks the session in complete_in_progress", async () => {
    const id = await start();
    const client = fakeClient();
    const now = new Date("2026-08-23T10:00:00Z");

    const outcome = await completeSession(sql, id, payment, client, now);
    assert.ok(outcome?.ok);
    assert.equal(outcome.session.status, "complete_in_progress");
    assert.equal(outcome.reused, false);

    // The link was asked for at the authoritative total, in the session's
    // currency, keyed by the session id.
    assert.equal(client.calls.length, 1);
    assert.deepEqual(
      { ...client.calls[0], customer: undefined },
      {
        amount_minor: TOTAL,
        currency: "INR",
        reference_id: id,
        description: `Order ${id}`,
        expire_by: expiryFor(now).unix,
        customer: undefined,
      },
    );

    // The order carries the URL, because `links[]` cannot: `Link.type` is a
    // closed enum of policy pages with additionalProperties false.
    assert.equal(outcome.session.order.permalink_url, "https://rzp.io/rzp/fake1");
    assert.equal(outcome.session.order.checkout_session_id, id);
    assert.equal(outcome.session.order.status, "created");
    assert.equal(outcome.session.links.length, 0);
  });

  test("the response conforms to CheckoutSessionWithOrder, not just CheckoutSession", async () => {
    const id = await start();
    const outcome = await completeSession(sql, id, payment, fakeClient());
    assert.ok(outcome?.ok);
    assertValid("CheckoutSessionWithOrder", outcome.session);
  });

  test("the buyer is told, in the session, that a human must pay", async () => {
    const id = await start();
    const outcome = await completeSession(sql, id, payment, fakeClient());
    assert.ok(outcome?.ok);

    const info = outcome.session.messages.find((m) => m.type === "info");
    assert.ok(info);
    assert.equal(info.resolution, "requires_buyer_review");
    assert.match(info.content, /rzp\.io/);
    assert.match(info.content, /no charge has occurred/);
  });

  test("the link, its amount and its deadline are stored", async () => {
    const id = await start();
    const now = new Date("2026-08-23T10:00:00Z");
    await completeSession(sql, id, payment, fakeClient(), now);

    const { rows } = await sql.query<{
      payment_link_id: string;
      link_amount_minor: number;
      link_expires_at: Date;
      razorpay_order_id: string | null;
    }>(
      `select payment_link_id, link_amount_minor, link_expires_at, razorpay_order_id
         from checkout_session where id = $1`,
      [id],
    );
    assert.equal(rows[0]?.payment_link_id, "plink_fake1");
    assert.equal(rows[0]?.link_amount_minor, TOTAL);
    assert.equal(rows[0]?.link_expires_at.toISOString(), "2026-08-23T10:30:00.000Z");
    // Null until the webhook names it: a Payment Link creates its own order and
    // the create response does not carry its id.
    assert.equal(rows[0]?.razorpay_order_id, null);
  });

  test("a second complete reuses the link instead of creating another", async () => {
    const id = await start();
    const client = fakeClient();
    await completeSession(sql, id, payment, client, new Date("2026-08-23T10:00:00Z"));
    const again = await completeSession(sql, id, payment, client, new Date("2026-08-23T10:05:00Z"));

    assert.ok(again?.ok);
    assert.equal(again.reused, true);
    assert.equal(client.calls.length, 1);
    assert.equal(again.session.order.permalink_url, "https://rzp.io/rzp/fake1");
  });

  test("reuse does not extend the deadline", async () => {
    const id = await start();
    const client = fakeClient();
    await completeSession(sql, id, payment, client, new Date("2026-08-23T10:00:00Z"));
    await completeSession(sql, id, payment, client, new Date("2026-08-23T10:20:00Z"));

    const { rows } = await sql.query<{ link_expires_at: Date }>(
      `select link_expires_at from checkout_session where id = $1`,
      [id],
    );
    // Still the original 10:30. A polling agent must not be able to make a
    // 30-minute link immortal by retrying.
    assert.equal(rows[0]?.link_expires_at.toISOString(), "2026-08-23T10:30:00.000Z");
  });

  test("a price change under a live link is refused, and no second link is made", async () => {
    const id = await start();
    const client = fakeClient();
    await completeSession(sql, id, payment, client, new Date("2026-08-23T10:00:00Z"));

    // The merchant edits the sheet. This is Phase 5's drift, arriving early.
    await upsertCatalog(sql, MERCHANT, [
      product({ variants: [variant({ price: { amount_minor: 99900, currency: "INR" } })] }),
    ]);

    const again = await completeSession(sql, id, payment, client, new Date("2026-08-23T10:05:00Z"));
    assert.ok(again && !again.ok);
    assert.equal(again.code, "price_changed");
    assert.equal(again.status, 409);
    assert.equal(client.calls.length, 1);
  });

  test("an out-of-stock cart is refused BEFORE Razorpay is called", async () => {
    const id = await start();
    await upsertCatalog(sql, MERCHANT, [
      product({ variants: [variant({ availability: "out_of_stock" })] }),
    ]);

    const client = fakeClient();
    const outcome = await completeSession(sql, id, payment, client);
    assert.ok(outcome && !outcome.ok);
    assert.equal(outcome.code, "session_not_ready_for_payment");
    // The refusal happens with no payment call attempted, which is DESIGN.md §5
    // rule 1 and the reason this assertion exists at all.
    assert.equal(client.calls.length, 0);
  });

  test("the wrong handler never reaches the PSP", async () => {
    const id = await start();
    const client = fakeClient();
    const outcome = await completeSession(
      sql,
      id,
      // A VALID mandate, so this test asserts the handler refusal and not the
      // absence of authority. With neither, the gate answers first — correctly:
      // an agent that may not charge at all does not need to be told which
      // handler we prefer.
      { payment_data: { handler_id: "dev.acp.tokenized.card" }, mandate: validMandate() },
      client,
    );
    assert.ok(outcome && !outcome.ok);
    assert.equal(outcome.code, "unsupported_payment_handler");
    assert.equal(client.calls.length, 0);
  });

  test("a cancelled session cannot be completed", async () => {
    const id = await start();
    await cancelSession(sql, id);
    const client = fakeClient();
    const outcome = await completeSession(sql, id, payment, client);
    assert.ok(outcome && !outcome.ok);
    assert.equal(outcome.code, "session_terminal");
    assert.equal(client.calls.length, 0);
  });

  test("refusals do not depend on Razorpay being configured", async () => {
    // The live-HTTP failure this test exists for: a client whose construction
    // throws (no keys on the server) turned every 4xx refusal into a 502.
    const exploding: PaymentLinkClient = {
      async cancel() {
        return { status: "cancelled" };
      },
      create() {
        throw new Error("RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET are required");
      },
    };
    const id = await start();

    const wrongHandler = await completeSession(
      sql,
      id,
      { payment_data: { handler_id: "dev.acp.tokenized.card" }, mandate: validMandate() },
      exploding,
    );
    assert.ok(wrongHandler && !wrongHandler.ok);
    assert.equal(wrongHandler.status, 400);
    assert.equal(wrongHandler.code, "unsupported_payment_handler");

    await upsertCatalog(sql, MERCHANT, [
      product({ variants: [variant({ availability: "out_of_stock" })] }),
    ]);
    const unpayable = await completeSession(sql, id, payment, exploding);
    assert.ok(unpayable && !unpayable.ok);
    assert.equal(unpayable.status, 409);

    // And the create path still surfaces the configuration failure, rather than
    // swallowing it into a refusal that blames the agent.
    await upsertCatalog(sql, MERCHANT, [product()]);
    await assert.rejects(() => completeSession(sql, id, payment, exploding), /RAZORPAY_KEY_ID/);
  });

  test("an unknown session is null, not a refusal", async () => {
    assert.equal(await completeSession(sql, "cs_" + "0".repeat(24), payment, fakeClient()), null);
  });
});

describe("expiry, derived on read", () => {
  const start = async () =>
    (await createSession(sql, MERCHANT, [{ id: "var_shoe", quantity: 1 }])).id;

  const before = new Date("2026-08-23T10:00:00Z");
  // The link deadline is 10:30. Razorpay does not enforce `expire_by` at the
  // instant itself — a probe measured the flip to "expired" within 30s of it —
  // so the session waits out a 120s grace before calling itself expired. Any
  // time inside that grace is a time when the link may still be payable, and a
  // payment made there must still find a completable session.
  const after = new Date("2026-08-23T10:33:00Z");

  test("a GET past the deadline reports expired, with no webhook and no cron", async () => {
    const id = await start();
    await completeSession(sql, id, payment, fakeClient(), before);

    const live = await getSession(sql, id, new Date("2026-08-23T10:29:00Z"));
    assert.equal(live?.status, "complete_in_progress");

    const dead = await getSession(sql, id, after);
    assert.equal(dead?.status, "expired");
  });

  test("the derived expiry is persisted, not recomputed forever", async () => {
    const id = await start();
    await completeSession(sql, id, payment, fakeClient(), before);
    await getSession(sql, id, after);

    const { rows } = await sql.query<{ status: string; snapshot: { status: string } }>(
      `select status, snapshot from checkout_session where id = $1`,
      [id],
    );
    assert.equal(rows[0]?.status, "expired");
    // The snapshot is what a terminal GET serves, so it must move too.
    assert.equal(rows[0]?.snapshot.status, "expired");
  });

  test("an expired session cannot be updated", async () => {
    const id = await start();
    await completeSession(sql, id, payment, fakeClient(), before);

    const result = await updateSession(sql, id, { line_items: [{ id: "var_shoe", quantity: 2 }] }, after);
    assert.ok(result && !result.ok);
    assert.equal(result.code, "session_terminal");
  });

  test("an expired session cannot be cancelled into a different terminal state", async () => {
    const id = await start();
    await completeSession(sql, id, payment, fakeClient(), before);

    const result = await cancelSession(sql, id, after);
    assert.ok(result && !result.ok);
    assert.equal(result.code, "session_expired");
  });

  test("completing an expired session expires it and refuses", async () => {
    const id = await start();
    const client = fakeClient();
    await completeSession(sql, id, payment, client, before);

    const outcome = await completeSession(sql, id, payment, client, after);
    assert.ok(outcome && !outcome.ok);
    assert.equal(outcome.code, "session_expired");
    assert.equal(client.calls.length, 1);
    assert.equal((await getSession(sql, id, after))?.status, "expired");
  });
});

describe("cancelling a session must stop the link being payable", () => {
  // Verified live before this existed: the session read `canceled` while the
  // Razorpay link read `created`, and https://rzp.io/... still accepted
  // ₹2,570.40 for the rest of its thirty minutes. Anyone holding the URL could
  // pay an order the agent had already called off.
  const start = async () =>
    (await createSession(sql, MERCHANT, [{ id: "var_shoe", quantity: 1 }])).id;

  test("the live link is cancelled, and cancelled BEFORE the session", async () => {
    const id = await start();
    const client = fakeClient();
    const done = await completeSession(sql, id, payment, client);
    assert.ok(done?.ok);

    const result = await cancelSession(sql, id, new Date(), client);
    assert.ok(result?.ok);
    assert.equal(result.session.status, "canceled");
    assert.deepEqual(client.canceled, ["plink_fake1"]);
  });

  test("a link that cannot be cancelled leaves the session alone", async () => {
    const id = await start();
    const client = fakeClient();
    assert.ok((await completeSession(sql, id, payment, client))?.ok);

    // Razorpay refuses to cancel a link that has been paid. Marking the session
    // `canceled` anyway would claim a cancellation that is not true, for an
    // order somebody has already paid for. That is a refund, not a cancel.
    const refusing = {
      ...client,
      async cancel(): Promise<{ status: string }> {
        throw new Error("payment link is already paid");
      },
    };
    const result = await cancelSession(sql, id, new Date(), refusing);
    assert.equal(result?.ok, false);
    assert.equal(result?.code, "payment_link_not_cancellable");

    const after = await getSession(sql, id);
    assert.equal(after?.status, "complete_in_progress");
  });

  test("a session with no link cancels without calling Razorpay at all", async () => {
    const id = await start();
    const client = fakeClient();
    const result = await cancelSession(sql, id, new Date(), client);
    assert.ok(result?.ok);
    assert.equal(result.session.status, "canceled");
    assert.deepEqual(client.canceled, []);
  });
});

describe("the window between our deadline and Razorpay's enforcement of it", () => {
  // MEASURED, NOT ASSUMED. A probe against a real link found Razorpay flipping
  // it to "expired" within 30s of `expire_by` rather than at it. Declaring the
  // session expired at the nominal deadline therefore left a window where we
  // said expired and the link was still payable — a captured payment against a
  // session whose status refuses the transition. Money taken, no order, and
  // silent. The cancel defect's sibling.
  const start = async () =>
    (await createSession(sql, MERCHANT, [{ id: "var_shoe", quantity: 1 }])).id;

  const AT_CREATE = new Date("2026-08-23T10:00:00Z"); // link deadline 10:30
  const INSIDE_GRACE = new Date("2026-08-23T10:30:30Z");
  const PAST_GRACE = new Date("2026-08-23T10:33:00Z");

  test("a session inside the grace is NOT expired yet", async () => {
    const id = await start();
    assert.ok((await completeSession(sql, id, payment, fakeClient(), AT_CREATE))?.ok);

    assert.equal((await getSession(sql, id, INSIDE_GRACE))?.status, "complete_in_progress");
    assert.equal((await getSession(sql, id, PAST_GRACE))?.status, "expired");
  });

  test("a payment captured inside the grace still completes the session", async () => {
    // This is the whole point. The buyer paid while the link was genuinely
    // payable, so the order must exist. Before the grace this session read
    // `expired` by the time the webhook arrived, and the payment had nowhere
    // to land.
    const id = await start();
    assert.ok((await completeSession(sql, id, payment, fakeClient(), AT_CREATE))?.ok);

    const live = await getSession(sql, id, INSIDE_GRACE); // the read that used to expire it
    // The authoritative total, not a guess: the webhook refuses an amount that
    // disagrees with the session, and a test that hardcodes one is asserting
    // against its own arithmetic rather than the cart's.
    const total = live?.totals.find((t) => t.type === "total")?.amount ?? 0;
    assert.ok(total > 0);

    await handleEvent(
      sql,
      {
        event: "payment_link.paid",
        event_id: "evt_grace",
        session_id: id,
        link_id: "plink_fake1",
        order_id: "graceorder",
        order_id_raw: "order_graceorder",
        payment_id: "pay_grace",
        amount_minor: total,
        amount_paid_minor: total,
        currency: "INR",
      },
      INSIDE_GRACE,
    );

    const after = await getSession(sql, id, PAST_GRACE);
    assert.equal(after?.status, "completed", "a payment inside Razorpay's window must produce an order");
  });
});

describe("invariant 2 — no payment call executes without a valid mandate", () => {
  // The assertion that matters is NOT that the request is refused. It is that
  // `client.create` was never reached: a refusal that still spent a Razorpay
  // call would mean the gate ran after the money path, not before it.
  const start = async () =>
    (await createSession(sql, MERCHANT, [{ id: "var_shoe", quantity: 1 }])).id;

  const noCall = async (over: Record<string, unknown>, code: string) => {
    const id = await start();
    const client = fakeClient();
    const outcome = await completeSession(
      sql,
      id,
      { payment_data: { handler_id: RAZORPAY_LINK_HANDLER.id }, ...over },
      client,
    );
    assert.equal(outcome?.ok, false);
    assert.equal(outcome && !outcome.ok ? outcome.code : "", code);
    assert.deepEqual(client.calls, [], "a refused mandate must cost zero Razorpay calls");
    return id;
  };

  test("no mandate at all", async () => {
    await noCall({}, "MANDATE_MISSING");
  });

  test("a mandate whose signature does not verify", async () => {
    const forged = { ...validMandate(), signature: "0".repeat(64) };
    await noCall({ mandate: forged }, "MANDATE_SIGNATURE_INVALID");
  });

  test("a mandate whose constraints were edited after signing", async () => {
    // The ceiling is raised without re-signing. This is the attack the
    // signature exists for, and it must fail on the SIGNATURE — never by
    // slipping through to a ceiling comparison against the tampered value.
    const tampered = validMandate({ max_amount: { value: 1, currency: "INR" } });
    tampered.constraints.max_amount.value = 99_999_999;
    await noCall({ mandate: tampered }, "MANDATE_SIGNATURE_INVALID");
  });

  test("an expired mandate", async () => {
    await noCall(
      { mandate: signMandate({ ...validMandate(), expires_at: "2020-01-02T00:00:00Z" }) },
      "MANDATE_EXPIRED",
    );
  });

  test("a ceiling below the authoritative total", async () => {
    // The total includes delivery and tax; a ceiling above the bare item price
    // but below the real total must still refuse.
    await noCall(
      { mandate: validMandate({ max_amount: { value: 89_900, currency: "INR" } }) },
      "MANDATE_CEILING_EXCEEDED",
    );
  });

  test("the refusal is written to the audit log with both strings", async () => {
    const id = await noCall({}, "MANDATE_MISSING");
    const rows = await timeline(sql, id);
    const refusal = rows.find((r) => r.action === "mandate.verify" && r.outcome === "refused");
    assert.ok(refusal, "the refusal must be in the timeline");
    assert.equal(refusal.reason_code, "MANDATE_MISSING");
    assert.ok((refusal.reason_human ?? "").length > 0);
    assert.equal(refusal.session_status_at_event, "ready_for_payment");
  });

  test("a live link is NOT reused once its mandate has expired", async () => {
    // The dangerous case. A link minted under a valid mandate is still payable;
    // handing it back after the authority lapsed is money moving without
    // authority, which is the whole point of the gate.
    const id = await start();
    const client = fakeClient();
    const mandate = signMandate({ ...validMandate(), expires_at: "2026-08-23T10:15:00Z" });

    const first = await completeSession(
      sql, id, { payment_data: { handler_id: RAZORPAY_LINK_HANDLER.id }, mandate }, client,
      new Date("2026-08-23T10:00:00Z"),
    );
    assert.equal(first?.ok, true);
    assert.equal(client.calls.length, 1);

    const later = await completeSession(
      sql, id, { payment_data: { handler_id: RAZORPAY_LINK_HANDLER.id }, mandate }, client,
      new Date("2026-08-23T10:16:00Z"),
    );
    assert.equal(later?.ok, false);
    assert.equal(later && !later.ok ? later.code : "", "MANDATE_EXPIRED");
    assert.equal(client.calls.length, 1, "no second link, and the first is not handed out again");
  });
});

describe("two clocks — the mandate is the ceiling", () => {
  test("a link never outlives the mandate that authorised it", async () => {
    // A link outliving its mandate is a URL a person can still pay after the
    // authority to charge them lapsed. The reverse is merely inconvenient.
    const id = (await createSession(sql, MERCHANT, [{ id: "var_shoe", quantity: 1 }])).id;
    const client = fakeClient();
    const now = new Date("2026-08-23T10:00:00Z");
    // TWENTY minutes of authority against a thirty-minute link — above
    // Razorpay's fifteen-minute floor, so a link can legally be created, and
    // below our own TTL, so the mandate is still what truncates it. This read
    // "ten minutes" and passed only because fakeClient does not enforce the
    // floor: against the real PSP that case was always a 502, never the
    // truncated link this asserts.
    const mandate = signMandate({ ...validMandate(), expires_at: "2026-08-23T10:20:00Z" });

    await completeSession(
      sql, id, { payment_data: { handler_id: RAZORPAY_LINK_HANDLER.id }, mandate }, client, now,
    );

    assert.equal(client.calls[0]?.expire_by, Math.floor(Date.parse("2026-08-23T10:20:00Z") / 1000));
    const { rows } = await sql.query<{ link_expires_at: Date }>(
      "select link_expires_at from checkout_session where id = $1",
      [id],
    );
    assert.equal(rows[0]?.link_expires_at.toISOString(), "2026-08-23T10:20:00.000Z");
  });

  test("a mandate too near expiry is refused here, not by the PSP", async () => {
    // Below Razorpay's fifteen-minute floor. The old behaviour truncated the
    // link anyway, Razorpay rejected it, and the agent got a 502 naming the
    // PSP for our arithmetic — plus a burnt idempotency key. RAZORPAY_MIN_TTL
    // was exported for this and never read.
    const id = (await createSession(sql, MERCHANT, [{ id: "var_shoe", quantity: 1 }])).id;
    const client = fakeClient();
    const now = new Date("2026-08-23T10:00:00Z");
    const mandate = signMandate({ ...validMandate(), expires_at: "2026-08-23T10:06:00Z" });

    const outcome = await completeSession(
      sql, id, { payment_data: { handler_id: RAZORPAY_LINK_HANDLER.id }, mandate }, client, now,
    );

    assert.ok(outcome && !outcome.ok);
    assert.equal(outcome.code, "MANDATE_EXPIRES_TOO_SOON");
    assert.equal(client.calls.length, 0, "no PSP call is made for a deadline it would reject");

    // And it is on the record, with the numbers that explain it.
    const { rows } = await sql.query<{ reason_code: string; evidence: Record<string, unknown> }>(
      "select reason_code, evidence from audit_event where session_id = $1 and outcome = 'refused'",
      [id],
    );
    assert.equal(rows[0]?.reason_code, "MANDATE_EXPIRES_TOO_SOON");
    assert.equal(rows[0]?.evidence["minimum_link_ttl_minutes"], 15);
  });

  test("a mandate outliving the link leaves our thirty minutes alone", async () => {
    const id = (await createSession(sql, MERCHANT, [{ id: "var_shoe", quantity: 1 }])).id;
    const client = fakeClient();
    await completeSession(
      sql, id, payment, client, new Date("2026-08-23T10:00:00Z"),
    );
    assert.equal(client.calls[0]?.expire_by, Math.floor(Date.parse("2026-08-23T10:30:00Z") / 1000));
  });
});

describe("the failure path: drift refused, logged, alternative offered", () => {
  // DESIGN.md §5. One scenario that exercises all five bar items — explainable,
  // bounded, gated, audited, gracefully failed.
  const cheaper = () =>
    product({
      id: "prod_cheap",
      variants: [variant({ id: "var_cheap", title: "Canvas Shoe - Budget", price: { amount_minor: 40000, currency: "INR" } })],
    });

  /**
   * UNDER THE CEILING AS AN ITEM, OVER IT AS A CART. 58000 fits a 60000
   * ceiling; 58000 + 5000 delivery + 5% tax is 66150 and does not. This is the
   * exact shape that broke on the real catalogue — the finder compared the bare
   * item price while the gate compared the authoritative total, so it offered
   * something the gate then refused, which is the loop it exists to avoid.
   *
   * Without a product in this band the suite cannot see the bug: every earlier
   * fixture had enough headroom that item-price and cart-total agreed.
   */
  const justOverOnceTaxed = () =>
    product({
      id: "prod_edge",
      variants: [variant({ id: "var_edge", title: "Canvas Shoe - Edge", price: { amount_minor: 58000, currency: "INR" } })],
    });

  /**
   * OVER THE CEILING AND NOT IN THE CART, which is what makes the assertions
   * below able to fail. Without it the catalogue holds only the refused item
   * and one affordable option, so a ceiling filter that did nothing at all
   * would still offer something affordable and every assertion would pass —
   * a suite that looks like it tests the property and does not. Verified by
   * removing the ceiling clause and watching these fail.
   */
  const tooDear = () =>
    product({
      id: "prod_lux",
      variants: [variant({ id: "var_lux", title: "Canvas Shoe - Limited", price: { amount_minor: 250000, currency: "INR" } })],
    });

  test("a cart over the ceiling is refused with no PSP call, and offered something it can afford", async () => {
    await upsertCatalog(sql, MERCHANT, [product(), cheaper(), tooDear(), justOverOnceTaxed()]);
    const id = (await createSession(sql, MERCHANT, [{ id: "var_shoe", quantity: 1 }])).id;
    const client = fakeClient();

    // Authority for less than the cart costs.
    const mandate = validMandate({ max_amount: { value: 60000, currency: "INR" } });
    const outcome = await completeSession(
      sql, id, { payment_data: { handler_id: RAZORPAY_LINK_HANDLER.id }, mandate }, client,
    );

    assert.equal(outcome?.ok, false);
    assert.ok(outcome && !outcome.ok);
    assert.equal(outcome.code, "MANDATE_CEILING_EXCEEDED");
    // Bounded and gated: refused BEFORE any Razorpay call.
    assert.deepEqual(client.calls, []);

    // Gracefully failed: something it could actually buy instead.
    assert.ok(outcome.alternatives && outcome.alternatives.length > 0, "no alternative offered");
    for (const alt of outcome.alternatives) {
      // The ITEM price fitting is not the test — the CART TOTAL fitting is,
      // because that is what the gate compares. var_edge fits the first and
      // fails the second.
      assert.notEqual(alt.id, "var_edge", "offered an item whose cart total exceeds the ceiling");
      assert.ok(alt.price_minor <= 60000, `${alt.id} is over the ceiling it was offered against`);
      assert.notEqual(alt.id, "var_shoe", "the refused item was offered back");
    }
  });

  test("an alternative offered would itself pass the gate", async () => {
    // THE INVERSE OF THE SPECIFICITY RULE. The gate must not refuse what the
    // mandate allows; this must not offer what the gate would refuse. An
    // alternative that fails on the next call sends the agent around a loop and
    // spends its budget to arrive back here.
    await upsertCatalog(sql, MERCHANT, [product(), cheaper(), tooDear(), justOverOnceTaxed()]);
    const id = (await createSession(sql, MERCHANT, [{ id: "var_shoe", quantity: 1 }])).id;
    const mandate = validMandate({ max_amount: { value: 60000, currency: "INR" } });

    const refused = await completeSession(
      sql, id, { payment_data: { handler_id: RAZORPAY_LINK_HANDLER.id }, mandate }, fakeClient(),
    );
    assert.ok(refused && !refused.ok && refused.alternatives?.length);

    // Take the offer and walk it back through the whole path.
    const alt = refused.alternatives[0]!;
    const second = (await createSession(sql, MERCHANT, [{ id: alt.id, quantity: 1 }])).id;
    const client = fakeClient();
    const outcome = await completeSession(
      sql, second, { payment_data: { handler_id: RAZORPAY_LINK_HANDLER.id }, mandate }, client,
    );

    assert.equal(outcome?.ok, true, "the alternative we offered was refused by our own gate");
    assert.equal(client.calls.length, 1);
  });

  test("a refusal an alternative cannot answer gets none", async () => {
    // An expired mandate is not fixed by a cheaper product, and offering one
    // would imply the purchase is still possible.
    await upsertCatalog(sql, MERCHANT, [product(), cheaper(), tooDear(), justOverOnceTaxed()]);
    const id = (await createSession(sql, MERCHANT, [{ id: "var_shoe", quantity: 1 }])).id;
    const expired = signMandate({ ...validMandate(), expires_at: "2020-01-02T00:00:00Z" });

    const outcome = await completeSession(
      sql, id, { payment_data: { handler_id: RAZORPAY_LINK_HANDLER.id }, mandate: expired }, fakeClient(),
    );
    assert.ok(outcome && !outcome.ok);
    assert.equal(outcome.code, "MANDATE_EXPIRED");
    assert.deepEqual(outcome.alternatives ?? [], []);
  });

  test("the drift is named in the audit trail, not just the total", async () => {
    await upsertCatalog(sql, MERCHANT, [product()]);
    // The agent quotes the price it read from the feed; the catalogue has moved.
    const id = (await createSession(sql, MERCHANT, [
      { id: "var_shoe", quantity: 1, quoted_minor: 79900 },
    ])).id;

    await completeSession(
      sql,
      id,
      {
        payment_data: { handler_id: RAZORPAY_LINK_HANDLER.id },
        mandate: validMandate({ max_amount: { value: 60000, currency: "INR" } }),
      },
      fakeClient(),
    );

    const rows = await timeline(sql, id);
    const refusal = rows.find((r) => r.action === "mandate.verify" && r.outcome === "refused");
    assert.ok(refusal);
    const drift = (refusal.evidence as { drift?: Array<Record<string, number>> }).drift ?? [];
    assert.equal(drift.length, 1, "the drift that caused this is not in the record");
    assert.equal(drift[0]?.["quoted_minor"], 79900);
    assert.equal(drift[0]?.["live_minor"], 89900);
  });
});

describe("the alternatives pre-filter window", () => {
  test("cheap affordable items are not crowded out by expensive ones", async () => {
    // THE BUG THE CONFORMANCE RUN FOUND. The SQL narrowed by ITEM price and
    // took the most expensive matches, then the cart-total filter rejected all
    // of them — so when delivery and tax pushed the whole window over the
    // ceiling, the affordable cheap items were never fetched and the refusal
    // offered nothing. A ceiling of 11234 against real items at 5700 returned
    // an empty list while three perfectly good alternatives existed.
    //
    // Enough expensive-but-under-ceiling items to fill the window, and one
    // cheap one that only survives if the bound is computed rather than
    // approximated.
    const filler = Array.from({ length: 14 }, (_, i) =>
      product({
        id: `prod_fill_${i}`,
        variants: [
          variant({
            id: `var_fill_${i}`,
            title: `Filler ${i}`,
            // Under the ceiling as an item, over it as a cart.
            price: { amount_minor: 58000 + i, currency: "INR" },
          }),
        ],
      }),
    );
    const affordable = product({
      id: "prod_tiny",
      variants: [variant({ id: "var_tiny", title: "Tiny", price: { amount_minor: 1000, currency: "INR" } })],
    });

    await upsertCatalog(sql, MERCHANT, [product(), affordable, ...filler]);
    const id = (await createSession(sql, MERCHANT, [{ id: "var_shoe", quantity: 1 }])).id;

    const outcome = await completeSession(
      sql,
      id,
      {
        payment_data: { handler_id: RAZORPAY_LINK_HANDLER.id },
        mandate: validMandate({ max_amount: { value: 60000, currency: "INR" } }),
      },
      fakeClient(),
    );

    assert.ok(outcome && !outcome.ok);
    assert.equal(outcome.code, "MANDATE_CEILING_EXCEEDED");
    assert.ok(
      outcome.alternatives?.some((a) => a.id === "var_tiny"),
      "the only affordable item was crowded out of the pre-filter window",
    );
  });
});

describe("single_use is enforced by the caller, not only by the gate", () => {
  /**
   * THE GATE WAS ALWAYS RIGHT AND NOBODY SPENT THE MANDATE. `consume` was
   * imported by complete.ts and never called, so `mandate_consumption` stayed
   * empty, every single_use check read "not consumed", and one mandate could
   * pay for unlimited carts until it expired.
   *
   * Thirty-two green gate tests did not catch it because they pass `consumed`
   * IN as an argument — they assert the rule and can say nothing about whether
   * a caller ever sets it. That is the shape CLAUDE.md warns about twice: an
   * untested path is an assumption, and a rule's own tests cannot falsify it.
   * These drive the real caller against a real database instead.
   */
  const start = async () =>
    (await createSession(sql, MERCHANT, [{ id: "var_shoe", quantity: 1 }])).id;

  test("a second session cannot spend the same single-use mandate", async () => {
    const mandate = validMandate({ single_use: true });
    const first = await completeSession(
      sql,
      await start(),
      { ...payment, mandate },
      fakeClient(),
      new Date("2026-08-23T10:00:00Z"),
    );
    assert.ok(first?.ok, "the first purchase should succeed");

    const second = await completeSession(
      sql,
      await start(),
      { ...payment, mandate },
      fakeClient(),
      new Date("2026-08-23T10:01:00Z"),
    );
    assert.ok(second && !second.ok, "the second purchase must be refused");
    assert.equal(second.code, "MANDATE_ALREADY_CONSUMED");
  });

  test("the SAME session may retry with the mandate it already spent", async () => {
    // Invariant 4: a dropped response is retried, and that retry must work.
    // Refusing it would protect nothing — the link already exists — while
    // turning every network blip into a dead mandate.
    const mandate = validMandate({ single_use: true });
    const id = await start();
    const client = fakeClient();

    const first = await completeSession(sql, id, { ...payment, mandate }, client, new Date("2026-08-23T10:00:00Z"));
    assert.ok(first?.ok);

    const retry = await completeSession(sql, id, { ...payment, mandate }, client, new Date("2026-08-23T10:02:00Z"));
    assert.ok(retry?.ok, "the same session retrying must still succeed");
    assert.equal(retry.reused, true, "and must reuse the existing link, not make a second one");
    assert.equal(client.calls.length, 1, "exactly one payment link for one cart");
  });

  test("a NON single-use mandate may be spent again", async () => {
    // The refusal must come from the constraint, not from having been seen.
    const mandate = validMandate({ single_use: false });
    const a = await completeSession(sql, await start(), { ...payment, mandate }, fakeClient(), new Date("2026-08-23T10:00:00Z"));
    const b = await completeSession(sql, await start(), { ...payment, mandate }, fakeClient(), new Date("2026-08-23T10:01:00Z"));
    assert.ok(a?.ok && b?.ok, "single_use: false authorises more than one purchase");
  });
});
