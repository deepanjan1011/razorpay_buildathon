/**
 * Internal normalized model -> ACP Product Feed. PLAN.md §1.1.
 *
 * Two rules govern everything here:
 *
 * 1. **Nothing unsafe is served.** What the feed serves is decided by
 *    `isServable`, not by `needs_review` — those are different questions.
 *    `needs_review` queues a record for the merchant; a WITHHOLDING flag makes
 *    it unsafe to publish. A product flagged `CATEGORY_UNMAPPED` is served
 *    *and* queued, because the mandate gate refuses it at payment time anyway
 *    (flags.ts). A variant with a bad price is withheld; a product whose every
 *    variant is withheld goes entirely.
 * 2. **The projection is lossy by construction, and that is correct.** Every
 *    ACP object sets `additionalProperties: false`, so provenance, confidence,
 *    inventory counts and merchant ids have nowhere to go. They stay in
 *    Postgres, where they power the review queue, the audit trail and the eval.
 */
import { isServable, isWithholding } from "../normalize/flags.ts";
import type { NormalizationFlag } from "../normalize/flags.ts";
import type { Product, Variant } from "../normalize/schema.ts";
import {
  MERCHANT_TAXONOMY_NAME,
  TAXONOMY_NAME,
} from "../normalize/taxonomy.ts";
import type {
  ACPAvailability,
  ACPCategory,
  ACPDescription,
  ACPFeedMetadata,
  ACPMedia,
  ACPPrice,
  ACPProduct,
  ACPVariant,
  ACPVariantOption,
} from "./acp.ts";

export type Feed = {
  metadata: ACPFeedMetadata;
  products: ACPProduct[];
  /** Ids withheld from the feed, with the reason. Never silently dropped. */
  withheld: Array<{ id: string; kind: "product" | "variant"; reason: string }>;
};

/**
 * The reason a record was withheld names only the flags that actually caused
 * it. Advisory and review-only flags ride along on the record but withhold
 * nothing, so listing them here would make the audit trail state a false
 * cause — "withheld: CURRENCY_ASSUMED" is not why anything was withheld, and
 * neither is CATEGORY_UNMAPPED, which is served. CLAUDE.md invariant 3 wants a
 * reason code that is true.
 */
function withholdingReason(flags: readonly NormalizationFlag[]): string {
  return flags.filter(isWithholding).join(",") || "withheld";
}

/** ACP `Price.currency` is `^[A-Z]{3}$`; the internal model is INR-only. */
function price(money: { amount_minor: number; currency: "INR" }): ACPPrice {
  return { amount: money.amount_minor, currency: money.currency };
}

/**
 * ACP models stock as a boolean plus an extensible status string, with no
 * quantity field — and BOTH are optional.
 *
 * So `unknown` is published as absence: the key is omitted entirely rather than
 * guessed into `in_stock`. That is the honest encoding of "this merchant's
 * sheet does not track stock", which describes most small-merchant price lists.
 * The spec supports it — `rfc.product_feeds.md` §3.3 makes checkout
 * authoritative and §7 forbids agents treating feed availability as
 * guaranteed — so an absent signal costs discovery nothing and asserts nothing
 * false.
 */
function availability(variant: Variant): ACPAvailability | undefined {
  switch (variant.availability) {
    case "in_stock":
      return { available: true, status: "in_stock" };
    case "out_of_stock":
      return { available: false, status: "out_of_stock" };
    case "unknown":
      return undefined;
  }
}

function categories(variant: Variant): ACPCategory[] {
  const out: ACPCategory[] = [
    { value: variant.category, taxonomy: TAXONOMY_NAME },
  ];
  // The merchant's own wording, preserved verbatim. ACP's `taxonomy` field
  // makes this spec-native rather than something we had to smuggle.
  if (variant.category_raw !== null && variant.category_raw !== "") {
    out.push({ value: variant.category_raw, taxonomy: MERCHANT_TAXONOMY_NAME });
  }
  return out;
}

/** `format: uri` — a relative path or a bare filename is not a media URL. */
function isAbsoluteUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function media(imageUrl: string | null, altText: string): ACPMedia[] | undefined {
  if (imageUrl === null || !isAbsoluteUrl(imageUrl)) return undefined;
  return [{ type: "image", url: imageUrl, alt_text: altText }];
}

function variantOptions(variant: Variant): ACPVariantOption[] | undefined {
  const entries = Object.entries(variant.options);
  if (entries.length === 0) return undefined;
  return entries.map(([name, value]) => ({ name, value }));
}

/**
 * `Description` has `minProperties: 1` and no null type, so an empty
 * description must be omitted entirely rather than sent as `{}` or null.
 */
function description(parts: string[]): ACPDescription | undefined {
  const plain = parts.filter((p) => p !== "").join("\n");
  return plain === "" ? undefined : { plain };
}

/** Title-cases an attribute key for prose: `inner_material` -> `Inner material`. */
function label(key: string): string {
  const spaced = key.replace(/[_-]+/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function projectVariant(variant: Variant): ACPVariant {
  const out: ACPVariant = {
    id: variant.id,
    title: variant.title,
    price: price(variant.price),
    categories: categories(variant),
  };

  const stock = availability(variant);
  if (stock !== undefined) out.availability = stock;

  if (variant.compare_at_price !== null) {
    out.list_price = price(variant.compare_at_price);
  }

  const options = variantOptions(variant);
  if (options !== undefined) out.variant_options = options;

  const assets = media(variant.image_url, variant.title);
  if (assets !== undefined) out.media = assets;

  // `attributes` (material, gender, …) have no ACP slot. They are folded into
  // prose rather than emitted as `variant_options`, which mean option
  // selections that *distinguish* a variant — an agent may render those as a
  // picker, so putting "Gender: Womens" there would offer the buyer a choice
  // that does not exist. See OBSTACLES.md Decision 3.
  const attributes = Object.entries(variant.attributes).map(
    ([key, value]) => `${label(key)}: ${value}`,
  );
  const prose = description(attributes);
  if (prose !== undefined) out.description = prose;

  return out;
}

export function projectProduct(
  product: Product,
): { product: ACPProduct | null; withheld: Feed["withheld"] } {
  const withheld: Feed["withheld"] = [];

  if (!isServable(product.normalization.flags)) {
    return {
      product: null,
      withheld: [
        {
          id: product.id,
          kind: "product",
          reason: withholdingReason(product.normalization.flags),
        },
      ],
    };
  }

  const servable: ACPVariant[] = [];
  for (const variant of product.variants) {
    if (!isServable(variant.normalization.flags)) {
      withheld.push({
        id: variant.id,
        kind: "variant",
        reason: withholdingReason(variant.normalization.flags),
      });
      continue;
    }
    servable.push(projectVariant(variant));
  }

  // ACP requires `variants`, so a product cannot ship empty. A product whose
  // every variant is flagged is withheld whole rather than published as a
  // listing an agent cannot buy from.
  if (servable.length === 0) {
    withheld.push({
      id: product.id,
      kind: "product",
      reason: "all_variants_withheld",
    });
    return { product: null, withheld };
  }

  const out: ACPProduct = {
    id: product.id,
    title: product.title,
    variants: servable,
  };

  const assets = media(product.image_url, product.title);
  if (assets !== undefined) out.media = assets;

  // `brand` has no ACP field at all. Folded into prose so it stays matchable by
  // an agent, rather than dropped or forced into a field that means something
  // else.
  const prose = description([
    product.description ?? "",
    product.brand === null ? "" : `Brand: ${product.brand}`,
  ]);
  if (prose !== undefined) out.description = prose;

  // No `url`: a merchant on no platform has no product detail page. The field
  // is optional, so omitting it is conformant — and inventing one would point
  // an agent at a page that does not exist.

  return { product: out, withheld };
}

export function projectFeed(
  products: Product[],
  options: { feedId: string; targetCountry?: string; updatedAt?: Date },
): Feed {
  const out: ACPProduct[] = [];
  const withheld: Feed["withheld"] = [];

  for (const product of products) {
    const result = projectProduct(product);
    withheld.push(...result.withheld);
    if (result.product !== null) out.push(result.product);
  }

  const metadata: ACPFeedMetadata = {
    id: options.feedId,
    updated_at: (options.updatedAt ?? new Date()).toISOString(),
  };
  if (options.targetCountry !== undefined) {
    metadata.target_country = options.targetCountry;
  }

  return { metadata, products: out, withheld };
}
