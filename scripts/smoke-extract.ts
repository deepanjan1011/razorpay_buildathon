/**
 * ONE real API call against ONE fixture row.
 *
 * Not a test — it needs a key and the network, so it stays out of `npm test`.
 * Its whole job is to exercise the request shape that every normalizer test
 * fakes: output_config.format, the strict schema, the refusal branch, and the
 * response fields the fingerprint reads.
 *
 * Until this has run once, `createExtractor` is an untested assumption sitting
 * in the pipeline — the same shape as the price bug, and it would fail
 * plausibly rather than loudly.
 *
 *   npm run smoke
 *
 * Requires ANTHROPIC_API_KEY. Prints the fingerprint to paste into
 * docs/NORMALIZATION-EVAL.md when the real eval runs.
 */
import { join } from "node:path";

import { parseWorkbook } from "../lib/ingest/parse.ts";
import { semanticCells } from "../lib/ingest/fields.ts";
import { createExtractor, MODEL } from "../lib/normalize/llm.ts";
import { normalizeSheet } from "../lib/normalize/normalize.ts";
import { projectFeed } from "../lib/feed/project.ts";
import { validate } from "../lib/feed/validate.ts";

const FIXTURE = "messy-05-title-attributes.xlsx";

function fail(message: string): never {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}

if (!process.env["ANTHROPIC_API_KEY"]) {
  fail(
    "ANTHROPIC_API_KEY is not set.\n" +
      "  cp .env.example .env and fill it in, then:\n" +
      "  export ANTHROPIC_API_KEY=... && npm run smoke",
  );
}

const path = join(import.meta.dirname, "..", "fixtures", FIXTURE);
const [sheet] = await parseWorkbook(path);
if (!sheet) fail(`no sheets in ${FIXTURE}`);

// One row. `Blk RunShoe M-9` — colour and size welded into the title, which is
// exactly the semantic work the model exists to do and the parse layer refuses
// to guess at.
const row = sheet.rows[0];
if (!row) fail(`no rows in ${FIXTURE}`);

const input = [{ source_row: row.row, cells: semanticCells(row.cells, sheet.headers) }];

console.log(`model:  ${MODEL}`);
console.log(`fixture: ${FIXTURE} row ${row.row}`);
console.log(`sent:   ${JSON.stringify(input[0]?.cells)}`);
if (JSON.stringify(input).match(/price|stock|\d{3,}/i)) {
  fail("a price- or stock-shaped value reached the model input — invariant 1");
}

const extract = createExtractor();

let result;
try {
  result = await extract(input);
} catch (error) {
  fail(`the call failed:\n  ${error instanceof Error ? error.message : String(error)}`);
}

console.log("\nfingerprint:");
for (const [k, v] of Object.entries(result.fingerprint)) console.log(`  ${k}: ${v}`);

if (result.fingerprint.model_served !== MODEL) {
  console.log(
    `\n! served by ${result.fingerprint.model_served}, not ${MODEL} — record this`,
  );
}

const extraction = result.batch.rows[0];
if (!extraction) fail("the model returned no rows for a one-row request");
console.log("\nextraction:");
console.log(JSON.stringify(extraction, null, 2));

if (extraction.source_row !== row.row) {
  fail(`source_row came back as ${extraction.source_row}, expected ${row.row}`);
}

// Carry it through the rest of the pipeline — the point is to prove the real
// response shape survives everything downstream, not just that a call returns.
const products = normalizeSheet(sheet, result.batch.rows, {
  merchantId: "mer_smoke",
  sourceFile: FIXTURE,
});
const feed = projectFeed(products, { feedId: "feed_smoke", targetCountry: "IN" });

console.log(
  `\nnormalized: ${products.length} product(s), ` +
    `${products.flatMap((p) => p.variants).length} variant(s)`,
);
console.log(`served: ${feed.products.length}, withheld: ${feed.withheld.length}`);
for (const w of feed.withheld) console.log(`  withheld ${w.id}: ${w.reason}`);

const errors = validate("ProductsResponse", { products: feed.products });
if (errors.length > 0) {
  fail(
    "the feed built from a REAL extraction failed ACP validation:\n" +
      errors.map((e) => `  ${e.path}: ${e.message}`).join("\n"),
  );
}

console.log("\n✓ real call → extraction → normalize → ACP feed, schema-valid");
