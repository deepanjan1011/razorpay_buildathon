/**
 * POST /api/checkout_sessions/{id}/cancel — cancel if not completed.
 *
 * Cancelling twice succeeds: the agent may be retrying, and the state it wants
 * is already true. Cancelling a COMPLETED session does not, because money moved
 * against it — that needs a refund, which is a different operation with a
 * different audit trail.
 */
import { connect } from "../../../../../lib/db/sql.ts";
import {
  checkHeaders,
  conformantSession,
  errorResponse,
  withIdempotency,
} from "../../../../../lib/checkout/http.ts";
import { cancelSession } from "../../../../../lib/checkout/session.ts";
import { razorpayClient } from "../../../../../lib/checkout/razorpay.ts";

export const dynamic = "force-dynamic";

const SESSION_ID = /^cs_[a-f0-9]{24}$/;

export async function POST(
  request: Request,
  context: { params: Promise<{ sessionId: string }> },
): Promise<Response> {
  const headerError = checkHeaders(request, { post: true });
  if (headerError) return headerError;

  const { sessionId } = await context.params;
  if (!SESSION_ID.test(sessionId)) {
    return errorResponse(404, {
      type: "invalid_request",
      code: "session_not_found",
      message: `Checkout session not found: ${sessionId}`,
      param: "checkout_session_id",
    });
  }

  try {
    const sql = await connect();
    const gate = await withIdempotency(
      sql,
      request,
      `POST /checkout_sessions/${sessionId}/cancel`,
      sessionId,
      // Cancel has no body, so the empty object is the request. Two cancels
      // with the same key are therefore a replay, never a conflict.
      {},
    );
    if (gate.kind === "replay" || gate.kind === "conflict") return gate.response;

    const result = await cancelSession(sql, sessionId, new Date(), razorpayClient());
    if (result === null) {
      return errorResponse(404, {
        type: "invalid_request",
        code: "session_not_found",
        message: `Checkout session not found: ${sessionId}`,
        param: "checkout_session_id",
      });
    }

    if (!result.ok) {
      const body = {
        type: "invalid_request" as const,
        code: result.code,
        message: result.message,
      };
      await gate.commit(409, body);
      return errorResponse(409, { ...body, param: "checkout_session_id" });
    }

    await gate.commit(200, result.session);
    return conformantSession(200, result.session);
  } catch (error) {
    console.error("[checkout] cancel failed:", error);
    return errorResponse(500, {
      type: "processing_error",
      code: "session_cancel_failed",
      message: "Could not cancel the checkout session",
    });
  }
}
