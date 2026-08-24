/**
 * The verification gate. CLAUDE.md invariant 2.
 *
 * TWO KINDS OF CHECK, AND THE DIFFERENCE IS NOT STYLISTIC.
 *
 * A PRECONDITION decides whether evaluation is possible at all. If the
 * signature does not verify, the mandate's contents are unauthenticated bytes,
 * and computing a ceiling comparison from them is not merely impolite — it is
 * meaningless, and recording that it "passed" would be a lie about evidence we
 * do not have. A precondition short-circuits EVALUATION.
 *
 * A PEER CHECK is evaluated against trusted contents. All five can be true at
 * once, and choosing one of them to record is an arbitrary choice wearing the
 * costume of a decision. So peers short-circuit THE RESPONSE ONLY: the caller
 * gets exactly one reason code, and the audit event records every peer that
 * failed AND every peer that passed.
 *
 * That is what removes order-dependence from the trail. The recorded outcome is
 * no longer a function of the order the checks happen to run in, which matters
 * because on this project the recorded cause IS the product. The passed set is
 * evidence too: in a dispute, "we evaluated the ceiling, the category, the item
 * count, the window and single-use, and these four passed" is a statement.
 * Silence is not.
 *
 * PURE. No database, no clock of its own, no crypto. Everything it needs is an
 * argument, which is what lets all thirty-two peer combinations be enumerated
 * in a test without a PSP, a key or a network.
 */
import { ACP_CODE, GATE_VERSION, PEER_ORDER } from "./schema.ts";
import type {
  CartFacts,
  Mandate,
  MandateReasonCode,
  MandateVerdict,
  PeerCheck,
  PeerEvaluation,
} from "./schema.ts";

export type GateInput = {
  /** null when the agent presented none at all. */
  mandate: Mandate | null;
  /** Whether THIS mandate has already been spent. Read by the caller. */
  consumed: boolean;
  /** Whether the signature verified. Computed by the caller behind the seam. */
  signatureValid: boolean;
  cart: CartFacts;
  now: Date;
};

function fail(reason_code: MandateReasonCode, reason_human: string) {
  return { reason_code, reason_human };
}

/**
 * Every peer, evaluated. None of them may short-circuit another.
 *
 * Deliberately written as five independent expressions rather than a chain: a
 * chain is exactly the order-dependence this function exists to remove, and the
 * cheapest way to reintroduce it is an early `return` that looks tidy.
 */
function evaluatePeers(
  mandate: Mandate,
  consumed: boolean,
  cart: CartFacts,
  now: Date,
): PeerEvaluation[] {
  const expiresAt = Date.parse(mandate.expires_at);
  const issuedAt = Date.parse(mandate.issued_at);

  // 1 — VALIDITY WINDOW. Refuses: now outside [issued_at, expires_at).
  // Evaluated at the payment call, never at session create: a mandate still
  // valid when the charge happens must not be refused for having been near
  // expiry when the cart was built.
  const window: PeerEvaluation = (() => {
    if (now.getTime() < issuedAt) {
      // A mandate from the future is evidence of a clock problem or a forgery,
      // and charging against it charges against authority not yet granted.
      return {
        check: "validity_window",
        ...fail("MANDATE_NOT_YET_VALID", `Mandate ${mandate.mandate_id} is not valid until ${mandate.issued_at}`),
      };
    }
    if (now.getTime() >= expiresAt) {
      return {
        check: "validity_window",
        ...fail("MANDATE_EXPIRED", `Mandate ${mandate.mandate_id} expired at ${mandate.expires_at}`),
      };
    }
    return { check: "validity_window" };
  })();

  // 2 — SINGLE USE. Refuses: a single-use mandate ALREADY CONSUMED.
  // Deliberately not "seen before": a retry after a transport failure presents
  // the same mandate and must succeed, or invariant 4's idempotent retry is
  // impossible. Consumption is recorded after a payment call succeeds.
  const singleUse: PeerEvaluation =
    mandate.constraints.single_use && consumed
      ? {
          check: "single_use",
          ...fail("MANDATE_ALREADY_CONSUMED", `Mandate ${mandate.mandate_id} is single-use and has already been spent`),
        }
      : { check: "single_use" };

  // 3 — AMOUNT CEILING. Refuses: authoritative total ABOVE max_amount.
  // The final priced total including delivery and tax, because that is what the
  // buyer will be charged; a pre-tax subtotal authorises more than was agreed.
  const ceiling: PeerEvaluation =
    cart.total_minor > mandate.constraints.max_amount.value
      ? {
          check: "ceiling",
          ...fail(
            "MANDATE_CEILING_EXCEEDED",
            `Cart total ${cart.total_minor} exceeds mandate ceiling ${mandate.constraints.max_amount.value}`,
          ),
        }
      : { check: "ceiling" };

  // 4 — CATEGORY. Refuses: a line outside a PRESENT categories constraint.
  // An ABSENT constraint authorises any category including `unmapped`; refusing
  // unmapped unconditionally is the loose version, and it makes every product
  // the mapper could not place unbuyable for a buyer who never asked for a
  // category. When the constraint IS present, `unmapped` matches nothing by
  // construction — it is a member of no list of real categories.
  const allowed = mandate.constraints.categories;
  const offending = allowed === undefined ? undefined : cart.categories.find((c) => !allowed.includes(c));
  const category: PeerEvaluation =
    offending !== undefined
      ? {
          check: "category",
          ...fail(
            "MANDATE_CATEGORY_NOT_PERMITTED",
            `Cart contains a ${offending} item but the mandate authorises only ${(allowed ?? []).join(", ") || "nothing"}`,
          ),
        }
      : { check: "category" };

  // 5 — ITEM COUNT. Refuses: more items than max_items, counting what the
  // mandate means by an item. Counting expanded variants refuses a legal
  // two-item cart as four.
  const maxItems = mandate.constraints.max_items;
  const itemCount: PeerEvaluation =
    maxItems !== undefined && cart.item_count > maxItems
      ? {
          check: "item_count",
          ...fail(
            "MANDATE_ITEM_COUNT_EXCEEDED",
            `Cart has ${cart.item_count} items but the mandate authorises ${maxItems}`,
          ),
        }
      : { check: "item_count" };

  const byCheck: Record<PeerCheck, PeerEvaluation> = {
    validity_window: window,
    single_use: singleUse,
    ceiling,
    category,
    item_count: itemCount,
  };
  // Returned in the DECLARED order so the response is deterministic. The
  // evaluation above is order-free; only this projection is ordered.
  return PEER_ORDER.map((c) => byCheck[c]);
}

export function verifyMandate(input: GateInput): MandateVerdict {
  const { mandate, consumed, signatureValid, cart, now } = input;

  const precondition = (code: MandateReasonCode, human: string): MandateVerdict => ({
    ok: false,
    reason_code: code,
    reason_human: human,
    acp_code: ACP_CODE[code],
    gate_version: GATE_VERSION,
    // NOT an empty list of passed checks — an explicit statement that nothing
    // was evaluated. "No peer check failed" and "no peer check ran" are
    // different facts, and a reader of the trail must not have to guess which.
    peers_evaluated: false,
    peers: [],
  });

  // ── PRECONDITIONS ────────────────────────────────────────────────────────
  // Each of these makes evaluation of the contents meaningless, not merely
  // unnecessary. They short-circuit EVALUATION, and the record says so.

  if (mandate === null) {
    return precondition("MANDATE_MISSING", "No mandate was presented; this seller requires one to charge");
  }

  // The signature comes first among preconditions, and that ordering is a
  // security property rather than a preference: reporting a ceiling breach on
  // an unverified mandate tells a forger what the ceiling is.
  if (!signatureValid) {
    return precondition("MANDATE_SIGNATURE_INVALID", `Mandate ${mandate.mandate_id} did not verify against its signature`);
  }

  if (!Number.isFinite(Date.parse(mandate.expires_at)) || !Number.isFinite(Date.parse(mandate.issued_at))) {
    // The window cannot be evaluated at all, so it is not a peer failure.
    return precondition("MANDATE_SIGNATURE_INVALID", `Mandate ${mandate.mandate_id} carries an unreadable validity window`);
  }

  if (cart.currency !== mandate.constraints.max_amount.currency) {
    // A PRECONDITION, not a ceiling detail. Comparing 300000 paise against
    // 300000 cents is a number that looks fine and means nothing, so the
    // ceiling cannot be evaluated — and reporting that it passed would assert
    // a comparison we never made.
    return precondition(
      "MANDATE_CURRENCY_MISMATCH",
      `Cart is in ${cart.currency} but mandate authorises ${mandate.constraints.max_amount.currency}`,
    );
  }

  // ── PEERS ────────────────────────────────────────────────────────────────
  // All five evaluated, none allowed to short-circuit another.
  const peers = evaluatePeers(mandate, consumed, cart, now);
  const firstFailure = peers.find((p) => p.reason_code !== undefined);

  if (firstFailure?.reason_code) {
    return {
      ok: false,
      // ONE code to the caller: minimal, and no enumeration of everything else
      // that is wrong with a mandate somebody may be probing.
      reason_code: firstFailure.reason_code,
      reason_human: firstFailure.reason_human ?? "",
      acp_code: ACP_CODE[firstFailure.reason_code],
      gate_version: GATE_VERSION,
      // The FULL picture to the record.
      peers_evaluated: true,
      peers,
    };
  }

  return { ok: true, gate_version: GATE_VERSION, peers_evaluated: true, peers };
}
