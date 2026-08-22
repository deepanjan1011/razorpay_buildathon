/**
 * Authoritative cart arithmetic. Deterministic, integer-only, no model.
 *
 * Every amount is integer minor units end to end (CLAUDE.md invariant 6).
 * There is no rounding step anywhere in this file, because there is nothing to
 * round: a quantity is an integer, a unit price is an integer, tax is computed
 * with integer arithmetic and an explicit rounding rule stated at the one place
 * it happens.
 */
import type { CatalogVariant } from "../catalog/store.ts";

/** ACP `Total.type` values, in the order a buyer reads them. */
export type TotalType =
  | "items_base_amount"
  | "subtotal"
  | "fulfillment"
  | "tax"
  | "total";

export type Total = { type: TotalType; display_text: string; amount: number };

/** Per-line breakdown. ACP requires `totals` on every LineItem, not just the cart. */
export function lineTotals(amountMinor: number): Total[] {
  return [
    { type: "items_base_amount", display_text: "Item", amount: amountMinor },
    { type: "subtotal", display_text: "Subtotal", amount: amountMinor },
    { type: "total", display_text: "Total", amount: amountMinor },
  ];
}

export type CartLine = {
  variant: CatalogVariant;
  quantity: number;
  /** quantity × unit price, integer minor units. */
  amount: number;
};

/**
 * Flat-rate fulfilment. DESIGN.md §2 lists tax configuration as a stub; the
 * same honesty applies here — a real rate depends on weight, distance and
 * courier, none of which a spreadsheet merchant has given us.
 */
export const FULFILLMENT_FLAT_MINOR = 5000; // ₹50
export const FREE_FULFILLMENT_THRESHOLD_MINOR = 100000; // ₹1,000

/**
 * Flat 5%, declared a stub in DESIGN.md §2 and in the README.
 *
 * Real Indian GST is per-HSN-code and varies 0/5/12/18/28 by category, plus
 * CGST/SGST/IGST split by whether the sale crosses a state line. A small
 * merchant's spreadsheet contains none of that. Inventing a per-item rate would
 * produce a confident wrong number on a tax invoice, which is worse than an
 * obviously flat one that is documented as flat.
 */
export const TAX_RATE_BASIS_POINTS = 500; // 5.00%

/**
 * Integer tax, rounded HALF UP at the single point where a fraction can occur.
 *
 * Stated explicitly because "how is tax rounded" is exactly the kind of thing
 * that silently differs between the number an agent quotes and the number a
 * merchant is paid.
 */
export function taxOn(amountMinor: number): number {
  return Math.round((amountMinor * TAX_RATE_BASIS_POINTS) / 10000);
}

/**
 * An EMPTY cart costs nothing to deliver.
 *
 * Found by a test asserting an unpriceable cart totals zero: with no lines the
 * subtotal is 0, which is below the free-delivery threshold, so the flat ₹50
 * applied and the cart totalled ₹52.50 of pure delivery and tax on nothing.
 * The threshold rule was written for a cart that exists.
 */
export function fulfillmentFor(subtotalMinor: number, lineCount: number): number {
  if (lineCount === 0) return 0;
  return subtotalMinor >= FREE_FULFILLMENT_THRESHOLD_MINOR ? 0 : FULFILLMENT_FLAT_MINOR;
}

/**
 * Builds the ACP `totals` array.
 *
 * `total` is computed by summing the components rather than recomputing from
 * the lines, so the breakdown a buyer reads and the amount they are charged
 * cannot disagree. In Phase 3 this same number is what the mandate ceiling is
 * checked against — a total that does not equal its own breakdown would make
 * that check meaningless.
 */
export function computeTotals(lines: CartLine[]): Total[] {
  const itemsBase = lines.reduce((sum, line) => sum + line.amount, 0);
  const subtotal = itemsBase;
  const fulfillment = fulfillmentFor(subtotal, lines.length);
  const tax = taxOn(subtotal + fulfillment);
  const total = subtotal + fulfillment + tax;

  return [
    { type: "items_base_amount", display_text: "Items", amount: itemsBase },
    { type: "subtotal", display_text: "Subtotal", amount: subtotal },
    {
      type: "fulfillment",
      display_text: fulfillment === 0 ? "Delivery (free)" : "Delivery",
      amount: fulfillment,
    },
    { type: "tax", display_text: "Tax (flat 5% stub)", amount: tax },
    { type: "total", display_text: "Total", amount: total },
  ];
}

export function totalOf(totals: Total[]): number {
  return totals.find((t) => t.type === "total")?.amount ?? 0;
}
