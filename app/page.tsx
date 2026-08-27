/**
 * The front door. It was a 404.
 *
 * Not a landing page in the marketing sense — nothing here is judged, and time
 * spent on a hero section is time not spent making the refusal frame land. What
 * it has to do is orient someone in about five seconds and point at the two
 * surfaces that are real: a merchant uploading a spreadsheet, and the audit
 * trail behind a purchase.
 */
import Nav from "./nav.tsx";
import { connect } from "../lib/db/sql.ts";

export const dynamic = "force-dynamic";

async function counts() {
  // Live numbers rather than claims. "63 products" that is actually a query is
  // worth more than a paragraph asserting the pipeline works, and it goes stale
  // the moment it stops being true.
  try {
    const sql = await connect();
    const { rows } = await sql.query<{ variants: number; sessions: number; refusals: number }>(
      `select
         (select count(*) from catalog_variant)                                  as variants,
         (select count(*) from checkout_session)                                 as sessions,
         (select count(*) from audit_event where outcome = 'refused')            as refusals`,
    );
    return rows[0] ?? null;
  } catch {
    // A database that is down must not take the front page with it.
    return null;
  }
}

/**
 * THE MOST RECENT REAL REFUSAL, on the front page.
 *
 * Written after watching someone land on /sessions cold: it is forty opaque
 * ids, and the one row that carries the entire argument looks exactly like the
 * thirty-nine that do not. A visitor with no guide clicks something at random,
 * gets a three-event allowed session, and leaves — having seen a list, not a
 * product. So the refusal comes to them, with both numbers and a way in.
 *
 * Live, not a screenshot: if the gate ever stops refusing, this card empties
 * and the claim disappears with it, which is the correct failure mode.
 */
async function latestRefusal() {
  try {
    const sql = await connect();
    const { rows } = await sql.query<{
      session_id: string;
      reason_code: string;
      cart: number | null;
      ceiling: number | null;
    }>(
      `select session_id,
              reason_code,
              (evidence->>'cart_total_minor')::bigint      as cart,
              (evidence->>'mandate_ceiling_minor')::bigint as ceiling
         from audit_event
        where outcome = 'refused'
          and evidence ? 'cart_total_minor'
          and evidence ? 'mandate_ceiling_minor'
        order by seq desc
        limit 1`,
    );
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

const rupees = (minor: number | null) =>
  minor === null ? "—" : `₹${(Number(minor) / 100).toFixed(2)}`;

const Card = ({ href, title, body }: { href: string; title: string; body: string }) => (
  <a
    href={href}
    className="card"
    style={{
      display: "block", padding: "24px 22px", textDecoration: "none", color: "inherit", flex: "1 1 260px",
    }}
  >
    <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 8, color: "var(--text)" }}>{title}</div>
    <div style={{ fontSize: 14, color: "var(--muted)", lineHeight: 1.6 }}>{body}</div>
  </a>
);

export default async function Home() {
  const [c, refusal] = await Promise.all([counts(), latestRefusal()]);

  return (
    <main style={{ padding: "32px 24px 64px" }}>
      <Nav active="overview" />
      <div className="animate-in" style={{ maxWidth: 1040, margin: "0 auto", animationDelay: "0.1s", animationFillMode: "both" }}>
        <div className="eyebrow" style={{ marginTop: "40px" }}>
          <span style={{ color: "var(--accent)" }}>——</span> Overview
        </div>
        <h1 style={{ fontSize: 48, margin: "14px 0 0", lineHeight: 1.1, letterSpacing: "-0.03em", fontWeight: 800 }}>
          A spreadsheet merchant,
          <br />
          transactable by <span style={{ color: "var(--accent)" }}>AI buyers</span>.
        </h1>
        <p style={{ fontSize: 18, color: "var(--muted)", lineHeight: 1.6, maxWidth: 660, marginTop: 20 }}>
          Their catalogue is a spreadsheet. Their storefront is Instagram. Their payments are
          a Razorpay link. This turns that into an ACP product feed, an agent-facing checkout,
          and a signed mandate that decides whether a charge may happen at all — with an audit
          trail behind every decision.
        </p>

        {c && (
          <div style={{ display: "flex", gap: 16, margin: "48px 0 32px", flexWrap: "wrap" }}>
            {[
              [c.variants, "products live", "from one spreadsheet"],
              [c.sessions, "checkout sessions", "priced authoritatively"],
              [c.refusals, "refusals recorded", "each with a reason code"],
            ].map(([n, label, sub]) => (
              <div
                key={String(label)}
                className="card"
                style={{ padding: "24px", flex: "1 1 180px", background: "var(--panel)" }}
              >
                <div className="eyebrow">{String(label)}</div>
                <div style={{ fontSize: 40, fontWeight: 800, letterSpacing: "-0.03em", margin: "12px 0 4px", color: "var(--text)" }}>
                  {String(n)}
                </div>
                <div style={{ fontSize: 14, color: "var(--muted)", fontWeight: 500 }}>{String(sub)}</div>
              </div>
            ))}
          </div>
        )}

        {refusal && (
          <a
            href={`/sessions/${refusal.session_id}`}
            className="card card-interactive"
            style={{
              display: "block",
              padding: "32px",
              marginBottom: 16,
              textDecoration: "none",
              color: "inherit",
              background: "var(--panel)"
            }}
          >
            <div className="eyebrow" style={{ color: "var(--bad)", fontWeight: 700 }}>A real refusal · from the last run</div>
            <div style={{ display: "flex", gap: 20, alignItems: "center", margin: "20px 0 16px", flexWrap: "wrap" }}>
              <div style={{ fontSize: 36, fontWeight: 800, color: "var(--bad)", letterSpacing: "-0.03em" }}>
                {rupees(refusal.cart)}
              </div>
              <div style={{ fontSize: 24, color: "var(--dim)" }}>&gt;</div>
              <div style={{ fontSize: 36, fontWeight: 800, letterSpacing: "-0.03em" }}>
                {rupees(refusal.ceiling)}
              </div>
              <code style={{ fontSize: 14, color: "var(--panel)", background: "var(--bad)", padding: "6px 12px", borderRadius: "999px", fontWeight: 700 }}>{refusal.reason_code}</code>
            </div>
            <div style={{ fontSize: 15, color: "var(--muted)", lineHeight: 1.6 }}>
              The cart cost more than the buyer authorised, so no payment call was made.
              The agent was told why, offered something the mandate could afford, and took it.{" "}
              <span style={{ color: "var(--text)", fontWeight: 700 }}>See the full trail →</span>
            </div>
          </a>
        )}

        <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginTop: c && refusal ? 32 : 0 }}>
          <a href="/upload" className="card card-interactive" style={{ flex: 1, minWidth: 260, padding: 32, textDecoration: "none", color: "inherit", background: "var(--panel)" }}>
            <div style={{ fontSize: 18, fontWeight: 800, marginBottom: 12, color: "var(--text)" }}>Upload a catalogue →</div>
            <div style={{ fontSize: 15, color: "var(--muted)", lineHeight: 1.6 }}>A messy spreadsheet. Merged cells, notes above the header, prices written any way at all. Watch it become a feed.</div>
          </a>
          <a href="/sessions" className="card card-interactive" style={{ flex: 1, minWidth: 260, padding: 32, textDecoration: "none", color: "inherit", background: "var(--panel)" }}>
            <div style={{ fontSize: 18, fontWeight: 800, marginBottom: 12, color: "var(--text)" }}>Audit trail →</div>
            <div style={{ fontSize: 15, color: "var(--muted)", lineHeight: 1.6 }}>Every decision a checkout made, with the reason code, the human explanation, and the checks that passed beside the one that failed.</div>
          </a>
        </div>

        <div
          className="card"
          style={{ marginTop: 40, padding: "32px", background: "var(--neutral-bg)", border: "1px dashed var(--line)" }}
        >
          <div className="eyebrow" style={{ marginBottom: 16 }}>
            THE NINETY SECONDS
          </div>
          <code style={{ fontSize: 14, color: "var(--text)", background: "var(--panel)", border: "1px solid var(--line)", padding: "6px 12px", borderRadius: "6px", fontWeight: 700 }}>npm run demo</code>
          <p style={{ fontSize: 15, color: "var(--muted)", lineHeight: 1.7, marginBottom: 0, marginTop: 16 }}>
            An agent discovers a product, buys it, then hits a price that moved underneath it.
            It is refused with both numbers, offered something the mandate can afford, and takes
            it. The refusal is the point:{" "}
            <span style={{ color: "var(--text)", fontWeight: 700 }}>no payment call executes without a valid mandate</span>.
          </p>
        </div>

        <p style={{ fontSize: 13, color: "var(--dim)", marginTop: 48, textAlign: "center", fontWeight: 500 }}>
          Razorpay test mode only — no live keys, no real money. Built for the Razorpay
          Buildathon, Track 1.
        </p>
      </div>
    </main>
  );
}
