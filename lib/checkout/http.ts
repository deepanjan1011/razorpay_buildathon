/**
 * Shared HTTP behaviour for the ACP checkout endpoints.
 *
 * Headers the spec marks `required: true` on these paths: `Authorization`,
 * `Content-Type`, `Idempotency-Key` (POST only) and `API-Version`. The
 * remainder — `Accept-Language`, `User-Agent`, `Request-Id`, `Signature`,
 * `Timestamp` — are optional and are read where useful, not demanded.
 *
 * The error codes here are not invented. `schema.agentic_checkout.json`'s
 * `Error` description names them: `idempotency_key_required`,
 * `idempotency_in_flight`, `idempotency_conflict`, under
 * `type: invalid_request`.
 */
import type { Sql } from "../db/sql.ts";
import { bodyHash } from "./session.ts";
import { ACP_API_VERSION, validate } from "./validate.ts";

export type AcpError = {
  type: "invalid_request" | "processing_error" | "service_unavailable";
  code: string;
  message: string;
  param?: string;
};

export function errorResponse(status: number, error: AcpError): Response {
  return new Response(JSON.stringify(error), {
    status,
    headers: {
      "Content-Type": "application/json",
      "API-Version": ACP_API_VERSION,
      "Cache-Control": "no-store",
    },
  });
}

export function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "API-Version": ACP_API_VERSION,
      "Cache-Control": "no-store",
      ...extra,
    },
  });
}

/**
 * Serves a session only if it validates against the pinned schema.
 *
 * DESIGN.md §2 says validate every response; a validator that only runs in
 * tests validates test fixtures. If our own session is malformed, a 500 naming
 * the violation beats a 200 teaching an agent the wrong shape — this is the
 * last moment anyone on our side can notice.
 */
export function conformantSession(
  status: number,
  session: unknown,
  definition: "CheckoutSession" | "CheckoutSessionWithOrder" = "CheckoutSession",
): Response {
  const errors = validate(definition, session);
  if (errors.length > 0) {
    console.error(`[checkout] outbound ${definition} failed validation:`, errors);
    return errorResponse(500, {
      type: "processing_error",
      code: "session_schema_violation",
      message: `Generated ${definition} does not conform to ACP ${ACP_API_VERSION}`,
    });
  }
  return json(status, session);
}

/** Required on every path. A mismatch is refused rather than answered wrongly. */
export function checkHeaders(request: Request, opts: { post: boolean }): Response | null {
  const version = request.headers.get("api-version");
  if (!version) {
    return errorResponse(400, {
      type: "invalid_request",
      code: "missing_api_version",
      message: `API-Version is required; this server serves ${ACP_API_VERSION}`,
      param: "API-Version",
    });
  }
  if (version !== ACP_API_VERSION) {
    return errorResponse(400, {
      type: "invalid_request",
      code: "unsupported_api_version",
      message: `This server serves API-Version ${ACP_API_VERSION}, not ${version}`,
      param: "API-Version",
    });
  }
  if (!request.headers.get("authorization")) {
    return errorResponse(401, {
      type: "invalid_request",
      code: "missing_authorization",
      message: "Authorization header is required",
      param: "Authorization",
    });
  }
  if (opts.post) {
    const key = request.headers.get("idempotency-key");
    if (!key) {
      return errorResponse(400, {
        type: "invalid_request",
        code: "idempotency_key_required",
        message: "Idempotency-Key MUST be present on all POST requests",
        param: "Idempotency-Key",
      });
    }
    if (key.length > 255) {
      return errorResponse(400, {
        type: "invalid_request",
        code: "invalid_request",
        message: "Idempotency-Key must be at most 255 characters",
        param: "Idempotency-Key",
      });
    }
  }
  return null;
}

export type Replay =
  | { kind: "replay"; response: Response }
  | { kind: "conflict"; response: Response }
  | { kind: "proceed"; commit: (status: number, body: unknown) => Promise<void> };

/**
 * Idempotency, enforced by us because Razorpay does not offer it (DESIGN.md §2)
 * and because ACP requires it regardless of what the PSP supports.
 *
 * The mechanism is the batch-claim pattern again: a conditional INSERT wins or
 * loses, and Postgres decides. That matters more here than it looks — the
 * alternative, "check then insert", has a window in which two concurrent
 * retries of the same request both find nothing and both execute. On the
 * `complete` endpoint later, both executing means two Razorpay orders.
 *
 * Three outcomes, all named by the spec's own error codes:
 *
 *   same key, same body, finished   -> replay the stored response verbatim
 *   same key, still running         -> 409 idempotency_in_flight
 *   same key, DIFFERENT body        -> 409 idempotency_conflict
 *
 * The last is a client bug and must never be answered with the old response:
 * silently returning a session for a cart the caller did not ask for is worse
 * than an error.
 */
export async function withIdempotency(
  sql: Sql,
  request: Request,
  endpoint: string,
  merchantId: string,
  body: unknown,
): Promise<Replay> {
  const key = request.headers.get("idempotency-key") ?? "";
  const hash = bodyHash(body);

  const { rows: claimed } = await sql.query<{ key: string }>(
    `insert into idempotency_record
       (key, endpoint, merchant_id, request_sha256, response_status, response_body)
     values ($1, $2, $3, $4, 0, '{}'::jsonb)
     on conflict (key, endpoint) do nothing
     returning key`,
    [key, endpoint, merchantId, hash],
  );

  if (claimed.length > 0) {
    return {
      kind: "proceed",
      commit: async (status, responseBody) => {
        await sql.query(
          `update idempotency_record
              set response_status = $3, response_body = $4
            where key = $1 and endpoint = $2`,
          [key, endpoint, status, JSON.stringify(responseBody)],
        );
      },
    };
  }

  const { rows } = await sql.query<{
    request_sha256: string;
    response_status: number;
    response_body: unknown;
  }>(
    `select request_sha256, response_status, response_body
       from idempotency_record where key = $1 and endpoint = $2`,
    [key, endpoint],
  );
  const record = rows[0];

  if (!record) {
    // The row vanished between the failed insert and this read. Vanishingly
    // unlikely, and reporting it beats guessing which of the three cases it was.
    return {
      kind: "conflict",
      response: errorResponse(409, {
        type: "invalid_request",
        code: "idempotency_in_flight",
        message: "Idempotency record is being written; retry shortly",
        param: "Idempotency-Key",
      }),
    };
  }

  if (record.request_sha256 !== hash) {
    return {
      kind: "conflict",
      response: errorResponse(409, {
        type: "invalid_request",
        code: "idempotency_conflict",
        message: "This Idempotency-Key was used with a different request body",
        param: "Idempotency-Key",
      }),
    };
  }

  if (record.response_status === 0) {
    return {
      kind: "conflict",
      response: errorResponse(409, {
        type: "invalid_request",
        code: "idempotency_in_flight",
        message: "A request with this Idempotency-Key is still in progress",
        param: "Idempotency-Key",
      }),
    };
  }

  return {
    kind: "replay",
    response: json(record.response_status, record.response_body, {
      "Idempotent-Replay": "true",
    }),
  };
}

/**
 * Turns the agent's `line_items` into quantities.
 *
 * QUANTITY IS EXPRESSED BY REPETITION, and that is not a choice we made.
 * `Item` in `schema.agentic_checkout.json` declares exactly `{id, name?,
 * unit_amount?}` with `additionalProperties: false` — there is no `quantity`
 * property, so `{"id": "x", "quantity": 2}` is a schema violation. Two of a
 * thing is the id twice.
 *
 * (The schema's own description of `Item` says "a purchasable item with variant
 * options (e.g., size, color) and quantity", which contradicts its properties.
 * Recorded in OBSTACLES.md. We follow the schema, because the schema is what
 * validates.)
 *
 * Aggregating rather than creating duplicate lines is the useful reading: an
 * agent asking for the same variant twice means two units, not two carts.
 */
export function aggregate(items: Array<{ id: string }>): Array<{ id: string; quantity: number }> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const id = String(item.id);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return [...counts.entries()].map(([id, quantity]) => ({ id, quantity }));
}

/** Parses and schema-checks a request body. Malformed input is the caller's. */
export async function readBody(
  request: Request,
  definition:
    | "CheckoutSessionCreateRequest"
    | "CheckoutSessionUpdateRequest"
    | "CheckoutSessionCompleteRequest",
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; response: Response }> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return {
      ok: false,
      response: errorResponse(400, {
        type: "invalid_request",
        code: "invalid_json",
        message: "Request body is not valid JSON",
      }),
    };
  }

  const errors = validate(definition, parsed);
  if (errors.length > 0) {
    const first = errors[0];
    return {
      ok: false,
      response: errorResponse(400, {
        type: "invalid_request",
        code: "invalid_request",
        message: `Request does not conform to ${definition}: ${first?.message ?? "invalid"}`,
        // RFC 9535 JSONPath, as the spec asks for on `param`.
        param: `$${(first?.path ?? "/").replace(/\//g, ".")}`,
      }),
    };
  }

  return { ok: true, body: parsed as Record<string, unknown> };
}

export { ACP_API_VERSION };
