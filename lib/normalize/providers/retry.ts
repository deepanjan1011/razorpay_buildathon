/**
 * Capped retry for transport failures. CLAUDE.md invariant 4.
 *
 * What may be retried is deliberately narrow:
 *
 *   429  rate limited — the request was fine, the timing was not
 *   5xx  the provider broke
 *   network errors
 *
 * Everything else, and 4xx in particular, is a bug in our request. Retrying a
 * 400 just spends the same mistake several times and buries the message.
 *
 * The invariant also requires idempotency keys on retried mutating calls. These
 * calls mutate nothing — extraction is a pure read — so there is no operation to
 * make idempotent. That is why no key is sent, rather than an oversight.
 *
 * MEASURED, not assumed: the Gemini free tier allows 5 requests per minute per
 * model, and says so in the response body rather than in a header —
 * `google.rpc.RetryInfo` with `retryDelay: "19s"`, and no `Retry-After` at all.
 * An exponential backoff topping out at four seconds therefore never waited
 * long enough and burned all its attempts inside a single rate-limit window,
 * failing 500 of 500 rows. Reading what the server actually says is the fix;
 * guessing shorter just earns another 429.
 */
import { ProviderError } from "./types.ts";

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

/** A rate-limit window can be a minute. Backoff has to be able to outlast one. */
const MAX_BACKOFF_MS = 70_000;

export type RetryOptions = {
  /** Total attempts including the first. */
  attempts?: number;
  /** Base backoff in ms; doubles each attempt, with jitter. */
  baseDelayMs?: number;
  /** Called before each wait, so callers can report rather than sit silent. */
  onRetry?: (info: {
    attempt: number;
    status: number | null;
    waitMs: number;
    source: "server" | "backoff";
  }) => void;
};

export type RetryingResponse = {
  status: number;
  ok: boolean;
  /** Read once here, so callers cannot hit "body already consumed". */
  body: string;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * How long the server told us to wait, in whichever of the three places it
 * chose to say so. Only the first is standard HTTP; Google uses the third.
 */
export function serverDelayMs(headers: Headers, body: string): number | null {
  const header = headers.get("retry-after");
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const date = Date.parse(header);
    if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  }

  try {
    const json = JSON.parse(body) as {
      error?: { message?: string; details?: Array<Record<string, unknown>> };
    };

    for (const detail of json.error?.details ?? []) {
      if (
        detail["@type"] === "type.googleapis.com/google.rpc.RetryInfo" &&
        typeof detail["retryDelay"] === "string"
      ) {
        const seconds = Number(detail["retryDelay"].replace(/s$/, ""));
        if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
      }
    }

    // Last resort: the prose message carries it too ("Please retry in 19.12s").
    const prose = /retry in ([\d.]+)s/i.exec(json.error?.message ?? "");
    if (prose?.[1]) return Math.max(0, Number(prose[1]) * 1000);
  } catch {
    // Not JSON, or not shaped that way. Fall through to backoff.
  }

  return null;
}

export async function fetchRetrying(
  provider: string,
  url: string,
  init: RequestInit,
  options: RetryOptions = {},
): Promise<RetryingResponse> {
  const attempts = options.attempts ?? 5;
  const base = options.baseDelayMs ?? 1000;

  let lastError: unknown = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    let response: Response;
    let body: string;
    try {
      response = await fetch(url, init);
      body = await response.text();
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      const waitMs = Math.min(MAX_BACKOFF_MS, base * 2 ** (attempt - 1) + Math.random() * 250);
      options.onRetry?.({ attempt, status: null, waitMs, source: "backoff" });
      await sleep(waitMs);
      continue;
    }

    if (!RETRYABLE.has(response.status)) {
      return { status: response.status, ok: response.ok, body };
    }
    if (attempt === attempts) {
      // Caller turns this into a ProviderError with the body intact.
      return { status: response.status, ok: false, body };
    }

    const fromServer = serverDelayMs(response.headers, body);
    const waitMs = Math.min(
      MAX_BACKOFF_MS,
      // A second of slack on the server's figure: retrying at the exact
      // boundary of a rate-limit window tends to land just inside it.
      fromServer !== null
        ? fromServer + 1000
        : base * 2 ** (attempt - 1) + Math.random() * 250,
    );
    options.onRetry?.({
      attempt,
      status: response.status,
      waitMs,
      source: fromServer !== null ? "server" : "backoff",
    });
    await sleep(waitMs);
  }

  throw new ProviderError(
    provider,
    0,
    `network failure after ${attempts} attempts: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}
