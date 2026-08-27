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

import Nav from "../nav.tsx";
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
    <main style={{ maxWidth: 680, margin: "3rem auto", padding: "0 1.5rem 4rem" }}>
      <Nav active="upload" />
      <div className="animate-in" style={{ animationDelay: "0.1s", animationFillMode: "both" }}>
        <div className="eyebrow" style={{ marginTop: "24px" }}>
          <span style={{ color: "var(--accent)" }}>——</span> Ingest
        </div>
        <h1 style={{ fontSize: 42, margin: "14px 0 0", letterSpacing: "-0.03em", fontWeight: 800 }}>
          Upload a catalogue
        </h1>
        <p style={{ color: "var(--muted)", fontSize: 16, marginTop: 12, lineHeight: 1.6 }}>
          A spreadsheet of products. Messy is fine — merged cells, notes above the
          header, prices written any way at all.
        </p>

      <form
        onSubmit={submit}
        className="card"
        style={{ display: "grid", gap: "20px", margin: "32px 0", padding: "28px 32px" }}
      >
        <label style={{ display: "grid", gap: "8px", fontSize: 15 }}>
          Merchant id
          <input
            name="merchant_id"
            value={merchantId}
            onChange={(e) => setMerchantId(e.target.value)}
            pattern="[A-Za-z0-9_-]{1,64}"
            required
            style={{ fontFamily: "monospace", fontSize: 14 }}
          />
        </label>

        <label style={{ display: "grid", gap: "8px", fontSize: 15 }}>
          Spreadsheet
          <input name="file" type="file" accept=".xlsx,.xls" required style={{ border: "1px dashed var(--dim)", padding: "12px", background: "var(--neutral-bg)", cursor: "pointer" }} />
        </label>

        <button
          type="submit"
          disabled={busy}
          style={{
            padding: "12px 24px",
            background: "var(--accent)",
            color: "var(--panel)",
            border: "1px solid var(--accent)",
            marginTop: 8,
            justifySelf: "start",
            transition: "all 0.2s ease",
            fontSize: 15,
          }}
        >
          {busy ? "Uploading…" : "Upload"}
        </button>
      </form>

      {error && (
        <p role="alert" style={{ color: "var(--bad)", fontFamily: "monospace", fontSize: ".85rem" }}>
          {error}
        </p>
      )}

      {progress && (
        <section className="animate-in" style={{ borderTop: "1px solid var(--line)", paddingTop: "32px", animationDelay: "0s" }}>
          <p style={{ fontFamily: "monospace", fontSize: 13, background: "var(--neutral-bg)", display: "inline-block", padding: "4px 8px", borderRadius: 6 }}>
            {progress.id} — <strong style={{ color: progress.status === "failed" ? "var(--bad)" : "var(--text)" }}>{progress.status}</strong>
            {progress.resumed && " (resumed)"}
          </p>

          {/* Row counts, not a spinner. Minutes of silence is the failure mode. */}
          <p style={{ fontSize: 15, marginTop: 16 }}>
            <span style={{ fontWeight: 600 }}>{progress.rows_extracted} / {progress.rows_total}</span> rows extracted &nbsp;·&nbsp;
            batch {progress.batches_done} / {progress.batches_total}
            {progress.batches_failed > 0 && <span style={{ color: "var(--bad)", fontWeight: 600 }}>{` · ${progress.batches_failed} failed`}</span>}
          </p>

          <div style={{ background: "var(--neutral-bg)", height: 12, borderRadius: 999, overflow: "hidden", marginTop: 12, boxShadow: "inset 0 1px 2px rgba(0,0,0,0.05)" }}>
            <div
              style={{
                width: `${pct}%`,
                height: "100%",
                background: progress.batches_failed > 0 
                  ? "var(--warn)" 
                  : "linear-gradient(90deg, #24824d, #34b568)",
                transition: "width 0.4s cubic-bezier(0.16, 1, 0.3, 1)",
                borderRadius: 999,
              }}
            />
          </div>

          {progress.failures.length > 0 && (
            <div className="card" style={{ marginTop: "24px", padding: "20px 24px", borderColor: "var(--warn)", background: "var(--warn-bg)" }}>
              <h2 style={{ fontSize: 16, margin: "0 0 8px" }}>Batches that failed</h2>
              <p style={{ fontSize: 14, color: "var(--muted)", margin: "0 0 16px" }}>
                These rows were not read. They appear in the catalogue as flagged
                products, never as missing ones. Uploading the same file again
                retries exactly these batches.
              </p>
              <ul style={{ fontSize: 13, fontFamily: "monospace", margin: 0, paddingLeft: 20 }}>
                {progress.failures.map((f) => (
                  <li key={f.batch_index} style={{ marginBottom: 12 }}>
                    batch {f.batch_index} — <strong>{f.reason_code}</strong>
                    <br />
                    <span style={{ color: "var(--muted)", fontFamily: "sans-serif" }}>{f.reason_human}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {progress.status === "complete" && progress.feed_url && (
            <p style={{ marginTop: "24px" }}>
              <a href={progress.feed_url} style={{ fontWeight: 600 }}>View the agent-readable feed →</a>
            </p>
          )}
        </section>
      )}
      </div>
    </main>
  );
}
