/**
 * GET  /api/checkout_sessions/{id} — retrieve, re-priced from the catalogue.
 * POST /api/checkout_sessions/{id} — update the cart.
 *
 * ACP uses POST rather than PATCH for the update, which is why both verbs live
 * here on the same path.
 */
import { connect } from "../../../../lib/db/sql.ts";
import {
  checkHeaders,
  conformantSession,
  errorResponse,
  readBody,
  withIdempotency,
  aggregate,
} from "../../../../lib/checkout/http.ts";
import { getSession, updateSession } from "../../../../lib/checkout/session.ts";
import type { RequestedItem } from "../../../../lib/checkout/session.ts";

export const dynamic = "force-dynamic";

const SESSION_ID = /^cs_[a-f0-9]{24}$/;

function notFound(id: string): Response {
  return errorResponse(404, {
    type: "invalid_request",
    code: "session_not_found",
    message: `Checkout session not found: ${id}`,
    param: "checkout_session_id",
  });
}

export async function GET(
  request: Request,
  context: { params: Promise<{ sessionId: string }> },
): Promise<Response> {
  const headerError = checkHeaders(request, { post: false });
  if (headerError) return headerError;

  const { sessionId } = await context.params;
  // A malformed id is answered identically to a missing one: telling a caller
  // that their id was the wrong SHAPE confirms what shape real ids are.
  if (!SESSION_ID.test(sessionId)) return notFound(sessionId);

  try {
    const session = await getSession(await connect(), sessionId);
    if (!session) return notFound(sessionId);
    // Re-priced from the live catalogue by getSession, not replayed — see
    // lib/checkout/session.ts on why a GET must not serve a stale price.
    return conformantSession(200, session);
  } catch (error) {
    console.error("[checkout] retrieve failed:", error);
    return errorResponse(500, {
      type: "processing_error",
      code: "session_unavailable",
      message: "Could not read the checkout session",
    });
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ sessionId: string }> },
): Promise<Response> {
  const headerError = checkHeaders(request, { post: true });
  if (headerError) return headerError;

  const { sessionId } = await context.params;
  if (!SESSION_ID.test(sessionId)) return notFound(sessionId);

  const parsed = await readBody(request, "CheckoutSessionUpdateRequest");
  if (!parsed.ok) return parsed.response;

  try {
    const sql = await connect();
    // Scoped per session, so the same key on two different sessions is two
    // different operations rather than a collision.
    const gate = await withIdempotency(
      sql,
      request,
      `POST /checkout_sessions/${sessionId}`,
      sessionId,
      parsed.body,
    );
    if (gate.kind === "replay" || gate.kind === "conflict") return gate.response;

    const items = parsed.body["line_items"] as Array<{ id: string }> | undefined;
    const patch: { line_items?: RequestedItem[] } = {};
    // Quantity by repetition, same as create — Item has no quantity field.
    if (items) patch.line_items = aggregate(items);

    const result = await updateSession(sql, sessionId, patch);
    if (result === null) return notFound(sessionId);

    if (!result.ok) {
      // A terminal session refusing modification is a 409: the request is
      // well-formed, the state forbids it.
      const response = errorResponse(409, {
        type: "invalid_request",
        code: result.code,
        message: result.message,
        param: "checkout_session_id",
      });
      await gate.commit(409, {
        type: "invalid_request",
        code: result.code,
        message: result.message,
      });
      return response;
    }

    await gate.commit(200, result.session);
    return conformantSession(200, result.session);
  } catch (error) {
    console.error("[checkout] update failed:", error);
    return errorResponse(500, {
      type: "processing_error",
      code: "session_update_failed",
      message: "Could not update the checkout session",
    });
  }
}
