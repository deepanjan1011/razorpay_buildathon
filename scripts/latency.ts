/**
 * How long does normalization actually take at catalogue scale?
 *
 *   npm run latency            # batch-size sweep, then a full 500-row run
 *   npm run latency -- 200     # different catalogue size
 *
 * The upload flow cannot be designed without this. If the cost is per row, a
 * 500-row sheet is an overnight job and the UI needs a queue and a progress
 * model. If it is per call, the same sheet is a handful of requests and the UI
 * can just wait. Guessing which would mean designing the wrong thing twice.
 *
 * Rows are synthetic and generated here rather than committed: this measures
 * throughput, not accuracy, and shipping a 500-row fixture to measure wall-clock
 * would be a large binary file that asserts nothing.
 */
import { createExtractor, defaultProvider } from "../lib/normalize/llm.ts";
import type { ExtractionInput } from "../lib/normalize/llm.ts";
import {
  DEFAULT_BATCH_SIZE,
  DEFAULT_CONCURRENCY,
  extractCatalogue,
} from "../lib/normalize/batch.ts";

try {
  process.loadEnvFile();
} catch {
  /* provider key check reports it */
}

const TOTAL = Number(process.argv[2] ?? 500);

// Shaped like the fixtures: merchant shorthand, mixed script, embedded options.
const PRODUCTS = [
  "Blk RunShoe M-", "Wht Snkr W-", "Brn LthrSandal M-", "Canvas Shoe White ",
  "Cotton Kurta Blue ", "Silk Saree Green ", "Steel Tiffin Box ", "Copper Bottle ",
  "பருத்தி சேலை ", "Paruthi Sattai ", "Vetti Cotton ", "Kolhapuri Chappal ",
  "Leather Belt Black ", "Plain Tee White ", "Linen Trouser Beige ",
];

function makeRows(n: number): ExtractionInput[] {
  return Array.from({ length: n }, (_, i) => ({
    source_row: i + 2,
    cells: { Item: `${PRODUCTS[i % PRODUCTS.length]}${(i % 12) + 5}` },
  }));
}

const provider = defaultProvider();
const extract = createExtractor(provider);

console.log(`provider: ${provider.id} (${provider.model}, ${provider.conformance})`);
console.log(`catalogue: ${TOTAL} rows\n`);

// ── 1. batch-size sweep ───────────────────────────────────────────────────
console.log("BATCH SIZE SWEEP  (one call each)\n");
console.log(
  ["rows".padEnd(8), "ms".padEnd(10), "ms/row".padEnd(10), "returned".padEnd(10), "out tok"].join(""),
);

type Sweep = { size: number; ms: number; perRow: number };
const sweeps: Sweep[] = [];

for (const size of [10, 25, 50, 100]) {
  if (size > TOTAL) break;
  try {
    const result = await extract(makeRows(size));
    const perRow = result.latency_ms / size;
    sweeps.push({ size, ms: result.latency_ms, perRow });
    const outTok =
      (result.usage?.["candidatesTokenCount"] as number | undefined) ??
      (result.usage?.["completion_tokens"] as number | undefined) ??
      0;
    console.log(
      [
        String(size).padEnd(8),
        String(result.latency_ms).padEnd(10),
        perRow.toFixed(0).padEnd(10),
        `${result.batch.rows.length}/${size}`.padEnd(10),
        String(outTok),
      ].join(""),
    );
  } catch (error) {
    console.log(
      [String(size).padEnd(8), "FAILED".padEnd(10), "".padEnd(10), "".padEnd(10)].join("") +
        (error instanceof Error ? error.message.slice(0, 90) : ""),
    );
  }
}

// ── 2. verdict ────────────────────────────────────────────────────────────
console.log("");
if (sweeps.length >= 2) {
  const first = sweeps[0]!;
  const last = sweeps[sweeps.length - 1]!;
  const rowRatio = last.size / first.size;
  const timeRatio = last.ms / first.ms;
  // Per-row cost would mean time scales with rows. Per-call cost would mean it
  // barely moves. The ratio of ratios separates them without hand-waving.
  const scaling = timeRatio / rowRatio;
  console.log(
    `scaling: ${first.size}→${last.size} rows is ${rowRatio.toFixed(1)}x rows ` +
      `and ${timeRatio.toFixed(1)}x time (factor ${scaling.toFixed(2)})`,
  );
  console.log(
    scaling < 0.5
      ? "  → dominated by PER-CALL cost. Batch aggressively."
      : scaling > 0.8
        ? "  → close to PER-ROW cost. Batching buys little; parallelism is the lever."
        : "  → mixed. Batch, and parallelise across batches.",
  );
  const best = sweeps.reduce((a, b) => (a.perRow <= b.perRow ? a : b));
  console.log(`  → cheapest per row at batch size ${best.size} (${best.perRow.toFixed(0)}ms/row)`);
  console.log(
    `  → naive ${TOTAL} rows at that size, sequential: ` +
      `${((TOTAL / best.size) * best.ms / 1000).toFixed(0)}s`,
  );
}

// ── 3. full catalogue, through the real batching path ─────────────────────
const BATCH = Number(process.env["LATENCY_BATCH"] ?? DEFAULT_BATCH_SIZE);
const CONCURRENCY = Number(process.env["LATENCY_CONCURRENCY"] ?? DEFAULT_CONCURRENCY);

console.log(`\nFULL RUN  ${TOTAL} rows via extractCatalogue, batch ${BATCH}, concurrency ${CONCURRENCY}\n`);

const result = await extractCatalogue(extract, makeRows(TOTAL), {
  batchSize: BATCH,
  concurrency: CONCURRENCY,
  onProgress: (p) =>
    console.log(`  batch ${p.batchesDone}/${p.batchesTotal}  (${p.rowsDone}/${p.rowsTotal} rows)`),
});

console.log(`\nwall clock: ${(result.latency_ms / 1000).toFixed(1)}s for ${TOTAL} rows`);
console.log(`rows returned: ${result.rows.length}/${TOTAL}`);
console.log(`rows in failed batches: ${result.failed.length}`);
console.log(`throughput: ${(TOTAL / (result.latency_ms / 1000)).toFixed(1)} rows/s`);
console.log(`per row: ${(result.latency_ms / TOTAL).toFixed(0)}ms`);

const reasons = new Map<string, number>();
for (const f of result.failed) reasons.set(f.reason.slice(0, 80), (reasons.get(f.reason.slice(0, 80)) ?? 0) + 1);
for (const [reason, count] of reasons) console.log(`  ${count} rows: ${reason}`);
