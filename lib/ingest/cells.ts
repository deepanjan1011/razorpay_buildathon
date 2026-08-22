/**
 * Deterministic cell coercion. PHASE-1.md §4: anything a parser can do reliably
 * must not go through the model. Everything here is reliable; nothing here
 * infers meaning.
 *
 * The recurring rule is that an unreadable value becomes null plus a flag, never
 * a guess and never a zero. A zero price and a missing price are different
 * facts, and only one of them can be charged against a mandate ceiling.
 */
import type { NormalizationFlag } from "../normalize/flags.ts";

export type PriceParse = {
  /** Integer paise. CLAUDE.md invariant 6 — never floats, never rupees. */
  amount_minor: number | null;
  /** A struck-through / MRP figure found alongside the price, if any. */
  compare_at_minor: number | null;
  flags: NormalizationFlag[];
};

export type StockParse = {
  availability: "in_stock" | "out_of_stock" | "unknown";
  inventory_count: number | null;
};

const asText = (raw: unknown): string =>
  raw === null || raw === undefined ? "" : String(raw).trim();

/** Currency markers that mean the merchant told us the unit rather than us assuming it. */
const CURRENCY_MARKER = /₹|\bRs\.?\b|\bINR\b/i;

/** `2799 (MRP 3499)`, `2799 (3499)` — sale price with the reference alongside. */
const WITH_REFERENCE = /^(.+?)\s*[({[]\s*(?:MRP|M\.R\.P\.?|List)?\s*:?\s*([\d.,]+)\s*[)}\]]$/i;

/** `500-700`, `500 to 700`. A range is not a price. */
const RANGE = /^[^\d]*[\d.,]+\s*(?:-|–|—|to)\s*[\d.,]+[^\d]*$/i;

/** `2.8k`, `1.5K` — thousands shorthand. */
const SHORTHAND = /^([\d.,]+)\s*k$/i;

/**
 * Converts one already-isolated numeric token to paise.
 * Returns null when the token holds no digits.
 */
function toMinor(token: string): { minor: number | null; imprecise: boolean } {
  const shorthand = SHORTHAND.exec(token);
  if (shorthand?.[1]) {
    const thousands = Number(shorthand[1].replace(/,/g, ""));
    if (!Number.isFinite(thousands)) return { minor: null, imprecise: false };
    return { minor: Math.round(thousands * 1000 * 100), imprecise: false };
  }

  // Extract the number rather than stripping everything that is not one:
  // stripping leaves punctuation behind (`Rs. 1,299/-` becomes `.1299`, which
  // parses as a valid but wildly wrong 0.13 rupees).
  const digits = /\d+(?:\.\d+)?/.exec(token.replace(/,/g, ""));
  if (!digits) return { minor: null, imprecise: false };

  const rupees = Number(digits[0]);
  if (!Number.isFinite(rupees)) return { minor: null, imprecise: false };

  const exact = rupees * 100;
  const minor = Math.round(exact);
  // More precision than paise can hold — the merchant wrote something we cannot
  // represent exactly, so say so rather than rounding in silence.
  return { minor, imprecise: Math.abs(exact - minor) > 1e-9 };
}

export function parsePrice(raw: unknown): PriceParse {
  const text = asText(raw);
  const flags: NormalizationFlag[] = [];
  const missing = (): PriceParse => ({
    amount_minor: null,
    compare_at_minor: null,
    flags: [...flags, "MISSING_REQUIRED_FIELD"],
  });

  if (text === "") return missing();

  if (RANGE.test(text)) {
    // Picking an end of a range is a guess that silently changes what the buyer
    // pays. Refuse and send it to review.
    return { amount_minor: null, compare_at_minor: null, flags: ["PRICE_AMBIGUOUS"] };
  }

  if (!CURRENCY_MARKER.test(text)) flags.push("CURRENCY_ASSUMED");

  const withReference = WITH_REFERENCE.exec(text);
  const priceToken = withReference?.[1] ?? text;
  const referenceToken = withReference?.[2];

  const price = toMinor(priceToken);
  if (price.minor === null) return missing();
  if (price.imprecise) flags.push("PRICE_AMBIGUOUS");

  let compare_at_minor: number | null = null;
  if (referenceToken !== undefined) {
    const reference = toMinor(referenceToken);
    // A "reference" below the price is not a reference. Drop it rather than
    // publish a list_price that makes the offer look like a markup.
    if (reference.minor !== null && reference.minor > price.minor) {
      compare_at_minor = reference.minor;
    }
  }

  return { amount_minor: price.minor, compare_at_minor, flags };
}

// ---------------------------------------------------------------------------

/** Checked before the positives, so `out of stock` cannot match on `stock`. */
const OUT_OF_STOCK =
  /\b(?:out\s*of\s*stock|sold\s*out|not\s*available|unavailable|no\s*stock|nil|none|finished)\b|^n$|^no$|^✗$|^x$|^✘$|^❌$/i;

const IN_STOCK =
  /\b(?:in\s*stock|available|ready|yes|have|stock)\b|^y$|^✓$|^✔$|^☑$|^✅$/i;

/** `10 pcs`, `10 nos`, `10`, `10 units`. */
const COUNT = /^(\d+)\s*(?:pcs?|pieces?|nos?\.?|units?|qty)?$/i;

export function parseStock(raw: unknown): StockParse {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return {
      availability: raw > 0 ? "in_stock" : "out_of_stock",
      inventory_count: Math.trunc(raw),
    };
  }

  const text = asText(raw);
  if (text === "") return { availability: "unknown", inventory_count: null };

  const count = COUNT.exec(text);
  if (count?.[1]) {
    const n = Number(count[1]);
    return {
      availability: n > 0 ? "in_stock" : "out_of_stock",
      inventory_count: n,
    };
  }

  if (OUT_OF_STOCK.test(text)) return { availability: "out_of_stock", inventory_count: null };
  if (IN_STOCK.test(text)) return { availability: "in_stock", inventory_count: null };

  // `-`, `??`, `ask`, `call`. Unknown is a real answer; assuming in_stock would
  // let an agent buy something the merchant does not have.
  return { availability: "unknown", inventory_count: null };
}

// ---------------------------------------------------------------------------

/**
 * Splits an option cell into its values: `S/M/L`, `Red, Blue, Black`.
 *
 * Only fires on a delimiter surrounded by values, so a hyphenated title like
 * `Blk RunShoe M-9` is left alone. Hyphen is deliberately NOT a delimiter — it
 * appears inside sizes far more often than between them.
 */
export function splitList(raw: unknown): string[] {
  const text = asText(raw);
  if (text === "") return [];

  const parts = text
    .split(/\s*[/,|;]\s*|\s+\/\s+/)
    .map((p) => p.trim())
    .filter((p) => p !== "");

  return parts.length > 0 ? parts : [text];
}

// ---------------------------------------------------------------------------

/**
 * Indic script ranges: Devanagari through Sinhala (U+0900–U+0DFF), which covers
 * Tamil at U+0B80–U+0BFF.
 *
 * This detects script, not language. Transliterated Tamil in Latin letters —
 * `Paruthi Sattai` — is invisible here by design; identifying it is semantics
 * and belongs to the model, not to a regex pretending to be sure.
 */
const INDIC = /[ऀ-෿]/;

export function hasIndicScript(raw: unknown): boolean {
  return INDIC.test(asText(raw));
}
