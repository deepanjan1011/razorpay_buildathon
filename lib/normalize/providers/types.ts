/**
 * The provider seam.
 *
 * DESIGN.md §6 originally named Claude. No Anthropic key is available, so the
 * normalizer runs on Groq or Gemini instead — and rather than swap one vendor
 * name for another, the choice now lives behind this interface. Nothing outside
 * `lib/normalize/providers/` names a vendor.
 *
 * A provider does exactly one thing: send a system prompt plus rows, return raw
 * text and what actually served it. It does not parse, validate, or interpret —
 * `parseExtraction` does that identically for every provider, so the two are
 * compared on the same terms.
 */
export type ProviderResponse = {
  /** Raw response text. Parsed and validated by the caller, not here. */
  text: string;
  /** What the API says actually ran. The drift signal for the eval. */
  model_served: string;
  /** Provider-reported usage, when available. Shapes differ; kept verbatim. */
  usage: Record<string, unknown> | null;
};

export type Provider = {
  /** Stable id used in fingerprints and the bake-off table. */
  readonly id: string;
  /** The model string sent. */
  readonly model: string;
  /**
   * How the output shape is enforced on the wire. This is the axis the
   * bake-off exists to weigh, so it is recorded rather than assumed:
   *
   *   "constrained" — token-level decoding against the schema. Invalid JSON and
   *                   out-of-enum values are not merely unlikely, they are
   *                   unreachable.
   *   "best_effort" — the schema is a strong hint. Adherence is typical, not
   *                   guaranteed.
   */
  readonly conformance: "constrained" | "best_effort";
  complete(system: string, user: string): Promise<ProviderResponse>;
};

/** Thrown for any non-2xx, with the body, so failures are loud and diagnosable. */
export class ProviderError extends Error {
  // Explicit fields rather than constructor parameter properties: Node strips
  // types rather than compiling them, so only erasable syntax is allowed.
  readonly provider: string;
  readonly status: number;
  readonly body: string;

  constructor(provider: string, status: number, body: string) {
    super(`${provider} returned ${status}: ${body.slice(0, 600)}`);
    this.name = "ProviderError";
    this.provider = provider;
    this.status = status;
    this.body = body;
  }
}

export function requireKey(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. cp .env.example .env and fill it in, or export it.`,
    );
  }
  return value;
}
