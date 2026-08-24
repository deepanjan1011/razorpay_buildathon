/**
 * The agent-facing MCP server. Phase 4.
 *
 * THREE TOOLS. Discover, create a session, complete it. Nothing else. Every
 * additional tool is surface that can fail in front of a judge, and none of it
 * is the gate — which is a real agent completing a purchase.
 *
 * IT SPEAKS HTTP TO OUR OWN API rather than importing the libraries directly,
 * and that is the whole point. Calling `completeSession` in-process would
 * bypass agent authentication, ACP schema validation, idempotency and the
 * `Mandate` header — every guard Phases 2 and 3 built lives in the HTTP layer.
 * A demo that skipped them would prove the demo works, not the product.
 *
 * NOT AN ENTRY POINT INTO THE JOB LAYER. CLAUDE.md gates Phase 4 on
 * re-deriving exactly-once extraction against every caller, because the
 * guarantee silently broke once when `POST /api/ingest` became a second one.
 * Re-derived, and the answer is that this surface never reaches it: ingest is
 * merchant-side, these three tools are buyer-side, and nothing under
 * lib/feed, lib/catalog, lib/checkout or lib/mandate imports lib/ingest/job.
 * A test asserts that this file never imports it, so an ingest tool added later
 * fails the build rather than quietly reopening the question.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { join } from "node:path";

// FALLS BACK TO .env, because an MCP server is launched by a client and
// inherits whatever environment that client happened to have. `.mcp.json` can
// interpolate ${AGENT_TOKEN}, but only if the variable is exported in the shell
// that started the client — and when it is not, every tool call comes back 401
// with nothing saying why. Every other part of this project reads .env; this
// had no reason to be the exception.
try {
  process.loadEnvFile();
} catch {
  /* no .env is fine when the environment already carries the token */
}

const BASE = process.env["AGENTREADY_BASE_URL"] ?? "http://localhost:3000";

/**
 * READ PER CALL, not once at startup.
 *
 * An MCP server is a long-lived process launched by a client. A token rotated
 * in `.env` while it runs would otherwise be invisible until someone restarted
 * the client — and the symptom is a 401, which reads as "your credential was
 * revoked" rather than "this process is holding a stale one". Reading it at
 * call time costs nothing and removes a debugging dead end.
 */
function token(): string {
  try {
    // RESOLVED AGAINST THIS FILE, NOT THE WORKING DIRECTORY.
    //
    // `process.loadEnvFile()` with no argument reads `${cwd}/.env`, and an MCP
    // server's cwd is whatever the CLIENT launched it with — for Claude Code
    // that is not necessarily the repo. So the bare call silently found
    // nothing, every tool call came back 401, and the token in .env was valid
    // the whole time. Same family as `import.meta.dirname` being undefined in a
    // bundle: code that works when you run it from the right directory and
    // stops when something else starts it.
    process.loadEnvFile(join(import.meta.dirname, "..", ".env"));
  } catch {
    /* no .env, or already in the environment */
  }
  return process.env["AGENT_TOKEN"] ?? "";
}
const API_VERSION = "2026-04-17";

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "API-Version": API_VERSION,
    Authorization: `Bearer ${token()}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

/** A fresh key per call. Invariant 4: retries are the caller's, not ours. */
const idem = () => `mcp-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;

type Json = Record<string, unknown>;

async function call(path: string, init: RequestInit): Promise<{ status: number; body: Json }> {
  if (!token()) {
    // Named rather than left as a 401. "invalid_credential" on every call is
    // indistinguishable from a revoked token, and sends whoever is debugging
    // to the wrong place entirely.
    return {
      status: 0,
      body: {
        error: "no_agent_token",
        message:
          "AGENT_TOKEN is not set. Mint one with `npm run agent:issue -- <agent> <merchant>` " +
          "and put it in .env, then restart the MCP client so the server picks it up.",
      },
    };
  }
  const res = await fetch(`${BASE}${path}`, init);
  const text = await res.text();
  let body: Json;
  try {
    body = text ? (JSON.parse(text) as Json) : {};
  } catch {
    body = { error: "non_json_response", raw: text.slice(0, 400) };
  }
  return { status: res.status, body };
}

/**
 * Tool results are text, and a refusal is a RESULT rather than a thrown error.
 *
 * An agent that receives an exception learns that something went wrong. An
 * agent that receives "MANDATE_CEILING_EXCEEDED — cart total 299900 exceeds
 * mandate ceiling 280000" can decide what to do about it, which is the whole
 * argument for reason codes carrying a human string beside them.
 */
const asText = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});

const server = new McpServer({ name: "agentready", version: "0.1.0" });

server.registerTool(
  "discover_products",
  {
    title: "Discover products",
    description:
      "List a merchant's purchasable products. Returns id, title, price in minor units " +
      "(paise), currency, availability and category. `availability` is in_stock, out_of_stock "
      + "or unknown — unknown means the merchant tracks no stock, which is normal and does "
      + "NOT mean unavailable. Use the returned id as the item id " +
      "when creating a checkout session.",
    inputSchema: {
      feed_id: z.string().describe("The merchant's feed id, e.g. feed_live"),
      query: z.string().optional().describe("Case-insensitive substring filter on the title"),
      limit: z.number().int().min(1).max(100).optional(),
    },
  },
  async ({ feed_id, query, limit }) => {
    const { status, body } = await call(`/api/feeds/${encodeURIComponent(feed_id)}/products`, {
      headers: headers(),
    });
    if (status !== 200) return asText({ error: "feed_unavailable", status, body });

    // VARIANTS, NOT PRODUCTS. The id an agent is handed here must be the id
    // checkout accepts, and checkout prices variants — a product id fed to
    // create_checkout_session resolves to nothing. The first version of this
    // tool returned product ids with undefined prices, which no unit test
    // noticed and the first real client run found in one call.
    const products = Array.isArray(body["products"]) ? (body["products"] as Json[]) : [];
    const variants = products.flatMap((p) => {
      const list = Array.isArray(p["variants"]) ? (p["variants"] as Json[]) : [];
      return list.map((v) => {
        const price = (v["price"] ?? {}) as Json;
        const availability = (v["availability"] ?? {}) as Json;
        const categories = Array.isArray(v["categories"]) ? (v["categories"] as Json[]) : [];
        return {
          id: v["id"],
          title: v["title"] ?? p["title"],
          price_minor: price["amount"],
          currency: price["currency"] ?? "INR",
          // THREE STATES, NOT TWO. The feed publishes unknown availability as an
          // ABSENT key — most small-merchant sheets have no stock column at
          // all, so "we do not know" is the common case, not the exception.
          // Collapsing absent to `false` made an entire real catalogue read as
          // out of stock, which is a different and false claim: the merchant
          // never said it was unavailable. Absent, empty and false are three
          // facts and this is the fourth place in this codebase where merging
          // two of them lost something that mattered.
          availability:
            availability["available"] === true
              ? "in_stock"
              : availability["available"] === false
                ? "out_of_stock"
                : "unknown",
          category: categories[0]?.["value"],
        };
      });
    });

    const needle = query?.toLowerCase();
    const matched = needle
      ? variants.filter((v) => String(v.title ?? "").toLowerCase().includes(needle))
      : variants;

    return asText({
      count: matched.length,
      note: "Use `id` as an item id in create_checkout_session.",
      products: matched.slice(0, limit ?? 20),
    });
  },
);

server.registerTool(
  "create_checkout_session",
  {
    title: "Create a checkout session",
    description:
      "Price a cart authoritatively. Returns the session id, its status and the totals " +
      "including delivery and tax. Quantity is expressed by repeating an item id — the " +
      "ACP Item schema has no quantity field. The totals here, not the feed prices, are " +
      "what a mandate ceiling is checked against.",
    inputSchema: {
      item_ids: z.array(z.string()).min(1).describe("Repeat an id to buy more than one"),
      currency: z.string().default("INR"),
      quoted_prices: z
        .record(z.string(), z.number().int())
        .optional()
        .describe(
          "id -> the price_minor you were shown by discover_products. Optional, and worth " +
            "sending: it is the only way a later refusal can say 'you read 5700, it is now " +
            "9120' instead of 'the total changed'.",
        ),
    },
  },
  async ({ item_ids, currency, quoted_prices }) => {
    const { status, body } = await call("/api/checkout_sessions", {
      method: "POST",
      headers: headers({ "Idempotency-Key": idem() }),
      body: JSON.stringify({
        currency,
        capabilities: {},
        // `unit_amount` is ACP's own field for exactly this. Sent only when the
        // agent supplied it — an absent quote is "I did not say", not "I said
        // zero", and a zero would read as drift from a price nobody quoted.
        line_items: item_ids.map((id) => {
          const quoted = quoted_prices?.[id];
          return quoted === undefined ? { id } : { id, unit_amount: quoted };
        }),
      }),
    });
    if (status !== 201) return asText({ error: body["code"] ?? "create_failed", status, message: body["message"] });

    return asText({
      session_id: body["id"],
      status: body["status"],
      totals: body["totals"],
      line_items: body["line_items"],
      // Surfaced rather than buried: an unpayable cart says why here, and the
      // agent needs it before it goes looking for a mandate.
      messages: body["messages"],
    });
  },
);

server.registerTool(
  "complete_checkout",
  {
    title: "Complete a checkout",
    description:
      "Exchange a session and a signed mandate for a payment link a human opens. " +
      "REFUSES without a valid mandate: no payment call executes without one. A refusal " +
      "returns a machine reason code and a human explanation — read it rather than " +
      "retrying, since a mandate refusal is never a transport failure.",
    inputSchema: {
      session_id: z.string(),
      mandate_header: z
        .string()
        .describe("The base64url mandate from POST /api/mandates, sent as the Mandate header"),
    },
  },
  async ({ session_id, mandate_header }) => {
    const { status, body } = await call(
      `/api/checkout_sessions/${encodeURIComponent(session_id)}/complete`,
      {
        method: "POST",
        headers: headers({ "Idempotency-Key": idem(), Mandate: mandate_header }),
        body: JSON.stringify({ payment_data: { handler_id: "razorpay_link" } }),
      },
    );

    if (status !== 200) {
      const alternatives = Array.isArray(body["alternatives"]) ? body["alternatives"] : [];
      return asText({
        refused: true,
        reason_code: body["code"],
        // The human string is the actionable half. An agent told
        // "MANDATE_CEILING_EXCEEDED" alone cannot tell by how much.
        explanation: body["message"],
        // Present only when the refusal is one an alternative can answer. An
        // expired mandate gets none, because a cheaper product does not restore
        // lapsed authority and offering one would imply the purchase is still
        // possible.
        ...(alternatives.length > 0
          ? {
              alternatives,
              next_step:
                "These fit the mandate. Create a new session with one of these ids and complete again.",
            }
          : {}),
        // Said explicitly, because an agent that retries a mandate refusal
        // burns its budget arriving back here. Invariant 4: retry transport
        // failures, never refusals.
        retryable: false,
        status,
      });
    }

    const order = (body["order"] ?? {}) as Json;
    return asText({
      status: body["status"],
      payment_url: order["permalink_url"],
      payment_link_id: order["id"],
      totals: order["totals"],
      note: "A person opens this URL to pay. The session completes when the payment webhook arrives.",
    });
  },
);

await server.connect(new StdioServerTransport());
