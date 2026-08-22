/**
 * GET /api/feeds/{id}/products — ACP ProductsResponse.
 *
 * rfc.product_feeds.md conformance: MUST return the FULL current product set.
 * No pagination, deliberately — the spec's read is a snapshot, and an agent
 * rebuilding its index needs the whole thing. §7 notes pagination as an option
 * for large catalogues; a small merchant's sheet is not that, and adding paging
 * now would be an untested code path serving no one.
 *
 * Only servable products are here at all: the projection withholds anything
 * carrying a withholding flag before it is ever written to the store, so this
 * handler has no filtering to do and no way to accidentally skip it.
 */
import {
  feedNotFound,
  conformantJson,
  notModified,
  versionMismatch,
} from "../../../../../lib/feed/http.ts";
import { readFeed } from "../../../../../lib/feed/store.ts";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ feedId: string }> },
): Promise<Response> {
  const mismatch = versionMismatch(request);
  if (mismatch) return mismatch;

  const { feedId } = await context.params;
  const feed = await readFeed(feedId);
  if (!feed) return feedNotFound(feedId);

  const fresh = notModified(request, feed.etag);
  if (fresh) return fresh;

  return conformantJson("ProductsResponse", { products: feed.products }, { etag: feed.etag });
}
