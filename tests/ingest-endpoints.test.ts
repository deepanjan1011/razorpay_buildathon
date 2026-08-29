/**
 * The ingest endpoints, against real Postgres (PGlite) and a fake extractor.
 *
 * The pipeline is exercised directly rather than through the route handlers
 * where the handler would only add a `connect()` call: the routes construct
 * their own database connection from DATABASE_URL, which a test must not do.
 * What the route tests cover is the HTTP contract — status codes, error shapes,
 * and the input validation at the trust boundary.
 */
import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const feedRoot = await mkdtemp(join(tmpdir(), "feeds-ingest-"));
process.env["FEED_ROOT"] = feedRoot;

const { connectEphemeral } = await import("../lib/db/sql.ts");
const { migrate } = await import("../lib/db/migrate.ts");
const { ingestUpload, publishFeed, feedIdFor, parseUpload } = await import(
  "../lib/ingest/pipeline.ts"
);
const { runJob, getProgress, createJob } = await import("../lib/ingest/job.ts");
const { readFeed } = await import("../lib/feed/store.ts");
// Dynamic like the rest of this file: FEED_ROOT must be set before any of these
// modules resolve their paths at import time.
const { lookupVariants } = await import("../lib/catalog/store.ts");
const uploadRoute = await import("../app/api/ingest/route.ts");
const progressRoute = await import("../app/api/ingest/[jobId]/route.ts");

import type { Sql } from "../lib/db/sql.ts";
import type { ExtractFn, ExtractionInput } from "../lib/normalize/llm.ts";

let sql: Sql;
let bytes: ArrayBuffer;

before(async () => {
  const buf = await readFile(
    join(import.meta.dirname, "..", "fixtures", "messy-01-preamble.xlsx"),
  );
  bytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
});

beforeEach(async () => {
  sql = await connectEphemeral();
  await migrate(sql);
});

after(async () => {
  await rm(feedRoot, { recursive: true, force: true });
});

const fakeExtract: ExtractFn = async (batch: ExtractionInput[]) => ({
  batch: {
    rows: batch.map((r) => ({
      source_row: r.source_row,
      title: "Canvas Shoe",
      title_inferred: false,
      category: "footwear",
      category_confidence: 0.95,
      options: {},
      attributes: {},
      brand: null,
      description: null,
      variant_group: "canvas-shoe",
      confidence: 0.9,
    })),
  },
  fingerprint: {
    provider: "fake",
    conformance: "best_effort",
    model_requested: "fake-1",
    model_served: "fake-1",
    prompt_sha256: "b".repeat(64),
  },
  usage: null,
  latency_ms: 1,
});

describe("upload → job → feed", () => {
  test("an upload creates a job covering every parsed row", async () => {
    const { progress, resumed } = await ingestUpload(sql, {
      merchantId: "mer_lakshmi",
      sourceFile: "messy-01-preamble.xlsx",
      bytes,
      extract: fakeExtract,
    });

    assert.match(progress.id, /^job_[a-f0-9]{16}$/);
    assert.equal(progress.rows_total, 4); // preamble and junk already dropped
    assert.equal(resumed, false);
  });

  test("re-uploading the same sheet resumes instead of duplicating", async () => {
    const first = await ingestUpload(sql, {
      merchantId: "mer_lakshmi",
      sourceFile: "messy-01-preamble.xlsx",
      bytes,
      extract: fakeExtract,
    });
    await runJob(sql, first.progress.id, fakeExtract);

    const second = await ingestUpload(sql, {
      merchantId: "mer_lakshmi",
      sourceFile: "messy-01-preamble.xlsx",
      bytes,
      extract: fakeExtract,
    });

    assert.equal(second.progress.id, first.progress.id);
    assert.equal(second.resumed, true);
    assert.equal(second.progress.rows_total, 4, "rows not duplicated");
  });

  test("publishing works from stored state alone, with no sheet in memory", async () => {
    const { progress } = await ingestUpload(sql, {
      merchantId: "mer_lakshmi",
      sourceFile: "messy-01-preamble.xlsx",
      bytes,
      extract: fakeExtract,
    });
    await runJob(sql, progress.id, fakeExtract);

    // Nothing from the upload is passed here — everything comes from Postgres.
    // This is what makes a job finishable by a process that never saw the file.
    const { served, withheld } = await publishFeed(sql, progress.id, "mer_lakshmi");
    assert.ok(served > 0);
    assert.equal(withheld, 0);

    const stored = await readFeed(feedIdFor("mer_lakshmi"));
    assert.ok(stored);
    assert.equal(stored.products.flatMap((p) => p.variants).length, 4);
  });

  test("a partly-extracted job still publishes what it has", async () => {
    // createJob rather than ingestUpload: ingestUpload deliberately starts a
    // background run, which would race this test's own assertions.
    const sheets = await parseUpload(bytes);
    const id = await createJob(sql, {
      merchantId: "mer_partial",
      sourceFile: "messy-01-preamble.xlsx",
      sheet: sheets[0]!,
    });

    // Nothing extracted yet. Unread rows are flagged placeholders, not
    // absences, so they are withheld rather than missing.
    const before = await publishFeed(sql, id, "mer_partial");
    assert.equal(before.served, 0);
    assert.ok(before.withheld > 0, "unread rows are visible as withheld");

    await runJob(sql, id, fakeExtract);
    const after = await publishFeed(sql, id, "mer_partial");
    assert.ok(after.served > 0);
    assert.equal(after.withheld, 0);
  });
});

describe("POST /api/ingest — the trust boundary", () => {
  const post = (body: FormData | string | null, init: RequestInit = {}) =>
    uploadRoute.POST(
      new Request("https://merchant.example.com/api/ingest", {
        method: "POST",
        body,
        ...init,
      }),
    );

  test("a non-multipart body is a 400, not a crash", async () => {
    const response = await post(JSON.stringify({ nope: true }), {
      headers: { "Content-Type": "application/json" },
    });
    assert.equal(response.status, 400);
    const body = (await response.json()) as { code: string };
    assert.equal(body.code, "expected_multipart_form");
  });

  test("a missing file is a 400 naming the field", async () => {
    const form = new FormData();
    form.set("merchant_id", "mer_lakshmi");
    const response = await post(form);
    assert.equal(response.status, 400);
    const body = (await response.json()) as { code: string; param: string };
    assert.equal(body.code, "missing_file");
    assert.equal(body.param, "file");
  });

  test("merchant ids are validated — they reach the filesystem", async () => {
    for (const bad of ["../../etc", "mer lakshmi", "", "a/b", "x".repeat(65)]) {
      const form = new FormData();
      form.set("merchant_id", bad);
      form.set("file", new File([new Uint8Array(bytes)], "sheet.xlsx"));
      const response = await post(form);
      assert.equal(response.status, 400, `${JSON.stringify(bad)} should be refused`);
      const body = (await response.json()) as { code: string };
      assert.equal(body.code, "invalid_merchant_id");
    }
  });

  test("an oversized file is refused before it is parsed", async () => {
    const form = new FormData();
    form.set("merchant_id", "mer_lakshmi");
    form.set("file", new File([new Uint8Array(11 * 1024 * 1024)], "big.xlsx"));
    const response = await post(form);
    assert.equal(response.status, 413);
    const body = (await response.json()) as { code: string };
    assert.equal(body.code, "file_too_large");
  });

  test("errors use ACP's flat shape, so one client parser handles everything", async () => {
    const response = await post(null);
    const body = (await response.json()) as Record<string, unknown>;
    for (const key of ["type", "code", "message"]) assert.ok(key in body);
  });
});

describe("POST /api/ingest — where an anonymous upload lands", () => {
  /**
   * The route has no authentication and the merchant id arrives in the form,
   * so on a public URL anyone could post a sheet as `mer_live` and replace the
   * catalogue the demo buys from. In production the submitted id is ignored.
   *
   * WHAT THIS DOES NOT COVER, stated rather than implied: the wiring from this
   * decision into `ingestUpload`. Driving the route far enough to write a job
   * needs a live DATABASE_URL, which these tests must not depend on — so this
   * asserts the decision and not that the caller uses it. The caller is one
   * line above the call, and it is read, not proven.
   */
  const req = (headers: Record<string, string> = {}) =>
    new Request("https://merchant.example.com/api/ingest", { method: "POST", headers });

  const withEnv = (env: Record<string, string | undefined>, fn: () => void) => {
    const before = { ...process.env };
    Object.assign(process.env, env);
    for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k];
    try {
      fn();
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in before)) delete process.env[k];
      Object.assign(process.env, before);
    }
  };

  test("outside production the submitted merchant is honoured", () => {
    withEnv({ NODE_ENV: "test" }, () => {
      assert.equal(uploadRoute.merchantFor(req(), "mer_live"), "mer_live");
    });
  });

  test("in production every upload lands on the sandbox merchant", () => {
    withEnv({ NODE_ENV: "production", INGEST_KEY: undefined }, () => {
      assert.equal(uploadRoute.merchantFor(req(), "mer_live"), "mer_try");
    });
  });

  test("the lock holds when no key is configured, including for the owner", () => {
    // Unset INGEST_KEY must not mean "any key works" — the classic inversion.
    withEnv({ NODE_ENV: "production", INGEST_KEY: undefined }, () => {
      assert.equal(uploadRoute.merchantFor(req({ "x-ingest-key": "" }), "mer_live"), "mer_try");
      assert.equal(uploadRoute.merchantFor(req({ "x-ingest-key": "guess" }), "mer_live"), "mer_try");
    });
  });

  test("a wrong key is refused and the right key names its own merchant", () => {
    withEnv({ NODE_ENV: "production", INGEST_KEY: "s3cret" }, () => {
      assert.equal(uploadRoute.merchantFor(req({ "x-ingest-key": "wrong" }), "mer_live"), "mer_try");
      assert.equal(uploadRoute.merchantFor(req({ "x-ingest-key": "s3cret" }), "mer_live"), "mer_live");
    });
  });

  test("the sandbox merchant is configurable", () => {
    withEnv({ NODE_ENV: "production", INGEST_SANDBOX_MERCHANT: "mer_demo_only" }, () => {
      assert.equal(uploadRoute.merchantFor(req(), "mer_live"), "mer_demo_only");
    });
  });
});

describe("GET /api/ingest/{jobId}", () => {
  const get = (jobId: string) =>
    progressRoute.GET(new Request(`https://merchant.example.com/api/ingest/${jobId}`), {
      params: Promise.resolve({ jobId }),
    });

  test("a malformed job id is 404, not a database round trip", async () => {
    for (const bad of ["../../etc/passwd", "job_zzz", "nope", ""]) {
      const response = await get(bad);
      assert.equal(response.status, 404, `${JSON.stringify(bad)}`);
      const body = (await response.json()) as { code: string };
      assert.equal(body.code, "job_not_found");
    }
  });

  // A well-formed but unknown job id also 404s, but proving that through the
  // route needs a live DATABASE_URL, which a test must not depend on. The
  // behaviour it rests on — getProgress throwing "no such job" — is asserted
  // directly in tests/ingest-job.test.ts.
});

describe("progress is legible enough to wait on", () => {
  test("counts advance and failures carry reasons", async () => {
    const sheets = await parseUpload(bytes);
    const id = await createJob(sql, {
      merchantId: "mer_lakshmi",
      sourceFile: "messy-01-preamble.xlsx",
      sheet: sheets[0]!,
    });

    let failing = 0;
    await runJob(sql, id, async (batch) => {
      if (++failing === 1) throw new Error("gemini returned 429: quota exceeded");
      return fakeExtract(batch);
    });

    const after = await getProgress(sql, id);
    assert.equal(after.status, "failed");
    assert.equal(after.failures.length, 1);
    // A bare count would leave a merchant unable to tell a rate limit from a
    // broken sheet.
    assert.equal(after.failures[0]?.reason_code, "PROVIDER_RATE_LIMITED");
    assert.match(after.failures[0]?.reason_human ?? "", /429/);
  });

  test("a failed job is terminal but resumable", async () => {
    const sheets = await parseUpload(bytes);
    const id = await createJob(sql, {
      merchantId: "mer_lakshmi",
      sourceFile: "messy-01-preamble.xlsx",
      sheet: sheets[0]!,
    });
    await runJob(sql, id, async () => {
      throw new Error("gemini returned 429: quota exceeded");
    });
    assert.equal((await getProgress(sql, id)).status, "failed");

    await runJob(sql, id, fakeExtract);
    const recovered = await getProgress(sql, id);
    assert.equal(recovered.status, "complete");
    assert.equal(recovered.rows_extracted, recovered.rows_total);
  });
});

describe("upload parsing", () => {
  test("a workbook parses from bytes without touching disk", async () => {
    const sheets = await parseUpload(bytes);
    assert.ok(sheets[0]);
    assert.equal(sheets[0].headers[0], "Item Name");
    assert.equal(sheets[0].rows.length, 4);
  });
});

describe("what is discoverable is exactly what is buyable", () => {
  // THE SEAM NOTHING TESTED. `upsertCatalog` existed with exactly one caller —
  // the test suite — so the feed an agent discovers from and the catalogue
  // checkout prices against were filled by different paths, and nothing kept
  // them agreeing. Every unit test passed throughout: each half was correct in
  // isolation, and no fixture covered a call that was never written.
  //
  // The symptom is the worst shape a demo can take. An agent discovers a
  // product, creates a session for the id it was handed, and gets
  // not_ready_for_payment with a total of zero — because the advertised id is
  // not in the catalogue at all. Found by driving the MCP server with a real
  // client, on the first run that got as far as creating a session.
  test("every variant the feed publishes can be priced by checkout", async () => {
    const { progress } = await ingestUpload(sql, {
      merchantId: "mer_seam",
      sourceFile: "messy-01-preamble.xlsx",
      bytes,
      extract: fakeExtract,
    });
    await runJob(sql, progress.id, fakeExtract);

    const { served, stocked } = await publishFeed(sql, progress.id, "mer_seam");
    assert.ok(served > 0, "the fixture must publish something for this to mean anything");

    const stored = await readFeed(feedIdFor("mer_seam"));
    assert.ok(stored);
    const advertised = stored.products.flatMap((p) => p.variants.map((v) => v.id));
    assert.ok(advertised.length > 0);

    // DIFFERENT UNITS, and the first version of this test conflated them:
    // `served` counts PRODUCTS and `stocked` counts VARIANTS. One product with
    // four variants is served 1, stocked 4. The catalogue is keyed by variant
    // because that is what checkout prices, so the comparison that means
    // anything is against the advertised variant ids.
    assert.equal(stocked, advertised.length, "the catalogue must hold every advertised variant");

    const priced = await lookupVariants(sql, "mer_seam", advertised);
    assert.deepEqual(
      advertised.filter((id) => !priced.has(id)),
      [],
      "the feed advertises ids checkout cannot price",
    );
  });

  test("publishing twice does not duplicate the catalogue", async () => {
    // Re-ingest is normal — a merchant reuploads a corrected sheet — and the
    // upsert key is (merchant, variant), so a second publish updates rather
    // than accumulating a second copy at a shifted id.
    const { progress } = await ingestUpload(sql, {
      merchantId: "mer_seam2",
      sourceFile: "messy-01-preamble.xlsx",
      bytes,
      extract: fakeExtract,
    });
    await runJob(sql, progress.id, fakeExtract);

    const first = await publishFeed(sql, progress.id, "mer_seam2");
    const second = await publishFeed(sql, progress.id, "mer_seam2");
    assert.equal(second.stocked, first.stocked);
    assert.ok(first.stocked > 0);

    const { rows } = await sql.query<{ n: number }>(
      "select count(*)::int n from catalog_variant where merchant_id = $1",
      ["mer_seam2"],
    );
    assert.equal(rows[0]?.n, first.stocked);
  });
});
