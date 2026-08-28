/**
 * Turns a real merchant sheet into a labelling skeleton.
 *
 *   npm run label:init -- fixtures/real-lakshmi.xlsx
 *
 * PLAN.md §5 asks for fifty hand-labelled products. Hand-labelling from
 * scratch means retyping every row before you can even start deciding what the
 * right answer is, which is most of the work and none of the judgement.
 *
 * So this emits one entry per parsed row with the RAW CELLS already filled in
 * and the answer fields blank. What is left is the part only a person can do:
 * looking at `Blk RunShoe M-9` and saying what it actually is.
 *
 * The output goes next to the sheet as `<name>.labels.json`, which the
 * `fixtures/real-*` gitignore already covers — real merchant data does not get
 * committed (DESIGN.md §9).
 */
import { basename, dirname, join } from "node:path";
import { writeFile } from "node:fs/promises";

import { parseWorkbook } from "../lib/ingest/parse.ts";
import { CATEGORIES } from "../lib/normalize/taxonomy.ts";

const path = process.argv[2];
if (!path) {
  console.error("usage: npm run label:init -- fixtures/real-<name>.xlsx");
  process.exit(1);
}

const sheets = await parseWorkbook(path);
const sheet = sheets[0];
if (!sheet) {
  console.error(`no sheets in ${path}`);
  process.exit(1);
}

const out = {
  $comment: [
    "Hand labels for the normalization eval. PLAN.md §5.",
    "Fill in the answer fields. Leave a field null to skip scoring it.",
    "title:    keywords that MUST appear (any one of them counts as correct)",
    "category: acceptable values — more than one may be genuinely right",
    "colour/size: acceptable values, or null if the row has no such dimension",
    "Do NOT tune these to what the pipeline produced. Label what is true.",
    `valid categories: ${CATEGORIES.join(", ")}`,
  ],
  source: {
    file: basename(path),
    sheet: sheet.name,
    // Fill these in. They are the provenance line that makes the number honest.
    origin: "TODO: shop name / public listing URL",
    collected_on: "TODO: YYYY-MM-DD",
    collected_by: "TODO",
    method: "TODO: photographed and transcribed | transcribed from public listing",
    permission: "TODO: how this may be used",
  },
  rows: sheet.rows.map((row) => ({
    source_row: row.row,
    // Context, so the labeller can see what they are labelling without
    // switching windows. Not scored.
    raw: row.cells,
    title: [] as string[],
    category: [] as string[],
    colour: null as string[] | null,
    size: null as string[] | null,
    title_inferred: false,
  })),
};

const target = join(dirname(path), `${basename(path).replace(/\.[^.]+$/, "")}.labels.json`);
await writeFile(target, JSON.stringify(out, null, 2), "utf8");

console.log(`wrote ${target}`);
console.log(`${out.rows.length} rows to label (§5 wants at least 50)`);
console.log(`skipped by the parser: ${sheet.rows.length === 0 ? "all" : sheet.skipped.length} rows`);
console.log("\nfill in `source` and the answer fields, then: npm run eval -- " + path);
