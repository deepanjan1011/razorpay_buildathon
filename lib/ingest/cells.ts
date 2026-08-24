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
  /**
   * The unit the price is quoted PER, verbatim, when the cell names one:
   * "Pack" from `₹ 57/Pack`, "Kg" from `₹ 100/Kg`. null when the cell names no
   * unit — including `Rs. 1,299/-`, where the slash is punctuation and not a
   * rate. Reported, never acted on here: whether a per-Kg rate is ambiguous
   * depends on the pack size, which lives in another cell.
   */
  rate_unit: string | null;
  flags: NormalizationFlag[];
};

/**
 * A quantity with a unit, normalised to a base so two can be compared.
 *
 * Mass in grams, volume in millilitres. Returns null rather than guessing when
 * the text names no unit we know — an unrecognised unit is not a zero.
 */
const UNIT_BASE: Record<string, { dimension: "mass" | "volume"; factor: number }> = {
  kg: { dimension: "mass", factor: 1000 },
  kgs: { dimension: "mass", factor: 1000 },
  kilo: { dimension: "mass", factor: 1000 },
  kilos: { dimension: "mass", factor: 1000 },
  kilogram: { dimension: "mass", factor: 1000 },
  kilograms: { dimension: "mass", factor: 1000 },
  g: { dimension: "mass", factor: 1 },
  gm: { dimension: "mass", factor: 1 },
  gms: { dimension: "mass", factor: 1 },
  gram: { dimension: "mass", factor: 1 },
  grams: { dimension: "mass", factor: 1 },
  l: { dimension: "volume", factor: 1000 },
  ltr: { dimension: "volume", factor: 1000 },
  litre: { dimension: "volume", factor: 1000 },
  litres: { dimension: "volume", factor: 1000 },
  liter: { dimension: "volume", factor: 1000 },
  liters: { dimension: "volume", factor: 1000 },
  ml: { dimension: "volume", factor: 1 },
};

export type Quantity = { dimension: "mass" | "volume"; base: number };

export function parseQuantity(raw: unknown): Quantity | null {
  const text = asText(raw);
  // Match the number AND its unit together. Matching them separately would
  // pair the 150 of "150 g" with a "kg" appearing elsewhere in the cell.
  const m = /(\d+(?:\.\d+)?)\s*([A-Za-z]+)/.exec(text.replace(/,/g, ""));
  if (!m) return null;
  const unit = UNIT_BASE[m[2]!.toLowerCase()];
  if (!unit) return null;
  const value = Number(m[1]);
  if (!Number.isFinite(value)) return null;
  return { dimension: unit.dimension, base: value * unit.factor };
}

/** The unit a rate is quoted per, if the text names one. */
export function rateUnitOf(text: string): string | null {
  // `[A-Za-z]` deliberately: `Rs. 1,299/-` must NOT read "-" as a unit.
  const m = /(?:\/|\bper\b)\s*([A-Za-z]+)/i.exec(text);
  return m?.[1] ?? null;
}

/** A rate quoted per a unit of MEASURE, as opposed to per a sale unit. */
export function measureRate(unit: string | null): Quantity | null {
  if (unit === null) return null;
  const known = UNIT_BASE[unit.toLowerCase()];
  return known ? { dimension: known.dimension, base: known.factor } : null;
}

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
 * Belt and braces on the money path. A price outside ₹1 .. ₹10,00,000 is more
 * likely a parse failure than a real offer from a small merchant, so it is
 * flagged for review rather than accepted.
 *
 * This is deliberately redundant with the extraction fix in `toMinor`: the
 * `Rs. 1,299/-` bug produced 13 paise, which this band catches on its own. In
 * the one path where being wrong costs real money, two independent checks that
 * both have to fail is worth four lines.
 */
const MIN_PLAUSIBLE_MINOR = 100; // ₹1
const MAX_PLAUSIBLE_MINOR = 100_000_000; // ₹10,00,000

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
  const rate_unit = rateUnitOf(text);
  const missing = (): PriceParse => ({
    amount_minor: null,
    compare_at_minor: null,
    rate_unit,
    flags: [...flags, "MISSING_REQUIRED_FIELD"],
  });

  if (text === "") return missing();

  if (RANGE.test(text)) {
    // Picking an end of a range is a guess that silently changes what the buyer
    // pays. Refuse and send it to review.
    return { amount_minor: null, compare_at_minor: null, rate_unit, flags: ["PRICE_AMBIGUOUS"] };
  }

  if (!CURRENCY_MARKER.test(text)) flags.push("CURRENCY_ASSUMED");

  const withReference = WITH_REFERENCE.exec(text);
  const priceToken = withReference?.[1] ?? text;
  const referenceToken = withReference?.[2];

  const price = toMinor(priceToken);
  if (price.minor === null) return missing();
  if (price.imprecise) flags.push("PRICE_AMBIGUOUS");
  if (price.minor < MIN_PLAUSIBLE_MINOR || price.minor > MAX_PLAUSIBLE_MINOR) {
    flags.push("PRICE_OUT_OF_BAND");
  }

  let compare_at_minor: number | null = null;
  if (referenceToken !== undefined) {
    const reference = toMinor(referenceToken);
    // A "reference" below the price is not a reference. Drop it rather than
    // publish a list_price that makes the offer look like a markup.
    if (reference.minor !== null && reference.minor > price.minor) {
      compare_at_minor = reference.minor;
    }
  }

  return { amount_minor: price.minor, compare_at_minor, rate_unit, flags };
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
 * Hyphen is deliberately NOT a delimiter — it appears inside sizes (`M-9`) far
 * more often than between them.
 *
 * A tight slash is not a delimiter either when it joins multi-word values,
 * because `1/2 kg` is one size and not two. Grocery sellers size by measure,
 * and splitting that fraction invents two separately purchasable products that
 * do not exist. The rule: a slash with no surrounding whitespace only splits
 * when every resulting part is a single word.
 *
 * The cost is that `Half Sleeve/Full Sleeve` stays unsplit. That is the safer
 * failure — under-splitting yields one variant with a compound name, visible
 * and fixable in review, while over-splitting silently fabricates SKUs an agent
 * can buy.
 */
export function splitList(raw: unknown): string[] {
  const text = asText(raw);
  if (text === "") return [];

  const parts = text
    .split(/\s*[,|;]\s*|\s*\/\s*/)
    .map((p) => p.trim())
    .filter((p) => p !== "");

  if (parts.length < 2) return [text];

  const tightSlash = /\S\/\S/.test(text);
  if (tightSlash && parts.some((p) => /\s/.test(p))) return [text];

  return parts;
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
