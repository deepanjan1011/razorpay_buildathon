/**
 * Shared HTTP behaviour for the feed read surface. PHASE-1.md §6.
 *
 * TRANSPORT DEVIATION, restated because it is easy to forget when reading route
 * handlers: in ACP the Product Feed API is hosted by the AGENT, and
 * `rfc.product_feeds.md` §3.1 says agents MUST NOT call feed endpoints on
 * merchants. A merchant on no platform has no agent-hosted feed service to push
 * to. So we serve the spec's resource shapes from the merchant side, which is
 * conformant in payload and deliberately not in direction. See OBSTACLES.md
 * Decision 1.
 */
import { ACP_API_VERSION } from "./acp.ts";
import { validate } from "./validate.ts";
import type { Definition } from "./validate.ts";

/** ACP's flat error shape — `schema.feed.json` $defs.Error. */
export type AcpError = {
  type: string;
  code: string;
  message: string;
  param?: string;
};

export function errorResponse(status: number, error: AcpError): Response {
  return new Response(JSON.stringify(error), {
    status,
    headers: {
      "Content-Type": "application/json",
      "API-Version": ACP_API_VERSION,
      "Cache-Control": "no-store",
    },
  });
}

export const feedNotFound = (feedId: string): Response =>
  errorResponse(404, {
    type: "invalid_request",
    code: "feed_not_found",
    // The id is echoed because an agent holding a stale feed id needs to know
    // WHICH one is gone. It is validated before it reaches here.
    message: `Feed not found: ${feedId}`,
    param: "id",
  });

/**
 * `API-Version` is required by the RFC. We accept its absence — an agent that
 * omits it gets the only version we have, which cannot surprise it — but reject
 * a MISMATCH, because that is an agent expecting a contract we do not serve and
 * failing loudly is kinder than answering in the wrong shape.
 */
export function versionMismatch(request: Request): Response | null {
  const requested = request.headers.get("api-version");
  if (requested === null || requested === ACP_API_VERSION) return null;
  return errorResponse(400, {
    type: "invalid_request",
    code: "unsupported_api_version",
    message: `This feed serves API-Version ${ACP_API_VERSION}, not ${requested}`,
    param: "API-Version",
  });
}

/**
 * Serves a payload only if it validates against the pinned ACP schema.
 *
 * DESIGN.md §2 says validate every response against the published schemas. A
 * validator that only runs in tests validates the test fixtures; running it on
 * the real response is what makes the claim true. If our own feed is
 * malformed, a 500 naming the violation is far better than a 200 that quietly
 * teaches an agent the wrong shape — and this is the last point at which
 * anyone on our side can notice.
 */
export function conformantJson(
  definition: Definition,
  payload: unknown,
  init: { etag?: string; maxAge?: number } = {},
): Response {
  const errors = validate(definition, payload);
  if (errors.length > 0) {
    console.error(
      `[feed] outbound ${definition} failed ACP ${ACP_API_VERSION} validation:`,
      errors,
    );
    return errorResponse(500, {
      type: "server_error",
      code: "feed_schema_violation",
      message: `Generated feed does not conform to ACP ${ACP_API_VERSION}`,
    });
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "API-Version": ACP_API_VERSION,
    // Stable and cacheable (PHASE-1.md §6). Short max-age with revalidation:
    // feed price and availability are explicitly NOT guaranteed
    // (rfc.product_feeds.md §7) and checkout is authoritative, so a stale read
    // is safe — but a long TTL would make a price correction invisible for
    // longer than a merchant would expect.
    "Cache-Control": `public, max-age=${init.maxAge ?? 60}, must-revalidate`,
  };
  if (init.etag) headers["ETag"] = init.etag;

  return new Response(JSON.stringify(payload), { status: 200, headers });
}

/** 304 when the agent already has this exact body. */
export function notModified(request: Request, etag: string): Response | null {
  if (request.headers.get("if-none-match") !== etag) return null;
  return new Response(null, {
    status: 304,
    headers: { ETag: etag, "API-Version": ACP_API_VERSION },
  });
}
