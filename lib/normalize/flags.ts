/** PHASE-1.md §1. Kept in one place so parse and normalize cannot drift apart. */
export type NormalizationFlag =
  | "PRICE_AMBIGUOUS"
  | "CATEGORY_UNMAPPED"
  | "TITLE_INFERRED"
  | "VARIANTS_SPLIT"
  | "CURRENCY_ASSUMED"
  | "MULTILINGUAL_SOURCE"
  | "MISSING_REQUIRED_FIELD";
