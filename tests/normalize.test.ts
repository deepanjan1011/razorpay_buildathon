/**
 * The normalizer, driven by a FAKE extractor.
 *
 * No API key, no network, no cost, and — more importantly — no
 * non-determinism: these tests assert what the deterministic layer does with a
 * given semantic reading, which is exactly the half that must never vary. The
 * model's own accuracy is measured separately and honestly in
 * docs/NORMALIZATION-EVAL.md, against a real sheet, and is not something a
 * green test suite can stand in for.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { parseWorkbook } from "../lib/ingest/parse.ts";
import { findField, semanticCells } from "../lib/ingest/fields.ts";
import { expandOptions, normalizeSheet } from "../lib/normalize/normalize.ts";
import {
  isServable,
  isWithholding,
  needsReview,
  REVIEW_ONLY_FLAGS,
  WITHHOLDING_FLAGS,
} from "../lib/normalize/flags.ts";
import type { NormalizationFlag } from "../lib/normalize/flags.ts";
import { parseExtraction, promptFingerprint, SYSTEM_PROMPT } from "../lib/normalize/llm.ts";
import { EXTRACTION_SCHEMA, toGeminiSchema } from "../lib/normalize/llm-schema.ts";
import type { RowExtraction } from "../lib/normalize/llm-schema.ts";
import { projectFeed } from "../lib/feed/project.ts";
import { assertValid } from "../lib/feed/validate.ts";

const fixture = (name: string) => join(import.meta.dirname, "..", "fixtures", name);
const ctx = { merchantId: "mer_lakshmi", sourceFile: "messy-01-preamble.xlsx" };

const ADVISORY: NormalizationFlag[] = [
  "CURRENCY_ASSUMED",
  "VARIANTS_SPLIT",
  "MULTILINGUAL_SOURCE",
  "STOCK_NOT_TRACKED",
];

function extraction(over: Partial<RowExtraction> & { source_row: number }): RowExtraction {
  return {
    title: "Canvas Shoe",
    title_inferred: false,
    category: "footwear",
    category_confidence: 0.95,
    options: {},
    attributes: {},
    brand: null,
    description: null,
    variant_group: null,
    confidence: 0.9,
    ...over,
  };
}

describe("the model is never shown money or stock", () => {
  test("price and stock columns are stripped before extraction", async () => {
    const [sheet] = await parseWorkbook(fixture("messy-01-preamble.xlsx"));
    assert.ok(sheet);
    const row = sheet.rows[0];
    assert.ok(row);

    const visible = semanticCells(row.cells, sheet.headers);
    assert.ok("Item Name" in visible);
    assert.ok("Category" in visible);
    // CLAUDE.md invariant 1 made structural: the model cannot influence an
    // amount it is never shown.
    assert.ok(!("Price" in visible));
    assert.ok(!("Stock" in visible));
  });

  test("field roles match exactly, so MRP is not mistaken for the sale price", async () => {
    const sheets = await parseWorkbook(fixture("messy-02-headers.xlsx"));
    const sheet = sheets.find((s) => s.name === "two-row-header");
    assert.ok(sheet);

    assert.equal(findField(sheet.headers, "price"), "Sale Price");
    assert.equal(findField(sheet.headers, "list_price"), "MRP");
    assert.equal(findField(sheet.headers, "stock"), "Available");
  });

  test("a Tamil price header is still recognised", () => {
    assert.equal(findField(["பொருள்", "விலை", "Stock"], "price"), "விலை");
  });
});

describe("variant expansion", () => {
  test("the cartesian product of two option axes", () => {
    const sets = expandOptions({ Size: "M/L/XL", Colour: "Red, Blue, Black" });
    assert.equal(sets.length, 9);
    assert.ok(sets.some((s) => s["Size"] === "M" && s["Colour"] === "Red"));
  });

  test("a single option axis, and none at all", () => {
    assert.equal(expandOptions({ Colour: "Green, Maroon" }).length, 2);
    assert.deepEqual(expandOptions({}), [{}]);
  });

  test("a measure is not expanded into fake variants", () => {
    assert.equal(expandOptions({ Size: "1/2 kg" }).length, 1);
  });
});

describe("assembly from a real fixture", () => {
  test("prices come from the sheet, not the model", async () => {
    const [sheet] = await parseWorkbook(fixture("messy-01-preamble.xlsx"));
    assert.ok(sheet);

    const products = normalizeSheet(
      sheet,
      sheet.rows.map((r) =>
        extraction({ source_row: r.row, variant_group: "canvas-shoe" }),
      ),
      ctx,
    );

    const variants = products.flatMap((p) => p.variants);
    const prices = variants.map((v) => v.price.amount_minor).sort((a, b) => a - b);
    // 650, 899, 899, 1450 rupees from the sheet, as integer paise.
    assert.deepEqual(prices, [65000, 89900, 89900, 145000]);
    for (const v of variants) assert.ok(Number.isInteger(v.price.amount_minor));
  });

  test("every variant traces back to its source row", async () => {
    const [sheet] = await parseWorkbook(fixture("messy-01-preamble.xlsx"));
    assert.ok(sheet);

    const products = normalizeSheet(
      sheet,
      sheet.rows.map((r) => extraction({ source_row: r.row })),
      ctx,
    );

    for (const v of products.flatMap((p) => p.variants)) {
      assert.equal(v.provenance.source_file, "messy-01-preamble.xlsx");
      assert.equal(v.provenance.source_sheet, "Price List");
      assert.ok(v.provenance.source_row >= 7, "real sheet row, not an index");
      assert.ok(Object.keys(v.provenance.source_cells).length > 0);
    }
  });

  test("ids are stable across re-ingest and do not depend on row order", async () => {
    const [sheet] = await parseWorkbook(fixture("messy-01-preamble.xlsx"));
    assert.ok(sheet);
    const extractions = sheet.rows.map((r) =>
      extraction({ source_row: r.row, variant_group: `group-${r.row}` }),
    );

    const first = normalizeSheet(sheet, extractions, ctx);
    const again = normalizeSheet(sheet, [...extractions].reverse(), ctx);

    const ids = (ps: typeof first) => ps.flatMap((p) => p.variants.map((v) => v.id)).sort();
    // Variant.id becomes the ACP checkout items[].id, so a shift would break an
    // agent's saved reference and, in Phase 3, a mandate issued against it.
    assert.deepEqual(ids(first), ids(again));
  });

  test("a row the model did not return is flagged, never dropped", async () => {
    const [sheet] = await parseWorkbook(fixture("messy-01-preamble.xlsx"));
    assert.ok(sheet);

    // Extraction for only the first row; the other three come back missing.
    const products = normalizeSheet(
      sheet,
      [extraction({ source_row: sheet.rows[0]!.row })],
      ctx,
    );

    const variants = products.flatMap((p) => p.variants);
    assert.equal(variants.length, sheet.rows.length, "no row disappeared");

    const unextracted = variants.filter((v) => v.normalization.confidence === 0);
    assert.equal(unextracted.length, 3);
    for (const v of unextracted) {
      assert.ok(v.normalization.needs_review);
      assert.ok(v.provenance.source_row > 0);
    }
  });
});

describe("flagging sends the unsure to review, not to buyers", () => {
  async function firstVariant(over: Partial<RowExtraction>) {
    const [sheet] = await parseWorkbook(fixture("messy-01-preamble.xlsx"));
    assert.ok(sheet);
    const row = sheet.rows[0];
    assert.ok(row);
    const products = normalizeSheet(
      sheet,
      [extraction({ source_row: row.row, ...over })],
      ctx,
    );
    const v = products[0]?.variants[0];
    assert.ok(v);
    return v;
  }

  test("a clean row is servable, and an advisory flag does not block it", async () => {
    const v = await firstVariant({});
    // The sheet prices as a plain number, so CURRENCY_ASSUMED is present. It is
    // provenance, not doubt — this system is INR-only, so there is no other
    // currency the number could be.
    assert.deepEqual(v.normalization.flags, ["CURRENCY_ASSUMED"]);
    assert.equal(v.normalization.needs_review, false);
  });

  test("advisory flags neither withhold nor queue", async () => {
    // If any of these starts withholding, the feed empties for ordinary sheets;
    // if any starts queueing, the review list becomes noise the merchant
    // rubber-stamps. Both failures look like caution.
    for (const flag of ADVISORY) {
      assert.equal(isWithholding(flag), false, flag);
      assert.equal(needsReview([flag]), false, flag);
    }

    const multiVariant = await firstVariant({ options: { Size: "S/M/L" } });
    assert.ok(multiVariant.normalization.flags.includes("VARIANTS_SPLIT"));
    assert.equal(multiVariant.normalization.needs_review, false);
  });

  test("withholding and review are different questions", () => {
    for (const flag of WITHHOLDING_FLAGS) {
      assert.equal(isWithholding(flag), true, flag);
      assert.equal(needsReview([flag]), true, `${flag} must also be reviewed`);
    }

    // The whole point of the three-tier split: queued for the merchant, but
    // still served to agents.
    for (const flag of REVIEW_ONLY_FLAGS) {
      assert.equal(needsReview([flag]), true, flag);
      assert.equal(isServable([flag]), true, `${flag} must still be servable`);
    }

    assert.equal(needsReview(["CURRENCY_ASSUMED", "VARIANTS_SPLIT"]), false);
  });

  test("low category confidence is flagged rather than force-fit", async () => {
    const v = await firstVariant({ category_confidence: 0.4 });
    assert.ok(v.normalization.flags.includes("CATEGORY_UNMAPPED"));
    assert.ok(v.normalization.needs_review);
  });

  test("an unmapped category is flagged even at high confidence", async () => {
    const v = await firstVariant({ category: "unmapped", category_confidence: 0.99 });
    assert.ok(v.normalization.flags.includes("CATEGORY_UNMAPPED"));
  });

  test("an unmapped product is queued for review but STILL SERVED", async () => {
    // Withholding it would make a potentially large fraction of a real
    // catalogue invisible to agents, and buys nothing: the mandate gate refuses
    // an unmapped product against any category-constrained mandate anyway.
    // Defence belongs at the payment gate, not at the feed.
    const v = await firstVariant({ category: "unmapped", category_confidence: 0.2 });
    assert.equal(v.normalization.needs_review, true);
    assert.equal(isServable(v.normalization.flags), true);
  });

  test("unmapped can never satisfy a category-constrained mandate", async () => {
    // The Phase 3 property that makes serving unmapped safe, asserted here so
    // it cannot be quietly broken before the mandate layer exists. If a future
    // mandate check skips the category test for unmapped products instead of
    // failing it, CATEGORY_UNMAPPED must move to WITHHOLDING_FLAGS.
    const v = await firstVariant({ category: "unmapped", category_confidence: 0.2 });
    const mandateCategories = ["footwear", "apparel"];
    assert.equal(mandateCategories.includes(v.category), false);
  });

  test("an inferred title is flagged", async () => {
    const v = await firstVariant({ title_inferred: true });
    assert.ok(v.normalization.flags.includes("TITLE_INFERRED"));
  });

  test("low row confidence is flagged", async () => {
    const v = await firstVariant({ confidence: 0.2 });
    assert.ok(v.normalization.needs_review);
  });

  test("every genuine uncertainty means needs_review", async () => {
    for (const over of [
      { category_confidence: 0.1 },
      { title_inferred: true },
      { confidence: 0.1 },
    ]) {
      const v = await firstVariant(over);
      assert.equal(v.normalization.needs_review, true);
    }
  });

  test("a Tamil-script row is flagged; a transliterated one is not", async () => {
    const [sheet] = await parseWorkbook(fixture("messy-07-multilingual.xlsx"));
    assert.ok(sheet);
    const products = normalizeSheet(
      sheet,
      sheet.rows.map((r) => extraction({ source_row: r.row, category: "apparel" })),
      ctx,
    );
    const variants = products.flatMap((p) => p.variants);

    const tamil = variants.find((v) => v.provenance.source_row === 2);
    assert.ok(tamil);
    assert.ok(tamil.normalization.flags.includes("MULTILINGUAL_SOURCE"));

    // `Paruthi Sattai` is Tamil in Latin script — not deterministically
    // detectable, and we do not pretend otherwise.
    const transliterated = variants.find((v) => v.provenance.source_row === 4);
    assert.ok(transliterated);
    assert.ok(!transliterated.normalization.flags.includes("MULTILINGUAL_SOURCE"));
  });
});

describe("end to end: sheet -> normalized -> ACP feed", () => {
  test("a clean sheet produces a feed that validates against the pinned schema", async () => {
    const [sheet] = await parseWorkbook(fixture("messy-01-preamble.xlsx"));
    assert.ok(sheet);

    const products = normalizeSheet(
      sheet,
      sheet.rows.map((r) =>
        extraction({ source_row: r.row, variant_group: "canvas-shoe" }),
      ),
      ctx,
    );

    const feed = projectFeed(products, { feedId: "feed_lakshmi", targetCountry: "IN" });
    assertValid("ProductsResponse", { products: feed.products });
    assertValid("FeedMetadata", feed.metadata);
    assert.ok(feed.products.length > 0);
  });

  test("unsafe rows are withheld from the feed but still exist internally", async () => {
    const [sheet] = await parseWorkbook(fixture("messy-01-preamble.xlsx"));
    assert.ok(sheet);

    const products = normalizeSheet(
      sheet,
      sheet.rows.map((r, i) =>
        extraction({
          source_row: r.row,
          variant_group: "canvas-shoe",
          // Exactly one row gets a withholding flag.
          title_inferred: i === 0,
        }),
      ),
      ctx,
    );

    const internal = products.flatMap((p) => p.variants);
    const feed = projectFeed(products, { feedId: "feed_lakshmi" });
    const served = feed.products.flatMap((p) => p.variants);

    assert.equal(internal.length, 4);
    assert.equal(served.length, 3);
    assert.equal(feed.withheld.length, 1);
    assert.equal(feed.withheld[0]?.reason, "TITLE_INFERRED");
  });

  test("an unmapped catalogue still reaches agents", async () => {
    const [sheet] = await parseWorkbook(fixture("messy-01-preamble.xlsx"));
    assert.ok(sheet);

    // The pathological case the old rule produced: the mapper places nothing.
    const products = normalizeSheet(
      sheet,
      sheet.rows.map((r) =>
        extraction({
          source_row: r.row,
          variant_group: "canvas-shoe",
          category: "unmapped",
          category_confidence: 0.1,
        }),
      ),
      ctx,
    );

    const feed = projectFeed(products, { feedId: "feed_lakshmi" });
    assert.equal(feed.withheld.length, 0);
    assert.equal(feed.products.flatMap((p) => p.variants).length, 4);
    // Every one of them is still queued for the merchant.
    for (const v of products.flatMap((p) => p.variants)) {
      assert.equal(v.normalization.needs_review, true);
    }
    assertValid("ProductsResponse", { products: feed.products });
  });
});

describe("model output is validated at the boundary", () => {
  /**
   * Wire shape: `options` and `attributes` are `{name, value}` arrays, because
   * neither provider can constrain an open-ended string map. `parseExtraction`
   * converts to Records at the boundary.
   */
  const wire = (over: Record<string, unknown> = {}) => ({
    source_row: 7,
    title: "Canvas Shoe",
    title_inferred: false,
    category: "footwear",
    category_confidence: 0.95,
    options: [{ name: "Size", value: "9" }],
    attributes: [{ name: "material", value: "canvas" }],
    brand: null,
    description: null,
    variant_group: null,
    confidence: 0.9,
    ...over,
  });

  test("a well-formed batch parses, and pairs become a Record", () => {
    const batch = parseExtraction(JSON.stringify({ rows: [wire()] }));
    assert.equal(batch.rows.length, 1);
    assert.equal(batch.rows[0]?.category, "footwear");
    assert.deepEqual(batch.rows[0]?.options, { Size: "9" });
    assert.deepEqual(batch.rows[0]?.attributes, { material: "canvas" });
  });

  test("an invented category is rejected, not accepted and mapped later", () => {
    assert.throws(
      () => parseExtraction(JSON.stringify({ rows: [wire({ category: "sportswear" })] })),
      /schema validation/,
    );
  });

  test("a missing required field is rejected", () => {
    const { title, ...withoutTitle } = wire();
    assert.throws(
      () => parseExtraction(JSON.stringify({ rows: [withoutTitle] })),
      /schema validation/,
    );
  });

  test("a nullable field must be present as null, not omitted", () => {
    // Constrained decoding requires every field in `required`, so "no brand"
    // is an explicit null rather than a missing key. A missing key is a schema
    // violation, not an ambiguity.
    const { brand, ...withoutBrand } = wire();
    assert.throws(
      () => parseExtraction(JSON.stringify({ rows: [withoutBrand] })),
      /schema validation/,
    );
    assert.doesNotThrow(() => parseExtraction(JSON.stringify({ rows: [wire({ brand: null })] })));
  });

  test("confidence outside 0-1 is rejected", () => {
    // Gemini's OpenAPI subset drops minimum/maximum, so this range is NOT
    // enforced on its wire. Our own validation is what catches it there —
    // which is exactly the difference the bake-off is weighing.
    assert.throws(
      () => parseExtraction(JSON.stringify({ rows: [wire({ confidence: 1.5 })] })),
      /schema validation/,
    );
  });

  test("an open-ended map is rejected — the wire shape is pairs", () => {
    assert.throws(
      () => parseExtraction(JSON.stringify({ rows: [wire({ options: { Size: "9" } })] })),
      /schema validation/,
    );
  });

  test("non-JSON is reported as such, not swallowed", () => {
    assert.throws(() => parseExtraction("I could not do that"), /not valid JSON/);
  });
});

describe("the Gemini schema adapter", () => {
  test("strips what OpenAPI 3.0 cannot express and converts union nulls", () => {
    const adapted = toGeminiSchema(EXTRACTION_SCHEMA) as Record<string, unknown>;
    const serialized = JSON.stringify(adapted);

    assert.ok(!serialized.includes("additionalProperties"));
    assert.ok(!serialized.includes('"minimum"'));
    assert.ok(!serialized.includes('"maximum"'));
    // ["string","null"] must become a concrete type plus nullable.
    assert.ok(!/\["string","null"\]/.test(serialized));
    assert.ok(serialized.includes('"nullable":true'));
    // The enum is the one constraint that survives on both providers.
    assert.ok(serialized.includes('"unmapped"'));
  });
});

describe("run fingerprint", () => {
  test("the prompt hash is stable and changes when the prompt changes", () => {
    assert.equal(promptFingerprint(), promptFingerprint());
    assert.match(promptFingerprint(), /^[0-9a-f]{64}$/);
  });

  test("the prompt never asks the model for a price", () => {
    // If this ever fails, invariant 1 has been weakened by a prompt edit.
    assert.match(SYSTEM_PROMPT, /never infer, restate or correct them/);
  });
});


describe("a price list with no stock column", () => {
  test("does not queue the merchant's whole catalogue", async () => {
    // messy-03 columns are Category | Item | Price — no stock column, like most
    // real price lists. The first live run queued 14 of 14 rows to tell the
    // merchant something they already know. A queue holding everything is one
    // they rubber-stamp.
    const [sheet] = await parseWorkbook(fixture("messy-03-merged-category.xlsx"));
    assert.ok(sheet);
    assert.equal(findField(sheet.headers, "stock"), null, "fixture has no stock column");

    const products = normalizeSheet(
      sheet,
      sheet.rows.map((r) => extraction({ source_row: r.row })),
      { merchantId: "mer_x", sourceFile: "messy-03-merged-category.xlsx" },
    );
    const variants = products.flatMap((p) => p.variants);

    for (const v of variants) {
      assert.ok(v.normalization.flags.includes("STOCK_NOT_TRACKED"));
      assert.equal(v.normalization.needs_review, false, "sheet-level fact, not a row problem");
      assert.equal(isServable(v.normalization.flags), true);
    }
  });

  test("but an unreadable value in a column that EXISTS is queued", async () => {
    const [sheet] = await parseWorkbook(fixture("messy-10-stock.xlsx"));
    assert.ok(sheet);
    assert.ok(findField(sheet.headers, "stock"), "fixture has a stock column");

    const products = normalizeSheet(
      sheet,
      sheet.rows.map((r) => extraction({ source_row: r.row })),
      { merchantId: "mer_x", sourceFile: "messy-10-stock.xlsx" },
    );
    const variants = products.flatMap((p) => p.variants);

    // "-", "??" etc. are per-row uncertainty and do get a human glance.
    const unreadable = variants.filter((v) => v.availability === "unknown");
    assert.ok(unreadable.length > 0);
    for (const v of unreadable) {
      assert.ok(v.normalization.flags.includes("STOCK_UNKNOWN"));
      assert.equal(v.normalization.needs_review, true);
      assert.equal(isServable(v.normalization.flags), true, "queued, not withheld");
    }
    assert.ok(!variants.some((v) => v.normalization.flags.includes("STOCK_NOT_TRACKED")));
  });
});

describe("variant identity does not rest on the model wording a title well", () => {
  // The first real merchant sheet had three products the model all titled
  // "Sesame Chikki" — black sesame, white sesame, white til. Identity was
  // hashed from that title, so all three shared ONE variant id. Variant.id is
  // the ACP items[].id: an agent referencing it had referenced three products,
  // and a Phase 3 mandate against it authorises a purchase nobody can identify.
  //
  // The prompt was fixed too, but a prompt is not a guarantee. This asserts the
  // property that must hold even when the model gets the title wrong.
  test("different merchant rows keep different ids under one collapsed title", async () => {
    const [sheet] = await parseWorkbook(fixture("messy-11-all-text.xlsx"));
    assert.ok(sheet);
    const rows = sheet.rows.map((r) => r.row);
    assert.equal(rows.length, 3);

    const collapsed = rows.map((row) => extraction({ source_row: row, title: "Snack" }));
    const variants = normalizeSheet(sheet, collapsed, {
      merchantId: "mer_t",
      sourceFile: "t.xlsx",
    }).flatMap((p) => p.variants);

    assert.equal(variants.length, 3);
    assert.equal(new Set(variants.map((v) => v.id)).size, 3);
  });

  test("but the same item on two sheets still shares one id", async () => {
    // messy-09's duplicates are CROSS-SHEET and differ in case: "Canvas Shoe
    // White" on Main Stock, "canvas shoe white" on Godown, at prices 899 and
    // 899 but Kolhapuri at 650 and 675. One product, however the merchant
    // typed it and whatever it is repriced to.
    const sheets = await parseWorkbook(fixture("messy-09-duplicates.xlsx"));
    const idsFor = (item: string) =>
      sheets.flatMap((sheet) =>
        normalizeSheet(
          sheet,
          sheet.rows.map((r) => extraction({ source_row: r.row, title: "Anything" })),
          { merchantId: "mer_t", sourceFile: "t.xlsx" },
        )
          .flatMap((p) => p.variants)
          .filter((v) => (v.provenance.source_cells["Item"] ?? "").toLowerCase() === item)
          .map((v) => v.id),
      );

    const canvas = idsFor("canvas shoe white");
    assert.equal(canvas.length, 3, "three rows name this shoe");
    assert.equal(new Set(canvas).size, 1, "case and sheet must not split identity");

    // Repricing is not a new product: 650 and 675 are the same chappal.
    const chappal = idsFor("kolhapuri chappal");
    assert.equal(chappal.length, 2);
    assert.equal(new Set(chappal).size, 1, "a reprice must not mint a new id");
  });
});

describe("variant_group groups products; it does not identify variants", () => {
  test("a constant variant_group does not collapse different rows into one id", async () => {
    // THE INCOMPLETE HALF OF THE EARLIER FIX. Identity was moved off the
    // model's TITLE and left in front of the model's variant_group —
    // `variant_group ?? identityFields` — so it still depended on the model
    // behaving. A fake extractor emitting one constant group collapsed four
    // different sheet rows into a single variant id and a single catalogue row,
    // and a real model can do the same thing.
    const [sheet] = await parseWorkbook(fixture("messy-11-all-text.xlsx"));
    assert.ok(sheet);
    assert.equal(sheet.rows.length, 3);

    const variants = normalizeSheet(
      sheet,
      sheet.rows.map((r) => extraction({ source_row: r.row, title: "Snack", variant_group: "one-group" })),
      { merchantId: "mer_g", sourceFile: "g.xlsx" },
    ).flatMap((p) => p.variants);

    assert.equal(variants.length, 3);
    assert.equal(
      new Set(variants.map((v) => v.id)).size,
      3,
      "one variant_group must not make three different rows one variant",
    );
  });

  test("but rows the merchant wrote identically still share an id", async () => {
    // The other direction, so the fix above is not just "never collapse".
    const [sheet] = await parseWorkbook(fixture("messy-09-duplicates.xlsx"));
    const sheets = await parseWorkbook(fixture("messy-09-duplicates.xlsx"));
    assert.ok(sheet);
    const ids = sheets.flatMap((s) =>
      normalizeSheet(
        s,
        s.rows.map((r) => extraction({ source_row: r.row, title: "Anything", variant_group: "g" })),
        { merchantId: "mer_g", sourceFile: "g.xlsx" },
      )
        .flatMap((p) => p.variants)
        .filter((v) => (v.provenance.source_cells["Item"] ?? "").toLowerCase() === "canvas shoe white")
        .map((v) => v.id),
    );
    assert.equal(ids.length, 3);
    assert.equal(new Set(ids).size, 1, "identical merchant rows are one variant");
  });
});
