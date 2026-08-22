/**
 * The one structured-output call. DESIGN.md §6 — no orchestration framework.
 *
 * The model is asked for semantics and nothing else. It never sees a request
 * for a price, a currency or a stock level; those are parsed deterministically
 * before this runs. CLAUDE.md invariant 1 is therefore structural here rather
 * than a promise: the model cannot influence an amount it is never asked to
 * emit.
 *
 * The client is injected so tests, and the eval harness, can run without a key.
 */
import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";

import { createAjv, formatErrors } from "../schema/ajv.ts";
import { EXTRACTION_SCHEMA } from "./llm-schema.ts";
import type { ExtractionBatch } from "./llm-schema.ts";
import { CATEGORIES } from "./taxonomy.ts";

/**
 * No dated snapshot exists for this model — `claude-opus-5` is the complete and
 * exact ID, and appending a date produces an invalid one. The eval is therefore
 * made auditable rather than reproducible: every run records `response.model`
 * alongside the number. See docs/NORMALIZATION-EVAL.md.
 */
export const MODEL = "claude-opus-5";
export const EFFORT = "high";

export const SYSTEM_PROMPT = `You read rows from a small merchant's product spreadsheet and return what each row MEANS.

You are given rows that have already been parsed. Prices, stock levels and currency have ALREADY been handled deterministically and are not your concern — never infer, restate or correct them.

For each row, return:

- title: the product name a buyer would recognise. Expand merchant shorthand: "Blk RunShoe M-9" is a black running shoe in men's size 9, so the title is "Running Shoe - Black". Do NOT put the size or colour in the title; they belong in options.
- title_inferred: true if the sheet had no usable product name and you constructed one.
- category: exactly one of the fixed list. You cannot invent members. If nothing fits with confidence, return "unmapped" — do not force-fit.
- category_confidence: 0-1. Be honest. A low number sends the row to a human, which is the correct outcome when you are unsure.
- options: ONLY dimensions that distinguish one variant from another of the SAME product — typically Colour and Size. Use the merchant's own values ("9", not "UK 9"), with capitalised keys ("Colour", "Size").
- attributes: everything else descriptive — material, gender, fit, occasion. These do NOT distinguish variants.
- brand: the brand if stated. null if not. Never guess a brand from the product type.
- description: a short factual description if the sheet gives you material to write one. null otherwise. Never invent features, quality claims or marketing copy.
- variant_group: a stable slug shared by rows that are variants of ONE product. "Canvas Shoe White" and "Canvas Shoe Black" share "canvas-shoe". A row that stands alone gets null.
- confidence: 0-1 for the row overall.

Some sheets are in Tamil, or in Tamil transliterated into Latin script ("Paruthi Sattai" is a cotton shirt). Read them. Return the title in English where you are confident of the meaning, and preserve the original wording in description when it carries information you cannot translate confidently.

Rules:
- Never invent a product that is not in the row.
- Prefer "unmapped" and low confidence over a confident guess. A flagged row is reviewed by the merchant; a wrong confident row is published to buyers.
- Return exactly one entry per input row, keyed by its source_row.

Valid categories: ${CATEGORIES.join(", ")}.`;

/** Rows as handed to the model — deterministic fields deliberately excluded. */
export type ExtractionInput = {
  source_row: number;
  /** Raw cells minus anything price- or stock-shaped. */
  cells: Record<string, string>;
};

export type ExtractionResult = {
  batch: ExtractionBatch;
  fingerprint: {
    model_requested: string;
    model_served: string;
    effort: string;
    prompt_sha256: string;
  };
};

const ajv = createAjv();
const validateBatch = ajv.compile(EXTRACTION_SCHEMA);

/**
 * Hashes the system prompt together with the output schema.
 *
 * A prompt edit invalidates a published accuracy number just as surely as a
 * model change does, and is far easier to make without noticing — so it is part
 * of the fingerprint, not a footnote.
 */
export function promptFingerprint(): string {
  return createHash("sha256")
    .update(SYSTEM_PROMPT)
    .update(JSON.stringify(EXTRACTION_SCHEMA))
    .digest("hex");
}

export type ExtractFn = (rows: ExtractionInput[]) => Promise<ExtractionResult>;

export function createExtractor(client = new Anthropic()): ExtractFn {
  return async function extract(rows) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 16000,
      system: SYSTEM_PROMPT,
      output_config: {
        effort: EFFORT,
        format: { type: "json_schema", schema: EXTRACTION_SCHEMA },
      },
      messages: [{ role: "user", content: JSON.stringify({ rows }) }],
    });

    if (response.stop_reason === "refusal") {
      throw new Error(
        `extraction refused: ${response.stop_details?.explanation ?? "no explanation"}`,
      );
    }

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");

    return {
      batch: parseExtraction(text),
      fingerprint: {
        model_requested: MODEL,
        model_served: response.model,
        effort: EFFORT,
        prompt_sha256: promptFingerprint(),
      },
    };
  };
}

/**
 * Validates model output against our own schema before anything downstream
 * touches it.
 *
 * Structured output constrains the model, but this is the boundary between a
 * non-deterministic component and deterministic code, and DESIGN.md §7 already
 * records that normalization is non-deterministic and must be measured. A
 * boundary you do not check is a boundary you are trusting.
 */
export function parseExtraction(text: string): ExtractionBatch {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new Error(`extraction was not valid JSON: ${String(cause)}`);
  }

  if (!validateBatch(parsed)) {
    const errors = formatErrors(validateBatch.errors)
      .map((e) => `  ${e.path}: ${e.message}`)
      .join("\n");
    throw new Error(`extraction failed schema validation:\n${errors}`);
  }

  return parsed as ExtractionBatch;
}
