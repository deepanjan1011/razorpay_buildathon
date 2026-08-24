/**
 * One test per PHASE-1.md §4 mess case. If a bullet in §4 has no `describe`
 * here, the §8 gate is not met.
 *
 * Everything asserted here is DETERMINISTIC. Where a case needs semantics —
 * what a product is, which category it belongs to, what `Blk RunShoe M-9`
 * decomposes into — the test asserts that the parse layer preserves the raw
 * value and does NOT guess. Guessing is the model's job, later, and §4 is
 * explicit that anything a parser can do reliably must not go through it.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { parseWorkbook, findDuplicates, dedupeKey } from "../lib/ingest/parse.ts";
import {
  parsePrice,
  parseStock,
  splitList,
  hasIndicScript,
} from "../lib/ingest/cells.ts";
import { normalizeSheet } from "../lib/normalize/normalize.ts";
import type { RowExtraction } from "../lib/normalize/llm-schema.ts";

/** A model extraction that asserts nothing, so the deterministic layer is what is under test. */
const extraction = (over: { source_row: number; title: string }): RowExtraction => ({
  description: null,
  brand: null,
  category: "food",
  category_confidence: 1,
  variant_group: null,
  options: {},
  attributes: {},
  confidence: 1,
  title_inferred: false,
  ...over,
});

const fixture = (name: string) => join(import.meta.dirname, "..", "fixtures", name);

/**
 * `assert.ok` cannot narrow through a default import — TypeScript requires an
 * assertion function to be reached through an explicitly annotated name. One
 * annotated alias buys narrowing for the whole file.
 */
const present: <T>(value: T, message?: string) => asserts value is NonNullable<T> = (
  value,
  message,
) => assert.ok(value !== undefined && value !== null, message);

describe("§4.1 — title rows, blank rows and notes above the real header", () => {
  test("finds the header below the preamble and drops the preamble", async () => {
    const [sheet] = await parseWorkbook(fixture("messy-01-preamble.xlsx"));
    present(sheet);

    assert.equal(sheet.headerRow, 6);
    assert.deepEqual(sheet.headers, ["Item Name", "Category", "Price", "Stock"]);
    assert.equal(sheet.rows.length, 4);

    // Preamble is skipped with a reason, not silently dropped.
    assert.ok(sheet.skipped.some((s) => s.row === 1 && s.reason === "preamble"));
    assert.ok(sheet.skipped.some((s) => s.row === 4 && s.reason === "preamble"));

    const first = sheet.rows[0];
    present(first);
    assert.equal(first.cells["Item Name"], "Canvas Shoe White");
    assert.equal(first.cells["Price"], "899");
    // Provenance: the row number is the real sheet row, not an index into rows.
    assert.equal(first.row, 7);
    assert.equal(first.sheet, "Price List");
  });
});

describe("§4.2 — headers on row 3, spanning two rows, or absent entirely", () => {
  test("header on row 3", async () => {
    const sheets = await parseWorkbook(fixture("messy-02-headers.xlsx"));
    const sheet = sheets.find((s) => s.name === "header-row-3");
    present(sheet);

    assert.equal(sheet.headerRow, 3);
    assert.deepEqual(sheet.headers, ["Product", "Type", "Rate", "Qty"]);
    assert.equal(sheet.rows.length, 3);
  });

  test("header spanning two rows picks the row carrying the real field names", async () => {
    const sheets = await parseWorkbook(fixture("messy-02-headers.xlsx"));
    const sheet = sheets.find((s) => s.name === "two-row-header");
    present(sheet);

    // Row 1 is a merged group banner (Product Details / Pricing); row 2 has the
    // actual fields. No two-row-header special case is needed — row 2 simply
    // scores higher.
    assert.equal(sheet.headerRow, 2);
    assert.deepEqual(sheet.headers, [
      "Name",
      "Code",
      "MRP",
      "Sale Price",
      "Available",
    ]);
    assert.equal(sheet.rows.length, 3);
  });

  test("no header at all is reported as absent, not invented", async () => {
    const sheets = await parseWorkbook(fixture("messy-02-headers.xlsx"));
    const sheet = sheets.find((s) => s.name === "no-header");
    present(sheet);

    assert.equal(sheet.headerRow, null);
    assert.equal(sheet.headerScore, 0);
    // Positional placeholders, obviously synthetic — never a guessed field name.
    assert.deepEqual(sheet.headers, ["col_1", "col_2", "col_3", "col_4"]);
    assert.equal(sheet.rows.length, 3);

    const first = sheet.rows[0];
    present(first);
    assert.equal(first.cells["col_1"], "Steel Tiffin Box 3 Tier");
  });
});

describe("§4.3 — merged cells: one category cell covering twelve product rows", () => {
  test("merged category is expanded onto every covered row", async () => {
    const [sheet] = await parseWorkbook(fixture("messy-03-merged-category.xlsx"));
    present(sheet);

    assert.equal(sheet.rows.length, 14);

    const categories = sheet.rows.map((r) => r.cells["Category"]);
    assert.equal(categories.filter((c) => c === "Footwear").length, 12);
    assert.equal(categories.filter((c) => c === "Accessories").length, 2);

    // Spot-check a row in the middle of the merge, which is blank in the file.
    const middle = sheet.rows.find((r) => r.cells["Item"] === "Rubber Slipper");
    present(middle);
    assert.equal(middle.cells["Category"], "Footwear");

    // The expansion is recorded, so provenance shows the value was inherited
    // rather than read from that row's own cell.
    assert.equal(middle.inherited["Category"], 2);
  });
});

describe("§4.4 — price formats", () => {
  const cases: Array<[string | number | null, number | null, number | null]> = [
    // raw                    amount_minor   compare_at_minor
    [2799, 279900, null],
    ["2,799", 279900, null],
    ["₹2799", 279900, null],
    ["₹ 2,799", 279900, null],
    ["Rs. 1,299/-", 129900, null],
    ["2799/-", 279900, null],
    ["2.8k", 280000, null],
    ["1.5K", 150000, null],
    ["2799 (MRP 3499)", 279900, 349900],
    ["899.50", 89950, null],
  ];

  for (const [raw, amount, compareAt] of cases) {
    test(`parses ${JSON.stringify(raw)}`, () => {
      const got = parsePrice(raw);
      assert.equal(got.amount_minor, amount, `amount for ${raw}`);
      assert.equal(got.compare_at_minor, compareAt, `compare_at for ${raw}`);
    });
  }

  test("amounts are integer paise, never floats or rupees", () => {
    for (const [raw] of cases) {
      const { amount_minor } = parsePrice(raw);
      assert.ok(amount_minor !== null);
      assert.ok(Number.isInteger(amount_minor), `${raw} produced a non-integer`);
    }
  });

  test("flags an assumed currency only when no marker is present", () => {
    assert.ok(parsePrice(2799).flags.includes("CURRENCY_ASSUMED"));
    assert.ok(parsePrice("2,799").flags.includes("CURRENCY_ASSUMED"));
    assert.ok(!parsePrice("₹2799").flags.includes("CURRENCY_ASSUMED"));
    assert.ok(!parsePrice("Rs. 1,299/-").flags.includes("CURRENCY_ASSUMED"));
  });

  test("refuses a range instead of picking an end of it", () => {
    const got = parsePrice("500-700");
    assert.equal(got.amount_minor, null);
    assert.ok(got.flags.includes("PRICE_AMBIGUOUS"));
  });

  test("a price that is not a number is missing, not zero", () => {
    for (const raw of ["Call for price", null, "", "   "]) {
      const got = parsePrice(raw);
      assert.equal(got.amount_minor, null, `${JSON.stringify(raw)} should be null`);
      assert.ok(got.flags.includes("MISSING_REQUIRED_FIELD"));
    }
  });

  test("sub-paise precision is flagged rather than silently rounded away", () => {
    const got = parsePrice("899.567");
    assert.equal(got.amount_minor, 89957);
    assert.ok(got.flags.includes("PRICE_AMBIGUOUS"));
  });
});

describe("§4.5 — size and colour embedded in the title", () => {
  test("the raw title is preserved verbatim and not decomposed", async () => {
    const [sheet] = await parseWorkbook(fixture("messy-05-title-attributes.xlsx"));
    present(sheet);

    const titles = sheet.rows.map((r) => r.cells["Item"]);
    // `Blk RunShoe M-9` is colour + product + size, but working that out is
    // semantics. The parse layer must hand it over untouched.
    assert.deepEqual(titles, [
      "Blk RunShoe M-9",
      "Blk RunShoe M-10",
      "Wht RunShoe M-9",
      "Rd Snkr W-7",
      "Brn LthrSandal M-8",
    ]);
  });

  test("splitList does not fire on a title that merely contains a hyphen", () => {
    assert.deepEqual(splitList("Blk RunShoe M-9"), ["Blk RunShoe M-9"]);
  });
});

describe("§4.6 — one row describing several variants", () => {
  test("splits slash- and comma-delimited option cells", () => {
    assert.deepEqual(splitList("S/M/L"), ["S", "M", "L"]);
    assert.deepEqual(splitList("M/L/XL"), ["M", "L", "XL"]);
    assert.deepEqual(splitList("Red, Blue, Black"), ["Red", "Blue", "Black"]);
    assert.deepEqual(splitList("30 / 32 / 34"), ["30", "32", "34"]);
    assert.deepEqual(splitList("Green, Maroon"), ["Green", "Maroon"]);
  });

  test("a single value stays single; a blank yields nothing", () => {
    assert.deepEqual(splitList("Blue"), ["Blue"]);
    assert.deepEqual(splitList("Free Size"), ["Free Size"]);
    assert.deepEqual(splitList(null), []);
    assert.deepEqual(splitList("  "), []);
  });

  test("the cartesian product of size and colour is the variant count", async () => {
    const [sheet] = await parseWorkbook(fixture("messy-06-variants-in-row.xlsx"));
    present(sheet);

    const shirt = sheet.rows.find((r) => r.cells["Item"] === "Cotton Shirt");
    present(shirt);
    const sizes = splitList(shirt.cells["Size"]);
    const colours = splitList(shirt.cells["Colour"]);
    // M/L/XL × Red/Blue/Black = nine purchasable variants from one sheet row.
    assert.equal(sizes.length * colours.length, 9);

    const saree = sheet.rows.find((r) => r.cells["Item"] === "Silk Saree");
    present(saree);
    // No size column value at all — one axis, two variants, not zero.
    assert.deepEqual(splitList(saree.cells["Size"]), []);
    assert.equal(splitList(saree.cells["Colour"]).length, 2);
  });
});

describe("§4.7 — mixed Tamil/English and transliterated Tamil", () => {
  test("a Tamil header row is still detected as a header", async () => {
    const [sheet] = await parseWorkbook(fixture("messy-07-multilingual.xlsx"));
    present(sheet);

    assert.equal(sheet.name, "பொருட்கள்");
    assert.equal(sheet.headerRow, 1);
    assert.deepEqual(sheet.headers, ["பொருள்", "விலை", "Stock"]);
    assert.equal(sheet.rows.length, 5);
  });

  test("Tamil text survives byte-for-byte", async () => {
    const [sheet] = await parseWorkbook(fixture("messy-07-multilingual.xlsx"));
    present(sheet);
    const first = sheet.rows[0];
    present(first);
    assert.equal(first.cells["பொருள்"], "பருத்தி சேலை");
  });

  test("Indic script is detected; transliteration is not claimed", () => {
    assert.ok(hasIndicScript("பருத்தி சேலை"));
    assert.ok(hasIndicScript("Cotton Towel / துண்டு"));
    assert.ok(!hasIndicScript("Cotton Shirt"));
    // `Paruthi Sattai` is Tamil written in Latin script. Detecting that
    // deterministically is not reliable, so we do not pretend to — it is left
    // for the model, and this assertion pins that honesty in place.
    assert.ok(!hasIndicScript("Paruthi Sattai (Cotton Shirt)"));
  });

  test("₹ and ✓ are not mistaken for Indic script", () => {
    assert.ok(!hasIndicScript("₹2799"));
    assert.ok(!hasIndicScript("✓"));
  });
});

describe("§4.8 — trailing junk rows: totals, notes, contact numbers", () => {
  test("junk below the data is dropped with a reason", async () => {
    const [sheet] = await parseWorkbook(fixture("messy-08-trailing-junk.xlsx"));
    present(sheet);

    assert.equal(sheet.rows.length, 3);
    assert.deepEqual(
      sheet.rows.map((r) => r.cells["Item"]),
      ["Steel Tiffin Box", "Steel Tumbler Set", "Copper Bottle"],
    );

    const junk = sheet.skipped.filter((s) => s.reason === "junk").map((s) => s.row);
    assert.deepEqual(junk, [6, 7, 8, 9]); // TOTAL, note, phone, disclaimer
    assert.ok(sheet.skipped.some((s) => s.row === 5 && s.reason === "blank"));
  });

  test("a totals row is not mistaken for a product", async () => {
    const [sheet] = await parseWorkbook(fixture("messy-08-trailing-junk.xlsx"));
    present(sheet);
    assert.ok(!sheet.rows.some((r) => /total/i.test(r.cells["Item"] ?? "")));
  });
});

describe("§4.9 — duplicate products across sheets", () => {
  test("groups duplicates across every sheet in the workbook", async () => {
    const sheets = await parseWorkbook(fixture("messy-09-duplicates.xlsx"));
    const rows = sheets.flatMap((s) => s.rows);
    assert.equal(rows.length, 7);

    const groups = findDuplicates(rows, "Item");
    assert.equal(groups.length, 2);

    const canvas = groups.find((g) => g.key === dedupeKey("Canvas Shoe White"));
    present(canvas);
    // Two sheets plus a whitespace/casing variant.
    assert.equal(canvas.rows.length, 3);
    assert.deepEqual(canvas.conflicting, []);

    const chappal = groups.find((g) => g.key === dedupeKey("Kolhapuri Chappal"));
    present(chappal);
    assert.equal(chappal.rows.length, 2);
    // Same product, two prices. That is a conflict for a human, not something
    // to resolve by picking one.
    assert.deepEqual(chappal.conflicting, ["Price"]);
  });

  test("the dedupe key ignores case, padding and inner whitespace only", () => {
    assert.equal(dedupeKey("  canvas shoe white "), dedupeKey("Canvas Shoe White"));
    assert.equal(dedupeKey("Canvas  Shoe   White"), dedupeKey("Canvas Shoe White"));
    // Different products must not collide.
    assert.notEqual(dedupeKey("Canvas Shoe White"), dedupeKey("Canvas Shoe Black"));
  });
});

describe("§4.10 — stock as yes/no/✓/blank/10 pcs", () => {
  const cases: Array<[string | number | null, string, number | null]> = [
    // raw            availability     inventory_count
    ["yes", "in_stock", null],
    ["no", "out_of_stock", null],
    ["✓", "in_stock", null],
    ["✗", "out_of_stock", null],
    ["Y", "in_stock", null],
    ["N", "out_of_stock", null],
    [null, "unknown", null],
    ["10 pcs", "in_stock", 10],
    [0, "out_of_stock", 0],
    [24, "in_stock", 24],
    ["In Stock", "in_stock", null],
    ["Out of stock", "out_of_stock", null],
    ["-", "unknown", null],
    ["available", "in_stock", null],
    ["SOLD OUT", "out_of_stock", null],
  ];

  for (const [raw, availability, count] of cases) {
    test(`reads ${JSON.stringify(raw)} as ${availability}`, () => {
      const got = parseStock(raw);
      assert.equal(got.availability, availability);
      assert.equal(got.inventory_count, count);
    });
  }

  test("negative phrasing wins over the word it contains", () => {
    // "Out of stock" contains "stock"; "not available" contains "available".
    assert.equal(parseStock("Out of stock").availability, "out_of_stock");
    assert.equal(parseStock("not available").availability, "out_of_stock");
    assert.equal(parseStock("no stock").availability, "out_of_stock");
  });

  test("an unreadable value is unknown, never assumed in stock", () => {
    for (const raw of ["ask", "??", "call", "-"]) {
      assert.equal(parseStock(raw).availability, "unknown", `${raw}`);
    }
  });
});

describe("§4.11 — a sheet where every cell is text, no typed numbers anywhere", () => {
  test("the header row is still found, so columns keep the merchant's names", async () => {
    const [sheet] = await parseWorkbook(fixture("messy-11-all-text.xlsx"));
    assert.ok(sheet);

    // The regression this guards: `detectHeader` required a TYPED numeric cell
    // in the first data row. There is none here — `₹ 57/Pack` is a string — so
    // the header was read as data and every column came back `col_N`. That is
    // not a cosmetic loss: the accuracy scorer locates the price column BY ITS
    // HEADER NAME, so positional keys made price silently unscoreable.
    assert.equal(sheet.headerRow, 4);
    assert.deepEqual(sheet.headers, ["Category", "Product", "Price", "Pack Size"]);
    assert.equal(sheet.rows.length, 3);

    const first = sheet.rows[0];
    assert.ok(first);
    assert.equal(first.cells["Price"], "₹ 57/Pack");
    assert.equal(first.cells["Product"], "Mixture 150gm");
  });
});

describe("§4.12 — a price quoted per unit of measure, beside a pack that is not that unit", () => {
  // "₹ 100/Kg" on a 250g pack is either ₹100 for the pack or ₹25 of a kilo
  // rate, and the sheet does not choose. The pipeline must not choose either:
  // computing 250/1000 × ₹100 invents a price the merchant never wrote, on the
  // one path where being confidently wrong costs real money.
  //
  // The rows that must NOT flag are the point of this case. Every per-Kg row on
  // the real sheet also states a smaller pack, so the real sheet cannot catch a
  // rule that fires on all of them — and such a rule empties the feed of every
  // merchant who sells by weight.
  const expected: Array<[string, boolean]> = [
    ["Adhirasam", true],
    ["Kara Boondi", true],
    ["Sesame Oil Sachet", true], // a volume rate cannot price a mass pack
    ["Loose Rice", false], // a kilo rate with no pack stated IS the kilo
    ["Ghee Tin", false], // the pack is exactly the unit quoted
    ["Cooking Oil", false],
    ["Murukku", false], // "Pack" is a sale unit, not a unit of measure
    ["Fryums", false],
  ];

  for (const [item, ambiguous] of expected) {
    test(`${item} is ${ambiguous ? "" : "not "}ambiguous`, async () => {
      const [sheet] = await parseWorkbook(fixture("messy-12-measure-rates.xlsx"));
      assert.ok(sheet);
      const row = sheet.rows.find((r) => r.cells["Item"] === item);
      assert.ok(row, `${item} missing from the fixture`);

      const variant = normalizeSheet(
        sheet,
        [extraction({ source_row: row.row, title: item })],
        { merchantId: "mer_t", sourceFile: "t.xlsx" },
      )
        .flatMap((p) => p.variants)
        .find((v) => v.provenance.source_row === row.row);

      assert.ok(variant);
      assert.equal(variant.normalization.flags.includes("PRICE_AMBIGUOUS"), ambiguous);
    });
  }

  test("an ambiguous row is held for review, not repriced", async () => {
    const [sheet] = await parseWorkbook(fixture("messy-12-measure-rates.xlsx"));
    assert.ok(sheet);
    const row = sheet.rows.find((r) => r.cells["Item"] === "Adhirasam");
    assert.ok(row);
    const variant = normalizeSheet(
      sheet,
      [extraction({ source_row: row.row, title: "Adhirasam" })],
      { merchantId: "mer_t", sourceFile: "t.xlsx" },
    ).flatMap((p) => p.variants)[0];

    assert.ok(variant);
    assert.ok(variant.normalization.needs_review);
    // ₹100 as written, NOT 250/1000 × ₹100 = ₹25. The merchant's figure is kept
    // for them to look at; what is withheld is the claim that it is a pack price.
    assert.equal(variant.price.amount_minor, 10000);
  });
});
