/**
 * Upload -> job -> feed, as one callable unit.
 *
 * WHY THE RUN IS FIRE-AND-FORGET. Extraction takes minutes on a real catalogue
 * (PHASE-1.md §4a: ~5.5 min for 500 rows under a 5 requests/minute cap), so the
 * POST cannot wait for it. There is no queue and no worker process, which would
 * normally make "start it and return" a way to lose work.
 *
 * It is safe here only because resume is exactly-once (lib/ingest/job.ts). A
 * killed process leaves batches `pending`, never half-written; the next call
 * picks up exactly those and re-spends nothing. So the recovery mechanism for a
 * dropped run is *the same code path as the normal one*, which is a much
 * smaller thing to get right than a queue.
 *
 * The honest limit: this needs a long-lived server. On a serverless deploy the
 * function may be frozen the moment the response is returned, so progress stops
 * — and the fix is to POST again, which resumes. A real worker is the Phase 6
 * answer if the deployment target demands one.
 */
import ExcelJS from "exceljs";

import type { Sql } from "../db/sql.ts";
import { parseSheets } from "./parse.ts";
import type { ParsedSheet } from "./parse.ts";
import { assembleProducts, createJob, getProgress, runJob } from "./job.ts";
import type { JobProgress } from "./job.ts";
import { createExtractor } from "../normalize/llm.ts";
import type { ExtractFn } from "../normalize/llm.ts";
import { projectFeed } from "../feed/project.ts";
import { writeFeed } from "../feed/store.ts";

export async function parseUpload(bytes: ArrayBuffer): Promise<ParsedSheet[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes);
  return parseSheets(wb);
}

/** A merchant's feed id is derived from the merchant, so it is stable. */
export function feedIdFor(merchantId: string): string {
  return `feed_${merchantId.replace(/^mer_/, "")}`;
}

/**
 * Publishes whatever the job has successfully extracted so far.
 *
 * Deliberately callable on an INCOMPLETE job: if three batches of five
 * succeeded, those products are real and withholding them until the run
 * finishes helps nobody. Rows not yet read become flagged placeholders, which
 * is the same treatment they get on a failed batch.
 */
export async function publishFeed(
  sql: Sql,
  jobId: string,
  merchantId: string,
): Promise<{ served: number; withheld: number }> {
  const products = await assembleProducts(sql, jobId);
  const feed = projectFeed(products, {
    feedId: feedIdFor(merchantId),
    targetCountry: "IN",
  });
  await writeFeed(feed);
  return { served: feed.products.length, withheld: feed.withheld.length };
}

/**
 * Starts or resumes a job in the background and returns immediately.
 *
 * Errors are logged, not thrown: nothing is awaiting this, and an unhandled
 * rejection would take the server down for a batch failure the job record
 * already captured with a reason code.
 */
export function startRun(
  sql: Sql,
  jobId: string,
  merchantId: string,
  extract: ExtractFn = createExtractor(),
): void {
  void (async () => {
    try {
      await runJob(sql, jobId, extract);
      await publishFeed(sql, jobId, merchantId);
    } catch (error) {
      console.error(`[ingest] job ${jobId} run failed:`, error);
    }
  })();
}

export type IngestResult = { progress: JobProgress; resumed: boolean };

/**
 * The whole upload path. Idempotent by job id: re-uploading the same sheet
 * resumes rather than starting a second run.
 */
export async function ingestUpload(
  sql: Sql,
  input: {
    merchantId: string;
    sourceFile: string;
    bytes: ArrayBuffer;
    extract?: ExtractFn;
  },
): Promise<IngestResult> {
  const sheets = await parseUpload(input.bytes);
  const sheet = sheets[0];
  if (!sheet) throw new Error("the workbook has no sheets");

  const id = await createJob(sql, {
    merchantId: input.merchantId,
    sourceFile: input.sourceFile,
    sheet,
  });

  const before = await getProgress(sql, id);
  const resumed = before.rows_extracted > 0;

  if (before.status !== "complete") {
    startRun(sql, id, input.merchantId, input.extract);
  }

  return { progress: await getProgress(sql, id), resumed };
}
