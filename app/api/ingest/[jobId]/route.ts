/**
 * GET /api/ingest/{jobId} — progress for a running, resumable or finished job.
 *
 * This is what makes the wait legible. At ~1.5 rows/s a 500-row catalogue is
 * five and a half minutes, and a merchant staring at an opaque spinner cannot
 * tell "working" from "hung" — so the response carries row counts, batch
 * counts, and every failure with its reason rather than a bare status.
 */
import { connect } from "../../../../lib/db/sql.ts";
import { getProgress } from "../../../../lib/ingest/job.ts";
import { errorResponse } from "../../../../lib/feed/http.ts";
import { feedIdFor } from "../../../../lib/ingest/pipeline.ts";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ jobId: string }> },
): Promise<Response> {
  const { jobId } = await context.params;

  if (!/^job_[a-f0-9]{16}$/.test(jobId)) {
    return errorResponse(404, {
      type: "invalid_request",
      code: "job_not_found",
      message: `Job not found: ${jobId}`,
      param: "jobId",
    });
  }

  try {
    const progress = await getProgress(await connect(), jobId);

    return new Response(
      JSON.stringify({
        ...progress,
        // Where the result lands. Present from the start, because an agent or a
        // UI should not have to construct it.
        feed_url: `/api/feeds/${feedIdFor(progress.merchant_id)}/products`,
        // Terminal means "not going to change on its own". A failed job is
        // terminal but retryable — POST the same file to resume it.
        terminal: progress.status === "complete" || progress.status === "failed",
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/no such job/.test(message)) {
      return errorResponse(404, {
        type: "invalid_request",
        code: "job_not_found",
        message: `Job not found: ${jobId}`,
        param: "jobId",
      });
    }
    console.error("[ingest] progress lookup failed:", error);
    return errorResponse(500, {
      type: "server_error",
      code: "progress_unavailable",
      message: "Could not read job progress",
    });
  }
}
