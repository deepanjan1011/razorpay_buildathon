/**
 * The normalization accuracy number. PHASE-1.md §5.
 *
 *   npm run eval -- fixtures/real-<name>.xlsx
 *
 * Runs the real pipeline against a real merchant sheet, scores it against hand
 * labels, and rewrites docs/NORMALIZATION-EVAL.md.
 *
 * THIS NUMBER IS NEVER TUNED. The rules that keep it honest are enforced here
 * rather than left to discipline:
 *
 *   - It refuses to run on a synthetic fixture. `fixtures/messy-*` are ours; a
 *     number measured against mess we authored measures our own imagination.
 *   - It refuses to run without provenance filled in. A number whose source is
 *     unstated is not evidence.
 *   - It lists EVERY failure with its source row. §5 says the failures are not
 *     optional and not a summary — they are the part a reader checks first.
 *   - It records the run fingerprint, because an accuracy number belongs to the
 *     provider, model and prompt that produced it.
 */
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { parseWorkbook } from "../lib/ingest/parse.ts";
import { semanticCells } from "../lib/ingest/fields.ts";
import { createExtractor, defaultProvider } from "../lib/normalize/llm.ts";
import { extractCatalogue } from "../lib/normalize/batch.ts";
import { normalizeSheet } from "../lib/normalize/normalize.ts";
import type { RowExtraction } from "../lib/normalize/llm-schema.ts";
import type { Variant } from "../lib/normalize/schema.ts";

try {
  process.loadEnvFile();
} catch {
  /* provider key check reports it */
}

const noteFlag = process.argv.indexOf("--note");
const note = noteFlag > 0 ? (process.argv[noteFlag + 1] ?? "") : "";
const path = process.argv.filter((a, i) => i >= 2 && a !== "--note" && i !== noteFlag + 1)[0];
if (!path) {
  console.error("usage: npm run eval -- fixtures/real-<name>.xlsx");
  process.exit(1);
}

// Guard one: synthetic fixtures cannot produce this number.
if (/\bmessy-/.test(basename(path))) {
  console.error(
    "REFUSED: that is a synthetic fixture.\n" +
      "  The eval measures the pipeline against mess WE DID NOT WRITE. Scoring\n" +
      "  against our own fixtures measures our imagination, not the world.\n" +
      "  Use a real merchant sheet: fixtures/real-*.",
  );
  process.exit(1);
}

type Label = {
  source_row: number;
  raw: Record<string, string>;
  title: string[];
  category: string[];
  colour: string[] | null;
  size: string[] | null;
  title_inferred: boolean;
  /**
   * Expected price in MINOR UNITS, or "ambiguous" when the sheet genuinely does
   * not say. `₹ 57/Pack` on a 150g pack and `₹ 57/Kg` on the same 150g pack are
   * different claims, and the second does not state what one pack costs. The
   * correct answer there is not a number — it is PRICE_AMBIGUOUS and a review
   * flag, which the taxonomy already has. Scoring a number would score a guess.
   */
  price?: number | "ambiguous";
};

type Labels = {
  source: Record<string, string>;
  rows: Label[];
};

const labelPath = join(
  dirname(path),
  `${basename(path).replace(/\.[^.]+$/, "")}.labels.json`,
);

let labels: Labels;
try {
  labels = JSON.parse(await readFile(labelPath, "utf8")) as Labels;
} catch {
  console.error(
    `REFUSED: no labels at ${labelPath}\n` +
      `  Run: npm run label:init -- ${path}`,
  );
  process.exit(1);
}

// Guard two: provenance must be real before a number is published.
const todo = Object.entries(labels.source ?? {}).filter(([, v]) => /^TODO/.test(String(v)));
if (todo.length > 0) {
  console.error(
    "REFUSED: provenance is not filled in — " +
      todo.map(([k]) => k).join(", ") +
      "\n  DESIGN.md §9: where the data came from is part of the number.",
  );
  process.exit(1);
}

const labelled = labels.rows.filter((r) => r.title.length > 0 || r.category.length > 0);
if (labelled.length === 0) {
  console.error("REFUSED: no rows have been labelled yet.");
  process.exit(1);
}

// ── run the real pipeline ─────────────────────────────────────────────────
const [sheet] = await parseWorkbook(path);
if (!sheet) {
  console.error(`no sheets in ${path}`);
  process.exit(1);
}

const provider = defaultProvider();
const wanted = new Set(labelled.map((r) => r.source_row));
const rows = sheet.rows
  .filter((r) => wanted.has(r.row))
  .map((r) => ({ source_row: r.row, cells: semanticCells(r.cells, sheet.headers) }));

console.log(`${provider.id} (${provider.model}) — ${rows.length} labelled rows`);

const result = await extractCatalogue(createExtractor(provider), rows, {
  onProgress: (p) => console.log(`  batch ${p.batchesDone}/${p.batchesTotal}`),
});

const products = normalizeSheet(sheet, result.rows, {
  merchantId: "mer_eval",
  sourceFile: basename(path),
});
const byRow = new Map<number, Variant>();
for (const p of products) {
  for (const v of p.variants) if (!byRow.has(v.provenance.source_row)) byRow.set(v.provenance.source_row, v);
}
const extractionByRow = new Map<number, RowExtraction>(
  result.rows.map((r) => [r.source_row, r]),
);

// ── score ─────────────────────────────────────────────────────────────────
const norm = (s: string) => s.toLowerCase().trim().replace(/\s+/g, " ");
const oneOf = (v: string | undefined, accepted: string[]) =>
  v !== undefined && accepted.some((a) => norm(a) === norm(v));
const anyKeyword = (v: string, keywords: string[]) =>
  keywords.some((k) => norm(v).includes(norm(k)));

type Miss = { row: number; field: string; got: string; want: string; raw: string };
const scores: Record<string, { ok: number; total: number }> = {};
const misses: Miss[] = [];

function score(field: string, ok: boolean, row: number, got: string, want: string, raw: string) {
  scores[field] ??= { ok: 0, total: 0 };
  scores[field].total++;
  if (ok) scores[field].ok++;
  else misses.push({ row, field, got, want, raw });
}

for (const label of labelled) {
  const raw = Object.values(label.raw).join(" | ");
  const extraction = extractionByRow.get(label.source_row);
  const variant = byRow.get(label.source_row);

  if (!extraction || !variant) {
    score("row_returned", false, label.source_row, "MISSING", "an entry", raw);
    continue;
  }
  score("row_returned", true, label.source_row, "ok", "an entry", raw);

  if (label.title.length) {
    score("title", anyKeyword(extraction.title, label.title), label.source_row,
      extraction.title, label.title.join("|"), raw);
  }
  if (label.category.length) {
    score("category", oneOf(variant.category, label.category), label.source_row,
      variant.category, label.category.join("|"), raw);
  }
  score("title_inferred", extraction.title_inferred === label.title_inferred,
    label.source_row, String(extraction.title_inferred), String(label.title_inferred), raw);

  const opt = (names: string[]) => {
    for (const [k, v] of Object.entries(extraction.options)) {
      if (names.some((n) => norm(k) === n)) return v;
    }
    return undefined;
  };
  if (label.colour) {
    score("colour", oneOf(opt(["colour", "color"]), label.colour), label.source_row,
      opt(["colour", "color"]) ?? "—", label.colour.join("|"), raw);
  }
  if (label.size) {
    score("size", oneOf(opt(["size"]), label.size), label.source_row,
      opt(["size"]) ?? "—", label.size.join("|"), raw);
  }

  // Price is deterministic, never the model's — but it is scored against the
  // LABEL, not against "did we produce any number at all". `amount_minor > 0`
  // passes for a confidently wrong price, which on the money path is the worst
  // grade to award.
  if (label.price === "ambiguous") {
    const flagged = variant.normalization.flags.includes("PRICE_AMBIGUOUS");
    score("price_ambiguous_flagged", flagged, label.source_row,
      flagged ? "PRICE_AMBIGUOUS" : variant.normalization.flags.join(",") || "no flag",
      "PRICE_AMBIGUOUS", raw);
  } else if (typeof label.price === "number") {
    score("price_parsed", variant.price.amount_minor === label.price, label.source_row,
      String(variant.price.amount_minor), String(label.price), raw);
  }
}

const allVariants = products.flatMap((p) => p.variants);
const flagCounts: Record<string, number> = {};
for (const v of allVariants) for (const f of v.normalization.flags) flagCounts[f] = (flagCounts[f] ?? 0) + 1;
const needsReview = allVariants.filter((v) => v.normalization.needs_review).length;

// Guard three: a field that was labelled must actually have been scored.
//
// `price_parsed` scored ZERO rows and the table simply omitted it — no error,
// no warning, a clean-looking number missing the one field where being wrong
// costs money. The cause was that the scorer locates the price column by its
// HEADER NAME, and a sheet whose header row went undetected has positional
// `col_N` keys instead. Both halves were silent.
//
// A scorer that cannot find a field must say so and stop. This is the same
// family as the two refusals above, and the fifth time on this project that
// the failure signature has been "green, nothing checked".
const expected: Array<[string, number]> = [
  ["title", labelled.filter((r) => r.title.length > 0).length],
  ["category", labelled.filter((r) => r.category.length > 0).length],
  ["colour", labelled.filter((r) => r.colour !== null).length],
  ["size", labelled.filter((r) => r.size !== null).length],
  ["price_parsed", labelled.filter((r) => typeof r.price === "number").length],
  ["price_ambiguous_flagged", labelled.filter((r) => r.price === "ambiguous").length],
];
const unscored = expected.filter(([field, want]) => want > 0 && (scores[field]?.total ?? 0) === 0);
if (unscored.length > 0) {
  console.error(
    "REFUSED: labelled fields that scored zero rows — " +
      unscored.map(([f, n]) => `${f} (${n} labelled)`).join(", ") +
      "\n  The scorer could not locate these fields, so the number would be\n" +
      "  published without them and nothing would say so. Fix the scorer or\n" +
      "  the labels; do not publish a number with a hole in it.",
  );
  process.exit(1);
}

const overall = Object.values(scores).reduce(
  (a, s) => ({ ok: a.ok + s.ok, total: a.total + s.total }),
  { ok: 0, total: 0 },
);
const pct = (o: number, t: number) => (t === 0 ? "—" : `${Math.round((o / t) * 100)}%`);



// A field where every label carries the SAME value cannot discriminate: it will
// read 100% whatever the pipeline does. Detected rather than remembered, so the
// next fixture reports its own blind spots instead of inheriting this note.
const singleValued = (["category", "colour", "size"] as const)
  .map((field) => {
    const values = new Set(
      labelled.flatMap((r) => (field === "category" ? r.category : (r[field] ?? []))),
    );
    return [field, values] as const;
  })
  .filter(([, values]) => values.size === 1)
  .map(([field, values]) => `\`${field}\` (every labelled row is \`${[...values][0]}\`)`);

// ── run history ───────────────────────────────────────────────────────────
// Both numbers get published, not just the latest. A single figure cannot show
// that the eval FOUND something; two, with the change between them, can. The
// history is a data file this script appends to, so the document stays fully
// generated and the "never hand-edited" rule still holds.
type Run = {
  run_date: string;
  model_served: string;
  prompt_sha256: string;
  ok: number;
  total: number;
  note: string;
};
const runsPath = join(import.meta.dirname, "..", "docs", "NORMALIZATION-EVAL.runs.json");
let runs: Run[] = [];
try {
  runs = JSON.parse(await readFile(runsPath, "utf8")) as Run[];
} catch {
  /* first run */
}
runs.push({
  run_date: new Date().toISOString(),
  model_served: result.fingerprint?.model_served ?? "-",
  prompt_sha256: result.fingerprint?.prompt_sha256 ?? "-",
  ok: overall.ok,
  total: overall.total,
  note,
});
await writeFile(runsPath, `${JSON.stringify(runs, null, 2)}\n`, "utf8");

const historyTable = runs
  .map(
    (r) =>
      `| ${r.run_date.slice(0, 10)} | \`${r.model_served}\` | \`${r.prompt_sha256.slice(0, 12)}\` | ` +
      `${r.ok}/${r.total} (${pct(r.ok, r.total)}) | ${r.note || "-"} |`,
  )
  .join("\n");

// ── write the document ────────────────────────────────────────────────────
const fp = result.fingerprint;
const doc = `# NORMALIZATION-EVAL

Generated by \`npm run eval\`. **Never hand-edited, never tuned.**
Regenerate whenever the pipeline, the prompt or the provider changes.

## The number

**${overall.ok} / ${overall.total} field observations correct (${pct(overall.ok, overall.total)})**
across **${labelled.length} hand-labelled products** from a real merchant sheet.

At n=${overall.total} observations, treat this as an estimate. It is one
catalogue from one source, not a population.

${
  singleValued.length === 0
    ? ""
    : `**Measures nothing on this fixture:** ${singleValued.join(", ")}. A field with one
distinct label reads 100% regardless of what the pipeline does, and must not be
quoted as accuracy. Fixing this needs a second sheet from a different trade, not
more rows from this one.`
}

| Field | Correct | Accuracy |
|---|---|---|
${Object.entries(scores)
  .map(([f, s]) => `| \`${f}\` | ${s.ok}/${s.total} | ${pct(s.ok, s.total)} |`)
  .join("\n")}

## Review queue

${needsReview} of ${allVariants.length} variants need merchant review.

${Object.entries(flagCounts).sort((a, b) => b[1] - a[1]).map(([f, n]) => `- \`${f}\` — ${n}`).join("\n") || "- none"}

## Every failure

${misses.length === 0
  ? "None. At this sample size that means *no failures observed*, not *does not fail*."
  : misses
      .map(
        (m) =>
          `**row ${m.row} — \`${m.field}\`**\n` +
          `- sheet said: \`${m.raw}\`\n` +
          `- we produced: \`${m.got}\`\n` +
          `- expected: \`${m.want}\`\n`,
      )
      .join("\n")}

## Run history

Every run this fixture has produced, oldest first. A number that moved says more
than a number standing alone: it shows what the eval actually caught.

| Date | Model | Prompt | Score | What changed |
|---|---|---|---|---|
${historyTable}

## Run fingerprint

An accuracy number belongs to the run that produced it. The row above summarises
this run; here it is in full.

| Field | Value |
|---|---|
| provider | \`${fp?.provider ?? "—"}\` |
| conformance | \`${fp?.conformance ?? "—"}\` |
| model_requested | \`${fp?.model_requested ?? "—"}\` |
| model_served | \`${fp?.model_served ?? "—"}\` |
| prompt_sha256 | \`${fp?.prompt_sha256 ?? "—"}\` |
| latency | ${(result.latency_ms / 1000).toFixed(1)}s for ${rows.length} rows |
| rows in failed batches | ${result.failed.length} |
| run_date | ${new Date().toISOString()} |

If \`model_served\` or \`prompt_sha256\` differs from a previous run, this number
is not comparable to that one.

## Provenance

${Object.entries(labels.source).map(([k, v]) => `- **${k}**: ${v}`).join("\n")}

The sheet itself is not committed — \`fixtures/real-*\` is gitignored, per
DESIGN.md §9.
`;

await writeFile(join(import.meta.dirname, "..", "docs", "NORMALIZATION-EVAL.md"), doc, "utf8");

console.log(`\n${overall.ok}/${overall.total} (${pct(overall.ok, overall.total)}) across ${labelled.length} products`);
for (const [f, s] of Object.entries(scores)) console.log(`  ${f.padEnd(16)} ${s.ok}/${s.total}`);
console.log(`\n${misses.length} failures listed in docs/NORMALIZATION-EVAL.md`);
