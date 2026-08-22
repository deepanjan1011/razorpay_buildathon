/**
 * Where feeds live between generation and serving.
 *
 * The spec's own offline full-replacement artifacts, on disk:
 *
 *   .data/feeds/{feedId}/metadata.json   FeedMetadata
 *   .data/feeds/{feedId}/products.jsonl  one Product per line
 *
 * Not a database yet. CLAUDE.md's stack says Postgres, and that is where this
 * goes — but persistence is not wired up, and inventing a storage abstraction
 * to sit in front of one filesystem implementation would be scaffolding ahead
 * of the phase. Swapping to Postgres later means rewriting the two functions
 * below, which is smaller than the interface would have been.
 *
 * Writing the artifacts rather than a serialised blob is deliberate: they are
 * the exact files `rfc.product_feeds.md` §3.4 defines for file ingestion, so
 * the same bytes we serve are the ones a real agent platform would ingest.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

import { parseProductsJsonl, toProductsJsonl } from "./acp.ts";
import type { ACPFeedMetadata, ACPProduct } from "./acp.ts";
import type { Feed } from "./project.ts";

export const FEED_ROOT =
  process.env["FEED_ROOT"] ?? join(process.cwd(), ".data", "feeds");

/**
 * Feed ids come in from a URL path, so they are untrusted input. Anything
 * outside this shape is rejected rather than sanitised — a `..` that gets
 * cleaned into something plausible is worse than one that gets refused.
 */
const FEED_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function isValidFeedId(id: string): boolean {
  return FEED_ID.test(id);
}

function feedDir(feedId: string): string {
  if (!isValidFeedId(feedId)) throw new Error(`invalid feed id: ${feedId}`);
  return join(FEED_ROOT, feedId);
}

export type StoredFeed = {
  metadata: ACPFeedMetadata;
  products: ACPProduct[];
  /** Content hash of the products file. Serves as the ETag. */
  etag: string;
};

export async function writeFeed(feed: Feed): Promise<void> {
  const dir = feedDir(feed.metadata.id);
  await mkdir(dir, { recursive: true });
  // Full replacement, matching the spec's file-ingestion semantics: products
  // absent from the new snapshot are gone, not merged.
  await writeFile(join(dir, "products.jsonl"), toProductsJsonl(feed.products), "utf8");
  await writeFile(join(dir, "metadata.json"), JSON.stringify(feed.metadata, null, 2), "utf8");
}

export async function readFeed(feedId: string): Promise<StoredFeed | null> {
  if (!isValidFeedId(feedId)) return null;
  const dir = feedDir(feedId);

  let metadataRaw: string;
  let productsRaw: string;
  try {
    [metadataRaw, productsRaw] = await Promise.all([
      readFile(join(dir, "metadata.json"), "utf8"),
      readFile(join(dir, "products.jsonl"), "utf8"),
    ]);
  } catch {
    return null;
  }

  return {
    metadata: JSON.parse(metadataRaw) as ACPFeedMetadata,
    products: parseProductsJsonl(productsRaw),
    etag: `"${createHash("sha256").update(productsRaw).digest("hex").slice(0, 32)}"`,
  };
}
