/**
 * One session's audit timeline. Phase 6.
 *
 * THIS IS THE ARTIFACT THE TRACK BAR ASKS FOR. "Every money action explainable,
 * bounded and gated. Show the audit trail." Everything rendered here was
 * already in the database before this page existed — the page adds no facts, it
 * only stops them being invisible.
 *
 * BUILT AFTER WATCHING THE DEMO, not before. The frame that matters is the
 * refusal: both numbers side by side, the checks that PASSED beside the one
 * that failed, the drift that caused it, and what was offered instead. Guessing
 * at that before seeing it run would have produced a page that renders rows.
 */
import { connect } from "../../../lib/db/sql.ts";
import { timeline } from "../../../lib/audit/log.ts";
import type { AuditRow } from "../../../lib/audit/log.ts";

export const dynamic = "force-dynamic";

const money = (minor: unknown) =>
  typeof minor === "number" ? `₹${(minor / 100).toFixed(2)}` : String(minor ?? "—");

const OUTCOME_STYLE: Record<string, { bg: string; fg: string; label: string }> = {
  allowed: { bg: "#0b3d1e", fg: "#7ee2a8", label: "ALLOWED" },
  refused: { bg: "#4a1220", fg: "#ff9db1", label: "REFUSED" },
  error: { bg: "#4a2a0b", fg: "#ffc178", label: "ERROR" },
  // `observed` is not a euphemism for allowed — a late authorisation against a
  // session we refused is recorded as something we saw, not something we
  // permitted, and the colour should not suggest otherwise.
  observed: { bg: "#12304a", fg: "#8ecbff", label: "OBSERVED" },
};

function Peers({ evidence }: { evidence: Record<string, unknown> }) {
  const failed = (evidence["peers_failed"] ?? []) as Array<{ check: string; reason_code: string }>;
  const passed = (evidence["peers_passed"] ?? []) as string[];
  if (failed.length === 0 && passed.length === 0) return null;

  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ fontSize: 11, color: "#8b93a7", marginBottom: 6 }}>
        MANDATE CHECKS
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {/* Failed first, because that is what the reader is looking for. */}
        {failed.map((f) => (
          <span
            key={f.check}
            style={{ background: "#4a1220", color: "#ff9db1", padding: "3px 9px", borderRadius: 4, fontSize: 12 }}
          >
            ✕ {f.check}
          </span>
        ))}
        {/* AND THE PASSED SET, which is the half most audit views omit. In a
            dispute "the category and the item count were within bounds" is a
            statement; silence is not. */}
        {passed.map((p) => (
          <span
            key={p}
            style={{ background: "#16261c", color: "#6f8f7c", padding: "3px 9px", borderRadius: 4, fontSize: 12 }}
          >
            ✓ {p}
          </span>
        ))}
      </div>
    </div>
  );
}

function Drift({ evidence }: { evidence: Record<string, unknown> }) {
  const drift = (evidence["drift"] ?? []) as Array<{ id: string; quoted_minor: number; live_minor: number }>;
  if (drift.length === 0) return null;

  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ fontSize: 11, color: "#8b93a7", marginBottom: 6 }}>PRICE DRIFT</div>
      {drift.map((d) => (
        <div key={d.id} style={{ fontSize: 13, color: "#e6e8ee" }}>
          <code style={{ color: "#8b93a7" }}>{d.id}</code>{" "}
          the agent read <b style={{ color: "#ffc178" }}>{money(d.quoted_minor)}</b>, it is now{" "}
          <b style={{ color: "#ff9db1" }}>{money(d.live_minor)}</b>
        </div>
      ))}
    </div>
  );
}

function Event({ row }: { row: AuditRow }) {
  const style = OUTCOME_STYLE[row.outcome] ?? OUTCOME_STYLE["observed"]!;
  const evidence = (row.evidence ?? {}) as Record<string, unknown>;

  return (
    <li style={{ listStyle: "none", marginBottom: 14, borderLeft: `3px solid ${style.fg}`, paddingLeft: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ background: style.bg, color: style.fg, padding: "2px 8px", borderRadius: 4, fontSize: 11, fontWeight: 600 }}>
          {style.label}
        </span>
        <b style={{ fontSize: 15 }}>{row.action}</b>
        <span style={{ fontSize: 12, color: "#8b93a7" }}>by {row.actor}</span>
        {row.session_status_at_event && (
          // The status AS OBSERVED, which is what makes a late authorisation
          // legible: "the session was canceled when this arrived".
          <span style={{ fontSize: 12, color: "#8b93a7" }}>
            · session was <code>{row.session_status_at_event}</code>
          </span>
        )}
      </div>

      {row.reason_code && (
        <div style={{ marginTop: 8 }}>
          <code style={{ color: style.fg, fontSize: 13 }}>{row.reason_code}</code>
          <div style={{ fontSize: 14, color: "#e6e8ee", marginTop: 3 }}>{row.reason_human}</div>

          {/* THE SAME TWO NUMBERS, IN RUPEES. The recorded string keeps minor
              units because that is what invariant 6 says a RECORD holds; a
              reader is not a record. Side by side, ₹148.26 against ₹112.35
              lands in the time it takes to look at it, which 14826 against
              11235 does not — found by looking at this page rather than by
              reading its markup. */}
          {typeof evidence["cart_total_minor"] === "number" &&
            typeof evidence["mandate_ceiling_minor"] === "number" && (
              <div style={{ display: "flex", gap: 28, marginTop: 12, alignItems: "baseline" }}>
                <div>
                  <div style={{ fontSize: 11, color: "#8b93a7" }}>CART TOTAL</div>
                  <div style={{ fontSize: 26, color: "#ff9db1", fontWeight: 600 }}>
                    {money(evidence["cart_total_minor"])}
                  </div>
                </div>
                <div style={{ fontSize: 20, color: "#5c6478" }}>&gt;</div>
                <div>
                  <div style={{ fontSize: 11, color: "#8b93a7" }}>MANDATE CEILING</div>
                  <div style={{ fontSize: 26, color: "#e6e8ee", fontWeight: 600 }}>
                    {money(evidence["mandate_ceiling_minor"])}
                  </div>
                </div>
              </div>
            )}
        </div>
      )}

      <Drift evidence={evidence} />
      <Peers evidence={evidence} />

      <div style={{ marginTop: 8, fontSize: 11, color: "#5c6478" }}>
        {new Date(row.ts).toISOString()} · policy <code>{row.gate_version}</code> · seq {row.seq}
      </div>
    </li>
  );
}

export default async function SessionTimeline({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = await params;
  const sql = await connect();
  const rows = await timeline(sql, sessionId);

  return (
    <main style={{ background: "#0d0f14", color: "#e6e8ee", minHeight: "100vh", padding: "32px 24px", fontFamily: "ui-sans-serif, system-ui" }}>
      <div style={{ maxWidth: 760, margin: "0 auto" }}>
        <div style={{ fontSize: 12, color: "#8b93a7", letterSpacing: 1 }}>AUDIT TRAIL</div>
        <h1 style={{ fontSize: 20, margin: "6px 0 4px", fontFamily: "ui-monospace, monospace" }}>{sessionId}</h1>
        <p style={{ fontSize: 13, color: "#8b93a7", marginTop: 0 }}>
          Every decision this session made, in the order it was written. Append-only:
          nothing here is edited or removed, including events that arrived after the
          session was already terminal.
        </p>

        {rows.length === 0 ? (
          <p style={{ color: "#8b93a7" }}>
            No events for this session. Either it does not exist, or it belongs to another
            merchant — this page does not distinguish, for the same reason the API answers
            404 rather than 403.
          </p>
        ) : (
          <ul style={{ padding: 0, marginTop: 24 }}>
            {rows.map((row) => (
              <Event key={row.event_id} row={row} />
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
