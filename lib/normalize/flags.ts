/** PHASE-1.md §1. Kept in one place so parse and normalize cannot drift apart. */
export type NormalizationFlag =
  | "PRICE_AMBIGUOUS"
  | "CATEGORY_UNMAPPED"
  | "TITLE_INFERRED"
  | "VARIANTS_SPLIT"
  | "CURRENCY_ASSUMED"
  | "MULTILINGUAL_SOURCE"
  | "MISSING_REQUIRED_FIELD"
  | "PRICE_OUT_OF_BAND";

/**
 * Flags answer TWO independent questions, not one.
 *
 *   1. Should a human look at this?        -> needs_review
 *   2. Is it unsafe to publish?            -> not servable
 *
 * These were originally one boolean, which was a conflation: "held for merchant
 * review" and "withheld from the feed" are different things. Collapsing them
 * means the only way to ask a merchant about a product is to make it invisible
 * to buyers first, which is a bad trade for anything short of genuinely unsafe.
 *
 * Three tiers fall out:
 *
 *   WITHHOLDING  unsafe to publish, and reviewed. Wrong in a way a buyer or an
 *                agent cannot detect or recover from.
 *   REVIEW_ONLY  publish it, and ask the merchant anyway. Imperfect, but the
 *                imperfection is visible downstream and guarded elsewhere.
 *   advisory     neither. Provenance about what we did or what the source was.
 *
 * See OBSTACLES.md for both mistakes that produced this shape.
 */

/**
 * Unsafe to publish.
 *
 * Every member is wrong in an unrecoverable way. A bad price is compared
 * against a mandate ceiling and charged. A fabricated title makes an agent buy
 * the wrong object — the buyer's recourse is a return, which is out of scope
 * here and not a thing an agent can undo.
 */
export const WITHHOLDING_FLAGS = new Set<NormalizationFlag>([
  "MISSING_REQUIRED_FIELD",
  "PRICE_AMBIGUOUS",
  "PRICE_OUT_OF_BAND",
  "TITLE_INFERRED",
]);

/**
 * Publish, but ask the merchant.
 *
 * `CATEGORY_UNMAPPED` is the whole tier, and the reasoning is worth stating
 * because it looks like a relaxation and is not:
 *
 * Withholding every product the mapper cannot confidently place makes a
 * potentially large fraction of a real Indian small-merchant catalogue invisible
 * to agents. "The feed is missing half your catalogue" is a serious failure in
 * its own right.
 *
 * And withholding buys nothing, because the safety check already lives where it
 * belongs. Mandate verification matches on `category` only (DESIGN.md §3), so a
 * product whose category is `unmapped` can never satisfy a mandate that carries
 * a category constraint — it is refused at the payment gate by construction,
 * not by a rule someone has to remember. That is CLAUDE.md invariant 2's layer.
 * A mandate with no category constraint accepts any category by definition, so
 * serving an unmapped product is correct there too.
 *
 * Withholding at feed time would be defence in the wrong layer: it costs
 * discovery and adds no protection the payment gate does not already give.
 *
 * PHASE-1.md §2 REQUIREMENT INHERITED BY PHASE 3: the mandate category check
 * must treat `unmapped` as matching nothing. If that check is ever written as
 * "skip the category test when the product is unmapped", this tier becomes
 * unsafe and CATEGORY_UNMAPPED must move to WITHHOLDING_FLAGS.
 */
export const REVIEW_ONLY_FLAGS = new Set<NormalizationFlag>(["CATEGORY_UNMAPPED"]);

/**
 * Advisory — neither withholds nor queues:
 *
 * - CURRENCY_ASSUMED — the sheet gave no symbol. This system is INR-only
 *   (CLAUDE.md invariant 6), so there is no other currency it could be. The
 *   flag records the assumption for the audit trail; it is not doubt. It fires
 *   on nearly every row of nearly every real sheet.
 * - VARIANTS_SPLIT — one row became several variants. The splitting is
 *   deterministic, and `splitList` refuses the case that could fabricate SKUs
 *   (a measure like `1/2 kg`).
 * - MULTILINGUAL_SOURCE — the cell contained Indic script. Whether the reading
 *   is trustworthy is carried by the model's own `confidence`, already
 *   thresholded. Blocking on script alone would queue every row of a
 *   Tamil-speaking merchant's catalogue on the basis of the alphabet.
 *
 * A review queue holding every product is one the merchant rubber-stamps, which
 * destroys the check the queue exists to provide. Caution aimed at everything
 * stops being caution.
 */

export function isWithholding(flag: NormalizationFlag): boolean {
  return WITHHOLDING_FLAGS.has(flag);
}

/** Unsafe to publish. Drives what the feed serves. */
export function isServable(flags: readonly NormalizationFlag[]): boolean {
  return !flags.some(isWithholding);
}

/** Surfaces in the merchant dashboard. A superset of the withheld. */
export function needsReview(flags: readonly NormalizationFlag[]): boolean {
  return flags.some((f) => WITHHOLDING_FLAGS.has(f) || REVIEW_ONLY_FLAGS.has(f));
}
