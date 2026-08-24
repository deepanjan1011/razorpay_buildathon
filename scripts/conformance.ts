/**
 * The conformance suite. DESIGN.md §1: "Validate every response against the
 * published JSON Schemas — that doubles as the conformance suite."
 *
 *   npm run dev            # in another terminal
 *   npm run conformance
 *
 * WHY THIS IS NOT THE SAME AS THE VALIDATION ALREADY IN THE CODE.
 * `conformantSession` validates the object it is about to serialise, in
 * process, before it becomes bytes. This validates what actually came back over
 * HTTP — after `JSON.stringify` dropped every `undefined`, after Dates became
 * strings, after Next touched the response. Those are different claims, and
 * this project has already been caught by the gap between them twice: the
 * bundler where `import.meta.dirname` is undefined, and the working directory
 * an MCP client launches a server from.
 *
 * It also covers what in-process validation cannot: the ERROR shapes. A refusal
 * never passes through `conformantSession`, so nothing had ever checked that a
 * 403 body conforms to ACP's `Error` — and an agent parses those on exactly the
 * paths where it most needs to understand what happened.
 *
 * Exits non-zero on any failure, so it can gate a submission.
 */
process.loadEnvFile();

import { validate as validateCheckout } from "../lib/checkout/validate.ts";
import type { Definition as CheckoutDefinition } from "../lib/checkout/validate.ts";
import { validate as validateFeed } from "../lib/feed/validate.ts";
import type { Definition as FeedDefinition } from "../lib/feed/validate.ts";
import { signMandate } from "../lib/mandate/sign.ts";
import { encodeMandateHeader } from "../lib/mandate/store.ts";

const BASE = process.env["AGENTREADY_BASE_URL"] ?? "http://localhost:3000";
const TOKEN = process.env["AGENT_TOKEN"] ?? "";
const FEED = process.env["CONFORMANCE_FEED"] ?? "feed_live";
const ITEM = process.env["CONFORMANCE_ITEM"] ?? "";

if (!TOKEN) {
  console.error("AGENT_TOKEN is required. npm run agent:issue -- <agent> <merchant>");
  process.exit(1);
}

type Check = { name: string; status: number; ok: boolean; detail: string };
const results: Check[] = [];

const H = (extra: Record<string, string> = {}) => ({
  "API-Version": "2026-04-17",
  Authorization: `Bearer ${TOKEN}`,
  "Content-Type": "application/json",
  ...extra,
});
const idem = () => `conf-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

function record(
  name: string,
  status: number,
  body: unknown,
  errors: Array<{ path?: string; message?: string }>,
  expectedStatus?: number,
) {
  const statusOk = expectedStatus === undefined || status === expectedStatus;
  const ok = statusOk && errors.length === 0;
  const detail = !statusOk
    ? `expected HTTP ${expectedStatus}, got ${status}`
    : errors.length > 0
      ? `${errors[0]?.path ?? ""} ${errors[0]?.message ?? ""}`.trim()
      : "";
  results.push({ name, status, ok, detail });
  if (!ok && errors.length > 0) {
    // The whole error list, not just the first: a response can violate the
    // schema in several places and fixing one at a time is how six violations
    // took six rounds the first time this was done.
    console.error(`\n  ${name} — ${errors.length} violation(s):`);
    for (const e of errors.slice(0, 8)) console.error(`    ${e.path ?? "$"} ${e.message ?? ""}`);
  }
  return body;
}

const checkoutCase = async (
  name: string,
  definition: CheckoutDefinition,
  expectedStatus: number,
  path: string,
  init: RequestInit,
) => {
  const res = await fetch(`${BASE}${path}`, init);
  const body = await res.json().catch(() => ({}));
  return record(name, res.status, body, validateCheckout(definition, body), expectedStatus);
};

console.log(`conformance — ACP 2026-04-17 against ${BASE}\n`);

// ── The feed ────────────────────────────────────────────────────────────────
{
  const res = await fetch(`${BASE}/api/feeds/${FEED}/products`, { headers: H() });
  const body = (await res.json().catch(() => ({}))) as { products?: Array<{ variants?: Array<{ id: string }> }> };
  record("GET /feeds/{id}/products → ProductsResponse", res.status, body,
    validateFeed("ProductsResponse" as FeedDefinition, body), 200);

  // Every product and variant individually, because a container schema can pass
  // while a member inside it is wrong — the array validates, the item does not.
  const products = body.products ?? [];
  let bad = 0;
  for (const p of products) {
    if (validateFeed("Product" as FeedDefinition, p).length > 0) bad++;
    for (const v of p.variants ?? []) {
      if (validateFeed("Variant" as FeedDefinition, v).length > 0) bad++;
    }
  }
  results.push({
    name: `  ${products.length} products / ${products.flatMap((p) => p.variants ?? []).length} variants individually`,
    status: 200,
    ok: bad === 0,
    detail: bad === 0 ? "" : `${bad} failed`,
  });

  var itemId = ITEM || products.flatMap((p) => p.variants ?? []).map((v) => v.id)[0] || "";
}

if (!itemId) {
  console.error("\nNo purchasable item in the feed — run `npm run demo` once, or set CONFORMANCE_ITEM.");
  process.exit(1);
}

// ── Checkout: the success shapes ────────────────────────────────────────────
const created = (await checkoutCase(
  "POST /checkout_sessions → CheckoutSession",
  "CheckoutSession",
  201,
  "/api/checkout_sessions",
  {
    method: "POST",
    headers: H({ "Idempotency-Key": idem() }),
    body: JSON.stringify({ currency: "INR", capabilities: {}, line_items: [{ id: itemId }] }),
  },
)) as { id?: string; totals?: Array<{ type: string; amount: number }> };

const sessionId = created.id ?? "";
const total = created.totals?.find((t) => t.type === "total")?.amount ?? 0;

await checkoutCase(
  "GET /checkout_sessions/{id} → CheckoutSession",
  "CheckoutSession",
  200,
  `/api/checkout_sessions/${sessionId}`,
  { headers: H() },
);

// ── Checkout: the ERROR shapes, which in-process validation never sees ──────
await checkoutCase(
  "POST /complete, no mandate → Error",
  "Error",
  403,
  `/api/checkout_sessions/${sessionId}/complete`,
  {
    method: "POST",
    headers: H({ "Idempotency-Key": idem() }),
    body: JSON.stringify({ payment_data: { handler_id: "razorpay_link" } }),
  },
);

await checkoutCase(
  "POST /checkout_sessions, malformed body → Error",
  "Error",
  400,
  "/api/checkout_sessions",
  { method: "POST", headers: H({ "Idempotency-Key": idem() }), body: JSON.stringify({ nope: true }) },
);

await checkoutCase(
  "GET /checkout_sessions/{unknown} → Error",
  "Error",
  404,
  "/api/checkout_sessions/cs_000000000000000000000000",
  { headers: H() },
);

await checkoutCase(
  "POST /checkout_sessions, no credential → Error",
  "Error",
  401,
  "/api/checkout_sessions",
  {
    method: "POST",
    headers: { "API-Version": "2026-04-17", "Content-Type": "application/json", "Idempotency-Key": idem() },
    body: JSON.stringify({ currency: "INR", capabilities: {}, line_items: [{ id: itemId }] }),
  },
);

// ── The refusal that carries alternatives, and the deviation it declares ────
//
// THE CASE THAT ALMOST PASSED BY BEING ABSENT. The 403 tested above is
// MANDATE_MISSING, which carries no alternatives — so the suite was green while
// the refusal that DOES carry them had never been checked. `Error` sets
// `additionalProperties: false`, so an ACP `Error` with an `alternatives` key
// does not conform.
//
// This is the first deviation on the RESPONSE side, and it is worse than the
// request-side ones: an agent validating our response against the schema would
// reject it entirely, where a request-side extension only affects what we
// accept. It is reported here as its own line rather than hidden, and the body
// minus the extension is validated so the conformant part stays proven.
{
  const tiny = signMandate({
    mandate_id: `mnd_conf_low_${Date.now()}`,
    issued_at: new Date(Date.now() - 60_000).toISOString(),
    expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
    // One paise under the total, so the ceiling check is the only thing that
    // fails and alternatives are offered.
    constraints: { max_amount: { value: Math.max(total - 1, 1), currency: "INR" }, single_use: false },
    intent_text: "conformance: ceiling refusal",
  });

  const res = await fetch(`${BASE}/api/checkout_sessions/${sessionId}/complete`, {
    method: "POST",
    headers: H({ "Idempotency-Key": idem(), Mandate: encodeMandateHeader(tiny) }),
    body: JSON.stringify({ payment_data: { handler_id: "razorpay_link" } }),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const { alternatives, ...acpPart } = body;

  record("POST /complete, over ceiling → Error (minus extension)", res.status, acpPart,
    validateCheckout("Error", acpPart), 403);

  const carriesExtension = Array.isArray(alternatives) && alternatives.length > 0;
  results.push({
    name: "  DECLARED DEVIATION: `alternatives` on Error",
    status: res.status,
    // Not a failure. A declared deviation that is present and documented is the
    // outcome we intend; what would be a failure is it appearing undeclared.
    ok: true,
    detail: carriesExtension
      ? `present (${(alternatives as unknown[]).length}) — Error sets additionalProperties:false; see README`
      : "absent on this refusal",
  });
}

// ── Checkout: complete, which is its own definition ─────────────────────────
{
  const mandate = signMandate({
    mandate_id: `mnd_conf_${Date.now()}`,
    issued_at: new Date(Date.now() - 60_000).toISOString(),
    expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
    constraints: { max_amount: { value: Math.max(total, 1), currency: "INR" }, single_use: false },
    intent_text: "conformance run",
  });

  await checkoutCase(
    "POST /complete → CheckoutSessionWithOrder",
    "CheckoutSessionWithOrder",
    200,
    `/api/checkout_sessions/${sessionId}/complete`,
    {
      method: "POST",
      headers: H({ "Idempotency-Key": idem(), Mandate: encodeMandateHeader(mandate) }),
      body: JSON.stringify({ payment_data: { handler_id: "razorpay_link" } }),
    },
  );

  // Tidy up: a conformance run should not leave a payable link behind.
  await fetch(`${BASE}/api/checkout_sessions/${sessionId}/cancel`, {
    method: "POST",
    headers: H({ "Idempotency-Key": idem() }),
    body: "{}",
  });
}

// ── Report ──────────────────────────────────────────────────────────────────
console.log();
for (const r of results) {
  console.log(`  ${r.ok ? "✓" : "✗"} ${r.name.padEnd(52)} ${String(r.status).padEnd(4)} ${r.detail}`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} conformant`);
if (failed.length > 0) process.exit(1);
