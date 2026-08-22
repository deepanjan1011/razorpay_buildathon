# OBSTACLES

Running log. Newest at the bottom. What broke, what was tried, what worked.
Written as encountered, not reconstructed.

---

## 2026-08-22 — Which ACP version to pin

**Mismatch.** `DESIGN.md` §2 says "pin one dated API version" but names none.
Phase 1 needs a Product Feed Spec to conform to, and it was not known which
dated release contains one.

**What was tried.** Enumerated `spec/` in the `agentic-commerce-protocol` repo.
Released versions: `2025-09-29`, `2025-12-12`, `2026-01-16`, `2026-01-30`,
`2026-04-17`, plus `unreleased`.

**Finding.** The feed spec (`schema.feed.json`, `openapi.feed.yaml`) exists
**only from `2026-04-17`**. Every earlier dated release ships checkout and
delegate-payment only.

**Chosen.** Pin `API-Version: 2026-04-17`.

**Why.** Not a free choice. It is simultaneously the newest release and the only
one in which the feed half of Phase 1 has anything to validate against.

**Aside.** `rfcs/rfc.product_feeds.md` examples still show
`API-Version: 2026-01-30` — a version predating the feed API the RFC documents.
Stale examples; the dated spec files are authoritative.

---

## 2026-08-22 — DECISION 1: ACP feeds are agent-hosted push; we have no agent to push to

**Mismatch.** `PHASE-1.md` §6 and §7 assume the merchant *serves* a feed
(`/api/feed/[merchantId]`, "stable and cacheable", "versioned", plus a "merchant
manifest"). The real spec inverts that. `rfc.product_feeds.md` §3.1 and §5: the
Product Feed API is hosted by the **agent**; merchants call `POST /feeds` and
`PATCH /feeds/{id}/products` against the agent to publish. Verbatim MUST:
*"Agents MUST NOT call Product Feed API endpoints on merchants."*

So the planned pull endpoint is not merely un-submitted — it is the inverse of
the spec's transport direction.

**Complicating fact.** This project targets a merchant on no platform, with our
own MCP server standing in as the agent (`DESIGN.md` §1). There is no
third-party agent-hosted Feed API to push to, and no onboarding relationship
from which to obtain a `feed_id`.

**Options considered.**

1. *Offline artifacts + read API.* Emit the spec's own full-replacement
   artifacts — `metadata.json` (`FeedMetadata` shape) and `products.jsonl` (one
   `Product` per line) — validate both against `schema.feed.json`, and serve
   `GET /feeds/{id}` and `GET /feeds/{id}/products` as the read surface our MCP
   server consumes.
2. *Payload-only.* Generate and validate the artifacts, ship no HTTP surface in
   Phase 1, defer serving to Phase 4.
3. *Implement the push client too.* Build `POST /feeds` and
   `PATCH /feeds/{id}/products` as a client against a locally stubbed agent.

**Chosen.** Option 1.

**Why.** "Offline Full Replacement" is a first-class publication model in the
spec itself (`rfc.product_feeds.md` §3.4) — not a workaround we invented — so
the payloads are conformant even though the transport is not. Option 3's stub
agent is fiction: we would be conforming against a server we also wrote, which
proves nothing and costs the most code. Option 2 defers a decision Phase 4
strictly depends on. Option 1 yields exactly one deviation to declare in the
README: the read surface is merchant-hosted because no agent-hosted feed service
exists for a merchant with no platform.

**Note.** `DESIGN.md` §7's known gap — "Product feed is served, not submitted to
any agent platform's ingestion" — remains accurate under this choice and needs
no edit. It is now a precisely-characterised deviation rather than a vague one.

---

## 2026-08-22 — DECISION 2: Phase 1 schema is flat; ACP feed is two-level

**Mismatch.** `PHASE-1.md` §1 models one flat `Product` with a nullable
`variant_group_id`. ACP requires `Product { id, variants[] }`, where `Variant`
is the purchasable unit carrying price, availability, categories, media and
options. `variant_group_id` inverts the spec's containment direction.

Further: `Product.id` and `Variant.id` are both required and distinct, while
Phase 1 carries a single `id`.

**Downstream consequence.** `Variant.id` is the identifier an agent passes to
`POST /checkout_sessions` as `items[].id` (`rfc.product_feeds.md` §4.3; in the
checkout OpenAPI, `Item.id` is the only required field on `Item`). The id scheme
is therefore a Phase 2 and Phase 3 dependency and cannot be deferred.

**Options considered.**

1. *Restructure the internal model now* to match ACP containment.
2. *Keep the flat row model*, group into Product/Variant only in the feed
   projection layer.

**Chosen.** Option 1.

**Why.** The §4 mess case "one row describing several variants (`S/M/L`,
`Red, Blue, Black`)" maps onto `Product.variants[]` far more naturally than onto
a flat row plus a group id — the restructure makes the hardest parse case
easier, not harder. Option 2 does not avoid the work; the grouping logic and the
dual-id scheme still have to exist, just later, in a projection layer, after
tests have been written against the wrong shape. Cost of choosing now is one
`PHASE-1.md` §1 edit before any code exists.

---

## 2026-08-22 — DECISION 3: `brand`, `material`, `gender`, `inventory_count` have no legal home in the feed

**Mismatch.** `PHASE-1.md` §1 carries `brand`, `inventory_count`, and a
free-form `attributes: Record<string, string>` (colour, size, material, gender).
Checking `schema.feed.json`:

- No `brand` field on `Product` or `Variant`. Anywhere.
- No inventory quantity. `Availability` is `{available: boolean, status: string}`
  only — quantity is deliberately absent from the spec.
- `variant_options[] {name, value}` exists but is scoped to *"option selections
  that distinguish this variant"*. Colour and size qualify. Material and gender
  do not — they do not distinguish variants of the same product.

Every object in the feed schema sets `additionalProperties: false`. There is no
overflow slot.

**What was tried.** Investigated the ACP Extensions Framework
(`schema.extension.json`, `rfcs/rfc.extensions.md`) to see whether extension
fields could legitimately carry these — and provenance with them.

**Finding: extensions do not reach feeds.** Four independent confirmations:

1. RFC scope states extensions "extend the core **checkout** specification".
2. Composition rule §5.3: extensions "MAY add new optional fields to **the
   checkout object**".
3. Every documented `extends` target in §3.4.2 is `$.CheckoutSession*` —
   `CheckoutSessionCreateRequest`, `CheckoutSessionUpdateRequest`,
   `CheckoutSession`, `CheckoutSessionResponse`,
   `CheckoutSessionCompleteRequest`. No product or catalog target exists.
4. Negotiation happens through `capabilities.extensions` in checkout
   request/response. `grep -c capabilities` returns **0** for both
   `openapi.feed.yaml` and `schema.feed.json` — the feed surface has no
   capabilities object, so there is no channel through which an extension could
   ever be declared or negotiated.

**Options considered.**

1. *Internal only, fold into `description.plain`.* Keep all four in Postgres for
   dashboard, mandate matching and eval; surface brand/material/gender in prose
   so agents can still match on them.
2. *Emit as `variant_options`.* Schema-legal, keeps them structured.
3. *Use the extension mechanism.* — eliminated by the investigation above.

**Chosen.** Option 1.

**Why.** Option 3 is not available: it was checked rather than assumed, and the
feed surface cannot carry extensions. Option 2 is schema-legal but semantically
false — an agent reading `variant_options` may reasonably render them as
selectable choices, so a buyer could be offered "Gender: Womens" as a picker on
a product with one variant. Corrupting a field's meaning to preserve a field's
data is a worse outcome than a thinner feed. `description.plain` is
lossy-but-honest: the information stays agent-visible without lying about its
structure.

**Consequential rule.** `PHASE-1.md` §1 says the internal model is a superset
and to "never do a lossy transform on the way out". That now needs its
companion: **the outbound feed projection is lossy by construction, and that is
correct.** The no-lossy-transform rule governs the internal record, not the
published one.

---

## 2026-08-22 — DECISION 4: repo was not under version control

**Mismatch.** `git status` returned `fatal: not a git repository`. `CLAUDE.md`
treats commit history as a judged artifact, so every Phase 0 document was
uncommitted and unattributed.

**Options considered.**

1. *Init now*, commit the corrected design as commit one.
2. *Init later*, after Phase 1 code exists.

**Chosen.** Option 1, with two amendments: `.gitignore` lands in the first
commit (covering `CLAUDE.md`, `.env*`, `fixtures/real-*`), and `PHASE-1.md` is
corrected for Decisions 2 and 3 **before** committing.

**Why.** Commit one should be the corrected design, not a wrong version that
commit two fixes. A history that shows the flat schema being replaced two
commits later reads as churn; a history that starts correct and records *why* in
this file reads as judgement. `fixtures/real-*` is ignored from the start
because `DESIGN.md` §9 commits to real merchant spreadsheets used with
permission — the gitignore has to exist before the first real sheet arrives, not
after.

---

## 2026-08-22 — Provenance cannot be published in the feed

**Mismatch.** `CLAUDE.md` invariant 7 requires every normalized product to carry
provenance. `additionalProperties: false` on every feed object means a
conforming payload has nowhere to put `provenance` or `normalization`.

**Chosen.** Provenance stays internal — Postgres, dashboard and eval — and is
never serialized into the feed.

**Why.** The invariant is about traceability of the record, not about publishing
the trace. No real conflict, but it had to be stated explicitly, because it is
the same lossy-projection point as Decision 3 and would otherwise look like an
invariant being quietly dropped.

---

## 2026-08-22 — Spec inconsistencies found in `2026-04-17`

**Mismatch.** `DESIGN.md` §2 plans to validate every response against the
published JSON Schemas, treating that as the conformance suite. That assumes the
schemas mirror the OpenAPI. At `2026-04-17` they do not.

**Finding 1.** `openapi.feed.yaml` references
`#/components/schemas/UpsertProductsResponse` and defines it inline (line 651),
but `schema.feed.json` for the same dated version does not define
`UpsertProductsResponse` at all — absent from `$defs`, confirmed by grep
returning 0 occurrences. `changelog/unreleased/add-upsert-products-response-schema.md`
exists, suggesting the fix landed in `unreleased` after `2026-04-17` was cut.

**Consequence.** A conformance suite driven purely off `schema.feed.json` will
silently carry no assertion for upsert responses.

**Finding 2.** `openapi.feed.yaml` declares
`servers: [https://merchant.example.com]` while its own RFC states the API is
agent-hosted and that agents MUST NOT call it on merchants. The OpenAPI
`servers` block contradicts the RFC it implements.

**Status.** Noted, not blocking — both affect the endpoint on our deviation path
anyway. Do not paper over either in the conformance suite: assert what the
schema actually defines and record the hole here rather than inventing a local
schema and calling the result conformant.

---

## 2026-08-22 — Header detection by known field names fails on the Tamil sheet

**Hit.** First cut of `detectHeader` scored each candidate row by what fraction
of its cells matched a list of known field names (`item`, `price`, `stock`, …)
and required ≥0.5. It worked on nine fixtures and failed on
`messy-07-multilingual.xlsx`, whose header row is `பொருள் | விலை | Stock` — one
of three cells recognisable, score 0.33, rejected. The sheet then parsed as
having no header at all.

**Why that mattered more than one fixture.** The failure is not specific to
Tamil. Any sheet whose headers are not in the synonym list — another language,
an abbreviation, a merchant's own shorthand — degrades to "no header", and the
list can never be complete. A tactic that works only for English small
merchants is the wrong tactic for this project.

**What worked.** Replaced the name test with a structural one: a header row is
all non-numeric, has at least two filled cells, and is followed by a row
containing a number. That is script-agnostic and passes all ten fixtures,
including the two-row header case — which needed no special handling at all,
because the banner row (`Product Details` / `Pricing`) is followed by another
all-text row and is therefore rejected, while the real field-name row below it
is followed by numbers and is accepted.

**Kept anyway.** The synonym list survives as `headerScore`, reported but never
used as the gate. It tells the review queue how confident the header mapping is
without deciding anything.

---

## 2026-08-22 — Price parsing produced ₹0.13 for `Rs. 1,299/-`

**Hit.** `parsePrice("Rs. 1,299/-")` returned `13` paise instead of `129900`.

**Cause.** The cleaner was subtractive: strip the currency marker, strip the
trailing `/-`, strip commas, strip anything left that is not a digit or a dot.
The marker regex `\bRs\.?\b` matched only `Rs` — the trailing `\b` cannot sit
between `.` and a space — so the full stop survived, leaving `.1299`, which is
a perfectly valid number. `0.1299` rupees, rounded to 13 paise. No parse error,
no exception, just a wrong price two orders of magnitude out.

**What worked.** Stopped subtracting and started extracting: strip commas, then
match `/\d+(?:\.\d+)?/` and take the first hit. Removing text you do not want
leaves whatever you failed to anticipate; matching the number you do want
leaves nothing.

**Why this one is worth writing down.** It is exactly the failure mode the
invariants exist for. It is silent, it is in the money path, and the only
reason it surfaced before reaching a mandate ceiling comparison is that
`Rs. 1,299/-` was written into a fixture *before* the parser existed. A
plausible-looking wrong number is more dangerous than a crash, and a test suite
written after the implementation would likely have asserted whatever the
implementation happened to produce.

**Generalised into two standing rules** in `CLAUDE.md` and `PHASE-1.md` §4:

- *Extract, do not subtract.* Removal-based cleaning leaves behind whatever you
  failed to anticipate. Match what you want instead. Subtraction fails silently;
  extraction fails loudly.
- *Fixtures come from observed real-world data, before the parser.* A fixture
  written afterwards mirrors the implementation and stops finding anything.

---

## 2026-08-22 — Audit: every other coercion checked for the same shape

**Prompted by** the price bug generalising. If removal-based cleaning is wrong
in `parsePrice`, it is wrong wherever else it appears, and the failure would be
equally silent.

**Method.** Grepped every `replace` / `split` / `filter` / `trim` / `slice` in
`lib/ingest/` and classified each as extraction, matching, or subtraction.

**Result — `parsePrice` was the only true instance.**

| Site | Shape | Verdict |
|---|---|---|
| `toMinor` numeric parse | was subtraction | fixed, now extraction |
| `toMinor` shorthand branch | extraction, `NaN`-guarded | clean |
| `parseStock` | pure match/test, anchored count regex | clean, no subtraction anywhere |
| `cellText`, `dedupeKey` | whitespace normalisation only | clean |
| `trimTrailingEmpty` | subtractive, but bounded to trailing empty columns | acceptable |
| `splitList` | split-based, not subtractive — **but same failure family** | fixed, below |

**`splitList` fabricated variants from a fraction.** Not subtraction, but the
same silent-plausible-wrong-value shape: `splitList("1/2 kg")` returned
`["1", "2 kg"]`. Grocery sellers size by measure, so a `Size` column reading
`1/2 kg` is one size — and the split invents two separately purchasable SKUs
that do not exist. Worse than the price bug in one respect: an agent could buy
one of them.

**Fix.** A slash with no surrounding whitespace only splits when every resulting
part is a single word. `S/M/L` and `30/32/34` still split; `1/2 kg` does not;
`5 kg / 10 kg` still does, because the slash is spaced.

**Accepted cost.** `Half Sleeve/Full Sleeve` now stays unsplit. Under-splitting
is the safer failure: it yields one variant with a compound name that a human
sees in review, where over-splitting silently fabricates buyable SKUs. Pinned by
a test so it is a decision rather than a regression.

**Declined.** `parseStock` discards `inventory_count` when a word match wins —
`yes 5 pcs` gives `in_stock` with a null count. Left alone: `inventory_count` is
internal-only and never reaches the feed (§1.1, ACP has no quantity field), the
availability answer is still correct, and a looser digit-grab would start
reading sizes as stock counts (`Size 9 available` → 9 in stock). Wrong in the
safe direction, at zero published cost.

---

## 2026-08-22 — Sanity band added to the money path

**Why, given the extraction fix already landed.** The `Rs. 1,299/-` bug produced
13 paise. A plausibility band on the parsed amount would have caught it
independently, without anyone anticipating that specific malformation — which is
the whole point, since the next such bug will have a shape nobody predicted.

**Chosen.** Any parsed price below ₹1 or above ₹10,00,000 gets
`PRICE_OUT_OF_BAND` and therefore `needs_review`, rather than being accepted.
The value is kept rather than nulled, so the merchant can see what was read from
their sheet; `needs_review` already withholds it from the feed.

**Why a band and not tighter validation.** The band is not trying to be right
about what a small merchant charges. It is trying to catch order-of-magnitude
parse failures, which is a much easier target and does not need tuning. Two
independent checks that both have to fail is cheap insurance in the one path
where being wrong costs real money.

**Note.** `PRICE_OUT_OF_BAND` is a new `NormalizationFlag`; `PHASE-1.md` §1 was
amended rather than overloading `PRICE_AMBIGUOUS`, because
`CLAUDE.md` invariant 3 wants a distinct machine reason code per refusal.
