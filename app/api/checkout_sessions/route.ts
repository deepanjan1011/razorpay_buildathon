/**
 * POST /api/checkout_sessions — create a session. DESIGN.md §2.
 *
 * No payment happens here or anywhere in this directory yet. The session is
 * priced from the live catalogue and returned as authoritative state.
 */
import { connect } from "../../../lib/db/sql.ts";
import {
  checkHeaders,
  conformantSession,
  errorResponse,
  readBody,
  withIdempotency,
  aggregate,
} from "../../../lib/checkout/http.ts";
import { createSession } from "../../../lib/checkout/session.ts";

export const dynamic = "force-dynamic";

const ENDPOINT = "POST /checkout_sessions";

/**
 * Which merchant's catalogue to price against.
 *
 * Phase 2 stub: a header, because there is no agent authentication yet. Phase 3
 * replaces this with the authenticated identity — until then it is stated as a
 * stub rather than pretending the Authorization header means something.
 */
function merchantOf(request: Request): string | null {
  const id = request.headers.get("x-merchant-id") ?? "";
  return /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : null;
}

export async function POST(request: Request): Promise<Response> {
  const headerError = checkHeaders(request, { post: true });
  if (headerError) return headerError;

  const merchantId = merchantOf(request);
  if (!merchantId) {
    return errorResponse(400, {
      type: "invalid_request",
      code: "invalid_request",
      message: "X-Merchant-Id header is required and must be [A-Za-z0-9_-]{1,64}",
      param: "X-Merchant-Id",
    });
  }

  const parsed = await readBody(request, "CheckoutSessionCreateRequest");
  if (!parsed.ok) return parsed.response;

  const items = (parsed.body["line_items"] as Array<{ id: string }>) ?? [];
  if (items.length === 0) {
    return errorResponse(400, {
      type: "invalid_request",
      code: "invalid_request",
      message: "line_items must contain at least one item",
      param: "$.line_items",
    });
  }

  const requested = aggregate(items);

  try {
    const sql = await connect();
    const gate = await withIdempotency(sql, request, ENDPOINT, merchantId, parsed.body);
    if (gate.kind === "replay" || gate.kind === "conflict") return gate.response;

    const session = await createSession(sql, merchantId, requested);
    // Stored BEFORE responding, so a retry that arrives while the client is
    // still reading this response replays rather than creating a second session.
    await gate.commit(201, session);
    return conformantSession(201, session);
  } catch (error) {
    console.error("[checkout] create failed:", error);
    return errorResponse(500, {
      type: "processing_error",
      code: "session_create_failed",
      message: "Could not create the checkout session",
    });
  }
}
