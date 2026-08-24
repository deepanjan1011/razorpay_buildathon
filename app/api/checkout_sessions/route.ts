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
import { authenticate } from "../../../lib/auth/agent.ts";

export const dynamic = "force-dynamic";

const ENDPOINT = "POST /checkout_sessions";

export async function POST(request: Request): Promise<Response> {
  const headerError = checkHeaders(request, { post: true });
  if (headerError) return headerError;

  // THE MERCHANT COMES FROM THE CREDENTIAL, NEVER FROM A HEADER.
  //
  // The Phase 2 stub read `X-Merchant-Id` off the request, which meant any
  // caller could name any merchant and transact against their catalogue. There
  // is no longer a header that can say who you are acting for; the token says
  // it, and the token is verified.
  const sql = await connect();
  const agent = await authenticate(sql, request);
  if (!agent) {
    return errorResponse(401, {
      type: "invalid_request",
      code: "invalid_credential",
      message: "Authorization must carry a valid agent credential",
      param: "Authorization",
    });
  }
  const merchantId = agent.merchant_id;

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
