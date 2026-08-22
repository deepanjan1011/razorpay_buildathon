# PHASE 1 — Catalog ingest, normalization, feed

**Gate:** a real merchant spreadsheet goes in, a valid agent-readable feed
comes out, with a measured accuracy number.

Read `docs/DESIGN.md` and `CLAUDE.md` first.

---

## 1. Normalized product schema

Pinned spec version: **`API-Version: 2026-04-17`** — the only released ACP
version containing a Product Feed Spec. See `docs/OBSTACLES.md`.

The internal model mirrors ACP's two-level containment: a `Product` groups one
or more purchasable `Variant` records. It is a **superset** of the ACP Product
Feed Spec — it carries fields the feed has no slot for.

```ts
type Money = { amount_minor: number; currency: "INR" };  // integer paise

type Product = {
  id: string;                    // stable, merchant-scoped -> ACP Product.id
  merchant_id: string;           // internal only, no ACP field

  title: string;
  description: string | null;
  brand: string | null;          // internal only, no ACP field — see §1.1

  variants: Variant[];           // REQUIRED, non-empty -> ACP Product.variants
  image_url: string | null;      // -> ACP Product.media[0]

  provenance: Provenance;        // internal only, never published
  normalization: Normalization;  // internal only, never published
};

type Variant = {
  id: string;                    // stable -> ACP Variant.id
                                 // THIS is the checkout items[].id in Phase 2.
                                 // Must stay stable across re-ingests.
  title: string;                 // REQUIRED by ACP, unlike Product.title

  category: Category;            // mapped taxonomy, see §2
  category_raw: string | null;   // exactly what the sheet said
  category_confidence: number;   // 0-1, internal only

  price: Money;
  compare_at_price: Money | null;   // -> ACP Variant.list_price

  availability: "in_stock" | "out_of_stock" | "unknown";
  inventory_count: number | null;   // internal only, ACP has no quantity field

  options: Record<string, string>;     // ONLY variant-distinguishing dims:
                                       // colour, size. -> variant_options[]
  attributes: Record<string, string>;  // material, gender, ... internal only,
                                       // folded into description on the way out
  image_url: string | null;            // -> ACP Variant.media[0]

  provenance: Provenance;        // REQUIRED — every variant traces back
  normalization: Normalization;
};

type Provenance = {
  source_file: string;
  source_sheet: string;
  source_row: number;            // REQUIRED — every variant traces back
  source_cells: Record<string, string>;   // raw values used
};

type Normalization = {
  confidence: number;            // 0-1
  flags: NormalizationFlag[];
  needs_review: boolean;
};

type NormalizationFlag =
  | "PRICE_AMBIGUOUS"
  | "CATEGORY_UNMAPPED"
  | "TITLE_INFERRED"
  | "VARIANTS_SPLIT"
  | "CURRENCY_ASSUMED"
  | "MULTILINGUAL_SOURCE"
  | "MISSING_REQUIRED_FIELD"
  | "PRICE_OUT_OF_BAND";     // outside ₹1 .. ₹10,00,000, see §4
```

Nothing with `needs_review: true` is served in the feed. It surfaces in the
merchant dashboard for confirmation. **Never silently guess into the feed.**

A `Product` whose every `Variant` is flagged is itself withheld. A `Product`
with a mix serves only its clean variants — ACP requires `variants` to be
present, so a product cannot ship empty.

### Blocking vs advisory flags

`needs_review` is set by **blocking** flags only. Flags divide by what they
assert:

| | Flags | Meaning |
|---|---|---|
| **Blocking** | `MISSING_REQUIRED_FIELD`, `PRICE_AMBIGUOUS`, `PRICE_OUT_OF_BAND`, `CATEGORY_UNMAPPED`, `TITLE_INFERRED` | *We are not sure this is right.* Withheld from the feed, sent to review. |
| **Advisory** | `CURRENCY_ASSUMED`, `VARIANTS_SPLIT`, `MULTILINGUAL_SOURCE` | *Something we did, or something about the source.* Carried on the record and shown in review; does not gate publication. |

This is not a softening. Treating every flag as blocking empties the feed —
`CURRENCY_ASSUMED` fires on any plain-number price, which is nearly every row of
nearly every real sheet — and a review queue holding every product is one the
merchant rubber-stamps, which destroys the check it exists to provide. The
reasoning per flag is in `lib/normalize/flags.ts`; the failure that forced it is
in `OBSTACLES.md`.

A withheld record's logged reason names **blocking flags only**. A record held
for `CATEGORY_UNMAPPED` must not be logged as
`CURRENCY_ASSUMED,CATEGORY_UNMAPPED` — that reason code names a non-cause, and
`CLAUDE.md` invariant 3 asks for one that is true.

### 1.1 Outbound projection to the ACP feed

The internal model is a superset, so **the outbound projection is lossy by
construction, and that is correct.** The "never do a lossy transform" rule
governs the internal record — what we store from the sheet — not the published
one. Every feed object sets `additionalProperties: false`; there is no overflow
slot and no extension mechanism that reaches feeds (verified — see
`OBSTACLES.md` Decision 3).

| Internal | ACP feed | Note |
|---|---|---|
| `Product.id` | `Product.id` | required |
| `Product.title` | `Product.title` | optional in ACP |
| `Product.description` | `Product.description.plain` | **omit the key entirely when null** — `Description` has `minProperties: 1` and no null type |
| `Product.image_url` | `Product.media[0]` | `{type:"image", url}`, `format: uri` — must be absolute |
| `Variant.id` | `Variant.id` | required; also the checkout `items[].id` |
| `Variant.title` | `Variant.title` | **required by ACP** |
| `Variant.price` | `Variant.price` | `{amount, currency}` — field is `amount`, not `amount_minor`; integer, `minimum: 0` |
| `Variant.compare_at_price` | `Variant.list_price` | |
| `Variant.category` | `Variant.categories[0]` | `{value, taxonomy: "agentready"}` — `taxonomy` is a free string, so our fixed enum is legal as its own named taxonomy |
| `Variant.category_raw` | `Variant.categories[1]` | `{value: raw, taxonomy: "merchant"}` — verbatim preservation is spec-native here |
| `Variant.availability` | `Variant.availability` | `{available: bool, status: string}`. ACP has no `"unknown"`; `unknown` implies `needs_review` and therefore never ships |
| `Variant.options` | `Variant.variant_options[]` | `{name, value}` — colour/size only |
| `Variant.image_url` | `Variant.media[0]` | |

**Dropped on the way out, kept internally:**

- `merchant_id` — feed scope carries it; `Seller.name` is display-only
- `inventory_count` — ACP models stock as a boolean plus a status string, never a quantity
- `category_confidence`, `normalization`, `provenance` — no slot exists
- `brand`, and `attributes` (material, gender, …) — no slot exists. Folded into
  `description.plain` so they stay agent-matchable. **Not** emitted as
  `variant_options`: those are option selections that *distinguish* a variant,
  and an agent may render them as a picker. See `OBSTACLES.md` Decision 3.

Feed-level, not on any product: `FeedMetadata.target_country: "IN"`.

Cheap ACP fields worth populating once a merchant profile exists —
`Seller.links` (refund/shipping policy), `Variant.barcodes`, `Variant.condition`,
`Variant.unit_price` (matters for sellers pricing by weight or volume).

---

## 2. Category taxonomy

Fixed, small, deliberately coarse. Mandate matching must be deterministic, so
the LLM maps *into* this list and cannot invent members.

```ts
type Category =
  | "apparel" | "footwear" | "accessories" | "jewellery"
  | "beauty"  | "home"     | "kitchen"     | "electronics"
  | "stationery" | "food"  | "toys"        | "unmapped";
```

Rules:
- Below a confidence threshold → `"unmapped"` + `CATEGORY_UNMAPPED` +
  `needs_review: true`. **Do not force-fit.**
- `category_raw` always preserved verbatim, whatever the sheet said.
- Mandate category matching operates on `category` only, never on
  `category_raw` and never via a model call at payment time.

---

## 3. Ingest pipeline

```
upload (CSV/XLSX)
   ↓  parse — sheet detection, header detection, merged-cell expansion
   ↓  row extraction — raw cells preserved
   ↓  LLM structured extraction (batched, JSON schema constrained)
   ↓  deterministic validation + coercion
   ↓  flagging
   ↓  Postgres
   ↓  feed generation
```

The LLM call is the *easy* part. The parsing and validation around it is the
actual engineering.

---

## 4. The mess — handle each explicitly, with a test per case

Real small-merchant sheets contain:

- Title rows, blank rows, and notes above the real header
- Headers on row 3, or spanning two rows, or absent entirely
- Merged cells — one category cell covering twelve product rows
- Prices as `2799`, `2,799`, `₹2799`, `2799/-`, `2.8k`, `2799 (MRP 3499)`
- Size and colour embedded in the title: `Blk RunShoe M-9`
- One row describing several variants: `S/M/L`, `Red, Blue, Black`
- Mixed Tamil/English, or transliterated Tamil in Latin script
- Trailing junk rows: totals, notes, contact numbers
- Duplicate products across sheets
- Stock as `yes`/`no`/`✓`/blank/`10 pcs`

**Deterministic first, LLM second.** Anything regex or a parser can do reliably
(currency stripping, number coercion, boolean-ish stock values) must not go
through the model. The model handles semantics: what is this product, what
category, which attributes.

### Two rules the fixtures exist to enforce

**Fixtures are written from observed real-world data, before the code that
parses them — never derived from what the parser already handles.** A fixture
written afterwards is a mirror of the implementation: it asserts whatever the
code happens to do, and stops finding anything. This is methodology, not
diligence theatre — `parsePrice("Rs. 1,299/-")` returning ₹0.13 instead of
₹1,299 was caught only because that string sat in a fixture before the parser
existed. See `OBSTACLES.md`.

**Extract, do not subtract.** Never clean a value by removing what you do not
want and trusting the remainder; anything you failed to anticipate survives into
the result. Match the thing you *do* want instead. Subtraction fails silently
and produces a plausible wrong value, which is worse than a crash — especially
on the money path, where a plausible wrong number is compared against a mandate
ceiling and charged.

---

## 5. Accuracy measurement — do not skip

Hand-label 50 products from a real sheet. Run the pipeline. Report:

- Field-level accuracy per field (title, price, category, attributes)
- Count of `needs_review` products
- The failures, listed, with the source row and what went wrong

Output as `docs/NORMALIZATION-EVAL.md`, regenerated when the pipeline changes.

This number goes in the video. It is the honest metric this project has, and
it must never be hand-tuned to look better.

---

## 6. Feed

Serve products where `needs_review === false`, conforming to the ACP Product
Feed Spec at `2026-04-17`. Field mapping is fixed in §1.1 — do not re-guess it.

**Transport deviation, stated up front.** In ACP the Product Feed API is hosted
by the *agent*; merchants push to it (`POST /feeds`,
`PATCH /feeds/{id}/products`), and `rfc.product_feeds.md` §3.1 states that
agents MUST NOT call feed endpoints on merchants. A merchant on no platform has
no agent-hosted feed service to push to and no `feed_id` to push against. So:

1. Generate the spec's own offline full-replacement artifacts —
   `metadata.json` (`FeedMetadata` shape) and `products.jsonl`, one `Product`
   per line. This is a first-class publication model in the spec
   (`rfc.product_feeds.md` §3.4), not a workaround.
2. Validate both against `schema.feed.json` at the pinned version. That is the
   conformance suite.
3. Serve `GET /feeds/{id}` and `GET /feeds/{id}/products` as the read surface
   our MCP server consumes in Phase 4.

Conformant payloads, non-conformant transport direction, exactly one deviation
to declare in the README. Rationale in `OBSTACLES.md` Decision 1.

The read surface must be stable, cacheable and versioned. The "machine-readable
merchant manifest" is ACP discovery, not something we invent:
`capabilities.services: ["checkout", "feeds"]`.

**Known hole:** `UpsertProductsResponse` is referenced by `openapi.feed.yaml` at
`2026-04-17` but absent from `schema.feed.json` at the same version. Assert what
the schema defines; do not invent a local schema and call the result conformant.

---

## 7. Suggested layout

```
/app
  /(merchant)/upload        # sheet upload UI
  /(merchant)/review        # confirm flagged products
  /api/feeds/[feedId]           # FeedMetadata
  /api/feeds/[feedId]/products  # ProductsResponse
/lib
  /ingest    parse.ts  headers.ts  cells.ts
  /normalize llm.ts  schema.ts  taxonomy.ts  validate.ts  flags.ts
  /feed      acp.ts  project.ts   # internal -> ACP Product/Variant, §1.1
  /db        schema.ts  queries.ts
/docs
  DESIGN.md  PHASE-1.md  OBSTACLES.md  NORMALIZATION-EVAL.md
/spec/acp/2026-04-17           # vendored ACP schemas, pinned
/fixtures
  messy-*.xlsx              # synthetic mess, committed
  real-*.xlsx               # real sheets, gitignored
/tests
  one test per mess case in §4
```

Paths mirror the ACP feed shape (`/feeds/{id}`, `/feeds/{id}/products`) rather
than a merchant-scoped feed URL, so the read surface matches the spec's resource
model even though the transport direction does not. See §6.

---

## 8. Done when

- [ ] A real merchant spreadsheet parses end to end — blocked on a real sheet
- [x] Every §4 mess case has a passing test
- [ ] Flagged products are reviewable, not silently dropped or guessed —
      withheld *with a reason* by the projection; the review UI is not built
- [ ] `NORMALIZATION-EVAL.md` exists with a real, un-tuned number — blocked on a
      real sheet. Leave it empty rather than publishing a synthetic number; a
      placeholder has a way of surviving into the README.
- [x] `metadata.json` and `products.jsonl` validate against `schema.feed.json`
      at the pinned `2026-04-17`
- [ ] Every variant traces to its source row — `Provenance` is required by the
      type; enforced end to end once the normalizer populates it
- [x] `OBSTACLES.md` has real entries — if it's empty, it wasn't kept honestly
