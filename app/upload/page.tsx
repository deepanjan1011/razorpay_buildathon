/**
 * The merchant upload page. PHASE-1.md §7.
 *
 * DELIBERATELY PLAIN. Its job is to get a real spreadsheet through the pipeline
 * and to make a multi-minute wait legible — not to be designed. The merchant
 * dashboard and the review UI are Phase 6; polishing this now would be building
 * ahead of the phase for something nothing downstream depends on.
 *
 * What it must do well is the waiting. At ~1.5 rows/s a real catalogue is
 * minutes (PHASE-1.md §4a), and a merchant staring at a spinner cannot tell
 * "working" from "hung" — so it shows row counts, batch counts, and every
 * failed batch with its reason code rather than a bare status.
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Failure = { batch_index: number; reason_code: string; reason_human: string };

type Progress = {
  id: string;
  status: "pending" | "running" | "complete" | "failed";
  rows_total: number;
  rows_extracted: number;
  batches_total: number;
  batches_done: number;
  batches_failed: number;
  failures: Failure[];
  feed_url?: string;
  terminal?: boolean;
  resumed?: boolean;
};

type AcpError = { code: string; message: string };

const POLL_MS = 2000;

export default function UploadPage() {
  const [merchantId, setMerchantId] = useState("mer_demo");
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const poll = useCallback(async (jobId: string) => {
    try {
      const response = await fetch(`/api/ingest/${jobId}`, { cache: "no-store" });
      const body = (await response.json()) as Progress & AcpError;
      if (!response.ok) {
        setError(`${body.code}: ${body.message}`);
        return;
      }
      setProgress(body);
      // Keep polling until the job stops changing on its own. A failed job is
      // terminal but retryable — re-uploading the same file resumes it.
      if (!body.terminal) timer.current = setTimeout(() => void poll(jobId), POLL_MS);
    } catch (cause) {
      setError(`Lost contact with the server: ${String(cause)}`);
    }
  }, []);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setProgress(null);
    setBusy(true);

    try {
      const response = await fetch("/api/ingest", {
        method: "POST",
        body: new FormData(event.currentTarget),
      });
      const body = (await response.json()) as Progress & AcpError;
      if (!response.ok) {
        setError(`${body.code}: ${body.message}`);
        return;
      }
      setProgress(body);
      void poll(body.id);
    } catch (cause) {
      setError(`Upload failed: ${String(cause)}`);
    } finally {
      setBusy(false);
    }
  }

  const pct =
    progress && progress.rows_total > 0
      ? Math.round((progress.rows_extracted / progress.rows_total) * 100)
      : 0;

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", maxWidth: 640, margin: "3rem auto", padding: "0 1rem" }}>
      <h1 style={{ fontSize: "1.4rem" }}>Upload a catalogue</h1>
      <p style={{ color: "#555", fontSize: ".9rem" }}>
        A spreadsheet of products. Messy is fine — merged cells, notes above the
        header, prices written any way at all.
      </p>

      <form onSubmit={submit} style={{ display: "grid", gap: ".75rem", margin: "1.5rem 0" }}>
        <label style={{ display: "grid", gap: ".25rem", fontSize: ".9rem" }}>
          Merchant id
          <input
            name="merchant_id"
            value={merchantId}
            onChange={(e) => setMerchantId(e.target.value)}
            pattern="[A-Za-z0-9_-]{1,64}"
            required
            style={{ padding: ".4rem", fontFamily: "monospace" }}
          />
        </label>

        <label style={{ display: "grid", gap: ".25rem", fontSize: ".9rem" }}>
          Spreadsheet
          <input name="file" type="file" accept=".xlsx,.xls" required />
        </label>

        <button type="submit" disabled={busy} style={{ padding: ".5rem", cursor: "pointer" }}>
          {busy ? "Uploading…" : "Upload"}
        </button>
      </form>

      {error && (
        <p role="alert" style={{ color: "#b00", fontFamily: "monospace", fontSize: ".85rem" }}>
          {error}
        </p>
      )}

      {progress && (
        <section style={{ borderTop: "1px solid #ddd", paddingTop: "1rem" }}>
          <p style={{ fontFamily: "monospace", fontSize: ".85rem" }}>
            {progress.id} — <strong>{progress.status}</strong>
            {progress.resumed && " (resumed)"}
          </p>

          {/* Row counts, not a spinner. Minutes of silence is the failure mode. */}
          <p style={{ fontSize: ".9rem" }}>
            {progress.rows_extracted} / {progress.rows_total} rows &nbsp;·&nbsp;
            batch {progress.batches_done} / {progress.batches_total}
            {progress.batches_failed > 0 && ` · ${progress.batches_failed} failed`}
          </p>

          <div style={{ background: "#eee", height: 8, borderRadius: 4, overflow: "hidden" }}>
            <div
              style={{
                width: `${pct}%`,
                height: "100%",
                background: progress.batches_failed > 0 ? "#c60" : "#282",
                transition: "width .3s",
              }}
            />
          </div>

          {progress.failures.length > 0 && (
            <div style={{ marginTop: "1rem" }}>
              <h2 style={{ fontSize: "1rem" }}>Batches that failed</h2>
              <p style={{ fontSize: ".85rem", color: "#555" }}>
                These rows were not read. They appear in the catalogue as flagged
                products, never as missing ones. Uploading the same file again
                retries exactly these batches.
              </p>
              <ul style={{ fontSize: ".85rem", fontFamily: "monospace" }}>
                {progress.failures.map((f) => (
                  <li key={f.batch_index}>
                    batch {f.batch_index} — <strong>{f.reason_code}</strong>
                    <br />
                    <span style={{ color: "#666" }}>{f.reason_human}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {progress.status === "complete" && progress.feed_url && (
            <p style={{ marginTop: "1rem" }}>
              <a href={progress.feed_url}>View the agent-readable feed →</a>
            </p>
          )}
        </section>
      )}
    </main>
  );
}
