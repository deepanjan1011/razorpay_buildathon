/**
 * Internal normalized model -> ACP Product Feed. PHASE-1.md §1.1.
 *
 * Two rules govern everything here:
 *
 * 1. **Nothing with `needs_review` is served.** PHASE-1.md §1. A flagged
 *    variant is withheld, not guessed at; a product whose every variant is
 *    flagged is withheld entirely.
 * 2. **The projection is lossy by construction, and that is correct.** Every
 *    ACP object sets `additionalProperties: false`, so provenance, confidence,
 *    inventory counts and merchant ids have nowhere to go. They stay in
 *    Postgres, where they power the review queue, the audit trail and the eval.
 */
import { isBlocking } from "../normalize/flags.ts";
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
 * it. Advisory flags ride along on the record but never withhold anything, so
 * listing them here would make the audit trail state a false cause —
 * "withheld: CURRENCY_ASSUMED" is not why anything was withheld. CLAUDE.md
 * invariant 3 wants a reason code that is true.
 */
function blockingReason(flags: readonly NormalizationFlag[]): string {
  return flags.filter(isBlocking).join(",") || "needs_review";
}

/** ACP `Price.currency` is `^[A-Z]{3}$`; the internal model is INR-only. */
function price(money: { amount_minor: number; currency: "INR" }): ACPPrice {
  return { amount: money.amount_minor, currency: money.currency };
}

/**
 * ACP models stock as a boolean plus an extensible status string, with no
 * quantity field. `unknown` has no representation and must never ship — it
 * implies `needs_review`, so a variant carrying it is withheld before reaching
 * here; this throws rather than inventing a value if that ever stops holding.
 */
function availability(variant: Variant): ACPAvailability {
  switch (variant.availability) {
    case "in_stock":
      return { available: true, status: "in_stock" };
    case "out_of_stock":
      return { available: false, status: "out_of_stock" };
    case "unknown":
      throw new Error(
        `variant ${variant.id}: availability "unknown" has no ACP representation ` +
          `and must be withheld as needs_review, not published`,
      );
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
    availability: availability(variant),
    categories: categories(variant),
  };

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

  if (product.normalization.needs_review) {
    return {
      product: null,
      withheld: [
        {
          id: product.id,
          kind: "product",
          reason: blockingReason(product.normalization.flags),
        },
      ],
    };
  }

  const servable: ACPVariant[] = [];
  for (const variant of product.variants) {
    if (variant.normalization.needs_review) {
      withheld.push({
        id: variant.id,
        kind: "variant",
        reason: blockingReason(variant.normalization.flags),
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
