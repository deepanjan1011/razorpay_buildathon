/**
 * Mandate signing. The crypto seam.
 *
 * HMAC-SHA256 over a canonical serialisation, keyed by a server secret. Real
 * crypto, deliberately modest, and the limitation is stated rather than
 * implied: **a shared secret means the verifier could have issued the mandate
 * it is verifying.** That is sound for this project, where the seller issues
 * mandates on a buyer's instruction, and is NOT sound for the arrangement a
 * mandate ultimately wants — a buyer's own agent issuing, and the seller only
 * verifying. That needs asymmetric keys (DESIGN.md §2 names Ed25519) plus key
 * distribution and rotation, which is a project of its own.
 *
 * The seam is the point: `signMandate`/`verifyMandateSignature` are the only
 * two functions that know the algorithm, so swapping to Ed25519 touches this
 * file and nothing else.
 *
 * ACP CANNOT HELP HERE. Its `Signature` header is `required: false` with no
 * algorithm beyond the word "HMAC", no canonicalisation rule, no signing base
 * and no key distribution — two conformant implementations cannot verify each
 * other's requests (OBSTACLES.md). So this scheme is ours and is declared as a
 * deviation rather than presented as conformance.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

import type { Mandate } from "./schema.ts";

/**
 * Deterministic serialisation. Keys sorted at every level, no whitespace.
 *
 * `JSON.stringify` alone is NOT canonical: it preserves insertion order, so the
 * same mandate built two ways produces two different byte strings and one of
 * them fails to verify. The failure would look like tampering, which is the
 * worst possible signature bug — it accuses instead of explaining.
 */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}

/** Everything the signature covers: the mandate minus the signature itself. */
export type MandatePayload = Omit<Mandate, "signature">;

function secret(): string {
  const value = process.env["MANDATE_SIGNING_SECRET"];
  if (!value) {
    // Checked on the path that needs it, not at import: a missing key must not
    // make every unrelated refusal come back as a 500. The same lesson the
    // Razorpay client learned the hard way (OBSTACLES.md).
    throw new Error("MANDATE_SIGNING_SECRET is required to issue or verify mandates");
  }
  return value;
}

export function signPayload(payload: MandatePayload): string {
  return createHmac("sha256", secret()).update(canonical(payload)).digest("hex");
}

/**
 * A STALE `signature` ON THE INPUT IS DROPPED, not signed over.
 *
 * Re-signing a mandate built by spreading an already-signed one would include
 * the old signature in the signed bytes, while `verifyMandateSignature` strips
 * it before checking — so the result never verifies, and it fails as
 * MANDATE_SIGNATURE_INVALID, which reads as tampering. A signer that can emit
 * an unverifiable mandate is a trap, and the accusation it produces is the
 * worst kind of wrong answer.
 */
export function signMandate(payload: MandatePayload & { signature?: string }): Mandate {
  const { signature: _stale, ...clean } = payload;
  return { ...clean, signature: signPayload(clean) };
}

/**
 * True only if the mandate's bytes match its signature.
 *
 * Compared in constant time. A byte-by-byte compare that returns early leaks
 * how much of a forged signature was right, which is enough to construct one.
 * Returns false rather than throwing on a malformed signature: a bad signature
 * is a refusal the gate reports, not an exception the endpoint turns into a 500.
 */
export function verifyMandateSignature(mandate: Mandate): boolean {
  const { signature, ...payload } = mandate;
  if (typeof signature !== "string" || signature.length === 0) return false;

  let expected: string;
  try {
    expected = signPayload(payload as MandatePayload);
  } catch {
    // No key configured. NOT a valid signature — refusing every mandate is the
    // correct answer for a server that cannot verify one, exactly as the
    // webhook endpoint refuses every event when its secret is unset.
    return false;
  }

  const a = Buffer.from(signature, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
