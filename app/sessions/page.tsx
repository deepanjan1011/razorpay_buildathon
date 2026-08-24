/**
 * Recent sessions. The way into the timeline that does not involve pasting ids.
 *
 * Deliberately thin: this is navigation, not a second dashboard. Everything
 * worth looking at is one click away, and building a second surface here would
 * be chrome competing with the artifact that actually answers the track bar.
 */
import { connect } from "../../lib/db/sql.ts";

export const dynamic = "force-dynamic";

type Row = {
  id: string;
  status: string;
  updated_at: Date;
  events: number;
  refusals: number;
  last_reason: string | null;
};

const STATUS_COLOUR: Record<string, string> = {
  ready_for_payment: "#8ecbff",
  complete_in_progress: "#ffc178",
  completed: "#7ee2a8",
  canceled: "#8b93a7",
  expired: "#8b93a7",
  not_ready_for_payment: "#ff9db1",
};

export default async function Sessions() {
  const sql = await connect();
  // Joined against the audit log rather than the session row, because "what
  // happened" is the question this page exists to answer — a session with three
  // refusals behind it is more interesting than one that simply completed.
  const { rows } = await sql.query<Row>(
    `select s.id, s.status, s.updated_at,
            count(a.event_id)::int                                        as events,
            count(a.event_id) filter (where a.outcome = 'refused')::int   as refusals,
            (select a2.reason_code from audit_event a2
              where a2.session_id = s.id and a2.reason_code is not null
              order by a2.seq desc limit 1)                               as last_reason
       from checkout_session s
       left join audit_event a on a.session_id = s.id
      group by s.id, s.status, s.updated_at
      order by s.updated_at desc
      limit 40`,
  );

  return (
    <main style={{ background: "#0d0f14", color: "#e6e8ee", minHeight: "100vh", padding: "32px 24px", fontFamily: "ui-sans-serif, system-ui" }}>
      <div style={{ maxWidth: 900, margin: "0 auto" }}>
        <div style={{ fontSize: 12, color: "#8b93a7", letterSpacing: 1 }}>AGENTREADY</div>
        <h1 style={{ fontSize: 22, margin: "6px 0 4px" }}>Checkout sessions</h1>
        <p style={{ fontSize: 13, color: "#8b93a7", marginTop: 0 }}>
          Most recent first. Open one to see every decision it made and why.
        </p>

        {rows.length === 0 ? (
          <p style={{ color: "#8b93a7" }}>
            No sessions yet. Run <code>npm run demo</code>.
          </p>
        ) : (
          <div style={{ marginTop: 20 }}>
            {rows.map((r) => (
              <a
                key={r.id}
                href={`/sessions/${r.id}`}
                style={{
                  display: "flex", gap: 16, alignItems: "center", padding: "10px 12px",
                  borderBottom: "1px solid #1b1f2a", textDecoration: "none", color: "inherit",
                }}
              >
                <code style={{ fontSize: 13, color: "#e6e8ee", flex: "0 0 250px" }}>{r.id}</code>
                <span style={{ fontSize: 12, color: STATUS_COLOUR[r.status] ?? "#8b93a7", flex: "0 0 170px" }}>
                  {r.status}
                </span>
                {/* The refusal count first, because a session that was refused
                    is the one a reader came here to find. */}
                <span style={{ fontSize: 12, color: r.refusals > 0 ? "#ff9db1" : "#5c6478", flex: "0 0 100px" }}>
                  {r.refusals > 0 ? `${r.refusals} refused` : "—"}
                </span>
                <code style={{ fontSize: 11, color: "#8b93a7", flex: 1 }}>{r.last_reason ?? ""}</code>
                <span style={{ fontSize: 11, color: "#5c6478" }}>{r.events} events</span>
              </a>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
