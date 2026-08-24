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
import { GATE_VERSION, PEER_ORDER } from "../lib/mandate/schema.ts";
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

describe("preconditions stop evaluation; peers do not", () => {
  test("a precondition records that NO peer ran, which is not the same as none failing", () => {
    // `peers: []` with `peers_evaluated: true` would mean every peer passed.
    // With `peers_evaluated: false` it means the question was never asked. A
    // reader of the trail must not have to guess which one silence meant.
    for (const over of [
      { mandate: null },
      { signatureValid: false },
      { cart: { total_minor: 1, currency: "USD", categories: ["footwear" as const], item_count: 1 } },
    ]) {
      const v = verifyMandate(input(over));
      assert.equal(v.ok, false);
      assert.equal(v.peers_evaluated, false, JSON.stringify(over));
      assert.deepEqual(v.peers, []);
    }
  });

  test("an unsigned mandate never has its ceiling evaluated at all", () => {
    // Not merely "not reported" — not COMPUTED. A ceiling comparison against
    // unauthenticated bytes is meaningless, and recording that it passed would
    // be a claim about evidence we do not have.
    const v = verifyMandate(
      input({
        signatureValid: false,
        cart: { total_minor: 9_999_999, currency: "INR", categories: ["apparel"], item_count: 99 },
      }),
    );
    assert.equal(v.ok, false);
    assert.equal(v.reason_code, "MANDATE_SIGNATURE_INVALID");
    assert.equal(v.peers.length, 0);
  });
});

describe("the peer order is pinned, not documented", () => {
  // A mandate failing SEVERAL peers at once. Reorder PEER_ORDER and this fails.
  const everythingWrong = () =>
    input({
      now: new Date("2026-08-24T11:30:00Z"), // window: expired
      consumed: true, // single_use: spent
      mandate: mandate({
        constraints: {
          max_amount: { value: 1000, currency: "INR" }, // ceiling: exceeded
          categories: ["food"], // category: not permitted
          max_items: 1, // item_count: exceeded
          single_use: true,
        },
      }),
      cart: { total_minor: 250000, currency: "INR", categories: ["footwear"], item_count: 5 },
    });

  test("all five peers fail, and the response names the first in PEER_ORDER", () => {
    const v = verifyMandate(everythingWrong());
    assert.equal(v.ok, false);
    assert.equal(v.peers.filter((p) => p.reason_code).length, 5, "all five must actually fail");
    assert.equal(v.reason_code, "MANDATE_EXPIRED", "validity_window is first in PEER_ORDER");
  });

  test("the recorded evaluation is in PEER_ORDER regardless of what failed", () => {
    assert.deepEqual(
      verifyMandate(everythingWrong()).peers.map((p) => p.check),
      [...PEER_ORDER],
    );
    assert.deepEqual(verifyMandate(input()).peers.map((p) => p.check), [...PEER_ORDER]);
  });

  test("removing the first failure surfaces the next, in order", () => {
    // Walks the order by fixing one peer at a time. This is what makes the
    // ordering an assertion rather than a comment.
    const base = everythingWrong();
    const expected = [
      "MANDATE_EXPIRED",
      "MANDATE_ALREADY_CONSUMED",
      "MANDATE_CEILING_EXCEEDED",
      "MANDATE_CATEGORY_NOT_PERMITTED",
      "MANDATE_ITEM_COUNT_EXCEEDED",
    ];
    const fixes: Array<(i: GateInput) => GateInput> = [
      (i) => ({ ...i, now: NOW }),
      (i) => ({ ...i, consumed: false }),
      (i) => ({
        ...i,
        mandate: mandate({ constraints: { ...i.mandate!.constraints, max_amount: { value: 10_000_000, currency: "INR" } } }),
      }),
      (i) => ({ ...i, mandate: mandate({ constraints: { ...i.mandate!.constraints, categories: ["footwear"] } }) }),
    ];

    let current = base;
    for (let step = 0; step < expected.length; step++) {
      const v = verifyMandate(current);
      assert.equal(v.ok, false);
      assert.equal(v.reason_code, expected[step], `step ${step}`);
      if (step < fixes.length) current = fixes[step]!(current);
    }
  });
});

describe("all thirty-two peer combinations", () => {
  // Five independent peers is 2^5 states. Enumerated rather than sampled,
  // because the property being asserted — that the response is a function of
  // the failure SET and not of evaluation order — is exactly the kind of thing
  // that holds for the cases someone thought to write and breaks for the rest.
  //
  // WHAT THIS SUITE CANNOT DO, said plainly: it derives the expected code from
  // PEER_ORDER, so reordering PEER_ORDER reorders the expectation too and every
  // case still passes. A test written from a rule cannot falsify that rule
  // (CLAUDE.md). The order is pinned by the hand-written sequence in the
  // describe above, which hardcodes the codes; verified by reordering
  // PEER_ORDER and watching exactly those tests fail.
  //
  // What this suite DOES assert is orthogonal to order and is the thing 32
  // cases are for: the response is deterministic given a failure set, and the
  // recorded set is exactly complete — no peer missing, none invented.
  const build = (fails: Record<string, boolean>): GateInput =>
    input({
      now: fails["validity_window"] ? new Date("2026-08-24T11:30:00Z") : NOW,
      consumed: Boolean(fails["single_use"]),
      mandate: mandate({
        constraints: {
          max_amount: { value: fails["ceiling"] ? 1000 : 10_000_000, currency: "INR" },
          ...(fails["category"] ? { categories: ["food" as const] } : {}),
          ...(fails["item_count"] ? { max_items: 1 } : {}),
          single_use: true,
        },
      }),
      cart: {
        total_minor: 250000,
        currency: "INR",
        categories: ["footwear"],
        item_count: fails["item_count"] ? 5 : 1,
      },
    });

  const CODE_OF: Record<string, string> = {
    validity_window: "MANDATE_EXPIRED",
    single_use: "MANDATE_ALREADY_CONSUMED",
    ceiling: "MANDATE_CEILING_EXCEEDED",
    category: "MANDATE_CATEGORY_NOT_PERMITTED",
    item_count: "MANDATE_ITEM_COUNT_EXCEEDED",
  };

  for (let mask = 0; mask < 32; mask++) {
    const failing = PEER_ORDER.filter((_, i) => (mask & (1 << i)) !== 0);
    const label = failing.length === 0 ? "none failing" : failing.join("+");

    test(`${label}`, () => {
      const fails = Object.fromEntries(failing.map((c) => [c, true]));
      const v = verifyMandate(build(fails));

      if (failing.length === 0) {
        assert.equal(v.ok, true);
      } else {
        assert.equal(v.ok, false);
        // Deterministic: the first failing check in PEER_ORDER, always.
        assert.equal(v.reason_code, CODE_OF[failing[0]!]);
      }

      // COMPLETE: every peer appears exactly once, and the failed set is
      // exactly the intended one — no more, no fewer, whatever the order.
      assert.deepEqual(v.peers.map((p) => p.check), [...PEER_ORDER]);
      assert.deepEqual(
        v.peers.filter((p) => p.reason_code).map((p) => p.check).sort(),
        [...failing].sort(),
      );
      assert.equal(v.peers_evaluated, true);
      assert.equal(v.gate_version, GATE_VERSION);
    });
  }
});

describe("the gate is deterministic", () => {
  test("the same input twice produces byte-identical output", () => {
    // The guard against anything non-deterministic quietly entering the gate —
    // a Date.now(), a Math.random, an iteration over a Set built from a Map.
    for (const over of [
      {},
      { consumed: true },
      { signatureValid: false },
      { now: new Date("2026-08-24T11:30:00Z") },
      { cart: { total_minor: 300001, currency: "INR", categories: ["footwear" as const, "apparel" as const], item_count: 3 } },
    ]) {
      const a = JSON.stringify(verifyMandate(input(over)));
      const b = JSON.stringify(verifyMandate(input(over)));
      assert.equal(a, b, JSON.stringify(over));
    }
  });
});
