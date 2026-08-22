/**
 * PHASE-1.md §1.1 and §6. Two things are proven here:
 *
 * 1. What we emit validates against the vendored ACP schema — not against our
 *    own TypeScript types, which could drift, but against the pinned
 *    spec/acp/2026-04-17/schema.feed.json itself.
 * 2. The mapping rules hold: needs_review is never served, null descriptions
 *    are omitted rather than nulled, and fields with no ACP slot go to prose
 *    rather than into a field that means something else.
 *
 * Written before the normalizer deliberately: building the projection first
 * means the normalizer is later written against a schema that already provably
 * validates, instead of discovering schema problems through model output.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import type { Product, Variant } from "../lib/normalize/schema.ts";
import { projectFeed, projectProduct } from "../lib/feed/project.ts";
import { assertValid, validate } from "../lib/feed/validate.ts";
import { parseProductsJsonl, toProductsJsonl } from "../lib/feed/acp.ts";

const provenance = {
  source_file: "messy-01-preamble.xlsx",
  source_sheet: "Price List",
  source_row: 7,
  source_cells: { "Item Name": "Canvas Shoe White", Price: "899" },
};

const clean = { confidence: 0.95, flags: [], needs_review: false };

function variant(over: Partial<Variant> = {}): Variant {
  return {
    id: "var_canvas_white_9",
    title: "Canvas Shoe White - 9",
    category: "footwear",
    category_raw: "Footwear",
    category_confidence: 0.98,
    price: { amount_minor: 89900, currency: "INR" },
    compare_at_price: null,
    availability: "in_stock",
    inventory_count: 12,
    options: { Size: "9" },
    attributes: {},
    image_url: null,
    provenance,
    normalization: clean,
    ...over,
  };
}

function product(over: Partial<Product> = {}): Product {
  return {
    id: "prod_canvas_white",
    merchant_id: "mer_lakshmi",
    title: "Canvas Shoe White",
    description: null,
    brand: null,
    variants: [variant()],
    image_url: null,
    provenance,
    normalization: clean,
    ...over,
  };
}

describe("ACP schema conformance", () => {
  test("a projected product validates against the pinned schema", () => {
    const { product: acp } = projectProduct(product());
    assert.ok(acp);
    assertValid("Product", acp);
  });

  test("a fully populated product validates", () => {
    const { product: acp } = projectProduct(
      product({
        description: "Classic canvas shoe with a rubber sole.",
        brand: "Lakshmi",
        image_url: "https://cdn.example.com/canvas-white.jpg",
        variants: [
          variant({
            compare_at_price: { amount_minor: 129900, currency: "INR" },
            options: { Size: "9", Colour: "White" },
            attributes: { material: "canvas", gender: "unisex" },
            image_url: "https://cdn.example.com/canvas-white-9.jpg",
          }),
          variant({
            id: "var_canvas_white_10",
            title: "Canvas Shoe White - 10",
            availability: "out_of_stock",
            options: { Size: "10", Colour: "White" },
          }),
        ],
      }),
    );
    assert.ok(acp);
    assertValid("Product", acp);
    assert.equal(acp.variants.length, 2);
  });

  test("the feed response envelope validates", () => {
    const feed = projectFeed([product()], { feedId: "feed_lakshmi", targetCountry: "IN" });
    assertValid("ProductsResponse", { products: feed.products });
    assertValid("FeedMetadata", feed.metadata);
  });

  test("the validator actually rejects — it is not vacuously passing", () => {
    // additionalProperties is false everywhere, so provenance must fail.
    const smuggled = { id: "p1", variants: [{ id: "v1", title: "t" }], provenance };
    assert.ok(validate("Product", smuggled).length > 0);

    // Variant.title is required.
    assert.ok(validate("Product", { id: "p1", variants: [{ id: "v1" }] }).length > 0);

    // Price.amount must be an integer.
    assert.ok(
      validate("Variant", {
        id: "v1",
        title: "t",
        price: { amount: 899.5, currency: "INR" },
      }).length > 0,
    );

    // Currency must match ^[A-Z]{3}$.
    assert.ok(
      validate("Variant", {
        id: "v1",
        title: "t",
        price: { amount: 89900, currency: "inr" },
      }).length > 0,
    );

    // An empty description object violates minProperties: 1.
    assert.ok(
      validate("Variant", { id: "v1", title: "t", description: {} }).length > 0,
    );
  });
});

describe("§1.1 mapping rules", () => {
  test("prices carry over as integer minor units under the ACP field name", () => {
    const { product: acp } = projectProduct(product());
    assert.ok(acp);
    const [v] = acp.variants;
    assert.ok(v);
    assert.deepEqual(v.price, { amount: 89900, currency: "INR" });
    assert.ok(Number.isInteger(v.price.amount));
  });

  test("compare_at_price becomes list_price, and is omitted when absent", () => {
    const withList = projectProduct(
      product({
        variants: [variant({ compare_at_price: { amount_minor: 129900, currency: "INR" } })],
      }),
    ).product;
    assert.ok(withList);
    assert.deepEqual(withList.variants[0]?.list_price, {
      amount: 129900,
      currency: "INR",
    });

    const without = projectProduct(product()).product;
    assert.ok(without);
    assert.ok(!("list_price" in (without.variants[0] ?? {})));
  });

  test("both the mapped category and the merchant's verbatim wording are published", () => {
    const { product: acp } = projectProduct(product());
    assert.ok(acp);
    assert.deepEqual(acp.variants[0]?.categories, [
      { value: "footwear", taxonomy: "agentready" },
      { value: "Footwear", taxonomy: "merchant" },
    ]);
  });

  test("a null description is omitted, never sent as null or {}", () => {
    const { product: acp } = projectProduct(product());
    assert.ok(acp);
    assert.ok(!("description" in acp), "description key should be absent entirely");
    assertValid("Product", acp);
  });

  test("brand has no ACP field, so it goes to prose rather than being dropped", () => {
    const { product: acp } = projectProduct(
      product({ description: "Classic canvas shoe.", brand: "Lakshmi" }),
    );
    assert.ok(acp);
    assert.equal(acp.description?.plain, "Classic canvas shoe.\nBrand: Lakshmi");
  });

  test("attributes NEVER reach variant_options, whatever they are named", () => {
    // `options` and `attributes` now share a {name,value} shape on the wire,
    // because that is the only map shape either provider can constrain. A
    // shared SHAPE must not quietly become a shared DESTINATION: an agent may
    // render variant_options as a picker, so "Gender: Womens" landing there
    // offers the buyer a choice that does not exist.
    const attributes = {
      material: "canvas",
      gender: "unisex",
      fit: "regular",
      occasion: "casual",
      // Deliberately named like real option dimensions. Nothing about the key
      // should be able to promote an attribute into an option.
      Colour: "not-an-option",
      Size: "not-an-option",
    };

    const { product: acp } = projectProduct(
      product({ variants: [variant({ options: { Size: "9" }, attributes })] }),
    );
    assert.ok(acp);
    const [v] = acp.variants;
    assert.ok(v);

    // Exactly the one real option, and nothing else.
    assert.deepEqual(v.variant_options, [{ name: "Size", value: "9" }]);
    assert.equal(v.variant_options?.length, 1);

    // No attribute VALUE appears anywhere in variant_options, even when its key
    // collides with a genuine dimension name.
    const optionsJson = JSON.stringify(v.variant_options);
    assert.ok(!optionsJson.includes("not-an-option"));
    for (const value of ["canvas", "unisex", "regular", "casual"]) {
      assert.ok(!optionsJson.includes(value), `${value} leaked into variant_options`);
    }

    // They are not dropped either — they belong in prose.
    const prose = v.description?.plain ?? "";
    for (const value of ["canvas", "unisex", "regular", "casual"]) {
      assert.ok(prose.includes(value), `${value} lost entirely`);
    }
  });

  test("a variant with only attributes emits no variant_options at all", () => {
    const { product: acp } = projectProduct(
      product({
        variants: [variant({ options: {}, attributes: { material: "silk", gender: "womens" } })],
      }),
    );
    assert.ok(acp);
    const [v] = acp.variants;
    assert.ok(v);
    // Absent, not an empty array — an empty picker is still a picker.
    assert.ok(!("variant_options" in v));
    assert.equal(v.description?.plain, "Material: silk\nGender: womens");
  });

  test("non-distinguishing attributes go to prose, NOT to variant_options", () => {
    const { product: acp } = projectProduct(
      product({
        variants: [
          variant({
            options: { Size: "9" },
            attributes: { material: "canvas", gender: "unisex" },
          }),
        ],
      }),
    );
    assert.ok(acp);
    const [v] = acp.variants;
    assert.ok(v);

    // Only the dimension that actually distinguishes the variant is an option.
    assert.deepEqual(v.variant_options, [{ name: "Size", value: "9" }]);
    // Material and gender would render as a picker if emitted as options.
    assert.equal(v.description?.plain, "Material: canvas\nGender: unisex");
  });

  test("internal-only fields never appear in the payload", () => {
    const feed = projectFeed([product()], { feedId: "feed_lakshmi" });
    const serialized = JSON.stringify(feed.products);
    for (const leaked of [
      "provenance",
      "source_row",
      "merchant_id",
      "inventory_count",
      "normalization",
      "confidence",
      "needs_review",
      "category_confidence",
    ]) {
      assert.ok(!serialized.includes(leaked), `${leaked} leaked into the feed`);
    }
  });

  test("a relative or missing image url is omitted rather than published broken", () => {
    for (const url of [null, "canvas.jpg", "/images/canvas.jpg", "ftp://x/y.jpg"]) {
      const { product: acp } = projectProduct(product({ image_url: url }));
      assert.ok(acp);
      assert.ok(!("media" in acp), `${url} should not produce media`);
    }

    const ok = projectProduct(
      product({ image_url: "https://cdn.example.com/canvas.jpg" }),
    ).product;
    assert.ok(ok);
    assert.equal(ok.media?.[0]?.url, "https://cdn.example.com/canvas.jpg");
  });

  test("no product url is invented for a merchant with no storefront", () => {
    const { product: acp } = projectProduct(product());
    assert.ok(acp);
    assert.ok(!("url" in acp));
  });
});

describe("nothing flagged reaches the feed", () => {
  test("an unsafe variant is withheld, with its reason", () => {
    const result = projectProduct(
      product({
        variants: [
          variant(),
          variant({
            id: "var_bad_price",
            normalization: {
              confidence: 0.3,
              flags: ["PRICE_AMBIGUOUS"],
              needs_review: true,
            },
          }),
        ],
      }),
    );
    assert.ok(result.product);
    assert.equal(result.product.variants.length, 1);
    assert.deepEqual(result.withheld, [
      { id: "var_bad_price", kind: "variant", reason: "PRICE_AMBIGUOUS" },
    ]);
  });

  test("a review-only variant is queued for the merchant but still served", () => {
    const result = projectProduct(
      product({
        variants: [
          variant({
            id: "var_unmapped",
            category: "unmapped",
            category_raw: "Misc",
            normalization: {
              confidence: 0.3,
              flags: ["CATEGORY_UNMAPPED", "CURRENCY_ASSUMED"],
              needs_review: true,
            },
          }),
        ],
      }),
    );
    assert.ok(result.product);
    // needs_review is true, and it still ships — the mandate gate refuses it at
    // payment time against any category-constrained mandate.
    assert.equal(result.product.variants.length, 1);
    assert.deepEqual(result.withheld, []);
    assert.deepEqual(result.product.variants[0]?.categories, [
      { value: "unmapped", taxonomy: "agentready" },
      { value: "Misc", taxonomy: "merchant" },
    ]);
  });

  test("a product whose every variant is flagged is withheld whole", () => {
    const result = projectProduct(
      product({
        variants: [
          variant({
            normalization: {
              confidence: 0.2,
              flags: ["PRICE_OUT_OF_BAND"],
              needs_review: true,
            },
          }),
        ],
      }),
    );
    // ACP requires `variants`, so an empty product cannot ship — and a listing
    // an agent cannot buy from is worse than no listing.
    assert.equal(result.product, null);
    assert.ok(result.withheld.some((w) => w.reason === "all_variants_withheld"));
  });

  test("a flagged product is withheld even when its variants are clean", () => {
    const result = projectProduct(
      product({
        normalization: {
          confidence: 0.4,
          flags: ["TITLE_INFERRED"],
          needs_review: true,
        },
      }),
    );
    assert.equal(result.product, null);
    assert.deepEqual(result.withheld, [
      { id: "prod_canvas_white", kind: "product", reason: "TITLE_INFERRED" },
    ]);
  });

  test("unknown stock is published as ABSENCE, never guessed into in_stock", () => {
    // Most small-merchant sheets are price lists with no stock column at all.
    // The first real end-to-end run withheld 26 of 26 records on a sheet whose
    // columns were Category / Item / Price. Both ACP availability fields are
    // optional, and §3.3 makes checkout authoritative, so omitting the key is
    // both legal and the only honest encoding of "we were not told".
    const { product: acp, withheld } = projectProduct(
      product({ variants: [variant({ availability: "unknown" })] }),
    );
    assert.ok(acp, "an untracked-stock product must still reach agents");
    assert.deepEqual(withheld, []);

    const [v] = acp.variants;
    assert.ok(v);
    assert.ok(!("availability" in v), "the key is absent, not a guessed value");
    assertValid("Product", acp);
  });

  test("known stock is still published both ways", () => {
    const inStock = projectProduct(product()).product;
    assert.deepEqual(inStock?.variants[0]?.availability, {
      available: true,
      status: "in_stock",
    });

    const out = projectProduct(
      product({ variants: [variant({ availability: "out_of_stock" })] }),
    ).product;
    assert.deepEqual(out?.variants[0]?.availability, {
      available: false,
      status: "out_of_stock",
    });
  });

  test("a price-list sheet with no stock column still yields a servable feed", () => {
    // The regression this whole change exists for.
    const feed = projectFeed(
      [
        product({ variants: [variant({ availability: "unknown" })] }),
        product({ id: "prod_two", variants: [variant({ id: "v2", availability: "unknown" })] }),
      ],
      { feedId: "feed_pricelist", targetCountry: "IN" },
    );
    assert.equal(feed.products.length, 2);
    assert.equal(feed.withheld.length, 0);
    assertValid("ProductsResponse", { products: feed.products });
  });
});

describe("offline full-replacement artifacts", () => {
  test("products.jsonl is one product per line and round-trips", () => {
    const feed = projectFeed([product(), product({ id: "prod_two" })], {
      feedId: "feed_lakshmi",
      targetCountry: "IN",
    });

    const jsonl = toProductsJsonl(feed.products);
    assert.equal(jsonl.split("\n").length, 2);
    for (const line of jsonl.split("\n")) {
      assert.ok(!line.includes("\n"));
      assertValid("Product", JSON.parse(line));
    }

    assert.deepEqual(parseProductsJsonl(jsonl), feed.products);
  });

  test("metadata carries the target country as ISO 3166-1 alpha-2", () => {
    const feed = projectFeed([], { feedId: "feed_lakshmi", targetCountry: "IN" });
    assert.equal(feed.metadata.target_country, "IN");
    assertValid("FeedMetadata", feed.metadata);
    // Lowercase would violate ^[A-Z]{2}$ — confirm the schema is enforcing it.
    assert.ok(validate("FeedMetadata", { id: "f", target_country: "in" }).length > 0);
  });

  test("updated_at is RFC 3339", () => {
    const feed = projectFeed([], {
      feedId: "feed_lakshmi",
      updatedAt: new Date("2026-08-22T10:04:12Z"),
    });
    assert.equal(feed.metadata.updated_at, "2026-08-22T10:04:12.000Z");
    assertValid("FeedMetadata", feed.metadata);
  });
});
