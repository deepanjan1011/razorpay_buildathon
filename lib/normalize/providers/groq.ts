/**
 * Groq — OpenAI-compatible chat completions with strict structured outputs.
 *
 * Strict mode uses CONSTRAINED DECODING: the schema restricts which tokens the
 * model may emit at each step, so invalid JSON and out-of-enum categories are
 * unreachable rather than unlikely. That is the strongest guarantee available
 * on either provider, and the reason Groq wins a tie in the bake-off.
 *
 * The cost is that strict mode is fussy about the schema: every property must
 * appear in `required`, and `additionalProperties: false` must be set on every
 * object. EXTRACTION_SCHEMA is written to satisfy that directly — see
 * llm-schema.ts on why nullable-required beats optional.
 *
 * Plain fetch rather than an SDK: it is one POST, and a dependency that wraps
 * one POST is a dependency to keep current for nothing.
 */
import { EXTRACTION_SCHEMA } from "../llm-schema.ts";
import { ProviderError, requireKey } from "./types.ts";
import type { Provider, ProviderResponse } from "./types.ts";

const ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";

/** Largest open-weight general model on Groq; the semantics here are hard. */
export const GROQ_MODEL = "openai/gpt-oss-120b";

export function groqProvider(model: string = GROQ_MODEL): Provider {
  return {
    id: "groq",
    model,
    conformance: "constrained",

    async complete(system, user): Promise<ProviderResponse> {
      const response = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${requireKey("GROQ_API_KEY")}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          temperature: 0,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "extraction_batch",
              strict: true,
              schema: EXTRACTION_SCHEMA,
            },
          },
        }),
      });

      const body = await response.text();
      if (!response.ok) throw new ProviderError("groq", response.status, body);

      const json = JSON.parse(body) as {
        model?: string;
        usage?: Record<string, unknown>;
        choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
      };

      const choice = json.choices?.[0];
      const text = choice?.message?.content;
      if (typeof text !== "string") {
        throw new ProviderError("groq", response.status, `no content: ${body.slice(0, 400)}`);
      }
      // A length stop means the JSON is truncated. Constrained decoding
      // guarantees the grammar, not that the budget was enough to finish it.
      if (choice?.finish_reason === "length") {
        throw new ProviderError("groq", response.status, "response truncated (finish_reason=length)");
      }

      return {
        text,
        model_served: json.model ?? model,
        usage: json.usage ?? null,
      };
    },
  };
}
