/**
 * Ingest job lifecycle: create, run, resume. PHASE-1.md §4a.
 *
 * EXACTLY-ONCE AT BATCH GRANULARITY, and precisely what that means here:
 *
 * Exactly-once *execution* is not achievable — a process can die between the
 * provider returning and the write landing, and no amount of care changes that.
 * What is achievable, and what this implements, is exactly-once *effect*:
 *
 *   1. A batch's extractions and its `done` marker are written in ONE
 *      transaction. There is no state in which some rows of a batch are stored
 *      and the batch is not marked done, or vice versa. A crash mid-write rolls
 *      back to "batch pending, no rows stored".
 *   2. Resume selects batches where `status <> 'done'`. A completed batch is
 *      never re-run, so its API call is never re-spent — under a 5 requests per
 *      minute cap, requests are the only currency there is.
 *   3. The stored unit is the EXTRACTION, not the product. Extraction is
 *      non-deterministic; product assembly from a stored extraction is pure. So
 *      a resumed job cannot produce a different `variant_group`, and therefore
 *      cannot produce different product or variant ids for rows it already
 *      read. Since `Variant.id` is the ACP checkout `items[].id`, that is a
 *      correctness property and not a tidiness one.
 *
 * The failure mode this rules out is the nasty one: a resume that re-extracts
 * a completed batch, gets a slightly different reading, and silently emits a
 * SECOND product for the same sheet row under a new id.
 */
import { createHash } from "node:crypto";

import type { Sql } from "../db/sql.ts";
import type { ParsedSheet } from "./parse.ts";
import { semanticCells } from "./fields.ts";
import { chunk, DEFAULT_BATCH_SIZE } from "../normalize/batch.ts";
import type { ExtractFn, ExtractionInput, Fingerprint } from "../normalize/llm.ts";
import type { RowExtraction } from "../normalize/llm-schema.ts";
import { normalizeSheet } from "../normalize/normalize.ts";
import type { Product } from "../normalize/schema.ts";

export type JobStatus = "pending" | "running" | "complete" | "failed";
export type BatchStatus = "pending" | "running" | "done" | "failed";

/**
 * How long a claimed batch may sit before another runner may take it.
 *
 * Longer than any real batch — a 100-row call is ~50s, and retry can wait out a
 * 60s rate-limit window on top. Too short and two runners work the same batch,
 * which is the thing claiming exists to prevent.
 */
export const CLAIM_TIMEOUT_MS = 15 * 60 * 1000;

export type JobProgress = {
  id: string;
  merchant_id: string;
  source_file: string;
  status: JobStatus;
  rows_total: number;
  rows_extracted: number;
  batches_total: number;
  batches_done: number;
  batches_failed: number;
  /** Failed batches with their reason. Never a bare count. */
  failures: Array<{ batch_index: number; reason_code: string; reason_human: string }>;
  fingerprint: Partial<Fingerprint>;
  created_at: string;
  updated_at: string;
};

/**
 * Job ids are content-derived, so uploading the same file twice for the same
 * merchant resumes rather than starting a parallel duplicate run. A random id
 * would make double-submission — a refresh, a retried request — silently cost a
 * second full catalogue of API calls.
 */
export function jobId(merchantId: string, sourceFile: string, rowCount: number): string {
  const hash = createHash("sha256")
    .update([merchantId, sourceFile, String(rowCount)].join(" "))
    .digest("hex");
  return `job_${hash.slice(0, 16)}`;
}

export type CreateJobInput = {
  merchantId: string;
  sourceFile: string;
  sheet: ParsedSheet;
  batchSize?: number;
};

/**
 * Records the job and every row of the sheet. Idempotent: creating the same job
 * twice leaves the first one and its progress untouched.
 */
export async function createJob(sql: Sql, input: CreateJobInput): Promise<string> {
  const { merchantId, sourceFile, sheet } = input;
  const batchSize = input.batchSize ?? DEFAULT_BATCH_SIZE;
  const id = jobId(merchantId, sourceFile, sheet.rows.length);

  const batches = chunk(sheet.rows, batchSize);

  await sql.transaction(async (tx) => {
    const { rows: existing } = await tx.query(
      `insert into ingest_job
         (id, merchant_id, source_file, status, rows_total, batch_size,
          sheet_name, headers)
       values ($1, $2, $3, 'pending', $4, $5, $6, $7)
       on conflict (id) do nothing
       returning id`,
      [
        id, merchantId, sourceFile, sheet.rows.length, batchSize,
        sheet.name, JSON.stringify(sheet.headers),
      ],
    );
    // Already exists — leave its rows and batch state alone. Re-inserting would
    // reset extractions and throw away work already paid for.
    if (existing.length === 0) return;

    for (const [batchIndex, batch] of batches.entries()) {
      await tx.query(
        `insert into ingest_batch (job_id, batch_index, status) values ($1, $2, 'pending')`,
        [id, batchIndex],
      );
      for (const row of batch) {
        await tx.query(
          `insert into ingest_row
             (job_id, source_row, sheet, batch_index, semantic_cells, raw_cells)
           values ($1, $2, $3, $4, $5, $6)`,
          [
            id,
            row.row,
            row.sheet,
            batchIndex,
            JSON.stringify(semanticCells(row.cells, sheet.headers)),
            JSON.stringify(row.cells),
          ],
        );
      }
    }
  });

  return id;
}

type PendingBatch = { batch_index: number; rows: ExtractionInput[] };

/** Batch indexes still owed work. A `done` batch never appears here. */
async function claimableIndexes(sql: Sql, id: string): Promise<number[]> {
  const { rows } = await sql.query<{ batch_index: number }>(
    `select batch_index from ingest_batch
      where job_id = $1
        and (status in ('pending', 'failed')
             or (status = 'running' and claimed_at < now() - ($2 || ' milliseconds')::interval))
      order by batch_index`,
    [id, String(CLAIM_TIMEOUT_MS)],
  );
  return rows.map((r) => r.batch_index);
}

/**
 * Takes exclusive ownership of a batch, or returns null if another runner has
 * it.
 *
 * The whole mechanism is one conditional UPDATE. Postgres serialises the row
 * write, so of two concurrent runners exactly one gets a row back — no lock
 * table, no advisory lock, no queue. The stale-claim clause is what stops a
 * crashed runner parking a batch forever.
 */
async function claimBatch(
  sql: Sql,
  id: string,
  batchIndex: number,
): Promise<PendingBatch | null> {
  const { rows: claimed } = await sql.query<{ batch_index: number }>(
    `update ingest_batch
        set status = 'running', claimed_at = now(),
            -- A batch being retried carries no CURRENT failure. Leaving the
            -- previous attempt's reason attached would both violate
            -- only_failed_has_reason and, worse, leave the audit trail
            -- asserting a live failure that is no longer true.
            reason_code = null, reason_human = null
      where job_id = $1 and batch_index = $2
        and (status in ('pending', 'failed')
             or (status = 'running' and claimed_at < now() - ($3 || ' milliseconds')::interval))
      returning batch_index`,
    [id, batchIndex, String(CLAIM_TIMEOUT_MS)],
  );
  if (claimed.length === 0) return null;

  const { rows } = await sql.query<{
    source_row: number;
    semantic_cells: Record<string, string>;
  }>(
    `select source_row, semantic_cells from ingest_row
      where job_id = $1 and batch_index = $2 and extraction is null
      order by source_row`,
    [id, batchIndex],
  );

  return { batch_index: batchIndex, rows: rows.map((r) => ({
    source_row: r.source_row,
    cells: r.semantic_cells,
  })) };
}

export type RunOptions = {
  onProgress?: (progress: JobProgress) => void;
};

/**
 * AWAITING THIS IS NOT AWAITING THE JOB. `runJob` returns when there is
 * nothing left IT CAN CLAIM, which is not the same as the job being finished:
 * if another runner holds the remaining batches, this returns immediately with
 * the job still in flight. Correct for a claim-based runner, and a trap for
 * callers.
 *
 * It cost a real half hour. `ingestUpload` starts a run in the background, so
 * `await ingestUpload(...)` then `await runJob(...)` returns while the
 * background runner is still extracting — and `publishFeed` published a feed
 * from a job that had extracted nothing: 78 rows in, 0 served, 78 withheld, no
 * error anywhere, because publishing a partly-extracted job is deliberately
 * allowed. A caller that needs COMPLETION must poll `getProgress` until
 * `rows_extracted === rows_total`. Nothing here can express that for it,
 * because "done" is a property of the job and not of any one runner.
 *
 * Runs or resumes a job. Safe to call repeatedly: it only ever works on batches
 * that are not yet done.
 *
 * A failed batch does not abort the run — the remaining batches still go, and
 * the failure is recorded with a reason so those rows surface as flagged
 * products rather than missing ones. Calling `runJob` again retries exactly the
 * failed batches.
 */
export async function runJob(
  sql: Sql,
  id: string,
  extract: ExtractFn,
  options: RunOptions = {},
): Promise<JobProgress> {
  await sql.query(
    // The reason columns are cleared with the status, not separately. A job
    // being retried carries no CURRENT failure, and leaving the previous
    // attempt's reason attached would make the record assert a live failure
    // that is no longer true. `job_only_failed_has_reason` enforces it.
    `update ingest_job
        set status = 'running', updated_at = now(),
            reason_code = null, reason_human = null
      where id = $1`,
    [id],
  );

  for (const batchIndex of await claimableIndexes(sql, id)) {
    const batch = await claimBatch(sql, id, batchIndex);
    // Another runner has it. Not an error — the endpoint is idempotent and a
    // double submission is expected to produce a second runner.
    if (batch === null) continue;
    // Every row already read. Mark it done rather than calling the provider
    // with an empty batch.
    if (batch.rows.length === 0) {
      await sql.query(
        `update ingest_batch set status = 'done', completed_at = now(),
                reason_code = null, reason_human = null
          where job_id = $1 and batch_index = $2`,
        [id, batchIndex],
      );
      continue;
    }

    try {
      const result = await extract(batch.rows);

      // One transaction: extractions AND the done marker, or neither. This is
      // the atomicity the exactly-once claim rests on.
      await sql.transaction(async (tx) => {
        for (const extraction of result.batch.rows) {
          await tx.query(
            `update ingest_row set extraction = $3
              where job_id = $1 and source_row = $2`,
            [id, extraction.source_row, JSON.stringify(extraction)],
          );
        }
        await tx.query(
          `update ingest_batch
              set status = 'done', completed_at = now(),
                  attempts = attempts + 1, reason_code = null, reason_human = null
            where job_id = $1 and batch_index = $2`,
          [id, batch.batch_index],
        );
        await tx.query(
          `update ingest_job
              set provider = coalesce(provider, $2),
                  model_requested = coalesce(model_requested, $3),
                  model_served = coalesce(model_served, $4),
                  prompt_sha256 = coalesce(prompt_sha256, $5),
                  updated_at = now()
            where id = $1`,
          [
            id,
            result.fingerprint.provider,
            result.fingerprint.model_requested,
            result.fingerprint.model_served,
            result.fingerprint.prompt_sha256,
          ],
        );
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await sql.query(
        `update ingest_batch
            set status = 'failed', attempts = attempts + 1,
                reason_code = $3, reason_human = $4
          where job_id = $1 and batch_index = $2`,
        // Machine code plus human string, per CLAUDE.md invariant 3. The code
        // is coarse on purpose: it says what class of thing went wrong, and the
        // human string carries the provider's own words.
        [id, batch.batch_index, classify(reason), reason.slice(0, 500)],
      );
    }

    if (options.onProgress) options.onProgress(await getProgress(sql, id));
  }

  const progress = await getProgress(sql, id);
  const status: JobStatus = progress.batches_failed > 0 ? "failed" : "complete";
  await sql.query(
    `update ingest_job
        set status = $2, updated_at = now(),
            reason_code = $3, reason_human = $4
      where id = $1`,
    [
      id,
      status,
      status === "failed" ? "INGEST_BATCHES_FAILED" : null,
      status === "failed"
        ? `${progress.batches_failed} of ${progress.batches_total} batches failed; ` +
          `${progress.rows_total - progress.rows_extracted} rows unread`
        : null,
    ],
  );

  return { ...progress, status };
}

/** Coarse, stable reason codes. The detail lives in the human string. */
function classify(message: string): string {
  if (/429|quota|rate limit/i.test(message)) return "PROVIDER_RATE_LIMITED";
  if (/schema validation|not valid JSON/i.test(message)) return "EXTRACTION_MALFORMED";
  if (/truncated|MAX_TOKENS|finish_reason=length/i.test(message)) return "EXTRACTION_TRUNCATED";
  if (/blocked|refus/i.test(message)) return "PROVIDER_REFUSED";
  return "PROVIDER_ERROR";
}

export async function getProgress(sql: Sql, id: string): Promise<JobProgress> {
  const { rows: jobs } = await sql.query<Record<string, never>>(
    `select * from ingest_job where id = $1`,
    [id],
  );
  const job = jobs[0] as Record<string, unknown> | undefined;
  if (!job) throw new Error(`no such job: ${id}`);

  const { rows: counts } = await sql.query<{
    rows_extracted: string;
    batches_total: string;
    batches_done: string;
    batches_failed: string;
  }>(
    `select
       (select count(*) from ingest_row   where job_id = $1 and extraction is not null) as rows_extracted,
       (select count(*) from ingest_batch where job_id = $1)                            as batches_total,
       (select count(*) from ingest_batch where job_id = $1 and status = 'done')        as batches_done,
       (select count(*) from ingest_batch where job_id = $1 and status = 'failed')      as batches_failed`,
    [id],
  );
  const c = counts[0]!;

  const { rows: failures } = await sql.query<{
    batch_index: number;
    reason_code: string;
    reason_human: string;
  }>(
    `select batch_index, reason_code, reason_human
       from ingest_batch
      where job_id = $1 and status = 'failed'
      order by batch_index`,
    [id],
  );

  return {
    id: String(job["id"]),
    merchant_id: String(job["merchant_id"]),
    source_file: String(job["source_file"]),
    status: job["status"] as JobStatus,
    rows_total: Number(job["rows_total"]),
    rows_extracted: Number(c.rows_extracted),
    batches_total: Number(c.batches_total),
    batches_done: Number(c.batches_done),
    batches_failed: Number(c.batches_failed),
    failures,
    fingerprint: {
      provider: (job["provider"] as string | null) ?? undefined,
      model_requested: (job["model_requested"] as string | null) ?? undefined,
      model_served: (job["model_served"] as string | null) ?? undefined,
      prompt_sha256: (job["prompt_sha256"] as string | null) ?? undefined,
    },
    created_at: new Date(job["created_at"] as string).toISOString(),
    updated_at: new Date(job["updated_at"] as string).toISOString(),
  };
}

/**
 * Assembles products from whatever has been extracted so far.
 *
 * Reads EVERYTHING from the database — extractions, raw cells, sheet headers —
 * so a job can be finished by a process that never saw the uploaded file. That
 * is what makes resumability real rather than nominal.
 *
 * Pure with respect to the database: same stored rows in, same products out,
 * every time. Rows whose batch failed have no extraction, so `normalizeSheet`
 * turns them into fully flagged placeholders — a row that could not be read
 * becomes a visible problem in review, never a missing product.
 */
export async function assembleProducts(sql: Sql, id: string): Promise<Product[]> {
  const { rows: jobs } = await sql.query<{
    merchant_id: string;
    source_file: string;
    sheet_name: string | null;
    headers: string[] | null;
  }>(
    `select merchant_id, source_file, sheet_name, headers
       from ingest_job where id = $1`,
    [id],
  );
  const job = jobs[0];
  if (!job) throw new Error(`no such job: ${id}`);

  const { rows } = await sql.query<{
    source_row: number;
    sheet: string;
    raw_cells: Record<string, string>;
    extraction: RowExtraction | null;
  }>(
    `select source_row, sheet, raw_cells, extraction
       from ingest_row where job_id = $1 order by source_row`,
    [id],
  );

  // Rebuild just enough ParsedSheet for normalizeSheet: it reads `headers` to
  // find the price and stock columns, and each row's number and cells.
  const sheet: ParsedSheet = {
    name: job.sheet_name ?? rows[0]?.sheet ?? "",
    headerRow: null,
    headers: job.headers ?? [],
    headerScore: 0,
    rows: rows.map((r) => ({
      sheet: r.sheet,
      row: r.source_row,
      cells: r.raw_cells,
      values: Object.values(r.raw_cells),
      inherited: {},
    })),
    skipped: [],
  };

  return normalizeSheet(
    sheet,
    rows.map((r) => r.extraction).filter((e): e is RowExtraction => e !== null),
    { merchantId: job.merchant_id, sourceFile: job.source_file },
  );
}
