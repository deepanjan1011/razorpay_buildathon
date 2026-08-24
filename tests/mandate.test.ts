/**
 * The verification gate. CLAUDE.md invariant 2.
 *
 * HALF OF THIS FILE ASSERTS THAT VALID PURCHASES ARE ALLOWED, and that half is
 * the one that matters. A gate that refuses everything passes every refusal
 * test ever written, and DESIGN.md §3 is explicit that a mandate refusing too
 * readily makes agentic purchase impossible while looking like rigour. Each
 * "allowed" case below is a purchase the LOOSE version of a check would have
 * refused.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { verifyMandate } from "../lib/mandate/verify.ts";
import type { GateInput } from "../lib/mandate/verify.ts";
import type { Mandate } from "../lib/mandate/schema.ts";

const NOW = new Date("2026-08-24T10:00:00Z");

const mandate = (over: Partial<Mandate> = {}): Mandate => ({
  mandate_id: "mnd_1",
  issued_at: "2026-08-24T09:00:00Z",
  expires_at: "2026-08-24T11:00:00Z",
  constraints: { max_amount: { value: 300000, currency: "INR" }, single_use: true },
  intent_text: "black running shoes under 3000",
  signature: "sig",
  ...over,
});

const input = (over: Partial<GateInput> = {}): GateInput => ({
  mandate: mandate(),
  consumed: false,
  signatureValid: true,
  cart: { total_minor: 250000, currency: "INR", categories: ["footwear"], item_count: 1 },
  now: NOW,
  ...over,
});

const refusalOf = (over: Partial<GateInput> = {}) => {
  const verdict = verifyMandate(input(over));
  assert.equal(verdict.ok, false, "expected a refusal");
  return verdict.ok ? null : verdict;
};

describe("the gate refuses exactly the unsafe cases", () => {
  test("nothing presented", () => {
    assert.equal(refusalOf({ mandate: null })?.reason_code, "MANDATE_MISSING");
  });

  test("a signature that does not verify", () => {
    assert.equal(refusalOf({ signatureValid: false })?.reason_code, "MANDATE_SIGNATURE_INVALID");
  });

  test("expired at the moment of the payment call", () => {
    assert.equal(
      refusalOf({ now: new Date("2026-08-24T11:00:00Z") })?.reason_code,
      "MANDATE_EXPIRED",
    );
  });

  test("a mandate whose validity has not started", () => {
    assert.equal(
      refusalOf({ now: new Date("2026-08-24T08:59:00Z") })?.reason_code,
      "MANDATE_NOT_YET_VALID",
    );
  });

  test("single-use and already spent", () => {
    assert.equal(refusalOf({ consumed: true })?.reason_code, "MANDATE_ALREADY_CONSUMED");
  });

  test("a total above the ceiling", () => {
    const r = refusalOf({
      cart: { total_minor: 300001, currency: "INR", categories: ["footwear"], item_count: 1 },
    });
    assert.equal(r?.reason_code, "MANDATE_CEILING_EXCEEDED");
    // Both numbers, because a refusal an agent cannot act on is a dead end.
    assert.match(r?.reason_human ?? "", /300001.*300000/);
  });

  test("a currency the mandate does not authorise is its own refusal", () => {
    // NOT a ceiling breach: comparing 250000 paise against 300000 cents is a
    // number that looks fine and means nothing.
    assert.equal(
      refusalOf({
        cart: { total_minor: 250000, currency: "USD", categories: ["footwear"], item_count: 1 },
      })?.reason_code,
      "MANDATE_CURRENCY_MISMATCH",
    );
  });

  test("a category outside a present constraint", () => {
    assert.equal(
      refusalOf({
        mandate: mandate({
          constraints: {
            max_amount: { value: 300000, currency: "INR" },
            categories: ["footwear"],
            single_use: true,
          },
        }),
        cart: { total_minor: 250000, currency: "INR", categories: ["apparel"], item_count: 1 },
      })?.reason_code,
      "MANDATE_CATEGORY_NOT_PERMITTED",
    );
  });

  test("an unmapped item under a category-constrained mandate", () => {
    // `unmapped` is a member of no list of real categories, so it is refused by
    // construction. This is what lets unmapped products stay discoverable in
    // the feed while remaining unbuyable under a category constraint.
    assert.equal(
      refusalOf({
        mandate: mandate({
          constraints: {
            max_amount: { value: 300000, currency: "INR" },
            categories: ["footwear"],
            single_use: true,
          },
        }),
        cart: { total_minor: 250000, currency: "INR", categories: ["unmapped"], item_count: 1 },
      })?.reason_code,
      "MANDATE_CATEGORY_NOT_PERMITTED",
    );
  });

  test("more items than authorised", () => {
    assert.equal(
      refusalOf({
        mandate: mandate({
          constraints: {
            max_amount: { value: 300000, currency: "INR" },
            max_items: 1,
            single_use: true,
          },
        }),
        cart: { total_minor: 250000, currency: "INR", categories: ["footwear"], item_count: 2 },
      })?.reason_code,
      "MANDATE_ITEM_COUNT_EXCEEDED",
    );
  });
});

describe("the gate ALLOWS purchases a loose check would refuse", () => {
  test("an unmapped item when the mandate names NO categories", () => {
    // The loose version refuses any `unmapped` product outright. That makes
    // every product the mapper could not place unbuyable, even for a buyer who
    // never asked for a category — the Phase 1 failure with money attached.
    assert.equal(
      verifyMandate(
        input({
          cart: { total_minor: 250000, currency: "INR", categories: ["unmapped"], item_count: 1 },
        }),
      ).ok,
      true,
    );
  });

  test("a mandate near expiry when the cart was built but valid when charged", () => {
    // The loose version evaluates expiry at session create. A mandate with one
    // minute left is a mandate with one minute left.
    assert.equal(
      verifyMandate(input({ now: new Date("2026-08-24T10:59:59Z") })).ok,
      true,
    );
  });

  test("a retry of a single-use mandate that was never actually spent", () => {
    // The loose version refuses a mandate merely SEEN before, which kills the
    // idempotent retry invariant 4 requires after a transport failure.
    assert.equal(verifyMandate(input({ consumed: false })).ok, true);
  });

  test("a total exactly at the ceiling", () => {
    // Off-by-one here refuses a purchase for precisely the authorised amount.
    assert.equal(
      verifyMandate(
        input({
          cart: { total_minor: 300000, currency: "INR", categories: ["footwear"], item_count: 1 },
        }),
      ).ok,
      true,
    );
  });

  test("two products the buyer asked for, under a two-item mandate", () => {
    // The loose version counts expanded variants and refuses this as four.
    assert.equal(
      verifyMandate(
        input({
          mandate: mandate({
            constraints: {
              max_amount: { value: 300000, currency: "INR" },
              max_items: 2,
              single_use: true,
            },
          }),
          cart: {
            total_minor: 250000,
            currency: "INR",
            categories: ["footwear", "apparel"],
            item_count: 2,
          },
        }),
      ).ok,
      true,
    );
  });

  test("a mandate that is not single-use is reusable", () => {
    assert.equal(
      verifyMandate(
        input({
          mandate: mandate({
            constraints: { max_amount: { value: 300000, currency: "INR" }, single_use: false },
          }),
          consumed: true,
        }),
      ).ok,
      true,
    );
  });
});

describe("an EMPTY category list is not an absent one", () => {
  test("it authorises nothing, where absent authorises anything", () => {
    // Conflating these is how a mandate meaning "no categories agreed yet"
    // silently becomes "any category". They are opposite claims.
    const empty = verifyMandate(
      input({
        mandate: mandate({
          constraints: {
            max_amount: { value: 300000, currency: "INR" },
            categories: [],
            single_use: true,
          },
        }),
      }),
    );
    assert.equal(empty.ok, false);
    assert.equal(verifyMandate(input()).ok, true);
  });
});

describe("order of checks — first failure short-circuits", () => {
  test("an unsigned mandate is refused for its signature, not its ceiling", () => {
    // Reporting the ceiling breach of an unverified mandate tells a forger what
    // the ceiling is. Cheapest and most fundamental check first.
    assert.equal(
      refusalOf({
        signatureValid: false,
        cart: { total_minor: 9_999_999, currency: "INR", categories: ["apparel"], item_count: 99 },
      })?.reason_code,
      "MANDATE_SIGNATURE_INVALID",
    );
  });

  test("an expired mandate is refused before it can be treated as consumed", () => {
    assert.equal(
      refusalOf({ now: new Date("2026-08-24T11:00:00Z"), consumed: true })?.reason_code,
      "MANDATE_EXPIRED",
    );
  });
});

describe("every refusal is machine-readable AND human-readable", () => {
  test("both strings are present, and the agent code is a closed-enum value", () => {
    const closed = new Set([
      "missing", "invalid", "out_of_stock", "payment_declined", "requires_sign_in",
      "requires_3ds", "low_stock", "quantity_exceeded", "coupon_invalid", "coupon_expired",
      "minimum_not_met", "maximum_exceeded", "region_restricted", "age_verification_required",
      "approval_required", "unsupported", "not_found", "conflict", "rate_limited", "expired",
      "intervention_required",
    ]);

    const cases: Array<Partial<GateInput>> = [
      { mandate: null },
      { signatureValid: false },
      { now: new Date("2026-08-24T11:00:00Z") },
      { consumed: true },
      { cart: { total_minor: 300001, currency: "INR", categories: ["footwear"], item_count: 1 } },
      { cart: { total_minor: 250000, currency: "USD", categories: ["footwear"], item_count: 1 } },
    ];

    for (const over of cases) {
      const r = refusalOf(over);
      assert.ok(r);
      assert.ok(r.reason_code.length > 0);
      assert.ok(r.reason_human.length > 0, `${r.reason_code} has no human string`);
      assert.ok(
        closed.has(r.acp_code),
        `${r.reason_code} maps to ${r.acp_code}, which is not in MessageError.code`,
      );
    }
  });
});
