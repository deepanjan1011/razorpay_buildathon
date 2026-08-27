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
import Nav from "../../nav.tsx";
import { connect } from "../../../lib/db/sql.ts";
import { timeline } from "../../../lib/audit/log.ts";
import type { AuditRow } from "../../../lib/audit/log.ts";

export const dynamic = "force-dynamic";

/**
 * A readable instant, in one timezone, stated.
 *
 * The ISO string was correct and unreadable: `2026-08-27T09:27:08.211Z` makes a
 * reader parse a format before they can compare two rows. Seconds are KEPT —
 * this is an ordered log and events land within the same minute — and the zone
 * is pinned to IST and printed, because a timestamp whose zone you have to
 * guess is the same problem in a nicer font. Fixed locale and zone, so the
 * server render and any later read agree.
 */
const WHEN = new Intl.DateTimeFormat("en-IN", {
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: true,
  timeZone: "Asia/Kolkata",
});

const when = (ts: string | Date) => `${WHEN.format(new Date(ts))} IST`;

const money = (minor: unknown) =>
  typeof minor === "number" ? `₹${(minor / 100).toFixed(2)}` : String(minor ?? "—");

const OUTCOME_STYLE: Record<string, { bg: string; fg: string; label: string }> = {
  allowed: { bg: "#e4efe4", fg: "#1b7a4c", label: "ALLOWED" },
  refused: { bg: "#fbe4de", fg: "#b23a1f", label: "REFUSED" },
  error: { bg: "#f7ebd5", fg: "#8a6410", label: "ERROR" },
  // `observed` is not a euphemism for allowed — a late authorisation against a
  // session we refused is recorded as something we saw, not something we
  // permitted, and the colour should not suggest otherwise.
  observed: { bg: "#ede6da", fg: "#e1532a", label: "OBSERVED" },
};

function Peers({ evidence }: { evidence: Record<string, unknown> }) {
  const failed = (evidence["peers_failed"] ?? []) as Array<{ check: string; reason_code: string }>;
  const passed = (evidence["peers_passed"] ?? []) as string[];
  if (failed.length === 0 && passed.length === 0) return null;

  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ fontSize: 11, color: "#6e6559", marginBottom: 6 }}>
        MANDATE CHECKS
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {/* Failed first, because that is what the reader is looking for. */}
        {failed.map((f) => (
          <span
            key={f.check}
            style={{ background: "#fbe4de", color: "#b23a1f", padding: "3px 9px", borderRadius: 4, fontSize: 12 }}
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
            style={{ background: "#eaf2ea", color: "#4a7a5c", padding: "3px 9px", borderRadius: 4, fontSize: 12 }}
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
      <div style={{ fontSize: 11, color: "#6e6559", marginBottom: 6 }}>PRICE DRIFT</div>
      {drift.map((d) => (
        <div key={d.id} style={{ fontSize: 13, color: "#17140f" }}>
          <code style={{ color: "#6e6559" }}>{d.id}</code>{" "}
          the agent read <b style={{ color: "#8a6410" }}>{money(d.quoted_minor)}</b>, it is now{" "}
          <b style={{ color: "#b23a1f" }}>{money(d.live_minor)}</b>
        </div>
      ))}
    </div>
  );
}

function Event({ row }: { row: AuditRow }) {
  const style = OUTCOME_STYLE[row.outcome] ?? OUTCOME_STYLE["observed"]!;
  const evidence = (row.evidence ?? {}) as Record<string, unknown>;

  return (
    <li
      className="card"
      style={{
        listStyle: "none",
        marginBottom: 12,
        // The outcome colour stays a left edge rather than a filled card: a
        // refusal must be findable at a glance without the page turning red.
        borderLeft: `3px solid ${style.fg}`,
        padding: "14px 16px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ background: style.bg, color: style.fg, padding: "2px 8px", borderRadius: 4, fontSize: 11, fontWeight: 600 }}>
          {style.label}
        </span>
        <b style={{ fontSize: 15 }}>{row.action}</b>
        <span style={{ fontSize: 12, color: "#6e6559" }}>by {row.actor}</span>
        {row.session_status_at_event && (
          // The status AS OBSERVED, which is what makes a late authorisation
          // legible: "the session was canceled when this arrived".
          <span style={{ fontSize: 12, color: "#6e6559" }}>
            · session was <code>{row.session_status_at_event}</code>
          </span>
        )}
      </div>

      {row.reason_code && (
        <div style={{ marginTop: 8 }}>
          <code style={{ color: style.fg, fontSize: 13 }}>{row.reason_code}</code>
          {/* SHOWN ONLY WHERE THE TILES DO NOT ALREADY SAY IT. Where both
              numbers render in rupees below, this sentence repeats them in
              paise — the same fact twice, in the harder units. The string is
              still RECORDED on every refusal; invariant 3 is about the log,
              not about rendering it twice. */}
          {!(
            typeof evidence["cart_total_minor"] === "number" &&
            typeof evidence["mandate_ceiling_minor"] === "number"
          ) && (
            <div style={{ fontSize: 14, color: "#17140f", marginTop: 3 }}>{row.reason_human}</div>
          )}

          {/* THE SAME TWO NUMBERS, IN RUPEES. The recorded string keeps minor
              units because that is what invariant 6 says a RECORD holds; a
              reader is not a record. Side by side, ₹148.26 against ₹112.35
              lands in the time it takes to look at it, which 14826 against
              11235 does not — found by looking at this page rather than by
              reading its markup. */}
          {typeof evidence["cart_total_minor"] === "number" &&
            typeof evidence["mandate_ceiling_minor"] === "number" && (
              <div
                style={{
                  display: "flex",
                  gap: 20,
                  marginTop: 14,
                  alignItems: "center",
                  background: "var(--bg)",
                  border: "1px solid var(--line)",
                  borderRadius: 12,
                  padding: "12px 16px",
                }}
              >
                <div>
                  <div className="eyebrow">Cart total</div>
                  <div style={{ fontSize: 30, color: "#b23a1f", fontWeight: 700, letterSpacing: -0.5 }}>
                    {money(evidence["cart_total_minor"])}
                  </div>
                </div>
                <div style={{ fontSize: 20, color: "#988c7c" }}>&gt;</div>
                <div>
                  <div className="eyebrow">Mandate ceiling</div>
                  <div style={{ fontSize: 30, color: "#17140f", fontWeight: 700, letterSpacing: -0.5 }}>
                    {money(evidence["mandate_ceiling_minor"])}
                  </div>
                </div>
              </div>
            )}
        </div>
      )}

      <Drift evidence={evidence} />
      <Peers evidence={evidence} />

      {/* The time reads first and the provenance follows it, quieter. Dropping
          gate_version would be the wrong kind of tidying: rows written before
          and after a change to the check set must stay distinguishable, which
          is the whole reason it is stamped on every row. */}
      <div style={{ marginTop: 10, fontSize: 11, color: "#988c7c" }}>
        {when(row.ts)}
        <span style={{ margin: "0 6px" }}>·</span>
        policy <code>{row.gate_version}</code>
        <span style={{ margin: "0 6px" }}>·</span>seq {row.seq}
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
    <main style={{ background: "#f7f0e4", color: "#17140f", minHeight: "100vh", padding: "32px 24px", fontFamily: "ui-sans-serif, system-ui" }}>
      <Nav active="sessions" />
      <div style={{ maxWidth: 900, margin: "0 auto" }}>
        {/* A real link, so it works on a page opened cold — from the overview
            card, a pasted URL, or a browser with no history to go back to.
            `history.back()` would do nothing in exactly those cases. */}
        <a
          href="/sessions"
          style={{
            display: "inline-block",
            fontSize: 12,
            fontWeight: 600,
            textDecoration: "none",
            color: "var(--muted)",
            marginBottom: 14,
          }}
        >
          ← All sessions
        </a>

        <div className="eyebrow">
          <span style={{ color: "var(--accent)" }}>——</span> Audit trail
        </div>
        {/* THE ID IS THE HEADLINE. "Every decision, in order" was a caption for
            a page whose subject is one specific session — it said the same thing
            on every page, which makes it decoration. The id is what a viewer
            arrived here holding. */}
        <h1
          style={{
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            fontSize: 24,
            margin: "8px 0 6px",
            letterSpacing: -0.4,
            fontWeight: 700,
            wordBreak: "break-all",
          }}
        >
          {sessionId}
        </h1>
        <p style={{ fontSize: 13, color: "#6e6559", margin: "0 0 4px" }}>
          Every decision, in the order it was written. Append-only — including events
          that arrived after the session was already terminal.
        </p>

        {rows.length === 0 ? (
          <p style={{ color: "#6e6559" }}>
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
