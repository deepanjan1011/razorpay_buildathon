/**
 * The live catalogue — what a variant costs and whether it is available RIGHT
 * NOW, as opposed to what the published feed said when it was last generated.
 *
 * `rfc.product_feeds.md` §3.3: feed data is a signal, the checkout response is
 * authoritative. Keeping these in separate storage is what makes that true
 * rather than merely asserted — if checkout priced carts from the feed
 * artifacts, the feed would be authoritative by construction and Phase 5's
 * drift scenario would have nothing to disagree about.
 */
import type { Sql } from "../db/sql.ts";
import type { Product } from "../normalize/schema.ts";
import { isServable } from "../normalize/flags.ts";

export type CatalogVariant = {
  merchant_id: string;
  variant_id: string;
  product_id: string;
  title: string;
  price_minor: number;
  currency: string;
  availability: "in_stock" | "out_of_stock" | "unknown";
  category: string;
};

/**
 * Publishes normalized products into the live catalogue.
 *
 * Only servable variants land here, by the same rule the feed uses: a record
 * carrying a withholding flag is not something an agent may buy, and putting it
 * in the catalogue would let a checkout session reference an item the feed
 * never offered.
 */
export async function upsertCatalog(
  sql: Sql,
  merchantId: string,
  products: Product[],
): Promise<number> {
  let count = 0;
  for (const product of products) {
    if (!isServable(product.normalization.flags)) continue;
    for (const variant of product.variants) {
      if (!isServable(variant.normalization.flags)) continue;
      await sql.query(
        `insert into catalog_variant
           (merchant_id, variant_id, product_id, title, price_minor, currency,
            availability, category, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, now())
         on conflict (merchant_id, variant_id) do update set
           product_id = excluded.product_id,
           title = excluded.title,
           price_minor = excluded.price_minor,
           currency = excluded.currency,
           availability = excluded.availability,
           category = excluded.category,
           updated_at = now()`,
        [
          merchantId,
          variant.id,
          product.id,
          variant.title,
          variant.price.amount_minor,
          variant.price.currency,
          variant.availability,
          variant.category,
        ],
      );
      count++;
    }
  }
  return count;
}

/** Reads the CURRENT state of the requested variants. Never cached. */
export async function lookupVariants(
  sql: Sql,
  merchantId: string,
  variantIds: string[],
): Promise<Map<string, CatalogVariant>> {
  if (variantIds.length === 0) return new Map();
  const { rows } = await sql.query<CatalogVariant>(
    `select merchant_id, variant_id, product_id, title, price_minor, currency,
            availability, category
       from catalog_variant
      where merchant_id = $1 and variant_id = any($2)`,
    [merchantId, variantIds],
  );
  return new Map(rows.map((r) => [r.variant_id, { ...r, price_minor: Number(r.price_minor) }]));
}

/**
 * Changes a price without republishing the feed.
 *
 * Exists for Phase 5: it is how drift is produced honestly, by moving the live
 * catalogue while the published snapshot stays where the agent last read it —
 * rather than by faking a mismatch in a test.
 */
export async function setPrice(
  sql: Sql,
  merchantId: string,
  variantId: string,
  priceMinor: number,
): Promise<void> {
  await sql.query(
    `update catalog_variant set price_minor = $3, updated_at = now()
      where merchant_id = $1 and variant_id = $2`,
    [merchantId, variantId, priceMinor],
  );
}

export async function setAvailability(
  sql: Sql,
  merchantId: string,
  variantId: string,
  availability: CatalogVariant["availability"],
): Promise<void> {
  await sql.query(
    `update catalog_variant set availability = $3, updated_at = now()
      where merchant_id = $1 and variant_id = $2`,
    [merchantId, variantId, availability],
  );
}
