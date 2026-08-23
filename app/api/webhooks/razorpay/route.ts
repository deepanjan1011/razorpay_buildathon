/**
 * POST /api/webhooks/razorpay — the one endpoint an unauthenticated stranger
 * can reach. Everything it decides lives in lib/checkout/webhook.ts and is
 * unit-tested without a database, a network or a payment.
 *
 * THE BODY IS READ AS TEXT AND NEVER RE-SERIALISED. The signature is over the
 * exact bytes Razorpay sent; `request.json()` here would silently break every
 * verification, and it would break it in the direction that rejects genuine
 * events rather than accepting forged ones — which is the failure that gets
 * "fixed" at 2am by disabling the check.
 */
import { connect } from "../../../../lib/db/sql.ts";
import { handleEvent, parseEvent, verifySignature } from "../../../../lib/checkout/webhook.ts";

function reply(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export async function POST(request: Request): Promise<Response> {
  const secret = process.env["RAZORPAY_WEBHOOK_SECRET"];
  if (!secret) {
    // Not a 200. Accepting unverifiable events because the server is
    // misconfigured is how an unsigned endpoint ships.
    console.error("[webhook] RAZORPAY_WEBHOOK_SECRET is not set; refusing all events");
    return reply(503, { error: "webhook_not_configured" });
  }

  const rawBody = await request.text();

  if (!verifySignature(rawBody, request.headers.get("x-razorpay-signature"), secret)) {
    // No detail in the response. A verifier that explains why it failed is a
    // verifier that helps someone iterate towards a forgery.
    return reply(401, { error: "invalid_signature" });
  }

  // Deduplication is keyed on this header because the payload has no event id.
  const eventId = request.headers.get("x-razorpay-event-id");
  if (!eventId) {
    return reply(400, { error: "missing_event_id" });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return reply(400, { error: "invalid_json" });
  }

  const event = parseEvent(parsed, eventId);
  if (!event) {
    return reply(400, { error: "unrecognised_event_shape" });
  }

  const sql = await connect();
  const { duplicate, decision } = await handleEvent(sql, event);

  // 200 for everything we understood, including outcomes we refused to act on.
  // A non-2xx makes Razorpay redeliver, and redelivering an event whose meaning
  // is "this payment does not match the cart" produces the same answer forever.
  console.info(
    `[webhook] ${event.event} ${event.event_id} -> ${decision.outcome} ${decision.reason_code}` +
      (duplicate ? " (duplicate)" : ""),
  );
  return reply(200, {
    received: true,
    duplicate,
    outcome: decision.outcome,
    reason_code: decision.reason_code,
  });
}
