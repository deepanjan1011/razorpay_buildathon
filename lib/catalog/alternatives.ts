/**
 * What else could this buyer have, given the authority they hold?
 *
 * DESIGN.md §5 item 3: a refusal that offers an in-mandate alternative. The
 * difference between a dead end and a recoverable one, and the reason the
 * failure path is worth ninety seconds of anyone's attention.
 *
 * THE SPECIFICITY RULE APPLIES HERE TOO, INVERTED. The gate must not refuse a
 * purchase the mandate allows; this must not OFFER a purchase the mandate would
 * refuse. An alternative that fails the gate on the next call is worse than no
 * alternative at all — it sends the agent around a loop and spends its budget
 * to arrive back where it started. So every constraint the gate checks is
 * applied here, in the same direction, against the same data.
 *
 * Deliberately NOT a recommender. No similarity scoring, no embeddings, no
 * ranking model. Same category, within budget, cheapest headroom first. A model
 * in this path would be a model adjacent to the charge decision, and invariant
 * 1 keeps it out.
 */
import type { Sql } from "../db/sql.ts";
import type { Mandate } from "../mandate/schema.ts";
import type { CatalogVariant } from "./store.ts";

export type Alternative = {
  id: string;
  title: string;
  price_minor: number;
  currency: string;
  category: string;
};

/**
 * Up to `limit` variants this mandate could actually buy instead.
 *
 * `budgetMinor` is what is left of the ceiling, not the ceiling itself: on a
 * multi-line cart the alternative has to fit beside what is already in it.
 * Passing the whole ceiling would offer something that breaches it in
 * combination, which is the loop this function exists to avoid.
 */
export async function alternativesFor(
  sql: Sql,
  merchantId: string,
  options: {
    mandate: Mandate | null;
    budgetMinor: number;
    /** Prefer these categories; falls back to any allowed one. */
    nearCategories: string[];
    excludeIds: string[];
    limit?: number;
  },
): Promise<Alternative[]> {
  const { mandate, budgetMinor, nearCategories, excludeIds, limit = 3 } = options;
  if (budgetMinor <= 0) return [];

  // The mandate's category constraint, applied exactly as the gate applies it:
  // ABSENT authorises anything, PRESENT restricts to its members. An empty list
  // authorises nothing, so there is nothing to offer.
  const allowed = mandate?.constraints.categories;
  if (allowed !== undefined && allowed.length === 0) return [];

  const { rows } = await sql.query<CatalogVariant>(
    `select merchant_id, variant_id, product_id, title, price_minor, currency,
            availability, category
       from catalog_variant
      where merchant_id = $1
        and price_minor > 0
        and price_minor <= $2
        -- unknown availability is INCLUDED. Most small-merchant sheets track
        -- no stock at all, so excluding unknown would offer nothing from a real
        -- catalogue. Only a merchant who explicitly said out_of_stock is
        -- skipped: absent is not false, which this codebase has now learned
        -- four times.
        and availability <> 'out_of_stock'
        and not (variant_id = any($3::text[]))
        and ($4::text[] is null or category = any($4::text[]))
      order by price_minor desc
      limit $5`,
    [
      merchantId,
      budgetMinor,
      excludeIds,
      allowed === undefined ? null : allowed,
      // Over-fetch so the category preference below has something to sort.
      Math.max(limit * 4, 12),
    ],
  );

  // Cheapest headroom first: the closest thing to what they asked for that
  // still fits. `order by price_minor desc` already did that; this only lifts
  // the same-category ones above the merely-allowed ones.
  const near = new Set(nearCategories);
  const sorted = [
    ...rows.filter((r) => near.has(r.category)),
    ...rows.filter((r) => !near.has(r.category)),
  ];

  return sorted.slice(0, limit).map((r) => ({
    id: r.variant_id,
    title: r.title,
    price_minor: r.price_minor,
    currency: r.currency,
    category: r.category,
  }));
}
