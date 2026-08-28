/**
 * The feed read surface. PLAN.md §6.
 *
 * Route handlers are called directly as functions rather than through a dev
 * server: an App Router handler takes a Request and returns a Response, so a
 * server would add a port, a lifecycle and a source of flakiness while testing
 * exactly the same code.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// FEED_ROOT is read at module load, so it must be set before the store is
// imported. Hence the dynamic imports below.
const root = await mkdtemp(join(tmpdir(), "feeds-"));
process.env["FEED_ROOT"] = root;

const { writeFeed } = await import("../lib/feed/store.ts");
const { projectFeed } = await import("../lib/feed/project.ts");
const { ACP_API_VERSION } = await import("../lib/feed/acp.ts");
const metadataRoute = await import("../app/api/feeds/[feedId]/route.ts");
const productsRoute = await import("../app/api/feeds/[feedId]/products/route.ts");

import type { Product, Variant } from "../lib/normalize/schema.ts";

const provenance = {
  source_file: "messy-01-preamble.xlsx",
  source_sheet: "Price List",
  source_row: 7,
  source_cells: { "Item Name": "Canvas Shoe White", Price: "899" },
};
const clean = { confidence: 0.95, flags: [], needs_review: false };

function variant(over: Partial<Variant> = {}): Variant {
  return {
    id: "var_canvas_white_9",
    title: "Canvas Shoe White - 9",
    category: "footwear",
    category_raw: "Footwear",
    category_confidence: 0.98,
    price: { amount_minor: 89900, currency: "INR" },
    compare_at_price: null,
    availability: "in_stock",
    inventory_count: 12,
    options: { Size: "9" },
    attributes: {},
    image_url: null,
    provenance,
    normalization: clean,
    ...over,
  };
}

function product(over: Partial<Product> = {}): Product {
  return {
    id: "prod_canvas_white",
    merchant_id: "mer_lakshmi",
    title: "Canvas Shoe White",
    description: null,
    brand: null,
    variants: [variant()],
    image_url: null,
    provenance,
    normalization: clean,
    ...over,
  };
}

const params = (feedId: string) => ({ params: Promise.resolve({ feedId }) });
/** `Response.json()` is `unknown` under strict; these are assertions, not parsing. */
const json = async <T = Record<string, any>>(response: Response): Promise<T> =>
  (await response.json()) as T;
const get = (path: string, headers: Record<string, string> = {}) =>
  new Request(`https://merchant.example.com${path}`, { headers });

before(async () => {
  await writeFeed(
    projectFeed([product(), product({ id: "prod_two", title: "Kolhapuri Chappal" })], {
      feedId: "feed_lakshmi",
      targetCountry: "IN",
      updatedAt: new Date("2026-08-22T10:04:12Z"),
    }),
  );
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("GET /feeds/{id}", () => {
  test("returns FeedMetadata that validates against the pinned schema", async () => {
    const response = await metadataRoute.GET(get("/api/feeds/feed_lakshmi"), params("feed_lakshmi"));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("API-Version"), ACP_API_VERSION);

    const body = await json(response);
    assert.deepEqual(body, {
      id: "feed_lakshmi",
      updated_at: "2026-08-22T10:04:12.000Z",
      target_country: "IN",
    });
  });

  test("404 uses ACP's flat error shape, not a bare string", async () => {
    const response = await metadataRoute.GET(get("/api/feeds/feed_missing"), params("feed_missing"));
    assert.equal(response.status, 404);

    const body = await json(response);
    assert.equal(body.type, "invalid_request");
    // The code openapi.feed.yaml actually specifies.
    assert.equal(body.code, "feed_not_found");
    assert.equal(body.param, "id");
    assert.equal(typeof body.message, "string");
  });
});

describe("GET /feeds/{id}/products", () => {
  test("returns the full product set, schema-valid", async () => {
    const response = await productsRoute.GET(
      get("/api/feeds/feed_lakshmi/products"),
      params("feed_lakshmi"),
    );
    assert.equal(response.status, 200);

    const body = await json(response);
    // "MUST return the full current product set" — everything, no paging.
    assert.equal(body.products.length, 2);
    assert.equal(body.products[0].id, "prod_canvas_white");
    assert.equal(body.products[0].variants[0].price.amount, 89900);
  });

  test("no internal-only field survives to the wire", async () => {
    const response = await productsRoute.GET(
      get("/api/feeds/feed_lakshmi/products"),
      params("feed_lakshmi"),
    );
    const text = await response.text();
    for (const leaked of [
      "provenance",
      "source_row",
      "merchant_id",
      "inventory_count",
      "normalization",
      "needs_review",
    ]) {
      assert.ok(!text.includes(leaked), `${leaked} reached the wire`);
    }
  });

  test("404 for an unknown feed", async () => {
    const response = await productsRoute.GET(
      get("/api/feeds/nope/products"),
      params("nope"),
    );
    assert.equal(response.status, 404);
    assert.equal((await json(response)).code, "feed_not_found");
  });
});

describe("caching", () => {
  test("responses are cacheable and carry an ETag", async () => {
    const response = await productsRoute.GET(
      get("/api/feeds/feed_lakshmi/products"),
      params("feed_lakshmi"),
    );
    assert.match(response.headers.get("Cache-Control") ?? "", /public, max-age=\d+/);
    assert.ok(response.headers.get("ETag"));
  });

  test("If-None-Match with a matching ETag gets 304 and no body", async () => {
    const first = await productsRoute.GET(
      get("/api/feeds/feed_lakshmi/products"),
      params("feed_lakshmi"),
    );
    const etag = first.headers.get("ETag");
    assert.ok(etag);

    const second = await productsRoute.GET(
      get("/api/feeds/feed_lakshmi/products", { "If-None-Match": etag }),
      params("feed_lakshmi"),
    );
    assert.equal(second.status, 304);
    assert.equal(await second.text(), "");
  });

  test("the ETag changes when the products change", async () => {
    const before = (
      await productsRoute.GET(get("/api/feeds/feed_lakshmi/products"), params("feed_lakshmi"))
    ).headers.get("ETag");

    await writeFeed(
      projectFeed([product()], { feedId: "feed_lakshmi", targetCountry: "IN" }),
    );

    const after = (
      await productsRoute.GET(get("/api/feeds/feed_lakshmi/products"), params("feed_lakshmi"))
    ).headers.get("ETag");

    assert.notEqual(before, after);
  });
});

describe("API-Version", () => {
  test("a matching version is accepted", async () => {
    const response = await metadataRoute.GET(
      get("/api/feeds/feed_lakshmi", { "API-Version": ACP_API_VERSION }),
      params("feed_lakshmi"),
    );
    assert.equal(response.status, 200);
  });

  test("an absent version is accepted — we serve only one", async () => {
    const response = await metadataRoute.GET(get("/api/feeds/feed_lakshmi"), params("feed_lakshmi"));
    assert.equal(response.status, 200);
  });

  test("a mismatched version is refused rather than answered in the wrong shape", async () => {
    const response = await metadataRoute.GET(
      get("/api/feeds/feed_lakshmi", { "API-Version": "2026-01-30" }),
      params("feed_lakshmi"),
    );
    assert.equal(response.status, 400);
    const body = await json(response);
    assert.equal(body.code, "unsupported_api_version");
    assert.match(body.message, /2026-04-17/);
  });
});

describe("feed ids are untrusted input", () => {
  test("path traversal is refused, not sanitised", async () => {
    for (const id of ["../../etc/passwd", "..", "a/b", "feed lakshmi", "x".repeat(65), ""]) {
      const response = await metadataRoute.GET(get(`/api/feeds/x`), params(id));
      // Deliberately the same answer as a missing feed: distinguishing them
      // confirms the shape of what we store.
      assert.equal(response.status, 404, `${JSON.stringify(id)} should 404`);
    }
  });

  test("a traversal id never reads a real file", async () => {
    const response = await metadataRoute.GET(
      get("/api/feeds/x"),
      params("../feed_lakshmi"),
    );
    assert.equal(response.status, 404);
  });
});
