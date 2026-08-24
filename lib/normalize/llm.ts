/**
 * The one structured-output call. DESIGN.md §6 — no orchestration framework.
 *
 * The model is asked for semantics and nothing else. It never sees a request
 * for a price, a currency or a stock level; those are parsed deterministically
 * before this runs. CLAUDE.md invariant 1 is therefore structural rather than a
 * promise: the model cannot influence an amount it is never asked to emit.
 *
 * The provider is injected. Nothing here or downstream names a vendor — see
 * providers/types.ts for why, and OBSTACLES.md for what changed.
 */
import { createHash } from "node:crypto";

import { createAjv, formatErrors } from "../schema/ajv.ts";
import { EXTRACTION_SCHEMA, fromWire } from "./llm-schema.ts";
import type { ExtractionBatch, WireExtractionBatch } from "./llm-schema.ts";
import { CATEGORIES } from "./taxonomy.ts";
import { geminiProvider } from "./providers/gemini.ts";
import { groqProvider } from "./providers/groq.ts";
import type { Provider } from "./providers/types.ts";

export { geminiProvider, groqProvider };
export type { Provider };

/**
 * The provider the pipeline uses by default.
 *
 * Gemini, set from the bake-off in OBSTACLES.md rather than by preference:
 * 40/40 field observations on the discriminating rows in each of two runs,
 * against 37/40 and 39/40 for the strongest Groq model, whose every miss was
 * the transliterated-Tamil row. That n is small — 40 observations is "no
 * failures observed", not a demonstrated property — and the decision is
 * recorded with reversal conditions for exactly that reason.
 *
 * That is not the tie the constrained-decoding advantage was meant to settle.
 * The guarantee protects against a failure that did not occur in any run; the
 * semantic gap that did occur lands precisely on the merchants this project
 * exists for. `parseExtraction` validates every provider's output against the
 * canonical schema anyway, so best-effort adherence degrades to a loud error
 * rather than a silent bad record.
 *
 * Change it here and nowhere else — then re-run the eval, because the number
 * belongs to the provider that produced it.
 */
export function defaultProvider(): Provider {
  const choice = process.env["NORMALIZER_PROVIDER"] ?? "gemini";
  switch (choice) {
    case "groq":
      return groqProvider();
    case "gemini":
      return geminiProvider();
    default:
      throw new Error(`unknown NORMALIZER_PROVIDER: ${choice} (groq | gemini)`);
  }
}

export const SYSTEM_PROMPT = `You read rows from a small merchant's product spreadsheet and return what each row MEANS.

You are given rows that have already been parsed. Prices, stock levels and currency have ALREADY been handled deterministically and are not your concern — never infer, restate or correct them.

For each row, return:

- source_row: echo back the source_row you were given, unchanged.
- title: the product name AS THE MERCHANT WROTE IT. Reproduce their wording. The ONE change you may make is expanding shorthand: "Blk RunShoe M-9" is a black running shoe in men's size 9, so the title is "Running Shoe". Everything else stays theirs.
  - Do NOT correct spelling. "Raggi murukku" stays "Raggi murukku"; "Bitter Guard Chips" stays "Bitter Guard Chips"; "Moong dhall" stays "Moong dhall". The catalogue is the merchant's, and silently respelling it takes their own product name away from them.
  - Do NOT drop a word that distinguishes one product from another. "Black Sesame Chikki" and "White Sesame Chikki" are DIFFERENT PRODUCTS, and "Sesame Chikki" names neither of them. Dropping "Yellow" from "Yellow Banana Chips" where the sheet also lists "Banana Chips Sweet" merges two things a buyer would not confuse.
  - Do NOT put the size or colour in the title; they belong in options. But a colour word that names an INGREDIENT or VARIETY is part of the name: black sesame is a kind of seed, not a colour of chikki. Treat a colour as an option only where the same product appears in the sheet in more than one colour.
- title_inferred: true ONLY if the row gave you nothing to name the product from and you invented one. Expanding merchant shorthand is NOT inferring — "Blk RunShoe M-9" already names the product, so title_inferred is false there. Translating is not inferring either. Set it true when the row genuinely had no name.
- category: exactly one of the fixed list. You cannot invent members. If nothing fits with confidence, return "unmapped" — do not force-fit.
- category_confidence: 0-1. Be honest. A low number sends the row to a human, which is the correct outcome when you are unsure.
- options: ONLY dimensions that distinguish one variant from another of the SAME product — typically Colour and Size. Use the merchant's own values ("9", not "UK 9"), with capitalised names ("Colour", "Size"). Empty array if none.
- attributes: everything else descriptive — material, gender, fit, occasion. These do NOT distinguish variants. Empty array if none.
- brand: the brand if stated. null if not. Never guess a brand from the product type.
- description: a short factual description if the sheet gives you material to write one. null otherwise. Never invent features, quality claims or marketing copy.
- variant_group: a stable lowercase slug shared by rows that are variants of ONE product. "Canvas Shoe White" and "Canvas Shoe Black" share "canvas-shoe". A row that stands alone gets null.
- confidence: 0-1 for the row overall.

Some sheets are in Tamil, or in Tamil transliterated into Latin script ("Paruthi Sattai" is a cotton shirt). Read them, and translate a title written in Tamil SCRIPT into English where you are confident of the meaning. Preserve the original wording in description when it carries information you cannot translate confidently.

A title already written in Latin script is NOT translated and NOT re-spelled: "Oma podi" stays "Oma podi", not "Omapodi"; "Pottukadalai laddu" stays as written. The merchant chose that spelling. Re-spelling a transliteration is the same mistake as correcting one.

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

export type Fingerprint = {
  provider: string;
  conformance: string;
  model_requested: string;
  model_served: string;
  prompt_sha256: string;
};

export type ExtractionResult = {
  batch: ExtractionBatch;
  fingerprint: Fingerprint;
  usage: Record<string, unknown> | null;
  /** Milliseconds for the call itself. Reported by the bake-off. */
  latency_ms: number;
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

export function createExtractor(provider: Provider = defaultProvider()): ExtractFn {
  return async function extract(rows) {
    const started = Date.now();
    const response = await provider.complete(SYSTEM_PROMPT, JSON.stringify({ rows }));
    const latency_ms = Date.now() - started;

    return {
      batch: parseExtraction(response.text),
      fingerprint: {
        provider: provider.id,
        conformance: provider.conformance,
        model_requested: provider.model,
        model_served: response.model_served,
        prompt_sha256: promptFingerprint(),
      },
      usage: response.usage,
      latency_ms,
    };
  };
}

/**
 * Validates model output against our own schema before anything downstream
 * touches it — identically for every provider, so the two are comparable.
 *
 * This runs even for a provider whose decoding is constrained. The constraint
 * is the provider's claim about itself; this is our check of it, and the
 * boundary between a non-deterministic component and deterministic code is not
 * a place to take a vendor's word.
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

  return fromWire(parsed as WireExtractionBatch);
}
