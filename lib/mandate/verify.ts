/**
 * The verification gate. CLAUDE.md invariant 2.
 *
 * Signature, expiry, single-use consumption, amount ceiling, category, item
 * count — IN THAT ORDER, first failure short-circuits.
 *
 * The order is not cosmetic. An unsigned mandate must not have its ceiling
 * reported, because that would tell a forger what the ceiling is; and an
 * expired mandate must not be consumed. Cheapest and most fundamental first.
 *
 * PURE. No database, no clock of its own, no crypto. Everything it needs is an
 * argument, which is what lets every refusal be tested without a PSP, a key or
 * a network — the same reason the payment client is a seam.
 *
 * EVERY CHECK BELOW STATES THE CONDITION IT REFUSES AND WHY THAT CONDITION IS
 * EXACTLY UNSAFE (DESIGN.md §3). A check that cannot be justified that
 * precisely is a proxy, and a proxy on the payment path refuses real purchases
 * while looking like rigour.
 */
import { ACP_CODE } from "./schema.ts";
import type { CartFacts, Mandate, MandateReasonCode, MandateVerdict } from "./schema.ts";

function refuse(reason_code: MandateReasonCode, reason_human: string): MandateVerdict {
  return { ok: false, reason_code, reason_human, acp_code: ACP_CODE[reason_code] };
}

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

export function verifyMandate(input: GateInput): MandateVerdict {
  const { mandate, consumed, signatureValid, cart, now } = input;

  // Nothing presented. Distinct from a bad one: the agent may simply not know
  // it needs authority, and the human string should say so rather than imply a
  // forgery.
  if (mandate === null) {
    return refuse("MANDATE_MISSING", "No mandate was presented; this seller requires one to charge");
  }

  // 1 — SIGNATURE. Refuses: a mandate whose bytes do not match its signature.
  // Exactly unsafe because every constraint below is only meaningful if the
  // constraints are the ones the human authorised. An unsigned mandate is a
  // request from the agent about itself.
  if (!signatureValid) {
    return refuse(
      "MANDATE_SIGNATURE_INVALID",
      `Mandate ${mandate.mandate_id} did not verify against its signature`,
    );
  }

  // 2 — VALIDITY WINDOW. Refuses: now outside [issued_at, expires_at).
  // Evaluated HERE, at the payment call, not at session create — a mandate
  // still valid when the charge happens must not be refused because it was
  // near expiry when the cart was built (DESIGN.md §3).
  const expiresAt = Date.parse(mandate.expires_at);
  const issuedAt = Date.parse(mandate.issued_at);
  if (!Number.isFinite(expiresAt) || !Number.isFinite(issuedAt)) {
    return refuse(
      "MANDATE_SIGNATURE_INVALID",
      `Mandate ${mandate.mandate_id} carries an unreadable validity window`,
    );
  }
  if (now.getTime() < issuedAt) {
    // A mandate from the future is not merely early — it is evidence of a clock
    // problem or a forgery, and charging against it would be charging against
    // authority nobody has granted yet.
    return refuse(
      "MANDATE_NOT_YET_VALID",
      `Mandate ${mandate.mandate_id} is not valid until ${mandate.issued_at}`,
    );
  }
  if (now.getTime() >= expiresAt) {
    return refuse(
      "MANDATE_EXPIRED",
      `Mandate ${mandate.mandate_id} expired at ${mandate.expires_at}`,
    );
  }

  // 3 — SINGLE USE. Refuses: a single-use mandate ALREADY CONSUMED.
  // Exactly unsafe because spending it twice charges twice for one authority.
  //
  // Deliberately NOT "seen before": a retry after a transport failure presents
  // the same mandate and must succeed, or invariant 4's idempotent retry
  // becomes impossible. Consumption is a fact the caller records after a
  // payment call succeeds, not a fact about having been shown the mandate.
  if (mandate.constraints.single_use && consumed) {
    return refuse(
      "MANDATE_ALREADY_CONSUMED",
      `Mandate ${mandate.mandate_id} is single-use and has already been spent`,
    );
  }

  // 4 — AMOUNT CEILING. Refuses: authoritative cart total ABOVE max_amount.
  // Compared against the final priced total — including delivery and tax —
  // because that is what the buyer will be charged. A pre-tax subtotal would
  // authorise a charge larger than the human agreed to.
  if (cart.currency !== mandate.constraints.max_amount.currency) {
    // Not a ceiling failure. Comparing 300000 paise against 300000 cents is a
    // number that looks fine and means nothing, so this is its own refusal
    // rather than a silent pass or a misattributed ceiling breach.
    return refuse(
      "MANDATE_CURRENCY_MISMATCH",
      `Cart is in ${cart.currency} but mandate authorises ${mandate.constraints.max_amount.currency}`,
    );
  }
  if (cart.total_minor > mandate.constraints.max_amount.value) {
    return refuse(
      "MANDATE_CEILING_EXCEEDED",
      `Cart total ${cart.total_minor} exceeds mandate ceiling ` +
        `${mandate.constraints.max_amount.value}`,
    );
  }

  // 5 — CATEGORY. Refuses: a line whose mapped category is not a member of a
  // PRESENT categories constraint.
  //
  // The specificity that matters is the guard: an ABSENT constraint authorises
  // any category, including `unmapped`. Refusing `unmapped` unconditionally is
  // the loose version DESIGN.md §3 names, and it would make every product the
  // mapper could not place unbuyable even for a buyer who never asked for a
  // category — the Phase 1 failure with money attached.
  //
  // When the constraint IS present, `unmapped` matches nothing, by
  // construction: it is not a member of any list of real categories. That is
  // what lets unmapped products stay discoverable in the feed while remaining
  // unbuyable under a category-constrained mandate (DESIGN.md §3).
  const allowed = mandate.constraints.categories;
  if (allowed !== undefined) {
    const offending = cart.categories.find((c) => !allowed.includes(c));
    if (offending !== undefined) {
      return refuse(
        "MANDATE_CATEGORY_NOT_PERMITTED",
        `Cart contains a ${offending} item but the mandate authorises only ` +
          `${allowed.join(", ") || "nothing"}`,
      );
    }
  }

  // 6 — ITEM COUNT. Refuses: more items than max_items.
  // Counts what the mandate means by an item — distinct products the buyer
  // asked for. Counting expanded variants would refuse a legal two-item cart as
  // four, which is the loose version and refuses real purchases.
  const maxItems = mandate.constraints.max_items;
  if (maxItems !== undefined && cart.item_count > maxItems) {
    return refuse(
      "MANDATE_ITEM_COUNT_EXCEEDED",
      `Cart has ${cart.item_count} items but the mandate authorises ${maxItems}`,
    );
  }

  return { ok: true };
}
