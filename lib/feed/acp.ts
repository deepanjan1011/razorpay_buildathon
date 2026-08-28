/**
 * ACP Product Feed types, transcribed from the pinned schema.
 *
 * Source of truth: spec/acp/2026-04-17/schema.feed.json. These types exist for
 * authoring convenience only — the conformance test validates against the
 * vendored schema itself, never against this file, so a drift here cannot make
 * a non-conforming payload pass.
 *
 * Every object in the schema sets `additionalProperties: false`. Optional
 * fields must therefore be OMITTED, not set to null or undefined-valued, since
 * `JSON.stringify` drops undefined but a null would fail validation.
 */

export const ACP_API_VERSION = "2026-04-17";

/** `minProperties: 1` — an empty description object is invalid. */
export type ACPDescription = {
  plain?: string;
  html?: string;
  markdown?: string;
};

export type ACPPrice = {
  /** ISO 4217 minor units, integer, `minimum: 0`. */
  amount: number;
  /** `^[A-Z]{3}$` */
  currency: string;
};

export type ACPAvailability = {
  available?: boolean;
  /** Extensible. Known: in_stock, limited_stock, backorder, preorder, out_of_stock, discontinued. */
  status?: string;
};

export type ACPCategory = {
  value: string;
  taxonomy?: string;
};

export type ACPVariantOption = {
  name: string;
  value: string;
};

export type ACPMedia = {
  /** image, video, model. */
  type: string;
  /** `format: uri` — must be absolute. */
  url: string;
  alt_text?: string;
  width?: number;
  height?: number;
};

export type ACPBarcode = { type: string; value: string };

export type ACPLink = { type: string; title?: string; url: string };

export type ACPSeller = { name?: string; links?: ACPLink[] };

export type ACPVariant = {
  id: string;
  title: string;
  description?: ACPDescription;
  url?: string;
  barcodes?: ACPBarcode[];
  price?: ACPPrice;
  list_price?: ACPPrice;
  availability?: ACPAvailability;
  categories?: ACPCategory[];
  condition?: string[];
  variant_options?: ACPVariantOption[];
  media?: ACPMedia[];
  seller?: ACPSeller;
  marketplace?: ACPSeller;
};

export type ACPProduct = {
  id: string;
  title?: string;
  description?: ACPDescription;
  url?: string;
  media?: ACPMedia[];
  variants: ACPVariant[];
};

export type ACPFeedMetadata = {
  id: string;
  /** `^[A-Z]{2}$` */
  target_country?: string;
  updated_at?: string;
};

/**
 * The offline full-replacement artifact pair. PLAN.md §6, and
 * rfc.product_feeds.md §3.4 — `products.jsonl` is one Product per line.
 */
export function toProductsJsonl(products: ACPProduct[]): string {
  return products.map((p) => JSON.stringify(p)).join("\n");
}

export function parseProductsJsonl(jsonl: string): ACPProduct[] {
  return jsonl
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as ACPProduct);
}
