/**
 * Recent sessions. The way into the timeline that does not involve pasting ids.
 *
 * Deliberately thin: this is navigation, not a second dashboard. Everything
 * worth looking at is one click away, and building a second surface here would
 * be chrome competing with the artifact that actually answers the track bar.
 */
import { TransitionLink } from "./navigation.tsx";
import { connect } from "../../lib/db/sql.ts";

export const dynamic = "force-dynamic";

type Row = {
  id: string;
  status: string;
  updated_at: Date;
  events: number;
  refusals: number;
  last_reason: string | null;
  /** First line item's name, from the priced snapshot. Null on an empty cart. */
  item: string | null;
  item_count: number | null;
};

/**
 * THE ID LEADS. It is what the demo transcript prints, what the server log
 * carries, and what a viewer types to open one — so it is the column someone
 * actually matches a row against. A relative timestamp read better in
 * isolation and was worse at the only job this table has.
 */

type StatusStyle = { color: string; bg: string };

/**
 * The fallback is a VALUE, not another lookup. `STATUS_STYLES[x] ?? STATUS_STYLES.y`
 * reads as a default and is not one: under `noUncheckedIndexedAccess` the second
 * lookup is `| undefined` too, so the expression never actually guarantees a
 * style — and a status this map has not met yet is exactly when it is needed.
 */
const STATUS_DEFAULT: StatusStyle = { color: "var(--muted)", bg: "var(--neutral-bg)" };

const STATUS_STYLES: Record<string, StatusStyle> = {
  // NOT the accent. A cart priced and waiting is the ordinary case, and
  // painting it the same colour as a refusal makes the page read as a wall of
  // alarms — which is the opposite of what a reader scans this list for.
  ready_for_payment: { color: "var(--muted)", bg: "var(--neutral-bg)" },
  complete_in_progress: { color: "var(--warn)", bg: "var(--warn-bg)" },
  completed: { color: "var(--good)", bg: "var(--good-bg)" },
  canceled: { color: "var(--muted)", bg: "var(--neutral-bg)" },
  expired: { color: "var(--muted)", bg: "var(--neutral-bg)" },
  not_ready_for_payment: { color: "var(--bad)", bg: "var(--bad-bg)" },
};

/**
 * Filters as LINKS and "show more" as a bigger limit in the URL — no client
 * component, no state, no bundle. A filtered view is a different page, and the
 * platform already has an address for that. It also means a viewer can send
 * someone "the refusals" rather than "open this and click the second tab".
 *
 * The filter is never interpolated into SQL: the query fragment is chosen from
 * a fixed map, so an unknown value degrades to `all` rather than reaching the
 * database. `limit` is clamped for the same reason.
 */
const FILTERS = {
  all: { label: "All", having: "" },
  refused: { label: "Refused", having: "having count(a.event_id) filter (where a.outcome = 'refused') > 0" },
  today: { label: "Today", having: "having max(s.updated_at) >= date_trunc('day', now())" },
} as const;

type FilterKey = keyof typeof FILTERS;

/**
 * Same treatment as the session page: fixed locale, zone pinned to IST, so the
 * server render is deterministic. Seconds are dropped here — a list is scanned
 * for "which run was this", and the ordered log on the session page is where
 * within-the-minute ordering actually matters.
 */
const WHEN = new Intl.DateTimeFormat("en-IN", {
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hour12: true,
  timeZone: "Asia/Kolkata",
});

const PAGE = 15;

const isFilter = (v: unknown): v is FilterKey =>
  typeof v === "string" && Object.hasOwn(FILTERS, v);

export default async function Sessions({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string; limit?: string }>;
}) {
  const params = await searchParams;
  const filter: FilterKey = isFilter(params.filter) ? params.filter : "all";
  const raw = Number(params.limit);
  // Clamped, not trusted. A limit from a URL is user input on a table scan.
  const limit = Number.isFinite(raw) ? Math.min(Math.max(Math.trunc(raw), PAGE), 200) : PAGE;

  const sql = await connect();
  // Joined against the audit log rather than the session row, because "what
  // happened" is the question this page exists to answer — a session with three
  // refusals behind it is more interesting than one that simply completed.
  const { rows } = await sql.query<Row>(
    `select s.id, s.status, s.updated_at,
            s.snapshot->'line_items'->0->>'name'                           as item,
            jsonb_array_length(s.snapshot->'line_items')                   as item_count,
            count(a.event_id)::int                                        as events,
            count(a.event_id) filter (where a.outcome = 'refused')::int   as refusals,
            (select a2.reason_code from audit_event a2
              where a2.session_id = s.id and a2.reason_code is not null
              order by a2.seq desc limit 1)                               as last_reason
       from checkout_session s
       left join audit_event a on a.session_id = s.id
      group by s.id, s.status, s.updated_at, s.snapshot
      ${FILTERS[filter].having}
      order by s.updated_at desc
      limit $1`,
    // One more than asked for, purely to answer "is there a next page" without
    // a second count query over the same join.
    [limit + 1],
  );

  const hasMore = rows.length > limit;
  const visible = hasMore ? rows.slice(0, limit) : rows;
  const href = (f: FilterKey, l: number) => `/sessions?filter=${f}${l > PAGE ? `&limit=${l}` : ""}`;

  return (
    <main style={{ padding: "8px 24px 64px" }}>
      <div className="animate-in" style={{ maxWidth: 1040, margin: "0 auto", animationDelay: "0.1s", animationFillMode: "both" }}>
        <div className="eyebrow" style={{ marginTop: "24px" }}>
          <span style={{ color: "var(--accent)" }}>——</span> Sessions
        </div>
        <h1 style={{ fontSize: 42, margin: "14px 0 0", letterSpacing: "-0.03em", fontWeight: 800 }}>
          Every checkout, and why.
        </h1>
        <p style={{ fontSize: 16, color: "var(--muted)", marginTop: 12 }}>
          Most recent first. Open one to see every decision it made and why.
        </p>

        <div style={{ display: "flex", gap: 6, marginTop: 16 }}>
          {(Object.keys(FILTERS) as FilterKey[]).map((key) => {
            const on = key === filter;
            return (
              <TransitionLink
                key={key}
                href={href(key, PAGE)}
                className="pill"
                data-active={on}
              >
                {FILTERS[key].label}
              </TransitionLink>
            );
          })}
        </div>

        {visible.length === 0 ? (
          <p style={{ color: "#6e6559", marginTop: 20 }}>
            {filter === "all" ? (
              <>
                No sessions yet. Run <code>npm run demo</code>.
              </>
            ) : (
              <>
                Nothing matches this filter. <TransitionLink href={href("all", PAGE)}>Show all sessions →</TransitionLink>
              </>
            )}
          </p>
        ) : (
          <div className="card" style={{ marginTop: 20, padding: "4px 8px" }}>
            <div
              className="eyebrow"
              style={{ display: "flex", gap: 16, padding: "16px 20px 12px", borderBottom: "1px solid var(--line)" }}
            >
              <span style={{ flex: "0 1 250px" }}>Cart</span>
              <span style={{ flex: "0 0 170px" }}>Status</span>
              <span style={{ flex: 1 }}>Outcome</span>
              <span style={{ flex: "0 0 62px", textAlign: "right" }}>Events</span>
              <span style={{ flex: "0 0 108px", textAlign: "right" }}>When</span>
            </div>
            {visible.map((r) => {
              const statusStyle = STATUS_STYLES[r.status] ?? STATUS_DEFAULT;
              return (
              <TransitionLink
                key={r.id}
                href={`/sessions/${r.id}`}
                style={{
                  display: "flex", gap: 16, alignItems: "center", padding: "16px 20px",
                  borderBottom: "1px solid var(--line)", textDecoration: "none", color: "inherit",
                }}
              >
                {/* WHAT WAS IN THE CART LEADS. A 26-character opaque id told a
                    reader nothing and told every row the same nothing — forty
                    of them differ only in hash. The product and the total
                    distinguish rows at a glance; the id stays underneath,
                    because it is what the demo transcript and the server log
                    print and the only thing anyone actually matches on. */}
                <span style={{ flex: "0 1 250px", minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {r.item ?? "empty cart"}
                    {r.item_count && r.item_count > 1 ? (
                      <span style={{ color: "var(--muted)", fontWeight: 500 }}> +{r.item_count - 1}</span>
                    ) : null}
                    {/* NO TOTAL HERE, deliberately. The snapshot's total is the
                        CURRENT price, and a refused row is refused precisely
                        because the price moved — so the list would print
                        "Mini Murukku ₹112.35 — refused, ceiling ₹112.35" and
                        invite the exact wrong conclusion. The total that
                        explains a refusal is the one recorded at refusal time,
                        and it is on the session page where its ceiling is
                        beside it. */}
                  </div>
                  <code style={{ fontSize: 11, color: "var(--dim)" }}>{r.id}</code>
                </span>
                {/* A chip, not coloured text: status is a category, and a bare
                    coral word reads as an alarm on a row that is merely waiting. */}
                <span style={{ flex: "0 0 170px" }}>
                  <span
                    style={{
                      fontSize: 12,
                      fontWeight: 600,
                      color: statusStyle.color,
                      background: statusStyle.bg,
                      padding: "4px 10px",
                      borderRadius: 999,
                    }}
                  >
                    {r.status}
                  </span>
                </span>
                {/* COUNT AND REASON IN ONE COLUMN. They were two, and they were
                    redundant: a reason code exists only where something was
                    refused, so the pair was always either "— / blank" or
                    "n refused / CODE". Merging them gives the reason — the only
                    part that says anything — the width it was being denied.
                    min-width:0 or the flex item refuses to shrink below its
                    content and pushes the events column off the card. */}
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    overflow: "hidden",
                  }}
                >
                  {r.refusals > 0 ? (
                    <>
                      <span style={{ fontSize: 13, color: "var(--bad)", whiteSpace: "nowrap", fontWeight: 600 }}>
                        {r.refusals} refused
                      </span>
                      <code
                        style={{
                          fontSize: 12,
                          color: "var(--muted)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {r.last_reason ?? ""}
                      </code>
                    </>
                  ) : (
                    <span style={{ fontSize: 14, color: "var(--dim)" }}>—</span>
                  )}
                </span>
                <span style={{ fontSize: 13, color: "var(--muted)", flex: "0 0 62px", whiteSpace: "nowrap", textAlign: "right" }}>
                  {r.events} events
                </span>
                <span
                  style={{
                    fontSize: 11,
                    color: "var(--muted)",
                    flex: "0 0 108px",
                    whiteSpace: "nowrap",
                    textAlign: "right",
                  }}
                >
                  {WHEN.format(new Date(r.updated_at))}
                </span>
              </TransitionLink>
            );})}
          </div>
        )}

        {/* LINKS, not buttons. They survive a reload, they can be sent to
            someone, and they need no JavaScript — the row count lives in the
            URL where the filter already does.

            Collapse appears as soon as the list has been expanded, including
            while more rows remain: someone forty rows deep should not have to
            reach the end before they can get back to a readable page. */}
        {(hasMore || limit > PAGE) && (
          <div
            style={{
              marginTop: 16,
              display: "flex",
              gap: 10,
              justifyContent: "center",
              alignItems: "center",
              flexWrap: "wrap",
            }}
          >
            {hasMore && (
              <TransitionLink
                href={href(filter, limit + 25)}
                pendingText="Loading..."
                className="pill"
                style={{ padding: "9px 20px" }}
              >
                Show 25 more
              </TransitionLink>
            )}
            {limit > PAGE && (
              <TransitionLink
                href={href(filter, PAGE)}
                pendingText="Collapsing..."
                className="pill"
                style={{ background: "transparent", borderStyle: "dashed" }}
              >
                ↑ Collapse
              </TransitionLink>
            )}
          </div>
        )}

        {!hasMore && (
          <p style={{ textAlign: "center", fontSize: 12, color: "var(--dim)", marginTop: 12 }}>
            That is all {visible.length}.
          </p>
        )}
      </div>
    </main>
  );
}
