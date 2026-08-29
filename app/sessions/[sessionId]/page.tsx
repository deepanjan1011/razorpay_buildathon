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
  allowed: { bg: "var(--good)", fg: "var(--panel)", label: "ALLOWED" },
  refused: { bg: "var(--bad)", fg: "var(--panel)", label: "REFUSED" },
  error: { bg: "var(--warn)", fg: "var(--panel)", label: "ERROR" },
  observed: { bg: "var(--dim)", fg: "var(--panel)", label: "OBSERVED" },
};

function Peers({ evidence }: { evidence: Record<string, unknown> }) {
  const failed = (evidence["peers_failed"] ?? []) as Array<{ check: string; reason_code: string }>;
  const passed = (evidence["peers_passed"] ?? []) as string[];
  if (failed.length === 0 && passed.length === 0) return null;

  return (
    <div style={{ marginTop: 16 }}>
      <div className="eyebrow" style={{ marginBottom: 10, fontSize: 12, fontWeight: 700, letterSpacing: "0.05em" }}>
        MANDATE CHECKS
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
        {/* Failed first, because that is what the reader is looking for. */}
        {failed.map((f) => (
          <span
            key={f.check}
            style={{ background: "var(--bad-bg)", color: "var(--bad)", padding: "6px 12px", borderRadius: 8, fontSize: 14, fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}
          >
            <span style={{ fontSize: 16 }}>✕</span> {f.check}
          </span>
        ))}
        {/* AND THE PASSED SET, which is the half most audit views omit. In a
            dispute "the category and the item count were within bounds" is a
            statement; silence is not. */}
        {passed.map((p) => (
          <span
            key={p}
            style={{ background: "var(--good-bg)", color: "var(--good)", padding: "6px 12px", borderRadius: 8, fontSize: 14, fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}
          >
            <span style={{ fontSize: 16 }}>✓</span> {p}
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * What the gate offered instead.
 *
 * The refusal was legible before this and the recovery was not: a dead end and
 * a redirect looked identical on the page, because the log recorded only the
 * refusal. Rendered only when something was offered — an absent list on an
 * expired mandate is correct and has nothing to say.
 */
function Alternatives({ evidence }: { evidence: Record<string, unknown> }) {
  const offered = (evidence["alternatives_offered"] ?? []) as Array<{
    id: string;
    title: string;
    price_minor: number;
  }>;
  if (offered.length === 0) return null;

  return (
    <div style={{ marginTop: 16 }}>
      <div className="eyebrow" style={{ marginBottom: 8 }}>
        Offered instead — within the mandate
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {offered.map((a) => (
          <span
            key={a.id}
            style={{
              display: "inline-flex",
              alignItems: "baseline",
              gap: 8,
              background: "var(--good-bg)",
              color: "var(--good)",
              border: "1px solid var(--line)",
              padding: "6px 12px",
              borderRadius: 8,
              fontSize: 13,
              fontWeight: 600,
            }}
          >
            {a.title}
            <b style={{ fontWeight: 700 }}>{money(a.price_minor)}</b>
          </span>
        ))}
      </div>
    </div>
  );
}

function Drift({ evidence }: { evidence: Record<string, unknown> }) {
  const drift = (evidence["drift"] ?? []) as Array<{
    id: string;
    /** Absent on rows written before the title was recorded. */
    title?: string;
    quoted_minor: number;
    live_minor: number;
  }>;
  if (drift.length === 0) return null;

  return (
    <div style={{ marginTop: 12 }}>
      <div className="eyebrow" style={{ marginBottom: 8 }}>PRICE DRIFT</div>
      {drift.map((d) => (
        <div key={d.id} style={{ fontSize: 14, color: "var(--text)", background: "var(--panel)", padding: "8px 12px", border: "1px solid var(--line)", borderRadius: 8, display: "inline-block" }}>
          {/* The name if the row carries one, the id if it does not. Older
              rows predate the title being recorded, and showing a stale id is
              honest where inventing a name would not be. */}
          {d.title ? (
            <b style={{ fontWeight: 700 }}>{d.title}</b>
          ) : (
            <code style={{ color: "var(--muted)", fontWeight: 600 }}>{d.id}</code>
          )}{" "}
          — the agent read <b style={{ color: "var(--warn)" }}>{money(d.quoted_minor)}</b>, it is now{" "}
          <b style={{ color: "var(--bad)" }}>{money(d.live_minor)}</b>
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
      style={{
        listStyle: "none",
        marginBottom: 32,
        position: "relative",
        paddingLeft: 40,
        zIndex: 1,
      }}
    >
      <div 
        style={{ 
          position: "absolute", 
          left: 3, 
          top: 26, 
          width: 14, 
          height: 14, 
          borderRadius: 999, 
          background: style.bg, 
          border: `3px solid var(--bg)`, 
          zIndex: 2, 
          boxShadow: `0 0 0 4px ${style.bg}20` 
        }} 
      />
      <div className="card" style={{ padding: "24px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap", borderBottom: "1px solid var(--line)", paddingBottom: 16, marginBottom: 16 }}>
        <span style={{ background: style.bg, color: style.fg, padding: "6px 14px", borderRadius: 999, fontSize: 13, fontWeight: 800, letterSpacing: "0.05em", textTransform: "uppercase" }}>
          {style.label}
        </span>
        <b style={{ fontSize: 20, fontWeight: 800, letterSpacing: "-0.02em" }}>{row.action}</b>
        
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginLeft: "auto" }}>
          <span style={{ fontSize: 14, color: "var(--muted)", fontWeight: 500 }}>by <span style={{ color: "var(--text)", fontWeight: 700 }}>{row.actor}</span></span>
          {row.session_status_at_event && (
            <span style={{ fontSize: 14, color: "var(--muted)", display: "flex", alignItems: "center", gap: 6 }}>
              · <span style={{ background: "var(--neutral-bg)", color: "var(--text)", padding: "4px 8px", borderRadius: 6, fontWeight: 600 }}>{row.session_status_at_event}</span>
            </span>
          )}
        </div>
      </div>

      {row.reason_code && (
        <div style={{ marginTop: 16 }}>
          <code style={{ color: style.fg, fontSize: 15, background: style.bg, padding: "6px 10px", borderRadius: 6, fontWeight: 700 }}>{row.reason_code}</code>
          {/* SHOWN ONLY WHERE THE TILES DO NOT ALREADY SAY IT. Where both
              numbers render in rupees below, this sentence repeats them in
              paise — the same fact twice, in the harder units. The string is
              still RECORDED on every refusal; invariant 3 is about the log,
              not about rendering it twice. */}
          {!(
            typeof evidence["cart_total_minor"] === "number" &&
            typeof evidence["mandate_ceiling_minor"] === "number"
          ) && (
            <div style={{ fontSize: 15, color: "var(--text)", marginTop: 8 }}>{row.reason_human}</div>
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
                  gap: 24,
                  marginTop: 16,
                  alignItems: "center",
                  background: "var(--panel)",
                  border: "1px solid var(--line)",
                  borderRadius: 16,
                  padding: "16px 20px",
                }}
              >
                <div>
                  <div className="eyebrow" style={{ color: "var(--muted)" }}>Cart total</div>
                  <div style={{ fontSize: 34, color: "var(--bad)", fontWeight: 800, letterSpacing: "-0.03em", marginTop: 4 }}>
                    {money(evidence["cart_total_minor"])}
                  </div>
                </div>
                <div style={{ fontSize: 24, color: "var(--dim)", fontWeight: 300 }}>&gt;</div>
                <div>
                  <div className="eyebrow" style={{ color: "var(--muted)" }}>Mandate ceiling</div>
                  <div style={{ fontSize: 34, color: "var(--text)", fontWeight: 800, letterSpacing: "-0.03em", marginTop: 4 }}>
                    {money(evidence["mandate_ceiling_minor"])}
                  </div>
                </div>
              </div>
            )}
        </div>
      )}

      <Drift evidence={evidence} />
      <Peers evidence={evidence} />
      <Alternatives evidence={evidence} />

      {/* The time reads first and the provenance follows it, quieter. Dropping
          gate_version would be the wrong kind of tidying: rows written before
          and after a change to the check set must stay distinguishable, which
          is the whole reason it is stamped on every row. */}
      <div style={{ marginTop: 24, fontSize: 13, color: "var(--muted)", fontWeight: 600, display: "flex", alignItems: "center", gap: 12, background: "var(--neutral-bg)", padding: "10px 14px", borderRadius: 8 }}>
        <span style={{ color: "var(--text)" }}>{when(row.ts)}</span>
        <span style={{ color: "var(--dim)" }}>|</span>
        <span>policy <code style={{ color: "var(--text)", fontWeight: 700 }}>{row.gate_version}</code></span>
        <span style={{ color: "var(--dim)" }}>|</span>
        <span>seq <span style={{ color: "var(--text)", fontWeight: 700 }}>{row.seq}</span></span>
      </div>
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
    <main style={{ padding: "8px 24px 64px" }}>
      <div className="animate-in" style={{ maxWidth: 900, margin: "0 auto", animationDelay: "0.1s", animationFillMode: "both" }}>
        {/* A real link, so it works on a page opened cold — from the overview
            card, a pasted URL, or a browser with no history to go back to.
            `history.back()` would do nothing in exactly those cases. */}
        <div style={{ marginBottom: 24, marginTop: 16 }}>
          <a
            href="/sessions"
            className="card"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              fontSize: 14,
              fontWeight: 600,
              textDecoration: "none",
              color: "var(--text)",
              padding: "8px 16px",
              borderRadius: 999,
            }}
          >
            ← All sessions
          </a>
        </div>

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
            fontSize: 28,
            margin: "12px 0 8px",
            letterSpacing: -0.5,
            fontWeight: 800,
            wordBreak: "break-all",
          }}
        >
          {sessionId}
        </h1>
        <p style={{ fontSize: 16, color: "var(--muted)", margin: "0 0 8px", lineHeight: 1.6 }}>
          Every decision, in the order it was written. Append-only — including events
          that arrived after the session was already terminal.
        </p>

        {rows.length === 0 ? (
          <p style={{ color: "var(--muted)", fontSize: 15, marginTop: 24 }}>
            No events for this session. Either it does not exist, or it belongs to another
            merchant — this page does not distinguish, for the same reason the API answers
            404 rather than 403.
          </p>
        ) : (
          <ul style={{ padding: 0, marginTop: 40, position: "relative" }}>
            <div style={{ position: "absolute", top: 24, bottom: 0, left: 9, width: 2, background: "var(--line)", zIndex: 0 }} />
            {rows.map((row) => (
              <Event key={row.event_id} row={row} />
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
