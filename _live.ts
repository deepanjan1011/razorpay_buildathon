const BASE = "https://razorpaybuildathon-production.up.railway.app";

const check = async (path: string, expect: string[] = []) => {
  try {
    const res = await fetch(BASE + path, { cache: "no-store" });
    const body = await res.text();
    const missing = expect.filter((n) => !body.includes(n));
    console.log(
      `${res.status} ${path}` +
        (missing.length ? `  missing: ${missing.join(", ")}` : "") +
        (res.status >= 400 ? `  ${body.slice(0, 120).replace(/\s+/g, " ")}` : ""),
    );
  } catch (e) {
    console.log(`ERR ${path}  ${e instanceof Error ? e.message : String(e)}`);
  }
};

await check("/", ["A spreadsheet merchant"]);
await check("/catalogue", ["Catalogue"]);
await check("/sessions", ["Every checkout"]);
await check("/upload", ["Upload a catalogue"]);
await check("/api/feeds/feed_live/products");
