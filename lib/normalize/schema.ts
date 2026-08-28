/**
 * The internal normalized model. PLAN.md §1.
 *
 * A superset of the ACP Product Feed Spec: it carries provenance, confidence
 * and merchant fields the feed has no slot for. The projection to ACP
 * (lib/feed/project.ts) is lossy by construction — see PLAN.md §1.1.
 */
import type { NormalizationFlag } from "./flags.ts";
import type { Category } from "./taxonomy.ts";

/** Integer paise. CLAUDE.md invariant 6 — never floats, never rupees. */
export type Money = { amount_minor: number; currency: "INR" };

export type Availability = "in_stock" | "out_of_stock" | "unknown";

/** PLAN.md §1 `source_row` is required — every variant traces back. */
export type Provenance = {
  source_file: string;
  source_sheet: string;
  source_row: number;
  source_cells: Record<string, string>;
};

export type Normalization = {
  confidence: number;
  flags: NormalizationFlag[];
  needs_review: boolean;
};

export type Variant = {
  /** Stable. Becomes ACP `Variant.id`, and the checkout `items[].id` in Phase 2. */
  id: string;
  title: string;

  category: Category;
  category_raw: string | null;
  category_confidence: number;

  price: Money;
  compare_at_price: Money | null;

  availability: Availability;
  inventory_count: number | null;

  /** Only variant-distinguishing dimensions: colour, size. */
  options: Record<string, string>;
  /** Material, gender, … — no ACP slot, folded into the description on the way out. */
  attributes: Record<string, string>;
  image_url: string | null;

  provenance: Provenance;
  normalization: Normalization;
};

export type Product = {
  id: string;
  merchant_id: string;

  title: string;
  description: string | null;
  brand: string | null;

  /** Non-empty. ACP requires `variants` to be present. */
  variants: Variant[];
  image_url: string | null;

  provenance: Provenance;
  normalization: Normalization;
};
