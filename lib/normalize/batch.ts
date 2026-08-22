/**
 * Batching for catalogue-scale extraction.
 *
 * Measured, not guessed (scripts/latency.ts): extraction cost is dominated by
 * the CALL, not the row. Ten rows to a hundred is 10x the rows and 3.6x the
 * time — 1390ms/row at batch 10, 506ms/row at batch 100. So batch aggressively.
 *
 * Concurrency is the opposite lesson, and the measurement was blunt: the Gemini
 * free tier allows FIVE requests per minute per model. Four parallel calls
 * failed 200 of 500 rows; at concurrency 2 with a short backoff, all 500.
 *
 * Under a requests-per-minute cap the scarce resource is REQUESTS, not tokens
 * and not time. Parallelism does not help — it spends the same five requests
 * sooner and then waits anyway. So: batch as large as the output budget allows,
 * and issue the batches one at a time. Both levers point the same way.
 *
 * The ceiling on batch size is output tokens. Every row must be described in
 * the response, so a large enough batch truncates — and both providers surface
 * truncation as a thrown error rather than a short answer, so it fails loudly.
 */
import type { ExtractFn, ExtractionInput, Fingerprint } from "./llm.ts";
import type { RowExtraction } from "./llm-schema.ts";

/**
 * Defaults tuned to the measurement above, deliberately conservative on
 * concurrency because a 429 costs a whole batch and a merchant's upload is not
 * a place to be clever about rate limits.
 */
export const DEFAULT_BATCH_SIZE = 100;

/**
 * One. Not a placeholder — a rate limit of five requests per minute makes
 * concurrency actively counterproductive: it converts a queue into a burst of
 * 429s, and the retry then serialises them anyway, having wasted the attempts.
 * Raise this only against a paid tier, and re-measure rather than assume.
 */
export const DEFAULT_CONCURRENCY = 1;

export type BatchProgress = {
  batchesDone: number;
  batchesTotal: number;
  rowsDone: number;
  rowsTotal: number;
};

export type BatchOptions = {
  batchSize?: number;
  concurrency?: number;
  onProgress?: (progress: BatchProgress) => void;
};

export type BatchResult = {
  rows: RowExtraction[];
  /** Rows whose batch failed outright, with the reason. Never silently lost. */
  failed: Array<{ source_row: number; reason: string }>;
  fingerprint: Fingerprint | null;
  latency_ms: number;
};

export function chunk<T>(items: T[], size: number): T[][] {
  if (size < 1) throw new Error(`batch size must be >= 1, got ${size}`);
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Runs extraction over a whole catalogue.
 *
 * A failed batch does NOT abort the run and does not vanish. Its rows are
 * returned in `failed`, so the caller can flag them for review — the same rule
 * as everywhere else in this pipeline: an unreadable row becomes a visible
 * problem, never a missing product. `normalizeSheet` already turns a row with
 * no extraction into a fully flagged placeholder, so the two compose.
 */
export async function extractCatalogue(
  extract: ExtractFn,
  rows: ExtractionInput[],
  options: BatchOptions = {},
): Promise<BatchResult> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
  const batches = chunk(rows, batchSize);

  const collected: RowExtraction[] = [];
  const failed: BatchResult["failed"] = [];
  let fingerprint: Fingerprint | null = null;
  let batchesDone = 0;
  let rowsDone = 0;

  const started = Date.now();
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor++;
      const batch = batches[index];
      if (batch === undefined) return;

      try {
        const result = await extract(batch);
        collected.push(...result.batch.rows);
        fingerprint ??= result.fingerprint;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        for (const row of batch) failed.push({ source_row: row.source_row, reason });
      }

      batchesDone++;
      rowsDone += batch.length;
      options.onProgress?.({
        batchesDone,
        batchesTotal: batches.length,
        rowsDone,
        rowsTotal: rows.length,
      });
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, worker));

  return {
    rows: collected,
    failed,
    fingerprint,
    latency_ms: Date.now() - started,
  };
}
