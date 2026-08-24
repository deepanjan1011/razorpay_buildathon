# OBSTACLES

Running log. Newest at the bottom. What broke, what was tried, what worked.
Written as encountered, not reconstructed.

---

## The finding that generalises

**A green test suite proves the code is consistent with itself. It proves
nothing about the world the code runs in.**

Four bugs in this file are that one finding, wearing two faces. They are logged
separately below because that is how they were hit, but scattered they read as
four small mistakes rather than one large lesson.

| Face | What the suite failed to vary | Bugs |
|---|---|---|
| **Data** | the *shape of the input* — every fixture was one we wrote | `CURRENCY_ASSUMED` empties the feed; `CATEGORY_UNMAPPED` hides the catalogue; unknown stock empties it again |
| **Environment** | the *place the code runs* — every test ran under plain Node | `import.meta.dirname` undefined in a Next route bundle |

Both faces produce the same symptom: **everything green, nothing working.** And
both were found the same way — by running the real thing against something the
suite had never varied, then *reading the output rather than the exit code*.

### Face one: the data

Three withholding rules, each with a trigger condition ubiquitous in real
merchant sheets.

| Rule | Trigger | Rate on real sheets | Effect |
|---|---|---|---|
| any flag ⇒ `needs_review` | `CURRENCY_ASSUMED` on any plain-number price | ~every row | feed permanently empty |
| `CATEGORY_UNMAPPED` withholds | product the mapper cannot place | large fraction | catalogue invisible to agents |
| unknown stock withholds | sheet has no stock column | most price lists | feed empty again |

**A test written from a rule agrees with the rule.** Each of these had passing
unit tests — the tests asserted the wrong behaviour faithfully. The rules were
not *inconsistent*, they were *wrong*, and consistency is all a suite checks.

The third was found on a run that reported `complete 14/14`, 12 products,
`ACP valid` — and served zero. The exit code was 0.

### Face two: the environment

`lib/feed/validate.ts` loaded the pinned ACP schema with
`readFileSync(join(import.meta.dirname, …))`. That is correct under Node, and
`import.meta.dirname` is **undefined inside a Next route bundle** — so
`next build` failed on a module that 184 tests exercise constantly.

No test could have caught it, and adding more tests would not have helped: every
test runs that code under plain Node, so the suite had one environment and the
product has two. The fix was to import the schema as JSON, which removes the
filesystem from the runtime path entirely.

This is the same failure as the three above with a different variable held
constant. Where those never varied the *input*, this never varied the *host*.

### What actually finds these

- **Run the real thing, in the real place.** The data bugs needed the pipeline
  against real-world-shaped sheets; the environment bug needed `next build` and
  a server answering `curl`. Neither needed a cleverer unit test.
- **Read the output, not the exit code.** Three of the four reported success
  while being wrong.
- **Vary the axis the suite holds constant.** Ask what every test has in common —
  same fixtures we authored, same runtime, same process — because that is
  precisely where the suite is blind.

### The rules this produced

1. **A rule that withholds is only safe if it withholds a minority of real
   rows.** For every blocking flag, state its expected trigger rate; if it is
   not clearly a minority, it is advisory. A withholding rule with a ubiquitous
   trigger is a denial-of-service on the merchant, and the review queue makes it
   look like caution. (`CLAUDE.md`)
2. **Tests derived from a rule cannot falsify the rule.** Every rule needs at
   least one end-to-end assertion against a fixture built from real-world shape.
   (`CLAUDE.md`, `PHASE-1.md` §4)
3. **A suite that runs in one environment says nothing about a second one.**
   Anything that ships to a different host — a bundler, a serverless runtime, a
   browser — needs at least one check *in that host*. `npm run build` and one
   real HTTP request are worth more than any number of extra unit tests here.
   (`CLAUDE.md`)

### Ask what a flag asserts, not whether it sounds risky

The fix each time was the same question: *what does this condition actually tell
us?* `CURRENCY_ASSUMED` asserts nothing — the system is INR-only. Unknown stock
asserts nothing the spec treats as authoritative. Neither is doubt; both were
being read as doubt because they were shaped like warnings.

**And where a rule is wrong on spec grounds as well as practical ones, say
both.** "Withholding on absent availability contradicts `rfc.product_feeds.md`
§3.3 and §7" is a stronger justification than "it emptied the feed", and it is
the argument that survives someone disagreeing about the practical part.

### Where this bites next

Phase 3's mandate verification is this failure mode with the stakes raised —
every check is a withholding rule, and one that refuses too readily makes
agentic purchase impossible while looking like rigour. The Phase 1 fix does NOT
transfer: there the cautious default was wrong, but on the money path it is
right. The answer there is specificity, not looseness. See `DESIGN.md` §3.

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

---

## 2026-08-22 — Feed projection built before the normalizer, deliberately

**Not an obstacle — a sequencing decision worth recording**, because the
alternative is tempting and worse.

The obvious order is normalizer first, then project its output to ACP. Doing it
that way means every schema problem surfaces as a validation failure on model
output, where the cause is ambiguous: bad projection, bad normalization, or a
misread of the spec. Building the projection first against hand-written
internal records means the normalizer is written against a target that
provably validates, and any later failure is unambiguously the model's.

**Guard against a vacuous suite.** A conformance test that validates everything
is worth nothing, and it fails open — the suite stays green while the schema
silently does nothing. `tests/feed-projection.test.ts` therefore asserts that
the validator *rejects*: smuggled provenance (`additionalProperties: false`), a
variant missing its required `title`, a non-integer `Price.amount`, a lowercase
currency, and an empty `description` object. If the schema ever stops loading,
those assertions fail rather than the suite going quietly green.

**Also asserted:** no internal-only field name appears anywhere in the
serialized payload. That is a cheap, blunt check on the lossy-projection rule
from Decision 3 — it catches a leak that a field-by-field test would miss if
someone adds a field and forgets the test.

**ajv is currently a devDependency.** It is only used by the conformance suite.
`DESIGN.md` §2 says every *response* is validated against the schemas, so in
Phase 2 the same validator runs in the request path and ajv becomes a runtime
dependency. Flagged here so that move is a known step rather than a surprise.

**Small tooling note.** ajv ships CommonJS with `export =`; under
`nodenext` + `verbatimModuleSyntax` the runtime import works but TypeScript sees
a namespace rather than a constructor. Applied ajv's own documented ESM
workaround. Recorded only so the next person does not think the cast is
accidental.

---

## 2026-08-22 — "Any flag means needs_review" was wrong, and emptied the feed

**Hit.** Three tests failed the moment the normalizer ran end to end against a
real fixture. Root cause was one rule I had written into `normalize.ts` with a
confident comment — *"Any flag at all means a human looks at it. There is
deliberately no minor flag tier."*

`CURRENCY_ASSUMED` fires on any price written as a plain number. That is nearly
every row of nearly every small-merchant sheet. So under that rule every product
was `needs_review`, and **the feed was permanently empty**. The gate could never
be met, by construction.

**Why the rule was wrong, not just inconvenient.** It sounded like the cautious
choice and was the opposite, in two ways:

1. `CURRENCY_ASSUMED` is not a statement of doubt. This system is INR-only
   (`CLAUDE.md` invariant 6). There is no other currency the number could be.
   The flag records an assumption for the audit trail; it does not mean we are
   unsure what the merchant meant.
2. A review queue containing *every* product is a queue the merchant
   rubber-stamps. That destroys the check the queue exists to provide. Caution
   aimed at everything stops being caution.

**Fix.** Flags now divide by what they actually assert, in `flags.ts`:

- **Blocking** — *we are not sure this is right.* `MISSING_REQUIRED_FIELD`,
  `PRICE_AMBIGUOUS`, `PRICE_OUT_OF_BAND`, `CATEGORY_UNMAPPED`,
  `TITLE_INFERRED`. These withhold the record and send it to review.
- **Advisory** — *here is something we did, or something about the source.*
  `CURRENCY_ASSUMED`, `VARIANTS_SPLIT`, `MULTILINGUAL_SOURCE`. Carried on the
  record, shown in review, but they do not gate publication.

Each advisory case has its own reason, spelled out in `flags.ts` rather than
left implicit. `VARIANTS_SPLIT`: the splitting is deterministic and `splitList`
already refuses the case that could fabricate SKUs. `MULTILINGUAL_SOURCE`:
whether a Tamil reading is trustworthy is carried by the model's own
`confidence`, which is already thresholded — blocking on script alone would put
every row of a Tamil-speaking merchant's catalogue into review on the basis of
the alphabet.

**Second, quieter bug found by the same fix.** The projection built its withheld
`reason` by joining *all* flags, so a record held back for `CATEGORY_UNMAPPED`
was logged as `CURRENCY_ASSUMED,CATEGORY_UNMAPPED`. That reason code is false —
`CURRENCY_ASSUMED` withheld nothing. `CLAUDE.md` invariant 3 asks for a machine
reason code on every refusal, and a reason code that names a non-cause is worse
than none, because it will be believed. The reason now lists blocking flags
only.

**Worth noting about how this surfaced.** The rule read as principled and was
stated confidently in a code comment *and* asserted by a test I had written to
match it. What caught it was running the pipeline end to end against a fixture
built from real-world shapes — the plain-number price. A unit test written
against my own assumption agreed with the assumption.

**Generalised** into `CLAUDE.md` and `PHASE-1.md` §4: *tests derived from a rule
cannot falsify the rule — every rule needs at least one end-to-end assertion
against a fixture built from real-world shape, not from the rule.*

**Root cause was in the docs, not just the code.** `PHASE-1.md` §1 said "nothing
with `needs_review: true` is served" and listed `CURRENCY_ASSUMED` as a flag a
few lines later. The rule and the flag list were incoherent *together*, and each
looked fine alone. Worth remembering when reviewing a spec: the contradiction
was not inside any one sentence.

---

## 2026-08-22 — `CATEGORY_UNMAPPED` was defence in the wrong layer

**Hit.** Pushing the previous finding one rung further: is `CATEGORY_UNMAPPED`
correctly withholding?

**The problem.** Withholding every product the mapper cannot confidently place
makes that fraction of the catalogue invisible to agents. On real Indian
small-merchant sheets that fraction could be large. "The feed is missing half
your catalogue" is the same failure as the empty feed, one rung down.

**And withholding buys nothing.** The safety check already lives where it
belongs. Mandate verification matches on `category` only (`DESIGN.md` §3), so a
product whose category is `unmapped` can never satisfy a mandate carrying a
category constraint — refused at the payment gate *by construction*, not by a
rule anyone has to remember. That is `CLAUDE.md` invariant 2's layer. A mandate
with no category constraint accepts any category by definition, so serving an
unmapped product is correct there too.

**Underlying conflation, and the actual fix.** "Held for merchant review" and
"withheld from the feed" are different things, and I had collapsed them into one
boolean. That forces a bad trade: the only way to ask the merchant about a
product is to make it invisible to buyers first.

Flags now answer two independent questions, in three tiers:

| Tier | Flags | Served? | Queued? |
|---|---|---|---|
| Withholding | `MISSING_REQUIRED_FIELD`, `PRICE_AMBIGUOUS`, `PRICE_OUT_OF_BAND`, `TITLE_INFERRED` | no | yes |
| Review-only | `CATEGORY_UNMAPPED` | **yes** | yes |
| Advisory | `CURRENCY_ASSUMED`, `VARIANTS_SPLIT`, `MULTILINGUAL_SOURCE` | yes | no |

`TITLE_INFERRED` stays withholding: a fabricated title makes an agent buy the
wrong object, which is unrecoverable in the same way a wrong price is. The price
flags are not close to the line.

**Requirement pushed into Phase 3, and pinned by a test now.** Serving unmapped
products is only safe while the mandate category check treats `unmapped` as
matching *nothing*. If that check is ever written as "skip the category test
when the product is unmapped", this tier becomes unsafe and `CATEGORY_UNMAPPED`
must move back to withholding. `tests/normalize.test.ts` asserts the property
today so the requirement cannot quietly evaporate before the mandate layer
exists.

**A real bug fell out of fixing this.** Changing the test to flag one row of a
four-row variant group withheld the *entire product*, not one variant. Cause:
`normalizeSheet` took product identity from whichever row in the group was read
first, so one row with an inferred title condemned three siblings that were
named fine — and which row is "first" is an accident of sheet order. Product
identity now resolves to the best row in the group. This had nothing to do with
the flag tiers; it was found only because the tier change made the test
exercise a grouping path nothing had exercised before.

---

## 2026-08-22 — The normalizer no longer runs on Claude

**Why this needs saying at all.** This is a Razorpay Buildathon submission built
with Claude Code, and the catalogue normalizer runs on Gemini. A judge may
reasonably wonder why. The reason is mundane: **no Anthropic API key was
available for this project**, and `DESIGN.md` §6 had named Claude before that
was known.

**What changed.** Rather than swap one vendor name for another, the provider now
sits behind a seam — `lib/normalize/providers/`, injected into
`createExtractor`. Nothing outside that directory names a vendor.
`DESIGN.md` §6 and `CLAUDE.md` were updated to describe the seam rather than a
supplier. A provider is ~70 lines; adding Claude later is a file, not a
refactor.

**Why two candidates rather than one.** Groq and Gemini differ on an axis this
project specifically cares about, and guessing which way it falls would have
been guessing:

- **Groq** offers strict mode via **constrained decoding** — the schema
  restricts which tokens may be emitted, so invalid JSON and out-of-enum
  categories are *unreachable*, not merely unlikely. On guarantees, Groq is
  clearly stronger.
- **Gemini** offers `responseSchema`, an OpenAPI 3.0 subset with **best-effort**
  adherence. But it is a frontier model where Groq serves open weights, and the
  semantic work here — Tamil, transliterated Tamil, decomposing
  `Blk RunShoe M-9`, mapping into a fixed taxonomy — is exactly where open
  weights are weakest.

Stronger guarantee versus better semantics. The fixtures already discriminate.

---

## 2026-08-22 — Provider bake-off: real numbers

`npm run bakeoff`. Same prompt, same canonical schema, same rows, all providers.

**Sample size: n = 10 rows, 40 field observations per provider per run, 2 runs.**
Every figure below carries that n. At this size "100%" means *no failures
observed in 40 observations*, which is not the same claim as "does not fail" —
the 95% confidence interval on 40/40 still reaches down to roughly 91%. Do not
let a bare percentage from this table travel without its n attached.

The rows were chosen to discriminate rather than to flatter: the five
merchant-shorthand rows from `messy-05` and the five Tamil/transliterated rows
from `messy-07`.

| field (n=10 rows) | gpt-oss-120b | qwen3.6-27b | gemini-3.5-flash |
|---|---|---|---|
| title | 9/10 → 10/10 | — | **10/10** |
| category | 9/10 → 9/10 | — | **10/10** |
| title_inferred | 9/10 → 10/10 | — | **10/10** |
| colour | 5/5 | — | **5/5** |
| size | 5/5 | — | **5/5** |
| **overall (n=40 obs)** | **37/40, 39/40 (93%, 98%)** | **0/40 (0%)** | **40/40, 40/40 (100%, 100%)** |
| latency (10 rows, 2 calls) | ~7.0s | — | ~16.3s |
| conformance | constrained | constrained | best-effort |
| schema violations | none | n/a | **none** |

Two runs shown where they differed.

**Qwen never returned anything.** Every call failed with Groq
`400 json_validate_failed` and an empty `failed_generation`. That is a finding
worth keeping: **constrained decoding is model-dependent, not a property of the
platform.** A model that cannot satisfy the grammar fails the request outright.
Loud rather than silent, which is the right failure — but it is not the blanket
guarantee "Groq is constrained" implies.

**Every Groq miss was the same row:** `Vetti - Cotton`. It returned
`category: "unmapped"` in both runs, and in run 1 also `title: "White Cotton"`
with `title_inferred: true`. A vetti is a dhoti — everyday Tamil apparel. Under
our flag tiers that reading queues the product for review and, with
`title_inferred`, withholds it from the feed entirely.

**Gemini scored 40/40 in both runs**, including every Tamil row, and produced no
schema violation despite having no decoding guarantee. At n=40 that is "no
failures observed", not a demonstrated property.

### Decision: Gemini

The tie-break rule was "if it's close, take Groq — constrained decoding is a
better property than best-effort." That rule is right, and it does not apply
here, because this is not close on the axis that matters:

1. **The guarantee protected against a failure that never occurred.** Zero
   schema violations from Gemini across every run — though at n=40 that is
   weak evidence, and it is evidence of absence only at this scale. The
   property is real; its observed value here was zero.
2. **The semantic gap did occur, repeatedly and in the same place.** And that
   place is the transliterated-Tamil row — the exact demographic this project
   targets. "Half the Tamil catalogue is withheld or miscategorised" is not a
   rounding error here; it is the use case.
3. **Best-effort degrades safely in this codebase.** `parseExtraction`
   validates every provider's output against the canonical schema before
   anything downstream sees it, so a violation becomes a loud error rather than
   a silent bad record. That is what makes the weaker guarantee acceptable —
   not optimism about the model.

Groq is 2.3× faster. That did not weigh much: this is a batch ingest path, not
a request path, and 16 seconds for a catalogue is not a constraint.

**Reversal conditions, so this is a decision and not a preference.** Move to
Groq if the eval on a real sheet shows Gemini schema violations at any material
rate, or if Gemini's semantic lead does not survive real merchant data. The
seam makes it a one-line change and a re-run.

### Honest limits of this table

- **n = 10 rows / 40 field observations, synthetic.** These are our own
  fixtures, written by us. They measure which provider reads *our* mess cases
  better. They are **not** the §5 accuracy number, which needs a real sheet and
  50 hand-labelled products. `NORMALIZATION-EVAL.md` stays empty. Any figure
  quoted from this table must carry its n — a bare "100%" implies a property
  that 40 observations cannot establish.
- **One label was wrong on the first run.** Gemini returned `"Veshti"` for
  வேட்டி and was scored a miss, because the label only accepted
  `vetti|dhoti`. Veshti is the standard Tamil Nadu romanisation — the label was
  wrong, not the model. Corrected before the numbers above. Worth recording as
  the same failure mode as everything else in this file: a check written from an
  assumption, agreeing with the assumption.
- **The prompt was sharpened between the smoke test and the bake-off.** On the
  first real call, Groq set `title_inferred: true` for `Blk RunShoe M-9` and
  Gemini set `false`. The prompt said "true if the sheet had no usable product
  name" — ambiguous about whether shorthand counts as a name. Since
  `TITLE_INFERRED` withholds, that ambiguity was withholding an entire
  catalogue. The prompt now states explicitly that expanding shorthand and
  translating are not inferring. Both providers were then measured on the fixed
  prompt.


---

## 2026-08-22 — Normalization latency at catalogue scale, and the 5 RPM wall

**Question.** `~16s` was observed on a 5-row call. Per row or per call? The
upload flow cannot be designed without knowing: per row makes a 500-row sheet an
overnight job needing a queue; per call makes it a handful of requests the UI
can wait on.

**Measured** (`npm run latency`, gemini-3.5-flash):

| batch | ms | ms/row | output tokens |
|---|---|---|---|
| 10 | 10,959 | 1,096 | 1,724 |
| 25 | 26,031 | 1,041 | 4,406 |
| 50 | 30,590 | 612 | 7,858 |
| 100 | 50,673 | 507 | 8,411 |

10 → 100 rows is 10× the rows and 3.6–4.6× the time, **factor 0.36–0.46**. Cost
is dominated by the CALL, not the row. So batch aggressively — 507ms/row at 100
against 1,096ms/row at 10, better than 2×.

**Then the real wall.** Four parallel calls failed 200 of 500 rows with 429.
Dropping to concurrency 2 failed *all 500*. The cause was not concurrency
itself:

> `Quota exceeded ... limit: 5, model: gemini-3.5-flash`
> `GenerateRequestsPerMinutePerProjectPerModel-FreeTier`, quotaValue `5`

**Five requests per minute.** And critically, Gemini sends **no `Retry-After`
header** — the delay lives in the response body as
`google.rpc.RetryInfo { retryDelay: "19s" }`. Our backoff only read headers, so
it fell back to exponential backoff capped at four seconds, exhausted four
attempts inside a single sixty-second window, and failed everything. It looked
like a concurrency problem and was a *don't-read-the-error* problem.

**Fixes.** `providers/retry.ts` now parses `RetryInfo` from the body (and the
prose message as a last resort), and backoff can wait up to 70s — a rate-limit
window has to be outlastable. `DEFAULT_CONCURRENCY` is **1**: under an RPM cap
the scarce resource is requests, so parallelism only converts a queue into a
burst of 429s that the retry then serialises anyway, having wasted the attempts.

**Result: 300/300 rows, zero failures**, 200.9s wall clock — ~670ms/row
including rate-limit waiting, 1.5 rows/s.

### The constraint forced the right architecture

The temptation, on hitting 5 RPM, is to treat it as an obstacle to apologise for
— *"normalization is slow because we are on a free tier."* That reading is
wrong, and it would have led to worse code.

A synchronous upload was never correct. It only *looked* correct while the
catalogue was ten rows and the round trip was a second. What the rate limit did
was remove the option of finding that out later, in front of a merchant, with a
2,000-row sheet and a browser tab that had been open for twenty minutes.

What a correct ingest pipeline needs, at any tier:

| Requirement | Why it is not tier-specific |
|---|---|
| **Async job, not a request** | Any LLM-backed ingest over a real catalogue outlives an HTTP request. A paid tier moves the threshold; it does not remove it. |
| **Pollable progress** | A merchant watching an opaque spinner cannot tell "working" from "hung". They need row counts. |
| **Resumability at batch granularity** | Connections drop, deploys restart, tokens expire. Re-running a whole catalogue because batch 14 of 20 failed is wasteful at any price. |
| **Failed rows surfaced, not swallowed** | A batch that 429s must produce *flagged products*, not *missing products* — the same rule as every other unreadable input in this pipeline. |

Every one of those is what the free-tier cap made unavoidable. The convenient
architecture — `await normalize(sheet)` inside a POST handler — would have
passed every test we had, demoed fine on a fixture, and failed on the first real
catalogue.

`extractCatalogue` already supplies the library half: per-batch progress, and
failed rows returned with a reason rather than thrown. The job record, the poll
endpoint and resume-from-batch are the remaining Phase 1 persistence work.

**Numbers to plan against**, at the measured 1.5 rows/s:

| catalogue | wall clock |
|---|---|
| 100 rows | ~1 min |
| 500 rows | ~5.5 min |
| 2,000 rows | ~22 min |

**5 RPM is binding through submission.** This is a free-tier build and will not
be upgraded to paid, so these numbers are the real ones, not a temporary
embarrassment. `DEFAULT_CONCURRENCY` is one line and the seam is clean if that
ever changes — but nothing should be designed on the assumption that it will.

---

## 2026-08-22 — DECISION: the demo ingests a bounded subset, on purpose

**Follows directly from the rate limit.** At 1.5 rows/s a full catalogue is
minutes of wall clock. Whatever real sheet arrives, the submission video
**ingests a bounded subset** — on the order of 100 rows, about a minute — rather
than the whole thing.

**Not a dodge, and the README says so plainly.** Three reasons, in order of
importance:

1. **It is the honest thing to show.** A bounded run at measured throughput is
   the system's real behaviour. A pre-warmed cache or a pre-computed feed
   presented as a live ingest would not be.
2. **It demonstrates more, not less.** The interesting artifact is the *job* —
   progress advancing, batches completing, flagged rows landing in review, the
   feed appearing at the end. Twenty-two minutes of that is the same ninety
   seconds of information with twenty minutes of silence attached.
3. **The full-catalogue number is stated rather than performed.** "500 rows in
   5.5 minutes at 5 requests/minute" is a sentence. It does not need to be
   filmed in real time to be true, and filming it would not make it more true.

**What the video must not do:** present a subset as a full catalogue, or hide
that a limit exists. The cap and the reason for it are stated on camera and in
the README. A documented limitation is a strength; a quietly trimmed demo is the
thing this whole file exists to prevent.

---

## 2026-08-22 — Postgres provider: Neon over Supabase, for one concrete reason

**Prompted by** the question "why Supabase?" — and the honest answer was that
nothing in the repo used it. `grep` found "Supabase" only inside comments. The
dependency is `pg` plus a `DATABASE_URL`: no `supabase-js`, no auth, no RLS, no
realtime, no storage, no edge functions. The stack line said "Postgres via
Supabase" but the code said "Postgres".

**The deciding difference**, from each provider's own current pricing page
rather than memory:

| | Supabase Free | Neon Free |
|---|---|---|
| idle behaviour | *"Free projects are paused after 1 week of inactivity"* | computes suspend after 5 min, **auto-resume on next connection** |
| recovering from idle | manual restore in the dashboard | none needed |
| storage | 500 MB | 0.5 GB/project |
| compute | shared | 100 CU-hours/project/month |

Submission is 4 September and judging may happen days or weeks later. A paused
project does not read as "their free tier lapsed", it reads as **"their thing is
broken"** — and it is entirely avoidable. Neon's scale-to-zero has the same
cost profile without the manual step.

**Chosen.** Neon. Not because it is better software, but because its idle
behaviour matches how this artifact will actually be consumed.

**Cost of being wrong: one environment variable.** No code changed — the seam
was already a connection string, and the only edits were comments that named a
vendor the code never depended on. `CLAUDE.md` and `DESIGN.md` now say
"Postgres — any provider" with the current choice noted, which is what the code
already did.

**Correcting earlier advice.** I said to use Supabase's *session* pooler because
"the transaction pooler breaks explicit `BEGIN`/`COMMIT`". That reasoning was
wrong. A transaction-mode pooler pins a server connection for the duration of a
transaction — that is what transaction mode *is*. What actually breaks under it
is **named prepared statements** and session-level state (`SET`, `LISTEN`,
advisory locks held across transactions). `pg` uses unnamed statements unless a
query is given a `name`, and this codebase never does, so the pooled endpoint is
fine. Use Neon's pooled string; if anything behaves oddly, the direct endpoint
is the same URL without `-pooler`.

---

## 2026-08-22 — First live end-to-end run served ZERO products

**The run.** Real Neon, real Gemini, `messy-03` (14 rows), full pipeline: parse
→ job → extract → assemble → project → validate. Everything "worked":
`complete 14/14`, 12 products, 14 variants, ACP valid.

**Served: 0. Withheld: 26.** Every record, `MISSING_REQUIRED_FIELD`.

**Cause.** `messy-03`'s columns are `Category | Item | Price`. **There is no
stock column.** `parseStock(null)` returns `unknown`, the normalizer flagged
that `MISSING_REQUIRED_FIELD`, which withholds — so a sheet that does not track
stock produced an empty feed.

Most small-merchant sheets are PRICE LISTS. They have no stock column. This is
the `CURRENCY_ASSUMED` failure a third time: a condition true of a large
fraction of real sheets, silently emptying the feed, passing every test.

**Why the old behaviour was wrong on the spec too.** Both `Availability` fields
are OPTIONAL, and `rfc.product_feeds.md` §3.3 makes checkout authoritative over
feed data while §7 forbids agents treating feed availability as guaranteed.
Availability is a signal; the authority is downstream. Withholding for an absent
signal was defence in the wrong layer — the same diagnosis as
`CATEGORY_UNMAPPED`.

**Fix, part one.** `unknown` is published as ABSENCE: the `availability` key is
omitted rather than guessed into `in_stock`. That is the honest encoding of "we
were not told", it is spec-legal, and it asserts nothing false. Result: 12
served, 0 withheld, ACP valid.

**Fix, part two — found by looking at the fixed run.** With stock now
review-only, the run reported `review queue: 14 of 14`. The merchant's ENTIRE
catalogue queued, to tell them something they already know: their spreadsheet
has no stock column. That is the rubber-stamp failure, and catching it required
reading the output rather than the exit code.

Two different facts had been sharing one flag:

| | flag | tier |
|---|---|---|
| sheet has NO stock column | `STOCK_NOT_TRACKED` | advisory — a property of the SHEET, surfaced once, not per row |
| column exists, value unreadable (`-`, `??`) | `STOCK_UNKNOWN` | review-only — a real per-row uncertainty |

**The pattern, now three for three.** Every one of these was a condition common
in real sheets that a synthetic-fixture suite passed cleanly:
`CURRENCY_ASSUMED` (plain-number prices), `CATEGORY_UNMAPPED` (unmappable
products), and now stock. In each case the "cautious" rule was the harmful one,
and in each case the fix was to ask *what does this flag actually assert* rather
than *does it sound risky*.

**And it took a live run to find.** 160 tests were green. The gate is a real
sheet going in and a valid feed coming out — not a suite agreeing with itself.

---

## 2026-08-22 — The ingest endpoint created a concurrency hole in "exactly-once"

**Hit while writing the endpoint tests**, not by a failing assertion — two tests
went non-deterministic, and the reason was worse than flaky tests.

`runJob` selected batches with `status <> 'done'` and worked them. That is
exactly-once against **sequential** resume: a completed batch is never re-run.
It says nothing about **two runners at once**. Both would see the same batch as
pending, both would call the provider, and both would write. The data stayed
consistent — the write transaction guarantees that — but the second API call was
already spent, against a five-per-minute budget.

**I created the exposure in the same session.** `POST /api/ingest` is idempotent
by job id and starts the run in the background, so a double-click, a refresh or
a retried request starts a second runner on the same job. The guarantee was
written before the thing that could violate it existed.

**Fix: claim a batch with a conditional UPDATE.**

```sql
update ingest_batch set status = 'running', claimed_at = now()
 where job_id = $1 and batch_index = $2 and status in ('pending','failed')
returning batch_index
```

Postgres serialises the row write, so of N concurrent runners exactly one gets a
row back and the rest move on. No lock table, no advisory lock, no queue —
about fifteen lines, most of them the stale-claim clause.

**`claimed_at` exists for the crash case.** A runner that dies mid-batch would
otherwise park it in `running` forever, unreclaimable. A claim older than
fifteen minutes is treated as abandoned — comfortably longer than a 100-row call
plus a retry waiting out a rate-limit window.

**The check constraint immediately caught a second bug.** Claiming a previously
FAILED batch flipped `status` to `running` while leaving the earlier attempt's
`reason_code` attached, violating `only_failed_has_reason`. That constraint was
written for schema tidiness and turned out to be defending the audit trail: a
running batch carrying a stale failure reason is a record asserting a live
failure that is no longer true — the false-reason-code problem from earlier in
this file, arriving by a different route. Claiming now clears both reason
columns.

**Tested with three genuinely concurrent runners** against real Postgres,
asserting every row is extracted exactly once; plus a stranded-claim test and a
fresh-claim test.

**The general point.** "Exactly-once" was true of the code as written and became
false when a new caller appeared. A concurrency guarantee is a property of the
whole system, not of the function that implements it, and adding an entry point
is enough to invalidate one. Worth re-checking the same way when the MCP server
lands in Phase 4 and a third caller can start work.

---

## 2026-08-22 — Live: upload → job → poll → published feed

Full stack against real Neon and real Gemini, no fakes:

```
migrations: [ '002_job_sheet.sql', '003_batch_claim.sql' ]
POST returned in 1026 ms | job job_e1d17af855680546 | resumed false | status running
  poll: running 0/4 → complete 4/4
final: complete 4/4 | served by gemini-3.5-flash
feed published: 3 products, 4 variants
```

The POST returns in **one second** on a job that takes twelve — which is the
whole point of the job layer, and the thing a synchronous handler could not do.

**One design point confirmed by building it.** `assembleProducts` originally
took the parsed sheet as an argument, so a job could survive a restart in the
database and still be impossible to finish — the headers it needs to locate the
price and stock columns lived only in memory. Migration `002` stores the sheet
name and headers on the job. Resumability that depends on a process staying
alive is not resumability.

---

## 2026-08-22 — Audit for the (state, explanation) shape, before Phase 3 needs it

**Why now.** A false reason code has surfaced twice by different routes: a
withheld record logged with a flag that was not the cause, and a retried batch
still carrying its previous failure. Both were the same shape — **a STATE field
and an EXPLANATION field encoding one fact between them, updatable
independently, free to contradict each other.** Phase 3's audit log makes
reason codes load-bearing (`CLAUDE.md` invariant 3), so the shape was audited
deliberately rather than waited on.

**Found: one live instance of the same bug.** `runJob` set
`ingest_job.status = 'running'` at the start without clearing `reason_code`, so
a job that had failed and was being retried was RUNNING while still asserting
`INGEST_BATCHES_FAILED — 1 of 3 batches failed`. `GET /api/ingest/{jobId}`
exposes that field. Fixed, and forbidden in SQL by
`job_only_failed_has_reason` (migration 004), matching the batch constraint that
caught the first one.

**Found: two derived-vs-stored pairs, both currently consistent, now pinned.**

- `Normalization.flags` and `needs_review`. `needs_review` is stored rather than
  computed on read, so it is a second field encoding what the flags already say.
  It is only ever produced by `normalization()`, but nothing enforced that — a
  test now runs four fixtures through the pipeline and asserts
  `needs_review === needsReview(flags)` for every product and variant.
- `availability` and `inventory_count`. A positive count with `out_of_stock`, or
  a count attached to `unknown`, would be a contradiction. `parseStock` sets both
  together and cannot produce one; a test pins it across fifteen inputs.

**The rule this produces.** Where the two fields live in the database, forbid the
disagreement with a check constraint — every writer has to go through it, and
the constraint has now caught two bugs that code review did not. Where they live
in TypeScript, derive one from the other in a single function and assert the
agreement in a test.

---

## 2026-08-22 — `import.meta.dirname` is undefined once a bundler touches it

**Hit** on the first `next build`, after 184 green tests:

> `Failed to collect page data for /api/feeds/[feedId]/products`
> `TypeError: The "path" argument must be of type string. Received undefined`
> `at lib/feed/validate.ts:27` — `join(import.meta.dirname, "..", "..")`

The validator loaded the pinned ACP schema with `readFileSync` off
`import.meta.dirname`. That works under plain Node — which is the only way the
test suite ever runs it — and is undefined inside a Next route bundle.

**Fix.** Import the schema as JSON instead. No filesystem at runtime, and a
stronger pin: the schema becomes part of the module graph rather than a file
that must still exist at the right relative path when the route executes.

**Worth noting for the pattern collection.** The validator is one of the
most-exercised pieces of code in the repo, and no test could have caught this,
because every test runs it under Node. "Green suite, breaks in the real
environment" — the same shape as the others in this file, with the environment
rather than the data being the thing the suite did not vary.

---

## 2026-08-22 — Live over HTTP: `/upload` → job → feed

Real server, real Neon, real Gemini, `curl` rather than direct function calls:

```
GET /upload -> 200
POST /api/ingest -> job_0ab5a7e1649c9f85
  poll: running 0/4 → running 4/4 → complete 4/4
GET /api/feeds/feed_http/products -> 200, ACP-shaped
GET /api/feeds/nope/products -> {"type":"invalid_request","code":"feed_not_found",…}
```

First time the route handlers served over the network rather than being called
as functions. Nothing new broke, which is worth recording precisely because the
bundler bug above shows that "called as a function in a test" and "served by the
framework" are different environments.

---

## 2026-08-22 — PHASE 2 RECONCILIATION: Razorpay test mode vs DESIGN.md §2

Done before any implementation, the same way the ACP feed spec was reconciled in
Phase 1. Sources: Razorpay's live API docs, and ACP `2026-04-17`
`openapi.agentic_checkout.yaml` / `openapi.delegate_payment.yaml` /
`rfc.seller_backed_payment_handler.md`.

### What matches DESIGN.md, and needs no change

| Claim | Verified |
|---|---|
| Amounts are integer minor units | `POST /v1/orders` takes `amount` in "the smallest currency sub-unit" — ₹299 is `29900`. Matches invariant 6 exactly; no float ever crosses the boundary. |
| Test mode is real and separate | Test keys, test cards, and webhooks that fire on test-mode transactions with an identical payload shape to live. Invariant 5 holds without special handling. |
| Order webhooks with HMAC signature | `X-Razorpay-Signature` = HMAC-SHA256 over the **raw request body**, keyed by the **webhook secret**. |

### Mismatch 1 — "Idempotency keys on all mutating calls" is not available

DESIGN.md §2 lists idempotency keys as a cross-cutting requirement. **Razorpay
supports `Idempotency-Key` on Payout APIs only** — the documentation for it sits
under *Payout APIs → Payout Idempotency* and says "for **payout** API requests".
Orders and Payments have no equivalent header.

*Consequence.* A retried `POST /v1/orders` creates a SECOND order. Under
invariant 4 (capped retries on transport failure) that is exactly the path we
will exercise.

*Resolution.* We own idempotency instead of delegating it: a table keyed on the
ACP `Idempotency-Key` storing the resulting `razorpay_order_id`, checked before
any call. Razorpay's `receipt` field (unique, ≤40 chars) carries our key so the
two can be reconciled from their dashboard. This is the same shape as the batch
claim in the ingest layer — a conditional insert, not a lock.

*Amend DESIGN.md* to say idempotency is enforced by us, not by the PSP.

### Mismatch 2 — the delegated-payment framing is wrong, and the real reason is stronger

DESIGN.md §2 says: *"Razorpay is not a Delegated Payment Spec–compatible PSP."*

That is not what the spec says. `openapi.delegate_payment.yaml` declares
`servers: https://merchant.example.com` — **the MERCHANT implements
`POST /agentic_commerce/delegate_payment`**, not the PSP. Its job is to accept a
raw card credential (`number`: "FPAN/DPAN/network token/virtual PAN") and return
a vault token the merchant's own PSP can charge within an `Allowance`.

So the blocker is not vendor compatibility. **Implementing that endpoint means
raw card numbers land in our infrastructure, which is PCI DSS scope.** That is a
categorical no for a buildathon build, and it is a much better reason than the
one currently written down — it is a decision, not a limitation.

### Mismatch 3 — DESIGN.md predates the PaymentHandler abstraction

§2 was written against an older spec. At `2026-04-17`, `PaymentData` is no longer
a bare shared payment token:

```
PaymentData: { handler_id, instrument: { type, credential: { type, token } }, … }
Capabilities.payment.handlers[] -> PaymentHandler {
  name (reverse-DNS), psp, requires_delegate_payment, requires_pci_compliance, … }
```

There is also `rfc.seller_backed_payment_handler.md` — `dev.acp.seller_backed.*`
— for payment options "managed and resolved entirely on the seller's backend
without transferring credentials to the agent", explicitly
`requires_pci_compliance: false`.

*This is materially better news than DESIGN.md assumes.* Instead of "the
delegated payment interface is implemented against our own handler, the single
largest deviation from spec", we can **declare a handler**, which is the
spec's own extension point. Proposed:

```json
{ "name": "in.agentready.razorpay_payment_link",
  "psp": "razorpay",
  "requires_delegate_payment": false,
  "requires_pci_compliance": false }
```

Honest about what it is: a non-registered handler under our own reverse-DNS
name, where the credential token is a Razorpay reference rather than a card.
`dev.acp.seller_backed` itself does not fit — it still sets
`requires_delegate_payment: true`, so it routes through the endpoint we are
declining to implement.

That converts the largest deviation from *"we did not implement the payment
spec"* into *"we declared a handler the spec has a slot for, and did not
implement delegate_payment, because PCI"*. Smaller, and precisely stated.

### Mismatch 4 — no server-to-server card payment exists

The bigger practical constraint, and the one that shapes the whole leg.
Razorpay's standard flow collects card details in a **browser Checkout widget**;
the server only creates the Order beforehand and verifies afterwards.
`razorpay_signature` = HMAC-SHA256(`order_id|payment_id`, `key_secret`) is
computed *by the browser handler*. S2S exists but is **Third-Party Validation
for BFSI** (securities, broking, mutual funds) — not a general server-only card
API.

**An agent cannot complete a card payment purely server-to-server.** Any design
where our `POST /checkout_sessions/{id}/complete` charges a card directly is
fiction.

What *is* server-creatable: **Payment Links** (`short_url`) and **QR codes**.
Both produce a URL a human opens. That is the honest agentic shape — the agent
gets the session to `ready_for_payment` and hands back a link; a human completes
it; the webhook moves the order to paid. It also matches the project's premise:
the merchant's payments are already a Razorpay link.

### Failure behaviour worth designing for now

- Payment states: `created → authorized → captured`, or `failed`. Order:
  `created → attempted → paid`, with an `attempts` counter.
- **Late authorisation is real** — Razorpay documents "Manage Late Authorised
  Payments". A payment can be authorised *after* we have given up and marked a
  session failed. Phase 5's drift path must therefore treat a terminal session
  as terminal *for us* while still reconciling a later webhook, rather than
  assuming failure is final. This interacts with invariant 4: it is a case where
  not retrying is correct and the state still changes underneath us.
- Webhook ordering is not guaranteed; Razorpay's own docs point at idempotency
  and event ordering. Our handler must be idempotent per `event.id`.

### Practical blocker for testing webhooks

Razorpay **cannot deliver webhooks to localhost**, and blacklists most tunnels:
`ngrok.io`, `loca.lt`, `webhook.site`, `requestbin.com`, `beeceptor.com`,
`hookbin.com`, `mockbin.org` are all refused. Their recommendation is **zrok**.
Test-mode webhook setup also prompts for OTP `754081`.

Plan around it: the webhook handler is written as a pure function over
`(rawBody, signature, secret)` and tested directly with fixtures, so correctness
does not depend on tunnelling. A tunnel is then needed only once, to prove
delivery — which is the Phase 1 lesson about environments applied in advance.

### Sequence

Checkout sessions and authoritative cart state first — pure ACP, no Razorpay,
no payment. That half is fully specified and testable today. The payment leg
last, because every open question above lives in it.

---

## 2026-08-22 — "Authoritative" needs two storage locations, not one

Building checkout sessions surfaced a structural point that is easy to get
wrong and impossible to fix later.

`rfc.product_feeds.md` §3.3 says feed data is a **signal** and the checkout
response is **authoritative**. If checkout prices carts by reading the published
feed artifacts, that sentence is decoration: both sides read the same bytes, so
they can never disagree, and Phase 5's drift scenario — agent quotes ₹2,799,
checkout says ₹2,999 — would have to be *faked* in a test rather than produced.

So there are now two stores. `catalog_variant` is the live truth that checkout
reads at request time; the feed artifacts are a snapshot taken at publish. Drift
becomes a real state of the system (`setPrice` moves one and not the other) and
the Phase 5 path can be demonstrated rather than simulated.

The same reasoning applies to retrieval. `GET /checkout_sessions/{id}`
**re-prices from the catalogue** rather than replaying the stored snapshot,
because a GET that returns a price we no longer honour is exactly what "checkout
is authoritative" is supposed to rule out. Terminal sessions are the deliberate
exception: a completed or cancelled session is a historical record and must not
change under a reader. A test moves the price by ₹4,100 under a cancelled
session and asserts it does not budge.

---

## 2026-08-22 — The checkout schema rejected six things I believed were right

`CheckoutSessionBase` requires more than reading the prose suggests:
`id, status, currency, line_items, totals, fulfillment_options, messages, links,
capabilities` — and `LineItem` requires its OWN `totals` while both it and
`Item` set `additionalProperties: false`.

My first session object had none of `fulfillment_options`, `links` or
`capabilities`, gave line items no `totals`, and carried a convenient
`total_amount` on each line that is simply not a LineItem field. Six violations,
all caught by validating a real session against the pinned schema — none of
which careful reading had caught, because I had read the OpenAPI's *property
list* and not its *required list*.

`PaymentHandler` then required five more: `version`, `spec`, `config_schema`,
`instrument_schemas`, `config`. Two of those are `format: uri` and the project
has no published domain, so they point at a placeholder that is **declared as a
placeholder in the code** and must be repointed before submission. A required
URI field cannot be omitted; the choice was between an honest placeholder and a
plausible URL that quietly 404s.

**One real bug fell out of the same run.** A test asserting that an unpriceable
cart totals zero failed with `5250`: with no line items the subtotal is 0, which
is below the free-delivery threshold, so the flat ₹50 applied and 5% tax was
charged on it. **An empty cart was billing ₹52.50 of delivery and tax on
nothing.** The threshold rule had been written for a cart that exists.

---

## 2026-08-22 — A near-miss: ajv's strictness is not the spec's

Worth recording because I nearly wrote down a false finding.

Compiling the checkout schema threw:
`strict mode: required property "token" is not defined at "#/anyOf/0"`. My first
reading was "another defect in the published schema", which would have gone into
this file next to the genuine `UpsertProductsResponse` gap from Phase 1.

Checking first showed the opposite. The construct is:

```json
"anyOf": [ { "required": ["handler_id", "instrument"] },
           { "required": ["purchase_order_number"] } ]
```

That is valid, idiomatic JSON Schema for "one of these must be present", with
the shapes defined on the parent. `strictRequired` is an **ajv lint** that
assumes every `required` sits beside its own `properties` — a style preference,
not a rule. The schema is fine; our validator configuration was wrong.

Disabling that one lint makes the validator accept the schema and changes
nothing about how strictly it validates data. Recorded because the false version
would have been believed: a note in this file saying "the ACP checkout schema is
malformed" is exactly the kind of confident wrong statement the false-reason-code
entries are about, just aimed at someone else's work instead of our own.

---

## 2026-08-22 — ACP `Item` has no `quantity`, and its own description says it does

Building `POST /checkout_sessions` against the pinned schema turned up a
contradiction inside a single definition.

`schema.agentic_checkout.json` `$defs.Item`:

```json
{
  "description": "A purchasable item with variant options (e.g., size, color) and quantity",
  "additionalProperties": false,
  "properties": { "id": {...}, "name": {...}, "unit_amount": {...} },
  "required": ["id"]
}
```

The description promises **quantity**. The properties do not contain it, and
`additionalProperties: false` forbids adding it. So `{"id": "x", "quantity": 2}`
— which is exactly what `rfc.product_feeds.md` §4.3's own worked example sends —
**fails validation against the checkout schema of the same dated release.**

Unlike the ajv `strictRequired` case a few entries up, this one is not a
misreading on our side. It is checkable in one object: description and
properties disagree, and the RFC example contradicts the schema.

**Resolution: follow the schema, because the schema is what validates.**
Quantity is expressed by REPETITION — two of a thing is the id twice — and
`aggregate()` folds repeats into a quantity. Asking for the same variant twice
means two units, not two carts.

Recorded rather than worked around silently, because an agent built from the
RFC example will send `quantity` and get a 400, and whoever debugs that deserves
to find this note.

**Second thing the same exercise found**, less interesting but more embarrassing:
`CheckoutSessionCreateRequest.required` is `["line_items", "currency",
"capabilities"]`. I had built a create handler that demanded none of them,
because I read the property list rather than the required list — the same
mistake as the six session-shape errors two entries up. Reading a JSON Schema
means reading `required` first.

---

## 2026-08-22 — Live over HTTP: checkout sessions

Real server, real Neon, `curl`:

```
POST /checkout_sessions  (no Idempotency-Key)  -> idempotency_key_required
POST /checkout_sessions  (id twice, qty 2)     -> ready_for_payment, unit 65000
   totals: items 130000, subtotal 130000, delivery 0, tax 6500, total 136500
   handler: in.agentready.razorpay_payment_link
POST same key, same body                       -> 201, Idempotent-Replay: true
POST same key, DIFFERENT body                  -> idempotency_conflict
GET  /checkout_sessions/{id}                   -> 200
POST /checkout_sessions/{id}/cancel            -> canceled
```

Delivery is 0 because the cart crosses the ₹1,000 free threshold, and the total
equals its own components. The quantity of 2 came from repeating the id, which
is the reading forced by the schema above.

---

## 2026-08-23 — Reading the payload beats reading the docs: five findings no careful reading produces

Built the Razorpay webhook first, ahead of `POST /checkout_sessions/{id}/complete`,
because it is the only endpoint an unauthenticated stranger can call and a
security boundary that waits for the deadline gets the attention a deadline
allows. The signature check is a pure function over `(rawBody, signature,
secret)`, so it is exercised without a database, a live PSP, or a payment.

**This entry is the fixtures rule paying off in a domain it was not written
for.** The rule came out of spreadsheets — *fixtures are written from observed
real-world data, before the code that parses them* — and the reason it earns its
place in `CLAUDE.md` is on display below: five findings, and **not one of them is
available by reading the documentation carefully.** They are only available by
looking at what the system actually emits.

The prose says the event has an id. It does — in a header, with nothing in the
body. The prose describes `notes` as a key-value map. It is, in one of the three
real samples; in the others it is an empty array and a null. The prose says
`expire_by` is a timestamp. It is, except when it is `0` meaning unset. No amount
of care applied to the sentences produces any of that, because the sentences are
not wrong — they are *incomplete in ways only the artifact reveals*. Careful
reading produces a parser that agrees with the documentation, and the
documentation is not what will be sent to us at 3am.

The payloads were therefore transcribed verbatim from Razorpay's published
samples into `fixtures/razorpay/` **before the parser existed**. What that bought:

1. **The event id is not in the body.** It is the `x-razorpay-event-id` HEADER.
   None of the three real payloads carries an `id` or `event_id` field at all.
   Any deduplication scheme keyed on something inside the payload is keyed on
   the wrong thing, and the obvious fallback — the payment id — is wrong in the
   other direction, because several distinct events reference one payment. There
   is a test asserting the absence, so this cannot quietly regress.

2. **`payment_link.entity.order_id` is `order_QflczVVaNJciLq`, and
   `payload.order.entity.id`, in the same payload, is `QflczVVaNJciLq`.** The
   prefix is present on one and absent on the other. `===` between them never
   matches. Canonicalised by MATCHING `/^(?:[a-z]+_)?([A-Za-z0-9]+)$/` and taking
   the capture, not by stripping the prefix — stripping is subtraction and would
   cheerfully turn an unanticipated `order_order_x` into a plausible wrong id.

3. **`notes` appears as `[]`, as `null`, and as an object across the three
   samples.** An empty PHP-ish array where a map is documented. Any code reaching
   `notes.acp_session_id` would be reading a property off an array on the most
   common path. Our session id therefore travels in `reference_id`, which is also
   what surfaces as the order's `receipt` — the field DESIGN §2 already
   reconciles idempotency through.

4. **`expire_by` and `expired_at` are `0` when unset**, not null and not absent.
   Zero is not 1 January 1970 here; it means "no value".

5. Razorpay's docs are explicit that the body must not be parsed or cast before
   signing. There is a test that signs a `JSON.parse` → `JSON.stringify` round
   trip of the fixture and asserts verification FAILS. That failure mode is
   nasty precisely because it is safe-direction — it rejects every genuine event
   while accepting no forged one — so it looks like a Razorpay problem at 2am and
   gets "fixed" by disabling the check.

**Idempotency reuses `idempotency_record`**, keyed `(x-razorpay-event-id,
'razorpay_webhook')`. No new table: the conditional INSERT that arbitrates
concurrent checkout retries arbitrates concurrent webhook redeliveries, and it
is already raced by a test. Four concurrent redeliveries produce exactly one
non-duplicate.

### A sixth finding of the same shape, from a different layer

`SessionStatus` in `session.ts` listed five states; the database check
constraint carries the full ACP enum. Adding `expired` to `isTerminal()` made
`status === "expired"` a **type error in three files** — TS2367, "these types
have no overlap" — because the union did not contain it. Every test had passed:
types are erased at runtime, and PGlite accepted the string happily.

This is not a separate lesson from the five above. It is the same one seen from
the layer axis rather than the data axis, and it joins a family this project now
has three members of:

| What was held constant | What varied it | What it found |
|---|---|---|
| the data (fixtures we authored) | real published payloads | five parse assumptions |
| the runtime (plain Node) | `next build` | `import.meta.dirname` undefined in a bundle |
| the checker (the test runner) | `tsc --noEmit` | a state with no name in the type |

Every one of them was green before it was varied. **The question that finds
these is not "is there another test to write" — it is "what does every existing
test hold constant".** More tests along the same axis would have found none of
the three.

### Verified live over HTTP against Neon

`next dev`, real server, real database, the fixture as the request body:

```
valid signature + event id     -> 200 {"duplicate":false,"outcome":"observed","reason_code":"SESSION_UNKNOWN"}
same event id again            -> 200 {"duplicate":true,  ...}
signature "deadbeef"           -> 401 invalid_signature
no signature header            -> 401 invalid_signature
valid signature, no event id   -> 400 missing_event_id
body tampered after signing    -> 401 invalid_signature
signature over re-serialised   -> 401 invalid_signature
```

`SESSION_UNKNOWN` is correct: the fixture's `reference_id` is `23`, and no such
session exists in Neon. An event naming a session we do not have is an
observation and a 200 — a 5xx would make Razorpay redeliver forever an event
that will never mean anything different.

**Still untested, and stated rather than implied: no traffic from Razorpay has
ever hit this endpoint.** The fixtures are their published samples, not captures
from our own account. Live delivery is unverified until a test-mode payment is
actually made, which needs `complete` first.

### `next dev` writes to CLAUDE.md

Next 16 appends a `<!-- BEGIN:nextjs-agent-rules -->` block to `CLAUDE.md` on
every `next dev`, from `generate-agent-files.js`. It is a real Next feature, not
a corruption, but it means the project's instruction file has a second author.
Stripped from this commit; it returns on the next `next dev` unless
`agentRules: false` is set in a `next.config`, which this repo does not yet have.
Noted because a block of instructions appearing in CLAUDE.md that nobody on the
team wrote deserves to be a decision rather than a surprise.

Also added `dev` and `build` scripts, whose absence meant `npm run build` — the
one check that runs the code in the bundler it ships in — was not runnable.

---

## 2026-08-23 — `complete`: one API call, not two, and a 502 that only a real request could find

### A Payment Link creates its own order

DESIGN.md §2 said `complete` "creates a Razorpay order and a payment link".
Building it showed that is not a thing the API does. **A Payment Link creates its
own order**, and the create request takes no `order_id` — so "create an order,
then create a link for it" produces a second, unrelated order that nothing ever
pays, and two ids to reconcile where there should be one.

The order id is not in the create response either. It arrives with the webhook,
as `payload.order.entity` — which is why `razorpay_order_id` is nullable in
`migrations/006_payment_link.sql` and stays null until someone pays.

So `complete` makes exactly one call. DESIGN.md §2 corrected in the same commit,
because a design document that describes a flow the API cannot perform is worse
than no design document.

### `links[]` cannot carry the payment URL

The obvious place to return a payment link is the session's `links` array. It
cannot go there: `Link.type` is a **closed enum of policy pages** —
`terms_of_use`, `privacy_policy`, `return_policy`, `shipping_policy`,
`contact_us`, `about_us`, `faq`, `support` — with `additionalProperties: false`.
There is no `payment` member and no room to add one.

It goes in `order.permalink_url` on a `CheckoutSessionWithOrder`, and `order.id`
is the Payment Link id, because at that moment the link is the only object that
exists in Razorpay. The response is validated against `CheckoutSessionWithOrder`
rather than `CheckoutSession` — the latter would pass a response with no order
in it at all.

### The 502 that swallowed every refusal

`complete`'s route called `completeSession(sql, id, body, razorpayClient())`.
`razorpayClient()` validated `RAZORPAY_KEY_ID`/`RAZORPAY_KEY_SECRET` at
construction and threw when they were missing. The throw is in the **argument**,
so it happened before any policy ran — and on a machine with no Razorpay keys,
which is this one:

```
wrong handler_id  -> 502 payment_link_unavailable   (should be 400)
out of stock      -> 502 payment_link_unavailable   (should be 409)
cancelled session -> 502 payment_link_unavailable   (should be 409)
```

Every refusal came back as "could not create a payment link", which is wrong
about what happened and wrong about whose fault it is. An agent debugging its own
malformed `payment_data` would have been told the seller's PSP was down.

**Twenty-six unit tests did not see it**, and could not have: the fake client
never throws, and the failure was in constructing the real one. One real HTTP
request found it immediately. Fixed by moving the configuration check inside
`create()`, where it fires only on the path that actually needs a key — and the
regression test now uses a client whose `create` throws, which is the thing the
old fake could not express.

This is the same family as the three in the entry above, and the fourth member of
it: **the suite held the client constant.**

### An unresolved idempotency claim wedges the key forever

The claim is inserted with `response_status = 0` and updated when the response is
known. If the Razorpay call throws, nothing updates it — and every retry of that
key then reads status 0 and returns `idempotency_in_flight`. The request wedges
itself permanently, which is a worse failure than the one it is reporting.

Resolved by committing the 502 into the record rather than releasing it. A retry
with the same key replays the 502; a genuine new attempt takes a new key, which
is what invariant 4 means by no blind retry. Releasing the claim instead would
have allowed a second link if the first call had in fact succeeded before the
failure.

### A GET was resetting `complete_in_progress` back to `ready_for_payment`

`getSession` re-prices on every read and persisted `priceCart`'s status. That
status is computed from the catalogue alone, so for a session with a live payment
link it is `ready_for_payment` — and a plain GET during the pending window
quietly un-completed the session, after which a second `complete` was allowed.

Prices refresh on read; **the lifecycle status is not the catalogue's to set.**
Found by a test asserting a GET in the pending window, not by reading the
function — the read path had been correct for every status that existed when it
was written.

`updateSession` had the same shape of hole and now refuses with
`session_pending_payment`: editing a cart under a live link would leave a payable
URL at an amount the cart no longer agrees with.

### Verified live over HTTP against Neon

```
create session                          -> 201 ready_for_payment, total 73500
complete, handler dev.acp.tokenized.card-> 400 unsupported_payment_handler
complete, no payment_data               -> 400 invalid_request ($. param)
complete, handler razorpay_link         -> 502 payment_link_unavailable
complete, same Idempotency-Key again    -> 502 replayed (not wedged in_flight)
complete, out-of-stock cart             -> 409 session_not_ready_for_payment
cancel, then complete                   -> 409 session_terminal
```

The 502 on the correct handler is the honest result on this machine: **there are
no Razorpay keys in `.env`, and there never have been.** Which means the part of
`complete` that spends money — the Payment Link create request — **has never
run.** Its request body is an assumption, not code. Everything up to it is
verified; the call itself is not, and no green suite here should be read as
saying otherwise. It needs a test-mode key before Phase 2's gate is met.

---

## 2026-08-24 — The first real Payment Link create: `customer: {}` is a 400

Test-mode keys finally exist, so the one call in this project that spends money
ran for the first time. It failed on the first attempt:

```
400 BAD_REQUEST_ERROR
"incorrect JSON object received - faulty key: customer"
```

`razorpayClient()` sent `customer: request.customer ?? {}`. ACP gives us no
buyer contact details, so `request.customer` is undefined on **every** request
`complete` makes — meaning that `?? {}` sent an empty object every single time,
and **every live payment link create would have failed.** Not an edge case: the
only case.

The field must be **absent**, not empty. Fixed by spreading it conditionally.

### The SDK's type is what caused the bug

`node_modules/razorpay/dist/types/paymentLink.d.ts:46` declares:

```ts
customer: Pick<Customers.RazorpayCustomerCreateRequestBody, 'name' | 'email' | 'contact'>;
```

Required. No `?`. The API rejects that field unless it has content, and the
type demands it be present — so `?? {}` was not carelessness, it was the
shortest way to satisfy a type that is wrong about its own API. Omitting the
field now needs a cast, which is annotated at the call site: the body is
correct and the type is the mistaken party.

### Why no test could have caught it, and what replaces them

`fakeClient` receives a `PaymentLinkRequest`. The defect was in translating
that into the body Razorpay is sent, which happens *inside* `razorpayClient()`
— the exact function any substitute replaces. **282 tests were green.** No
number of them along that axis would have found this, for the same reason the
four entries above were invisible: the suite holds the client constant.

What replaces them is `npm run smoke:link` — one real create against test mode,
outside `npm test` because it needs keys and the network, on the
`scripts/smoke-extract.ts` precedent. It is the only thing in the repo that
can fail on this.

### Phase 2's gate

```
npm run smoke:link -> plink_TTQ12h9IwrTd9Q  https://rzp.io/rzp/hQi55cYB  created
```

The Payment Link create is no longer an assumption. `complete` end-to-end over
HTTP, and live webhook delivery from Razorpay's own servers, are still not —
both are next, and the webhook needs a public URL before it can be tried.

---

## 2026-08-24 — The first real merchant sheet broke header detection, and the scorer hid it

TRANSCRIBING.md Route B: 78 products transcribed from one Chennai seller's
public IndiaMART listing. IndiaMART serves a stripped page to signed-out and
automated sessions — three URL patterns returned four unrelated t-shirt
suppliers for "cotton saree" — so the transcription was done through a
signed-in browser. That detail matters only because it is *why* every cell in
the resulting sheet is text.

### `hasNumeric` tested the cell's type, not its content

`detectHeader` required the row after a candidate header to contain a numeric
cell, and `hasNumeric` was `typeof cell.value === "number"`. This sheet has no
typed number anywhere: the price reads `₹ 57/Pack`, the pack size `150 g`, the
shelf life `60 Days`. So no row could ever satisfy the test, the header row
`Category | Product | Price | Pack Size | Shelf Life` was read as data, and
every column came back `col_1..col_5`.

**Two things were tangled here and they separate cleanly.**

The first is a real defect, independent of where the sheet came from: a
merchant formatting a price column as text is completely ordinary, and
`₹ 57/Pack` is as numeric a price as `57`. Testing the cell's *type* was wrong
on its own terms. Fixed by testing for digits in the text.

The second is our own contamination, stated rather than hidden: this sheet is
all-text partly because it was transcribed from a web listing rather than
opened from a merchant's Excel file. A shopkeeper typing prices into a
spreadsheet would often produce typed numbers.

The honest sequence was to fix the detector and re-run against the sheet
**unchanged** — not to edit the data until the code passed. It now finds the
header at row 4 with the merchant's own names and 78 product rows. *The fixture
was fine and the detector was broken.*

`messy-11-all-text.xlsx` locks it down, because the real sheet cannot be
committed. Cases 01–10 all carry typed numeric prices, so not one of them could
express this — the suite held the cell type constant.

### The scorer omitted a field it could not find, and said nothing

Worse than the missing number. `eval` locates the price column by matching the
raw key against `/price|rate|mrp|amount|விலை/`. With `col_N` keys nothing
matched, so `price_parsed` scored **zero rows** — and the published table would
simply not have had a price line. No error, no warning, a clean-looking
accuracy figure missing the one field where being wrong costs money.

A scorer that silently drops a field it cannot locate will do it again on the
next fixture. Fixed as a **refusal**, not a patch: any labelled field that
scores zero rows aborts the run. That is the third such guard in this script,
and the fifth time on this project that the failure signature has been *green,
nothing checked*.

### `PRICE_AMBIGUOUS` is the correct answer, not a number

Seven rows quote a kilo rate beside a sub-kilo pack — `₹ 57/Kg` on a 150g pack,
`₹ 100/Kg` on 250g of adhirasam. That is either ₹57 for the pack or a kilo rate
the pack does not state, and **the sheet does not choose**. Scoring a number
there would be scoring a guess and rewarding a confident wrong answer.

Labels gained a `price` field that accepts `"ambiguous"`, and those rows are
scored on whether the pipeline raises `PRICE_AMBIGUOUS` — a flag the taxonomy
already had — rather than on what it computes. The old check was
`amount_minor > 0`, which passes for a confidently wrong price.

### Labels: twenty rows that could not fail

The first pass accepted several alternatives per row — `["Pepper Kara Sev",
"Kara Sev"]`, `["Raggi murukku", "Ragi murukku"]`. Both halves are wrong for
the same reason: a shorter alternative lets the pipeline drop a qualifier for
free, and accepting a typo *and* its correction means the row cannot fail.
Twenty unfailable rows inflate the number.

All collapsed to one label, always the seller's own wording. Normalization is
not spell-correction: silently turning `Raggi` into `Ragi` takes the merchant's
product name away from them. Shorthand expansion is different and stays
required — `spl` → `Special` — consistent with the rule already settled in the
`title_inferred` prompt.

### Known weakness of this fixture

Every row maps to `food`. Category accuracy from this sheet will read near
perfect and measure nothing, because the taxonomy has no finer bucket for a
snacks catalogue. It should not be headlined, and it is a direct argument for a
second sheet from a different trade.

---

## 2026-08-24 — Three products, one checkout id: the eval found a buy-path defect

The 95% run's title failures split into two families that turned out to be one
bug, and the second family was not a naming problem.

### Sixteen title misses, one cause

Six were the model respelling the merchant — `Ragi` for `Raggi`, `Moong Dal`
for `Moong dhall`, `Jackfruit` for `Jack Fruit`, `Omapodi` for `Oma podi`. Ten
were it dropping a distinguishing word — `Sesame Chikki` for all three of
`Black Sesame Chikki`, `White Sesame Chikki` and `White Til Chikki`; `Banana
Chips` for all three banana rows; `Potato Chips` for two different chips.

Both are the model deciding it knows better than the merchant, and both came
from one prompt line: *"the product name a buyer would recognise"*, plus a
Tamil instruction to *"return the title in English"* that licensed re-spelling
Latin-script transliterations. Rewritten as a single rule — reproduce the
merchant's wording, expand shorthand only, never drop a distinguishing word.
**All sixteen fixed: `title` 62/78 → 78/78.**

### The collapse reached `stableId`, which is the real defect

Identity was `stableId("var", merchantId, variant_group ?? extraction.title,
optionSignature)` — hashed from **the model's title**. Three rows titled
`Sesame Chikki` therefore produced ONE variant id:

```
row 49  var_60612ea51469678b | Black Sesame Chikki
row 50  var_60612ea51469678b | White Sesame Chikki
row 51  var_60612ea51469678b | White Til Chikki
```

`Variant.id` is the ACP `items[].id`. An agent that referenced that id
referenced three products, and a Phase 3 mandate issued against it would
authorise a purchase nobody can identify. **That is worse than mislabelling:
mislabelling is visible, this is an agent buying white sesame when it asked for
black.**

The prompt fix makes the titles distinct again, and is not sufficient. Identity
that depends on the model wording a title the same way twice will collide again
the next time the prompt changes. Identity now comes from the merchant's own
cells, with price, list price and stock excluded — repricing an item must not
mint a new id.

The regression test asserts the property under a DELIBERATELY collapsed title,
because a test that assumes the model behaves cannot catch the model
misbehaving.

### The dedup half was caught by the test, not by reading the code

First attempt hashed the cells verbatim. `messy-09`'s duplicates are
cross-sheet and differ in case — `Canvas Shoe White` on one sheet, `canvas
shoe white` on the other, and Kolhapuri at 650 on one and 675 on the other.
Verbatim bytes split them into different products. Case-folded and
whitespace-collapsed now; price was already excluded, so the reprice is fine.

My first version of that test was also wrong — it read only sheet one, where
all three rows are genuinely different products. The failing test was correct
about the code and wrong about the fixture.

### `PRICE_AMBIGUOUS` 0/7 — still open, and the clearest evidence for the eval

Seven rows quote a kilo rate beside a sub-kilo pack. The pipeline raises
`PRICE_AMBIGUOUS` on **none** of them; it produces a confident number and flags
only `STOCK_NOT_TRACKED`. `₹ 100/Kg` on 250g of adhirasam became a price.

**Under the previous check — `amount_minor > 0` — all seven scored correct.**
A weak metric did not merely miss this defect, it actively reported it as
passing. That is the whole argument for the label change, and it is the one
open defect on the money path. Not fixed here; named rather than buried.

### Published numbers

95% → 99%, both in the document with their prompt fingerprints and a line
saying what changed, generated from a runs file rather than hand-written. Runs
2 and 3 share a prompt hash and scored identically, which is a small
reproducibility signal worth having.

### Stated limitation

Every row on this fixture maps to `food`, so `category` reads 100% and measures
nothing. The document now DETECTS single-valued fields and says so itself,
rather than relying on anyone remembering. A second sheet from a different
trade is the fix, and is deferred: twelve days left and Phases 3-6 ahead.

---

## 2026-08-24 — `PRICE_AMBIGUOUS`: flagging without resolving, and the rule the real sheet could not test

The last open defect on the closed Phase 1 gate. Seven of 78 rows quote a rate
per unit of MEASURE beside a pack that is not that unit — `₹ 100/Kg` against a
250g pack of adhirasam. Either ₹100 buys the pack or it buys a kilo, and the
sheet does not say.

### The temptation was to resolve it, and that is the wrong direction

250/1000 × ₹100 = ₹25 is arithmetic the merchant never wrote. It would publish
an invented price on the one path where being confidently wrong costs real
money, and it would look right — a plausible number with no flag on it. This is
the withholding-versus-guessing question from CLAUDE.md, and on the money path
guessing is strictly worse: a withheld row is a merchant answering a question,
a guessed row is a buyer charged a figure nobody stated.

So the pipeline flags and holds. The merchant's own ₹100 is kept for them to
look at in review; what is withheld is the *claim that it is a pack price*.

### Keeping the rule narrow, so it withholds a minority

`PRICE_AMBIGUOUS` here fires only when the sheet states BOTH a measure rate and
a pack smaller than that unit. A kilo rate with **no** pack size stated is a
kilo being sold, and is left alone.

Without that second condition every merchant who prices by weight gets an empty
feed — the exact failure this project has already shipped three times
(`CURRENCY_ASSUMED`, `CATEGORY_UNMAPPED`, unknown stock). Trigger rate on the
real sheet: 7 of 78, a clear minority.

### The real sheet cannot test the half that matters

Every per-Kg row on it also states a smaller pack. **There is no
counter-example on the real sheet**, so a rule that fired on *every* per-Kg
price would have scored an identical 7/7 and looked equally correct.

`messy-12-measure-rates.xlsx` supplies the counter-examples, and they are the
point of the case rather than an afterthought: a kilo rate with no pack, a pack
that IS exactly the quoted unit (`₹ 550/Kg`, `1 kg`), a sale-unit rate
(`₹ 57/Pack`), and a volume rate against a mass pack, which must flag for a
different reason.

### 470/470, and why that is a weaker claim than it looks

The score is now perfect, which is the moment to be most careful.
`price_ambiguous_flagged` reads 7/7 because a rule and the labels that check it
were **written by the same hand in the same change** — they agree with each
other, and that is not evidence. What actually constrains this rule is the five
committed rows it must NOT flag.

The document now says so itself: any perfect score renders a caution that it
means *nothing left that these labels can detect*, and points at the fixtures
holding each rule's counter-examples. Generated, not remembered.

### Published

95% → 99% → 100%, every run in the history table with its prompt fingerprint
and the change that produced it.

---

## 2026-08-24 — `complete` end to end: a cancelled session left a payable link

First run of create → complete → cancel against `next dev`, real Neon and a real
test-mode Razorpay key. Everything up to `complete` had been verified before;
the leg past it never had.

### What worked first time

```
create                                  -> 201 ready_for_payment, total 257040
complete, handler razorpay_link         -> 200 complete_in_progress
                                           plink_TTRZWW4znfREn7
                                           https://rzp.io/rzp/pJN1VrLe
complete, same Idempotency-Key          -> 200 replayed, SAME link id
complete, new key, link already live    -> 200 reused, no second link
GET during the pending window           -> 200 still complete_in_progress
complete, handler dev.acp.tokenized.card-> 400 unsupported_payment_handler
update cart while a link is live        -> 400 refused
```

The reuse path and the GET-does-not-un-complete regression both hold against a
real database, which previously only unit tests had asserted.

### The defect: cancel marked the session and left the link alive

`cancelSession` set `canceled` and never touched Razorpay. Verified against
their API rather than inferred:

```
session cs_2ee77e40c84e47dd8ec69a00 -> canceled
link    plink_TTRZWW4znfREn7        -> status "created", amount 257040, amount_paid 0
```

**A cancelled order with a live payable URL.** Anyone holding it could pay
₹2,570.40 for the remaining thirty minutes, and the webhook would then report a
payment against a session that says it was cancelled. This is the two-clocks
problem CLAUDE.md flags for Phase 3, arriving early and in Phase 2.

Fixed by cancelling the link FIRST and the session second. If Razorpay refuses —
which it does for a link that has been paid — the session is left exactly as it
was and the caller gets `payment_link_not_cancellable`. Marking it `canceled`
anyway would claim a cancellation that is not true for an order somebody has
already paid; that case is a refund, not a cancel. Same shape as invariant 2:
check first, act second, first failure short-circuits.

Proven end to end afterwards, against the live API:

```
complete -> link status "created"
cancel   -> session "canceled", link status "cancelled"
```

### Why no test could have caught it, again

`cancelSession` never called the client, so there was nothing for a fake to
observe — the absence of a call is invisible to a test that only inspects the
calls that happened. The suite was not weak here so much as blind: a missing
interaction has no fixture. What found it was asking Razorpay what it thought
the link's status was, which is a question no unit test can ask.

The three tests added now assert the property directly: the link is cancelled,
a refusal leaves the session alone, and a session with no link never calls
Razorpay at all.

### An open conformance question, not a bug

ACP's `PaymentData` is `anyOf: [{handler_id, instrument}, {purchase_order_number}]`.
Our handler declares `requires_delegate_payment: false` — the agent receives a
URL and no credential is transferred in either direction — so neither branch
fits. The repo currently uses both conventions: `tests/complete.test.ts` sends
`instrument.credential.token = "n/a"`, and the live runs above used
`purchase_order_number`. `completeSession` reads only `handler_id`, so both are
accepted today.

One of them has to be the documented one. `"n/a"` fabricates a credential that
does not exist, which is the kind of plausible-looking placeholder this project
keeps rejecting elsewhere. Recording it as an open decision rather than settling
it silently.

### Still not done in Phase 2

No traffic from Razorpay has reached the webhook endpoint. Live delivery needs a
public URL and `RAZORPAY_WEBHOOK_SECRET`, and remains the one untested leg.
