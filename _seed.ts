/** Seeds the deployed catalogue with the real merchant sheet, past the ingest lock. */
import { readFile } from "node:fs/promises";

const BASE = "https://razorpaybuildathon-production.up.railway.app";
const KEY = process.argv[2]!;
const SHEET = "fixtures/real-nellaikuttam-snacks.xlsx";

const form = new FormData();
form.set("merchant_id", "mer_live");
form.set("file", new File([await readFile(SHEET)], "real-nellaikuttam-snacks.xlsx"));

const res = await fetch(`${BASE}/api/ingest`, {
  method: "POST",
  headers: { "X-Ingest-Key": KEY },
  body: form,
});
const body = (await res.json()) as { id?: string; rows_total?: number; code?: string; message?: string };
console.log(res.status, JSON.stringify(body).slice(0, 200));

if (!body.id) process.exit(1);

// Poll until the job stops moving. Extraction is ~5 requests/minute.
for (let i = 0; i < 90; i++) {
  await new Promise((r) => setTimeout(r, 4000));
  const p = await fetch(`${BASE}/api/ingest/${body.id}`, { cache: "no-store" });
  const j = (await p.json()) as {
    status: string;
    rows_extracted: number;
    rows_total: number;
    terminal?: boolean;
  };
  console.log(`${j.status}  ${j.rows_extracted}/${j.rows_total}`);
  if (j.terminal) break;
}

const feed = await fetch(`${BASE}/api/feeds/feed_live/products`, { cache: "no-store" });
const text = await feed.text();
console.log(
  `feed_live: ${feed.status}`,
  feed.status === 200 ? `${(text.match(/"id":"prod_/g) ?? []).length} products` : text.slice(0, 120),
);
