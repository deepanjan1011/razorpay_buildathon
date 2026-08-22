/**
 * Fields that encode one fact between them must never disagree.
 *
 * A false reason code has now surfaced twice by different routes — a withheld
 * record logged with a non-causing flag, and a retried batch still carrying its
 * previous failure. Both were the same shape: a STATE field and an EXPLANATION
 * field, updated independently, free to contradict each other.
 *
 * `CLAUDE.md` invariant 3 says every refusal carries a machine reason code and a
 * human string. Phase 3's audit log makes those load-bearing — a reason code
 * that names a non-cause will be believed. So this file audits the shape rather
 * than waiting to be bitten a third time.
 *
 * Where the disagreement can be forbidden in SQL it is (see migrations 001/004);
 * this covers the pairs that live in TypeScript.
 */
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { connectEphemeral } from "../lib/db/sql.ts";
import type { Sql } from "../lib/db/sql.ts";
import { migrate } from "../lib/db/migrate.ts";
import { parseWorkbook } from "../lib/ingest/parse.ts";
import { parseStock } from "../lib/ingest/cells.ts";
import { normalizeSheet } from "../lib/normalize/normalize.ts";
import { needsReview } from "../lib/normalize/flags.ts";
import { createJob, getProgress, runJob } from "../lib/ingest/job.ts";
import type { ExtractFn } from "../lib/normalize/llm.ts";

const fixture = (name: string) => join(import.meta.dirname, "..", "fixtures", name);

let sql: Sql;
beforeEach(async () => {
  sql = await connectEphemeral();
  await migrate(sql);
});

describe("needs_review is DERIVED from flags, never set beside them", () => {
  test("every record the pipeline produces agrees with its own flags", async () => {
    // `needs_review` is stored rather than computed on read, so it is a second
    // field encoding a fact the flags already carry. It is only ever produced
    // by `normalization()`; this proves nothing has started setting it directly.
    for (const name of [
      "messy-01-preamble.xlsx",
      "messy-03-merged-category.xlsx",
      "messy-07-multilingual.xlsx",
      "messy-10-stock.xlsx",
    ]) {
      const [sheet] = await parseWorkbook(fixture(name));
      assert.ok(sheet);

      const products = normalizeSheet(
        sheet,
        sheet.rows.map((r, i) => ({
          source_row: r.row,
          title: `Item ${i}`,
          title_inferred: i % 5 === 0,
          category: i % 4 === 0 ? "unmapped" : "footwear",
          category_confidence: i % 3 === 0 ? 0.2 : 0.95,
          options: {},
          attributes: {},
          brand: null,
          description: null,
          variant_group: null,
          confidence: i % 7 === 0 ? 0.1 : 0.9,
        })),
        { merchantId: "mer_x", sourceFile: name },
      );

      for (const p of [...products, ...products.flatMap((x) => x.variants)]) {
        assert.equal(
          p.normalization.needs_review,
          needsReview(p.normalization.flags),
          `${name}: needs_review disagrees with ${JSON.stringify(p.normalization.flags)}`,
        );
      }
    }
  });
});

describe("availability and inventory_count cannot contradict", () => {
  test("a positive count is never out_of_stock, and zero is never in_stock", () => {
    const inputs = [
      "yes", "no", "✓", "✗", null, "10 pcs", 0, 24, "In Stock",
      "Out of stock", "-", "available", "SOLD OUT", "0 pcs", "1",
    ];
    for (const raw of inputs) {
      const { availability, inventory_count } = parseStock(raw);
      if (inventory_count === null) continue;
      if (inventory_count > 0) {
        assert.equal(availability, "in_stock", `${JSON.stringify(raw)}`);
      } else {
        assert.equal(availability, "out_of_stock", `${JSON.stringify(raw)}`);
      }
    }
  });

  test("unknown availability never carries a count", () => {
    for (const raw of ["-", "??", "ask", "call", null, ""]) {
      const parsed = parseStock(raw);
      if (parsed.availability !== "unknown") continue;
      assert.equal(parsed.inventory_count, null, `${JSON.stringify(raw)}`);
    }
  });
});

describe("a job's status and its reason cannot disagree", () => {
  const failing: ExtractFn = async () => {
    throw new Error("gemini returned 429: quota exceeded");
  };
  const ok: ExtractFn = async (batch) => ({
    batch: {
      rows: batch.map((r) => ({
        source_row: r.source_row,
        title: "Item",
        title_inferred: false,
        category: "footwear",
        category_confidence: 0.9,
        options: {},
        attributes: {},
        brand: null,
        description: null,
        variant_group: null,
        confidence: 0.9,
      })),
    },
    fingerprint: {
      provider: "fake",
      conformance: "best_effort",
      model_requested: "f",
      model_served: "f",
      prompt_sha256: "c".repeat(64),
    },
    usage: null,
    latency_ms: 1,
  });

  async function job() {
    const [sheet] = await parseWorkbook(fixture("messy-01-preamble.xlsx"));
    assert.ok(sheet);
    return createJob(sql, {
      merchantId: "mer_x",
      sourceFile: "messy-01-preamble.xlsx",
      sheet,
      batchSize: 2,
    });
  }

  test("a retried job does not still claim the previous failure", async () => {
    const id = await job();
    await runJob(sql, id, failing);
    assert.equal((await getProgress(sql, id)).status, "failed");

    // The bug: `status = 'running'` was set without clearing the reason, so a
    // job being retried was RUNNING while asserting a failure that had ended.
    await runJob(sql, id, ok);
    const after = await getProgress(sql, id);
    assert.equal(after.status, "complete");

    const { rows } = await sql.query<{ reason_code: string | null }>(
      "select reason_code from ingest_job where id = $1",
      [id],
    );
    assert.equal(rows[0]?.reason_code, null, "a complete job carries no failure reason");
  });

  test("the database refuses the disagreement outright", async () => {
    const id = await job();
    await assert.rejects(
      sql.query(
        `update ingest_job set status = 'running', reason_code = 'STALE' where id = $1`,
        [id],
      ),
      /job_only_failed_has_reason/,
      "a non-failed job must not be able to carry a reason at all",
    );
  });

  test("a failed job DOES carry both a code and a human string", async () => {
    const id = await job();
    await runJob(sql, id, failing);
    const { rows } = await sql.query<{ reason_code: string; reason_human: string }>(
      "select reason_code, reason_human from ingest_job where id = $1",
      [id],
    );
    // Invariant 3: both, always. An empty explanation is as bad as a false one.
    assert.ok(rows[0]?.reason_code);
    assert.ok(rows[0]?.reason_human);
  });
});
