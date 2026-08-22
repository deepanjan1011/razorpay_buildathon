/**
 * Batching and retry, driven by fakes. No network, no keys.
 *
 * The behaviour that matters here is what happens when a batch FAILS, because
 * that is the path a rate limit takes and the one where rows quietly disappear
 * if nobody is looking.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { chunk, extractCatalogue, DEFAULT_CONCURRENCY } from "../lib/normalize/batch.ts";
import type { ExtractFn, ExtractionInput, ExtractionResult } from "../lib/normalize/llm.ts";
import { serverDelayMs } from "../lib/normalize/providers/retry.ts";

const rows = (n: number): ExtractionInput[] =>
  Array.from({ length: n }, (_, i) => ({ source_row: i + 2, cells: { Item: `item ${i}` } }));

function fakeResult(batch: ExtractionInput[]): ExtractionResult {
  return {
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
      conformance: "constrained",
      model_requested: "fake-1",
      model_served: "fake-1",
      prompt_sha256: "0".repeat(64),
    },
    usage: null,
    latency_ms: 1,
  };
}

describe("chunk", () => {
  test("splits evenly and keeps the remainder", () => {
    assert.equal(chunk(rows(250), 100).length, 3);
    assert.equal(chunk(rows(250), 100)[2]?.length, 50);
    assert.equal(chunk(rows(100), 100).length, 1);
    assert.deepEqual(chunk([], 100), []);
  });

  test("a zero or negative size is a programming error, not a silent no-op", () => {
    assert.throws(() => chunk(rows(10), 0), /batch size/);
  });
});

describe("extractCatalogue", () => {
  test("covers every row exactly once across batches", async () => {
    const seen: number[] = [];
    const extract: ExtractFn = async (batch) => {
      seen.push(...batch.map((r) => r.source_row));
      return fakeResult(batch);
    };

    const result = await extractCatalogue(extract, rows(250), { batchSize: 100 });
    assert.equal(result.rows.length, 250);
    assert.equal(new Set(seen).size, 250, "no row sent twice");
    assert.equal(result.failed.length, 0);
  });

  test("a failed batch does not abort the run", async () => {
    let call = 0;
    const extract: ExtractFn = async (batch) => {
      call++;
      if (call === 2) throw new Error("gemini returned 429: quota exceeded");
      return fakeResult(batch);
    };

    const result = await extractCatalogue(extract, rows(250), {
      batchSize: 100,
      concurrency: 1,
    });

    // The other two batches still landed.
    assert.equal(result.rows.length, 150);
    assert.equal(result.failed.length, 100);
  });

  test("rows in a failed batch are returned with a reason, never lost", async () => {
    const extract: ExtractFn = async () => {
      throw new Error("gemini returned 429: quota exceeded");
    };

    const all = rows(120);
    const result = await extractCatalogue(extract, all, { batchSize: 100, concurrency: 1 });

    assert.equal(result.rows.length, 0);
    // Every single input row is accounted for.
    assert.equal(result.failed.length, 120);
    assert.deepEqual(
      result.failed.map((f) => f.source_row).sort((a, b) => a - b),
      all.map((r) => r.source_row),
    );
    for (const f of result.failed) assert.match(f.reason, /429/);
  });

  test("progress is reported per batch, monotonically", async () => {
    const seen: number[] = [];
    const extract: ExtractFn = async (batch) => fakeResult(batch);

    await extractCatalogue(extract, rows(250), {
      batchSize: 100,
      concurrency: 1,
      onProgress: (p) => {
        seen.push(p.rowsDone);
        assert.equal(p.rowsTotal, 250);
        assert.equal(p.batchesTotal, 3);
      },
    });

    assert.deepEqual(seen, [100, 200, 250]);
  });

  test("the default is serial, because the free tier allows 5 requests a minute", () => {
    assert.equal(DEFAULT_CONCURRENCY, 1);
  });

  test("concurrency never exceeds the batch count", async () => {
    let inFlight = 0;
    let peak = 0;
    const extract: ExtractFn = async (batch) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return fakeResult(batch);
    };

    await extractCatalogue(extract, rows(150), { batchSize: 100, concurrency: 8 });
    assert.equal(peak, 2, "two batches means at most two in flight");
  });
});

describe("serverDelayMs", () => {
  const headers = (init: Record<string, string> = {}) => new Headers(init);

  test("reads a Retry-After header in seconds", () => {
    assert.equal(serverDelayMs(headers({ "retry-after": "30" }), ""), 30_000);
  });

  test("reads Google's RetryInfo from the body, which carries no header", () => {
    // The shape that actually failed us: no Retry-After at all, the delay
    // buried in error.details. A backoff that only reads headers waits four
    // seconds for a sixty-second window and burns every attempt.
    const body = JSON.stringify({
      error: {
        code: 429,
        message: "You exceeded your current quota. Please retry in 19.120595985s.",
        details: [
          { "@type": "type.googleapis.com/google.rpc.Help", links: [] },
          { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "19s" },
        ],
      },
    });
    assert.equal(serverDelayMs(headers(), body), 19_000);
  });

  test("falls back to the prose message when RetryInfo is absent", () => {
    const body = JSON.stringify({
      error: { code: 429, message: "Quota exceeded. Please retry in 42.5s." },
    });
    assert.equal(serverDelayMs(headers(), body), 42_500);
  });

  test("returns null when the server said nothing, so backoff takes over", () => {
    assert.equal(serverDelayMs(headers(), ""), null);
    assert.equal(serverDelayMs(headers(), "not json"), null);
    assert.equal(serverDelayMs(headers(), JSON.stringify({ error: { message: "nope" } })), null);
  });
});
