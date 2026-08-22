/**
 * Checkout sessions and authoritative cart state. Pure ACP — no Razorpay.
 *
 * The assertions that matter are the authority ones. "Checkout is
 * authoritative" (rfc.product_feeds.md §3.3) is a claim about behaviour, and it
 * is only true if the cart is recomputed from the live catalogue rather than
 * replayed from a stored snapshot. So these tests move the catalogue underneath
 * a live session and assert the session follows.
 */
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { connectEphemeral } from "../lib/db/sql.ts";
import type { Sql } from "../lib/db/sql.ts";
import { migrate } from "../lib/db/migrate.ts";
import { upsertCatalog, setPrice, setAvailability, lookupVariants } from "../lib/catalog/store.ts";
import {
  cancelSession,
  createSession,
  getSession,
  updateSession,
  MAX_QUANTITY,
} from "../lib/checkout/session.ts";
import { computeTotals, taxOn, fulfillmentFor, totalOf } from "../lib/checkout/totals.ts";
import { validate } from "../lib/checkout/validate.ts";
import type { Product, Variant } from "../lib/normalize/schema.ts";

const MERCHANT = "mer_lakshmi";
let sql: Sql;

const provenance = {
  source_file: "s.xlsx",
  source_sheet: "S",
  source_row: 2,
  source_cells: {},
};
const clean = { confidence: 0.95, flags: [], needs_review: false };

function variant(over: Partial<Variant> = {}): Variant {
  return {
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
    ...over,
  };
}

function product(over: Partial<Product> = {}): Product {
  return {
    id: "prod_shoe",
    merchant_id: MERCHANT,
    title: "Canvas Shoe",
    description: null,
    brand: null,
    variants: [variant()],
    image_url: null,
    provenance,
    normalization: clean,
    ...over,
  };
}

beforeEach(async () => {
  sql = await connectEphemeral();
  await migrate(sql);
  await upsertCatalog(sql, MERCHANT, [
    product(),
    product({
      id: "prod_belt",
      title: "Leather Belt",
      variants: [
        variant({ id: "var_belt", title: "Leather Belt - Black", price: { amount_minor: 55000, currency: "INR" } }),
      ],
    }),
  ]);
});

describe("the live catalogue is separate from the published feed", () => {
  test("only servable variants are published into it", async () => {
    const fresh = await connectEphemeral();
    await migrate(fresh);
    const n = await upsertCatalog(fresh, MERCHANT, [
      product(),
      product({
        id: "prod_bad",
        variants: [
          variant({
            id: "var_bad",
            normalization: { confidence: 0.2, flags: ["PRICE_AMBIGUOUS"], needs_review: true },
          }),
        ],
      }),
    ]);
    assert.equal(n, 1, "a withheld variant must not be buyable");
    const found = await lookupVariants(fresh, MERCHANT, ["var_bad"]);
    assert.equal(found.size, 0);
  });

  test("prices are stored and read back as integer minor units", async () => {
    const found = await lookupVariants(sql, MERCHANT, ["var_shoe"]);
    const v = found.get("var_shoe");
    assert.ok(v);
    assert.equal(v.price_minor, 89900);
    assert.ok(Number.isInteger(v.price_minor));
  });
});

describe("totals are integer arithmetic with a stated rounding rule", () => {
  test("subtotal, flat delivery, 5% tax, and a total that equals its parts", () => {
    const totals = computeTotals([
      { variant: { price_minor: 89900 } as never, quantity: 1, amount: 89900 },
    ]);
    const by = (t: string) => totals.find((x) => x.type === t)?.amount;

    assert.equal(by("subtotal"), 89900);
    assert.equal(by("fulfillment"), 5000); // under the free threshold
    assert.equal(by("tax"), taxOn(94900));
    // The breakdown a buyer reads and the amount charged cannot disagree.
    assert.equal(by("total"), 89900 + 5000 + taxOn(94900));
  });

  test("delivery is free above the threshold", () => {
    assert.equal(fulfillmentFor(99999, 1), 5000);
    assert.equal(fulfillmentFor(100000, 1), 0);
    // An empty cart costs nothing to deliver — see totals.ts.
    assert.equal(fulfillmentFor(0, 0), 0);
  });

  test("every amount is an integer, at every quantity", () => {
    for (const q of [1, 3, 7, 99]) {
      const totals = computeTotals([
        { variant: { price_minor: 33333 } as never, quantity: q, amount: 33333 * q },
      ]);
      for (const t of totals) {
        assert.ok(Number.isInteger(t.amount), `${t.type} at qty ${q} is not an integer`);
      }
    }
  });

  test("tax rounds half up at the single point a fraction occurs", () => {
    // 5% of 101 is 5.05 -> 5;  5% of 110 is 5.5 -> 6.
    assert.equal(taxOn(101), 5);
    assert.equal(taxOn(110), 6);
  });
});

describe("session creation prices from the catalogue, not from the request", () => {
  test("a valid cart is ready_for_payment with authoritative amounts", async () => {
    const s = await createSession(sql, MERCHANT, [{ id: "var_shoe", quantity: 2 }]);

    assert.match(s.id, /^cs_[a-f0-9]{24}$/);
    assert.equal(s.status, "ready_for_payment");
    assert.equal(s.line_items.length, 1);
    // The agent sent only an id and a quantity. Everything else is ours.
    assert.equal(s.line_items[0]?.unit_amount, 89900);
    assert.equal(totalOf(s.line_items[0]?.totals ?? []), 179800);
    assert.equal(totalOf(s.totals), 179800 + 0 + taxOn(179800));
    assert.deepEqual(s.messages, []);
  });

  test("an unknown item is refused with a message, not priced as zero", async () => {
    const s = await createSession(sql, MERCHANT, [{ id: "var_ghost", quantity: 1 }]);
    assert.equal(s.status, "not_ready_for_payment");
    assert.equal(s.line_items.length, 0);
    assert.equal(s.messages[0]?.code, "invalid");
    assert.match(s.messages[0]?.param ?? "", /line_items\[0\]\.id/);
    // A zero-total payable cart is how you charge nothing for something.
    assert.equal(totalOf(s.totals), 0);
    assert.notEqual(s.status, "ready_for_payment");
  });

  test("an out-of-stock item is refused with its own code", async () => {
    await setAvailability(sql, MERCHANT, "var_shoe", "out_of_stock");
    const s = await createSession(sql, MERCHANT, [{ id: "var_shoe", quantity: 1 }]);
    assert.equal(s.status, "not_ready_for_payment");
    assert.equal(s.messages[0]?.code, "out_of_stock");
  });

  test("quantities are validated at the trust boundary", async () => {
    for (const q of [0, -1, 1.5, MAX_QUANTITY + 1]) {
      const s = await createSession(sql, MERCHANT, [{ id: "var_shoe", quantity: q }]);
      assert.equal(s.status, "not_ready_for_payment", `quantity ${q}`);
      assert.match(s.messages[0]?.param ?? "", /quantity/);
    }
  });

  test("one bad item does not silently price the rest as payable", async () => {
    const s = await createSession(sql, MERCHANT, [
      { id: "var_shoe", quantity: 1 },
      { id: "var_ghost", quantity: 1 },
    ]);
    assert.equal(s.line_items.length, 1);
    // Charging for the half we understood is worse than refusing the cart.
    assert.equal(s.status, "not_ready_for_payment");
  });
});

describe("authoritative means RE-READ, not replayed", () => {
  test("a price change moves a live session's total", async () => {
    const before = await createSession(sql, MERCHANT, [{ id: "var_shoe", quantity: 1 }]);
    assert.equal(before.line_items[0]?.unit_amount, 89900);

    // The merchant raises the price. The feed snapshot is untouched.
    await setPrice(sql, MERCHANT, "var_shoe", 99900);

    const after = await getSession(sql, before.id);
    assert.ok(after);
    assert.equal(after.line_items[0]?.unit_amount, 99900, "GET replayed a stale price");
    assert.equal(totalOf(after.totals), 99900 + 5000 + taxOn(104900));
  });

  test("going out of stock moves a ready session back to not_ready", async () => {
    const s = await createSession(sql, MERCHANT, [{ id: "var_shoe", quantity: 1 }]);
    assert.equal(s.status, "ready_for_payment");

    await setAvailability(sql, MERCHANT, "var_shoe", "out_of_stock");

    const after = await getSession(sql, s.id);
    assert.ok(after);
    assert.equal(after.status, "not_ready_for_payment");
    assert.equal(after.messages[0]?.code, "out_of_stock");
  });

  test("an item deleted from the catalogue is reported, not silently dropped", async () => {
    const s = await createSession(sql, MERCHANT, [{ id: "var_belt", quantity: 1 }]);
    assert.equal(s.status, "ready_for_payment");

    await sql.query(`delete from catalog_variant where variant_id = 'var_belt'`);

    const after = await getSession(sql, s.id);
    assert.ok(after);
    assert.equal(after.status, "not_ready_for_payment");
    assert.equal(after.messages[0]?.code, "invalid");
  });
});

describe("update and cancel", () => {
  test("update replaces the cart and re-prices it", async () => {
    const s = await createSession(sql, MERCHANT, [{ id: "var_shoe", quantity: 1 }]);
    const r = await updateSession(sql, s.id, {
      line_items: [{ id: "var_belt", quantity: 2 }],
    });
    assert.ok(r?.ok);
    assert.equal(r.session.line_items[0]?.name, "Leather Belt - Black");
    assert.equal(totalOf(r.session.line_items[0]?.totals ?? []), 110000);
  });

  test("cancel is terminal, and a cancelled session stops re-pricing", async () => {
    const s = await createSession(sql, MERCHANT, [{ id: "var_shoe", quantity: 1 }]);
    const c = await cancelSession(sql, s.id);
    assert.ok(c?.ok);
    assert.equal(c.session.status, "canceled");

    // A terminal session is a historical record. Moving the catalogue must not
    // rewrite what it says.
    await setPrice(sql, MERCHANT, "var_shoe", 500000);
    const after = await getSession(sql, s.id);
    assert.equal(after?.status, "canceled");
    assert.equal(after?.line_items[0]?.unit_amount, 89900, "history was rewritten");
  });

  test("a terminal session cannot be updated", async () => {
    const s = await createSession(sql, MERCHANT, [{ id: "var_shoe", quantity: 1 }]);
    await cancelSession(sql, s.id);
    const r = await updateSession(sql, s.id, { line_items: [{ id: "var_belt", quantity: 1 }] });
    assert.equal(r?.ok, false);
    if (r && !r.ok) assert.equal(r.code, "session_terminal");
  });

  test("cancelling twice is a no-op, not an error — the agent may be retrying", async () => {
    const s = await createSession(sql, MERCHANT, [{ id: "var_shoe", quantity: 1 }]);
    await cancelSession(sql, s.id);
    const again = await cancelSession(sql, s.id);
    assert.ok(again?.ok);
    assert.equal(again.session.status, "canceled");
  });

  test("unknown ids return null rather than inventing a session", async () => {
    assert.equal(await getSession(sql, "cs_nope"), null);
    assert.equal(await updateSession(sql, "cs_nope", {}), null);
    assert.equal(await cancelSession(sql, "cs_nope"), null);
  });
});

describe("ACP conformance of the session payload", () => {
  test("a priced session validates against the pinned checkout schema", async () => {
    const s = await createSession(sql, MERCHANT, [{ id: "var_shoe", quantity: 2 }]);
    const errors = validate("CheckoutSession", s);
    assert.deepEqual(errors, [], JSON.stringify(errors));
  });

  test("a session carrying error messages also validates", async () => {
    const s = await createSession(sql, MERCHANT, [{ id: "var_ghost", quantity: 1 }]);
    assert.deepEqual(validate("CheckoutSession", s), []);
  });

  test("the checkout validator actually rejects", () => {
    // Guard against a vacuous conformance suite, as with the feed validator.
    assert.ok(validate("CheckoutSession", { id: "cs_1", status: "nonsense" }).length > 0);
    assert.ok(validate("CheckoutSession", { status: "ready_for_payment" }).length > 0);
  });

  test("it is a DIFFERENT schema from the feed's", async () => {
    // Sharing an ajv factory must not become sharing a schema.
    const { validate: validateFeed } = await import("../lib/feed/validate.ts");
    const session = await createSession(sql, MERCHANT, [{ id: "var_shoe", quantity: 1 }]);
    assert.ok(validateFeed("Product", session).length > 0, "a session is not a feed Product");
  });
});
