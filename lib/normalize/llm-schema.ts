/**
 * The schema for what the model returns. This is NOT the ACP feed schema.
 *
 * The model produces semantics only. It is never asked for a price, a stock
 * level, or a currency — those are deterministic (lib/ingest/cells.ts), and
 * PHASE-1.md §4 is explicit that anything a parser can do reliably must not go
 * through the model. Keeping money out of the model's output is what makes
 * CLAUDE.md invariant 1 structural rather than aspirational: the model cannot
 * influence an amount it never emits.
 *
 * WIRE SHAPE vs INTERNAL SHAPE
 *
 * Internally `options` and `attributes` are `Record<string, string>`. On the
 * wire they are arrays of `{name, value}`, because NEITHER provider can express
 * an open-ended string map: constrained decoding (Groq strict) disallows
 * `additionalProperties`, and Gemini's `responseSchema` is an OpenAPI 3.0
 * subset that has no equivalent either.
 *
 * This is not a workaround. A closed array of pairs is a stricter contract than
 * an open map — it is checkable, ordered, and it is already the shape ACP uses
 * for `variant_options`. The map was the accident; the array is the honest
 * shape. `fromWire` converts once, at the boundary, so nothing downstream
 * changes.
 */
import { CATEGORIES } from "./taxonomy.ts";

/** A `{name, value}` pair — the only map shape both providers can constrain. */
export type WirePair = { name: string; value: string };

export type WireRowExtraction = {
  source_row: number;
  title: string;
  title_inferred: boolean;
  category: string;
  category_confidence: number;
  options: WirePair[];
  attributes: WirePair[];
  brand: string | null;
  description: string | null;
  variant_group: string | null;
  confidence: number;
};

export type WireExtractionBatch = { rows: WireRowExtraction[] };

/** The internal shape everything downstream of `parseExtraction` sees. */
export type RowExtraction = {
  source_row: number;
  title: string;
  /** True when the sheet had no usable title and this one was inferred. */
  title_inferred: boolean;
  category: string;
  category_confidence: number;
  /** Dimensions that DISTINGUISH a variant: colour, size. */
  options: Record<string, string>;
  /** Everything else: material, gender, … No ACP slot; folded into prose. */
  attributes: Record<string, string>;
  brand: string | null;
  description: string | null;
  /**
   * Rows sharing a group id are variants of one product. The model sets this
   * from semantics ("Canvas Shoe White" and "Canvas Shoe Black" are one
   * product); it does not decide the final id.
   */
  variant_group: string | null;
  confidence: number;
};

export type ExtractionBatch = { rows: RowExtraction[] };

function pairsToRecord(pairs: WirePair[]): Record<string, string> {
  const out: Record<string, string> = {};
  // Last write wins on a duplicate key. Duplicates are a model error, not a
  // meaningful shape, and silently keeping both is not an option a Record has.
  for (const { name, value } of pairs) {
    if (name !== "" && value !== "") out[name] = value;
  }
  return out;
}

export function fromWire(batch: WireExtractionBatch): ExtractionBatch {
  return {
    rows: batch.rows.map((r) => ({
      ...r,
      options: pairsToRecord(r.options),
      attributes: pairsToRecord(r.attributes),
    })),
  };
}

const pairSchema = {
  type: "object",
  additionalProperties: false,
  required: ["name", "value"],
  properties: {
    name: { type: "string", description: "Dimension name, e.g. Colour or Size" },
    value: { type: "string", description: "The value for this row" },
  },
} as const;

/**
 * Canonical schema. Groq strict mode consumes this directly.
 *
 * Constrained decoding requires every property listed in `required` and
 * `additionalProperties: false` throughout — so a nullable field is a REQUIRED
 * field whose type includes `"null"`, never an omitted one. That is a stronger
 * contract than optionality: the model must actively say "no brand" rather than
 * silently leaving it out, and a missing key becomes a schema violation instead
 * of an ambiguity.
 *
 * The `category` enum is what stops the model inventing taxonomy members —
 * PHASE-1.md §2. Under constrained decoding it is a token-level guarantee.
 */
export const EXTRACTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["rows"],
  properties: {
    rows: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "source_row",
          "title",
          "title_inferred",
          "category",
          "category_confidence",
          "options",
          "attributes",
          "brand",
          "description",
          "variant_group",
          "confidence",
        ],
        properties: {
          source_row: {
            type: "integer",
            description: "Echo back the source_row of the input row",
          },
          title: { type: "string" },
          title_inferred: { type: "boolean" },
          category: { type: "string", enum: [...CATEGORIES] },
          category_confidence: { type: "number", minimum: 0, maximum: 1 },
          options: {
            type: "array",
            description: "Only dimensions that distinguish variants: Colour, Size",
            items: pairSchema,
          },
          attributes: {
            type: "array",
            description: "Descriptive, non-distinguishing: material, gender, fit",
            items: pairSchema,
          },
          brand: { type: ["string", "null"] },
          description: { type: ["string", "null"] },
          variant_group: { type: ["string", "null"] },
          confidence: { type: "number", minimum: 0, maximum: 1 },
        },
      },
    },
  },
} as const;

/**
 * Gemini's `responseSchema` is an OpenAPI 3.0 subset, which differs from JSON
 * Schema in three ways this schema actually hits:
 *
 *   - no `additionalProperties`  — dropped
 *   - no union types             — `["string","null"]` becomes `nullable: true`
 *   - no `minimum` / `maximum`   — dropped, so the range is unenforced on the
 *                                  wire and caught by our own validation instead
 *
 * The last one matters for the bake-off: Gemini's adherence is best-effort, and
 * an out-of-range confidence is exactly the kind of thing constrained decoding
 * makes impossible and best-effort does not. `parseExtraction` validates both
 * providers against the canonical schema afterwards, so a violation is caught
 * either way — the difference is whether it can happen at all.
 */
export function toGeminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);
  if (schema === null || typeof schema !== "object") return schema;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (key === "additionalProperties" || key === "minimum" || key === "maximum") {
      continue;
    }
    if (key === "type" && Array.isArray(value)) {
      const concrete = value.find((t) => t !== "null");
      out["type"] = concrete;
      if (value.includes("null")) out["nullable"] = true;
      continue;
    }
    out[key] = toGeminiSchema(value);
  }
  return out;
}
