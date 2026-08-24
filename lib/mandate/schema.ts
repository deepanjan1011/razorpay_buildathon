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
 */
export type MandateReasonCode =
  | "MANDATE_MISSING"
  | "MANDATE_UNKNOWN"
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
  MANDATE_UNKNOWN: "not_found",
  MANDATE_SIGNATURE_INVALID: "invalid",
  MANDATE_EXPIRED: "expired",
  MANDATE_NOT_YET_VALID: "invalid",
  MANDATE_ALREADY_CONSUMED: "conflict",
  MANDATE_CURRENCY_MISMATCH: "invalid",
  MANDATE_CEILING_EXCEEDED: "maximum_exceeded",
  MANDATE_CATEGORY_NOT_PERMITTED: "approval_required",
  MANDATE_ITEM_COUNT_EXCEEDED: "quantity_exceeded",
};

export type MandateRefusal = {
  ok: false;
  reason_code: MandateReasonCode;
  reason_human: string;
  acp_code: string;
};

export type MandateVerdict = { ok: true } | MandateRefusal;
