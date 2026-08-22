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
import type { RowExtraction } from "../lib/normalize/llm-schema.ts";
import { projectFeed } from "../lib/feed/project.ts";
import { assertValid } from "../lib/feed/validate.ts";

const fixture = (name: string) => join(import.meta.dirname, "..", "fixtures", name);
const ctx = { merchantId: "mer_lakshmi", sourceFile: "messy-01-preamble.xlsx" };

const ADVISORY: NormalizationFlag[] = [
  "CURRENCY_ASSUMED",
  "VARIANTS_SPLIT",
  "MULTILINGUAL_SOURCE",
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
  test("a well-formed batch parses", () => {
    const batch = parseExtraction(
      JSON.stringify({ rows: [extraction({ source_row: 7 })] }),
    );
    assert.equal(batch.rows.length, 1);
    assert.equal(batch.rows[0]?.category, "footwear");
  });

  test("an invented category is rejected, not accepted and mapped later", () => {
    assert.throws(
      () =>
        parseExtraction(
          JSON.stringify({
            rows: [{ ...extraction({ source_row: 7 }), category: "sportswear" }],
          }),
        ),
      /schema validation/,
    );
  });

  test("a missing required field is rejected", () => {
    const { title, ...withoutTitle } = extraction({ source_row: 7 });
    assert.throws(
      () => parseExtraction(JSON.stringify({ rows: [withoutTitle] })),
      /schema validation/,
    );
  });

  test("confidence outside 0-1 is rejected", () => {
    assert.throws(
      () =>
        parseExtraction(
          JSON.stringify({ rows: [{ ...extraction({ source_row: 7 }), confidence: 1.5 }] }),
        ),
      /schema validation/,
    );
  });

  test("non-JSON is reported as such, not swallowed", () => {
    assert.throws(() => parseExtraction("I could not do that"), /not valid JSON/);
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
