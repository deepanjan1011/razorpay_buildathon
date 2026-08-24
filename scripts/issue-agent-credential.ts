/**
 * Mint an agent credential.
 *
 *   npm run agent:issue -- <agent_id> <merchant_id> [label]
 *
 * A SCRIPT AND NOT AN ENDPOINT, deliberately. An unauthenticated HTTP route
 * that issues credentials is the hole the credential exists to close, and
 * "we'll protect it later" is how that ships. Minting requires database access,
 * which is a boundary that already exists.
 *
 * The token is printed ONCE. It is stored only as a SHA-256 hash, so there is
 * no way to recover it — the same shape as Razorpay's own key secret, and for
 * the same reason.
 */
import { randomBytes } from "node:crypto";

import { connect } from "../lib/db/sql.ts";
import { hashToken } from "../lib/auth/agent.ts";

process.loadEnvFile();

const [agentId, merchantId, label] = process.argv.slice(2);
if (!agentId || !merchantId) {
  console.error("usage: npm run agent:issue -- <agent_id> <merchant_id> [label]");
  process.exit(1);
}

// 32 bytes of randomness. The token is never guessed, only presented, so its
// only job is to be long enough that guessing is not a strategy.
const token = `ak_${randomBytes(32).toString("base64url")}`;

const sql = await connect();
await sql.query(
  `insert into agent_credential (token_sha256, agent_id, merchant_id, label)
   values ($1, $2, $3, $4)`,
  [hashToken(token), agentId, merchantId, label ?? null],
);

console.log(`agent_id    ${agentId}`);
console.log(`merchant_id ${merchantId}`);
console.log(`token       ${token}`);
console.log("\nShown once. Only its SHA-256 is stored; there is no way to recover it.");
console.log("Send it as:  Authorization: Bearer <token>");
