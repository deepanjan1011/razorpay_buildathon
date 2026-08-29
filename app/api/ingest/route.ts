/**
 * POST /api/ingest — upload a spreadsheet, start or resume its job.
 *
 * Returns 202 and a job id, never the finished catalogue: extraction takes
 * minutes at real catalogue size (PLAN.md §4a). Poll
 * `GET /api/ingest/{jobId}`.
 *
 * IDEMPOTENT. The job id is derived from merchant + filename + row count, so a
 * refresh, a double-click or a retried request lands on the same job and
 * resumes it. Without that, a double submission would silently cost a second
 * full catalogue of API calls against a 5 requests/minute budget.
 */
import { connect } from "../../../lib/db/sql.ts";
import { ingestUpload } from "../../../lib/ingest/pipeline.ts";
import { errorResponse } from "../../../lib/feed/http.ts";
import { timingSafeEqual } from "node:crypto";

export const dynamic = "force-dynamic";

/** Small-merchant sheets are small. A cap here is a trust boundary, not a tuning knob. */
const MAX_BYTES = 10 * 1024 * 1024;

/**
 * WHERE AN ANONYMOUS UPLOAD IS ALLOWED TO LAND.
 *
 * This route has no authentication, which is fine on a laptop and is not fine
 * on a public URL: the merchant id arrives in the form, so anyone could post a
 * spreadsheet as `mer_live` and replace the catalogue the demo buys from —
 * correctly, because replacing a catalogue is exactly what this endpoint does.
 *
 * So in production the submitted id is IGNORED and every upload lands on a
 * sandbox merchant. The page keeps working and cannot reach the demo data.
 *
 * LOCKED BY DEFAULT rather than by configuration. A guard that has to be
 * switched on is a guard that ships off, and the failure is silent until
 * someone has already overwritten the catalogue.
 *
 * `INGEST_KEY` is the way back in for whoever owns the deployment: a request
 * carrying it may name its own merchant, which is how the real catalogue gets
 * seeded. Unset means nobody can, including the owner — the safe direction.
 */
const presented = (request: Request) => request.headers.get("x-ingest-key");

function equal(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  // Lengths differ: not equal, and not comparable in constant time either.
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

export function merchantFor(request: Request, submitted: string): string {
  // READ PER REQUEST, not once at import. A value captured at module load is a
  // value a test cannot vary and a rotated key cannot change — the same reason
  // the MCP server reads its token per call rather than at startup.
  if (process.env.NODE_ENV !== "production") return submitted;
  const key = process.env["INGEST_KEY"];
  // Constant-time, like every other secret comparison in this repo (agent
  // tokens, webhook signatures, mandate signatures). `===` on a secret leaks
  // the length of the matching prefix through timing, and being the one place
  // that does it differently is how the odd one out stays odd.
  if (key && presented(request) !== null && equal(presented(request)!, key)) return submitted;
  return process.env["INGEST_SANDBOX_MERCHANT"] ?? "mer_try";
}

export async function POST(request: Request): Promise<Response> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return errorResponse(400, {
      type: "invalid_request",
      code: "expected_multipart_form",
      message: "Send the spreadsheet as multipart/form-data with a `file` field",
      param: "file",
    });
  }

  const file = form.get("file");
  const merchantId = String(form.get("merchant_id") ?? "").trim();

  if (!(file instanceof File)) {
    return errorResponse(400, {
      type: "invalid_request",
      code: "missing_file",
      message: "No `file` field in the upload",
      param: "file",
    });
  }
  // Merchant ids reach the filesystem through the feed store, so they are
  // validated rather than trusted — same rule as feed ids.
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(merchantId)) {
    return errorResponse(400, {
      type: "invalid_request",
      code: "invalid_merchant_id",
      message: "merchant_id must be 1-64 characters of [A-Za-z0-9_-]",
      param: "merchant_id",
    });
  }
  if (file.size > MAX_BYTES) {
    return errorResponse(413, {
      type: "invalid_request",
      code: "file_too_large",
      message: `Spreadsheet is ${file.size} bytes; the limit is ${MAX_BYTES}`,
      param: "file",
    });
  }

  // Validated first, then possibly replaced: a bad id is still a 400 rather
  // than being quietly swallowed by the sandbox, so the form keeps telling the
  // truth about what it accepts.
  const landingMerchant = merchantFor(request, merchantId);

  try {
    const { progress, resumed } = await ingestUpload(await connect(), {
      merchantId: landingMerchant,
      sourceFile: file.name,
      bytes: await file.arrayBuffer(),
    });

    return new Response(JSON.stringify({ ...progress, resumed }), {
      status: 202,
      headers: {
        "Content-Type": "application/json",
        // Where to watch it. The client should not guess this URL.
        Location: `/api/ingest/${progress.id}`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // A workbook we cannot parse is the merchant's problem to see, not a 500.
    if (/no sheets|zip|corrupt|End of (data|central)/i.test(message)) {
      return errorResponse(400, {
        type: "invalid_request",
        code: "unreadable_spreadsheet",
        message: `Could not read the workbook: ${message}`,
        param: "file",
      });
    }
    console.error("[ingest] upload failed:", error);
    return errorResponse(500, {
      type: "server_error",
      code: "ingest_failed",
      message: "Could not start the ingest job",
    });
  }
}
