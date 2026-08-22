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
 * Flags divide by what they actually assert.
 *
 * A BLOCKING flag says *we are not sure this is right* — it withholds the
 * record from the feed and sends it to the merchant. An ADVISORY flag says
 * *here is something we did, or something about the source* — it is provenance,
 * carried on the record and shown in review, but it does not gate publication.
 *
 * The distinction is not cosmetic. Treating every flag as blocking sounds
 * cautious and is actually the opposite: `CURRENCY_ASSUMED` fires on any price
 * written as a plain number, which is nearly every row of nearly every small
 * merchant's sheet. Blocking on it empties the feed. And a review queue
 * containing every product is a queue the merchant rubber-stamps — which
 * destroys the check that the queue exists to provide. Caution has to be aimed
 * at genuine uncertainty or it stops being caution.
 *
 * See OBSTACLES.md.
 */
export const BLOCKING_FLAGS = new Set<NormalizationFlag>([
  // We could not read a value we need.
  "MISSING_REQUIRED_FIELD",
  // We read a price but cannot say which number the merchant meant.
  "PRICE_AMBIGUOUS",
  // We read a price that is implausible enough to suspect a parse failure.
  "PRICE_OUT_OF_BAND",
  // We could not place the product in the taxonomy mandates match against.
  "CATEGORY_UNMAPPED",
  // The sheet gave no usable name and the model constructed one.
  "TITLE_INFERRED",
]);

/**
 * Advisory, and why each one is not a statement of doubt:
 *
 * - CURRENCY_ASSUMED — the sheet gave no symbol. This system is INR-only
 *   (CLAUDE.md invariant 6), so there is no other currency it could be. The
 *   flag records the assumption for the audit trail; it does not express doubt.
 * - VARIANTS_SPLIT — one row became several variants. The splitting is
 *   deterministic and `splitList` refuses the case that could fabricate SKUs
 *   (a measure like `1/2 kg`). The flag records that the row fanned out, which
 *   provenance needs and a buyer never sees.
 * - MULTILINGUAL_SOURCE — the source cell contained Indic script. Whether the
 *   reading is trustworthy is carried by the model's own `confidence`, which is
 *   already thresholded. Blocking here would put every row of a Tamil-speaking
 *   merchant's catalogue in review on the basis of the script alone.
 */
export function isBlocking(flag: NormalizationFlag): boolean {
  return BLOCKING_FLAGS.has(flag);
}

export function needsReview(flags: readonly NormalizationFlag[]): boolean {
  return flags.some(isBlocking);
}
