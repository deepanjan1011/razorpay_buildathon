/**
 * POST /api/checkout_sessions/{id}/complete — finalise the cart and hand back a
 * payment link. NO CHARGE OCCURS HERE (DESIGN.md §2).
 *
 * The response is a `CheckoutSessionWithOrder`, validated as such rather than as
 * a `CheckoutSession`: the order is required by that definition, and validating
 * against the narrower one would pass a response with no order in it.
 */
import { connect } from "../../../../../lib/db/sql.ts";
import {
  checkHeaders,
  conformantSession,
  errorResponse,
  readBody,
  withIdempotency,
} from "../../../../../lib/checkout/http.ts";
import { completeSession } from "../../../../../lib/checkout/complete.ts";
import type { CompleteRequest } from "../../../../../lib/checkout/complete.ts";
import { razorpayClient } from "../../../../../lib/checkout/razorpay.ts";
import { parseMandateHeader } from "../../../../../lib/mandate/store.ts";
import { authenticate } from "../../../../../lib/auth/agent.ts";
import { ownsSession } from "../../../../../lib/auth/scope.ts";

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

  const parsed = await readBody(request, "CheckoutSessionCompleteRequest");
  if (!parsed.ok) return parsed.response;

  try {
    const sql = await connect();

    // WHO IS ASKING, AND IS THIS THEIRS. Neither was checked before: the id
    // came from the path and nothing tied it to a caller, so anyone holding a
    // session id could drive someone else's checkout. 404 rather than 403 for a
    // session belonging to another merchant — 403 confirms it exists.
    const agent = await authenticate(sql, request);
    if (!agent) {
      return errorResponse(401, {
        type: "invalid_request",
        code: "invalid_credential",
        message: "Authorization must carry a valid agent credential",
        param: "Authorization",
      });
    }
    if (!(await ownsSession(sql, agent.merchant_id, sessionId))) {
      return errorResponse(404, {
        type: "invalid_request",
        code: "session_not_found",
        message: `No checkout session ${sessionId}`,
      });
    }
    const gate = await withIdempotency(
      sql,
      request,
      `POST /checkout_sessions/${sessionId}/complete`,
      sessionId,
      parsed.body,
    );
    if (gate.kind === "replay" || gate.kind === "conflict") return gate.response;

    // The client is constructed AFTER the idempotency claim and only on the
    // path that can call it, so a misconfigured or non-test key fails the
    // request that would have spent money rather than every request.
    let outcome;
    try {
      // The mandate rides in a header: `additionalProperties: false` on the ACP
      // request body leaves no conformant place for a field ACP does not
      // define, and headers are where ACP carries its own `Signature`.
      // A malformed header parses to null and is refused BY THE GATE with
      // MANDATE_MISSING, rather than 400ing here — one place decides whether a
      // charge may happen, and it says why in the audit log.
      outcome = await completeSession(
        sql,
        sessionId,
        {
          ...(parsed.body as CompleteRequest),
          mandate: parseMandateHeader(request.headers.get("mandate")),
        },
        razorpayClient(),
      );
    } catch (error) {
      // The claim MUST be resolved. Leaving it at status 0 makes every retry of
      // this key a permanent `idempotency_in_flight` — the request wedges
      // itself, which is worse than the failure it is reporting.
      //
      // Recorded as a stored 502 rather than released, so this key cannot be
      // reused to attempt a second link. Retrying is a NEW attempt and takes a
      // NEW key, which is what invariant 4 means by no blind retry. If the link
      // was in fact created before the failure, Razorpay's own uniqueness rule
      // on `reference_id` — which is the session id — refuses the duplicate.
      console.error("[checkout] payment link creation failed:", error);
      const body = {
        type: "processing_error" as const,
        code: "payment_link_unavailable",
        message: "Could not create a payment link for this session",
      };
      await gate.commit(502, body);
      return errorResponse(502, body);
    }

    if (outcome === null) {
      return errorResponse(404, {
        type: "invalid_request",
        code: "session_not_found",
        message: `Checkout session not found: ${sessionId}`,
        param: "checkout_session_id",
      });
    }

    if (!outcome.ok) {
      const body = {
        type: "invalid_request" as const,
        code: outcome.code,
        message: outcome.message,
        // A refusal an agent can act on. ACP's Error schema has no slot for
        // this and sets additionalProperties: false, so it rides beside the
        // error rather than inside it — the same wall the mandate hit, and
        // declared the same way rather than dropped for tidiness.
        ...(outcome.alternatives && outcome.alternatives.length > 0
          ? { alternatives: outcome.alternatives }
          : {}),
      };
      // Committed to the idempotency record, so a retry of a refused complete
      // gets the same refusal rather than a second attempt at the PSP.
      await gate.commit(outcome.status, body);
      return errorResponse(outcome.status, { ...body, param: "checkout_session_id" });
    }

    await gate.commit(200, outcome.session);
    return conformantSession(200, outcome.session, "CheckoutSessionWithOrder");
  } catch (error) {
    console.error("[checkout] complete failed:", error);
    return errorResponse(502, {
      type: "processing_error",
      code: "payment_link_unavailable",
      // No retry here and none suggested to the agent beyond the idempotency
      // key it already holds: a blind retry against a payment provider is how
      // one cart becomes two links (CLAUDE.md invariant 4).
      message: "Could not create a payment link for this session",
    });
  }
}
