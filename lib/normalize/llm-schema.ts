/**
 * The schema for what the LLM returns. This is NOT the ACP feed schema.
 *
 * The model produces semantics only, for our internal model. It is never asked
 * for a price, a stock level, or a currency — those are deterministic
 * (lib/ingest/cells.ts), and PHASE-1.md §4 is explicit that anything a parser
 * can do reliably must not go through the model. Keeping money out of the
 * model's output is also what makes CLAUDE.md invariant 1 structural rather
 * than aspirational: the model cannot influence an amount it never emits.
 *
 * The ACP projection happens later and separately (lib/feed/project.ts).
 */
import { CATEGORIES } from "./taxonomy.ts";

/** One row's semantic reading. Keyed back to the sheet row it came from. */
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
   * from the semantics ("Canvas Shoe White" and "Canvas Shoe Black" are one
   * product); it does not decide the final id.
   */
  variant_group: string | null;
  confidence: number;
};

export type ExtractionBatch = { rows: RowExtraction[] };

const stringMap = {
  type: "object",
  additionalProperties: { type: "string" },
} as const;

/**
 * `strict: true` on the Anthropic side requires `additionalProperties: false`
 * and an explicit `required` list on every object. The category `enum` is what
 * stops the model inventing taxonomy members — PHASE-1.md §2.
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
          source_row: { type: "integer" },
          title: { type: "string" },
          title_inferred: { type: "boolean" },
          category: { type: "string", enum: [...CATEGORIES] },
          category_confidence: { type: "number", minimum: 0, maximum: 1 },
          options: stringMap,
          attributes: stringMap,
          brand: { type: ["string", "null"] },
          description: { type: ["string", "null"] },
          variant_group: { type: ["string", "null"] },
          confidence: { type: "number", minimum: 0, maximum: 1 },
        },
      },
    },
  },
} as const;
