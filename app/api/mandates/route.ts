/**
 * POST /api/mandates — issue a signed mandate.
 *
 * WHY THIS EXISTS AS AN ENDPOINT AND NOT A TEST FIXTURE. Phase 4's gate is a
 * real agent completing a purchase, and an agent cannot present a mandate it
 * has no way to obtain. A mandate that only exists inside the test suite makes
 * the gate unreachable from outside it.
 *
 * WHAT THIS IS NOT: the arrangement a mandate ultimately wants. Here the SELLER
 * issues, on a human's stated instruction, and signs with a shared secret — so
 * the verifier could have issued what it verifies. The real shape is the
 * buyer's own agent issuing under a key the seller only has the public half of.
 * That needs asymmetric keys, distribution and rotation, and is named as a gap
 * in the README rather than implied away. What this DOES demonstrate is the
 * property under test: a payment call cannot happen without a mandate whose
 * bytes match its signature and whose constraints the cart satisfies.
 *
 * Not an ACP endpoint. ACP has no mandate concept — its nearest equivalent is
 * the Delegated Payment Spec, which Razorpay cannot participate in.
 */
import { randomUUID } from "node:crypto";

import { signMandate } from "../../../lib/mandate/sign.ts";
import { encodeMandateHeader } from "../../../lib/mandate/store.ts";
import { isCategory } from "../../../lib/normalize/taxonomy.ts";
import type { Category } from "../../../lib/normalize/taxonomy.ts";
import type { MandateConstraints } from "../../../lib/mandate/schema.ts";

export const dynamic = "force-dynamic";

/** Long enough to shop, short enough that a leaked mandate is not a standing risk. */
const DEFAULT_TTL_MINUTES = 60;
const MAX_TTL_MINUTES = 24 * 60;

function bad(message: string, param?: string): Response {
  return new Response(
    JSON.stringify({ type: "invalid_request", code: "invalid_request", message, param }),
    { status: 400, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } },
  );
}

export async function POST(request: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return bad("Request body is not valid JSON");
  }

  const maxAmount = body["max_amount"];
  if (typeof maxAmount !== "number" || !Number.isInteger(maxAmount) || maxAmount <= 0) {
    // Integer minor units, invariant 6. A float here is a ceiling that rounds,
    // and a ceiling that rounds is a ceiling nobody agreed to.
    return bad("max_amount must be a positive integer in minor units (paise)", "$.max_amount");
  }

  const rawCategories = body["categories"];
  let categories: Category[] | undefined;
  if (rawCategories !== undefined) {
    if (!Array.isArray(rawCategories) || rawCategories.some((c) => typeof c !== "string")) {
      return bad("categories must be an array of strings when present", "$.categories");
    }
    const unknown = rawCategories.filter((c) => !isCategory(c as string));
    if (unknown.length > 0) {
      // Refused rather than dropped. Silently discarding an unrecognised
      // category would widen the mandate beyond what was asked for — the buyer
      // said "footwear only" and got "anything".
      return bad(`Not categories in this taxonomy: ${unknown.join(", ")}`, "$.categories");
    }
    categories = rawCategories as Category[];
  }
  // ABSENT and EMPTY are different mandates and both are issuable: absent
  // authorises any category, empty authorises none. The gate reads them that
  // way too; conflating them here would erase the distinction at the source.

  const maxItems = body["max_items"];
  if (maxItems !== undefined && (typeof maxItems !== "number" || !Number.isInteger(maxItems) || maxItems < 1)) {
    return bad("max_items must be a positive integer when present", "$.max_items");
  }

  const ttl = body["ttl_minutes"];
  if (ttl !== undefined && (typeof ttl !== "number" || ttl <= 0 || ttl > MAX_TTL_MINUTES)) {
    return bad(`ttl_minutes must be between 1 and ${MAX_TTL_MINUTES}`, "$.ttl_minutes");
  }
  const minutes = typeof ttl === "number" ? ttl : DEFAULT_TTL_MINUTES;

  const constraints: MandateConstraints = {
    max_amount: { value: maxAmount, currency: typeof body["currency"] === "string" ? body["currency"] : "INR" },
    ...(categories !== undefined ? { categories } : {}),
    ...(typeof maxItems === "number" ? { max_items: maxItems } : {}),
    // Single-use by DEFAULT. A reusable mandate is a standing authority, and
    // the safe default for authority is that it is spent once.
    single_use: body["single_use"] !== false,
  };

  const now = new Date();
  let mandate;
  try {
    mandate = signMandate({
      mandate_id: `mnd_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
      issued_at: now.toISOString(),
      expires_at: new Date(now.getTime() + minutes * 60_000).toISOString(),
      constraints,
      // The human's words, kept verbatim and never parsed at payment time —
      // invariant 1 keeps the model out of the charge decision entirely.
      intent_text: typeof body["intent_text"] === "string" ? body["intent_text"] : "",
    });
  } catch {
    return new Response(
      JSON.stringify({
        type: "service_unavailable",
        code: "signing_not_configured",
        message: "MANDATE_SIGNING_SECRET is not set; this server cannot issue mandates",
      }),
      { status: 503, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } },
    );
  }

  return new Response(
    JSON.stringify({
      mandate,
      // Ready to put straight in the `Mandate` header of a complete request.
      // An agent should not have to work out our encoding from prose.
      mandate_header: encodeMandateHeader(mandate),
    }),
    { status: 201, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } },
  );
}
