/**
 * Provider bake-off: same schema, same rows, same prompt, both providers.
 *
 *   npm run bakeoff
 *
 * NOT the accuracy number. These labels are hand-written against SYNTHETIC
 * fixtures, so they measure which provider reads our own mess cases better —
 * a comparison, not a measurement. The number PHASE-1.md §5 asks for requires a
 * real merchant sheet and 50 hand-labelled products, and
 * docs/NORMALIZATION-EVAL.md stays empty until one exists. Do not let this
 * table migrate into that file.
 *
 * The rows are chosen to discriminate, not to flatter:
 *
 *   messy-05  merchant shorthand — `Blk RunShoe M-9` is a colour, a product and
 *             a size welded together, with the colour abbreviated.
 *   messy-07  Tamil script, and Tamil transliterated into Latin. This is where
 *             open-weight models are expected to be weakest and where the
 *             constrained-decoding advantage cannot help.
 */
import { join } from "node:path";

import { parseWorkbook } from "../lib/ingest/parse.ts";
import { semanticCells } from "../lib/ingest/fields.ts";
import { createExtractor, geminiProvider, groqProvider } from "../lib/normalize/llm.ts";
import type { Provider } from "../lib/normalize/llm.ts";
import type { RowExtraction } from "../lib/normalize/llm-schema.ts";

try {
  process.loadEnvFile();
} catch {
  /* provider key checks report it */
}

/**
 * Ground truth. `title` lists keywords that must ALL appear (case-insensitive);
 * everything else is a set of acceptable values, because more than one answer is
 * genuinely correct for some of these and scoring against one arbitrary phrasing
 * would measure agreement with me rather than correctness.
 */
type Label = {
  fixture: string;
  row: number;
  raw: string;
  title: string[];
  category: string[];
  colour?: string[];
  size?: string[];
  title_inferred: boolean;
};

const LABELS: Label[] = [
  // Merchant shorthand: colour + product + size in one cell.
  { fixture: "messy-05-title-attributes.xlsx", row: 2, raw: "Blk RunShoe M-9",
    title: ["running", "shoe"], category: ["footwear"],
    colour: ["black", "blk"], size: ["9", "m-9", "uk 9"], title_inferred: false },
  { fixture: "messy-05-title-attributes.xlsx", row: 3, raw: "Blk RunShoe M-10",
    title: ["running", "shoe"], category: ["footwear"],
    colour: ["black", "blk"], size: ["10", "m-10", "uk 10"], title_inferred: false },
  { fixture: "messy-05-title-attributes.xlsx", row: 4, raw: "Wht RunShoe M-9",
    title: ["running", "shoe"], category: ["footwear"],
    colour: ["white", "wht"], size: ["9", "m-9", "uk 9"], title_inferred: false },
  { fixture: "messy-05-title-attributes.xlsx", row: 5, raw: "Rd Snkr W-7",
    title: ["sneaker"], category: ["footwear"],
    colour: ["red", "rd"], size: ["7", "w-7", "uk 7"], title_inferred: false },
  { fixture: "messy-05-title-attributes.xlsx", row: 6, raw: "Brn LthrSandal M-8",
    title: ["sandal"], category: ["footwear"],
    colour: ["brown", "brn"], size: ["8", "m-8", "uk 8"], title_inferred: false },

  // Tamil script, then Tamil in Latin script.
  { fixture: "messy-07-multilingual.xlsx", row: 2, raw: "பருத்தி சேலை (cotton saree)",
    title: ["saree"], category: ["apparel"], title_inferred: false },
  { fixture: "messy-07-multilingual.xlsx", row: 3, raw: "பட்டு சேலை (silk saree)",
    title: ["saree"], category: ["apparel"], title_inferred: false },
  { fixture: "messy-07-multilingual.xlsx", row: 4, raw: "Paruthi Sattai (Cotton Shirt)",
    title: ["shirt"], category: ["apparel"], title_inferred: false },
  { fixture: "messy-07-multilingual.xlsx", row: 5, raw: "Vetti - Cotton (dhoti)",
    title: ["vetti", "veshti", "dhoti"], category: ["apparel"], title_inferred: false },
  { fixture: "messy-07-multilingual.xlsx", row: 6, raw: "Cotton Towel / துண்டு",
    title: ["towel"], category: ["home", "accessories", "apparel"], title_inferred: false },
];

const norm = (s: string) => s.toLowerCase().trim().replace(/\s+/g, " ");
const oneOf = (value: string | undefined, accepted: string[]) =>
  value !== undefined && accepted.some((a) => norm(a) === norm(value));
/** `title` is scored as keyword coverage — ANY listed keyword present passes. */
const titleOk = (title: string, keywords: string[]) =>
  keywords.some((k) => norm(title).includes(norm(k)));

const optionValue = (e: RowExtraction, names: string[]) => {
  for (const [k, v] of Object.entries(e.options)) {
    if (names.some((n) => norm(k) === n)) return v;
  }
  return undefined;
};

type Score = { field: string; ok: boolean; got: string; want: string };

function scoreRow(label: Label, e: RowExtraction | undefined): Score[] {
  if (!e) {
    return [{ field: "row", ok: false, got: "MISSING", want: "an entry" }];
  }
  const out: Score[] = [
    { field: "title", ok: titleOk(e.title, label.title), got: e.title, want: label.title.join("|") },
    { field: "category", ok: oneOf(e.category, label.category), got: e.category, want: label.category.join("|") },
    {
      field: "title_inferred",
      ok: e.title_inferred === label.title_inferred,
      got: String(e.title_inferred),
      want: String(label.title_inferred),
    },
  ];
  if (label.colour) {
    const got = optionValue(e, ["colour", "color"]);
    out.push({ field: "colour", ok: oneOf(got, label.colour), got: got ?? "—", want: label.colour.join("|") });
  }
  if (label.size) {
    const got = optionValue(e, ["size"]);
    out.push({ field: "size", ok: oneOf(got, label.size), got: got ?? "—", want: label.size.join("|") });
  }
  return out;
}

type Run = {
  provider: Provider;
  scores: Map<string, Score[]>;
  latency_ms: number;
  model_served: string;
  error: string | null;
  schemaViolation: boolean;
};

const byFixture = new Map<string, Label[]>();
for (const l of LABELS) {
  const list = byFixture.get(l.fixture) ?? [];
  list.push(l);
  byFixture.set(l.fixture, list);
}

const runs: Run[] = [];

const CONTENDERS: Provider[] = [
  groqProvider("openai/gpt-oss-120b"),
  // Qwen is worth a run of its own: open weights, but trained with far more
  // Asian-language data than gpt-oss, and the Indic rows are the discriminator.
  groqProvider("qwen/qwen3.6-27b"),
  geminiProvider(),
];

for (const provider of CONTENDERS) {
  const run: Run = {
    provider,
    scores: new Map(),
    latency_ms: 0,
    model_served: "",
    error: null,
    schemaViolation: false,
  };
  const extract = createExtractor(provider);

  for (const [fixture, labels] of byFixture) {
    const [sheet] = await parseWorkbook(join(import.meta.dirname, "..", "fixtures", fixture));
    if (!sheet) continue;

    const rows = sheet.rows
      .filter((r) => labels.some((l) => l.row === r.row))
      .map((r) => ({ source_row: r.row, cells: semanticCells(r.cells, sheet.headers) }));

    try {
      const result = await extract(rows);
      run.latency_ms += result.latency_ms;
      run.model_served = result.fingerprint.model_served;
      const byRow = new Map(result.batch.rows.map((r) => [r.source_row, r]));
      for (const label of labels) {
        run.scores.set(`${fixture}#${label.row}`, scoreRow(label, byRow.get(label.row)));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      run.error = message;
      // The axis the bake-off exists to weigh: did the wire shape hold?
      if (/schema validation|not valid JSON/.test(message)) run.schemaViolation = true;
      for (const label of labels) {
        run.scores.set(`${fixture}#${label.row}`, [
          { field: "row", ok: false, got: "ERROR", want: "an entry" },
        ]);
      }
    }
  }

  runs.push(run);
}

// ── report ────────────────────────────────────────────────────────────────
const FIELDS = ["title", "category", "title_inferred", "colour", "size"];

console.log("\nPER-FIELD ACCURACY\n");
console.log(
  ["field".padEnd(16), ...runs.map((r) => r.provider.model.split("/").pop()!.slice(0,13).padEnd(14))].join(""),
);
for (const field of FIELDS) {
  const cells = runs.map((run) => {
    let ok = 0;
    let total = 0;
    for (const scores of run.scores.values()) {
      for (const s of scores) {
        if (s.field !== field) continue;
        total++;
        if (s.ok) ok++;
      }
    }
    return total === 0 ? "—".padEnd(14) : `${ok}/${total}`.padEnd(14);
  });
  console.log([field.padEnd(16), ...cells].join(""));
}

const overall = runs.map((run) => {
  let ok = 0;
  let total = 0;
  for (const scores of run.scores.values()) {
    for (const s of scores) {
      total++;
      if (s.ok) ok++;
    }
  }
  return { run, ok, total, pct: total === 0 ? 0 : Math.round((ok / total) * 100) };
});

console.log("");
console.log(["overall".padEnd(16), ...overall.map((o) => `${o.ok}/${o.total} (${o.pct}%)`.padEnd(14))].join(""));
console.log(["latency".padEnd(16), ...runs.map((r) => `${r.latency_ms}ms`.padEnd(14))].join(""));
console.log(["conformance".padEnd(16), ...runs.map((r) => r.provider.conformance.padEnd(14))].join(""));
console.log(["schema break".padEnd(16), ...runs.map((r) => String(r.schemaViolation).padEnd(14))].join(""));
console.log(["served by".padEnd(16), ...runs.map((r) => (r.model_served || "—").padEnd(14))].join(""));

console.log("\nDISAGREEMENTS AND MISSES\n");
for (const key of runs[0]?.scores.keys() ?? []) {
  const label = LABELS.find((l) => `${l.fixture}#${l.row}` === key);
  const lines: string[] = [];
  for (const run of runs) {
    for (const s of run.scores.get(key) ?? []) {
      if (!s.ok) lines.push(`    ${run.provider.model.split("/").pop()!.slice(0,13).padEnd(14)} ${s.field}: got ${JSON.stringify(s.got)}, want ${s.want}`);
    }
  }
  if (lines.length > 0) {
    console.log(`  ${label?.raw ?? key}`);
    console.log(lines.join("\n"));
  }
}

for (const run of runs) {
  if (run.error) console.log(`\n! ${run.provider.id} errored: ${run.error}`);
}
