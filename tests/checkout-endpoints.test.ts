/**
 * The ACP checkout endpoints. Header contract, idempotency, error shapes.
 *
 * Idempotency is the substance here. ACP requires an `Idempotency-Key` on every
 * POST, Razorpay offers none (DESIGN.md §2), so we enforce it — and the tests
 * exercise the case that actually matters, which is two requests racing rather
 * than two arriving one after the other. A check-then-insert implementation
 * passes the sequential test and fails the concurrent one, and on `complete`
 * later that difference is two Razorpay orders.
 */
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { connectEphemeral } from "../lib/db/sql.ts";
import type { Sql } from "../lib/db/sql.ts";
import { migrate } from "../lib/db/migrate.ts";
import { upsertCatalog } from "../lib/catalog/store.ts";
import { withIdempotency, checkHeaders, readBody, aggregate } from "../lib/checkout/http.ts";
import { ACP_API_VERSION } from "../lib/checkout/validate.ts";
import type { Product, Variant } from "../lib/normalize/schema.ts";

const MERCHANT = "mer_lakshmi";
let sql: Sql;

const provenance = { source_file: "s.xlsx", source_sheet: "S", source_row: 2, source_cells: {} };
const clean = { confidence: 0.95, flags: [], needs_review: false };

const variant = (o: Partial<Variant> = {}): Variant => ({
  id: "var_shoe",
  title: "Canvas Shoe - White",
  category: "footwear",
  category_raw: null,
  category_confidence: 0.98,
  price: { amount_minor: 89900, currency: "INR" },
  compare_at_price: null,
  availability: "in_stock",
  inventory_count: null,
  options: {},
  attributes: {},
  image_url: null,
  provenance,
  normalization: clean,
  ...o,
});

const product = (o: Partial<Product> = {}): Product => ({
  id: "prod_shoe",
  merchant_id: MERCHANT,
  title: "Canvas Shoe",
  description: null,
  brand: null,
  variants: [variant()],
  image_url: null,
  provenance,
  normalization: clean,
  ...o,
});

beforeEach(async () => {
  sql = await connectEphemeral();
  await migrate(sql);
  await upsertCatalog(sql, MERCHANT, [product()]);
});

const req = (headers: Record<string, string> = {}, body?: unknown) =>
  new Request("https://merchant.example.com/api/checkout_sessions", {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "API-Version": ACP_API_VERSION,
      Authorization: "Bearer test",
      "Content-Type": "application/json",
      "X-Merchant-Id": MERCHANT,
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

describe("required headers", () => {
  const asJson = async (r: Response) => (await r.json()) as { code: string; type: string };

  test("API-Version is required and a mismatch is refused", async () => {
    const missing = checkHeaders(new Request("https://x/", { headers: {} }), { post: false });
    assert.equal(missing?.status, 400);
    assert.equal((await asJson(missing!)).code, "missing_api_version");

    const wrong = checkHeaders(
      new Request("https://x/", { headers: { "API-Version": "2026-01-30" } }),
      { post: false },
    );
    assert.equal(wrong?.status, 400);
    assert.equal((await asJson(wrong!)).code, "unsupported_api_version");
  });

  test("Authorization is required", async () => {
    const r = checkHeaders(
      new Request("https://x/", { headers: { "API-Version": ACP_API_VERSION } }),
      { post: false },
    );
    assert.equal(r?.status, 401);
    assert.equal((await asJson(r!)).code, "missing_authorization");
  });

  test("Idempotency-Key is required on POST, with the spec's own code", async () => {
    const r = checkHeaders(
      new Request("https://x/", {
        method: "POST",
        headers: { "API-Version": ACP_API_VERSION, Authorization: "Bearer t" },
      }),
      { post: true },
    );
    assert.equal(r?.status, 400);
    // Named verbatim in schema.agentic_checkout.json's Error description.
    assert.equal((await asJson(r!)).code, "idempotency_key_required");
  });

  test("it is NOT required on GET", () => {
    const r = checkHeaders(
      new Request("https://x/", {
        headers: { "API-Version": ACP_API_VERSION, Authorization: "Bearer t" },
      }),
      { post: false },
    );
    assert.equal(r, null);
  });

  test("errors always use ACP's flat shape with a legal type", async () => {
    const r = checkHeaders(new Request("https://x/"), { post: false })!;
    const body = await asJson(r);
    assert.ok(["invalid_request", "processing_error", "service_unavailable"].includes(body.type));
    assert.ok(body.code);
  });
});

describe("request body validation", () => {
  test("non-JSON is a 400, not a crash", async () => {
    const bad = new Request("https://x/", { method: "POST", body: "{not json" });
    const r = await readBody(bad, "CheckoutSessionCreateRequest");
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(((await r.response.json()) as { code: string }).code, "invalid_json");
  });

  test("a body violating the schema is refused with a JSONPath param", async () => {
    const bad = new Request("https://x/", {
      method: "POST",
      body: JSON.stringify({ line_items: [{ id: "v1" }], nonsense_field: true }),
    });
    const r = await readBody(bad, "CheckoutSessionCreateRequest");
    assert.equal(r.ok, false);
    if (!r.ok) {
      const body = (await r.response.json()) as { code: string; param: string };
      assert.equal(body.code, "invalid_request");
      assert.match(body.param, /^\$/);
    }
  });

  test("a conforming body passes — currency and capabilities are REQUIRED", async () => {
    // Both are in CheckoutSessionCreateRequest.required, which is easy to miss
    // by reading the property list instead of the required list.
    const good = new Request("https://x/", {
      method: "POST",
      body: JSON.stringify({
        line_items: [{ id: "var_shoe" }],
        currency: "INR",
        capabilities: {},
      }),
    });
    const r = await readBody(good, "CheckoutSessionCreateRequest");
    assert.equal(r.ok, true);
  });

  test("quantity on an Item is a schema violation — it is expressed by repetition", async () => {
    // Item declares {id, name?, unit_amount?} with additionalProperties: false.
    const withQty = new Request("https://x/", {
      method: "POST",
      body: JSON.stringify({
        line_items: [{ id: "var_shoe", quantity: 2 }],
        currency: "INR",
        capabilities: {},
      }),
    });
    assert.equal((await readBody(withQty, "CheckoutSessionCreateRequest")).ok, false);
  });
});

describe("quantity by repetition", () => {
  test("repeated ids aggregate into one line with a quantity", () => {
    assert.deepEqual(aggregate([{ id: "a" }, { id: "a" }, { id: "b" }, { id: "a" }]), [
      { id: "a", quantity: 3 },
      { id: "b", quantity: 1 },
    ]);
  });

  test("a single item is quantity one", () => {
    assert.deepEqual(aggregate([{ id: "a" }]), [{ id: "a", quantity: 1 }]);
  });

  test("order of first appearance is preserved", () => {
    assert.deepEqual(
      aggregate([{ id: "z" }, { id: "a" }, { id: "z" }]).map((i) => i.id),
      ["z", "a"],
    );
  });
});

describe("idempotency", () => {
  const gate = (key: string, body: unknown) =>
    withIdempotency(sql, req({ "Idempotency-Key": key }, body), "POST /x", MERCHANT, body);

  test("first use proceeds; the same key and body then replays", async () => {
    const first = await gate("k1", { line_items: [{ id: "var_shoe" }] });
    assert.equal(first.kind, "proceed");
    if (first.kind === "proceed") await first.commit(201, { id: "cs_abc" });

    const second = await gate("k1", { line_items: [{ id: "var_shoe" }] });
    assert.equal(second.kind, "replay");
    if (second.kind === "replay") {
      assert.equal(second.response.status, 201);
      assert.equal(second.response.headers.get("Idempotent-Replay"), "true");
      assert.deepEqual(await second.response.json(), { id: "cs_abc" });
    }
  });

  test("the same key with a DIFFERENT body is a conflict, never the old answer", async () => {
    const first = await gate("k2", { line_items: [{ id: "var_shoe" }] });
    if (first.kind === "proceed") await first.commit(201, { id: "cs_one" });

    const second = await gate("k2", { line_items: [{ id: "var_other" }] });
    assert.equal(second.kind, "conflict");
    if (second.kind === "conflict") {
      assert.equal(second.response.status, 409);
      // Returning cs_one here would hand back a session for a cart the caller
      // never asked for.
      assert.equal(
        ((await second.response.json()) as { code: string }).code,
        "idempotency_conflict",
      );
    }
  });

  test("a key whose request has not finished is in_flight, not a duplicate run", async () => {
    const first = await gate("k3", { a: 1 });
    assert.equal(first.kind, "proceed"); // deliberately never committed

    const second = await gate("k3", { a: 1 });
    assert.equal(second.kind, "conflict");
    if (second.kind === "conflict") {
      assert.equal(
        ((await second.response.json()) as { code: string }).code,
        "idempotency_in_flight",
      );
    }
  });

  test("CONCURRENT identical requests: exactly one proceeds", async () => {
    // The case a check-then-insert implementation gets wrong. Both would find
    // no record and both would execute; on `complete` that is two Razorpay
    // orders for one cart.
    const results = await Promise.all([
      gate("race", { a: 1 }),
      gate("race", { a: 1 }),
      gate("race", { a: 1 }),
      gate("race", { a: 1 }),
    ]);
    assert.equal(results.filter((r) => r.kind === "proceed").length, 1);
    assert.equal(results.filter((r) => r.kind === "conflict").length, 3);
  });

  test("the same key on a different endpoint is a different operation", async () => {
    const a = await withIdempotency(sql, req({ "Idempotency-Key": "shared" }, {}), "POST /a", MERCHANT, {});
    const b = await withIdempotency(sql, req({ "Idempotency-Key": "shared" }, {}), "POST /b", MERCHANT, {});
    assert.equal(a.kind, "proceed");
    assert.equal(b.kind, "proceed");
  });

  test("a replayed error is replayed as an error, not retried into success", async () => {
    const first = await gate("k4", { a: 1 });
    if (first.kind === "proceed") await first.commit(409, { type: "invalid_request", code: "session_terminal" });

    const second = await gate("k4", { a: 1 });
    assert.equal(second.kind, "replay");
    if (second.kind === "replay") assert.equal(second.response.status, 409);
  });
});

describe("the no-credential handler deviation is narrow", () => {
  // ACP's PaymentData assumes every handler carries a credential. Ours does
  // not — the artifact is a URL travelling seller-to-agent — so neither anyOf
  // branch fits, and the extension mechanism cannot add one because
  // PaymentData sets additionalProperties: false. We accept handler_id alone
  // and declare it. What must NOT happen is that declaring it turns
  // CheckoutSessionCompleteRequest into a schema nothing is checked against.
  const body = (payment_data: unknown) =>
    new Request("https://x/", { method: "POST", body: JSON.stringify({ payment_data }) });

  test("handler_id alone is accepted", async () => {
    const r = await readBody(body({ handler_id: "razorpay_link" }), "CheckoutSessionCompleteRequest");
    assert.equal(r.ok, true);
  });

  test("payment_data with NO handler_id is still refused", async () => {
    const r = await readBody(body({}), "CheckoutSessionCompleteRequest");
    assert.equal(r.ok, false);
  });

  test("an unknown field on payment_data is still refused", async () => {
    // The waiver covers the missing-branch error only. additionalProperties
    // must keep biting, or a typo in a field name would pass silently.
    const r = await readBody(
      body({ handler_id: "razorpay_link", handler_i: "typo" }),
      "CheckoutSessionCompleteRequest",
    );
    assert.equal(r.ok, false);
  });

  test("a malformed instrument is still refused when one IS sent", async () => {
    const r = await readBody(
      body({ handler_id: "razorpay_link", instrument: { type: "card" } }),
      "CheckoutSessionCompleteRequest",
    );
    assert.equal(r.ok, false);
  });
});
