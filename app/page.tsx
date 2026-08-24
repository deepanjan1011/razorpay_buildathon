/**
 * The front door. It was a 404.
 *
 * Not a landing page in the marketing sense — nothing here is judged, and time
 * spent on a hero section is time not spent making the refusal frame land. What
 * it has to do is orient someone in about five seconds and point at the two
 * surfaces that are real: a merchant uploading a spreadsheet, and the audit
 * trail behind a purchase.
 */
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

const Card = ({ href, title, body }: { href: string; title: string; body: string }) => (
  <a
    href={href}
    style={{
      display: "block", padding: 18, border: "1px solid var(--line)", borderRadius: 10,
      background: "var(--panel)", textDecoration: "none", color: "inherit", flex: "1 1 260px",
    }}
  >
    <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 6 }}>{title}</div>
    <div style={{ fontSize: 13, color: "var(--muted)", lineHeight: 1.5 }}>{body}</div>
  </a>
);

export default async function Home() {
  const c = await counts();

  return (
    <main style={{ padding: "44px 24px" }}>
      <div style={{ maxWidth: 780, margin: "0 auto" }}>
        <h1 style={{ fontSize: 30, margin: 0, lineHeight: 1.25 }}>
          A spreadsheet merchant,
          <br />
          transactable by AI buyers.
        </h1>
        <p style={{ fontSize: 15, color: "var(--muted)", lineHeight: 1.6, maxWidth: 620 }}>
          Their catalogue is a spreadsheet. Their storefront is Instagram. Their payments are
          a Razorpay link. This turns that into an ACP product feed, an agent-facing checkout,
          and a signed mandate that decides whether a charge may happen at all — with an audit
          trail behind every decision.
        </p>

        {c && (
          <div style={{ display: "flex", gap: 28, margin: "24px 0 30px" }}>
            {[
              [c.variants, "products live"],
              [c.sessions, "checkout sessions"],
              [c.refusals, "refusals recorded"],
            ].map(([n, label]) => (
              <div key={String(label)}>
                <div style={{ fontSize: 24, fontWeight: 600 }}>{String(n)}</div>
                <div style={{ fontSize: 12, color: "var(--muted)" }}>{String(label)}</div>
              </div>
            ))}
          </div>
        )}

        <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
          <Card
            href="/upload"
            title="Upload a catalogue →"
            body="A messy spreadsheet. Merged cells, notes above the header, prices written any way at all. Watch it become a feed."
          />
          <Card
            href="/sessions"
            title="Audit trail →"
            body="Every decision a checkout made, with the reason code, the human explanation, and the checks that passed beside the one that failed."
          />
        </div>

        <div
          style={{
            marginTop: 30, padding: 18, border: "1px solid var(--line)",
            borderRadius: 10, background: "var(--panel)",
          }}
        >
          <div style={{ fontSize: 12, color: "var(--muted)", letterSpacing: 1, marginBottom: 10 }}>
            THE NINETY SECONDS
          </div>
          <code style={{ fontSize: 13, color: "var(--good)" }}>npm run demo</code>
          <p style={{ fontSize: 13, color: "var(--muted)", lineHeight: 1.6, marginBottom: 0 }}>
            An agent discovers a product, buys it, then hits a price that moved underneath it.
            It is refused with both numbers, offered something the mandate can afford, and takes
            it. The refusal is the point:{" "}
            <span style={{ color: "var(--text)" }}>no payment call executes without a valid mandate</span>.
          </p>
        </div>

        <p style={{ fontSize: 12, color: "var(--dim)", marginTop: 28 }}>
          Razorpay test mode only — no live keys, no real money. Built for the Razorpay
          Buildathon, Track 1.
        </p>
      </div>
    </main>
  );
}
