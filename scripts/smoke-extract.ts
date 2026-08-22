/**
 * ONE real API call per provider, against ONE fixture row.
 *
 * Not a test — it needs keys and the network, so it stays out of `npm test`.
 * Its whole job is to exercise the request shape every normalizer test fakes:
 * the structured-output config, the schema each provider actually accepts, the
 * refusal and truncation branches, and the response fields the fingerprint
 * reads.
 *
 * Until this has run, `createExtractor` is an untested assumption sitting in the
 * pipeline — the same shape as the price bug, and it would fail plausibly
 * rather than loudly.
 *
 *   npm run smoke            # both providers
 *   npm run smoke -- groq    # one
 */
import { join } from "node:path";

import { parseWorkbook } from "../lib/ingest/parse.ts";
import { semanticCells } from "../lib/ingest/fields.ts";
import { createExtractor, geminiProvider, groqProvider } from "../lib/normalize/llm.ts";
import type { Provider } from "../lib/normalize/llm.ts";
import { normalizeSheet } from "../lib/normalize/normalize.ts";
import { projectFeed } from "../lib/feed/project.ts";
import { validate } from "../lib/feed/validate.ts";

const FIXTURE = "messy-05-title-attributes.xlsx";

// Node does not read .env on its own. Load it if present, so `cp .env.example
// .env` and fill it in is genuinely all that is needed.
try {
  process.loadEnvFile();
} catch {
  // No .env — the provider's own key check reports it.
}

const requested = process.argv.slice(2);
const ALL: Provider[] = [groqProvider(), geminiProvider()];
const providers =
  requested.length === 0 ? ALL : ALL.filter((p) => requested.includes(p.id));
if (providers.length === 0) {
  console.error(`no such provider: ${requested.join(", ")} (groq | gemini)`);
  process.exit(1);
}

const path = join(import.meta.dirname, "..", "fixtures", FIXTURE);
const [sheet] = await parseWorkbook(path);
if (!sheet) throw new Error(`no sheets in ${FIXTURE}`);

// `Blk RunShoe M-9` — colour and size welded into the title. Exactly the
// semantic work the model exists to do and the parse layer refuses to guess at.
const row = sheet.rows[0];
if (!row) throw new Error(`no rows in ${FIXTURE}`);

const input = [{ source_row: row.row, cells: semanticCells(row.cells, sheet.headers) }];

console.log(`fixture: ${FIXTURE} row ${row.row}`);
console.log(`sent:    ${JSON.stringify(input[0]?.cells)}`);

// Invariant 1, checked on the actual payload rather than assumed.
if (/price|stock|\d{3,}/i.test(JSON.stringify(input))) {
  console.error("\n✗ a price- or stock-shaped value reached the model input — invariant 1");
  process.exit(1);
}

let failures = 0;

for (const provider of providers) {
  console.log(`\n${"─".repeat(60)}\n${provider.id}  (${provider.model}, ${provider.conformance})`);

  try {
    const result = await createExtractor(provider)(input);

    console.log(`latency: ${result.latency_ms}ms`);
    console.log("fingerprint:");
    for (const [k, v] of Object.entries(result.fingerprint)) console.log(`  ${k}: ${v}`);
    if (result.usage) console.log(`usage: ${JSON.stringify(result.usage)}`);

    const extraction = result.batch.rows[0];
    if (!extraction) throw new Error("no rows returned for a one-row request");
    console.log("extraction:");
    console.log(
      JSON.stringify(extraction, null, 2)
        .split("\n")
        .map((l) => "  " + l)
        .join("\n"),
    );

    if (extraction.source_row !== row.row) {
      throw new Error(`source_row came back as ${extraction.source_row}, expected ${row.row}`);
    }

    // Carry it all the way through: the point is that a REAL response shape
    // survives everything downstream, not merely that a call returns.
    const products = normalizeSheet(sheet, result.batch.rows, {
      merchantId: "mer_smoke",
      sourceFile: FIXTURE,
    });
    const feed = projectFeed(products, { feedId: "feed_smoke", targetCountry: "IN" });
    console.log(
      `pipeline: ${products.length} product(s), ` +
        `${products.flatMap((p) => p.variants).length} variant(s), ` +
        `${feed.products.length} served, ${feed.withheld.length} withheld`,
    );
    for (const w of feed.withheld) console.log(`  withheld ${w.id}: ${w.reason}`);

    const errors = validate("ProductsResponse", { products: feed.products });
    if (errors.length > 0) {
      throw new Error(
        "feed from a REAL extraction failed ACP validation:\n" +
          errors.map((e) => `    ${e.path}: ${e.message}`).join("\n"),
      );
    }

    console.log(`✓ ${provider.id}: call → extraction → normalize → ACP feed, schema-valid`);
  } catch (error) {
    failures++;
    console.error(`✗ ${provider.id}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

process.exit(failures > 0 ? 1 : 0);
