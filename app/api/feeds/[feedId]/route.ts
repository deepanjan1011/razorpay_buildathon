/**
 * GET /api/feeds/{id} — ACP FeedMetadata.
 *
 * rfc.product_feeds.md conformance: MUST return the current FeedMetadata, or
 * 404 if the feed does not exist.
 */
import { feedNotFound, conformantJson, versionMismatch } from "../../../../lib/feed/http.ts";
import { readFeed } from "../../../../lib/feed/store.ts";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ feedId: string }> },
): Promise<Response> {
  const mismatch = versionMismatch(request);
  if (mismatch) return mismatch;

  const { feedId } = await context.params;
  const feed = await readFeed(feedId);
  // An invalid id and a missing feed are the same answer on purpose: replying
  // "malformed id" to `../../etc/passwd` confirms the shape of what we store.
  if (!feed) return feedNotFound(feedId);

  return conformantJson("FeedMetadata", feed.metadata);
}
