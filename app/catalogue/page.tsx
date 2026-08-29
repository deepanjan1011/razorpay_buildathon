/**
 * The catalogue, as a human can read it. Phase 6.
 *
 * THE TRANSFORMATION HAD NO PAGE. "A messy spreadsheet becomes an
 * agent-readable catalogue" is the whole claim, and the only way to witness it
 * was raw JSON at /api/feeds/{id}/products. A visitor could read the promise on
 * the front page and never see the thing it promises.
 *
 * IT SHOWS THE WITHHELD ROWS TOO, which is the half that matters more. The
 * projection withholds a variant it cannot trust and records why (flags.ts),
 * and until this page existed that reason lived only in the database — correct,
 * and invisible to the merchant who could act on it. PLAN.md §8 lists exactly
 * this as its one open box: "flagged products are reviewable, not silently
 * dropped". This is the reviewable half; acting on it is still not built, and
 * saying so on the page is better than implying otherwise.
 *
 * BOTH HALVES COME FROM ONE SOURCE. Published and withheld are derived from the
 * same assembled products in the same read, rather than the feed for one and a
 * query for the other — two sources would drift, and a page claiming "11 of 15"
 * while the feed serves 12 is worse than no page.
 */
import Nav from "../nav.tsx";
import { connect } from "../../lib/db/sql.ts";
import { assembleProducts } from "../../lib/ingest/job.ts";
import { isWithholding } from "../../lib/normalize/flags.ts";
import type { Product, Variant } from "../../lib/normalize/schema.ts";

export const dynamic = "force-dynamic";

const money = (minor: number) => `₹${(minor / 100).toFixed(2)}`;

/** The flags that actually withheld it — not every flag riding along. */
const blockingFlags = (v: Variant) => v.normalization.flags.filter(isWithholding);

type Shelf = {
  merchant: string;
  sourceFile: string;
  published: Array<{ v: Variant; product: Product }>;
  withheld: Array<{ v: Variant; product: Product; reasons: string[] }>;
};

/**
 * The most recent completed ingest, for whichever merchant ran one last.
 *
 * Deliberately not a merchant picker: there is one merchant in this build, and
 * a selector over a list of one is furniture.
 */
async function latestShelf(): Promise<Shelf | null> {
  try {
    const sql = await connect();
    const { rows } = await sql.query<{ id: string; merchant_id: string; source_file: string }>(
      `select id, merchant_id, source_file
         from ingest_job
        where status = 'complete'
        order by created_at desc
        limit 1`,
    );
    const job = rows[0];
    if (!job) return null;

    const products = await assembleProducts(sql, job.id);
    const shelf: Shelf = {
      merchant: job.merchant_id,
      sourceFile: job.source_file,
      published: [],
      withheld: [],
    };

    for (const product of products) {
      for (const v of product.variants) {
        const reasons = blockingFlags(v);
        if (reasons.length > 0) shelf.withheld.push({ v, product, reasons });
        else shelf.published.push({ v, product });
      }
    }
    return shelf;
  } catch {
    // A database that is down must not take the page with it — same rule as
    // the front page's counts.
    return null;
  }
}

function Stat({ n, label, sub, tone }: { n: number; label: string; sub: string; tone?: "bad" }) {
  return (
    <div className="card" style={{ padding: "14px 18px", flex: "1 1 180px" }}>
      <div className="eyebrow">{label}</div>
      <div
        style={{
          fontSize: 32,
          fontWeight: 750,
          letterSpacing: -0.8,
          margin: "4px 0 2px",
          color: tone === "bad" ? "var(--bad)" : "var(--text)",
        }}
      >
        {n}
      </div>
      <div style={{ fontSize: 12, color: "var(--muted)" }}>{sub}</div>
    </div>
  );
}

export default async function Catalogue() {
  const shelf = await latestShelf();

  return (
    <main style={{ padding: "44px 24px" }}>
      <Nav active="catalogue" />
      <div style={{ maxWidth: 1040, margin: "0 auto" }}>
        <div className="eyebrow">
          <span style={{ color: "var(--accent)" }}>——</span> Catalogue
        </div>
        <h1 style={{ fontSize: 32, margin: "8px 0 6px", letterSpacing: -0.8, fontWeight: 750 }}>
          What the spreadsheet became.
        </h1>

        {shelf === null ? (
          <p style={{ fontSize: 14, color: "var(--muted)" }}>
            No completed ingest yet. Upload a sheet on <a href="/upload">Upload</a>, or run{" "}
            <code>npm run demo</code>.
          </p>
        ) : (
          <>
            <p style={{ fontSize: 14, color: "var(--muted)", marginTop: 0, lineHeight: 1.6 }}>
              From <code>{shelf.sourceFile}</code> for <code>{shelf.merchant}</code>. Every row
              below traces to the sheet row it came from.
            </p>

            <div style={{ display: "flex", gap: 14, margin: "22px 0 28px", flexWrap: "wrap" }}>
              <Stat
                n={shelf.published.length}
                label="Agents can buy"
                sub="priced, categorised, in the feed"
              />
              <Stat
                n={shelf.withheld.length}
                label="Held for review"
                sub="withheld with a reason, never guessed"
                tone="bad"
              />
              <Stat
                n={shelf.published.length + shelf.withheld.length}
                label="Rows read"
                sub="after preamble and junk were skipped"
              />
            </div>

            {/* WITHHELD FIRST. It is the shorter list and the more interesting
                one: anyone can publish the rows that parsed cleanly. */}
            {shelf.withheld.length > 0 && (
              <section style={{ marginBottom: 30 }}>
                <div className="eyebrow" style={{ marginBottom: 10 }}>
                  Held back — and why
                </div>
                <div className="card" style={{ padding: "4px 8px" }}>
                  {shelf.withheld.map(({ v, reasons }) => (
                    <div
                      key={`${v.id}-${v.provenance.source_row}`}
                      style={{
                        display: "flex",
                        gap: 16,
                        alignItems: "center",
                        padding: "12px",
                        borderBottom: "1px solid var(--line)",
                        flexWrap: "wrap",
                      }}
                    >
                      <span style={{ flex: "1 1 220px", fontWeight: 600, fontSize: 14 }}>
                        {v.title}
                      </span>
                      <span style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                        {reasons.map((r) => (
                          <code
                            key={r}
                            style={{
                              fontSize: 11,
                              color: "var(--bad)",
                              background: "var(--bad-bg)",
                              padding: "3px 8px",
                              borderRadius: 999,
                            }}
                          >
                            {r}
                          </code>
                        ))}
                      </span>
                      {/* THE SOURCE ROW, because a reason a merchant cannot
                          locate is not actionable. This is what provenance was
                          carried the whole way for. */}
                      <span style={{ fontSize: 12, color: "var(--muted)", whiteSpace: "nowrap" }}>
                        row {v.provenance.source_row}
                        {v.provenance.source_cells["Price"] || v.provenance.source_cells["Rate"] ? (
                          <>
                            {" · "}
                            <code style={{ color: "var(--warn)" }}>
                              {v.provenance.source_cells["Price"] ??
                                v.provenance.source_cells["Rate"]}
                            </code>
                          </>
                        ) : null}
                      </span>
                    </div>
                  ))}
                </div>
                <p style={{ fontSize: 12, color: "var(--dim)", marginTop: 10 }}>
                  These are held out of the feed, not dropped — an agent never sees a price we
                  could not read. Fixing them in the sheet and uploading again clears them; there
                  is no in-app editor yet, and PLAN.md §8 says so.
                </p>
              </section>
            )}

            <div className="eyebrow" style={{ marginBottom: 10 }}>
              In the feed
            </div>
            {/* GRID, NOT FLEX-WRAP. Flex items grow into the leftover space, so
                a final row holding one card stretches it across the full width
                and the page reads as broken rather than as 13 products. A grid
                track keeps the last card the size of every other card. */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(212px, 1fr))",
                gap: 12,
              }}
            >
              {/* KEYED BY ID *AND* SOURCE ROW. Variant ids are content hashes, so
                  two identical rows in one sheet — a duplicate a merchant
                  genuinely typed twice — produce the same id by design. The
                  feed collapses them; this page lists what each row became, so
                  it must key on where the row was, not on what it hashed to. */}
              {shelf.published.map(({ v }) => (
                <div
                  key={`${v.id}-${v.provenance.source_row}`}
                  className="card"
                  style={{ padding: "14px 16px", minWidth: 0 }}
                >
                  <div style={{ fontSize: 14, fontWeight: 650, marginBottom: 4 }}>{v.title}</div>
                  <div style={{ fontSize: 19, fontWeight: 750, letterSpacing: -0.4 }}>
                    {money(v.price.amount_minor)}
                  </div>
                  <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 6 }}>
                    {v.category} · row {v.provenance.source_row}
                  </div>
                </div>
              ))}
            </div>

            <p style={{ fontSize: 12, color: "var(--dim)", marginTop: 24 }}>
              The same records, as an agent reads them:{" "}
              <a href={`/api/feeds/feed_${shelf.merchant.replace(/^mer_/, "")}/products`}>
                the ACP product feed →
              </a>
            </p>
          </>
        )}
      </div>
    </main>
  );
}
