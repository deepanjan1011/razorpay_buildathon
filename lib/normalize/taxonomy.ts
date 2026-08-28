/**
 * PLAN.md §2. Fixed, small, deliberately coarse.
 *
 * The LLM maps *into* this list and cannot invent members. Mandate category
 * matching (DESIGN.md §3) runs against `Category` only — never `category_raw`,
 * and never via a model call at payment time.
 */
export const CATEGORIES = [
  "apparel",
  "footwear",
  "accessories",
  "jewellery",
  "beauty",
  "home",
  "kitchen",
  "electronics",
  "stationery",
  "food",
  "toys",
  "unmapped",
] as const;

export type Category = (typeof CATEGORIES)[number];

/**
 * The `taxonomy` name published alongside each category in the ACP feed.
 *
 * ACP's `Category.taxonomy` is a free string naming the system in use
 * (`google_product_category`, `shopify`, `merchant`, …), so our fixed enum is
 * spec-legal as its own named taxonomy. Naming it explicitly stops an agent
 * assuming these values come from a registry it knows.
 */
export const TAXONOMY_NAME = "agentready";

/** The taxonomy name for the merchant's own verbatim wording. */
export const MERCHANT_TAXONOMY_NAME = "merchant";

export function isCategory(value: string): value is Category {
  return (CATEGORIES as readonly string[]).includes(value);
}
