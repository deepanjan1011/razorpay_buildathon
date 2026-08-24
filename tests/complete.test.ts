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
const payment = { payment_data: { handler_id: RAZORPAY_LINK_HANDLER.id } };

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
      { payment_data: { handler_id: "dev.acp.tokenized.card" } },
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
      { payment_data: { handler_id: "dev.acp.tokenized.card" } },
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
  const after = new Date("2026-08-23T10:31:00Z");

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
