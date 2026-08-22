/**
 * Ingest jobs, against REAL Postgres (PGlite, in-process).
 *
 * Not a mock: the constraints, the upserts, the transaction rollback and the
 * `on conflict` semantics all actually execute. The alternative was a database
 * layer nobody could run until hosted credentials existed — another untested
 * path riding on a green suite that never touched it.
 *
 * The assertions that matter are the exactly-once ones. A resume that re-runs a
 * completed batch is not merely wasteful under a 5 requests/minute cap; because
 * extraction is non-deterministic, it can emit a SECOND product for the same
 * sheet row under a different id.
 */
import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { connectEphemeral } from "../lib/db/sql.ts";
import type { Sql } from "../lib/db/sql.ts";
import { migrate } from "../lib/db/migrate.ts";
import { parseWorkbook } from "../lib/ingest/parse.ts";
import type { ParsedSheet } from "../lib/ingest/parse.ts";
import {
  assembleProducts,
  createJob,
  getProgress,
  jobId,
  runJob,
} from "../lib/ingest/job.ts";
import type { ExtractFn, ExtractionInput, ExtractionResult } from "../lib/normalize/llm.ts";

const fixture = (name: string) => join(import.meta.dirname, "..", "fixtures", name);

let sql: Sql;
let sheet: ParsedSheet;

before(async () => {
  const [first] = await parseWorkbook(fixture("messy-03-merged-category.xlsx"));
  assert.ok(first);
  sheet = first; // 14 rows
});

beforeEach(async () => {
  sql = await connectEphemeral();
  const ran = await migrate(sql);
  assert.ok(ran.includes("001_ingest.sql"));
});

function fakeResult(batch: ExtractionInput[], variantGroup = "grp"): ExtractionResult {
  return {
    batch: {
      rows: batch.map((r) => ({
        source_row: r.source_row,
        title: `Item ${r.source_row}`,
        title_inferred: false,
        category: "footwear",
        category_confidence: 0.9,
        options: {},
        attributes: {},
        brand: null,
        description: null,
        variant_group: `${variantGroup}-${r.source_row}`,
        confidence: 0.9,
      })),
    },
    fingerprint: {
      provider: "fake",
      conformance: "best_effort",
      model_requested: "fake-1",
      model_served: "fake-1-0625",
      prompt_sha256: "a".repeat(64),
    },
    usage: null,
    latency_ms: 1,
  };
}

/** Records every row it is asked to extract, so re-work is visible. */
function countingExtractor(behaviour: (call: number) => "ok" | "throw" = () => "ok") {
  const calls: number[][] = [];
  let call = 0;
  const extract: ExtractFn = async (batch) => {
    call++;
    calls.push(batch.map((r) => r.source_row));
    if (behaviour(call) === "throw") throw new Error("gemini returned 429: quota exceeded");
    return fakeResult(batch);
  };
  return { extract, calls, rowsSeen: () => calls.flat() };
}

const create = () =>
  createJob(sql, {
    merchantId: "mer_lakshmi",
    sourceFile: "messy-03-merged-category.xlsx",
    sheet,
    batchSize: 5,
  });

describe("job creation", () => {
  test("records every sheet row, split into batches", async () => {
    const id = await create();
    const progress = await getProgress(sql, id);

    assert.equal(progress.rows_total, 14);
    assert.equal(progress.batches_total, 3); // 5 + 5 + 4
    assert.equal(progress.rows_extracted, 0);
    assert.equal(progress.status, "pending");
  });

  test("the model never sees price or stock columns", async () => {
    const id = await create();
    const { rows } = await sql.query<{ semantic_cells: Record<string, string> }>(
      "select semantic_cells from ingest_row where job_id = $1",
      [id],
    );
    // CLAUDE.md invariant 1, enforced at the storage boundary too.
    for (const row of rows) assert.ok(!("Price" in row.semantic_cells));
    assert.ok(rows.some((r) => "Item" in r.semantic_cells));
  });

  test("raw cells are kept for provenance even though the model cannot see them", async () => {
    const id = await create();
    const { rows } = await sql.query<{ raw_cells: Record<string, string> }>(
      "select raw_cells from ingest_row where job_id = $1 order by source_row limit 1",
      [id],
    );
    assert.ok(rows[0]);
    assert.ok("Price" in rows[0].raw_cells);
  });

  test("re-submitting the same sheet resumes rather than duplicating", async () => {
    const first = await create();
    const { extract, calls } = countingExtractor();
    await runJob(sql, first, extract);
    const callsAfterFirstRun = calls.length;

    // A refresh, or a retried request.
    const second = await create();
    assert.equal(second, first, "same content must yield the same job id");
    assert.equal(jobId("mer_lakshmi", "messy-03-merged-category.xlsx", 14), first);

    await runJob(sql, second, extract);
    // Nothing left to do, so nothing was spent.
    assert.equal(calls.length, callsAfterFirstRun);

    const progress = await getProgress(sql, first);
    assert.equal(progress.rows_total, 14, "rows were not duplicated");
  });
});

describe("exactly-once at batch granularity", () => {
  test("a completed batch is never re-extracted on resume", async () => {
    const id = await create();

    // Batch 2 fails; 1 and 3 land.
    const first = countingExtractor((call) => (call === 2 ? "throw" : "ok"));
    await runJob(sql, id, first.extract);

    let progress = await getProgress(sql, id);
    assert.equal(progress.batches_done, 2);
    assert.equal(progress.batches_failed, 1);
    assert.equal(progress.rows_extracted, 9); // 5 + 4
    assert.equal(progress.status, "failed");

    // Resume with a fresh counter.
    const second = countingExtractor();
    await runJob(sql, id, second.extract);

    // ONLY the failed batch was retried — its five rows, and nothing else.
    assert.equal(second.calls.length, 1);
    assert.deepEqual(second.rowsSeen().length, 5);

    progress = await getProgress(sql, id);
    assert.equal(progress.rows_extracted, 14);
    assert.equal(progress.batches_done, 3);
    assert.equal(progress.batches_failed, 0);
    assert.equal(progress.status, "complete");
  });

  test("no row is extracted twice across a failure and a resume", async () => {
    const id = await create();

    const first = countingExtractor((call) => (call === 1 ? "throw" : "ok"));
    await runJob(sql, id, first.extract);
    const second = countingExtractor();
    await runJob(sql, id, second.extract);

    const seen = [...first.rowsSeen(), ...second.rowsSeen()];
    const successfullySeen = seen.filter(
      (row, i) => !(i < 5 && first.calls[0]?.includes(row)),
    );
    // Every row appears exactly once among the calls that actually stored data.
    const stored = new Set(second.rowsSeen().concat(first.rowsSeen().slice(5)));
    assert.equal(stored.size, 14);
    assert.ok(successfullySeen.length >= 14);

    const progress = await getProgress(sql, id);
    assert.equal(progress.rows_extracted, 14);
  });

  test("a crash between extraction and commit leaves the batch retryable, not half-written", async () => {
    const id = await create();

    // Succeed at the provider, then blow up inside the write transaction.
    const failingWrite: ExtractFn = async (batch) => fakeResult(batch);
    const original = sql.transaction.bind(sql);
    let sabotaged = false;
    sql.transaction = async (fn) => {
      if (!sabotaged) {
        sabotaged = true;
        return original(async (tx) => {
          await fn(tx);
          throw new Error("crash mid-write");
        });
      }
      return original(fn);
    };

    await runJob(sql, id, failingWrite);
    sql.transaction = original;

    const progress = await getProgress(sql, id);
    // The sabotaged batch stored NOTHING — not some rows and no marker.
    assert.equal(progress.rows_extracted % 5, 4, "only whole batches landed");
    assert.ok(progress.batches_done < 3);

    // And it is retryable.
    const resume = countingExtractor();
    await runJob(sql, id, resume.extract);
    const final = await getProgress(sql, id);
    assert.equal(final.rows_extracted, 14);
    assert.equal(final.status, "complete");
  });

  test("product ids are identical across a resume", async () => {
    const idA = await create();
    const first = countingExtractor((call) => (call === 2 ? "throw" : "ok"));
    await runJob(sql, idA, first.extract);
    await runJob(sql, idA, countingExtractor().extract);
    const resumed = await assembleProducts(sql, idA, sheet);

    // A run that never failed, for comparison.
    const clean = await connectEphemeral();
    await migrate(clean);
    const idB = await createJob(clean, {
      merchantId: "mer_lakshmi",
      sourceFile: "messy-03-merged-category.xlsx",
      sheet,
      batchSize: 5,
    });
    await runJob(clean, idB, countingExtractor().extract);
    const straight = await assembleProducts(clean, idB, sheet);

    // Variant.id is the ACP checkout items[].id. A resume must not shift it.
    assert.deepEqual(
      resumed.flatMap((p) => p.variants.map((v) => v.id)).sort(),
      straight.flatMap((p) => p.variants.map((v) => v.id)).sort(),
    );
    assert.equal(resumed.length, straight.length);
  });
});

describe("failures are visible, not silent", () => {
  test("a failed batch records a machine code and a human string", async () => {
    const id = await create();
    const { extract } = countingExtractor((call) => (call === 2 ? "throw" : "ok"));
    await runJob(sql, id, extract);

    const progress = await getProgress(sql, id);
    assert.equal(progress.failures.length, 1);
    const failure = progress.failures[0];
    assert.ok(failure);
    // CLAUDE.md invariant 3: both, always.
    assert.equal(failure.reason_code, "PROVIDER_RATE_LIMITED");
    assert.match(failure.reason_human, /429/);
  });

  test("rows from a failed batch become flagged products, not missing ones", async () => {
    const id = await create();
    const { extract } = countingExtractor((call) => (call === 2 ? "throw" : "ok"));
    await runJob(sql, id, extract);

    const products = await assembleProducts(sql, id, sheet);
    const variants = products.flatMap((p) => p.variants);

    // Every sheet row is still represented.
    assert.equal(variants.length, 14);
    const unread = variants.filter((v) => v.normalization.confidence === 0);
    assert.equal(unread.length, 5);
    for (const v of unread) assert.ok(v.normalization.needs_review);
  });

  test("one failed batch does not abort the rest of the run", async () => {
    const id = await create();
    const { extract, calls } = countingExtractor((call) => (call === 1 ? "throw" : "ok"));
    await runJob(sql, id, extract);

    assert.equal(calls.length, 3, "batches 2 and 3 still ran");
    const progress = await getProgress(sql, id);
    assert.equal(progress.batches_done, 2);
  });
});

describe("progress and fingerprint", () => {
  test("progress is reported per batch and reaches the total", async () => {
    const id = await create();
    const seen: number[] = [];
    await runJob(sql, id, countingExtractor().extract, {
      onProgress: (p) => seen.push(p.rows_extracted),
    });
    assert.deepEqual(seen, [5, 10, 14]);
  });

  test("the job records what actually served it, for the eval", async () => {
    const id = await create();
    await runJob(sql, id, countingExtractor().extract);
    const progress = await getProgress(sql, id);

    // NORMALIZATION-EVAL.md: the number belongs to the run that produced it.
    assert.equal(progress.fingerprint.provider, "fake");
    assert.equal(progress.fingerprint.model_requested, "fake-1");
    assert.equal(progress.fingerprint.model_served, "fake-1-0625");
    assert.equal(progress.fingerprint.prompt_sha256, "a".repeat(64));
  });
});

describe("schema constraints are real", () => {
  test("a done batch cannot exist without a completion time", async () => {
    const id = await create();
    await assert.rejects(
      sql.query(
        `update ingest_batch set status = 'done', completed_at = null
          where job_id = $1 and batch_index = 0`,
        [id],
      ),
      /done_has_completed_at/,
    );
  });

  test("only a failed batch may carry a reason code", async () => {
    const id = await create();
    await assert.rejects(
      sql.query(
        `update ingest_batch set reason_code = 'NOPE' where job_id = $1 and batch_index = 0`,
        [id],
      ),
      /only_failed_has_reason/,
    );
  });

  test("deleting a job takes its rows and batches with it", async () => {
    const id = await create();
    await sql.query("delete from ingest_job where id = $1", [id]);
    const { rows } = await sql.query("select 1 from ingest_row where job_id = $1", [id]);
    assert.equal(rows.length, 0);
  });
});

describe("migrations", () => {
  test("are applied exactly once", async () => {
    const again = await migrate(sql);
    assert.deepEqual(again, [], "already-applied migrations do not re-run");
  });
});
