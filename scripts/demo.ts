/**
 * The ninety seconds, driven by a real MCP client.
 *
 *   npm run demo
 *
 * Buy normally. Then move a price under a live session and watch the agent be
 * refused, receive an in-mandate alternative, and take it. Prints the session
 * id to open in the dashboard at the end.
 *
 * The price is restored on the way out, so this is repeatable — a demo that
 * only works once is a demo you cannot rehearse.
 */
process.loadEnvFile();
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { connect } from "../lib/db/sql.ts";

const repo = process.cwd();
const client = new Client({ name: "drift-drive", version: "0.0.1" });
await client.connect(
  new StdioClientTransport({
    command: "node",
    args: [`${repo}/mcp/server.ts`],
    env: { ...process.env } as Record<string, string>,
  }),
);

/**
 * A tool result, or a stop with the reason printed.
 *
 * A REFUSAL IS NOT AN ERROR and must not stop here — it is what the demo
 * exists to show, and it carries `refused`, never `error`. What stops the run
 * is the setup being wrong: no API, no token, no feed. Those used to surface
 * three lines later as `Cannot read properties of undefined`, which names the
 * symptom and not the cause, in front of whoever is watching.
 */
const text = (r: unknown) => {
  const parsed = JSON.parse(
    (r as { content: Array<{ text: string }> }).content[0]?.text ?? "{}",
  );
  if (parsed.error) {
    console.error(`\n  cannot run the demo — ${parsed.error}`);
    console.error(`  ${parsed.message ?? ""}\n`);
    process.exit(1);
  }
  return parsed;
};

const mint = async (body: Record<string, unknown>) => {
  const r = await fetch("http://localhost:3000/api/mandates", {
    method: "POST",
    headers: {
      "API-Version": "2026-04-17",
      Authorization: `Bearer ${process.env["AGENT_TOKEN"]}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return (await r.json()) as { mandate_header: string; mandate: { mandate_id: string } };
};

const rule = (s: string) => console.log(`\n${"─".repeat(64)}\n${s}\n`);

// ── 1. A normal purchase ────────────────────────────────────────────────────
rule("1. The agent finds something and buys it");

const found = text(
  await client.callTool({
    name: "discover_products",
    arguments: { feed_id: "feed_live", query: "murukku", limit: 3 },
  }),
);
const pick = found.products[0];
console.log(`discovered  ${pick.title}  ${pick.price_minor} paise  (${pick.availability})`);

const s1 = text(
  await client.callTool({ name: "create_checkout_session", arguments: { item_ids: [pick.id] } }),
);
const total1 = s1.totals.find((t: { type: string }) => t.type === "total").amount;
console.log(`session     ${s1.session_id}  ${s1.status}  total ${total1}`);

const m1 = await mint({
  max_amount: total1,
  categories: ["food"],
  intent_text: "one packet of murukku",
});
const done = text(
  await client.callTool({
    name: "complete_checkout",
    arguments: { session_id: s1.session_id, mandate_header: m1.mandate_header },
  }),
);
console.log(`complete    ${done.status}`);
console.log(`pay at      ${done.payment_url}`);

// ── 2. The price moves under a live session ─────────────────────────────────
rule("2. The merchant repriced. The agent has authority for the OLD price.");

const s2 = text(
  await client.callTool({ name: "create_checkout_session", arguments: { item_ids: [pick.id], quoted_prices: { [pick.id]: pick.price_minor } } }),
);
const total2 = s2.totals.find((t: { type: string }) => t.type === "total").amount;
console.log(`session     ${s2.session_id}  total ${total2}`);

const m2 = await mint({
  max_amount: total2,
  categories: ["food"],
  intent_text: "one packet of murukku",
});
console.log(`mandate     ceiling ${total2}, category food`);

const sql = await connect();
const bumped = Math.round(pick.price_minor * 1.6);
await sql.query(
  "update catalog_variant set price_minor = $3 where merchant_id = $1 and variant_id = $2",
  ["mer_live", pick.id, bumped],
);
console.log(`DRIFT       ${pick.title}: ${pick.price_minor} -> ${bumped} paise`);

const refused = text(
  await client.callTool({
    name: "complete_checkout",
    arguments: { session_id: s2.session_id, mandate_header: m2.mandate_header },
  }),
);
console.log(`\nrefused     ${refused.reason_code}`);
console.log(`            ${refused.explanation}`);
console.log(`retryable   ${refused.retryable}`);
console.log(`alternatives:`);
for (const a of refused.alternatives ?? []) {
  console.log(`            ${a.title}  ${a.price_minor} paise  (${a.category})`);
}

// ── 3. The agent takes the alternative ──────────────────────────────────────
rule("3. The agent takes one of the alternatives it was offered");

const alt = (refused.alternatives ?? [])[0];
if (!alt) {
  console.log("NO ALTERNATIVE OFFERED — the failure path is a dead end here.");
} else {
  const s3 = text(
    await client.callTool({ name: "create_checkout_session", arguments: { item_ids: [alt.id] } }),
  );
  const total3 = s3.totals.find((t: { type: string }) => t.type === "total").amount;
  console.log(`session     ${s3.session_id}  total ${total3}`);

  const ok = text(
    await client.callTool({
      name: "complete_checkout",
      arguments: { session_id: s3.session_id, mandate_header: m2.mandate_header },
    }),
  );
  console.log(`complete    ${ok.status ?? ok.reason_code}`);
  console.log(`pay at      ${ok.payment_url ?? "(refused: " + ok.explanation + ")"}`);
}

// Put the price back so the demo is repeatable.
await sql.query(
  "update catalog_variant set price_minor = $3 where merchant_id = $1 and variant_id = $2",
  ["mer_live", pick.id, pick.price_minor],
);
console.log(`\n(price restored to ${pick.price_minor})`);
console.log(`\n${"─".repeat(64)}\nOPEN THE AUDIT TRAIL:\n  http://localhost:3000/sessions/${s2.session_id}\n${"─".repeat(64)}`);
await client.close();
