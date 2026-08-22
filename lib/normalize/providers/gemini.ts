/**
 * Gemini — generateContent with a `responseSchema`.
 *
 * Adherence is BEST EFFORT. The schema is a strong hint honoured in the normal
 * case, not a decoding constraint, so an out-of-enum category or an
 * out-of-range confidence is possible in a way it is not on Groq. Our own
 * validation in `parseExtraction` catches it either way — the difference the
 * bake-off is weighing is whether it can happen at all.
 *
 * Against that, Gemini is a frontier model where Groq serves open weights, and
 * the semantic work here is exactly where open weights are weakest: Tamil
 * headers, transliterated Tamil, and pulling `Blk RunShoe M-9` apart.
 *
 * `responseSchema` is an OpenAPI 3.0 subset — `toGeminiSchema` handles the
 * three differences this schema hits.
 */
import { EXTRACTION_SCHEMA, toGeminiSchema } from "../llm-schema.ts";
import { fetchRetrying } from "./retry.ts";
import { ProviderError, requireKey } from "./types.ts";
import type { Provider, ProviderResponse } from "./types.ts";

export const GEMINI_MODEL = "gemini-3.5-flash";

export function geminiProvider(model: string = GEMINI_MODEL): Provider {
  return {
    id: "gemini",
    model,
    conformance: "best_effort",

    async complete(system, user): Promise<ProviderResponse> {
      const url =
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

      const response = await fetchRetrying("gemini", url, {
        method: "POST",
        headers: {
          "x-goog-api-key": requireKey("GEMINI_API_KEY"),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: "user", parts: [{ text: user }] }],
          generationConfig: {
            temperature: 0,
            responseMimeType: "application/json",
            responseSchema: toGeminiSchema(EXTRACTION_SCHEMA),
          },
        }),
      }, {
        onRetry: (i) =>
          console.warn(
            `  gemini retry ${i.attempt} (${i.status ?? "network"}), ` +
              `waiting ${Math.round(i.waitMs / 100) / 10}s [${i.source}]`,
          ),
      });

      const body = response.body;
      if (!response.ok) throw new ProviderError("gemini", response.status, body);

      const json = JSON.parse(body) as {
        modelVersion?: string;
        usageMetadata?: Record<string, unknown>;
        promptFeedback?: { blockReason?: string };
        candidates?: Array<{
          finishReason?: string;
          content?: { parts?: Array<{ text?: string }> };
        }>;
      };

      // A safety block is a refusal, and it arrives as a 200 with no candidate.
      // Surfacing it as "no content" would hide why.
      if (json.promptFeedback?.blockReason) {
        throw new ProviderError(
          "gemini",
          response.status,
          `blocked: ${json.promptFeedback.blockReason}`,
        );
      }

      const candidate = json.candidates?.[0];
      if (candidate?.finishReason && !["STOP", "MAX_TOKENS"].includes(candidate.finishReason)) {
        throw new ProviderError("gemini", response.status, `finishReason=${candidate.finishReason}`);
      }
      if (candidate?.finishReason === "MAX_TOKENS") {
        throw new ProviderError("gemini", response.status, "response truncated (MAX_TOKENS)");
      }

      const text = (candidate?.content?.parts ?? [])
        .map((p) => p.text ?? "")
        .join("");
      if (text === "") {
        throw new ProviderError("gemini", response.status, `no content: ${body.slice(0, 400)}`);
      }

      return {
        text,
        model_served: json.modelVersion ?? model,
        usage: json.usageMetadata ?? null,
      };
    },
  };
}
