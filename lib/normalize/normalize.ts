/**
 * Deterministic assembly. PHASE-1.md §3, stages four and five.
 *
 * Takes parsed rows plus the model's semantic reading and produces the internal
 * Product/Variant model. Every decision that touches money or stock is made
 * here, from the raw cells, never from the model's output — the model supplies
 * titles, categories and attributes only.
 *
 * Nothing is dropped. A row the model could not read confidently becomes a
 * flagged variant that surfaces in review, which is the whole point of
 * `needs_review` existing.
 */
import { createHash } from "node:crypto";

import { hasIndicScript, parsePrice, parseStock, splitList } from "../ingest/cells.ts";
import { findField } from "../ingest/fields.ts";
import type { ParsedSheet, RawRow } from "../ingest/parse.ts";
import { needsReview } from "./flags.ts";
import type { NormalizationFlag } from "./flags.ts";
import type { RowExtraction } from "./llm-schema.ts";
import type { Money, Normalization, Product, Provenance, Variant } from "./schema.ts";
import { isCategory } from "./taxonomy.ts";

/**
 * Below these, a row goes to a human instead of to buyers. Deliberately
 * generous — PHASE-1.md §2 says do not force-fit, and a false confident
 * publish is worse than a review queue that is too long.
 */
export const CATEGORY_CONFIDENCE_MIN = 0.7;
export const ROW_CONFIDENCE_MIN = 0.6;

export type NormalizeContext = {
  merchantId: string;
  sourceFile: string;
};

/**
 * Ids are derived from content, not from row order, so that re-ingesting an
 * edited sheet does not renumber everything.
 *
 * This matters beyond tidiness: `Variant.id` becomes the ACP checkout
 * `items[].id` (rfc.product_feeds.md §4.3), so an id that shifts when a row
 * moves would break an agent's saved reference and, in Phase 3, a mandate
 * issued against it.
 */
function stableId(prefix: string, ...parts: string[]): string {
  const hash = createHash("sha256").update(parts.join(" ")).digest("hex");
  return `${prefix}_${hash.slice(0, 16)}`;
}

function money(amount_minor: number): Money {
  return { amount_minor, currency: "INR" };
}

function provenanceFor(row: RawRow, sheet: ParsedSheet, ctx: NormalizeContext): Provenance {
  return {
    source_file: ctx.sourceFile,
    source_sheet: sheet.name,
    source_row: row.row,
    source_cells: { ...row.cells },
  };
}

function normalization(flags: NormalizationFlag[], confidence: number): Normalization {
  // Blocking flags only. An advisory flag is provenance, not doubt — see
  // flags.ts for why treating every flag as blocking is less safe, not more.
  return { confidence, flags, needs_review: needsReview(flags) };
}

/**
 * Expands option values that are themselves lists into the cartesian product.
 *
 * `{Size: "S/M/L", Colour: "Red, Blue"}` becomes six option sets. The splitting
 * is deterministic (lib/ingest/cells.ts) rather than asked of the model, and
 * `splitList` refuses to split a measure like `1/2 kg` — see OBSTACLES.md.
 */
export function expandOptions(
  options: Record<string, string>,
): Array<Record<string, string>> {
  let combinations: Array<Record<string, string>> = [{}];

  for (const [name, raw] of Object.entries(options)) {
    const values = splitList(raw);
    if (values.length === 0) continue;
    const next: Array<Record<string, string>> = [];
    for (const base of combinations) {
      for (const value of values) next.push({ ...base, [name]: value });
    }
    combinations = next;
  }

  return combinations;
}

function variantsForRow(
  row: RawRow,
  sheet: ParsedSheet,
  extraction: RowExtraction,
  ctx: NormalizeContext,
): Variant[] {
  const priceField = findField(sheet.headers, "price");
  const listField = findField(sheet.headers, "list_price");
  const stockField = findField(sheet.headers, "stock");

  const parsed = parsePrice(priceField === null ? null : row.cells[priceField]);
  const stock = parseStock(stockField === null ? null : row.cells[stockField]);

  // A dedicated MRP column wins over one scraped out of "2799 (MRP 3499)".
  let compareAt: Money | null =
    parsed.compare_at_minor === null ? null : money(parsed.compare_at_minor);
  if (listField !== null) {
    const listed = parsePrice(row.cells[listField]);
    if (listed.amount_minor !== null) compareAt = money(listed.amount_minor);
  }

  const baseFlags: NormalizationFlag[] = [...parsed.flags];

  const category = isCategory(extraction.category) ? extraction.category : "unmapped";
  if (
    category === "unmapped" ||
    extraction.category_confidence < CATEGORY_CONFIDENCE_MIN
  ) {
    baseFlags.push("CATEGORY_UNMAPPED");
  }

  if (extraction.title_inferred) baseFlags.push("TITLE_INFERRED");
  if (extraction.confidence < ROW_CONFIDENCE_MIN) baseFlags.push("MISSING_REQUIRED_FIELD");

  // Not MISSING_REQUIRED_FIELD: a price we cannot read is unsellable, but stock
  // we cannot read is a signal the spec already treats as non-authoritative.
  // The feed omits availability rather than guessing at it.
  //
  // The two cases are different facts and get different flags. NO stock column
  // is a property of the sheet — true of most price lists, and flagging it per
  // row would queue an entire catalogue to tell the merchant something they
  // already know. A column that EXISTS with an unreadable value is a real
  // per-row uncertainty worth a human glance.
  if (stock.availability === "unknown") {
    baseFlags.push(stockField === null ? "STOCK_NOT_TRACKED" : "STOCK_UNKNOWN");
  }

  // Script detection is deterministic; transliteration is not, so a Tamil-script
  // row is flagged and a `Paruthi Sattai` row is not. See OBSTACLES.md.
  if (Object.values(row.cells).some(hasIndicScript)) {
    baseFlags.push("MULTILINGUAL_SOURCE");
  }

  const optionSets = expandOptions(extraction.options);
  if (optionSets.length > 1) baseFlags.push("VARIANTS_SPLIT");

  const provenance = provenanceFor(row, sheet, ctx);

  // IDENTITY COMES FROM THE MERCHANT'S OWN CELLS, NOT THE MODEL'S TITLE.
  //
  // This used to be `extraction.variant_group ?? extraction.title`. On the
  // first real sheet the model titled three different products "Sesame Chikki"
  // — black sesame, white sesame and white til — and all three collapsed to
  // ONE variant id. `Variant.id` is the ACP `items[].id`, so an agent
  // referencing it had referenced three products, and a Phase 3 mandate issued
  // against it would authorise a purchase nobody can identify. A prompt fix
  // makes those titles distinct again, but leaves identity resting on the
  // model wording a title the same way twice.
  //
  // The price and stock columns are excluded deliberately: repricing an item
  // must not mint a new id, and an id that changes on every stock edit breaks
  // the saved reference this hash exists to protect. What remains is the
  // merchant's own identifying text — distinct for distinct products, and
  // identical for genuinely duplicate rows, which is what dedup wants.
  // Case-folded and whitespace-collapsed, because the duplicates a merchant
  // actually produces differ that way: messy-09 lists "Canvas Shoe White" on
  // one sheet and "canvas shoe white" on another, and they are one product.
  // Hashing the bytes verbatim made cross-sheet dedup fail — caught by the
  // regression test, not by reading this.
  const identityFields = Object.entries(row.cells)
    .filter(([k]) => k !== priceField && k !== listField && k !== stockField)
    .map(([k, v]) => `${k.toLowerCase().trim()}=${v.toLowerCase().trim().replace(/\s+/g, " ")}`)
    .sort()
    .join(";");
  const identity = extraction.variant_group ?? (identityFields || extraction.title);

  return optionSets.map((options) => {
    const flags = [...baseFlags];
    // A variant with no price cannot be sold. Belt and braces: parsePrice
    // already flags this, but the assembly must not be able to emit a priced
    // record from an unpriced row by some future refactor.
    const amount = parsed.amount_minor;
    if (amount === null && !flags.includes("MISSING_REQUIRED_FIELD")) {
      flags.push("MISSING_REQUIRED_FIELD");
    }

    const optionSignature = Object.entries(options)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join(";");

    const title =
      optionSignature === ""
        ? extraction.title
        : `${extraction.title} - ${Object.values(options).join(" / ")}`;

    return {
      id: stableId("var", ctx.merchantId, identity, optionSignature),
      title,
      category,
      category_raw: extraction.category === category ? null : extraction.category,
      category_confidence: extraction.category_confidence,
      price: money(amount ?? 0),
      compare_at_price: compareAt,
      availability: stock.availability,
      inventory_count: stock.inventory_count,
      options,
      attributes: { ...extraction.attributes },
      image_url: null,
      provenance,
      normalization: normalization(flags, extraction.confidence),
    };
  });
}

export function normalizeSheet(
  sheet: ParsedSheet,
  extractions: RowExtraction[],
  ctx: NormalizeContext,
): Product[] {
  const byRow = new Map(extractions.map((e) => [e.source_row, e]));
  const groups = new Map<string, { extraction: RowExtraction; variants: Variant[] }>();
  // `extraction` is mutable: product identity is resolved to the best row in the
  // group as rows arrive, rather than fixed by read order. See below.

  for (const row of sheet.rows) {
    const extraction = byRow.get(row.row);
    if (extraction === undefined) {
      // The model returned nothing for this row. Do not skip it — an
      // unexplained disappearance is exactly the silent drop PHASE-1.md §8
      // forbids. Emit a fully flagged placeholder so it shows up in review.
      const provenance = provenanceFor(row, sheet, ctx);
      const key = `__unextracted_${row.row}`;
      groups.set(key, {
        extraction: {
          source_row: row.row,
          title: "",
          title_inferred: true,
          category: "unmapped",
          category_confidence: 0,
          options: {},
          attributes: {},
          brand: null,
          description: null,
          variant_group: null,
          confidence: 0,
        },
        variants: [
          {
            id: stableId("var", ctx.merchantId, sheet.name, String(row.row)),
            title: Object.values(row.cells)[0] ?? `row ${row.row}`,
            category: "unmapped",
            category_raw: null,
            category_confidence: 0,
            price: money(0),
            compare_at_price: null,
            availability: "unknown",
            inventory_count: null,
            options: {},
            attributes: {},
            image_url: null,
            provenance,
            normalization: normalization(
              ["MISSING_REQUIRED_FIELD", "CATEGORY_UNMAPPED"],
              0,
            ),
          },
        ],
      });
      continue;
    }

    const key = extraction.variant_group ?? `__row_${row.row}`;
    const existing = groups.get(key);
    const variants = variantsForRow(row, sheet, extraction, ctx);
    if (existing) {
      existing.variants.push(...variants);
      // Product identity comes from the best row in the group, not whichever
      // row happened to be read first. One row with an invented title would
      // otherwise withhold a whole product whose other rows are named fine —
      // and which row is "first" is an accident of sheet order.
      if (existing.extraction.title_inferred && !extraction.title_inferred) {
        existing.extraction = extraction;
      }
    } else {
      groups.set(key, { extraction, variants });
    }
  }

  const products: Product[] = [];
  for (const [key, group] of groups) {
    const { extraction, variants } = group;
    const first = variants[0];
    if (first === undefined) continue;

    // A product is flagged when its own identity is uncertain. A flagged
    // *variant* does not condemn its siblings — the projection withholds it
    // and serves the rest.
    const productFlags: NormalizationFlag[] = [];
    if (extraction.title_inferred) productFlags.push("TITLE_INFERRED");

    products.push({
      id: stableId("prod", ctx.merchantId, key),
      merchant_id: ctx.merchantId,
      title: extraction.title === "" ? first.title : extraction.title,
      description: extraction.description,
      brand: extraction.brand,
      variants,
      image_url: null,
      provenance: first.provenance,
      normalization: normalization(productFlags, extraction.confidence),
    });
  }

  return products;
}
