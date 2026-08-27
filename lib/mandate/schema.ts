/**
 * The mandate: a signed statement of what an agent may buy on someone's behalf.
 *
 * OURS, NOT ACP'S. ACP has no mandate concept — its equivalent lives in the
 * Delegated Payment Spec, which Razorpay cannot participate in (DESIGN.md §2).
 * Nothing here should be read as conformance to a published shape, and the
 * README says so.
 */
import type { Category } from "../normalize/taxonomy.ts";

export type MandateConstraints = {
  /** Integer minor units. CLAUDE.md invariant 6. */
  max_amount: { value: number; currency: string };
  /**
   * ABSENT means no category constraint, which is different from an empty list.
   * An empty list authorises nothing; `undefined` authorises any category. The
   * distinction matters because conflating them is the loose check DESIGN.md §3
   * names: refusing an `unmapped` product under a mandate that never mentioned
   * categories at all.
   */
  categories?: Category[];
  max_items?: number;
  single_use: boolean;
};

export type Mandate = {
  mandate_id: string;
  issued_at: string;
  expires_at: string;
  constraints: MandateConstraints;
  /** What the human asked for, in their words. Never parsed at payment time. */
  intent_text: string;
  signature: string;
};

/**
 * What the gate is shown about the cart.
 *
 * Assembled by the caller from the AUTHORITATIVE priced session, never from an
 * estimate or the agent's request — DESIGN.md §3 lists comparing against an
 * estimate as the loose version of the ceiling check.
 */
export type CartFacts = {
  total_minor: number;
  currency: string;
  /** The mapped category of every line. `unmapped` is a real member here. */
  categories: Category[];
  /**
   * Items as the MANDATE defines them: distinct products the buyer asked for,
   * not expanded variants. Counting variants refuses a legal two-item cart as
   * four (DESIGN.md §3).
   */
  item_count: number;
};

/**
 * Machine reason codes. Specific on purpose: the audit trail is the judged
 * artifact, and a refusal that names a non-cause will be believed.
 *
 * EVERY MEMBER IS REACHABLE. Three preconditions and five peer checks, and this
 * list is exactly the eight things they can say. `MANDATE_UNKNOWN` used to sit
 * here and nothing could ever emit it: it presumed a lookup by mandate id, and
 * mandates travel in a header rather than being stored and fetched, so the
 * situation it named cannot arise. A code that cannot happen is a claim this
 * vocabulary makes and cannot keep — the same defect as a refusal naming a
 * non-cause, one level up.
 */
export type MandateReasonCode =
  | "MANDATE_MISSING"
  | "MANDATE_SIGNATURE_INVALID"
  | "MANDATE_EXPIRED"
  | "MANDATE_NOT_YET_VALID"
  | "MANDATE_ALREADY_CONSUMED"
  | "MANDATE_CURRENCY_MISMATCH"
  | "MANDATE_CEILING_EXCEEDED"
  | "MANDATE_CATEGORY_NOT_PERMITTED"
  | "MANDATE_ITEM_COUNT_EXCEEDED";

/**
 * The agent-facing vocabulary is a CLOSED enum and none of its values means
 * "your mandate does not authorise this" (OBSTACLES.md). Internal codes stay
 * specific; the agent gets the nearest honest value plus the human string.
 *
 * `approval_required` for the category and missing cases rather than
 * `unsupported`: the agent is not being told the seller cannot sell the item —
 * which would be false — it is being told it lacks the authority to buy it.
 */
export const ACP_CODE: Record<MandateReasonCode, string> = {
  MANDATE_MISSING: "approval_required",
  MANDATE_SIGNATURE_INVALID: "invalid",
  MANDATE_EXPIRED: "expired",
  MANDATE_NOT_YET_VALID: "invalid",
  MANDATE_ALREADY_CONSUMED: "conflict",
  MANDATE_CURRENCY_MISMATCH: "invalid",
  MANDATE_CEILING_EXCEEDED: "maximum_exceeded",
  MANDATE_CATEGORY_NOT_PERMITTED: "approval_required",
  MANDATE_ITEM_COUNT_EXCEEDED: "quantity_exceeded",
};

/**
 * The five peer checks, IN THE ORDER THE RESPONSE REPORTS THEM.
 *
 * This constant is the order. It is pinned by a test that fails if it changes,
 * not by a comment asking nicely — on this project a convention in the money
 * path gets enforced in code, the way the eval's refusals and the audit check
 * constraint are.
 *
 * Authority-shaped checks first: an agent told "the link expired" learns
 * nothing it can act on, while an agent told "your mandate expired" knows to
 * get a new one.
 */
export const PEER_ORDER = [
  "validity_window",
  "single_use",
  "ceiling",
  "category",
  "item_count",
] as const;

export type PeerCheck = (typeof PEER_ORDER)[number];

/** One peer's result. `reason_code` absent means it passed. */
export type PeerEvaluation = {
  check: PeerCheck;
  reason_code?: MandateReasonCode;
  reason_human?: string;
};

/**
 * WHICH POLICY DECIDED THIS, stamped on every audit row.
 *
 * If the check set or the check order ever changes — a refactor, a new
 * constraint in Phase 5 — rows written before and after mean different things
 * about identical situations, and nothing in the trail would say so. A payment
 * audit trail that cannot be read years later is not one.
 *
 * Bump this whenever PEER_ORDER, the preconditions, or any check's trigger
 * condition changes. Not on a comment edit.
 */
export const GATE_VERSION = "2026-08-24.1";

type VerdictCommon = {
  gate_version: string;
  /**
   * FALSE when a precondition stopped evaluation. Distinct from an empty
   * `peers` list: "no peer failed" and "no peer ran" are different facts, and a
   * reader must not have to guess which one silence meant.
   */
  peers_evaluated: boolean;
  peers: PeerEvaluation[];
};

export type MandateRefusal = VerdictCommon & {
  ok: false;
  reason_code: MandateReasonCode;
  reason_human: string;
  acp_code: string;
};

export type MandateVerdict = (VerdictCommon & { ok: true }) | MandateRefusal;
